-- =========================================================
-- Arku Remote — Eşzamanlı oturum sayısını plana bağla
-- Tarih: 2026-10-05
--
-- ÜRÜN KARARI: ücretsiz hesap aynı anda 4 müşteriye bağlanabilir, ücretli
-- planlarda tavan 20. Sekmeler arası geçiş her iki planda da aynı.
--
-- ⚠ BU KONTROLÜN NEYİ ZORLADIĞINI AÇIKÇA YAZIYORUM
--
-- Eşzamanlı oturum sayısı doğası gereği İSTEMCİDE belirlenir: her oturum iki
-- uç arasında kurulan bir WebRTC bağlantısıdır, sunucu onu açmaz. Bu
-- tetikleyici, resmi istemcinin her oturum için yazdığı `connections` satırını
-- sayar. Değiştirilmiş bir istemci satırı hiç yazmayıp sınırı aşabilir.
--
-- Yani bu, ödeme yapmayan kullanıcıyı durduran bir güvenlik sınırı DEĞİL;
-- sınırı arayüzün yanında sunucuda da tutan bir ürün kontrolü. Yine de
-- yazılmasının sebebi O2 dersi (20260912_plan_enforcement): ücretli bir
-- özelliğin kapısını YALNIZCA arayüze koymak, doğrudan REST çağrısıyla
-- aşılabilen bir kapı demektir.
--
-- Kötüye kullanıma karşı asıl koruyan katmanlar başka yerde ve onlar gerçekten
-- sunucuda: sinyal hız sınırı (20260909_signals_rate_limit), TURN kişi başı
-- sınırı (20260921_turn_rate_limit) ve coturn kotaları (turnserver.conf).
--
-- ÖN KOŞUL: 20260912_plan_enforcement (arku_plan_at_least) uygulanmış olmalı.
-- =========================================================

begin;

-- ---------------------------------------------------------
-- Plana göre tavan. Tek yer: istemcideki SESSION_LIMITS ile aynı değerler
-- (src/lib/supabase.ts). İkisi ayrışırsa kullanıcı arayüzde izin verilen ama
-- sunucuda reddedilen bir işlem görür — değiştirirken İKİSİNİ birden.
-- ---------------------------------------------------------
create or replace function public.arku_session_limit(p_uid uuid)
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select case when public.arku_plan_at_least(p_uid, 'pro') then 20 else 4 end;
$$;

revoke all     on function public.arku_session_limit(uuid) from public;
revoke execute on function public.arku_session_limit(uuid) from anon;
grant  execute on function public.arku_session_limit(uuid) to authenticated;

-- ---------------------------------------------------------
-- Tetikleyici: yeni oturum satırı açılırken açık oturumları say.
--
-- BAYAT SATIR TEHLİKESİ: istemci çökerse `ended_at` hiç yazılmaz ve satır
-- sonsuza kadar "açık" görünür. Böyle satırlar birikirse kullanıcı kendi
-- hesabından kilitlenir — ödeme yapan bir müşteriyi bağlanamaz hale getirmek,
-- sınırın bir fazlasına izin vermekten çok daha kötüdür. Bu yüzden sayım
-- YALNIZCA son 12 saatte açılmış satırları kapsar: çökmüş bir oturum en fazla
-- 12 saat yer tutar, sonra kendiliğinden düşer.
-- ---------------------------------------------------------
create or replace function public.arku_connections_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_acik  integer;
  v_tavan integer;
begin
  select count(*) into v_acik
  from public.connections c
  where c.caller_id = new.caller_id
    and c.status = 'active'
    and c.ended_at is null
    and c.created_at > now() - interval '12 hours';

  v_tavan := public.arku_session_limit(new.caller_id);

  if v_acik >= v_tavan then
    raise exception 'Esmanli oturum siniri dolu (% oturum). Bir sekmeyi kapatin ya da aboneliginizi yukseltin.', v_tavan
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

revoke all     on function public.arku_connections_limit() from public;
revoke execute on function public.arku_connections_limit() from anon, authenticated;

drop trigger if exists trg_connections_limit on public.connections;
create trigger trg_connections_limit
  before insert on public.connections
  for each row execute function public.arku_connections_limit();

commit;

-- ---------------------------------------------------------
-- Bayat oturum satırlarını kapat (günde bir). Sayım penceresi zaten 12 saat,
-- bu görev tabloyu da dürüst tutar: bağlantı geçmişinde sonsuza kadar "açık"
-- görünen satır kalmasın.
-- ---------------------------------------------------------
do $$
begin
  perform cron.unschedule('arku-close-stale-connections');
exception when others then
  null;
end $$;

select cron.schedule(
  'arku-close-stale-connections',
  '13 5 * * *',  -- her gün 05:13 UTC
  $job$update public.connections
         set status = 'ended', ended_at = created_at + interval '12 hours'
       where status = 'active' and ended_at is null
         and created_at < now() - interval '12 hours'$job$
);

-- =========================================================
-- DOĞRULAMA
--
-- 1) Tavan doğru mu:
--      select public.arku_session_limit('<ucretsiz-uuid>');  -- 4
--      select public.arku_session_limit('<ucretli-uuid>');   -- 20
--
-- 2) Fonksiyon API yüzeyinde OLMAMALI (trigger fonksiyonu):
--      select array(select r.rolname from pg_roles r
--                   where has_function_privilege(r.rolname, p.oid,'EXECUTE')
--                     and r.rolname in ('anon','authenticated'))
--      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--      where n.nspname='public' and p.proname='arku_connections_limit';
--
-- 3) CANLI TEST: ücretsiz bir hesapla 4 oturum açın, beşinci reddedilmeli ve
--    kullanıcı anlamlı bir hata görmeli. Sonra planı yükseltip tekrar deneyin.
--
-- 4) Bayat satır kontrolü (kilitlenme olmamalı):
--      select caller_id, count(*) from public.connections
--       where status='active' and ended_at is null
--         and created_at > now() - interval '12 hours'
--       group by caller_id order by 2 desc limit 10;
--
-- GERİ ALMA
--   begin;
--   drop trigger if exists trg_connections_limit on public.connections;
--   drop function if exists public.arku_connections_limit();
--   drop function if exists public.arku_session_limit(uuid);
--   commit;
--   select cron.unschedule('arku-close-stale-connections');
-- =========================================================
