-- =========================================================
-- Arku Remote - signals tablo kontrolü
-- Bu komutları Supabase SQL Editor'da çalıştırın
-- =========================================================

-- Tablo yapısını kontrol et
SELECT
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_name = 'signals'
  AND table_schema = 'public'
ORDER BY ordinal_position;

-- Mevcut policy'leri listele
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
FROM pg_policies
WHERE tablename = 'signals'
  AND schemaname = 'public';

-- Tabloya test insert yap (çalışıp çalışmadığını gör)
-- Bu satırları tek tek çalıştırın
INSERT INTO public.signals (from_id, to_id, type, payload)
VALUES ('test-from', 'test-to', 'offer', '{"test": true}');

-- Test kaydını sil
DELETE FROM public.signals
WHERE from_id = 'test-from' AND to_id = 'test-to';

-- Son 5 kaydı gör
SELECT * FROM public.signals
ORDER BY created_at DESC
LIMIT 5;