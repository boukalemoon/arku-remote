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
