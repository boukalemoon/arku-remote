-- =========================================================
-- Arku Remote — sinyal satırları için sunucu tarafı TTL temizliği
-- Tarih: 2026-08-01
-- DURUM: ✅ UYGULANDI (cron görevi aktif)
--
-- Neden: teşhiste signals tablosundaki 66 satırın 66'sı da 5 dakikadan
-- eskiydi. İstemci temizliği (cleanSignals) yetim satırları toplayamıyor,
-- çünkü uygulama kapandığında çalışmayı durduruyor. Her satır ICE adayı,
-- yani IP adresi içerir — birikmeleri gereksiz bir kişisel veri yığınıdır
-- (KVKK: veri minimizasyonu ve saklama süresi).
--
-- Aktif bir çağrının güncel sinyalleri saniyeler içinde kullanılır ve
-- 5 dakikalık pencereye asla girmez; bu görev oturumları etkilemez.
-- =========================================================

create extension if not exists pg_cron;

do $$
begin
  perform cron.unschedule('arku-clean-signals');
exception when others then
  null; -- görev yoksa sorun değil (yeniden çalıştırılabilir olsun diye)
end $$;

select cron.schedule(
  'arku-clean-signals',
  '*/5 * * * *',
  $job$delete from public.signals where created_at < now() - interval '5 minutes'$job$
);

-- Doğrulama:
--   select jobname, schedule, active from cron.job where jobname='arku-clean-signals';
-- Çalışma geçmişi:
--   select status, start_time, end_time from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname='arku-clean-signals')
--   order by start_time desc limit 10;
-- Kaldırma:
--   select cron.unschedule('arku-clean-signals');
