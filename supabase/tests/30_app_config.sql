-- Zorunlu surum tablosu (20261012000100). Her test basarisizsa 'FAIL <id>'.
\set ON_ERROR_STOP on

-- Oturumu olan istemci (misafir dahil) en dusuk surumu okuyabilir.
set role authenticated;
do $$ declare v text; begin
  select value into v from public.app_config where key = 'min_desktop_version';
  if v is distinct from '1.6.0' then raise exception 'FAIL AC1: okunan deger %', v; end if;
  raise notice 'PASS AC1 (authenticated min_desktop_version=%)', v;
end $$;

-- Istemci degeri degistiremez, yeni anahtar ekleyemez, silemez.
do $$ begin
  begin
    update public.app_config set value = '0.0.1' where key = 'min_desktop_version';
    raise exception 'FAIL AC2: update yetkisi var';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.app_config (key, value) values ('x', 'y');
    raise exception 'FAIL AC2: insert yetkisi var';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.app_config;
    raise exception 'FAIL AC2: delete yetkisi var';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS AC2 (istemci yazamiyor)';
end $$;
reset role;

-- Listede olmayan anahtar istemciye gorunmez (ileride gizli ayar eklenirse).
insert into public.app_config (key, value) values ('internal_note', 'gizli');
set role authenticated;
do $$ begin
  if exists (select 1 from public.app_config where key = 'internal_note') then
    raise exception 'FAIL AC3: liste disi anahtar gorunuyor';
  end if;
  raise notice 'PASS AC3 (yalnizca izinli anahtarlar okunur)';
end $$;
reset role;

-- Oturumsuz (anon) istek tabloya hic erisemez.
set role anon;
do $$ begin
  begin
    perform 1 from public.app_config;
    raise exception 'FAIL AC4: anon okuyabildi';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS AC4 (anon erisemiyor)';
end $$;
reset role;

-- Migration ikinci kez uygulanirsa elle yukseltilmis deger EZILMEZ.
update public.app_config set value = '1.7.0' where key = 'min_desktop_version';
