-- =========================================================
-- Arku Remote — Kurum daveti yalnızca DOĞRULANMIŞ e-postaya bağlanır
-- Tarih: 2026-09-21
--
-- SORUN
-- arku_bind_org_invites (20260908_identity_presence_invites) kullanıcı giriş
-- yaptığında, e-postasına açılmış kurumsal davetleri otomatik olarak ona
-- bağlıyor. Eşleştirme auth.users.email üzerinden yapılıyor ama e-postanın
-- DOĞRULANMIŞ olup olmadığına bakılmıyordu.
--
-- Bugün sömürülebilir değil: panelde "Confirm email" AÇIK, yani doğrulamayan
-- kullanıcı oturum açamıyor ve bu fonksiyonu hiç çağıramıyor. Ama bu, tek bir
-- panel ayarına dayanan bir güvenlik. Ayar bir gün kapatılırsa (ya da bir
-- sağlayıcı doğrulanmamış e-postayla oturum açarsa) saldırgan kurbanın
-- e-postasıyla kayıt olup onun kurumsal üyeliğini üstüne alabilirdi.
--
-- QRtım girişi açıldığında bu yol CANLANIYOR: qrtim-auth hesabı
-- email_confirm: true ile açıyor. O tarafta e-posta doğrulaması artık şart
-- koşuluyor (20260921_qrtim_uid_identity + qrtim-auth), ama kural burada da
-- yazılı olmalı — davet bağlama, kimin hangi e-postaya sahip olduğuna dair
-- bir karardır ve o kararı veren yer burasıdır.
--
-- DEĞİŞEN TEK ŞEY: fonksiyona email_confirmed_at kontrolü eklendi.
-- Mevcut üyelikler etkilenmez; yalnızca yeni bağlama denemeleri süzülür.
-- =========================================================

begin;

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

  -- YALNIZCA doğrulanmış e-posta. Doğrulanmamışsa davet bağlanmaz ve
  -- kullanıcı hiçbir şey kaybetmez: doğruladığı anda bir sonraki girişte
  -- bağlanır.
  select email into v_email
  from auth.users
  where id = v_uid
    and email_confirmed_at is not null;

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
revoke execute on function public.arku_bind_org_invites() from anon;
grant  execute on function public.arku_bind_org_invites() to authenticated;

commit;

-- =========================================================
-- DOĞRULAMA
--
-- 1) Doğrulanmış bir hesapla çağırın — davet varsa bağlanmalı:
--      select public.arku_bind_org_invites();
--
-- 2) Doğrulanmamış bir hesapla (varsa) 0 dönmeli ve üyelik bağlanmamalı.
--
-- 3) CANLI TEST: bir kullanıcıyı firmaya davet edin, o kullanıcı giriş
--    yapsın, Kurumsal sekmesinde üyeliği görünsün. Davranış değişmemeli.
--
-- GERİ ALMA: 20260908_identity_presence_invites.sql içindeki tanımı yeniden
-- çalıştırın (kontrolsüz haline döner).
-- =========================================================
