-- =========================================================
-- Arku Remote - signals DELETE sertleştirmesi (DoS koruması)
-- Tarih: 2026-07-27
-- Bu dosyayı 20260727_signals_rls_revert.sql'DEN SONRA çalıştır.
--
-- Amaç: En tehlikeli açığı (herkesin `delete from signals` ile tüm
--       sinyalleri silip aktif çağrıları/servisi çökertmesi) kapatmak —
--       AMA realtime'ın bağlı olduğu SELECT/INSERT policy'lerine
--       DOKUNMADAN, yani çalışan bağlantı akışını bozmadan.
--
-- Yöntem: DELETE yalnızca 30 saniyeden ESKİ (stale) satırlara izin versin.
--   * İstemcinin temizleme mantığı zaten >60 sn eski satırları siler → etkilenmez.
--   * Bir saldırgan aktif çağrının GÜNCEL sinyallerini (ICE/offer/answer)
--     artık silemez → aktif oturumlar korunur.
--
-- NOT: SELECT (IP/ICE okuma sızıntısı) ve INSERT (sahte offer) açıkları
--      HÂLÂ AÇIK. Onların düzeltmesi auth tabanlı bir değişiklik gerektiriyor
--      ve yerelde test edilmeden production'a uygulanmayacak.
-- =========================================================

begin;

alter table public.signals enable row level security;

-- Yalnızca DELETE policy'sini değiştir; select/insert aynı kalır.
drop policy if exists "signals_delete"      on public.signals;
drop policy if exists "signals_delete_auth" on public.signals;

create policy "signals_delete"
on public.signals for delete
to authenticated, anon
using (created_at < now() - interval '30 seconds');

commit;

-- Doğrulama (opsiyonel): DELETE policy'sinin qual'i artık `using(true)` değil,
-- `created_at < now() - '00:00:30'` olmalı:
--   select policyname, cmd, qual from pg_policies
--   where schemaname='public' and tablename='signals' and cmd='DELETE';
