-- =========================================================
-- Arku Remote — fonksiyon yetkileri ve search_path sertleştirmesi
-- Tarih: 2026-08-01
-- DURUM: ✅ UYGULANDI
--
-- Kaynak: Supabase database linter (get_advisors → security).
--
-- v1.0.15'ten sonra HER istemcinin bir oturumu var (misafirler anonim
-- imzalanıyor), dolayısıyla anon rolünün bu SECURITY DEFINER fonksiyonları
-- çağırmasına gerek kalmadı. İlgili RLS politikalarının tamamı zaten
-- `to authenticated` olduğu için bu iptaller uygulamayı etkilemez.
-- =========================================================

begin;

-- SECURITY DEFINER fonksiyonların anon üzerinden çağrılabilmesi, oturum
-- açmadan veri sızdırma yüzeyidir (örn. abonelik/organizasyon bilgisi).
revoke execute on function public.arku_owns_identity(text)          from anon;
revoke execute on function public.arku_effective_subscription(uuid) from anon;
revoke execute on function public.arku_is_org_member(uuid, uuid)    from anon;
revoke execute on function public.arku_org_role(uuid, uuid)         from anon;

-- Değiştirilebilir search_path, SECURITY DEFINER fonksiyonlarda yetki
-- yükseltme vektörüdür. Gövdeyi yeniden tanımlamadan sabitleniyor.
alter function public.arku_map_qrtim_plan(text) set search_path = public;
alter function public.arku_set_updated_at()     set search_path = public;

commit;

-- =========================================================
-- BİLİNÇLİ OLARAK DOKUNULMAYANLAR
--
-- 1) public.rls_auto_enable() — linter "anon çağırabiliyor" diye uyarıyor
--    ancak bu bir EVENT TRIGGER fonksiyonudur (returns event_trigger).
--    PostgREST event_trigger dönen fonksiyonları yayınlamaz, yani
--    /rest/v1/rpc üzerinden çağrılamaz. Üstelik savunma amaçlıdır:
--    public şemasında oluşturulan yeni tablolarda RLS'i otomatik açar ve
--    search_path'i zaten sabitlenmiştir. Yetkisini iptal etmenin güvenlik
--    faydası yok, event trigger mekanizmasını etkileme riski var.
--
-- 2) citext eklentisi public şemasında — taşımak, citext kolonları olan
--    tabloları bozabilir. Fayda/risk oranı düşük.
--
-- 3) "Leaked password protection" kapalı — bu bir Dashboard ayarıdır
--    (Authentication → Policies), SQL ile açılamaz. Açılması önerilir.
-- =========================================================
