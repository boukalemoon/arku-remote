-- =========================================================
-- Arku Remote — istemci politikası: zorunlu masaüstü sürümü
-- Tarih: 2026-10-12
--
-- NEDEN
--   v1.6.0 oturum parolasını düz metin yerine HMAC kanıtı (pwh) olarak
--   gönderiyor. v1.4.0 ALICI bu kanıtı tanımıyor; yeni bir arayan eski bir
--   alıcıya parolayla bağlanamıyor ("parola hatalı"). Karar (Burak,
--   2026-10-12): eski istemciye düz metin parola göndermek yerine herkes
--   güncellesin.
--
--   v1.4.0 bu tabloyu okumaz; o istemciler mevcut otomatik güncelleyiciyle
--   (Windows kurulumu: arka planda indirir, çıkışta kurar) güncellenir.
--   Bu tablo v1.6.0 ve sonrası içindir: ileride bir sürümü zorunlu kılmak
--   için uygulama yeniden derlenmeden buradaki değer yükseltilir.
--
-- KULLANIM (Supabase panosu > Table editor > app_config ya da SQL):
--   update public.app_config set value = '1.7.0', updated_at = now()
--    where key = 'min_desktop_version';
--   Bu değerin altındaki masaüstü uygulaması bağlantı kuramaz, gelen
--   çağrıları kabul etmez ve kullanıcıya güncelleme ekranı gösterir.
--   Değer bozuksa (boş, "1.7" gibi) kapı DEVRE DIŞI kalır; kimse kilitlenmez.
--   SIRA ÖNEMLİ: önce o sürümü GitHub'da YAYIMLAYIN, sonra değeri yükseltin.
--   Yayımlanmamış bir sürümü zorunlu kılarsanız herkes "yeni sürüm henüz
--   yok" ekranında kilitli kalır.
--
-- ERİŞİM
--   Yalnızca oturumu olan istemciler (misafirler dahil, `authenticated`)
--   okuyabilir; `anon` rolüne tablo yetkisi verilmez (20261005 kuralı).
--   Yazma politikası YOK: yalnızca pano / service_role değiştirebilir.
-- =========================================================

begin;

create table if not exists public.app_config (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

comment on table public.app_config is
  'Istemci politikasi (herkese acik degerler). Yalnizca pano/service_role yazar.';

alter table public.app_config enable row level security;

revoke all on public.app_config from anon;
revoke all on public.app_config from authenticated;
grant select on public.app_config to authenticated;

drop policy if exists app_config_read on public.app_config;
create policy app_config_read on public.app_config
  for select to authenticated
  using (key in ('min_desktop_version'));

insert into public.app_config (key, value)
values ('min_desktop_version', '1.6.0')
on conflict (key) do nothing;

commit;
