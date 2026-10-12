-- =========================================================
-- Arku Remote — İlgezdi cihaz bağlantısı (aynı hesabın cihazları)
-- Tarih: 2026-09-21
--
-- AMAÇ
-- Aynı hesabın İlgezdi cihazları birbirine WebRTC sinyali yollasın (sekme
-- gönderme). İçerik DTLS veri kanalından gider; bu tablolara YALNIZCA SDP ve
-- ICE yazılır. `signals` tablosuna ve arama akışına DOKUNULMAZ.
--
-- NEDEN `signals` KULLANILAMIYOR
-- Arku'da kimlik hesap bazında (arku_owns_identity: auth.uid() ya da
-- users.connection_id). `signals.to_id` hesaba gider ve hesabın BÜTÜN
-- istemcileri aynı satırları görür: İlgezdi'nin sekme göndermek için açacağı
-- `offer`, Arku masaüstünde "gelen bağlantı" penceresi açardı
-- (src/App.tsx → to_id=eq.<kimlik> dinleyicisi). Bu yüzden ayrı ve DAHA DAR
-- bir kutu: başka hesaba yazmak mümkün değil.
--
-- SUNUCU NEYİ GARANTİ EDER, NEYİ ETMEZ — AÇIKÇA
-- Politikalar HESAP SINIRINI korur: kimse başka bir hesabın cihazına yazamaz.
-- Ama `from_device` isteği gönderen cihaza bağlı DEĞİLDİR: aynı hesabın
-- herhangi bir oturumu, o hesabın herhangi bir cihazı adına sinyal yazabilir.
-- Karşıdaki cihazın gerçekten o cihaz olduğunu YALNIZCA İlgezdi'nin yerelde
-- sakladığı DTLS parmak izi garanti eder. Bu tasarım bilinçlidir (sunucuya
-- güvenilmiyor) ama ancak ilk eşleştirme kısa kodla doğrulanırsa anlamlıdır.
--
-- MEVCUT SATIRLARA DOKUNMAZ; yalnızca iki tablo ve iki tetikleyici ekler.
-- =========================================================

begin;

-- ---------------------------------------------------------
-- Yardımcı: çağıran misafir (anonim) oturum mu?
--
-- `authenticated` rolü misafirleri DE kapsar (misafir akışı anonim oturum
-- açıyor). Bu tablolar kalıcı hesaplar içindir: misafir oturumu 30 günde
-- siliniyor (20260912_retention_cleanup) ve sahibi doğrulanmamış. Kontrol
-- olmazsa misafir oturumları bedava sinyal kutusuna dönerdi.
--
-- Not: `is_anonymous` iddiası eski belirteçlerde olmayabilir; yokluğunda
-- kullanıcı gerçek sayılır (mevcut davranış bozulmasın).
-- ---------------------------------------------------------
create or replace function public.arku_not_anonymous()
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
     and auth.uid() is not null;
$$;

revoke all     on function public.arku_not_anonymous() from public;
revoke execute on function public.arku_not_anonymous() from anon;
grant  execute on function public.arku_not_anonymous() to authenticated;

-- ---------------------------------------------------------
-- 1) user_devices — hesabın İlgezdi cihazları
-- ---------------------------------------------------------
create table if not exists public.user_devices (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  app        text not null default 'ilgezdi' check (app in ('ilgezdi')),
  name       text not null check (char_length(name) between 1 and 60),
  platform   text not null check (platform in ('win32', 'darwin', 'linux')),
  created_at timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);

create index if not exists idx_user_devices_user on public.user_devices (user_id);

alter table public.user_devices enable row level security;

drop policy if exists "user_devices_select" on public.user_devices;
create policy "user_devices_select" on public.user_devices for select
to authenticated using (user_id = auth.uid());

drop policy if exists "user_devices_insert" on public.user_devices;
create policy "user_devices_insert" on public.user_devices for insert
to authenticated with check (user_id = auth.uid() and public.arku_not_anonymous());

drop policy if exists "user_devices_update" on public.user_devices;
create policy "user_devices_update" on public.user_devices for update
to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "user_devices_delete" on public.user_devices;
create policy "user_devices_delete" on public.user_devices for delete
to authenticated using (user_id = auth.uid());

-- Kolon düzeyi yetki (20260912_authz_hardening'deki O4 dersi): satır düzeyi
-- "kendi satırın" demek yeterli değil; İÇERİĞİ de sınırlamak gerekiyor.
-- İstemci yalnızca cihaz kimliğini, adını ve platformunu yazar; created_at,
-- last_seen ve app'i kendi belirleyemez (sonra yalnızca ad/son görülme).
revoke insert, update on public.user_devices from authenticated;
grant insert (id, name, platform) on public.user_devices to authenticated;
grant update (name, last_seen)    on public.user_devices to authenticated;

-- anon rolü tablo düzeyinde de göremesin. RLS zaten durduruyor (anon'a
-- politika yok) ama verify_security_state.sql yetkileri de raporluyor;
-- "yetki yok" demek, politikaya hiç güvenmemek demektir.
revoke all on table public.user_devices from anon;

-- Hesap başına en çok 20 cihaz.
-- Yarış durumu: eşzamanlı iki ekleme sınırı bir aşabilir. Bilinçli — bu bir
-- maliyet koruması, güvenlik sınırı değil (kilit almak her eklemeye bedel
-- bindirirdi).
create or replace function public.arku_user_devices_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  c_max   constant integer := 20;
begin
  select count(*) into v_count
  from public.user_devices
  where user_id = new.user_id;

  if v_count >= c_max then
    raise exception 'Cihaz siniri dolu (% cihaz). Kullanmadiginiz bir cihazi kaldirin.', c_max
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists trg_user_devices_limit on public.user_devices;
create trigger trg_user_devices_limit
  before insert on public.user_devices
  for each row execute function public.arku_user_devices_limit();

-- ---------------------------------------------------------
-- 2) device_links — aynı hesabın iki cihazı arasındaki sinyal kutusu
-- ---------------------------------------------------------
create table if not exists public.device_links (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  from_device uuid not null references public.user_devices(id) on delete cascade,
  to_device   uuid not null references public.user_devices(id) on delete cascade,
  type        text not null check (type in ('offer', 'answer', 'ice-candidate', 'hangup')),
  payload     jsonb not null check (octet_length(payload::text) <= 16384),
  created_at  timestamptz not null default now(),
  check (from_device <> to_device)
);

-- Dinleme: istemci to_device=eq.<kendi cihaz kimliği> filtresiyle bekler.
create index if not exists idx_device_links_to
  on public.device_links (to_device, created_at desc);
-- Hız sınırı sayımı bu indeksten gider.
create index if not exists idx_device_links_user_created
  on public.device_links (user_id, created_at desc);

alter table public.device_links enable row level security;

drop policy if exists "device_links_insert" on public.device_links;
create policy "device_links_insert" on public.device_links for insert
to authenticated
with check (
  user_id = auth.uid()
  and public.arku_not_anonymous()
  and exists (select 1 from public.user_devices d where d.id = from_device and d.user_id = auth.uid())
  and exists (select 1 from public.user_devices d where d.id = to_device   and d.user_id = auth.uid())
);

drop policy if exists "device_links_select" on public.device_links;
create policy "device_links_select" on public.device_links for select
to authenticated using (user_id = auth.uid());

-- Silme: `signals` ile aynı 30 saniye kuralı — aktif oturumun güncel
-- sinyalleri silinemez.
drop policy if exists "device_links_delete" on public.device_links;
create policy "device_links_delete" on public.device_links for delete
to authenticated
using (user_id = auth.uid() and created_at < now() - interval '30 seconds');

-- UPDATE politikası YOK: satırlar değiştirilemez. Yetkiyi de geri alıyoruz ki
-- tablo düzeyinde bir kapı açık kalmasın.
revoke update on public.device_links from authenticated;
revoke insert on public.device_links from authenticated;
grant  insert (from_device, to_device, type, payload) on public.device_links to authenticated;

revoke all on table public.device_links from anon;

-- Hız sınırı: kullanıcı başına dakikada 200 satır.
-- Normal bir eşleştirme ~30 sinyal üretir (1 offer + ~25 ICE + answer);
-- 200 tavanı aynı anda birkaç cihaza sekme göndermeye fazlasıyla yeter.
create or replace function public.arku_device_links_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  c_max   constant integer := 200;
begin
  select count(*) into v_count
  from public.device_links
  where user_id = new.user_id
    and created_at > now() - interval '60 seconds';

  if v_count >= c_max then
    raise exception 'Sinyal hizi siniri asildi (dakikada %). Lutfen biraz bekleyin.', c_max
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists trg_device_links_rate_limit on public.device_links;
create trigger trg_device_links_rate_limit
  before insert on public.device_links
  for each row execute function public.arku_device_links_rate_limit();

-- Tetikleyici fonksiyonlar REST API yüzeyinde durmasın (20260910 dersi:
-- yetki PUBLIC üzerinden de geldiği için iki aşamalı revoke şart).
revoke all     on function public.arku_user_devices_limit()      from public;
revoke all     on function public.arku_device_links_rate_limit() from public;
revoke execute on function public.arku_user_devices_limit()      from anon, authenticated;
revoke execute on function public.arku_device_links_rate_limit() from anon, authenticated;

commit;

-- ---------------------------------------------------------
-- 3) Realtime yayını (20260509'daki koşullu desen — `add table` ikinci
--    çalıştırmada hata verir, migration yeniden çalıştırılabilir kalmalı)
-- ---------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'device_links'
  ) then
    alter publication supabase_realtime add table public.device_links;
  end if;
end $$;

-- ---------------------------------------------------------
-- 4) Saklama süresi: 5 dakika (signals ile aynı gerekçe)
--    Her satır ICE adayı, yani IP adresi içerir — birikmesi gereksiz bir
--    kişisel veri yığınıdır (KVKK: veri minimizasyonu). Aktif bir eşleştirmenin
--    sinyalleri saniyeler içinde kullanılır, bu pencereye hiç girmez.
-- ---------------------------------------------------------
do $$
begin
  perform cron.unschedule('arku-clean-device-links');
exception when others then
  null; -- görev yoksa sorun değil
end $$;

select cron.schedule(
  'arku-clean-device-links',
  '*/5 * * * *',
  $job$delete from public.device_links where created_at < now() - interval '5 minutes'$job$
);

-- =========================================================
-- DOĞRULAMA
--
-- 1) RLS iki tabloda da AÇIK olmalı:
--      select relname, relrowsecurity from pg_class
--       where relname in ('user_devices','device_links');
--
-- 2) anon hiçbir şey görememeli (hepsi 'yok'):
--      select t.tbl,
--             case when has_table_privilege('anon','public.'||t.tbl,'select') then 'VAR' else 'yok' end
--      from (values ('user_devices'),('device_links')) as t(tbl);
--
-- 3) Kolon yetkileri — user_devices'ta created_at/app, device_links'te
--    user_id/created_at LİSTEDE OLMAMALI:
--      select table_name, column_name, privilege_type
--      from information_schema.column_privileges
--      where table_schema='public' and table_name in ('user_devices','device_links')
--        and grantee='authenticated' and privilege_type in ('INSERT','UPDATE')
--      order by table_name, column_name;
--
-- 4) İKİ HESAPLA TEST (asıl kabul ölçütü): B hesabının cihaz kimliğine
--    A hesabıyla yazmayı deneyin — politika reddetmeli:
--      insert into public.device_links (from_device, to_device, type, payload)
--      values ('<A-cihazi>', '<B-cihazi>', 'offer', '{}'::jsonb);
--      -- new row violates row-level security policy
--
-- 5) Misafir oturumu cihaz EKLEYEMEMELİ (anonim oturumla deneyin):
--      insert into public.user_devices (name, platform) values ('test','win32');
--      -- new row violates row-level security policy
--
-- 6) Arku masaüstü uygulaması bu tabloları DİNLEMİYOR olmalı ve arama akışı
--    değişmemeli: normal bir Arku bağlantısı kurun, hiçbir fark olmamalı.
--    (Depoda `device_links` / `user_devices` geçen tek yer bu migration ve
--     belgelerdir; istemci kodunda referans yoktur.)
--
-- GERİ ALMA (yalnızca bu özelliğin verisini siler, signals'a dokunmaz)
--   begin;
--   drop table if exists public.device_links;
--   drop table if exists public.user_devices;
--   drop function if exists public.arku_device_links_rate_limit();
--   drop function if exists public.arku_user_devices_limit();
--   drop function if exists public.arku_not_anonymous();
--   commit;
--   select cron.unschedule('arku-clean-device-links');
-- =========================================================
