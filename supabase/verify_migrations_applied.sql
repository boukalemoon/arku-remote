-- =========================================================
-- Arku Remote — HANGİ MIGRATION CANLIDA?
-- Tarih: 2026-10-04
--
-- SALT OKUNUR. Hiçbir şeyi değiştirmez.
--
-- NEDEN VAR
-- Depodaki migration DOSYALARI, veritabanına UYGULANMIŞ migration'lar demek
-- değildir; Supabase bunu bir yerde tutmuyor. verify_security_state.sql canlı
-- durumu gösteriyor ama "şu dosya çalıştırıldı mı" sorusunu doğrudan
-- cevaplamıyor — o çıktıya bakıp eksik nesneden geriye doğru akıl yürütmek
-- gerekiyor. Bu betik o akıl yürütmeyi yapıyor.
--
-- YÖNTEM: her migration'ın yarattığı bir İŞARET NESNESİ aranıyor (tablo,
-- fonksiyon, kolon, politika, tetikleyici ya da bir yetki kısıtı). İşaret
-- varsa o dosya uygulanmıştır.
--
-- SINIRI DÜRÜSTÇE: işaret nesnesi, dosyanın TAMAMININ çalıştığını değil,
-- ÇALIŞMAYA BAŞLADIĞINI gösterir. Migration'lar begin/commit içinde olduğu
-- için yarım kalma ihtimali düşük; yine de "UYGULANDI" satırı bir garanti
-- değil, güçlü bir karinedir.
--
-- pg_cron görevleri burada YOK (eklenti kurulu değilken bu betiği de
-- çalıştırılamaz hale getiriyor). Onlar için ayrıca:
--   select jobname, schedule, active from cron.job order by jobname;
-- =========================================================

with kontrol(sira, dosya, tur, nesne, aciklama) as (values
  ( 1, '20260419_fix_signals_table_and_policies', 'tablo',        'signals',
       'Sinyallesme tablosu — bu yoksa hicbir baglanti kurulamaz'),
  ( 2, '20260509_enable_realtime_signals',        'yayin',        'signals',
       'WebSocket teslimati; yoksa cagri bildirimi gelmez (polling emniyet agi devreye girer)'),
  ( 3, '20260510_add_qrtim_columns_to_users',     'kolon',        'users.qrtim_id',
       'QRtim hesap baglama alanlari'),
  ( 4, '20260704_arku_subscriptions_orgs',        'tablo',        'subscriptions',
       'Abonelik ve kurumsal temel'),
  ( 5, '20260727_signals_delete_hardening',       'politika',     'signals|signals_delete',
       'Bayat sinyal silme kurali (30 sn)'),
  ( 6, '20260801_signals_rls_identity',           'fonksiyon',    'arku_owns_identity',
       'S1/S2: baskasinin sinyallerini okuma ve sahte kimlikle yazma kapandi'),
  ( 7, '20260801_harden_function_grants',         'yetki_anon_yok', 'arku_owns_identity',
       'Kimlik fonksiyonlari anon rolune kapali'),
  ( 8, '20260802_website_reviews',                'tablo',        'website_reviews',
       'Tanitim sitesi yorumlari'),
  ( 9, '20260803_device_unattended',              'tablo',        'device_unattended',
       'Gozetimsiz erisim izni + riza kaydi'),
  (10, '20260908_identity_presence_invites',      'fonksiyon',    'arku_presence',
       'K3/O1/O3: sunucu kimligi, davet baglama, cevrimici durumu'),
  (11, '20260908_identity_functions_revoke_anon', 'yetki_anon_yok', 'arku_ensure_connection_id',
       'Kimlik atama anon rolune kapali'),
  (12, '20260909_session_audit_chain',            'tablo',        'session_audit',
       'Denetim izi hash zinciri (ispat kaydi)'),
  (13, '20260909_signals_rate_limit',             'tetikleyici',  'trg_signals_rate_limit',
       'S6: sinyal sel ve kimlik taramasi sinirlamasi'),
  (14, '20260910_harden_trigger_functions',       'yetki_auth_yok', 'arku_signals_rate_limit',
       'Trigger fonksiyonlari REST API yuzeyinden kaldirildi'),
  (15, '20260912_org_owner_bootstrap',            'fonksiyon',    'arku_org_add_founder',
       'ZORUNLU: bu yoksa Kurumsal sekmesi calismaz (firma acilir, uye eklenemez)'),
  (16, '20260912_authz_hardening',                'fonksiyon',    'arku_qrtim_unlink',
       'O3/O4: baskasinin planini okuma + kendi rolunu/kimligini degistirme kapandi'),
  (17, '20260912_plan_enforcement',               'fonksiyon',    'arku_plan_at_least',
       'O2: plan ve koltuk siniri SUNUCUDA zorlaniyor (yoksa ucretsiz hesap ucretli ozellikleri kullanir)'),
  (18, '20260912_retention_cleanup',              'fonksiyon',    'arku_purge_stale_anon',
       'Saklama sureleri: log 90 gun, yetim anonim hesap 30 gun'),
  (19, '20260921_qrtim_uid_identity',             'kolon',        'users.qrtim_uid',
       'QRtim eslestirmesi kalici kimlige gecti (QRtim girisi acilmadan ONCE gerekli)'),
  (20, '20260921_org_invite_verified_email',      'fonksiyon_govde', 'arku_bind_org_invites|email_confirmed_at',
       'Kurum daveti yalnizca DOGRULANMIS e-postaya baglanir'),
  (21, '20260921_turn_rate_limit',                'tablo',        'turn_issue_log',
       'B1: TURN kimlik bilgisi icin kisi basi hiz siniri'),
  (22, '20260921_ilgezdi_device_links',           'tablo',        'user_devices',
       'Ilgezdi cihazlari arasi sinyal (yalnizca Ilgezdi entegrasyonu icin)'),
  (23, '20260922_qrtim_link_secrets',             'tablo',        'qrtim_link_secrets',
       'QRtim plan tazeleme sirri (QRtim girisi acilmadan ONCE gerekli)'),
  (24, '20260922_qrtim_plan_expiry',              'fonksiyon',    'arku_qrtim_apply_plan',
       'QRtim planina 72 saatlik gecerlilik ufku (QRtim girisi acilmadan ONCE gerekli)')
)
select
  k.sira,
  k.dosya,
  case
    -- Tablo var mı?
    when k.tur = 'tablo' then
      case when to_regclass('public.' || k.nesne) is not null
           then 'UYGULANDI' else '!!! EKSIK !!!' end

    -- Fonksiyon var mı?
    when k.tur = 'fonksiyon' then
      case when exists (select 1 from pg_proc p
                        join pg_namespace n on n.oid = p.pronamespace
                        where n.nspname = 'public' and p.proname = k.nesne)
           then 'UYGULANDI' else '!!! EKSIK !!!' end

    -- Fonksiyon var VE gövdesinde beklenen ifade geçiyor mu?
    -- (İçeriği değişen, yeni nesne yaratmayan migration'lar için.)
    when k.tur = 'fonksiyon_govde' then
      case when exists (select 1 from pg_proc p
                        join pg_namespace n on n.oid = p.pronamespace
                        where n.nspname = 'public'
                          and p.proname = split_part(k.nesne, '|', 1)
                          and p.prosrc like '%' || split_part(k.nesne, '|', 2) || '%')
           then 'UYGULANDI' else '!!! EKSIK !!!' end

    -- Kolon var mı? (nesne = 'tablo.kolon')
    when k.tur = 'kolon' then
      case when exists (select 1 from information_schema.columns c
                        where c.table_schema = 'public'
                          and c.table_name = split_part(k.nesne, '.', 1)
                          and c.column_name = split_part(k.nesne, '.', 2))
           then 'UYGULANDI' else '!!! EKSIK !!!' end

    -- Politika var mı? (nesne = 'tablo|politika')
    when k.tur = 'politika' then
      case when exists (select 1 from pg_policies
                        where schemaname = 'public'
                          and tablename = split_part(k.nesne, '|', 1)
                          and policyname = split_part(k.nesne, '|', 2))
           then 'UYGULANDI' else '!!! EKSIK !!!' end

    -- Tetikleyici var mı?
    when k.tur = 'tetikleyici' then
      case when exists (select 1 from pg_trigger t
                        where not t.tgisinternal and t.tgname = k.nesne)
           then 'UYGULANDI' else '!!! EKSIK !!!' end

    -- Yetki KISITI uygulanmış mı? Fonksiyon var ama o rol çağıramıyor olmalı.
    when k.tur = 'yetki_anon_yok' then
      case when not exists (select 1 from pg_proc p
                            join pg_namespace n on n.oid = p.pronamespace
                            where n.nspname = 'public' and p.proname = k.nesne)
             then 'fonksiyon yok'
           when exists (select 1 from pg_proc p
                        join pg_namespace n on n.oid = p.pronamespace
                        where n.nspname = 'public' and p.proname = k.nesne
                          and has_function_privilege('anon', p.oid, 'execute'))
             then '!!! EKSIK !!!'
           else 'UYGULANDI' end

    when k.tur = 'yetki_auth_yok' then
      case when not exists (select 1 from pg_proc p
                            join pg_namespace n on n.oid = p.pronamespace
                            where n.nspname = 'public' and p.proname = k.nesne)
             then 'fonksiyon yok'
           when exists (select 1 from pg_proc p
                        join pg_namespace n on n.oid = p.pronamespace
                        where n.nspname = 'public' and p.proname = k.nesne
                          and has_function_privilege('authenticated', p.oid, 'execute'))
             then '!!! EKSIK !!!'
           else 'UYGULANDI' end

    -- Realtime yayınında mı?
    when k.tur = 'yayin' then
      case when exists (select 1 from pg_publication_tables
                        where pubname = 'supabase_realtime'
                          and schemaname = 'public' and tablename = k.nesne)
           then 'UYGULANDI' else '!!! EKSIK !!!' end
  end as durum,
  k.aciklama
from kontrol k
order by k.sira;

-- =========================================================
-- ÇIKTIYI OKUMA
--
-- "!!! EKSIK !!!" olan her satır, o dosyanın veritabanında ÇALIŞTIRILMADIĞI
-- anlamına gelir. Sıra önemlidir: eksikleri DOSYA ADINDAKİ TARİH SIRASINA göre
-- uygulayın, atlamayın.
--
-- Uyguladıktan sonra bu betiği TEKRAR çalıştırın; hepsi "UYGULANDI" demeli.
-- Ardından verify_security_state.sql ile canlı güvenlik durumuna bakın.
--
-- 20260702_arku_initial_schema.sql BU LİSTEDE YOK ve olmamalı: o dosya izinli
-- politikaları yeniden kurar ve sonraki migration'ların kapattığı açıkları
-- GERİ AÇAR. Mevcut projede asla çalıştırılmamalıdır.
-- =========================================================
