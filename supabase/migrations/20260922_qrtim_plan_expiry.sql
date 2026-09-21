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
-- p_paid NULL ise (henüz `paid` göndermeyen bir çağıran — bağlama anındaki
-- arku-link yanıtı) BİLİNEN ad listesine düşülür ve bilinmeyen ad artık
-- ÜCRETSİZ sayılır. Bu geçici köprü, arku-link de `paid` döndürmeye
-- başlayınca kaldırılabilir; o zamana kadar ilk giriş adla, hemen ardından
-- gelen ilk tazeleme `paid` ile doğruluyor.
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

  -- Ücretli mi? Önce QRtım'in cevabı; yoksa bilinen ad listesi (köprü).
  v_paid := coalesce(
    p_paid,
    v_ad in ('student', 'professional', 'stk', 'business', 'corporate',
             'kurumsal', 'enterprise')
  );

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
--    Köprü (paid bilinmiyor): bilinmeyen ad artık ÜCRETSİZ:
--      select public.arku_qrtim_apply_plan('<uuid>', 'deneme', null);        -- 'free'
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
