-- =========================================================
-- Arku Remote — BEKLEYEN MIGRATION'LARIN TAMAMI (tek dosya)
-- Olusturuldu: 2026-10-05
--
-- NE ICIN: Supabase baglayicisi salt okunur kipte oldugu icin migration'lar
-- uzaktan uygulanamiyor. Bu dosya, bekleyen 12 migration'i DOGRU SIRAYLA tek
-- yapistirmada uygulamak icindir. Supabase Dashboard -> SQL Editor.
--
-- ONEMLI
--  * Her migration kendi begin/commit bloğunda. Biri hata verirse ONCEKILER
--    UYGULANMIS olur; hata mesajini bana getirin, kaldigi yerden devam ederiz.
--  * Her blogun sonunda supabase_migrations kaydi yaziliyor; boylece
--    "hangi migration canlida" sorusu bir daha tahmine kalmaz.
--  * Tekrar calistirilabilir: hepsi `if not exists` / `or replace` /
--    `drop ... if exists` desenleriyle yazildi, migration kaydi da
--    `on conflict do nothing`.
--
-- UYGULADIKTAN SONRA
--   1) supabase/verify_migrations_applied.sql  -> hepsi UYGULANDI demeli
--   2) supabase/verify_security_state.sql      -> BEKLENEN satirlari tutmali
-- =========================================================


-- =========================================================
-- >>> 20260912_org_owner_bootstrap.sql
-- =========================================================
-- =========================================================
-- Arku Remote — Kurumsal modülün açılış kilidini kaldır (Y1)
-- Tarih: 2026-09-12
--
-- SORUN
-- organization_members ekleme politikası şunu istiyordu:
--     arku_org_role(org_id, auth.uid()) in ('owner','admin')
-- Bu fonksiyon organization_members tablosuna bakıyor. Yeni açılmış bir
-- firmada henüz HİÇ ÜYE SATIRI OLMADIĞI için NULL döner; `NULL in (...)`
-- ise false sayılır. Sonuç bir açılış kilidi (bootstrap deadlock):
--
--   1. createOrganization firmayı açar               -> başarılı
--   2. kurucuyu owner üye olarak eklemeye çalışır    -> RLS REDDEDER
--      (istemci dönen hatayı kontrol etmiyordu, sessizce yutuluyordu)
--   3. firma ÜYESİZ kalır
--   4. owner artık hiçbir üye ekleyemez — ekleme yetkisi var olmayan
--      üyeliğe bağlı
--
-- ZİNCİRLEME ETKİ: cihaz etiketi (device_label) hiç oluşturulamadığı için
-- 'acme-01' biçimindeki kurumsal vanity kimlik HİÇ çözümlenemiyordu.
-- 20260908_identity_presence_invites.sql'in "O1 düzeltildi" notu bu yüzden
-- fiilen gerçekleşmemişti: arku_bind_org_invites doğru çalışıyor ama
-- bağlayacağı davet hiç yaratılamıyordu.
--
-- ÇÖZÜM — üç katman
--   1) TRIGGER: kurucu üyeliğini SUNUCU yazar. Böylece istemci sürümünden
--      bağımsız olarak her firmanın bir owner üyesi olur.
--   2) POLİTİKA: firma sahibi (organizations.owner_id) üye yönetebilir.
--      Trigger olmasa bile kilit açılır; ayrıca sahibin admin'i silmesi gibi
--      meşru işlemler için şart.
--   3) GERİ DOLGU: bu hatayla açılmış mevcut üyesiz firmalar onarılır.
--
-- GERİ ALMA: dosyanın sonundaki blokta.
-- =========================================================

begin;

-- ---------------------------------------------------------
-- 1) Kurucu üyeliğini sunucu yazsın
--
-- SECURITY DEFINER: trigger, RLS'in reddettiği satırı yazabilmeli.
-- `on conflict do nothing`: eski istemciler (v1.4.0) kurucu satırını
-- kendileri de eklemeye çalışıyor; ikinci deneme sessizce atlanır.
-- ---------------------------------------------------------
create or replace function public.arku_org_add_founder()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.organization_members (org_id, user_id, role, status)
  values (new.id, new.owner_id, 'owner', 'active')
  on conflict (org_id, user_id) do nothing;
  return new;
end $$;

revoke all     on function public.arku_org_add_founder() from public;
revoke execute on function public.arku_org_add_founder() from anon, authenticated;

drop trigger if exists trg_org_add_founder on public.organizations;
create trigger trg_org_add_founder
  after insert on public.organizations
  for each row execute function public.arku_org_add_founder();

-- ---------------------------------------------------------
-- 2) Firma sahibi de üye yönetebilsin
--
-- Yardımcı fonksiyon: organizations üzerinden sahiplik kontrolü.
-- SECURITY DEFINER çünkü politika içinden çağrıldığında organizations'ın
-- kendi RLS'ine takılmamalı (özyineleme riski).
-- ---------------------------------------------------------
create or replace function public.arku_owns_org(p_org uuid, p_uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.organizations o
    where o.id = p_org and o.owner_id = p_uid
  );
$$;

revoke all     on function public.arku_owns_org(uuid, uuid) from public;
revoke execute on function public.arku_owns_org(uuid, uuid) from anon;
grant  execute on function public.arku_owns_org(uuid, uuid) to authenticated;

drop policy if exists "org_members_write_admin"  on public.organization_members;
drop policy if exists "org_members_update_admin" on public.organization_members;
drop policy if exists "org_members_delete_admin" on public.organization_members;

create policy "org_members_write_admin" on public.organization_members for insert
to authenticated
with check (
  public.arku_owns_org(org_id, auth.uid())
  or public.arku_org_role(org_id, auth.uid()) in ('owner','admin')
);

create policy "org_members_update_admin" on public.organization_members for update
to authenticated
using (
  public.arku_owns_org(org_id, auth.uid())
  or public.arku_org_role(org_id, auth.uid()) in ('owner','admin')
)
with check (
  public.arku_owns_org(org_id, auth.uid())
  or public.arku_org_role(org_id, auth.uid()) in ('owner','admin')
);

-- Silme: firma sahibinin owner satırı silinemesin, aksi halde kilit geri döner.
create policy "org_members_delete_admin" on public.organization_members for delete
to authenticated
using (
  (
    public.arku_owns_org(org_id, auth.uid())
    or public.arku_org_role(org_id, auth.uid()) in ('owner','admin')
  )
  and not public.arku_owns_org(org_id, user_id)
);

-- ---------------------------------------------------------
-- 3) Mevcut üyesiz firmaları onar
--
-- Bu hatayla açılmış firmaların kurucusu üye listesinde yok. Onlar için
-- owner satırını şimdi yazıyoruz; zaten varsa dokunulmuyor.
-- ---------------------------------------------------------
insert into public.organization_members (org_id, user_id, role, status)
select o.id, o.owner_id, 'owner', 'active'
from public.organizations o
where not exists (
  select 1 from public.organization_members m
  where m.org_id = o.id and m.user_id = o.owner_id
)
on conflict (org_id, user_id) do nothing;

commit;

-- =========================================================
-- DOĞRULAMA
--
-- 1) Üyesiz firma kalmadı (0 satır dönmeli):
--      select o.id, o.name from public.organizations o
--      where not exists (select 1 from public.organization_members m
--                        where m.org_id = o.id and m.role = 'owner');
--
-- 2) Trigger duruyor:
--      select tgname from pg_trigger where tgname = 'trg_org_add_founder';
--
-- 3) CANLI TEST (arayüzden): Kurumsal sekmesi > firma oluştur >
--    e-posta ile üye ekle + cihaz etiketi ver. Eskiden 2. adım RLS
--    hatasıyla düşüyordu, artık geçmeli. Ardından davet edilen kullanıcı
--    giriş yaptığında 'slug-etiket' (örn. acme-01) ile aranabilir olmalı.
--
-- GERİ ALMA
--   begin;
--   drop trigger if exists trg_org_add_founder on public.organizations;
--   drop function if exists public.arku_org_add_founder();
--   drop policy if exists "org_members_write_admin"  on public.organization_members;
--   drop policy if exists "org_members_update_admin" on public.organization_members;
--   drop policy if exists "org_members_delete_admin" on public.organization_members;
--   create policy "org_members_write_admin" on public.organization_members for insert
--     to authenticated with check (public.arku_org_role(org_id, auth.uid()) in ('owner','admin'));
--   create policy "org_members_update_admin" on public.organization_members for update
--     to authenticated using (public.arku_org_role(org_id, auth.uid()) in ('owner','admin'))
--     with check (public.arku_org_role(org_id, auth.uid()) in ('owner','admin'));
--   create policy "org_members_delete_admin" on public.organization_members for delete
--     to authenticated using (public.arku_org_role(org_id, auth.uid()) in ('owner','admin'));
--   drop function if exists public.arku_owns_org(uuid, uuid);
--   commit;
--   (Geri dolgulanan üye satırları KALIR — zararsızdır, kilidi de açık tutar.)
-- =========================================================

insert into supabase_migrations.schema_migrations (version, name)
values ('20260912000100', 'org_owner_bootstrap')
on conflict (version) do nothing;

-- =========================================================
-- >>> 20260912_authz_hardening.sql
-- =========================================================
-- =========================================================
-- Arku Remote — Yetkilendirme sertleştirmesi (O3, O4)
-- Tarih: 2026-09-12
--
-- İKİ AYRI BULGU. Hiçbiri mevcut satırı DEĞİŞTİRMEZ; yalnızca yetki daraltır.
--
-- O3 — arku_effective_subscription başkasının planını döndürüyordu.
--      Fonksiyon kullanıcı kimliğini PARAMETRE olarak alıyor, SECURITY
--      DEFINER ile çalışıyor ve `authenticated` rolüne açıktı. Herhangi bir
--      oturumlu kullanıcı, başkasının UUID'sini geçerek onun planını,
--      abonelik kaynağını, koltuk sayısını ve kurumsal üyelik durumunu
--      okuyabiliyordu. UUID'ler resolve_connection_id ile 9 haneli kimlikten
--      çözülebildiği için hedef seçmek de mümkündü.
--
-- O4 — Kullanıcı kendi kimlik numarasını ve rolünü değiştirebiliyordu.
--      users_update_own politikası satır düzeyinde doğru (auth.uid() = id)
--      ama KOLON DÜZEYİNDE sınır yoktu. Kullanıcı kendi `role` alanını
--      'admin' yapabiliyor, `connection_id`'sini boş bir değerle
--      değiştirebiliyordu (numara/vanity işgali).
--
--      `role` bugün hiçbir yerde yetki kararı vermiyor — sömürülebilir
--      değil AMA bir tuzak: ileride biri role='admin' temelli bir politika
--      yazdığı anda yetki yükseltmesi doğar.
--
-- ⚠ SIRA: bu dosya 20260912_org_owner_bootstrap.sql'DEN SONRA çalıştırılmalı
--   (ikisi bağımsız ama sıra izlenebilirlik için önemli).
-- =========================================================

begin;

-- ---------------------------------------------------------
-- O3) Abonelik özeti yalnızca KENDİ hesabın için
--
-- Parametre geriye dönük uyumluluk için duruyor (istemci onu gönderiyor) ama
-- artık auth.uid()'den farklı bir değer verilirse istek reddedilir.
-- Gövde de auth.uid() kullanır; parametre yalnızca doğrulanır.
-- ---------------------------------------------------------
create or replace function public.arku_effective_subscription(p_uid uuid default null)
returns jsonb language plpgsql security definer set search_path = public stable as $$
declare
  v_uid uuid := auth.uid();
  v_out jsonb;
begin
  if v_uid is null then
    raise exception 'Oturum gerekli';
  end if;
  -- Baskasinin planini sormak artik hata: sessizce kendi planini dondurmek
  -- cagiranin hatasini gizler ve hata ayiklamayi zorlastirir.
  if p_uid is not null and p_uid <> v_uid then
    raise exception 'Yalnizca kendi aboneliginizi sorgulayabilirsiniz';
  end if;

  with ranks as (select unnest(array['free','pro','team','business']) as plan,
                        generate_series(0,3) as rank),
  own as (
    select s.plan, s.status, s.source, s.seats
    from public.subscriptions s where s.owner_id = v_uid and s.status = 'active'
  ),
  org_plans as (
    select s.plan
    from public.organization_members m
    join public.organizations o on o.id = m.org_id
    join public.subscriptions s on s.id = o.subscription_id
    where m.user_id = v_uid and m.status = 'active' and s.status = 'active'
  ),
  all_plans as (
    select plan from own
    union all select plan from org_plans
    union all select 'free'
  ),
  best as (
    select ap.plan from all_plans ap join ranks r on r.plan = ap.plan
    order by r.rank desc limit 1
  )
  select jsonb_build_object(
    'plan', (select plan from best),
    'source', coalesce((select source from own), 'none'),
    'seats', coalesce((select seats from own), 1),
    'is_org_member', exists(select 1 from public.organization_members
                            where user_id = v_uid and status = 'active')
  ) into v_out;

  return v_out;
end $$;

revoke all     on function public.arku_effective_subscription(uuid) from public;
revoke execute on function public.arku_effective_subscription(uuid) from anon;
grant  execute on function public.arku_effective_subscription(uuid) to authenticated;

-- ---------------------------------------------------------
-- O4) users tablosunda KOLON DÜZEYİNDE yetki
--
-- Korunan kolonlar (istemci ASLA yazamaz):
--   role           — yetki alanı
--   connection_id  — kimlik; yalnızca arku_ensure_connection_id (SECURITY
--                    DEFINER) atar. Kimlik değişmezliği kayıtlı müşteri
--                    listelerinin bozulmaması için şart.
--   qrtim_*        — QRtım kimliği; yalnızca edge fonksiyonu (service_role)
--                    yazar. Bağlantıyı KOPARMA işlemi için aşağıdaki
--                    arku_qrtim_unlink() RPC'si var.
--   created_at     — kayıt zamanı
--
-- NOT: `id` kolonuna update veriliyor ve bu zararsızdır — PostgREST'in
-- upsert'ü (on conflict do update) payload'daki her kolonu SET listesine
-- koyar, `id` dahil. Değeri değiştirmek zaten mümkün değil: PK çakışması
-- veya auth.users'a olan yabancı anahtar reddeder.
-- ---------------------------------------------------------
revoke insert, update on public.users from authenticated;

grant insert (id, email, display_name, phone, theme, last_seen, device_fingerprint)
  on public.users to authenticated;
grant update (id, email, display_name, phone, theme, last_seen, device_fingerprint)
  on public.users to authenticated;

-- QRtım bağlantısını koparma: kolon yetkisi kaldırıldığı için istemci artık
-- qrtim_* alanlarını doğrudan temizleyemez. Kendi satırında, yalnızca bu
-- alanları boşaltan dar bir fonksiyon veriyoruz.
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
     set qrtim_id = null, qrtim_username = null, qrtim_name = null,
         qrtim_email = null, qrtim_connected_at = null
   where id = v_uid;
end $$;

revoke all     on function public.arku_qrtim_unlink() from public;
revoke execute on function public.arku_qrtim_unlink() from anon;
grant  execute on function public.arku_qrtim_unlink() to authenticated;

commit;

-- =========================================================
-- DOĞRULAMA
--
-- 1) Kolon yetkileri — role ve connection_id LİSTEDE OLMAMALI:
--      select column_name, privilege_type
--      from information_schema.column_privileges
--      where table_schema='public' and table_name='users'
--        and grantee='authenticated' and privilege_type in ('INSERT','UPDATE')
--      order by column_name, privilege_type;
--
-- 2) Abonelik RPC'si başkası için hata vermeli:
--      select public.arku_effective_subscription(gen_random_uuid());
--      -- ERROR: Yalnizca kendi aboneliginizi sorgulayabilirsiniz
--      select public.arku_effective_subscription();   -- kendi planın
--
-- 3) CANLI TEST: giriş yapın (plan etiketi görünmeli), tema değiştirin,
--    profili güncelleyin, Ayarlar > QRtım bağlantısını kes. Hepsi çalışmalı.
--
-- GERİ ALMA
--   begin;
--   grant insert, update on public.users to authenticated;
--   drop function if exists public.arku_qrtim_unlink();
--   -- arku_effective_subscription'ı eski (parametreli, kontrolsüz) haliyle
--   -- geri almak için 20260704_arku_subscriptions_orgs.sql'deki tanımı
--   -- yeniden çalıştırın.
--   commit;
-- =========================================================

insert into supabase_migrations.schema_migrations (version, name)
values ('20260912000200', 'authz_hardening')
on conflict (version) do nothing;

-- =========================================================
-- >>> 20260912_plan_enforcement.sql
-- =========================================================
-- =========================================================
-- Arku Remote — Plan sınırlarını SUNUCUDA zorla (O2)
-- Tarih: 2026-09-12
--
-- SORUN
-- Kayıtlı müşteri listesi (pro) ile organizasyonlar ve markalı kimlik
-- (team/business) yalnızca ARAYÜZDE gizleniyordu (planCapabilities).
-- Sunucu tarafında karşılığı yoktu: organizations ekleme politikası
-- yalnızca `owner_id = auth.uid()` arıyor, saved_contacts ise sahiplik
-- dışında bir şey sormuyordu. Ücretsiz bir hesap, anon anahtarla doğrudan
-- REST çağrısı yaparak ücretli özelliklerin tamamını kullanabiliyordu.
-- Koltuk sayısı (subscriptions.seats) da hiçbir yerde kontrol edilmiyordu.
--
-- TASARIM KARARI: YALNIZCA EKLEME (INSERT) KISITLANIR.
-- Okuma, güncelleme ve silme serbest kalır. Gerekçe: bir abonelik satırı
-- eksik veya süresi dolmuş olduğunda kullanıcı KENDİ VERİSİNE erişimini
-- kaybetmemeli — yalnızca yeni veri ekleyemez. Aksi halde ödeme sağlayıcısı
-- kaynaklı tek bir gecikme, müşterinin kayıtlı müşteri listesini erişilemez
-- yapardı. Aynı sebeple mevcut satırlara hiç dokunulmuyor.
-- =========================================================

begin;

-- ---------------------------------------------------------
-- Plan sıralaması ve eşik kontrolü
--
-- arku_effective_subscription'ı ÇAĞIRMIYOR: o fonksiyon artık yalnızca
-- auth.uid() için çalışıyor ve politika içinden çağrılması gereksiz bir
-- jsonb ayrıştırması ekler. Burada aynı mantığın dar bir kopyası var.
-- ---------------------------------------------------------
create or replace function public.arku_plan_rank(p text)
returns integer language sql immutable as $$
  select case lower(coalesce(p,'free'))
    when 'business' then 3
    when 'team'     then 2
    when 'pro'      then 1
    else 0
  end;
$$;

/**
 * Kullanıcının etkin planı en az `p_min` mi?
 * Etkin plan = kendi aboneliği ile üyesi olduğu firmaların planı arasından
 * en yükseği (org üyeliği üzerinden gelen plan da sayılır).
 */
create or replace function public.arku_plan_at_least(p_uid uuid, p_min text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select public.arku_plan_rank(p_min) <= greatest(
    coalesce((select max(public.arku_plan_rank(s.plan))
              from public.subscriptions s
              where s.owner_id = p_uid and s.status = 'active'), 0),
    coalesce((select max(public.arku_plan_rank(s.plan))
              from public.organization_members m
              join public.organizations o on o.id = m.org_id
              join public.subscriptions s on s.id = o.subscription_id
              where m.user_id = p_uid and m.status = 'active' and s.status = 'active'), 0)
  );
$$;

revoke all     on function public.arku_plan_rank(text)            from public;
revoke all     on function public.arku_plan_at_least(uuid, text)  from public;
revoke execute on function public.arku_plan_rank(text)            from anon;
revoke execute on function public.arku_plan_at_least(uuid, text)  from anon;
grant  execute on function public.arku_plan_rank(text)            to authenticated;
grant  execute on function public.arku_plan_at_least(uuid, text)  to authenticated;

-- ---------------------------------------------------------
-- organizations — kurumsal özellik: team veya business
-- (update/delete/select DEĞİŞMEDİ; yalnızca yeni firma açma kısıtlanıyor)
-- ---------------------------------------------------------
drop policy if exists "orgs_insert_owner" on public.organizations;
create policy "orgs_insert_owner" on public.organizations for insert
to authenticated
with check (
  owner_id = auth.uid()
  and public.arku_plan_at_least(auth.uid(), 'team')
);

-- ---------------------------------------------------------
-- saved_contacts / contact_categories — kayıtlı müşteri: pro ve üstü
--
-- `for all` politikalar select/update/delete'i de kapsadığı için ekleme
-- kısıtını AYRI bir insert politikasına koyamayız (PostgreSQL aynı komut
-- için politikaları OR'lar; ayrı bir insert politikası kısıtı gevşetirdi).
-- Bu yüzden `for all` politikasının with_check'ine plan şartı ekliyoruz:
-- with_check YALNIZCA insert ve update'in yeni satırına uygulanır, using
-- (okuma/silme) etkilenmez.
--
-- DİKKAT — update: with_check update'te de çalışır. Plan düşmüş bir
-- kullanıcı mevcut kaydını GÜNCELLEYEMEZ ama okuyabilir ve silebilir.
-- Bilinçli: "yeni değer yazma" ücretli özelliğin kendisidir; verisine
-- erişimi ise korunur.
-- ---------------------------------------------------------
drop policy if exists "saved_contacts_rw" on public.saved_contacts;
create policy "saved_contacts_rw" on public.saved_contacts for all
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

drop policy if exists "categories_rw" on public.contact_categories;
create policy "categories_rw" on public.contact_categories for all
to authenticated
using (
  owner_id = auth.uid()
  or (org_id is not null and public.arku_org_role(org_id, auth.uid()) in ('owner','admin','operator'))
)
with check (
  public.arku_plan_at_least(auth.uid(), 'pro')
  and (
    owner_id = auth.uid()
    or (org_id is not null and public.arku_org_role(org_id, auth.uid()) in ('owner','admin','operator'))
  )
);

-- ---------------------------------------------------------
-- Koltuk sınırı (seats)
--
-- Politika yerine TETİKLEYİCİ: politika reddi istemciye anlamsız bir
-- "satır bulunamadı" olarak döner, tetikleyici ise sebebi söyleyen bir hata
-- mesajı verebilir.
--
-- Sayım `status <> 'disabled'` üzerinden: davet edilmiş ama henüz giriş
-- yapmamış bir üye de koltuk tutar (aksi halde sınır kolayca aşılırdı).
-- Firma sahibinin kendi owner satırı sayılmaz — koltuk operatörler içindir.
-- ---------------------------------------------------------
create or replace function public.arku_org_seat_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_seats integer;
  v_used  integer;
begin
  select o.owner_id into v_owner from public.organizations o where o.id = new.org_id;
  if v_owner is null then return new; end if;

  -- Kurucunun owner satırı koltuk tüketmez.
  if new.user_id is not null and new.user_id = v_owner then return new; end if;

  select coalesce(max(s.seats), 1) into v_seats
  from public.subscriptions s
  where s.owner_id = v_owner and s.status = 'active';

  select count(*) into v_used
  from public.organization_members m
  where m.org_id = new.org_id
    and m.status <> 'disabled'
    and (m.user_id is null or m.user_id <> v_owner);

  if v_used >= v_seats then
    raise exception 'Koltuk siniri dolu (% koltuk). Ek koltuk icin aboneliginizi yukseltin.', v_seats
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

revoke all     on function public.arku_org_seat_limit() from public;
revoke execute on function public.arku_org_seat_limit() from anon, authenticated;

drop trigger if exists trg_org_seat_limit on public.organization_members;
create trigger trg_org_seat_limit
  before insert on public.organization_members
  for each row execute function public.arku_org_seat_limit();

commit;

-- =========================================================
-- DOĞRULAMA
--
-- 1) Ücretsiz hesapla firma açma denemesi reddedilmeli:
--      insert into public.organizations (owner_id, name, slug)
--      values (auth.uid(), 'Test', 'test-free');
--      -- new row violates row-level security policy
--
-- 2) Ücretli hesapla aynı işlem geçmeli.
--
-- 3) Plan eşiği:
--      select public.arku_plan_at_least(auth.uid(), 'pro');
--      select public.arku_plan_at_least(auth.uid(), 'team');
--
-- 4) Mevcut veri ETKİLENMEDİ (okuma serbest):
--      select count(*) from public.saved_contacts;
--
-- KOLTUK SAYISINI ELLE ARTIRMA (admin):
--   update public.subscriptions set seats = 10 where owner_id = '<uuid>';
--
-- GERİ ALMA
--   begin;
--   drop trigger if exists trg_org_seat_limit on public.organization_members;
--   drop function if exists public.arku_org_seat_limit();
--   drop policy if exists "orgs_insert_owner" on public.organizations;
--   create policy "orgs_insert_owner" on public.organizations for insert
--     to authenticated with check (owner_id = auth.uid());
--   -- saved_contacts_rw ve categories_rw'yi plan sarti OLMADAN yeniden
--   -- olusturmak icin 20260704_arku_subscriptions_orgs.sql'deki tanimlari
--   -- yeniden calistirin.
--   drop function if exists public.arku_plan_at_least(uuid, text);
--   drop function if exists public.arku_plan_rank(text);
--   commit;
-- =========================================================

insert into supabase_migrations.schema_migrations (version, name)
values ('20260912000300', 'plan_enforcement')
on conflict (version) do nothing;

-- =========================================================
-- >>> 20260912_retention_cleanup.sql
-- =========================================================
-- =========================================================
-- Arku Remote — Saklama süreleri ve otomatik temizlik (O9, O15)
-- Tarih: 2026-09-12
--
-- İKİ BİRİKİM KAYNAĞI. İkisi de KVKK'nın veri minimizasyonu ve sınırlı
-- saklama ilkesiyle çatışıyor, ikisi de faturayı kullanıcı sayısıyla
-- doğrusal büyütüyor.
--
-- O9 — Anonim kullanıcı birikimi
--   Her istemci (misafir dahil) anonim olarak imzalanıyor ve
--   arku_ensure_connection_id ona KALICI bir 9 haneli kimlik atıyor. Her yeni
--   tarayıcı profili, her gizli pencere, her çıkış işlemi ve her kayıt
--   denemesi yeni bir anonim kullanıcı üretiyor; eskisi auth.users ve
--   public.users tablolarında yetim kalıyor. Hiçbir temizlik görevi yoktu.
--   Etkisi: auth.users sınırsız büyür (maliyet + yönetim paneli kullanılamaz
--   hale gelir) ve 900 milyonluk kimlik uzayı hiç bağlanmamış oturumlar
--   tarafından tüketilir. Ayrıca her yetim satır bir cihaz parmak izi taşır.
--
-- O15 — logs tablosu retention'sız
--   Kayıtlı kullanıcıda her günlük satırı ayrı bir insert olarak gidiyordu
--   (WebRTC iç durumları dahil). İçinde karşı taraf kimlikleri ve bağlantı
--   zamanları var — teknik günlük değil kişisel veri kaydı.
--   İstemci tarafı da bu sürümde daraltıldı: artık yalnızca kullanıcıya
--   anlamlı olaylar sunucuya yazılıyor, ICE/bağlantı ayrıntıları yerelde
--   kalıyor (bkz. src/App.tsx, m.onLog).
--
-- ⚠ SAKLAMA SÜRELERİ BİR HUKUKİ KARARDIR. Aşağıdaki değerler makul
--   başlangıçlar; aydınlatma metninizde YAZILI olan süreyle aynı olmalıdır.
--   Değiştirmek için cron ifadesindeki interval değerlerini düzenleyin.
--     signals        :  5 dakika  (zaten mevcut — 20260801)
--     logs           : 90 gün
--     anonim hesap   : 30 gün (hiç bağlantı kurmamış ve denetim kaydı olmayan)
--     connections    : DOKUNULMUYOR (bağlantı geçmişi kullanıcıya gösterilir)
--     session_audit  : DOKUNULMUYOR (append-only; bkz. docs/KVKK.md)
-- =========================================================

create extension if not exists pg_cron;

-- ---------------------------------------------------------
-- O15) logs — 90 gün
-- ---------------------------------------------------------
do $$
begin
  perform cron.unschedule('arku-clean-logs');
exception when others then null; -- görev yoksa sorun değil
end $$;

select cron.schedule(
  'arku-clean-logs',
  '23 3 * * *',  -- her gün 03:23 UTC
  $job$delete from public.logs where created_at < now() - interval '90 days'$job$
);

-- ---------------------------------------------------------
-- O9) Yetim anonim hesaplar — 30 gün
--
-- SİLME KOŞULLARI (hepsi birlikte):
--   * gerçekten anonim
--   * 30 günden eski VE 30 gündür giriş yapmamış
--   * hiç bağlantı kurmamış (connections.caller_id)
--   * hiç denetim kaydı yok (session_audit.actor_id)
--
-- Son iki koşul ŞART:
--   - session_audit.actor_id `on delete restrict` taşır; kaydı olan bir
--     kullanıcıyı silmek hata verir ve görev her gece patlar.
--   - connections `on delete cascade` taşır; koşul olmadan geçmiş sessizce
--     silinirdi.
--
-- public.users satırı auth.users'a `on delete cascade` bağlı olduğu için
-- ayrıca silmek gerekmez.
--
-- Fonksiyona sarılıyor: cron komutu tek satır olduğunda bu kadar koşulu
-- okunur tutmak mümkün değil ve hata ayıklamak için elle çağrılabilmesi
-- gerekiyor.
-- ---------------------------------------------------------
create or replace function public.arku_purge_stale_anon(p_days integer default 30)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer := 0;
begin
  -- is_anonymous kolonu eski Supabase sürümlerinde yok; varsa çalış, yoksa
  -- hiçbir şey yapma (görev sessizce boş döner, hata vermez).
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'auth' and table_name = 'users' and column_name = 'is_anonymous'
  ) then
    return 0;
  end if;

  with silinecek as (
    select u.id
    from auth.users u
    where u.is_anonymous is true
      and u.created_at < now() - (p_days || ' days')::interval
      and coalesce(u.last_sign_in_at, u.created_at) < now() - (p_days || ' days')::interval
      and not exists (select 1 from public.connections c   where c.caller_id = u.id)
      and not exists (select 1 from public.session_audit a where a.actor_id  = u.id)
    limit 5000  -- tek turda tabloyu kilitlemeyelim; görev her gece tekrar çalışır
  ), silinen as (
    delete from auth.users u
    using silinecek s
    where u.id = s.id
    returning u.id
  )
  select count(*) into v_count from silinen;

  return v_count;
end $$;

revoke all on function public.arku_purge_stale_anon(integer) from public;
revoke execute on function public.arku_purge_stale_anon(integer) from anon, authenticated;

do $$
begin
  perform cron.unschedule('arku-purge-anon');
exception when others then null;
end $$;

select cron.schedule(
  'arku-purge-anon',
  '41 3 * * *',  -- her gün 03:41 UTC
  $job$select public.arku_purge_stale_anon(30)$job$
);

-- =========================================================
-- DOĞRULAMA
--
-- 1) Görevler kurulu ve aktif:
--      select jobname, schedule, active from cron.job
--      where jobname in ('arku-clean-signals','arku-clean-logs','arku-purge-anon');
--
-- 2) Kaç anonim hesap temizlenmeye aday (SİLMEZ, yalnızca sayar):
--      select count(*) from auth.users u
--      where u.is_anonymous is true
--        and u.created_at < now() - interval '30 days'
--        and not exists (select 1 from public.connections c where c.caller_id = u.id)
--        and not exists (select 1 from public.session_audit a where a.actor_id = u.id);
--
-- 3) Elle bir tur çalıştırmak (kaç satır silindiğini döndürür):
--      select public.arku_purge_stale_anon(30);
--
-- 4) Çalışma geçmişi:
--      select j.jobname, d.status, d.start_time, d.return_message
--      from cron.job_run_details d join cron.job j on j.jobid = d.jobid
--      where j.jobname like 'arku-%' order by d.start_time desc limit 20;
--
-- GERİ ALMA
--   select cron.unschedule('arku-clean-logs');
--   select cron.unschedule('arku-purge-anon');
--   drop function if exists public.arku_purge_stale_anon(integer);
-- =========================================================

insert into supabase_migrations.schema_migrations (version, name)
values ('20260912000400', 'retention_cleanup')
on conflict (version) do nothing;

-- =========================================================
-- >>> 20260921_qrtim_uid_identity.sql
-- =========================================================
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

insert into supabase_migrations.schema_migrations (version, name)
values ('20260921000100', 'qrtim_uid_identity')
on conflict (version) do nothing;

-- =========================================================
-- >>> 20260921_org_invite_verified_email.sql
-- =========================================================
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

insert into supabase_migrations.schema_migrations (version, name)
values ('20260921000200', 'org_invite_verified_email')
on conflict (version) do nothing;

-- =========================================================
-- >>> 20260921_turn_rate_limit.sql
-- =========================================================
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

insert into supabase_migrations.schema_migrations (version, name)
values ('20260921000300', 'turn_rate_limit')
on conflict (version) do nothing;

-- =========================================================
-- >>> 20260921_ilgezdi_device_links.sql
-- =========================================================
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

insert into supabase_migrations.schema_migrations (version, name)
values ('20260921000400', 'ilgezdi_device_links')
on conflict (version) do nothing;

-- =========================================================
-- >>> 20260922_qrtim_link_secrets.sql
-- =========================================================
-- =========================================================
-- Arku Remote — QRtım kullanıcı başına bağlantı sırrı (plan tazeleme)
-- Tarih: 2026-09-22
--
-- NEDEN
-- QRtım planı Arku'ya YALNIZCA giriş/bağlama anında yazılıyordu
-- (grantQrtimSubscription). Yetki kararları yerel `subscriptions` satırına
-- bakıyor ve o satırın süresi hiç dolmuyor. Sonuç: QRtım aboneliği biten
-- kullanıcı Arku'da ücretli kademede SÜRESİZ kalıyordu — planı tazelemek için
-- tekrar QRtım ile giriş yapması gerekiyordu, ki yapmaz.
--
-- QRtım bunun için sunucudan sunucuya bir uç açtı (`partner-plan`). Uç,
-- paylaşılan bir ana anahtarla değil, KULLANICI BAŞINA bir sırla çalışıyor:
-- sır sızarsa yalnızca o kullanıcının planı okunabilir, ana anahtar sızsaydı
-- herkesinki okunurdu. Sır `arku-link` yanıtında kök seviyede dönüyor ve
-- BAĞLAMA ANINDA yakalanmalı — sonradan almanın yolu yok.
--
-- NEDEN AYRI TABLO (users'a kolon olarak değil)
-- users satırını kullanıcının kendisi okuyabiliyor (RLS: kendi satırın).
-- Sır orada dursaydı istemciye — dolayısıyla tarayıcıdaki herhangi bir
-- betiğe — görünürdü. Sırla yapılabilecek tek şey o kullanıcının planını
-- okumak, yani zarar küçük; ama sırrı sunucuda tutmanın maliyeti sıfır.
-- Bu tabloda POLİTİKA YOK: hiçbir istemci rolü erişemez, yalnızca
-- service_role (edge fonksiyonları) ve SECURITY DEFINER fonksiyonlar.
-- =========================================================

begin;

create table if not exists public.qrtim_link_secrets (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  qrtim_uid   uuid not null,
  link_secret text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- RLS açık ve politika YOK — kasıtlı. Politikasız tabloya istemci rolleri
-- hiçbir satır göremez.
alter table public.qrtim_link_secrets enable row level security;

revoke all on table public.qrtim_link_secrets from anon, authenticated;

drop trigger if exists trg_qrtim_link_secrets_updated on public.qrtim_link_secrets;
create trigger trg_qrtim_link_secrets_updated
  before update on public.qrtim_link_secrets
  for each row execute function public.arku_set_updated_at();

-- ---------------------------------------------------------
-- Bağlantı koparıldığında sır da gitmeli: kopardıktan sonra o sırla plan
-- sorgulamaya devam etmenin bir anlamı yok ve saklamanın gerekçesi kalmaz.
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

  delete from public.qrtim_link_secrets where user_id = v_uid;

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
-- 1) Tablo istemciye TAMAMEN kapalı olmalı (ikisi de 'yok'):
--      select case when has_table_privilege('anon','public.qrtim_link_secrets','select')
--                  then 'VAR' else 'yok' end as anon,
--             case when has_table_privilege('authenticated','public.qrtim_link_secrets','select')
--                  then 'VAR' else 'yok' end as authenticated;
--
-- 2) Politika olmamalı (0 satır):
--      select count(*) from pg_policies
--       where schemaname='public' and tablename='qrtim_link_secrets';
--
-- 3) CANLI TEST (QRtım bayrakları açıldıktan sonra): QRtım ile giriş yapın,
--    satır oluşmalı; Ayarlar > QRtım bağlantısını kesin, satır gitmeli.
--      select user_id, qrtim_uid, updated_at from public.qrtim_link_secrets;
--
-- GERİ ALMA
--   begin;
--   drop table if exists public.qrtim_link_secrets;
--   -- arku_qrtim_unlink'in bir önceki hali için
--   -- 20260921_qrtim_uid_identity.sql'deki tanımı yeniden çalıştırın.
--   commit;
-- =========================================================

insert into supabase_migrations.schema_migrations (version, name)
values ('20260922000100', 'qrtim_link_secrets')
on conflict (version) do nothing;

-- =========================================================
-- >>> 20260922_qrtim_plan_expiry.sql
-- =========================================================
-- =========================================================
-- Arku Remote — QRtım kaynaklı planın süresi ve tazelenmesi
-- Tarih: 2026-09-22
--
-- SORUN
-- QRtım planı Arku'ya yalnızca giriş/bağlama anında yazılıyordu ve yazılan
-- satırın süresi dolmuyordu (`current_period_end` hiç doldurulmuyor, plan
-- kontrolü yalnızca `status='active'` diyor). QRtım aboneliği biten kullanıcı
-- Arku'da ücretli kademede SÜRESİZ kalıyordu.
--
-- ÇÖZÜM: QRtım kaynaklı plana bir GEÇERLİLİK UFKU koyuyoruz. Uygulama planı
-- QRtım'in `partner-plan` ucundan periyodik doğruluyor; her başarılı
-- doğrulama ufku ileri itiyor. Doğrulama yapılamazsa ufuk kendiliğinden
-- geçiyor ve kullanıcı ücretsiz kademeye düşüyor.
--
-- SÜRE: 72 SAAT (Burak'ın kararı, 22.09.2026).
-- Gerekçe: Arku internet olmadan zaten çalışmıyor ve QRtım'in ucu bizimkiyle
-- aynı altyapıda; 72 saat boyunca ulaşamamak QRtım'de ciddi bir arıza demek.
-- Pencere, arıza sırasında müşteriyi mağdur etmeyecek kadar geniş, açığı
-- kapatacak kadar dar. Değiştirmek için aşağıdaki c_ttl sabiti yeterli —
-- süre TEK YERDE, burada duruyor (edge fonksiyonları bu fonksiyonu çağırır).
--
-- NULL = SÜRESİZ. Satın alınmış (source='direct') ve elle verilen
-- (source='manual') aboneliklerde `current_period_end` NULL kalır ve hiç
-- sorgulanmaz. Yalnızca QRtım kaynaklı satırlar tarih taşır — böylece
-- mevcut ödeme akışları bu değişiklikten HİÇ etkilenmez.
-- =========================================================

begin;

-- ---------------------------------------------------------
-- 1) Plan eşiği ve abonelik özeti artık süreyi dikkate alıyor
--
-- `current_period_end is null or > now()`: NULL süresiz demek, dolu bir tarih
-- geçmişse o abonelik artık saymaz.
-- ---------------------------------------------------------
create or replace function public.arku_plan_at_least(p_uid uuid, p_min text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select public.arku_plan_rank(p_min) <= greatest(
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

revoke all     on function public.arku_plan_at_least(uuid, text)  from public;
revoke execute on function public.arku_plan_at_least(uuid, text)  from anon;
grant  execute on function public.arku_plan_at_least(uuid, text)  to authenticated;

create or replace function public.arku_effective_subscription(p_uid uuid default null)
returns jsonb language plpgsql security definer set search_path = public stable as $$
declare
  v_uid uuid := auth.uid();
  v_out jsonb;
begin
  if v_uid is null then
    raise exception 'Oturum gerekli';
  end if;
  if p_uid is not null and p_uid <> v_uid then
    raise exception 'Yalnizca kendi aboneliginizi sorgulayabilirsiniz';
  end if;

  with ranks as (select unnest(array['free','pro','team','business']) as plan,
                        generate_series(0,3) as rank),
  own as (
    select s.plan, s.status, s.source, s.seats
    from public.subscriptions s
    where s.owner_id = v_uid and s.status = 'active'
      and (s.current_period_end is null or s.current_period_end > now())
  ),
  org_plans as (
    select s.plan
    from public.organization_members m
    join public.organizations o on o.id = m.org_id
    join public.subscriptions s on s.id = o.subscription_id
    where m.user_id = v_uid and m.status = 'active' and s.status = 'active'
      and (s.current_period_end is null or s.current_period_end > now())
  ),
  all_plans as (
    select plan from own
    union all select plan from org_plans
    union all select 'free'
  ),
  best as (
    select ap.plan from all_plans ap join ranks r on r.plan = ap.plan
    order by r.rank desc limit 1
  )
  select jsonb_build_object(
    'plan', (select plan from best),
    'source', coalesce((select source from own), 'none'),
    'seats', coalesce((select seats from own), 1),
    'is_org_member', exists(select 1 from public.organization_members
                            where user_id = v_uid and status = 'active')
  ) into v_out;

  return v_out;
end $$;

revoke all     on function public.arku_effective_subscription(uuid) from public;
revoke execute on function public.arku_effective_subscription(uuid) from anon;
grant  execute on function public.arku_effective_subscription(uuid) to authenticated;

-- ---------------------------------------------------------
-- 2) QRtım planını uygula — TEK YER
--
-- Bu mantık daha önce qrtim-auth ve qrtim-sync içinde TypeScript olarak İKİ
-- KEZ yazılmıştı. Süre buraya geldiği için ikisinin de aynı kurala uyması
-- şart; kopyayı çoğaltmak yerine tek fonksiyona indirildi.
--
-- Kurallar (eskisiyle aynı, üzerine süre eklendi):
--   * Satın alınmış aktif abonelik (source='direct') EZİLMEZ.
--   * Ücretsiz QRtım planı için yeni abonelik satırı AÇILMAZ; yalnızca
--     mevcut qrtim satırı free'ye çekilir.
--   * Ücretli plan qrtim kaynaklı yazılır ve ufku 72 saat ileri itilir.
-- ---------------------------------------------------------
-- ÜCRETLİ Mİ SORUSUNU BİZ CEVAPLAMIYORUZ
-- Eskiden plan ADINDAN çıkarılıyordu ve bilinmeyen her ad ÜCRETLİ sayılıyordu:
-- QRtım'de "deneme" gibi ücretsiz bir kademe çıksa sessizce ücretli lisans
-- dağıtırdık. QRtım artık cevabında `paid` (boolean) döndürüyor; karar orada
-- üretiliyor ve tanımsız plan `paid: false` dönüyor. Yeni kademe eklendiğinde
-- ne bizim kod değişiyor ne de haber verilmesi gerekiyor.
--
-- p_paid NULL ise ABONELİĞE HİÇ DOKUNULMAZ. "Bilinmiyor", "ücretsiz" demek
-- değildir: QRtım bir gün bu alanı göndermeyi bırakırsa (regresyon, sürüm
-- uyuşmazlığı), NULL'ı `false` saymak bütün ödeme yapan müşterileri bir anda
-- düşürürdü. Dokunmamak ikisini de yapmaz: yanlış yetki vermez, yanlış
-- yetki almaz. Doğrulama hiç gelmezse 72 saatlik ufuk kendiliğinden geçer ve
-- kullanıcı zaten ücretsize düşer — yani güvenli varsayılan yine yerinde.
--
-- Bu yüzden plan ADINDAN "ücretli mi" çıkarımı KALDIRILDI; artık hiçbir yolda
-- yok. (Bir süre köprü olarak duruyordu, `arku-link` de `paid` döndürmeye
-- başlayınca 22.09.2026'da silindi.)
--
-- KADEME ADI hâlâ bizde: hangi ÜCRETLİ kademenin Arku business'ına denk
-- geldiği bizim ürün kararımız. Bilinmeyen ücretli ad `pro` olur — yani
-- yanlış tarafa düşse bile DAHA DÜŞÜK kademeye düşer.
-- (QRtım `max_sync_devices` / `password_sync` alanlarına bağlamayı önerdi;
--  bağlamadık: Arku'nun business kademesi CİHAZ sayısı değil, bir firmadaki
--  OPERATÖR koltuğu demek — farklı bir eksen.)
create or replace function public.arku_qrtim_apply_plan(
  p_user_id    uuid,
  p_qrtim_plan text,
  p_paid       boolean default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan   text;
  v_paid   boolean;
  v_ad     text;
  v_src    text;
  v_status text;
  c_ttl    constant interval := interval '72 hours';
begin
  if p_user_id is null then
    raise exception 'user_id zorunlu';
  end if;

  v_ad := lower(trim(coalesce(p_qrtim_plan, '')));

  -- DOĞRULANAMADI: aboneliğe dokunma, mevcut planı olduğu gibi bildir.
  -- Ufuk ilerletilmediği için doğrulama gelmemeye devam ederse süre kendi
  -- geçer ve kullanıcı ücretsize düşer.
  if p_paid is null then
    return coalesce(
      (select s.plan from public.subscriptions s
        where s.owner_id = p_user_id and s.status = 'active'
          and (s.current_period_end is null or s.current_period_end > now())),
      'free'
    );
  end if;

  v_paid := p_paid;

  -- Hangi kademe? Yalnızca ücretliyse sorulur.
  v_plan := case
    when not v_paid then 'free'
    when v_ad in ('stk', 'business', 'corporate', 'kurumsal', 'enterprise')
      then 'business'
    else 'pro'
  end;

  select s.source, s.status into v_src, v_status
  from public.subscriptions s where s.owner_id = p_user_id;

  -- Satın alınmış aktif aboneliğe dokunma.
  if v_src = 'direct' and v_status = 'active' then
    return v_plan;
  end if;

  if v_plan = 'free' then
    if v_src = 'qrtim' then
      update public.subscriptions
         set plan = 'free', qrtim_plan = p_qrtim_plan, status = 'active',
             current_period_end = null
       where owner_id = p_user_id;
    end if;
    return 'free';
  end if;

  insert into public.subscriptions
    (owner_id, plan, status, source, qrtim_plan, seats, current_period_end)
  values
    (p_user_id, v_plan, 'active', 'qrtim', p_qrtim_plan,
     case when v_plan = 'business' then 5 else 1 end, now() + c_ttl)
  on conflict (owner_id) do update
     set plan = excluded.plan,
         status = 'active',
         source = 'qrtim',
         qrtim_plan = excluded.qrtim_plan,
         seats = excluded.seats,
         current_period_end = excluded.current_period_end;

  return v_plan;
end $$;

-- İki parametreli bir sürümü uygulanmışsa düşür: aksi halde iki imza yan yana
-- kalır ve `paid` göndermeyen çağrı sessizce eski davranışa düşerdi.
drop function if exists public.arku_qrtim_apply_plan(uuid, text);

revoke all     on function public.arku_qrtim_apply_plan(uuid, text, boolean) from public;
revoke execute on function public.arku_qrtim_apply_plan(uuid, text, boolean) from anon, authenticated;
grant  execute on function public.arku_qrtim_apply_plan(uuid, text, boolean) to service_role;

-- ---------------------------------------------------------
-- 3) Bağ koparıldığında / hesap silindiğinde yetkiyi HEMEN düşür
--
-- QRtım `link_revoked` (410) döndüğünde çağrılır. `unauthorized` (401) için
-- ÇAĞRILMAZ: o cevap "bizdeki kayıt bozuk olabilir" anlamına da geliyor ve
-- ona dayanarak kullanıcı düşürmek yanlış olur.
-- ---------------------------------------------------------
create or replace function public.arku_qrtim_revoke_link(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null then return; end if;

  delete from public.qrtim_link_secrets where user_id = p_user_id;

  update public.subscriptions
     set plan = 'free', status = 'active', qrtim_plan = null,
         current_period_end = null
   where owner_id = p_user_id and source = 'qrtim';

  update public.users
     set qrtim_uid = null, qrtim_id = null, qrtim_username = null,
         qrtim_name = null, qrtim_email = null, qrtim_connected_at = null
   where id = p_user_id;
end $$;

revoke all     on function public.arku_qrtim_revoke_link(uuid) from public;
revoke execute on function public.arku_qrtim_revoke_link(uuid) from anon, authenticated;
grant  execute on function public.arku_qrtim_revoke_link(uuid) to service_role;

commit;

-- =========================================================
-- DOĞRULAMA
--
-- 1) Mevcut abonelikler ETKİLENMEMELİ (hepsinin current_period_end'i NULL):
--      select source, count(*), count(current_period_end) as tarihli
--      from public.subscriptions group by source;
--
-- 2) Süresi geçmiş bir QRtım satırı plan vermemeli:
--      -- test hesabıyla:
--      update public.subscriptions
--         set current_period_end = now() - interval '1 hour'
--       where owner_id = '<uuid>' and source = 'qrtim';
--      select public.arku_plan_at_least('<uuid>', 'pro');   -- false dönmeli
--
-- 3) Uygulama ve geri alma:
--      select public.arku_qrtim_apply_plan('<uuid>', 'professional', true);  -- 'pro'
--      select public.arku_qrtim_apply_plan('<uuid>', 'corporate', true);     -- 'business'
--      select plan, current_period_end from public.subscriptions where owner_id='<uuid>';
--      select public.arku_qrtim_revoke_link('<uuid>');
--      select plan, current_period_end from public.subscriptions where owner_id='<uuid>'; -- free / null
--
-- 4) `paid` YETKİLİDİR — ad ne olursa olsun:
--      select public.arku_qrtim_apply_plan('<uuid>', 'professional', false); -- 'free'
--      select public.arku_qrtim_apply_plan('<uuid>', 'deneme', true);        -- 'pro'
--    NULL = doğrulanamadı: satır DEĞİŞMEMELİ, mevcut plan dönmeli.
--      select plan, current_period_end from public.subscriptions where owner_id='<uuid>';
--      select public.arku_qrtim_apply_plan('<uuid>', 'professional', null);
--      -- aynı plan dönmeli ve current_period_end İLERLEMEMİŞ olmalı
--
-- 5) Satın alınmış abonelik EZİLMEMELİ:
--      -- source='direct', status='active' bir satırda
--      select public.arku_qrtim_apply_plan('<uuid>', 'professional', true);
--      -- satır değişmemeli
--
-- GERİ ALMA
--   20260912_authz_hardening.sql (arku_effective_subscription) ve
--   20260912_plan_enforcement.sql (arku_plan_at_least) içindeki tanımları
--   yeniden çalıştırın; sonra:
--     drop function if exists public.arku_qrtim_apply_plan(uuid, text);
--     drop function if exists public.arku_qrtim_revoke_link(uuid);
-- =========================================================

insert into supabase_migrations.schema_migrations (version, name)
values ('20260922000200', 'qrtim_plan_expiry')
on conflict (version) do nothing;

-- =========================================================
-- >>> 20261005_revoke_anon_table_grants.sql
-- =========================================================
-- =========================================================
-- Arku Remote — anon rolünün tablo yetkilerini geri al
-- Tarih: 2026-10-05
--
-- DURUM TESPİTİ (verify_security_state.sql, 04.10.2026)
--   C. ANON TABLO YETKISI
--     connections   select=VAR  insert=VAR  delete=VAR
--     logs          select=VAR  insert=VAR  delete=VAR
--     signals       select=VAR  insert=VAR  delete=VAR
--     subscriptions select=VAR  insert=VAR  delete=VAR
--     users         select=VAR  insert=VAR  delete=VAR
--
-- BUGÜN AÇIK KAPI DEĞİL. Bu tabloların hepsinde RLS açık ve `anon` rolü için
-- HİÇBİR politika yok; politikasız rol sıfır satır görür. 01.08.2026'da canlı
-- test edilmişti (20260801_signals_rls_identity, test 7: "oturumsuz okuma →
-- 0 satır"). Yani bu migration bir açığı KAPATMIYOR, bir TUZAĞI kaldırıyor.
--
-- TUZAK ŞU: koruma tek bir şeye, "anon için politika yazılmamış olmasına"
-- dayanıyor. Biri ileride `to public` bir politika yazarsa (ki `to public`
-- varsayılandır — rol belirtmeyi unutmak yeter) ya da bir tabloda RLS'i
-- geçici olarak kapatırsa, kapı aynı anda ardına kadar açılır. Tablo yetkisi
-- yoksa o hatanın bedeli yok: RLS ne derse desin erişim olmaz.
--
-- İŞLEVSEL ETKİSİ YOK. Her Arku istemcisinin bir oturumu var (misafirler dahil
-- anonim oturum açılıyor), yani veri erişimi hiçbir zaman `anon` rolüyle
-- yapılmıyor. Değişen tek şey, oturumsuz bir isteğin aldığı cevabın "0 satır"
-- yerine "permission denied" olması.
--
-- Not: `website_reviews` BU LİSTEDE YOK. Tanıtım sitesi yorumları oturumsuz
-- gönderilebiliyor olabilir; o tablo (henüz uygulanmamış olan
-- 20260802_website_reviews ile gelir) kendi kurallarıyla ele alınmalı.
-- =========================================================

begin;

revoke all on public.signals              from anon;
revoke all on public.users                from anon;
revoke all on public.connections          from anon;
revoke all on public.logs                 from anon;
revoke all on public.subscriptions        from anon;
revoke all on public.organizations        from anon;
revoke all on public.organization_members from anon;
revoke all on public.saved_contacts       from anon;
revoke all on public.contact_categories   from anon;

-- Bu ikisi daha sonraki migration'larla geldi; henüz yoksa atla.
do $$
begin
  if to_regclass('public.session_audit') is not null then
    execute 'revoke all on public.session_audit from anon';
  end if;
  if to_regclass('public.device_unattended') is not null then
    execute 'revoke all on public.device_unattended from anon';
  end if;
end $$;

-- Bundan SONRA public şemasında açılacak tablolar da anon'a kapalı doğsun.
-- (Supabase'in varsayılanı anon ve authenticated'a tam yetki vermektir; asıl
--  tuzağın kaynağı bu varsayılan.)
alter default privileges in schema public revoke all on tables from anon;

commit;

-- =========================================================
-- DOĞRULAMA
--
-- 1) verify_security_state.sql'i tekrar çalıştırın. C bölümünde artık
--    HEPSİ 'yok' demeli:
--      select=yok  insert=yok  delete=yok
--
-- 2) CANLI TEST (asıl kabul ölçütü) — uygulama hiç etkilenmemeli:
--    a. Misafir sekmesi açın, kimlik görünmeli.
--    b. Misafir → kayıtlı kullanıcı bağlantısı kurun, görüntü gelmeli.
--    c. Kayıtlı → kayıtlı bağlantı kurun.
--    d. Ayarlar'da plan etiketi görünmeli.
--    Hepsi oturumlu (authenticated) rolle çalışır; bu değişiklikten
--    etkilenmez. Biri bozulursa o akış gerçekten anon rolüyle veri
--    okuyormuş demektir — GERİ ALIN ve bana söyleyin.
--
-- GERİ ALMA (Supabase varsayılanına döner)
--   begin;
--   alter default privileges in schema public grant all on tables to anon;
--   grant all on public.signals, public.users, public.connections,
--                public.logs, public.subscriptions, public.organizations,
--                public.organization_members, public.saved_contacts,
--                public.contact_categories to anon;
--   commit;
-- =========================================================

insert into supabase_migrations.schema_migrations (version, name)
values ('20261005000100', 'revoke_anon_table_grants')
on conflict (version) do nothing;

-- =========================================================
-- >>> 20261005_connection_limit.sql
-- =========================================================
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

insert into supabase_migrations.schema_migrations (version, name)
values ('20261005000200', 'connection_limit')
on conflict (version) do nothing;
