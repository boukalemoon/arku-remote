-- =========================================================
-- Arku Remote — Trigger fonksiyonlarını API yüzeyinden kaldır
-- Tarih: 2026-09-10
--
-- BULGU (Supabase security advisor): trigger fonksiyonları REST üzerinden
-- RPC olarak çağrılabiliyordu:
--   /rest/v1/rpc/arku_audit_chain
--   /rest/v1/rpc/arku_signals_rate_limit
--   /rest/v1/rpc/rls_auto_enable ...
--
-- Doğrudan çağrılmaları zaten hata verir (trigger bağlamı dışında NEW kaydı
-- yoktur), ama SECURITY DEFINER fonksiyonların genel API yüzeyinde durması
-- gereksiz risktir. İkisi (arku_audit_chain, arku_signals_rate_limit) bu
-- oturumda eklendi; kalanlar eski migration'lardan geliyordu.
--
-- ÖNEMLİ: PostgreSQL, trigger ATEŞLENİRKEN fonksiyon üzerinde EXECUTE
-- yetkisi ARAMAZ — yetki yalnızca trigger OLUŞTURULURKEN kontrol edilir.
-- Bu yüzden aşağıdaki revoke'lar trigger'ları bozmaz. Uygulama sonrası
-- signals ve session_audit insert'leri ile doğrulandı.
--
-- İKİ AŞAMA GEREKTİ: rol bazlı revoke tek başına yetmedi, çünkü bu
-- fonksiyonlar EXECUTE yetkisini doğrudan grant'tan değil PUBLIC üzerinden
-- alıyordu. `revoke ... from public` şart.
-- =========================================================

begin;

-- 1) PUBLIC üzerinden gelen yetki
revoke all on function public.arku_signals_rate_limit()   from public;
revoke all on function public.arku_audit_chain()          from public;
revoke all on function public.arku_audit_immutable()      from public;
revoke all on function public.arku_du_require_consent()   from public;
revoke all on function public.arku_set_updated_at()       from public;
revoke all on function public.rls_auto_enable()           from public;

-- 2) Supabase'in varsayılan yetkileriyle verilmiş doğrudan grant'lar
revoke execute on function public.arku_signals_rate_limit()   from anon, authenticated;
revoke execute on function public.arku_audit_chain()          from anon, authenticated;
revoke execute on function public.arku_audit_immutable()      from anon, authenticated;
revoke execute on function public.arku_du_require_consent()   from anon, authenticated;
revoke execute on function public.arku_set_updated_at()       from anon, authenticated;
revoke execute on function public.rls_auto_enable()           from anon, authenticated;

-- 3) search_path sabitlenmemiş fonksiyonlar.
-- Üçü de SECURITY DEFINER DEĞİL (yetki yükseltme vektörü yok) ama mutable
-- search_path, fonksiyonun beklemediği bir şemadaki nesneyi çağırmasına yol
-- açabilir. Sabitlemek bedava.
alter function public.arku_du_require_consent() set search_path = public;
alter function public.arku_format_id(text)      set search_path = public;
alter function public.arku_audit_immutable()    set search_path = public;

commit;

-- =========================================================
-- DOĞRULAMA — api_yuzeyi hepsinde boş olmalı:
--
--   select p.proname,
--          array(select r.rolname from pg_roles r
--                where has_function_privilege(r.rolname, p.oid,'EXECUTE')
--                  and r.rolname in ('anon','authenticated')) as api_yuzeyi
--   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--   where n.nspname='public' and p.proname in
--     ('arku_signals_rate_limit','arku_audit_chain','arku_audit_immutable',
--      'arku_du_require_consent','arku_set_updated_at','rls_auto_enable');
--
-- Ardından normal bir bağlantı kurup denetim kaydı üretin: trigger'lar
-- çalışmaya devam etmeli.
-- =========================================================
