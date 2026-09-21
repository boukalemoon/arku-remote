-- =========================================================
-- Arku Remote — QRtım kullanıcı başına bağlantı sırrı (plan tazeleme)
-- Tarih: 2026-09-22
--
-- NEDEN
-- QRtım planı Arku'ya YALNIZCA giriş/bağlama anında yazılıyordu
-- (grantQrtimSubscription). Yetki kararları yerel `subscriptions` satırına
-- bakıyor ve o satırın süresi hiç dolmuyor. Sonuç: QRtım aboneliği biten
-- kullanıcı Arku'da ücretli kademede SÜRESİZ kalıyordu — planı tazelemek için
-- tekrar QRtım ile giriş yapması gerekiyordu, ki yapmaz.
--
-- QRtım bunun için sunucudan sunucuya bir uç açtı (`partner-plan`). Uç,
-- paylaşılan bir ana anahtarla değil, KULLANICI BAŞINA bir sırla çalışıyor:
-- sır sızarsa yalnızca o kullanıcının planı okunabilir, ana anahtar sızsaydı
-- herkesinki okunurdu. Sır `arku-link` yanıtında kök seviyede dönüyor ve
-- BAĞLAMA ANINDA yakalanmalı — sonradan almanın yolu yok.
--
-- NEDEN AYRI TABLO (users'a kolon olarak değil)
-- users satırını kullanıcının kendisi okuyabiliyor (RLS: kendi satırın).
-- Sır orada dursaydı istemciye — dolayısıyla tarayıcıdaki herhangi bir
-- betiğe — görünürdü. Sırla yapılabilecek tek şey o kullanıcının planını
-- okumak, yani zarar küçük; ama sırrı sunucuda tutmanın maliyeti sıfır.
-- Bu tabloda POLİTİKA YOK: hiçbir istemci rolü erişemez, yalnızca
-- service_role (edge fonksiyonları) ve SECURITY DEFINER fonksiyonlar.
-- =========================================================

begin;

create table if not exists public.qrtim_link_secrets (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  qrtim_uid   uuid not null,
  link_secret text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- RLS açık ve politika YOK — kasıtlı. Politikasız tabloya istemci rolleri
-- hiçbir satır göremez.
alter table public.qrtim_link_secrets enable row level security;

revoke all on table public.qrtim_link_secrets from anon, authenticated;

drop trigger if exists trg_qrtim_link_secrets_updated on public.qrtim_link_secrets;
create trigger trg_qrtim_link_secrets_updated
  before update on public.qrtim_link_secrets
  for each row execute function public.arku_set_updated_at();

-- ---------------------------------------------------------
-- Bağlantı koparıldığında sır da gitmeli: kopardıktan sonra o sırla plan
-- sorgulamaya devam etmenin bir anlamı yok ve saklamanın gerekçesi kalmaz.
-- ---------------------------------------------------------
create or replace function public.arku_qrtim_unlink()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Oturum gerekli'; end if;

  delete from public.qrtim_link_secrets where user_id = v_uid;

  update public.users
     set qrtim_uid = null, qrtim_id = null, qrtim_username = null,
         qrtim_name = null, qrtim_email = null, qrtim_connected_at = null
   where id = v_uid;
end $$;

revoke all     on function public.arku_qrtim_unlink() from public;
revoke execute on function public.arku_qrtim_unlink() from anon;
grant  execute on function public.arku_qrtim_unlink() to authenticated;

commit;

-- =========================================================
-- DOĞRULAMA
--
-- 1) Tablo istemciye TAMAMEN kapalı olmalı (ikisi de 'yok'):
--      select case when has_table_privilege('anon','public.qrtim_link_secrets','select')
--                  then 'VAR' else 'yok' end as anon,
--             case when has_table_privilege('authenticated','public.qrtim_link_secrets','select')
--                  then 'VAR' else 'yok' end as authenticated;
--
-- 2) Politika olmamalı (0 satır):
--      select count(*) from pg_policies
--       where schemaname='public' and tablename='qrtim_link_secrets';
--
-- 3) CANLI TEST (QRtım bayrakları açıldıktan sonra): QRtım ile giriş yapın,
--    satır oluşmalı; Ayarlar > QRtım bağlantısını kesin, satır gitmeli.
--      select user_id, qrtim_uid, updated_at from public.qrtim_link_secrets;
--
-- GERİ ALMA
--   begin;
--   drop table if exists public.qrtim_link_secrets;
--   -- arku_qrtim_unlink'in bir önceki hali için
--   -- 20260921_qrtim_uid_identity.sql'deki tanımı yeniden çalıştırın.
--   commit;
-- =========================================================
