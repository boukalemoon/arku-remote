-- =========================================================
-- Arku Remote — Faz 3: kimlik, çevrimiçi durum ve kurumsal davet
-- Tarih: 2026-09-08
--
-- ÜÇ AYRI SORUNU ÇÖZER. Hiçbiri mevcut satırları DEĞİŞTİRMEZ; yalnızca
-- fonksiyon ekler. Mevcut kullanıcıların kimlikleri OLDUĞU GİBİ KALIR.
--
-- 1) K3 — Kimlik çakışması
--    connection_id istemcide üretiliyordu: 32-bit djb2 hash(uuid), sonra
--    9 haneye KIRPILIYORDU ("2147483647" -> "214748364"). users.connection_id
--    unique olduğu için çakışma çapraz bağlantıya yol açmıyor ama upsert
--    sessizce başarısız oluyor (istemci hatayı kontrol etmiyor) ve kullanıcı
--    KİMLİKSİZ kalıyor — kimse ona bağlanamıyor.
--    Doğum günü sınırı: ~10.000 kullanıcıda %4, ~33.000'de %50.
--    Ayrıca kimlik UUID'den deterministik türediği için ASLA değiştirilemiyor.
--
--    Çözüm: kimliği sunucu üretir, kriptografik rastgelelikle, çakışmada
--    yeniden dener. Misafir kimliğinin cihaz parmak izinden türetilmesi de
--    biter (aynı imajla kurulmuş kurumsal filoda hepsi aynı kimliği alıyordu).
--
-- 2) O1 — Kurumsal vanity kimlik (acme-01) hiç çalışmıyordu
--    resolve_connection_id, organization_members.user_id arıyor; ancak
--    addOrgMember bunu NULL bırakıyor ve davet kabul akışı HİÇ YOK.
--    Sonuç: yalnızca org sahibinin kendi satırı çözümlenebiliyordu.
--
--    Çözüm: kullanıcı giriş yaptığında e-postasına açılmış davetler
--    otomatik bağlanır.
--
-- 3) O3 — Çevrimiçi durum yok
--    Hedefin açık olup olmadığı görülemiyor; kimlik yazıp 30 sn bekleniyor.
--    users.last_seen yazılıyor ama hiç okunmuyor (RLS başkasının satırını
--    zaten vermez).
--
--    Çözüm: yalnızca kimlik + son görülme döndüren security definer RPC.
-- =========================================================

begin;

-- ---------------------------------------------------------
-- Yardımcı: 9 haneyi 123-456-789 biçimine sokar
-- ---------------------------------------------------------
create or replace function public.arku_format_id(digits text)
returns text
language sql
immutable
as $$
  select substr(digits, 1, 3) || '-' || substr(digits, 4, 3) || '-' || substr(digits, 7, 3);
$$;

-- ---------------------------------------------------------
-- 1) arku_ensure_connection_id — kimliği getir, yoksa ata
--
-- MEVCUT KİMLİĞİ ASLA DEĞİŞTİRMEZ. Kayıtlı müşteri listelerinin ve
-- paylaşılmış kimliklerin bozulmaması için bu şart.
-- Yalnızca connection_id boş olan kullanıcıya yeni kimlik verir —
-- bu, hash çakışması yüzünden kimliksiz kalmış kullanıcıları da onarır.
--
-- Aralık: 100-000-000 .. 999-999-999 (9 hane, baştaki sıfır yok).
-- gen_random_bytes ile üretilir; tahmin edilebilir olmaması kimlik
-- taramasını (ID enumeration) zorlaştırır.
-- ---------------------------------------------------------
create or replace function public.arku_ensure_connection_id()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_email     text;
  v_existing  text;
  v_candidate text;
  v_num       bigint;
  v_try       int := 0;
begin
  if v_uid is null then
    raise exception 'Oturum gerekli';
  end if;

  -- users satırı henüz yoksa oluştur (istemcinin upsert'ünden bağımsız çalışsın).
  select email into v_email from auth.users where id = v_uid;
  insert into public.users (id, email)
  values (v_uid, v_email)
  on conflict (id) do nothing;

  select connection_id into v_existing from public.users where id = v_uid;
  if v_existing is not null and length(trim(v_existing)) > 0 then
    return v_existing;
  end if;

  loop
    v_try := v_try + 1;

    -- 4 rastgele bayt -> işaretsiz aralığa çek -> 9 haneli aralığa indir
    v_num := (abs((('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::int)::bigint)
              % 900000000) + 100000000;
    v_candidate := public.arku_format_id(v_num::text);

    begin
      update public.users set connection_id = v_candidate where id = v_uid;
      return v_candidate;
    exception when unique_violation then
      -- Çakıştı; yeniden dene. 1e9 alanda 25 deneme fazlasıyla yeterli.
      if v_try >= 25 then
        raise exception 'Benzersiz kimlik üretilemedi';
      end if;
    end;
  end loop;
end $$;

revoke all on function public.arku_ensure_connection_id() from public;
grant execute on function public.arku_ensure_connection_id() to authenticated;

-- ---------------------------------------------------------
-- 2) arku_bind_org_invites — e-postaya açılmış davetleri bağlar
--
-- Kullanıcı giriş yaptığında çağrılır. invited_email eşleşen ve henüz
-- bağlanmamış üyelik satırlarını bu kullanıcıya bağlar; böylece
-- resolve_connection_id('<slug>-<device_label>') çalışır hale gelir.
--
-- Yalnızca 'invited' durumundaki, user_id'si BOŞ satırlara dokunur —
-- başka birinin bağlı üyeliğini devralmak mümkün değildir.
-- ---------------------------------------------------------
create or replace function public.arku_bind_org_invites()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_email text;
  v_count integer := 0;
begin
  if v_uid is null then return 0; end if;

  select email into v_email from auth.users where id = v_uid;
  if v_email is null or length(trim(v_email)) = 0 then return 0; end if;

  update public.organization_members
     set user_id = v_uid,
         status  = 'active'
   where user_id is null
     and status = 'invited'
     and lower(invited_email) = lower(v_email);

  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.arku_bind_org_invites() from public;
grant execute on function public.arku_bind_org_invites() to authenticated;

-- ---------------------------------------------------------
-- 3) arku_presence — kayıtlı kimliklerin çevrimiçi durumu
--
-- YALNIZCA connection_id + son görülme + çevrimiçi bayrağı döndürür.
-- E-posta, ad, telefon, cihaz parmak izi gibi hiçbir PII sızmaz —
-- users tablosunun RLS'i (yalnızca kendi satırın) yerinde kalır.
--
-- Kimlik taramasını sınırlamak için sorgu başına en fazla 200 kimlik.
-- Çevrimiçi eşiği 90 sn: istemci 60 sn'de bir kalp atışı gönderir,
-- bir atışın kaçması cihazı çevrimdışı göstermez.
-- ---------------------------------------------------------
create or replace function public.arku_presence(p_ids text[])
returns table (connection_id text, last_seen timestamptz, online boolean)
language sql
security definer
set search_path = public
stable
as $$
  select u.connection_id,
         u.last_seen,
         (u.last_seen is not null and u.last_seen > now() - interval '90 seconds')
  from public.users u
  where p_ids is not null
    and array_length(p_ids, 1) <= 200
    and u.connection_id = any(p_ids);
$$;

revoke all on function public.arku_presence(text[]) from public;
grant execute on function public.arku_presence(text[]) to authenticated;

-- last_seen üzerinden yapılan presence sorgusu için (kimlik ile filtreleniyor,
-- mevcut idx_users_connection_id yeterli — ek indeks gerekmiyor).

commit;

-- =========================================================
-- DOĞRULAMA
--   select public.arku_format_id('123456789');        -- 123-456-789
--   select public.arku_ensure_connection_id();        -- mevcut kimliği döndürmeli
--   select public.arku_bind_org_invites();            -- 0 (davet yoksa)
--   select * from public.arku_presence(array['000-000-000']); -- 0 satır
--
-- GERİ ALMA (fonksiyonlar veri değiştirmez, düşürmek güvenlidir):
--   drop function if exists public.arku_presence(text[]);
--   drop function if exists public.arku_bind_org_invites();
--   drop function if exists public.arku_ensure_connection_id();
--   drop function if exists public.arku_format_id(text);
-- İstemci, fonksiyon yoksa eski davranışına düşecek şekilde yazılmıştır.
-- =========================================================
