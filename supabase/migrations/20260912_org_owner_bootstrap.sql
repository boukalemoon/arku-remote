-- =========================================================
-- Arku Remote — Kurumsal modülün açılış kilidini kaldır (Y1)
-- Tarih: 2026-09-12
--
-- SORUN
-- organization_members ekleme politikası şunu istiyordu:
--     arku_org_role(org_id, auth.uid()) in ('owner','admin')
-- Bu fonksiyon organization_members tablosuna bakıyor. Yeni açılmış bir
-- firmada henüz HİÇ ÜYE SATIRI OLMADIĞI için NULL döner; `NULL in (...)`
-- ise false sayılır. Sonuç bir açılış kilidi (bootstrap deadlock):
--
--   1. createOrganization firmayı açar               -> başarılı
--   2. kurucuyu owner üye olarak eklemeye çalışır    -> RLS REDDEDER
--      (istemci dönen hatayı kontrol etmiyordu, sessizce yutuluyordu)
--   3. firma ÜYESİZ kalır
--   4. owner artık hiçbir üye ekleyemez — ekleme yetkisi var olmayan
--      üyeliğe bağlı
--
-- ZİNCİRLEME ETKİ: cihaz etiketi (device_label) hiç oluşturulamadığı için
-- 'acme-01' biçimindeki kurumsal vanity kimlik HİÇ çözümlenemiyordu.
-- 20260908_identity_presence_invites.sql'in "O1 düzeltildi" notu bu yüzden
-- fiilen gerçekleşmemişti: arku_bind_org_invites doğru çalışıyor ama
-- bağlayacağı davet hiç yaratılamıyordu.
--
-- ÇÖZÜM — üç katman
--   1) TRIGGER: kurucu üyeliğini SUNUCU yazar. Böylece istemci sürümünden
--      bağımsız olarak her firmanın bir owner üyesi olur.
--   2) POLİTİKA: firma sahibi (organizations.owner_id) üye yönetebilir.
--      Trigger olmasa bile kilit açılır; ayrıca sahibin admin'i silmesi gibi
--      meşru işlemler için şart.
--   3) GERİ DOLGU: bu hatayla açılmış mevcut üyesiz firmalar onarılır.
--
-- GERİ ALMA: dosyanın sonundaki blokta.
-- =========================================================

begin;

-- ---------------------------------------------------------
-- 1) Kurucu üyeliğini sunucu yazsın
--
-- SECURITY DEFINER: trigger, RLS'in reddettiği satırı yazabilmeli.
-- `on conflict do nothing`: eski istemciler (v1.4.0) kurucu satırını
-- kendileri de eklemeye çalışıyor; ikinci deneme sessizce atlanır.
-- ---------------------------------------------------------
create or replace function public.arku_org_add_founder()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.organization_members (org_id, user_id, role, status)
  values (new.id, new.owner_id, 'owner', 'active')
  on conflict (org_id, user_id) do nothing;
  return new;
end $$;

revoke all     on function public.arku_org_add_founder() from public;
revoke execute on function public.arku_org_add_founder() from anon, authenticated;

drop trigger if exists trg_org_add_founder on public.organizations;
create trigger trg_org_add_founder
  after insert on public.organizations
  for each row execute function public.arku_org_add_founder();

-- ---------------------------------------------------------
-- 2) Firma sahibi de üye yönetebilsin
--
-- Yardımcı fonksiyon: organizations üzerinden sahiplik kontrolü.
-- SECURITY DEFINER çünkü politika içinden çağrıldığında organizations'ın
-- kendi RLS'ine takılmamalı (özyineleme riski).
-- ---------------------------------------------------------
create or replace function public.arku_owns_org(p_org uuid, p_uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.organizations o
    where o.id = p_org and o.owner_id = p_uid
  );
$$;

revoke all     on function public.arku_owns_org(uuid, uuid) from public;
revoke execute on function public.arku_owns_org(uuid, uuid) from anon;
grant  execute on function public.arku_owns_org(uuid, uuid) to authenticated;

drop policy if exists "org_members_write_admin"  on public.organization_members;
drop policy if exists "org_members_update_admin" on public.organization_members;
drop policy if exists "org_members_delete_admin" on public.organization_members;

create policy "org_members_write_admin" on public.organization_members for insert
to authenticated
with check (
  public.arku_owns_org(org_id, auth.uid())
  or public.arku_org_role(org_id, auth.uid()) in ('owner','admin')
);

create policy "org_members_update_admin" on public.organization_members for update
to authenticated
using (
  public.arku_owns_org(org_id, auth.uid())
  or public.arku_org_role(org_id, auth.uid()) in ('owner','admin')
)
with check (
  public.arku_owns_org(org_id, auth.uid())
  or public.arku_org_role(org_id, auth.uid()) in ('owner','admin')
);

-- Silme: firma sahibinin owner satırı silinemesin, aksi halde kilit geri döner.
create policy "org_members_delete_admin" on public.organization_members for delete
to authenticated
using (
  (
    public.arku_owns_org(org_id, auth.uid())
    or public.arku_org_role(org_id, auth.uid()) in ('owner','admin')
  )
  and not public.arku_owns_org(org_id, user_id)
);

-- ---------------------------------------------------------
-- 3) Mevcut üyesiz firmaları onar
--
-- Bu hatayla açılmış firmaların kurucusu üye listesinde yok. Onlar için
-- owner satırını şimdi yazıyoruz; zaten varsa dokunulmuyor.
-- ---------------------------------------------------------
insert into public.organization_members (org_id, user_id, role, status)
select o.id, o.owner_id, 'owner', 'active'
from public.organizations o
where not exists (
  select 1 from public.organization_members m
  where m.org_id = o.id and m.user_id = o.owner_id
)
on conflict (org_id, user_id) do nothing;

commit;

-- =========================================================
-- DOĞRULAMA
--
-- 1) Üyesiz firma kalmadı (0 satır dönmeli):
--      select o.id, o.name from public.organizations o
--      where not exists (select 1 from public.organization_members m
--                        where m.org_id = o.id and m.role = 'owner');
--
-- 2) Trigger duruyor:
--      select tgname from pg_trigger where tgname = 'trg_org_add_founder';
--
-- 3) CANLI TEST (arayüzden): Kurumsal sekmesi > firma oluştur >
--    e-posta ile üye ekle + cihaz etiketi ver. Eskiden 2. adım RLS
--    hatasıyla düşüyordu, artık geçmeli. Ardından davet edilen kullanıcı
--    giriş yaptığında 'slug-etiket' (örn. acme-01) ile aranabilir olmalı.
--
-- GERİ ALMA
--   begin;
--   drop trigger if exists trg_org_add_founder on public.organizations;
--   drop function if exists public.arku_org_add_founder();
--   drop policy if exists "org_members_write_admin"  on public.organization_members;
--   drop policy if exists "org_members_update_admin" on public.organization_members;
--   drop policy if exists "org_members_delete_admin" on public.organization_members;
--   create policy "org_members_write_admin" on public.organization_members for insert
--     to authenticated with check (public.arku_org_role(org_id, auth.uid()) in ('owner','admin'));
--   create policy "org_members_update_admin" on public.organization_members for update
--     to authenticated using (public.arku_org_role(org_id, auth.uid()) in ('owner','admin'))
--     with check (public.arku_org_role(org_id, auth.uid()) in ('owner','admin'));
--   create policy "org_members_delete_admin" on public.organization_members for delete
--     to authenticated using (public.arku_org_role(org_id, auth.uid()) in ('owner','admin'));
--   drop function if exists public.arku_owns_org(uuid, uuid);
--   commit;
--   (Geri dolgulanan üye satırları KALIR — zararsızdır, kilidi de açık tutar.)
-- =========================================================
