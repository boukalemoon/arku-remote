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
--
-- NASIL KULLANILIR — İKİ KEZ ÇALIŞTIRIN
--   1) Migration UYGULAMADAN ÖNCE: çıktıyı saklayın. Bu sizin "önce" haliniz;
--      bir şey bozulursa neyin değiştiğini ancak buna bakarak anlarsınız.
--      Henüz var olmayan tablolar çıktıda HİÇ GÖRÜNMEZ — hata değil.
--   2) Migration UYGULADIKTAN SONRA: yeni tablolar ve fonksiyonlar listede
--      belirmeli ve "BEKLENEN:" yazan her satır beklenenle UYUŞMALI.
--      Uyuşmayan tek bir satır bile varsa devam etmeyin.
--
-- Bu betik yalnızca ŞEMANIN durumunu görür. Şemadan görünmeyen iki şeyi
-- dosyanın sonundaki nota bakarak elle kontrol edin.
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
    and c.relname in ('signals','users','connections','logs','subscriptions',
                      'organizations','organization_members','saved_contacts','contact_categories',
                      -- 2026-09 sonunda gelenler. Migration uygulanmadıysa
                      -- satır HİÇ ÇIKMAZ; bu bir hata değil, "henüz yok" demek.
                      'user_devices','device_links','turn_issue_log','qrtim_link_secrets')

  union all

  -- 2) Politikaların tam metni (asıl belirleyici bilgi)
  select 2, 'B. POLITIKALAR',
         tablename || ' · ' || policyname || '  [' || cmd || ']',
         'roller=' || array_to_string(roles, ',')
           || '  |  USING=' || coalesce(qual, '(yok)')
           || '  |  CHECK=' || coalesce(with_check, '(yok)')
  from pg_policies
  where schemaname = 'public'
    and tablename in ('signals','users','connections','logs',
                      'user_devices','device_links')

  union all

  -- 3) anon rolünün TABLO düzeyindeki yetkileri.
  --    RLS ancak bu temel yetki varsa devreye girer; yetki yoksa politika
  --    ne derse desin erişim olmaz.
  select 3, 'C. ANON TABLO YETKISI',
         t.tbl,
         'select=' || case when has_table_privilege('anon', 'public.'||t.tbl, 'select') then 'VAR' else 'yok' end
           || '  insert=' || case when has_table_privilege('anon', 'public.'||t.tbl, 'insert') then 'VAR' else 'yok' end
           || '  delete=' || case when has_table_privilege('anon', 'public.'||t.tbl, 'delete') then 'VAR' else 'yok' end
  from (values ('signals'),('users'),('connections'),('logs'),('subscriptions'),
               ('user_devices'),('device_links'),('turn_issue_log'),
               ('qrtim_link_secrets')) as t(tbl)
  where to_regclass('public.' || t.tbl) is not null

  union all

  -- 4) Fonksiyonlar: security definer mı, kim çağırabiliyor?
  --
  -- Her satırın sonunda BEKLENEN değer yazıyor; çıktıda "BEKLENEN" ile
  -- gerçeğin uyuşmadığı tek bir satır bile varsa orada durun.
  --
  -- İki grup var:
  --   * service_role'e ait olanlar — yalnızca edge fonksiyonları çağırır,
  --     istemciye HİÇ açık olmamalı (ikisi de "hayir").
  --   * istemcinin çağırdıkları — anon "hayir", authenticated "CAGIRABILIR".
  select 4, 'D. FONKSIYON',
         p.proname::text,
         case when p.prosecdef then 'SECURITY DEFINER' else 'security invoker' end
           || '  |  anon=' || case when has_function_privilege('anon', p.oid, 'execute') then 'CAGIRABILIR' else 'hayir' end
           || '  |  authenticated=' || case when has_function_privilege('authenticated', p.oid, 'execute') then 'CAGIRABILIR' else 'hayir' end
           || '  |  BEKLENEN: ' ||
           case when p.proname in ('arku_qrtim_resolve_account','arku_turn_rate_limit',
                                   'arku_user_devices_limit','arku_device_links_rate_limit',
                                   'arku_qrtim_apply_plan','arku_qrtim_revoke_link')
                then 'anon=hayir, authenticated=hayir'
                else 'anon=hayir, authenticated=CAGIRABILIR'
           end
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      -- İstemcinin çağırdıkları
      'resolve_connection_id','arku_effective_subscription','arku_plan_at_least',
      'arku_ensure_connection_id','arku_bind_org_invites','arku_qrtim_unlink',
      'arku_not_anonymous','arku_presence',
      -- Yalnızca service_role / trigger — API yüzeyinde OLMAMALI
      'arku_qrtim_resolve_account','arku_turn_rate_limit',
      'arku_user_devices_limit','arku_device_links_rate_limit',
      'arku_qrtim_apply_plan','arku_qrtim_revoke_link')

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

  union all

  -- 8) Yalnızca sunucunun eriştiği tablolar.
  --
  -- Bu ikisinde POLİTİKA OLMAMASI kasıtlıdır: RLS açık + politika yok = hiçbir
  -- istemci rolü tek satır göremez. Buraya bir gün politika eklenirse sır
  -- (qrtim_link_secrets) istemciye açılmış olur. O yüzden beklenen değer
  -- ekranda yazıyor.
  select 8, 'H. SUNUCUYA OZEL TABLOLAR',
         t.tbl,
         'RLS=' || case when (select c.relrowsecurity from pg_class c
                              join pg_namespace n on n.oid = c.relnamespace
                              where n.nspname='public' and c.relname = t.tbl)
                        then 'ACIK' else '!!! KAPALI !!!' end
           || '  politika=' || (select count(*)::text from pg_policies
                                 where schemaname='public' and tablename = t.tbl)
           || '  |  BEKLENEN: RLS=ACIK, politika=0'
  from (values ('qrtim_link_secrets'),('turn_issue_log')) as t(tbl)
  where to_regclass('public.' || t.tbl) is not null

) t
order by sira, ad;

-- =========================================================
-- ELLE KONTROL — bunlar SQL'den GÖRÜNMEZ
--
-- 1) Dashboard → Authentication → Sign In / Providers
--      "Allow anonymous sign-ins"  AÇIK olmalı
--      Misafir akışının ön koşulu. Kapalıysa misafirler bağlanamaz ve TURN
--      kimliği alamaz (turn-credentials artık gerçek oturum istiyor).
--
-- 2) Dashboard → Authentication → Providers → Email
--      "Confirm email"  AÇIK olmalı
--      QRtım hesap taşıması buna güveniyor: yalnızca DOĞRULANMIŞ e-postayla
--      eşleşen hesap taşınıyor (20260921_qrtim_uid_identity).
--
-- 3) Dashboard → Edge Functions → Secrets
--      QRTIM_SSO_ENABLED  → TANIMSIZ olmalı (QRtım girişi kapalı).
--      Açılacaksa istemcide src/App.tsx > QRTIM_ENABLED de true yapılmalı;
--      biri tek başına yetmez. Önce 20260921_qrtim_uid_identity,
--      20260921_org_invite_verified_email, 20260922_qrtim_link_secrets ve
--      20260922_qrtim_plan_expiry uygulanmış olmalı.
--
-- 4) pg_cron görevleri (yukarıdaki G bölümü eklentinin kurulu olduğunu söyler,
--    görevleri söylemez):
--      select jobname, schedule, active from cron.job order by jobname;
--    Beklenenler: arku-clean-signals, arku-clean-logs, arku-clean-turn-log,
--    arku-clean-device-links (sonuncusu yalnızca İlgezdi göçü uygulandıysa).
-- =========================================================
