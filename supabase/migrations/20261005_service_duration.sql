-- =========================================================
-- Arku Remote — Hizmet süresini sunucuda ölç (faturalanabilir süre)
-- Tarih: 2026-10-05
--
-- AMAÇ
-- Hizmet veren taraf, bir müşteriye ne kadar süre hizmet verdiğini görebilsin
-- ve bunun üzerinden ücretlendirebilsin.
--
-- BUGÜNKÜ DURUM VE NEDEN YETMİYOR
-- `connections` satırını istemci yazıyor ve İKİ alanı da kendi saatinden
-- dolduruyor: `created_at` (açıkça gönderiliyor) ve `duration_seconds`
-- (kapanışta hesaplanıyor). Ücreti ödeyen tarafın, süreyi ölçenin karşı taraf
-- olduğu bir sayıya dayanması gerekir. Ayrıca istemci çökerse satır sonsuza
-- kadar `status='active'`, süre 0 kalıyor.
--
-- ÇÖZÜM — üç parça
--   1) Zaman damgaları SUNUCUDAN. İstemci artık `created_at` ve
--      `duration_seconds` kolonlarına YAZAMAZ (kolon düzeyi yetki).
--   2) KALP ATIŞI. Oturum sürerken istemci 60 saniyede bir `last_heartbeat`
--      günceller; o da sunucu saatiyle damgalanır (trigger). Faturalanabilir
--      süre = coalesce(ended_at, last_heartbeat) - created_at.
--      Çöken oturum son atışta donar, sonsuza kadar saymaz. Süreyi şişirmek
--      için oturumu gerçekten açık tutmak gerekir.
--   3) RAPOR. arku_service_report, çağıranın KENDİ oturumlarını müşteri
--      bazında toplar.
--
-- NE ZORLAR, NE ZORLAMAZ
-- Bu, istemcinin kendi saatini kullanmasını ve süreyi serbestçe yazmasını
-- engeller. Oturumu gereksiz yere açık tutarak süre şişirmeyi engellemez —
-- onu engelleyen şey, açık oturumun karşı tarafta da görünür olmasıdır
-- (ekranda "bağlı" göstergesi) ve eşzamanlı oturum tavanıdır.
-- =========================================================

begin;

-- ---------------------------------------------------------
-- 1) Kalp atışı kolonu
-- ---------------------------------------------------------
alter table public.connections
  add column if not exists last_heartbeat timestamptz;

-- Mevcut satırlar: en iyi tahmin bitiş, yoksa başlangıç.
update public.connections
   set last_heartbeat = coalesce(ended_at, created_at)
 where last_heartbeat is null;

create index if not exists idx_connections_caller_active
  on public.connections (caller_id, status) where ended_at is null;

-- ---------------------------------------------------------
-- 2) Zaman damgalarını sunucu koyar
--
-- Trigger hem INSERT hem UPDATE'te çalışır:
--   * created_at ve last_heartbeat her zaman SUNUCU saatinden
--   * ended_at istemciden gelse bile şimdiden ileri olamaz
--   * duration_seconds türetilir, istemciden gelen değer yok sayılır
-- ---------------------------------------------------------
create or replace function public.arku_connection_times()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at     := now();
    new.last_heartbeat := now();
    new.duration_seconds := 0;
    return new;
  end if;

  -- UPDATE: başlangıç zamanı asla değişmez.
  new.created_at := old.created_at;

  -- Kalp atışı yalnızca ileri gider ve şimdiyi aşamaz.
  if new.last_heartbeat is distinct from old.last_heartbeat then
    new.last_heartbeat := least(now(), greatest(coalesce(old.last_heartbeat, old.created_at), now()));
  end if;

  -- Bitiş zamanı gelecekte olamaz.
  if new.ended_at is not null then
    new.ended_at := least(new.ended_at, now());
    if new.ended_at < new.created_at then new.ended_at := new.created_at; end if;
  end if;

  new.duration_seconds := greatest(0, floor(extract(epoch from
    (coalesce(new.ended_at, new.last_heartbeat, new.created_at) - new.created_at)))::integer);

  return new;
end $$;

revoke all     on function public.arku_connection_times() from public;
revoke execute on function public.arku_connection_times() from anon, authenticated;

drop trigger if exists trg_connection_times on public.connections;
create trigger trg_connection_times
  before insert or update on public.connections
  for each row execute function public.arku_connection_times();

-- ---------------------------------------------------------
-- 3) Kolon düzeyi yetki (20260912_authz_hardening'deki O4 dersi)
--
-- İstemci yalnızca kimi aradığını ve oturumun hâlâ sürdüğünü bildirir.
-- Zaman ve süre alanlarına dokunamaz.
-- ---------------------------------------------------------
revoke insert, update on public.connections from authenticated;

grant insert (caller_id, receiver_id, status) on public.connections to authenticated;
grant update (status, ended_at, last_heartbeat) on public.connections to authenticated;

-- ---------------------------------------------------------
-- 4) Hizmet raporu — çağıranın KENDİ oturumları, müşteri bazında
--
-- Parametresiz kimlik: auth.uid(). Başkasının raporunu sorgulatan bir uç
-- yazılmaz (Arku'da O3 olarak düzeltilen hatanın aynısı olurdu).
-- ---------------------------------------------------------
create or replace function public.arku_service_report(
  p_from timestamptz,
  p_to   timestamptz
)
returns table (
  musteri        text,
  oturum_sayisi  integer,
  toplam_saniye  bigint,
  ilk_oturum     timestamptz,
  son_oturum     timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select c.receiver_id,
         count(*)::integer,
         coalesce(sum(c.duration_seconds), 0)::bigint,
         min(c.created_at),
         max(coalesce(c.ended_at, c.last_heartbeat))
  from public.connections c
  where c.caller_id = auth.uid()
    and c.created_at >= p_from
    and c.created_at <  p_to
  group by c.receiver_id
  order by 3 desc;
$$;

revoke all     on function public.arku_service_report(timestamptz, timestamptz) from public;
revoke execute on function public.arku_service_report(timestamptz, timestamptz) from anon;
grant  execute on function public.arku_service_report(timestamptz, timestamptz) to authenticated;

commit;

-- =========================================================
-- DOĞRULAMA
--
-- 1) İstemci artık süre yazamamalı (listede duration_seconds ve created_at
--    GÖRÜNMEMELİ):
--      select column_name, privilege_type
--      from information_schema.column_privileges
--      where table_schema='public' and table_name='connections'
--        and grantee='authenticated' and privilege_type in ('INSERT','UPDATE')
--      order by column_name;
--
-- 2) Süre sunucudan türüyor mu (test satırıyla):
--      insert into public.connections (caller_id, receiver_id, status)
--      values (auth.uid(), 'test-musteri', 'active') returning id, created_at, duration_seconds;
--      -- 60 sn sonra:
--      update public.connections set last_heartbeat = now() where id = '<id>';
--      select duration_seconds from public.connections where id = '<id>';  -- ~60
--      update public.connections set status='ended', ended_at = now() where id = '<id>';
--      delete from public.connections where id = '<id>';
--
-- 3) Rapor:
--      select * from public.arku_service_report(now() - interval '30 days', now());
--
-- GERİ ALMA
--   begin;
--   drop trigger if exists trg_connection_times on public.connections;
--   drop function if exists public.arku_connection_times();
--   drop function if exists public.arku_service_report(timestamptz, timestamptz);
--   grant insert, update on public.connections to authenticated;
--   commit;
--   -- last_heartbeat kolonu kalabilir; kimseyi rahatsız etmez.
-- =========================================================
