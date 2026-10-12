-- =========================================================
-- 2026-10-11: arku_ensure_connection_id atomik hale getirildi
-- =========================================================
-- Kural: hesapla giren kullanıcının TEK ve DEĞİŞMEZ bir bağlantı kimliği
-- vardır (aynı hesapla hangi cihazdan girilirse girilsin aynı numara).
-- Misafirler (anonim oturum) her yeni oturumda yeni kimlik alır; bu
-- bilinçli: kalıcı numara isteyen hesap açar.
--
-- Sorun (bağımsız inceleme bulgusu): fonksiyon kimliği KİLİTSİZ okuyup
-- sonra yazıyordu. Satır zaten varsa ve kimlik boşsa, eşzamanlı iki çağrı
-- ikisi de "boş" görüp farklı numara üretiyor, sonra yazan öncekinin
-- üzerine yazıyordu. Bir istemci, kimsenin ulaşamayacağı bir numarayı
-- "hazır" diye gösterebiliyordu.
--
-- Düzeltme:
--   1. Kimlik `FOR UPDATE` ile okunur: aynı hesap için ikinci çağrı birincinin
--      işlemi bitene kadar bekler, sonra ATANMIŞ numarayı görür ve onu döner.
--   2. Yazma yalnızca `connection_id is null` iken olur; atanmış kimlik
--      hiçbir koşulda değiştirilmez. Yazılamazsa (başka işlem atadıysa)
--      mevcut değer okunup döndürülür.
-- Davranış dışında hiçbir şey değişmez (imza, yetki, biçim aynı).
create or replace function public.arku_ensure_connection_id()
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
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

  select email into v_email from auth.users where id = v_uid;
  insert into public.users (id, email)
  values (v_uid, v_email)
  on conflict (id) do nothing;

  -- Satırı kilitle: aynı hesabın eşzamanlı çağrıları burada sıraya girer.
  select connection_id into v_existing from public.users where id = v_uid for update;
  if v_existing is not null and length(trim(v_existing)) > 0 then
    return v_existing;
  end if;

  loop
    v_try := v_try + 1;

    -- 4 rastgele bayt -> işaretsiz 0..2^32-1 -> 9 haneli aralık
    v_num := ((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint)
              % 900000000) + 100000000;
    v_candidate := public.arku_format_id(v_num::text);

    begin
      update public.users set connection_id = v_candidate
       where id = v_uid and connection_id is null;
      if found then
        return v_candidate;
      end if;
      -- Kilit altında olmamız gerekirdi; yine de atanmışsa onu dön.
      select connection_id into v_existing from public.users where id = v_uid;
      return v_existing;
    exception when unique_violation then
      if v_try >= 25 then
        raise exception 'Benzersiz kimlik üretilemedi';
      end if;
    end;
  end loop;
end $function$;
