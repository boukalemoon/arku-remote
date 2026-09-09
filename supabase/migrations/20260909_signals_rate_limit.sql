-- =========================================================
-- Arku Remote — signals hız sınırı (S6)
-- Tarih: 2026-09-09
--
-- SORUN
-- Anonim giriş açık olduğu için sınırsız kimlik üretilebiliyor ve `signals`
-- tablosuna herhangi bir `to_id`'ye sınırsız teklif yazılabiliyordu.
-- Oturum parolası artık RAHATSIZLIĞI engelliyor (yanlış parolalı çağrı
-- karşı tarafın ekranında hiç görünmüyor) ama veritabanı yazımı devam
-- ediyordu: maliyet ve tablo şişmesi.
--
-- İki ayrı davranışı sınırlıyoruz:
--   1) HACİM        — dakikada yazılan toplam sinyal
--   2) YAYILMA      — dakikada kaç FARKLI hedefe yazıldığı
-- İkincisi asıl kötüye kullanımı yakalar: kimlik taraması, yani binlerce
-- kimliği sırayla çalmaya çalışmak.
--
-- SINIRLAR NEDEN BÖYLE
-- Normal bir oturum ~30 sinyal üretir (1 offer + ~25 ICE + answer + hangup)
-- ve bu 10 saniyeye sığar. Arku aynı hesapla birden fazla pencereyi
-- destekler; 5 eşzamanlı oturum ~150 sinyal eder. 400 tavanı meşru en yoğun
-- kullanımın ~2,5 katıdır. Farklı hedef sayısı ise meşru kullanımda tek
-- hanelidir; 25 fazlasıyla geniştir.
--
-- Sınır aşılırsa istek REDDEDİLİR (sessizce yutulmaz) — istemci hatayı
-- görür ve kullanıcıya bildirir.
-- =========================================================

begin;

-- Sayım sorgusu (from_id, created_at) üzerinden gider. Mevcut
-- idx_signals_from_to_created_at'in ortasında to_id olduğu için bu sorguya
-- uygun değil; ayrı ve dar bir indeks ekliyoruz.
create index if not exists idx_signals_from_created
  on public.signals (from_id, created_at desc);

create or replace function public.arku_signals_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_toplam  integer;
  v_hedef   integer;
  c_toplam  constant integer := 400; -- dakikada sinyal
  c_hedef   constant integer := 25;  -- dakikada farklı hedef
begin
  select count(*), count(distinct to_id)
    into v_toplam, v_hedef
  from public.signals
  where from_id = new.from_id
    and created_at > now() - interval '60 seconds';

  if v_toplam >= c_toplam then
    raise exception 'Sinyal hizi siniri asildi (dakikada %). Lutfen biraz bekleyin.', c_toplam
      using errcode = 'check_violation';
  end if;

  -- Yeni hedef ekleniyorsa yayılma sınırını da kontrol et. Aynı hedefe
  -- devam eden bir oturum bu sınıra takılmaz.
  if v_hedef >= c_hedef
     and not exists (
       select 1 from public.signals
       where from_id = new.from_id
         and to_id = new.to_id
         and created_at > now() - interval '60 seconds'
     ) then
    raise exception 'Cok fazla farkli hedefe baglanti denemesi (dakikada %).', c_hedef
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists trg_signals_rate_limit on public.signals;
create trigger trg_signals_rate_limit
  before insert on public.signals
  for each row execute function public.arku_signals_rate_limit();

revoke all on function public.arku_signals_rate_limit() from public;

commit;

-- =========================================================
-- SINIRI DEĞİŞTİRMEK: yukarıdaki c_toplam / c_hedef sabitlerini düzenleyip
-- fonksiyonu yeniden oluşturun (create or replace).
--
-- DOĞRULAMA: normal bir bağlantı kurun — hiçbir şey değişmemeli.
--   select count(*) from public.signals
--    where created_at > now() - interval '60 seconds';
-- =========================================================
