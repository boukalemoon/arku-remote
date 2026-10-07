-- =========================================================
-- Denetim 2026-10-07, bulgular Y1 (kurum ele geçirme) ve O1 (koltuk sınırı)
-- =========================================================
-- Y1: orgs_update_admin ve org_members_update_admin kolon sınırı koymuyordu.
--     Canlıda `authenticated` rolünün organizations.owner_id/subscription_id ve
--     organization_members.role/user_id üzerinde UPDATE yetkisi var. Bir admin:
--       * organizations.owner_id'yi kendine çevirip kurucuyu düşürebilir,
--       * kendi üyelik satırında role='owner' yapabilir,
--       * owner_id'yi daha çok koltuklu bir kullanıcıya bağlayabilir.
--     Ayrıca admin herhangi bir user_id ile üye satırı ekleyebiliyordu
--     (kullanıcının onayı olmadan kuruma katma).
-- O1: trg_org_seat_limit yalnızca INSERT'te çalışıyordu; 'disabled' eklenip
--     sonra 'active' yapılarak sınır aşılabiliyordu.
--
-- İstemci etkisi: src/lib/enterprise.ts organizations'ta yalnızca
-- name/slug/logo_url, organization_members'ta yalnızca role/device_label/status
-- güncelliyor ve üye eklerken user_id=null, status='invited' gönderiyor.
-- Kurucu satırını trg_org_add_founder (SECURITY DEFINER) yazıyor; davet
-- bağlama arku_bind_org_invites (SECURITY DEFINER). İkisi de etkilenmez.
--
-- Uygulama: Dashboard > SQL Editor. Yeniden çalıştırılabilir.
-- =========================================================

begin;

-- 1) Kolon yetkileri ------------------------------------------------------
revoke update on public.organizations from authenticated, anon;
grant  update (name, slug, logo_url, updated_at) on public.organizations to authenticated;

revoke update on public.organization_members from authenticated, anon;
grant  update (role, device_label, status) on public.organization_members to authenticated;

-- 2) Üye politikaları -----------------------------------------------------
drop policy if exists "org_members_write_admin"  on public.organization_members;
drop policy if exists "org_members_update_admin" on public.organization_members;
drop policy if exists "org_members_delete_admin" on public.organization_members;

-- Ekleme: yalnızca davet. Kullanıcı bağlama sunucu tarafında (bind_org_invites).
create policy "org_members_write_admin" on public.organization_members for insert
to authenticated
with check (
  (public.arku_owns_org(org_id, auth.uid())
   or public.arku_org_role(org_id, auth.uid()) in ('owner','admin'))
  and user_id is null
  and status = 'invited'
  and role <> 'owner'
);

-- Güncelleme: owner rolünü yalnızca firma sahibi verebilir/değiştirebilir.
create policy "org_members_update_admin" on public.organization_members for update
to authenticated
using (
  (public.arku_owns_org(org_id, auth.uid())
   or public.arku_org_role(org_id, auth.uid()) in ('owner','admin'))
  and (role <> 'owner' or public.arku_owns_org(org_id, auth.uid()))
)
with check (
  (public.arku_owns_org(org_id, auth.uid())
   or public.arku_org_role(org_id, auth.uid()) in ('owner','admin'))
  and (role <> 'owner' or public.arku_owns_org(org_id, auth.uid()))
);

create policy "org_members_delete_admin" on public.organization_members for delete
to authenticated
using (
  (public.arku_owns_org(org_id, auth.uid())
   or public.arku_org_role(org_id, auth.uid()) in ('owner','admin'))
  and not public.arku_owns_org(org_id, user_id)
  and (role <> 'owner' or public.arku_owns_org(org_id, auth.uid()))
);

-- 3) Koltuk sınırı: devre dışı -> etkin geçişinde de say ------------------
create or replace function public.arku_org_seat_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_seats integer;
  v_used  integer;
begin
  -- Devre dışı satır koltuk tüketmez.
  if new.status = 'disabled' then return new; end if;
  -- UPDATE'te yalnızca devre dışı -> etkin geçişi yeni koltuk demektir.
  if tg_op = 'UPDATE' and old.status <> 'disabled' then return new; end if;

  select o.owner_id into v_owner from public.organizations o where o.id = new.org_id;
  if v_owner is null then return new; end if;

  if new.user_id is not null and new.user_id = v_owner then return new; end if;

  select coalesce(max(s.seats), 1) into v_seats
  from public.subscriptions s
  where s.owner_id = v_owner and s.status = 'active';

  select count(*) into v_used
  from public.organization_members m
  where m.org_id = new.org_id
    and m.id <> new.id
    and m.status <> 'disabled'
    and (m.user_id is null or m.user_id <> v_owner);

  if v_used >= v_seats then
    raise exception 'Koltuk siniri dolu (% koltuk). Ek koltuk icin aboneliginizi yukseltin.', v_seats
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

revoke all     on function public.arku_org_seat_limit() from public;
revoke execute on function public.arku_org_seat_limit() from anon, authenticated;

drop trigger if exists trg_org_seat_limit on public.organization_members;
create trigger trg_org_seat_limit
  before insert or update of status on public.organization_members
  for each row execute function public.arku_org_seat_limit();

commit;

-- =========================================================
-- DOĞRULAMA (salt okuma)
--   select column_name from information_schema.column_privileges
--    where table_schema='public' and table_name='organizations'
--      and grantee='authenticated' and privilege_type='UPDATE';
--   -> name, slug, logo_url, updated_at (owner_id ve subscription_id YOK)
--   select pg_get_triggerdef(oid) from pg_trigger where tgname='trg_org_seat_limit';
--   -> BEFORE INSERT OR UPDATE OF status
-- =========================================================
