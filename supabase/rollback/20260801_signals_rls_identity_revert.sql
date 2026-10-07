-- =========================================================
-- ⚠️  ACİL DURUM GERİ ALMA — DİKKATLE KULLANIN
--
-- Bu dosya signals politikalarını İZİNLİ hâline döndürür ve böylece
-- S1 (tüm sinyallerin okunabilmesi = IP/ICE sızıntısı) ile
-- S2 (sahte kimlikle çağrı üretme) açıklarını YENİDEN AÇAR.
--
-- Kimliğe bağlı politikalar 2026-08-01'de uygulandı ve uçtan uca test
-- edildi (7/7 geçti). Bu dosyayı yalnızca bağlantı akışında gerçek bir
-- bozulma görürseniz çalıştırın, sorunu çözdükten sonra
-- 20260801_signals_rls_identity.sql'i tekrar uygulayın.
--
-- GERİ ALMADAN ÖNCE ŞUNU KONTROL EDİN: sorun büyük ihtimalle istemcinin
-- oturumsuz olmasıdır (eski sürüm masaüstü kurulumu). Çözüm, o istemciyi
-- v1.0.15+'a güncellemektir — politikaları geri almak değil.
-- =========================================================
--
-- Tarih: 2026-08-01
--
-- 20260801_signals_rls_identity.sql uygulandıktan sonra bağlantı akışında
-- HERHANGİ bir sorun görürseniz bunu çalıştırın. Saniyeler içinde
-- 2026-08-01 sabahındaki (çalışan) duruma dönersiniz.
--
-- Bu dosya, teşhis çıktısında ölçülen GERÇEK duruma göre yazılmıştır:
--   signals_select : anon,authenticated  USING true
--   signals_insert : anon,authenticated  CHECK (from_id/to_id not null)
--   signals_delete : anon,authenticated  USING (created_at < now()-30s)
-- =========================================================

begin;

alter table public.signals enable row level security;

drop policy if exists "signals_insert" on public.signals;
drop policy if exists "signals_select" on public.signals;
drop policy if exists "signals_delete" on public.signals;

create policy "signals_insert"
on public.signals for insert
to authenticated, anon
with check (from_id is not null and to_id is not null);

create policy "signals_select"
on public.signals for select
to authenticated, anon
using (true);

-- DELETE'in 30 saniye koruması korunur (bu zaten uygulanmış ve sorun çıkarmadı).
create policy "signals_delete"
on public.signals for delete
to authenticated, anon
using (created_at < now() - interval '30 seconds');

-- Misafir akışı anon rolüne dönerse çözümleme yetkisi de geri verilmeli.
grant execute on function public.resolve_connection_id(text) to anon;

commit;
