-- =========================================================
-- Supabase güvenlik uyarısı: function_search_path_mutable (2026-11-10)
--
-- arku_plan_rank arama yolu sabitlenmemiş tek fonksiyondu. Yalnızca
-- pg_catalog'daki yerleşik fonksiyonları (lower, coalesce) kullandığı için
-- boş arama yolu davranışı değiştirmez. Tekrar çalıştırılabilir.
-- =========================================================
alter function public.arku_plan_rank(text) set search_path = '';

-- DOĞRULAMA
--   select proconfig from pg_proc where proname = 'arku_plan_rank';  -- {search_path=""}
--   select public.arku_plan_rank('Business'), public.arku_plan_rank(null);  -- 3, 0
-- GERİ ALMA
--   alter function public.arku_plan_rank(text) reset search_path;
