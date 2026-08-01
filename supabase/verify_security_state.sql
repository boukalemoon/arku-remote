-- =========================================================
-- Arku Remote — CANLI GÜVENLİK DURUMU TEŞHİSİ
-- Tarih: 2026-08-01
--
-- SALT OKUNUR. Hiçbir şeyi değiştirmez, hiçbir satıra dokunmaz.
-- Supabase Dashboard → SQL Editor'a yapıştırıp çalıştırın ve
-- çıkan tabloyu olduğu gibi paylaşın.
--
-- Neden: migration DOSYALARI depoda mevcut ama hangilerinin bu projeye
-- gerçekten UYGULANDIĞI dışarıdan bilinemiyor. RLS'i tahmine dayanarak
-- değiştirmek daha önce çalışan bağlantı akışını iki kez bozdu.
-- Bu betik, değişiklik tasarlamadan önce gerçeği ortaya koyar.
-- =========================================================

select bolum, ad, detay from (

  -- 1) Tablolarda RLS açık mı?
  select 1 as sira, 'A. RLS DURUMU' as bolum,
         c.relname::text as ad,
         case when c.relrowsecurity then 'RLS ACIK' else '!!! RLS KAPALI !!!' end as detay
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relname in ('signals','users','connections','logs',
                      'organizations','organization_members','saved_contacts','contact_categories')

  union all

  -- 2) Politikaların tam metni (asıl belirleyici bilgi)
  select 2, 'B. POLITIKALAR',
         tablename || ' · ' || policyname || '  [' || cmd || ']',
         'roller=' || array_to_string(roles, ',')
           || '  |  USING=' || coalesce(qual, '(yok)')
           || '  |  CHECK=' || coalesce(with_check, '(yok)')
  from pg_policies
  where schemaname = 'public'
    and tablename in ('signals','users','connections','logs')

  union all

  -- 3) anon rolünün TABLO düzeyindeki yetkileri.
  --    RLS ancak bu temel yetki varsa devreye girer; yetki yoksa politika
  --    ne derse desin erişim olmaz.
  select 3, 'C. ANON TABLO YETKISI',
         t.tbl,
         'select=' || case when has_table_privilege('anon', 'public.'||t.tbl, 'select') then 'VAR' else 'yok' end
           || '  insert=' || case when has_table_privilege('anon', 'public.'||t.tbl, 'insert') then 'VAR' else 'yok' end
           || '  delete=' || case when has_table_privilege('anon', 'public.'||t.tbl, 'delete') then 'VAR' else 'yok' end
  from (values ('signals'),('users'),('connections'),('logs')) as t(tbl)
  where to_regclass('public.' || t.tbl) is not null

  union all

  -- 4) Kimlik çözümleme fonksiyonu: var mı, security definer mı, kim çağırabiliyor?
  select 4, 'D. FONKSIYON',
         p.proname::text,
         case when p.prosecdef then 'SECURITY DEFINER' else 'security invoker' end
           || '  |  anon=' || case when has_function_privilege('anon', p.oid, 'execute') then 'CAGIRABILIR' else 'hayir' end
           || '  |  authenticated=' || case when has_function_privilege('authenticated', p.oid, 'execute') then 'CAGIRABILIR' else 'hayir' end
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('resolve_connection_id','arku_effective_subscription')

  union all

  -- 5) Realtime yayını: signals burada yoksa WebSocket teslimatı hiç çalışmaz.
  select 5, 'E. REALTIME YAYINI',
         tablename::text,
         'supabase_realtime yayininda'
  from pg_publication_tables
  where pubname = 'supabase_realtime' and schemaname = 'public'

  union all

  -- 6) signals tablosunda biriken satır sayısı (TTL temizliği çalışıyor mu?)
  select 6, 'F. SIGNALS HACMI', 'toplam satir',
         (select count(*)::text from public.signals)
  union all
  select 6, 'F. SIGNALS HACMI', '5 dakikadan eski satir',
         (select count(*)::text from public.signals where created_at < now() - interval '5 minutes')

  union all

  -- 7) Sunucu tarafı otomatik temizlik altyapısı var mı?
  --    NOT: cron.job tablosuna doğrudan referans verilmiyor — eklenti kurulu
  --    değilken sorgu planlanırken "relation cron.job does not exist" hatası
  --    veriyordu (case içinde olması engellemiyor, çünkü ad çözümlemesi
  --    çalıştırmadan önce yapılıyor).
  select 7, 'G. OTOMATIK TEMIZLIK', 'pg_cron eklentisi',
         case when exists (select 1 from pg_extension where extname = 'pg_cron')
              then 'KURULU — gorevleri gormek icin ayrica: select jobname, schedule, command from cron.job;'
              else 'kurulu degil — sunucu tarafi TTL temizligi yok, temizlik yalnizca istemciye bagli'
         end

) t
order by sira, ad;

-- =========================================================
-- AYRICA elle kontrol edilmesi gereken (SQL'den görünmeyen) tek şey:
--   Dashboard → Authentication → Sign In / Providers →
--   "Allow anonymous sign-ins" AÇIK mı?
-- Misafir akışını auth tabanlı korumaya alacaksak bu şart.
-- =========================================================
