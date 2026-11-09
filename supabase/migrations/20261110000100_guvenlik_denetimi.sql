-- =========================================================
-- Güvenlik denetimi 2026-11-10
--
-- Tekrar çalıştırılabilir. Tek işlem içinde uygulanır; bir adım hata
-- verirse hiçbiri uygulanmaz.
--
--   G1 [Yüksek] organizations.subscription_id istemciden yazılabiliyordu.
--       Bir kurumun sıradan üyesi o kurumun abonelik kimliğini okuyup
--       kendi açtığı yeni kuruma bağlıyor ve ücretli planı kendine
--       alıyordu. Kurumdan çıkarılsa bile plan onda kalıyordu.
--   G2 [Orta] arku_plan_at_least / arku_session_limit herhangi bir
--       kullanıcının UUID'siyle çağrılabiliyordu: başkasının ücretli olup
--       olmadığı öğreniliyordu (O3'te arku_effective_subscription için
--       kapatılan sızıntının aynısı).
--   G3 [Orta] arku_presence her kimliği kabul ediyordu: anonim bir oturum
--       900 milyonluk kimlik uzayını tarayıp kimlerin var olduğunu ve ne
--       zaman çevrimiçi olduğunu çıkarabiliyordu. Artık yalnızca çağıranın
--       kendi (ya da kurumunun) kayıtlı kişileri.
--   G4 [Orta] Kurumun herhangi bir üyesi ("member") kurumun bütün kayıtlı
--       kişilerini silebiliyordu. Silme artık sahip/yönetici/operatöre.
--   G5 [Orta] arku_audit_verify (tüm zinciri tarayıp her satır için SHA-256
--       hesaplayan fonksiyon) anonim oturumlara açıktı: kilit ve CPU
--       üzerinden hizmet dışı bırakma, toplam oturum sayısının sızması.
--       Artık yalnızca kayıtlı hesaplar.
--   G6 [Yüksek, G1 ile birlikte] TURN kimlik sınırı 30/10 dk'dan 10/10 dk'ya.
--       turn-credentials artık aynı hesaba bir saat boyunca aynı kullanıcı
--       adını veriyor (handler.ts); meşru istemci 12 saatte bir istek yapar.
--   G7 [Düşük] Yeni fonksiyonlar PUBLIC'e EXECUTE yetkisiyle doğuyordu.
--
-- Uygulama: Supabase SQL Editor'de bu dosyanın tamamını çalıştırın.
-- Doğrulama ve geri alma dosyanın sonunda.
-- =========================================================
begin;

-- ---------------------------------------------------------
-- G1: organizations — subscription_id istemciden yazılamaz
-- ---------------------------------------------------------
-- İstemci yalnızca bu dört sütunu yazar (src/lib/enterprise.ts
-- createOrganization: owner_id, name, slug). UPDATE zaten sütun düzeyinde
-- daraltılmıştı (20261007000200); INSERT tüm tabloya açık kalmıştı.
revoke insert on public.organizations from authenticated, anon;
grant  insert (owner_id, name, slug, logo_url) on public.organizations to authenticated;

-- Sütun yetkisinin yanında ikinci kat: bir istemci isteği (auth.uid() dolu)
-- kurumu, kurum sahibinin OLMAYAN bir aboneliğe bağlayamaz. service_role ve
-- SQL Editor (auth.uid() boş) elle bağlama yapmaya devam edebilir.
create or replace function public.arku_org_subscription_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or new.subscription_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.subscription_id is not distinct from old.subscription_id
     and new.owner_id is not distinct from old.owner_id then
    return new;
  end if;
  if not exists (
    select 1 from public.subscriptions s
    where s.id = new.subscription_id and s.owner_id = new.owner_id
  ) then
    raise exception 'Kurum yalnizca sahibinin aboneligine baglanabilir'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

revoke all on function public.arku_org_subscription_guard() from public, anon, authenticated;

drop trigger if exists trg_org_subscription_guard on public.organizations;
create trigger trg_org_subscription_guard
  before insert or update of subscription_id, owner_id on public.organizations
  for each row execute function public.arku_org_subscription_guard();

-- ---------------------------------------------------------
-- G2: plan sorguları yalnızca kendi hesabın için
-- ---------------------------------------------------------
-- Tüm RLS politikaları ve tetikleyiciler bu fonksiyonları auth.uid() ile
-- çağırıyor (connections tetikleyicisi new.caller_id ile çağırır; ekleme
-- politikası caller_id = auth.uid() şartı koyar). auth.uid() boşsa
-- (service_role, cron, edge fonksiyonları) davranış değişmez.
create or replace function public.arku_plan_at_least(p_uid uuid, p_min text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select (auth.uid() is null or p_uid = auth.uid())
     and public.arku_plan_rank(p_min) <= greatest(
    coalesce((select max(public.arku_plan_rank(s.plan))
              from public.subscriptions s
              where s.owner_id = p_uid
                and s.status = 'active'
                and (s.current_period_end is null or s.current_period_end > now())), 0),
    coalesce((select max(public.arku_plan_rank(s.plan))
              from public.organization_members m
              join public.organizations o on o.id = m.org_id
              join public.subscriptions s on s.id = o.subscription_id
              where m.user_id = p_uid and m.status = 'active'
                and s.status = 'active'
                and (s.current_period_end is null or s.current_period_end > now())), 0)
  );
$$;

revoke all     on function public.arku_plan_at_least(uuid, text) from public;
revoke execute on function public.arku_plan_at_least(uuid, text) from anon;
grant  execute on function public.arku_plan_at_least(uuid, text) to authenticated;

-- arku_session_limit, arku_plan_at_least'i çağırır; başkasının UUID'siyle
-- artık her zaman ücretsiz tavanı (4) döner, plan bilgisi sızmaz.

-- ---------------------------------------------------------
-- G3: presence — yalnızca kendi kayıtlı kişilerin
-- ---------------------------------------------------------
-- İstemci bu RPC'yi yalnızca "Kayıtlı" sekmesindeki kişiler için çağırır
-- (App.tsx > fetchPresence(savedContacts...)). Sonuç kümesi aynı kalır.
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
    and u.connection_id = any(p_ids)
    and exists (
      select 1 from public.saved_contacts sc
      where sc.connection_id = u.connection_id
        and (sc.owner_id = auth.uid()
             or (sc.org_id is not null and public.arku_is_org_member(sc.org_id, auth.uid())))
    );
$$;

revoke all on function public.arku_presence(text[]) from public, anon;
grant execute on function public.arku_presence(text[]) to authenticated;

-- ---------------------------------------------------------
-- G4: saved_contacts — silme yetkisi daraltıldı
-- ---------------------------------------------------------
-- Eski "for all" politikasında DELETE yalnızca USING'e bakıyordu ve USING
-- kurumun tüm üyelerine açıktı. Okuma, ekleme ve güncelleme aynen korunur;
-- yalnızca silme ayrılır.
drop policy if exists "saved_contacts_rw"     on public.saved_contacts;
drop policy if exists "saved_contacts_select" on public.saved_contacts;
drop policy if exists "saved_contacts_insert" on public.saved_contacts;
drop policy if exists "saved_contacts_update" on public.saved_contacts;
drop policy if exists "saved_contacts_delete" on public.saved_contacts;

create policy "saved_contacts_select" on public.saved_contacts for select
to authenticated
using (
  owner_id = auth.uid()
  or (org_id is not null and public.arku_is_org_member(org_id, auth.uid()))
);

create policy "saved_contacts_insert" on public.saved_contacts for insert
to authenticated
with check (
  public.arku_plan_at_least(auth.uid(), 'pro')
  and (
    owner_id = auth.uid()
    or (org_id is not null and public.arku_org_role(org_id, auth.uid()) in ('owner','admin','operator'))
  )
);

create policy "saved_contacts_update" on public.saved_contacts for update
to authenticated
using (
  owner_id = auth.uid()
  or (org_id is not null and public.arku_is_org_member(org_id, auth.uid()))
)
with check (
  public.arku_plan_at_least(auth.uid(), 'pro')
  and (
    owner_id = auth.uid()
    or (org_id is not null and public.arku_org_role(org_id, auth.uid()) in ('owner','admin','operator'))
  )
);

create policy "saved_contacts_delete" on public.saved_contacts for delete
to authenticated
using (
  owner_id = auth.uid()
  or (org_id is not null and public.arku_org_role(org_id, auth.uid()) in ('owner','admin','operator'))
);

-- ---------------------------------------------------------
-- G5: denetim zinciri doğrulaması yalnızca kayıtlı hesaplara
-- ---------------------------------------------------------
-- Gövde değiştirilmez: mevcut fonksiyon _impl adına taşınır, istemciye
-- kapatılır; aynı adla ince bir kapı kurulur. İstemci (src/lib/audit.ts)
-- aynı RPC adını çağırmaya devam eder.
do $$
begin
  if to_regprocedure('public.arku_audit_verify_impl()') is null then
    alter function public.arku_audit_verify() rename to arku_audit_verify_impl;
  end if;
end $$;

revoke all on function public.arku_audit_verify_impl() from public, anon, authenticated;

create or replace function public.arku_audit_verify()
returns table (ok boolean, kontrol_edilen bigint, ilk_bozuk_seq bigint, mesaj text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null
     or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'Denetim zinciri dogrulamasi icin kayitli hesapla giris yapin'
      using errcode = 'insufficient_privilege';
  end if;
  return query select * from public.arku_audit_verify_impl();
end $$;

revoke all     on function public.arku_audit_verify() from public, anon;
grant  execute on function public.arku_audit_verify() to authenticated;

-- ---------------------------------------------------------
-- G6: TURN kimlik sınırı 10 / 10 dk
-- ---------------------------------------------------------
create or replace function public.arku_turn_rate_limit(p_caller text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count  integer;
  c_limit  constant integer  := 10;
  c_window constant interval := interval '10 minutes';
begin
  if p_caller is null or length(trim(p_caller)) = 0 then
    return false;
  end if;

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

-- ---------------------------------------------------------
-- G7: yeni fonksiyonlar varsayılan olarak API'ye açık doğmasın
-- ---------------------------------------------------------
-- Yalnızca bu migration'ı çalıştıran rolün (postgres) gelecekte oluşturacağı
-- fonksiyonları etkiler. Mevcut yetkiler değişmez.
--   * PUBLIC'in yetkisi Postgres'in GENEL varsayılanıdır; "in schema" ile
--     geri alınamaz, genel biçimde geri alınır.
--   * anon'a verilen yetki Supabase'in public şeması için koyduğu varsayılandır.
-- authenticated'a dokunulmaz: mevcut migration alışkanlığı bozulmasın.
-- Yeni bir RPC anonim ziyaretçiye açılacaksa bunu açıkça "grant" ile yazın.
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon;

commit;

-- =========================================================
-- DOĞRULAMA (SQL Editor)
--
-- 1) G1: istemci subscription_id yazamıyor (beklenen: 'yok'):
--      select case when has_column_privilege('authenticated','public.organizations','subscription_id','INSERT')
--                  then 'VAR' else 'yok' end;
--
-- 2) G1: daha önce kötüye kullanılmış olabilecek kurumlar. Boş olmalı;
--    satır dönerse elle inceleyin (kurum sahibinin olmayan bir aboneliğe bağlı):
--      select o.id, o.name, o.owner_id, o.subscription_id, s.owner_id as abonelik_sahibi
--      from public.organizations o
--      join public.subscriptions s on s.id = o.subscription_id
--      where s.owner_id <> o.owner_id;
--
-- 3) G4: politikalar (4 satır: select/insert/update/delete):
--      select policyname, cmd from pg_policies where tablename = 'saved_contacts';
--
-- 4) G5/G6: istemci rolleri _impl ve sınır fonksiyonuna erişemiyor (boş dizi):
--      select p.proname, array(select r.rolname from pg_roles r
--                   where has_function_privilege(r.rolname, p.oid, 'EXECUTE')
--                     and r.rolname in ('anon','authenticated'))
--      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--      where n.nspname = 'public' and p.proname in ('arku_audit_verify_impl','arku_turn_rate_limit');
--
-- 5) CANLI: uygulamada Kayıtlı sekmesinde çevrimiçi noktaları görünmeli;
--    Ayarlar > Denetim izi > Doğrula çalışmalı; yeni bağlantı kurulmalı.
--
-- GERİ ALMA (gerekirse, ayrı ayrı)
--   G1: drop trigger trg_org_subscription_guard on public.organizations;
--       grant insert on public.organizations to authenticated;
--   G4: 20260912_plan_enforcement.sql içindeki "saved_contacts_rw" tanımını
--       yeniden çalıştırın ve dört yeni politikayı silin.
--   G5: drop function public.arku_audit_verify();
--       alter function public.arku_audit_verify_impl() rename to arku_audit_verify;
--       grant execute on function public.arku_audit_verify() to authenticated;
--   G2/G3/G6: 20260922_qrtim_plan_expiry.sql, 20260908_identity_presence_invites.sql
--       ve 20260921_turn_rate_limit.sql içindeki tanımları yeniden çalıştırın.
-- =========================================================
