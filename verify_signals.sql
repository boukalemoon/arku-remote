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

-- ⚠ DIKKAT — AŞAĞIDAKİLER BİLEREK YORUMLU BIRAKILDI.
--
-- Dosyanın adı "kontrol" ama bu iki ifade ÜRETİM TABLOSUNA YAZAR. SQL
-- Editor'da "tümünü çalıştır" denildiğinde sessizce bir test satırı
-- ekliyordu; o satır artık hız sınırı tetikleyicisini de besliyor
-- (20260909_signals_rate_limit.sql).
--
-- Salt okunur teşhis için supabase/verify_security_state.sql kullanın.
-- Yazma testi gerçekten gerekiyorsa aşağıdaki iki bloğu TEK TEK, bilerek
-- çalıştırın:
--
-- INSERT INTO public.signals (from_id, to_id, type, payload)
-- VALUES ('test-from', 'test-to', 'offer', '{"test": true}');
--
-- DELETE FROM public.signals
-- WHERE from_id = 'test-from' AND to_id = 'test-to';

-- Son 5 kaydı gör
SELECT * FROM public.signals
ORDER BY created_at DESC
LIMIT 5;