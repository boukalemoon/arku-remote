-- =========================================================
-- Arku Remote — birikmiş sinyal satırlarının temizliği
-- Tarih: 2026-08-01
--
-- Teşhis çıktısı: 66 satırın 66'sı da 5 dakikadan eski. Yani istemci
-- temizliği yetim satırları toplayamıyor — uygulama kapandığında
-- cleanSignals() artık çalışmıyor ve satırlar kalıcı hâle geliyor.
--
-- Her satır ICE adayı, yani IP adresi içerir. Sinyaller yalnızca
-- bağlantı kurulurken (saniyeler) anlamlıdır; sonrasında tutulmaları
-- gereksiz bir veri birikimidir (KVKK: veri minimizasyonu / saklama süresi).
-- =========================================================

-- ── 1) TEK SEFERLİK TEMİZLİK ────────────────────────────────────────────
-- DURUM: 2026-08-01'de çalıştırıldı, 66 satır silindi. ✅
-- Tekrar gerekirse:
--   delete from public.signals where created_at < now() - interval '5 minutes';


-- ── 2) KALICI ÇÖZÜM: sunucu tarafı otomatik temizlik ─────────────────────
-- Aşağıdaki ÜÇ ifadeyi sırayla, tek blok hâlinde çalıştırın.
-- (Bunlar YORUM DEĞİLDİR — olduğu gibi çalıştırılabilir.)

-- 2a) Eklentiyi kur. Dashboard → Database → Extensions üzerinden de açılabilir.
create extension if not exists pg_cron;

-- 2b) Görevi tanımla: her 5 dakikada bir, 5 dakikadan eski satırları sil.
--     Aktif bir çağrının güncel sinyalleri (saniyeler içinde kullanılır)
--     bu pencereye asla girmez, dolayısıyla oturumları etkilemez.
select cron.schedule(
  'arku-clean-signals',
  '*/5 * * * *',
  $$delete from public.signals where created_at < now() - interval '5 minutes'$$
);

-- 2c) Kurulduğunu doğrula.
select jobname, schedule, active from cron.job where jobname = 'arku-clean-signals';


-- ── 3) Yönetim komutları ────────────────────────────────────────────────
-- Görevi kaldırmak:   select cron.unschedule('arku-clean-signals');
-- Çalışma geçmişi:    select * from cron.job_run_details
--                     where jobid = (select jobid from cron.job
--                                    where jobname = 'arku-clean-signals')
--                     order by start_time desc limit 10;
--
-- pg_cron açılamazsa: 1. bölümdeki DELETE'i ara ara elle çalıştırmak da yeterlidir.
-- Sinyal satırları kısa ömürlüdür; silinmeleri aktif olmayan hiçbir oturumu etkilemez.
