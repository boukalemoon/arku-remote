-- Denetim 2026-10-07: Y1, Y2, O1 davranış testleri.
-- Her test başarısızsa 'FAIL <id>' ile istisna fırlatır.
\set owner  '11111111-1111-1111-1111-111111111111'
\set admin  '22222222-2222-2222-2222-222222222222'
\set newbie '33333333-3333-3333-3333-333333333333'
\set org    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

-- Hazırlık (süper kullanıcı)
insert into auth.users values (:'owner','o@x'),(:'admin','a@x'),(:'newbie','n@x');
insert into public.subscriptions(owner_id, seats, status) values (:'owner', 2, 'active');
insert into public.organizations(id, owner_id, name, slug) values (:'org', :'owner', 'Acme', 'acme');
insert into public.organization_members(org_id, user_id, role, status) values (:'org', :'admin', 'admin', 'active');
-- Eski, devre dışı bırakılmış bir üye (O1 için; kurum dolmadan önce eklenir)
insert into public.organization_members(org_id, invited_email, role, status) values (:'org', 'old@y', 'member', 'disabled');

-- Y2: yeni kullanıcı sunucudan kimlik alabilmeli
select set_config('request.jwt.claim.sub', :'newbie', false);
set role authenticated;
do $$ declare v text; v2 text; begin
  begin v := public.arku_ensure_connection_id();
  exception when others then raise exception 'FAIL Y2: kimlik atanamadi: %', sqlerrm; end;
  if v !~ '^[1-9][0-9]{2}-[0-9]{3}-[0-9]{3}$' then raise exception 'FAIL Y2: bicim %', v; end if;
  v2 := public.arku_ensure_connection_id();
  if v2 <> v then raise exception 'FAIL Y2: ikinci cagri farkli kimlik'; end if;
  raise notice 'PASS Y2 (%)', v;
end $$;
reset role;

-- Y1: admin kurumu ele geçirememeli
select set_config('request.jwt.claim.sub', :'admin', false);
set role authenticated;
do $$ begin
  begin
    update public.organizations set owner_id = auth.uid() where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    if found then raise exception 'FAIL Y1a: admin owner_id degistirdi'; end if;
  exception when insufficient_privilege then null; end;
  raise notice 'PASS Y1a (owner_id degistirilemiyor)';
end $$;
do $$ begin
  begin
    update public.organization_members set role = 'owner' where user_id = auth.uid();
    if found then raise exception 'FAIL Y1b: admin kendini owner yapti'; end if;
  exception when insufficient_privilege then null; end;
  raise notice 'PASS Y1b (admin kendini owner yapamiyor)';
end $$;
do $$ begin
  begin
    insert into public.organization_members(org_id, user_id, role, status)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'member', 'active');
    raise exception 'FAIL Y1c: admin onaysiz kullanici ekledi';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS Y1c (onaysiz uye eklenemiyor)';
end $$;
-- Mevcut istemci yolları çalışmaya devam etmeli
do $$ begin
  update public.organizations set name = 'Acme 2', slug = 'acme2', logo_url = null where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  if not found then raise exception 'FAIL Y1d: admin ad guncelleyemedi'; end if;
  insert into public.organization_members(org_id, invited_email, role, device_label, status)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'x@y', 'member', 'PC-1', 'invited');
  raise notice 'PASS Y1d (istemcinin ad guncelleme ve davet yolu calisiyor)';
end $$;
reset role;

-- O1: koltuk sınırı (2 koltuk: admin + 1 davet dolu) güncellemeyle aşılamamalı
select set_config('request.jwt.claim.sub', :'owner', false);
set role authenticated;
do $$ declare v_id uuid; begin
  -- Süper kullanıcı yetkisi olmadan devre dışı satır ekleme yolu: önce davet, sonra disabled
  begin
    insert into public.organization_members(org_id, invited_email, role, status)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'z@y', 'member', 'invited');
    raise exception 'FAIL O1a: dolu kuruma davet eklendi';
  exception when check_violation then null; end;
  raise notice 'PASS O1a (dolu kuruma ekleme reddedildi)';
end $$;
do $$ begin
  if not exists (select 1 from public.organization_members where invited_email = 'old@y' and status = 'disabled') then
    raise exception 'FAIL O1b: test verisi eksik';
  end if;
  begin
    update public.organization_members set status = 'active' where invited_email = 'old@y';
    if found then raise exception 'FAIL O1b: disabled -> active ile sinir asildi'; end if;
  exception when check_violation then null; end;
  raise notice 'PASS O1b (disabled -> active sinirda reddedildi)';
end $$;
do $$ begin
  -- Etkin bir satırın etiketini değiştirmek sınıra takılmamalı
  update public.organization_members set device_label = 'PC-2' where invited_email = 'x@y';
  if not found then raise exception 'FAIL O1c: etiket guncellenemedi'; end if;
  raise notice 'PASS O1c (dolu kurumda etkin satir guncellenebiliyor)';
end $$;
reset role;
\echo ALL_DONE
