-- =========================================================
-- Arku Remote / Arku-Mon — Gözetimsiz Erişim (Unattended) AŞAMA 1
-- Tarih: 2026-08-03
--
-- KAPSAM: yalnızca YENİ tablo + fonksiyon + RLS. Mevcut tablolara
--         (signals, users, subscriptions, organization_members) DOKUNMAZ.
--         Çalışan bağlantı akışını etkilemez — hiçbir mevcut kod bu tabloyu
--         henüz okumaz. Uygulaması güvenlidir, geri alması `drop table` kadar
--         basittir.
--
-- AMAÇ: Bir cihazın (organization_members.device_label satırı) gözetimsiz
--       erişime AÇIK olup olmadığını, rıza kaydını ve hangi operatörlerin
--       ona onaysız bağlanabileceğini tanımlamak.
-- =========================================================

begin;

-- ---------------------------------------------------------
-- device_unattended — cihaz başına gözetimsiz erişim durumu
--   member_id: organization_members(id) — bu satır bir CİHAZı temsil eder
--   enabled:   gözetimsiz mod açık mı
--   consent_*: KVKK açık rıza kaydı (rıza yoksa enabled=true olamaz — trigger)
-- ---------------------------------------------------------
create table if not exists public.device_unattended (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null unique references public.organization_members(id) on delete cascade,
  enabled boolean not null default false,
  consent_at timestamptz,
  consent_text_version text,
  enrolled_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_device_unattended_member on public.device_unattended (member_id);

-- Rıza olmadan gözetimsiz mod açılamaz (KVKK zorunluluğu, DB düzeyinde)
create or replace function public.arku_du_require_consent()
returns trigger language plpgsql as $$
begin
  if new.enabled and new.consent_at is null then
    raise exception 'Gözetimsiz mod için açık rıza (consent_at) zorunludur';
  end if;
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_device_unattended_consent on public.device_unattended;
create trigger trg_device_unattended_consent
  before insert or update on public.device_unattended
  for each row execute function public.arku_du_require_consent();

-- ---------------------------------------------------------
-- arku_can_unattend(cihaz üyesi, operatör) — otomatik kabul kararının kalbi.
-- TRUE ancak: cihazın gözetimsiz modu açık + rızalı VE operatör, cihazla
-- AYNI org'un aktif owner/admin/operator üyesi ise. (Arka kapı olmaması için.)
-- ---------------------------------------------------------
create or replace function public.arku_can_unattend(p_device_member uuid, p_operator uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.device_unattended du
    join public.organization_members dm on dm.id = du.member_id      -- cihaz üyesi
    join public.organization_members om on om.org_id = dm.org_id     -- operatör üyesi (aynı org)
    where du.member_id = p_device_member
      and du.enabled is true
      and du.consent_at is not null
      and dm.status = 'active'
      and om.user_id = p_operator
      and om.status = 'active'
      and om.role in ('owner','admin','operator')
  );
$$;

revoke all on function public.arku_can_unattend(uuid, uuid) from public;
grant execute on function public.arku_can_unattend(uuid, uuid) to authenticated;

-- ---------------------------------------------------------
-- RLS: cihazın kendi org'unun owner/admin'i yönetir; üyeler okuyabilir.
-- ---------------------------------------------------------
alter table public.device_unattended enable row level security;

drop policy if exists "device_unattended_select" on public.device_unattended;
drop policy if exists "device_unattended_write"  on public.device_unattended;

create policy "device_unattended_select" on public.device_unattended for select
to authenticated
using (
  exists (
    select 1 from public.organization_members dm
    where dm.id = member_id
      and public.arku_is_org_member(dm.org_id, auth.uid())
  )
);

create policy "device_unattended_write" on public.device_unattended for all
to authenticated
using (
  exists (
    select 1 from public.organization_members dm
    where dm.id = member_id
      and public.arku_org_role(dm.org_id, auth.uid()) in ('owner','admin')
  )
)
with check (
  exists (
    select 1 from public.organization_members dm
    where dm.id = member_id
      and public.arku_org_role(dm.org_id, auth.uid()) in ('owner','admin')
  )
);

commit;

-- =========================================================
-- DOĞRULAMA (uyguladıktan sonra):
--   select * from public.device_unattended;                    -- boş, hata yok
--   select public.arku_can_unattend(gen_random_uuid(), auth.uid());  -- false
-- Mevcut signals/users politikaları DEĞİŞMEDİ — bağlantı akışı aynı.
-- =========================================================
