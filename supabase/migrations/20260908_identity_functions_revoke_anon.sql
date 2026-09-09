-- =========================================================
-- Arku Remote — Faz 3 takip: yeni fonksiyonlarda anon yetkisini kaldır
-- Tarih: 2026-09-08
--
-- SORUN: 20260908_identity_presence_invites.sql içindeki
--   `revoke all on function ... from public`
-- yeterli DEĞİL. Supabase, public şemasında `alter default privileges`
-- ile yeni fonksiyonlara anon/authenticated/service_role için EXECUTE
-- verir; PUBLIC'ten alınan yetki bu doğrudan grant'ları kaldırmaz.
--
-- Uygulama sonrası doğrulamada anon'un dördünü de çalıştırabildiği görüldü.
--
-- ETKİSİ: asıl önemli olan arku_presence. Oturumsuz bir istemci rastgele
-- kimlikler için "bu ID çevrimiçi mi" sorgusu yapabilirdi (kimlik tarama).
-- Diğer ikisi auth.uid() null olduğunda zaten iş yapmaz (biri exception
-- fırlatır, biri 0 döner) ama tutarlılık için onlar da kapatılıyor.
--
-- NOT: 20260801_signals_rls_identity.sql'de resolve_connection_id için
-- aynı sertleştirme yapılmıştı; bu, o kararın yeni fonksiyonlara taşınması.
-- =========================================================

begin;

revoke execute on function public.arku_presence(text[])          from anon;
revoke execute on function public.arku_ensure_connection_id()    from anon;
revoke execute on function public.arku_bind_org_invites()        from anon;
revoke execute on function public.arku_format_id(text)           from anon;

commit;

-- =========================================================
-- DOĞRULAMA — yetkili_roller sütununda 'anon' GÖRÜNMEMELİ:
--
--   select p.proname,
--          array(select r.rolname from pg_roles r
--                where has_function_privilege(r.rolname, p.oid, 'EXECUTE')
--                  and r.rolname in ('anon','authenticated','service_role'))
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname='public'
--     and p.proname like 'arku_%';
-- =========================================================

-- ---------------------------------------------------------
-- EK (aynı gün, doğrulama sonrası): kalan iki fonksiyon
--
-- arku_format_id: orijinal migration'da `revoke ... from public`
--   ATLANMIŞTI, anon yetkiyi PUBLIC üzerinden alıyordu. Saf bir string
--   biçimlendiricidir, veri sızdırmaz — yine de tutarlılık için kapatılıyor.
--
-- arku_can_unattend: 20260803_device_unattended.sql'de `revoke from public`
--   yapılmış ama Supabase'in varsayılan yetkileri anon'a DOĞRUDAN grant
--   verdiği için anon hâlâ çalıştırabiliyordu. Bu fonksiyon gözetimsiz
--   erişim kararını verir; oturumsuz çağrılabilir olmamalı.
-- ---------------------------------------------------------
revoke all     on function public.arku_format_id(text)            from public;
revoke execute on function public.arku_format_id(text)            from anon;
revoke execute on function public.arku_can_unattend(uuid, uuid)   from anon;
