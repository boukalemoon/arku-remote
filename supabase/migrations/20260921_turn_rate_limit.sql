-- =========================================================
-- Arku Remote — TURN kimlik bilgisi için kişi başı hız sınırı (B1)
-- Tarih: 2026-09-21
--
-- SORUN
-- `turn-credentials` fonksiyonu, projenin HERKESE AÇIK anon anahtarıyla da
-- çağrılabiliyordu. O anahtar geçerli bir JWT'dir ve her kuruluma gömülüdür,
-- dolayısıyla Supabase gateway'in imza doğrulaması kimseyi elemiyordu:
-- oturumu olmayan biri de relay (TURN) kimliği alıp bant genişliğimizi
-- harcayabiliyordu. Asıl zarar faturadan çok KAPASİTE: coturn'de
-- total-quota=200 ve relay port aralığı ~70 eşzamanlı aktarma demek; bunları
-- dolduran biri meşru kullanıcıların bağlanmasını engeller.
--
-- ÇÖZÜM İKİ PARÇALI
--   1) Fonksiyon artık `role = authenticated` ve dolu `sub` arıyor
--      (supabase/functions/turn-credentials/index.ts).
--   2) Bu migration: aynı kullanıcının sınırsız kimlik bilgisi üretmesini
--      engelleyen sayaç.
--
-- BU SINIRIN SINIRI — DÜRÜSTÇE
-- Misafir akışı için anonim girişler AÇIK (DEPLOYMENT.md § panel ayarları).
-- Anonim kullanıcı da `authenticated` rolüyle gelir, yani saldırgan yeni
-- anonim oturum açarak yeni bir `sub` alabilir ve bu sayacı sıfırlayabilir.
-- Kişi başı sınır, tek bir oturumla yapılan kazımayı durdurur; kitlesel
-- hesap üretimini durduracak olan Supabase Auth'un IP başına anonim giriş
-- sınırı ve (açılırsa) CAPTCHA'dır. Üçüncü katman coturn'ün kendi kotalarıdır.
-- Bu üçü birlikte anlamlıdır; hiçbiri tek başına yeterli değildir.
-- =========================================================

begin;

-- ---------------------------------------------------------
-- Sayaç tablosu
--
-- Tek amacı sayım. Kişisel veri taşımaz: yalnızca kullanıcı kimliği ve zaman.
-- (ICE adayları gibi IP içeren bir şey BURAYA YAZILMAZ.)
-- ---------------------------------------------------------
create table if not exists public.turn_issue_log (
  id         bigint generated always as identity primary key,
  caller     text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_turn_issue_log_caller
  on public.turn_issue_log (caller, created_at desc);

-- RLS açık ve POLİTİKA YOK: hiçbir istemci rolü bu tabloyu göremez.
-- Yalnızca service_role ve aşağıdaki SECURITY DEFINER fonksiyon erişir.
alter table public.turn_issue_log enable row level security;

revoke all on table public.turn_issue_log from anon, authenticated;

-- ---------------------------------------------------------
-- arku_turn_rate_limit — izin varsa true döner ve isteği kaydeder
--
-- Sınır neden 30/10dk: meşru istemci kimlik bilgisini TTL boyunca (12 saat)
-- önbelleğe alır, yani normal kullanımda saatte BİR istek yapar. Aynı hesapla
-- birkaç pencere açık olsa bile 10 dakikada 30'a yaklaşmak mümkün değildir.
-- Tavan, meşru kullanımı hiç etkilemeyecek kadar yüksek; kazımayı durduracak
-- kadar düşüktür.
-- ---------------------------------------------------------
create or replace function public.arku_turn_rate_limit(p_caller text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count  integer;
  c_limit  constant integer  := 30;
  c_window constant interval := interval '10 minutes';
begin
  if p_caller is null or length(trim(p_caller)) = 0 then
    return false;
  end if;

  -- Kendi çöpünü toplar: bu satırların ömrü sayım penceresi kadardır.
  -- Aşağıdaki cron görevi yalnızca bir daha hiç dönmeyen çağıranlar için.
  delete from public.turn_issue_log
   where caller = p_caller
     and created_at < now() - (c_window * 3);

  select count(*) into v_count
  from public.turn_issue_log
  where caller = p_caller
    and created_at > now() - c_window;

  if v_count >= c_limit then
    return false;
  end if;

  insert into public.turn_issue_log (caller) values (p_caller);
  return true;
end $$;

revoke all     on function public.arku_turn_rate_limit(text) from public;
revoke execute on function public.arku_turn_rate_limit(text) from anon, authenticated;
grant  execute on function public.arku_turn_rate_limit(text) to service_role;

commit;

-- ---------------------------------------------------------
-- Artık dönmeyen çağıranların satırlarını topla (pg_cron zaten kurulu).
-- ---------------------------------------------------------
do $$
begin
  perform cron.unschedule('arku-clean-turn-log');
exception when others then
  null; -- görev yoksa sorun değil (yeniden çalıştırılabilir olsun diye)
end $$;

select cron.schedule(
  'arku-clean-turn-log',
  '37 4 * * *',  -- her gün 04:37 UTC
  $job$delete from public.turn_issue_log where created_at < now() - interval '1 hour'$job$
);

-- =========================================================
-- DOĞRULAMA
--
-- 1) Tablo istemciye kapalı olmalı (ikisi de 'yok'):
--      select 'select=' || case when has_table_privilege('anon','public.turn_issue_log','select')
--                               then 'VAR' else 'yok' end,
--             'select=' || case when has_table_privilege('authenticated','public.turn_issue_log','select')
--                               then 'VAR' else 'yok' end;
--
-- 2) Fonksiyon API yüzeyinde OLMAMALI (boş dizi):
--      select array(select r.rolname from pg_roles r
--                   where has_function_privilege(r.rolname, p.oid,'EXECUTE')
--                     and r.rolname in ('anon','authenticated'))
--      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--      where n.nspname='public' and p.proname='arku_turn_rate_limit';
--
-- 3) Sayaç çalışıyor mu (service_role ile, SQL Editor):
--      select public.arku_turn_rate_limit('test-kullanici');  -- true
--      -- 30 kez çağrılınca false dönmeli
--      delete from public.turn_issue_log where caller = 'test-kullanici';
--
-- 4) CANLI TEST: normal bir bağlantı kurun. Günlükte ICE kaynağı 'edge'
--    görünmeli ve bağlantı bozulmamalı.
--
-- GERİ ALMA
--   begin;
--   drop function if exists public.arku_turn_rate_limit(text);
--   drop table if exists public.turn_issue_log;
--   commit;
--   select cron.unschedule('arku-clean-turn-log');
--   -- Fonksiyon yoksa turn-credentials sınırı atlar (çağrı hatası yok sayılır),
--   -- kimlik doğrulama kapısı yerinde kalır.
-- =========================================================
