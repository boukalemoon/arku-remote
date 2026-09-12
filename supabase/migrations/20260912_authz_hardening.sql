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
