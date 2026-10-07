-- =========================================================
-- Denetim 2026-10-07, bulgu Y2: yeni kullanıcıya sunucu kimliği atanamıyor
-- =========================================================
-- Sorun: arku_ensure_connection_id `set search_path = public` ile çalışıyor ve
-- gen_random_bytes'ı nitelemeden çağırıyor. pgcrypto Supabase'te `extensions`
-- şemasında olduğu için çağrı "function gen_random_bytes(integer) does not
-- exist" ile düşüyor. Kimliği zaten olan kullanıcılar erken dönüşe takıldığı
-- için sorun yalnızca YENİ hesaplarda görünüyor. İstemci yedeği de
-- connection_id yazamıyor (20260912_authz_hardening kolon yetkisini kaldırdı),
-- dolayısıyla yeni hesap hiç çağrı alamıyor.
--
-- Ayrıca: (bit(32)::int) işaretli olduğu için abs(-2147483648) taşma hatası
-- verebiliyordu (2^32'de 1 olasılık). bit(32)::bigint işaretsiz değer verir.
--
-- Canlıda kanıt (salt okuma): `set local search_path = public; select
-- gen_random_bytes(4)` -> 42883. 2026-10-07.
--
-- Uygulama: Dashboard > SQL Editor. Yeniden çalıştırılabilir (create or replace).
-- Doğrulama: yeni bir anonim oturumla `select public.arku_ensure_connection_id();`
-- 9 haneli kimlik döndürmeli.
-- =========================================================

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

    -- 4 rastgele bayt -> işaretsiz 0..2^32-1 -> 9 haneli aralık
    v_num := ((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint)
              % 900000000) + 100000000;
    v_candidate := public.arku_format_id(v_num::text);

    begin
      update public.users set connection_id = v_candidate where id = v_uid;
      return v_candidate;
    exception when unique_violation then
      if v_try >= 25 then
        raise exception 'Benzersiz kimlik üretilemedi';
      end if;
    end;
  end loop;
end $$;

revoke all on function public.arku_ensure_connection_id() from public, anon;
grant execute on function public.arku_ensure_connection_id() to authenticated;
