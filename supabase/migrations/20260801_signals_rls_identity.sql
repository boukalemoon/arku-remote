-- =========================================================
-- Arku Remote — signals RLS'i kimliğe bağlama (AŞAMA 2)
-- Tarih: 2026-08-01
-- DURUM: ✅ UYGULANDI ve CANLI DOĞRULANDI (2026-08-01)
--
-- Uygulama sonrası REST API üzerinden yapılan uçtan uca test (7/7 geçti):
--   1. users kimlik bağlaması ................................ HTTP 201 ✓
--   2. INSERT from_id = kendi UUID (arayan) .................. HTTP 201 ✓
--   3. INSERT from_id = connection_id (alıcının cevabı) ...... HTTP 201 ✓  ← KRİTİK
--   4. INSERT sahte from_id .................................. HTTP 403 ✓  ← S2 kapandı
--   5. Kendi sinyallerini görme .............................. 2 satır  ✓
--   6. Başkasının sinyallerini görme ......................... 0 satır  ✓  ← S1 kapandı
--   7. Oturumsuz (anon rolü) okuma ........................... 0 satır  ✓
--
-- 3. madde, eski `from_id = auth.uid()` tasarımının reddedeceği ve
-- "görüntü gelmiyor" semptomunu geri getirecek olan yoldur.
--
-- ÖN KOŞULLAR (uygulama anında hepsi doğrulanmıştı):
--   1) Dashboard → Authentication → Sign In / Providers →
--      "Allow anonymous sign-ins" AÇIK olmalı.
--   2) İstemcinin v1.0.15 (veya üstü) sürümü yayında olmalı. O sürüm
--      her sekmeye anonim oturum açar, users satırına display kimliğini
--      yazar ve realtime.setAuth() çağırır.
--   3) Uygulamayı bir kez açıp misafir sekmesinde de oturum oluştuğunu
--      doğrulayın (Ayarlar'da kimlik görünüyorsa oturum vardır).
--
-- GERİ ALMA: 20260801_signals_rls_identity_revert.sql — tek komut,
-- anında bugünkü çalışan duruma döner.
-- =========================================================

begin;

-- ---------------------------------------------------------
-- Kimlik sahipliği
--
-- Bir kullanıcının İKİ kimliği olabilir ve ikisi de meşrudur:
--   * auth.uid()          → arayan taraf kendini bununla imzalar
--   * users.connection_id → alıcı taraf, arayanın kendisini çağırdığı
--                           kimlikle (123-456-789) cevap verir
--
-- ÖNEMLİ: yalnızca `from_id = auth.uid()` şartı koyan bir politika
-- alıcının cevabını REDDEDER ve "bağlantı kuruluyor ama görüntü gelmiyor"
-- semptomunu geri getirir. Bu fonksiyon o yüzden ikisini de kabul eder.
-- ---------------------------------------------------------
create or replace function public.arku_owns_identity(ident text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    ident is not null
    and auth.uid() is not null
    and (
      ident = auth.uid()::text
      or exists (
        select 1
        from public.users u
        where u.id = auth.uid()
          and u.connection_id = ident
      )
    );
$$;

revoke all on function public.arku_owns_identity(text) from public;
grant execute on function public.arku_owns_identity(text) to authenticated;

-- ---------------------------------------------------------
-- Politikalar
-- ---------------------------------------------------------
alter table public.signals enable row level security;

drop policy if exists "signals_insert"      on public.signals;
drop policy if exists "signals_select"      on public.signals;
drop policy if exists "signals_delete"      on public.signals;
drop policy if exists "signals_insert_auth" on public.signals;
drop policy if exists "signals_select_auth" on public.signals;
drop policy if exists "signals_delete_auth" on public.signals;

-- Yalnızca kendi kimliğin adına sinyal yazabilirsin (sahte çağrı engellenir).
create policy "signals_insert"
on public.signals for insert
to authenticated
with check (
  to_id is not null
  and public.arku_owns_identity(from_id)
);

-- Yalnızca tarafı olduğun sinyalleri okuyabilirsin.
-- (ICE adayları IP adresi içerir; bu politika onların üçüncü kişilerce
--  okunmasını ve bağlantı grafiğinin çıkarılmasını engeller.)
create policy "signals_select"
on public.signals for select
to authenticated
using (
  public.arku_owns_identity(to_id)
  or public.arku_owns_identity(from_id)
);

-- Silme: hem tarafı olacaksın hem de satır bayatlamış olacak.
-- 30 sn kuralı korunuyor — aktif çağrının güncel sinyalleri silinemez.
create policy "signals_delete"
on public.signals for delete
to authenticated
using (
  created_at < now() - interval '30 seconds'
  and (
    public.arku_owns_identity(to_id)
    or public.arku_owns_identity(from_id)
  )
);

-- Kimlik çözümleme artık yalnızca oturumlu kullanıcılara açık.
-- (v1.0.15'ten sonra her istemcinin oturumu var; anon rolüne gerek kalmadı.
--  Bu, kimlik numaralandırmasını da zorlaştırır.)
revoke execute on function public.resolve_connection_id(text) from anon;

commit;

-- =========================================================
-- UYGULADIKTAN SONRA DOĞRULAMA
--
-- 1) supabase/verify_security_state.sql'i tekrar çalıştırın.
--    Beklenen: signals politikalarının rolü artık yalnızca "authenticated",
--    SELECT USING'i "true" DEĞİL.
--
-- 2) CANLI TEST (en önemlisi) — iki sekme, biri gizli pencere:
--    a. Misafir → kayıtlı kullanıcı: görüntü geliyor mu?
--    b. Kayıtlı → misafir: çağrı gidiyor mu?
--    c. Kayıtlı → kayıtlı: bozulmadı mı?
--    d. Reddet ve iptal anında çalışıyor mu?
--
--    Log panelinde "Signal kanalı hazır (WebSocket)" görünmeli. Yalnızca
--    "(polling)" satırları görünüyorsa realtime RLS'i geçemiyor demektir →
--    realtime.setAuth çalışmıyordur, GERİ ALIN.
--
-- 3) Herhangi bir adım başarısızsa:
--    20260801_signals_rls_identity_revert.sql
-- =========================================================
