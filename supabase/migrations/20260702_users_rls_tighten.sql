-- =========================================================
-- Arku Remote - users tablosu RLS sıkılaştırması
-- Tarih: 2026-07-02
-- Sorun: "users_select_authenticated" politikası her kayıtlı
--        kullanıcının diğer herkesin email/telefon/cihaz parmak izini
--        okumasına izin veriyordu (PII sızıntısı).
-- Çözüm: select yalnızca kendi satırına; hedef kimlik çözümü için
--        sadece UUID döndüren security definer fonksiyonu.
-- Not: Uygulama önce RPC'yi dener, fonksiyon yoksa eski doğrudan
--      sorguya döner — bu migration'ı uygulama deploy'undan önce
--      veya sonra çalıştırmak güvenlidir.
-- =========================================================

begin;

drop policy if exists "users_select_authenticated" on public.users;
drop policy if exists "users_select_own" on public.users;

create policy "users_select_own"
on public.users for select
to authenticated
using (auth.uid() = id);

-- connection_id -> user id çözümü; diğer kolonları sızdırmaz.
create or replace function public.resolve_connection_id(cid text)
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select id from public.users where connection_id = cid limit 1;
$$;

revoke all on function public.resolve_connection_id(text) from public;
grant execute on function public.resolve_connection_id(text) to authenticated;

commit;
