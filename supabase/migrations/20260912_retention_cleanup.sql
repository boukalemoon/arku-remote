-- =========================================================
-- Arku Remote — Saklama süreleri ve otomatik temizlik (O9, O15)
-- Tarih: 2026-09-12
--
-- İKİ BİRİKİM KAYNAĞI. İkisi de KVKK'nın veri minimizasyonu ve sınırlı
-- saklama ilkesiyle çatışıyor, ikisi de faturayı kullanıcı sayısıyla
-- doğrusal büyütüyor.
--
-- O9 — Anonim kullanıcı birikimi
--   Her istemci (misafir dahil) anonim olarak imzalanıyor ve
--   arku_ensure_connection_id ona KALICI bir 9 haneli kimlik atıyor. Her yeni
--   tarayıcı profili, her gizli pencere, her çıkış işlemi ve her kayıt
--   denemesi yeni bir anonim kullanıcı üretiyor; eskisi auth.users ve
--   public.users tablolarında yetim kalıyor. Hiçbir temizlik görevi yoktu.
--   Etkisi: auth.users sınırsız büyür (maliyet + yönetim paneli kullanılamaz
--   hale gelir) ve 900 milyonluk kimlik uzayı hiç bağlanmamış oturumlar
--   tarafından tüketilir. Ayrıca her yetim satır bir cihaz parmak izi taşır.
--
-- O15 — logs tablosu retention'sız
--   Kayıtlı kullanıcıda her günlük satırı ayrı bir insert olarak gidiyordu
--   (WebRTC iç durumları dahil). İçinde karşı taraf kimlikleri ve bağlantı
--   zamanları var — teknik günlük değil kişisel veri kaydı.
--   İstemci tarafı da bu sürümde daraltıldı: artık yalnızca kullanıcıya
--   anlamlı olaylar sunucuya yazılıyor, ICE/bağlantı ayrıntıları yerelde
--   kalıyor (bkz. src/App.tsx, m.onLog).
--
-- ⚠ SAKLAMA SÜRELERİ BİR HUKUKİ KARARDIR. Aşağıdaki değerler makul
--   başlangıçlar; aydınlatma metninizde YAZILI olan süreyle aynı olmalıdır.
--   Değiştirmek için cron ifadesindeki interval değerlerini düzenleyin.
--     signals        :  5 dakika  (zaten mevcut — 20260801)
--     logs           : 90 gün
--     anonim hesap   : 30 gün (hiç bağlantı kurmamış ve denetim kaydı olmayan)
--     connections    : DOKUNULMUYOR (bağlantı geçmişi kullanıcıya gösterilir)
--     session_audit  : DOKUNULMUYOR (append-only; bkz. docs/KVKK.md)
-- =========================================================

create extension if not exists pg_cron;

-- ---------------------------------------------------------
-- O15) logs — 90 gün
-- ---------------------------------------------------------
do $$
begin
  perform cron.unschedule('arku-clean-logs');
exception when others then null; -- görev yoksa sorun değil
end $$;

select cron.schedule(
  'arku-clean-logs',
  '23 3 * * *',  -- her gün 03:23 UTC
  $job$delete from public.logs where created_at < now() - interval '90 days'$job$
);

-- ---------------------------------------------------------
-- O9) Yetim anonim hesaplar — 30 gün
--
-- SİLME KOŞULLARI (hepsi birlikte):
--   * gerçekten anonim
--   * 30 günden eski VE 30 gündür giriş yapmamış
--   * hiç bağlantı kurmamış (connections.caller_id)
--   * hiç denetim kaydı yok (session_audit.actor_id)
--
-- Son iki koşul ŞART:
--   - session_audit.actor_id `on delete restrict` taşır; kaydı olan bir
--     kullanıcıyı silmek hata verir ve görev her gece patlar.
--   - connections `on delete cascade` taşır; koşul olmadan geçmiş sessizce
--     silinirdi.
--
-- public.users satırı auth.users'a `on delete cascade` bağlı olduğu için
-- ayrıca silmek gerekmez.
--
-- Fonksiyona sarılıyor: cron komutu tek satır olduğunda bu kadar koşulu
-- okunur tutmak mümkün değil ve hata ayıklamak için elle çağrılabilmesi
-- gerekiyor.
-- ---------------------------------------------------------
create or replace function public.arku_purge_stale_anon(p_days integer default 30)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer := 0;
begin
  -- is_anonymous kolonu eski Supabase sürümlerinde yok; varsa çalış, yoksa
  -- hiçbir şey yapma (görev sessizce boş döner, hata vermez).
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'auth' and table_name = 'users' and column_name = 'is_anonymous'
  ) then
    return 0;
  end if;

  with silinecek as (
    select u.id
    from auth.users u
    where u.is_anonymous is true
      and u.created_at < now() - (p_days || ' days')::interval
      and coalesce(u.last_sign_in_at, u.created_at) < now() - (p_days || ' days')::interval
      and not exists (select 1 from public.connections c   where c.caller_id = u.id)
      and not exists (select 1 from public.session_audit a where a.actor_id  = u.id)
    limit 5000  -- tek turda tabloyu kilitlemeyelim; görev her gece tekrar çalışır
  ), silinen as (
    delete from auth.users u
    using silinecek s
    where u.id = s.id
    returning u.id
  )
  select count(*) into v_count from silinen;

  return v_count;
end $$;

revoke all on function public.arku_purge_stale_anon(integer) from public;
revoke execute on function public.arku_purge_stale_anon(integer) from anon, authenticated;

do $$
begin
  perform cron.unschedule('arku-purge-anon');
exception when others then null;
end $$;

select cron.schedule(
  'arku-purge-anon',
  '41 3 * * *',  -- her gün 03:41 UTC
  $job$select public.arku_purge_stale_anon(30)$job$
);

-- =========================================================
-- DOĞRULAMA
--
-- 1) Görevler kurulu ve aktif:
--      select jobname, schedule, active from cron.job
--      where jobname in ('arku-clean-signals','arku-clean-logs','arku-purge-anon');
--
-- 2) Kaç anonim hesap temizlenmeye aday (SİLMEZ, yalnızca sayar):
--      select count(*) from auth.users u
--      where u.is_anonymous is true
--        and u.created_at < now() - interval '30 days'
--        and not exists (select 1 from public.connections c where c.caller_id = u.id)
--        and not exists (select 1 from public.session_audit a where a.actor_id = u.id);
--
-- 3) Elle bir tur çalıştırmak (kaç satır silindiğini döndürür):
--      select public.arku_purge_stale_anon(30);
--
-- 4) Çalışma geçmişi:
--      select j.jobname, d.status, d.start_time, d.return_message
--      from cron.job_run_details d join cron.job j on j.jobid = d.jobid
--      where j.jobname like 'arku-%' order by d.start_time desc limit 20;
--
-- GERİ ALMA
--   select cron.unschedule('arku-clean-logs');
--   select cron.unschedule('arku-purge-anon');
--   drop function if exists public.arku_purge_stale_anon(integer);
-- =========================================================
