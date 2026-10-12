-- Supabase'in bu testler için gereken asgari taklidi.
-- Canlı tanımlar 2026-10-07'de pg_get_functiondef / pg_policies ile okundu.
-- Yalnızca yerel, ağsız bir Postgres'te çalıştırılır.
\set ON_ERROR_STOP on
drop schema if exists public cascade; create schema public;
drop schema if exists auth cascade; create schema auth;
drop schema if exists extensions cascade; create schema extensions;
drop extension if exists pgcrypto;
create extension pgcrypto schema extensions;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end $$;
grant usage on schema public, auth, extensions to anon, authenticated;

create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create table public.users (
  id uuid primary key, email text, connection_id text unique, display_name text,
  phone text, theme text, last_seen timestamptz, device_fingerprint text);
alter table public.users enable row level security;
create policy users_select_own on public.users for select to authenticated using (auth.uid() = id);
grant select on public.users to authenticated;

create table public.subscriptions (id uuid primary key default gen_random_uuid(), owner_id uuid, seats int, status text);
create table public.organizations (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null, name text, slug text unique,
  logo_url text, subscription_id uuid, created_at timestamptz default now(), updated_at timestamptz default now());
create table public.organization_members (
  id uuid primary key default gen_random_uuid(), org_id uuid references public.organizations(id) on delete cascade,
  user_id uuid, role text not null default 'member', device_label text, invited_email text,
  status text not null default 'invited', created_at timestamptz default now(), unique (org_id, user_id));
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
-- Canlıdaki gibi: tablo düzeyinde geniş yetki (kolon kısıtı yok)
grant select, insert, update, delete on public.organizations, public.organization_members to authenticated;

create function public.arku_format_id(digits text) returns text language sql immutable set search_path to 'public' as
$$ select substr(digits,1,3)||'-'||substr(digits,4,3)||'-'||substr(digits,7,3); $$;
create function public.arku_is_org_member(p_org uuid, p_uid uuid) returns boolean language sql stable security definer set search_path to 'public' as
$$ select exists(select 1 from public.organization_members where org_id=p_org and user_id=p_uid and status='active'); $$;
create function public.arku_org_role(p_org uuid, p_uid uuid) returns text language sql stable security definer set search_path to 'public' as
$$ select role from public.organization_members where org_id=p_org and user_id=p_uid and status='active' limit 1; $$;
create function public.arku_owns_org(p_org uuid, p_uid uuid) returns boolean language sql stable security definer set search_path to 'public' as
$$ select exists(select 1 from public.organizations o where o.id=p_org and o.owner_id=p_uid); $$;
create function public.arku_org_add_founder() returns trigger language plpgsql security definer set search_path to 'public' as
$$ begin insert into public.organization_members(org_id,user_id,role,status) values (new.id,new.owner_id,'owner','active') on conflict (org_id,user_id) do nothing; return new; end $$;
create trigger trg_org_add_founder after insert on public.organizations for each row execute function public.arku_org_add_founder();

-- Canlı politikalar (2026-10-07 itibarıyla)
create policy orgs_select_member on public.organizations for select to authenticated using ((owner_id = auth.uid()) or arku_is_org_member(id, auth.uid()));
create policy orgs_update_admin on public.organizations for update to authenticated
  using ((owner_id = auth.uid()) or (arku_org_role(id, auth.uid()) = any (array['owner','admin'])))
  with check ((owner_id = auth.uid()) or (arku_org_role(id, auth.uid()) = any (array['owner','admin'])));
create policy org_members_select on public.organization_members for select to authenticated using ((user_id = auth.uid()) or arku_is_org_member(org_id, auth.uid()));
create policy org_members_write_admin on public.organization_members for insert to authenticated
  with check (arku_owns_org(org_id, auth.uid()) or (arku_org_role(org_id, auth.uid()) = any (array['owner','admin'])));
create policy org_members_update_admin on public.organization_members for update to authenticated
  using (arku_owns_org(org_id, auth.uid()) or (arku_org_role(org_id, auth.uid()) = any (array['owner','admin'])))
  with check (arku_owns_org(org_id, auth.uid()) or (arku_org_role(org_id, auth.uid()) = any (array['owner','admin'])));
create policy org_members_delete_admin on public.organization_members for delete to authenticated
  using ((arku_owns_org(org_id, auth.uid()) or (arku_org_role(org_id, auth.uid()) = any (array['owner','admin']))) and not arku_owns_org(org_id, user_id));
