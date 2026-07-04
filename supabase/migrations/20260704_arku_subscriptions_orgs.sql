-- =========================================================
-- Arku Remote - Abonelik + Kurumsal (multi-tenant) temeli
-- Tarih: 2026-07-04
-- Kapsam:
--   * subscriptions       — bireysel/kurumsal abonelik + QRtim kaynaklı ücretsiz
--   * organizations       — kiralayan firma (vanity slug + logo)
--   * organization_members— firmanın operatörleri ve cihazları (device_label)
--   * contact_categories  — müşteri sınıflandırma etiketleri
--   * saved_contacts      — kayıtlı müşteri ID'leri (kategori + not)
--   * RLS + SECURITY DEFINER yardımcıları (özyinelemesiz policy)
--   * resolve_connection_id genişletmesi: 'slug-label' -> uuid
--   * arku_map_qrtim_plan / arku_effective_subscription
-- Yeni tablolar; tekrar çalıştırmak güvenlidir.
-- =========================================================

begin;

create extension if not exists pgcrypto;
create extension if not exists citext;

-- updated_at otomasyonu
create or replace function public.arku_set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- ---------------------------------------------------------
-- 1) subscriptions — hesap başına en fazla bir aktif abonelik
--    plan: free | pro | team | business
--    source: direct (satın alım) | qrtim (senkron) | manual (admin)
-- ---------------------------------------------------------
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free','pro','team','business')),
  status text not null default 'active' check (status in ('active','past_due','canceled')),
  seats integer not null default 1 check (seats >= 1),
  source text not null default 'direct' check (source in ('direct','qrtim','manual')),
  qrtim_plan text,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_subscriptions_updated on public.subscriptions;
create trigger trg_subscriptions_updated before update on public.subscriptions
  for each row execute function public.arku_set_updated_at();

alter table public.subscriptions enable row level security;

drop policy if exists "subscriptions_select_own" on public.subscriptions;
create policy "subscriptions_select_own"
on public.subscriptions for select to authenticated
using (auth.uid() = owner_id);
-- Yazma yalnızca service_role ile (edge function); authenticated'e insert/update yok.

-- ---------------------------------------------------------
-- 2) organizations — kiralayan firma
--    slug: markalı kimlik önekі (acme -> acme-01, acme-02, ...)
-- ---------------------------------------------------------
create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  slug citext not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$'),
  logo_url text,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_organizations_updated on public.organizations;
create trigger trg_organizations_updated before update on public.organizations
  for each row execute function public.arku_set_updated_at();

create index if not exists idx_organizations_owner on public.organizations (owner_id);

-- ---------------------------------------------------------
-- 3) organization_members — operatörler ve erişilebilir cihazlar
--    device_label: firma içinde benzersiz; adres 'slug-label' olur
--    role: owner | admin | operator | member
-- ---------------------------------------------------------
create table if not exists public.organization_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','operator','member')),
  device_label text,
  invited_email text,
  status text not null default 'active' check (status in ('active','invited','disabled')),
  created_at timestamptz not null default now(),
  unique (org_id, user_id),
  unique (org_id, device_label)
);

create index if not exists idx_org_members_user on public.organization_members (user_id);
create index if not exists idx_org_members_org on public.organization_members (org_id);

-- ---------------------------------------------------------
-- SECURITY DEFINER yardımcıları — RLS özyinelemesini önler
-- ---------------------------------------------------------
create or replace function public.arku_org_role(p_org uuid, p_uid uuid)
returns text language sql security definer set search_path = public stable as $$
  select role from public.organization_members
  where org_id = p_org and user_id = p_uid and status = 'active' limit 1;
$$;

create or replace function public.arku_is_org_member(p_org uuid, p_uid uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists(
    select 1 from public.organization_members
    where org_id = p_org and user_id = p_uid and status = 'active'
  );
$$;

revoke all on function public.arku_org_role(uuid, uuid) from public;
revoke all on function public.arku_is_org_member(uuid, uuid) from public;
grant execute on function public.arku_org_role(uuid, uuid) to authenticated;
grant execute on function public.arku_is_org_member(uuid, uuid) to authenticated;

alter table public.organizations enable row level security;
drop policy if exists "orgs_select_member" on public.organizations;
drop policy if exists "orgs_insert_owner" on public.organizations;
drop policy if exists "orgs_update_admin" on public.organizations;
drop policy if exists "orgs_delete_owner" on public.organizations;

create policy "orgs_select_member" on public.organizations for select to authenticated
using (owner_id = auth.uid() or public.arku_is_org_member(id, auth.uid()));

create policy "orgs_insert_owner" on public.organizations for insert to authenticated
with check (owner_id = auth.uid());

create policy "orgs_update_admin" on public.organizations for update to authenticated
using (owner_id = auth.uid() or public.arku_org_role(id, auth.uid()) in ('owner','admin'))
with check (owner_id = auth.uid() or public.arku_org_role(id, auth.uid()) in ('owner','admin'));

create policy "orgs_delete_owner" on public.organizations for delete to authenticated
using (owner_id = auth.uid());

alter table public.organization_members enable row level security;
drop policy if exists "org_members_select" on public.organization_members;
drop policy if exists "org_members_write_admin" on public.organization_members;
drop policy if exists "org_members_update_admin" on public.organization_members;
drop policy if exists "org_members_delete_admin" on public.organization_members;

-- Üye kendi satırını ve aynı org'daki diğer üyeleri görebilir
create policy "org_members_select" on public.organization_members for select to authenticated
using (user_id = auth.uid() or public.arku_is_org_member(org_id, auth.uid()));

create policy "org_members_write_admin" on public.organization_members for insert to authenticated
with check (public.arku_org_role(org_id, auth.uid()) in ('owner','admin'));

create policy "org_members_update_admin" on public.organization_members for update to authenticated
using (public.arku_org_role(org_id, auth.uid()) in ('owner','admin'))
with check (public.arku_org_role(org_id, auth.uid()) in ('owner','admin'));

create policy "org_members_delete_admin" on public.organization_members for delete to authenticated
using (public.arku_org_role(org_id, auth.uid()) in ('owner','admin'));

-- ---------------------------------------------------------
-- 4) contact_categories — müşteri sınıflandırma
--    Kapsam: kişisel (owner_id) veya kurumsal (org_id). Biri dolu olur.
-- ---------------------------------------------------------
create table if not exists public.contact_categories (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete cascade,
  org_id uuid references public.organizations(id) on delete cascade,
  name text not null,
  color text not null default '#c5a059',
  created_at timestamptz not null default now(),
  check (owner_id is not null or org_id is not null)
);

create index if not exists idx_categories_owner on public.contact_categories (owner_id);
create index if not exists idx_categories_org on public.contact_categories (org_id);

alter table public.contact_categories enable row level security;
drop policy if exists "categories_rw" on public.contact_categories;
create policy "categories_rw" on public.contact_categories for all to authenticated
using (
  owner_id = auth.uid()
  or (org_id is not null and public.arku_org_role(org_id, auth.uid()) in ('owner','admin','operator'))
)
with check (
  owner_id = auth.uid()
  or (org_id is not null and public.arku_org_role(org_id, auth.uid()) in ('owner','admin','operator'))
);

-- ---------------------------------------------------------
-- 5) saved_contacts — kayıtlı müşteri ID'leri
--    connection_id: hedefin Arku kimliği (numeric veya slug-label)
-- ---------------------------------------------------------
create table if not exists public.saved_contacts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete cascade,
  org_id uuid references public.organizations(id) on delete cascade,
  connection_id text not null,
  display_name text,
  category_id uuid references public.contact_categories(id) on delete set null,
  notes text,
  last_connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (owner_id is not null or org_id is not null)
);

drop trigger if exists trg_saved_contacts_updated on public.saved_contacts;
create trigger trg_saved_contacts_updated before update on public.saved_contacts
  for each row execute function public.arku_set_updated_at();

create index if not exists idx_saved_contacts_owner on public.saved_contacts (owner_id);
create index if not exists idx_saved_contacts_org on public.saved_contacts (org_id);

alter table public.saved_contacts enable row level security;
drop policy if exists "saved_contacts_rw" on public.saved_contacts;
create policy "saved_contacts_rw" on public.saved_contacts for all to authenticated
using (
  owner_id = auth.uid()
  or (org_id is not null and public.arku_is_org_member(org_id, auth.uid()))
)
with check (
  owner_id = auth.uid()
  or (org_id is not null and public.arku_org_role(org_id, auth.uid()) in ('owner','admin','operator'))
);

-- ---------------------------------------------------------
-- 6) Kimlik çözümleme genişletmesi
--    'slug-label' (ör. acme-01) -> organization_members.user_id
--    aksi halde eski davranış: users.connection_id -> id
-- ---------------------------------------------------------
create or replace function public.resolve_connection_id(cid text)
returns uuid language plpgsql security definer set search_path = public stable as $$
declare
  v_id uuid;
  v_slug text;
  v_label text;
  v_pos int;
begin
  if cid is null then return null; end if;

  -- Vanity biçim: '<slug>-<label>' (label harfli/rakamlı; salt rakam ise numeric ID say)
  if cid ~ '^[a-z0-9]+(?:-[a-z0-9]+)+$' and cid !~ '^[0-9]{3}-[0-9]{3}-[0-9]{3}$' then
    v_pos := position('-' in cid);
    v_slug := split_part(cid, '-', 1);
    v_label := substr(cid, length(v_slug) + 2);
    select m.user_id into v_id
    from public.organization_members m
    join public.organizations o on o.id = m.org_id
    where o.slug = v_slug and m.device_label = v_label and m.status = 'active'
    limit 1;
    if v_id is not null then return v_id; end if;
  end if;

  -- Klasik numeric kimlik
  select id into v_id from public.users where connection_id = cid limit 1;
  return v_id;
end $$;

revoke all on function public.resolve_connection_id(text) from public;
grant execute on function public.resolve_connection_id(text) to authenticated, anon;

-- ---------------------------------------------------------
-- 7) QRtim plan eşlemesi + etkin abonelik
--    Tüm ücretli QRtim planları ücretsiz Arku verir:
--      business/stk -> business (kurumsal özellikler)
--      diğer ücretli (student/professional/pro/...) -> pro
--      free/boş -> free
-- ---------------------------------------------------------
create or replace function public.arku_map_qrtim_plan(p text)
returns text language sql immutable as $$
  select case
    when p is null then 'free'
    when lower(p) in ('business','kurumsal','stk','enterprise') then 'business'
    when lower(p) in ('free','') then 'free'
    else 'pro'  -- student, professional, pro ve diğer tüm ücretli planlar
  end;
$$;

-- Kullanıcının etkin planı: kendi aboneliği + üyesi olduğu org'ların planı
-- arasından en yükseği. UI ve Ilgezdi bunu okur.
create or replace function public.arku_effective_subscription(p_uid uuid)
returns jsonb language sql security definer set search_path = public stable as $$
  with ranks as (select unnest(array['free','pro','team','business']) as plan,
                        generate_series(0,3) as rank),
  own as (
    select s.plan, s.status, s.source, s.seats
    from public.subscriptions s where s.owner_id = p_uid and s.status = 'active'
  ),
  org_plans as (
    select s.plan
    from public.organization_members m
    join public.organizations o on o.id = m.org_id
    join public.subscriptions s on s.id = o.subscription_id
    where m.user_id = p_uid and m.status = 'active' and s.status = 'active'
  ),
  all_plans as (
    select plan from own
    union all select plan from org_plans
    union all select 'free'
  ),
  best as (
    select ap.plan from all_plans ap join ranks r on r.plan = ap.plan
    order by r.rank desc limit 1
  )
  select jsonb_build_object(
    'plan', (select plan from best),
    'source', coalesce((select source from own), 'none'),
    'seats', coalesce((select seats from own), 1),
    'is_org_member', exists(select 1 from public.organization_members where user_id = p_uid and status = 'active')
  );
$$;

revoke all on function public.arku_effective_subscription(uuid) from public;
grant execute on function public.arku_effective_subscription(uuid) to authenticated;

commit;
