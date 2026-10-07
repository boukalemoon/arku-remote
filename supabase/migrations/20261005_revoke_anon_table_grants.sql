-- =========================================================
-- Arku Remote — anon rolünün tablo yetkilerini geri al
-- Tarih: 2026-10-05
--
-- DURUM TESPİTİ (verify_security_state.sql, 04.10.2026)
--   C. ANON TABLO YETKISI
--     connections   select=VAR  insert=VAR  delete=VAR
--     logs          select=VAR  insert=VAR  delete=VAR
--     signals       select=VAR  insert=VAR  delete=VAR
--     subscriptions select=VAR  insert=VAR  delete=VAR
--     users         select=VAR  insert=VAR  delete=VAR
--
-- BUGÜN AÇIK KAPI DEĞİL. Bu tabloların hepsinde RLS açık ve `anon` rolü için
-- HİÇBİR politika yok; politikasız rol sıfır satır görür. 01.08.2026'da canlı
-- test edilmişti (20260801_signals_rls_identity, test 7: "oturumsuz okuma →
-- 0 satır"). Yani bu migration bir açığı KAPATMIYOR, bir TUZAĞI kaldırıyor.
--
-- TUZAK ŞU: koruma tek bir şeye, "anon için politika yazılmamış olmasına"
-- dayanıyor. Biri ileride `to public` bir politika yazarsa (ki `to public`
-- varsayılandır — rol belirtmeyi unutmak yeter) ya da bir tabloda RLS'i
-- geçici olarak kapatırsa, kapı aynı anda ardına kadar açılır. Tablo yetkisi
-- yoksa o hatanın bedeli yok: RLS ne derse desin erişim olmaz.
--
-- İŞLEVSEL ETKİSİ YOK. Her Arku istemcisinin bir oturumu var (misafirler dahil
-- anonim oturum açılıyor), yani veri erişimi hiçbir zaman `anon` rolüyle
-- yapılmıyor. Değişen tek şey, oturumsuz bir isteğin aldığı cevabın "0 satır"
-- yerine "permission denied" olması.
--
-- Not: `website_reviews` BU LİSTEDE YOK. Tanıtım sitesi yorumları oturumsuz
-- gönderilebiliyor olabilir; o tablo (henüz uygulanmamış olan
-- 20260802_website_reviews ile gelir) kendi kurallarıyla ele alınmalı.
-- =========================================================

begin;

revoke all on public.signals              from anon;
revoke all on public.users                from anon;
revoke all on public.connections          from anon;
revoke all on public.logs                 from anon;
revoke all on public.subscriptions        from anon;
revoke all on public.organizations        from anon;
revoke all on public.organization_members from anon;
revoke all on public.saved_contacts       from anon;
revoke all on public.contact_categories   from anon;

-- Bu ikisi daha sonraki migration'larla geldi; henüz yoksa atla.
do $$
begin
  if to_regclass('public.session_audit') is not null then
    execute 'revoke all on public.session_audit from anon';
  end if;
  if to_regclass('public.device_unattended') is not null then
    execute 'revoke all on public.device_unattended from anon';
  end if;
end $$;

-- Bundan SONRA public şemasında açılacak tablolar da anon'a kapalı doğsun.
-- (Supabase'in varsayılanı anon ve authenticated'a tam yetki vermektir; asıl
--  tuzağın kaynağı bu varsayılan.)
alter default privileges in schema public revoke all on tables from anon;

commit;

-- =========================================================
-- DOĞRULAMA
--
-- 1) verify_security_state.sql'i tekrar çalıştırın. C bölümünde artık
--    HEPSİ 'yok' demeli:
--      select=yok  insert=yok  delete=yok
--
-- 2) CANLI TEST (asıl kabul ölçütü) — uygulama hiç etkilenmemeli:
--    a. Misafir sekmesi açın, kimlik görünmeli.
--    b. Misafir → kayıtlı kullanıcı bağlantısı kurun, görüntü gelmeli.
--    c. Kayıtlı → kayıtlı bağlantı kurun.
--    d. Ayarlar'da plan etiketi görünmeli.
--    Hepsi oturumlu (authenticated) rolle çalışır; bu değişiklikten
--    etkilenmez. Biri bozulursa o akış gerçekten anon rolüyle veri
--    okuyormuş demektir — GERİ ALIN ve bana söyleyin.
--
-- GERİ ALMA (Supabase varsayılanına döner)
--   begin;
--   alter default privileges in schema public grant all on tables to anon;
--   grant all on public.signals, public.users, public.connections,
--                public.logs, public.subscriptions, public.organizations,
--                public.organization_members, public.saved_contacts,
--                public.contact_categories to anon;
--   commit;
-- =========================================================
