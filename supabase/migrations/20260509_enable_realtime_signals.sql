-- =========================================================
-- Yırak Remote - signals tablosu için Realtime etkinleştirme
-- Tarih: 2026-05-09
-- Sorun: signals tablosu supabase_realtime publication'ına
--        eklenmemişti, bu yüzden WebSocket üzerinden hiçbir
--        event gelmiyor ve bağlantı talepleri iletilmiyordu.
-- =========================================================

-- signals tablosunu realtime publication'a ekle
-- (Zaten ekliyse hata vermez)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'signals'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.signals;
  END IF;
END $$;

-- Doğrulama: publication tablosunda signals var mı?
-- SELECT * FROM pg_publication_tables WHERE pubname = 'supabase_realtime';
