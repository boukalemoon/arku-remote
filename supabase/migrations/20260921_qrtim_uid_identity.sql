-- =========================================================
-- Arku Remote — QRtım eşleştirmesini kalıcı kimliğe taşı (qrtim_uid)
-- Tarih: 2026-09-21
--
-- SORUN
-- qrtim-auth, Arku hesabını QRtım'in döndürdüğü E-POSTA ile buluyordu.
-- E-posta değişir, devredilir ve aynı adres bir süre sonra başka birine ait
-- olabilir. QRtım artık her hesap için bir kez üretilen ve hiç değişmeyen bir
-- kimlik (`qrtim_uid`) döndürüyor; eşleştirme anahtarı odur. Kural QRtım
-- deposundaki docs/qrtim-kimlik-entegrasyonu.md ile ortaktır.
--
-- ÜÇ PARÇA
--   1) users.qrtim_uid kolonu + benzersizlik — aynı QRtım hesabı iki Arku
--      hesabına bağlanamaz.
--   2) arku_qrtim_resolve_account — eşleştirmeyi ve mevcut hesaplar için TEK
--      SEFERLİK e-posta taşımasını ATOMİK yapan fonksiyon. Yalnızca
--      service_role (edge fonksiyonu) çağırabilir.
--   3) arku_qrtim_unlink artık qrtim_uid'i de temizler.
--
-- E-POSTA TAŞIMASI NEDEN AUTH KAYDINDAN OKUNUYOR
-- Mevcut hesapların bir kez bağlanması gerekiyor ve iki taraftaki tek ortak
-- alan e-posta. Ancak arama public.users.email üzerinden YAPILAMAZ: o kolon
-- istemciye yazılabilir (20260912_authz_hardening → grant update (email)),
-- yani kullanıcı kendi satırına kurban@firma.com yazıp taşımayı kendi üstüne
-- çekebilirdi. Bu yüzden arama auth.users üzerinde ve YALNIZCA
-- email_confirmed_at dolu — yani Arku'nun kendi doğruladığı — kayıtlarda
-- yapılır. (Panelde "Confirm email" AÇIK; bkz. DEPLOYMENT.md → Supabase panel
-- ayarları.)
--
-- MEVCUT SATIRLARA DOKUNMAZ: kolon eklenir, eski kayıtlar NULL kalır ve
-- kullanıcı QRtım ile ilk kez giriş yaptığında tek seferde taşınır.
-- =========================================================

begin;

-- ---------------------------------------------------------
-- 1) Kolon ve benzersizlik
--
-- Kısmi indeks (qrtim_id'deki desenin aynısı): bağlı olmayan hesaplarda
-- kolon NULL kalır ve NULL'lar benzersizlik kısıtına takılmaz.
-- ---------------------------------------------------------
alter table public.users add column if not exists qrtim_uid uuid;

create unique index if not exists users_qrtim_uid_unique
  on public.users (qrtim_uid)
  where qrtim_uid is not null;

-- Kolon düzeyi yetkiyi yeniden beyan et (20260912_authz_hardening).
-- users üzerinde authenticated'e TABLO düzeyinde insert/update yok; yetki
-- kolon kolon veriliyor. qrtim_uid bu listede OLMADIĞI için istemci onu
-- yazamaz — yalnızca service_role ve aşağıdaki SECURITY DEFINER fonksiyon
-- yazabilir. Liste burada tekrar ediliyor ki yeni kolonun yanlışlıkla
-- yazılabilir kalmadığı tek bakışta görülsün.
revoke insert, update on public.users from authenticated;

grant insert (id, email, display_name, phone, theme, last_seen, device_fingerprint)
  on public.users to authenticated;
grant update (id, email, display_name, phone, theme, last_seen, device_fingerprint)
  on public.users to authenticated;

-- ---------------------------------------------------------
-- 2) arku_qrtim_resolve_account — hesabı bul, gerekiyorsa bir kez taşı
--
-- DÖNÜŞ
--   (user_id, auth_email, matched)
--   matched = 'uid'            → kalıcı kimlikle eşleşti (normal yol)
--   matched = 'email-backfill' → mevcut hesap ilk kez bağlandı
--   matched = 'conflict'       → hesap BAŞKA bir QRtım kimliğine bağlı, ya da
--                                bu qrtim_uid başka hesapta: oturum AÇILMAZ
--   satır yok                  → hesap yok, çağıran yeni hesap açacak
--
-- auth_email ALANI ÖNEMLİ: oturum bu e-postayla açılır, QRtım'den gelenle
-- değil. Kullanıcı QRtım'de e-postasını değiştirmişse doğru hesapla eşleşip
-- yanlış hesaba giriş yapılmasını bu engeller.
-- ---------------------------------------------------------
create or replace function public.arku_qrtim_resolve_account(
  p_qrtim_uid uuid,
  p_email     text
)
returns table (user_id uuid, auth_email text, matched text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    uuid;
  v_email text;
  v_rows  integer;
begin
  if p_qrtim_uid is null then
    raise exception 'qrtim_uid zorunlu';
  end if;

  -- 1) Kalıcı kimlikle bağlı hesap. İlk girişten sonraki her giriş buradan.
  select u.id into v_id from public.users u where u.qrtim_uid = p_qrtim_uid;
  if v_id is not null then
    select a.email into v_email from auth.users a where a.id = v_id;
    return query select v_id, v_email, 'uid'::text;
    return;
  end if;

  -- 2) Tek seferlik taşıma. Yalnızca DOĞRULANMIŞ auth e-postası eşleşirse.
  if p_email is null or length(trim(p_email)) = 0 then
    return;
  end if;

  select a.id, a.email into v_id, v_email
  from auth.users a
  where lower(a.email) = lower(trim(p_email))
    and a.email_confirmed_at is not null
  limit 1;

  if v_id is null then
    return;  -- eşleşen doğrulanmış hesap yok
  end if;

  -- users satırı henüz yoksa oluştur; bağlantı kimliğini
  -- arku_ensure_connection_id kendi akışında atar.
  insert into public.users (id, email) values (v_id, v_email)
  on conflict (id) do nothing;

  -- YALNIZCA boş alanı doldur. Satır başka bir QRtım kimliğine bağlıysa
  -- hiçbir şey yazılmaz. Eşzamanlı ikinci bir istek benzersizlik hatası
  -- alır; ikisi de 'conflict' döner ve oturum açılmaz.
  begin
    update public.users
       set qrtim_uid = p_qrtim_uid
     where id = v_id
       and qrtim_uid is null;
    get diagnostics v_rows = row_count;
  exception when unique_violation then
    v_rows := 0;
  end;

  if v_rows = 0 then
    return query select v_id, v_email, 'conflict'::text;
    return;
  end if;

  return query select v_id, v_email, 'email-backfill'::text;
end $$;

-- API yüzeyinde durmasına gerek yok: yalnızca edge fonksiyonu çağırır.
-- (20260910_harden_trigger_functions dersi: yetki PUBLIC üzerinden de
--  gelebildiği için iki aşamalı revoke şart.)
revoke all     on function public.arku_qrtim_resolve_account(uuid, text) from public;
revoke execute on function public.arku_qrtim_resolve_account(uuid, text) from anon, authenticated;
grant  execute on function public.arku_qrtim_resolve_account(uuid, text) to service_role;

-- ---------------------------------------------------------
-- 3) Bağlantıyı koparma artık kalıcı kimliği de siler
--
-- Kopardıktan sonra aynı QRtım hesabı başka bir Arku hesabına bağlanabilir;
-- benzersizlik kısıtı ancak o zaman serbest kalır.
-- ---------------------------------------------------------
create or replace function public.arku_qrtim_unlink()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Oturum gerekli'; end if;
  update public.users
     set qrtim_uid = null, qrtim_id = null, qrtim_username = null,
         qrtim_name = null, qrtim_email = null, qrtim_connected_at = null
   where id = v_uid;
end $$;

revoke all     on function public.arku_qrtim_unlink() from public;
revoke execute on function public.arku_qrtim_unlink() from anon;
grant  execute on function public.arku_qrtim_unlink() to authenticated;

commit;

-- =========================================================
-- DOĞRULAMA
--
-- 1) Kolon ve indeks:
--      select column_name from information_schema.columns
--       where table_schema='public' and table_name='users' and column_name='qrtim_uid';
--      select indexname from pg_indexes
--       where tablename='users' and indexname='users_qrtim_uid_unique';
--
-- 2) qrtim_uid İSTEMCİYE YAZILABİLİR OLMAMALI (listede görünmemeli):
--      select column_name, privilege_type
--      from information_schema.column_privileges
--      where table_schema='public' and table_name='users'
--        and grantee='authenticated' and privilege_type in ('INSERT','UPDATE')
--      order by column_name;
--
-- 3) Fonksiyon API yüzeyinde OLMAMALI (boş dizi dönmeli):
--      select array(select r.rolname from pg_roles r
--                   where has_function_privilege(r.rolname, p.oid,'EXECUTE')
--                     and r.rolname in ('anon','authenticated'))
--      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--      where n.nspname='public' and p.proname='arku_qrtim_resolve_account';
--
-- 4) Eşleşmeyen kimlik boş dönmeli (hiçbir şey yazmaz):
--      select * from public.arku_qrtim_resolve_account(gen_random_uuid(), 'yok@example.com');
--
-- 5) CANLI TEST (QRtım bayrakları açıldıktan sonra):
--    a. QRtım ile ilk giriş → matched='email-backfill', qrtim_uid yazılmalı
--    b. Aynı hesapla ikinci giriş → matched='uid'
--    c. Ayarlar > QRtım bağlantısını kes → qrtim_uid NULL olmalı
--
-- GERİ ALMA (veri kaybetmez; kolon dursun, yalnızca fonksiyonlar dönsün)
--   begin;
--   drop function if exists public.arku_qrtim_resolve_account(uuid, text);
--   -- arku_qrtim_unlink'in eski hali için 20260912_authz_hardening.sql'deki
--   -- tanımı yeniden çalıştırın.
--   commit;
-- =========================================================
