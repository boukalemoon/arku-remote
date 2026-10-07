-- Düzeltme öncesi canlı fonksiyonlar (20260908_identity_presence_invites.sql,
-- 20260912_plan_enforcement.sql). Testlerin hatayı gerçekten yakaladığını
-- göstermek için önce bunlar kurulur, sonra düzeltme migration'ları uygulanır.
\set ON_ERROR_STOP on
create or replace function public.arku_ensure_connection_id() returns text language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_email text; v_existing text; v_candidate text; v_num bigint; v_try int := 0;
begin
  if v_uid is null then raise exception 'Oturum gerekli'; end if;
  select email into v_email from auth.users where id = v_uid;
  insert into public.users (id, email) values (v_uid, v_email) on conflict (id) do nothing;
  select connection_id into v_existing from public.users where id = v_uid;
  if v_existing is not null and length(trim(v_existing)) > 0 then return v_existing; end if;
  loop
    v_try := v_try + 1;
    v_num := (abs((('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::int)::bigint) % 900000000) + 100000000;
    v_candidate := public.arku_format_id(v_num::text);
    begin update public.users set connection_id = v_candidate where id = v_uid; return v_candidate;
    exception when unique_violation then if v_try >= 25 then raise exception 'Benzersiz kimlik üretilemedi'; end if; end;
  end loop;
end $$;
grant execute on function public.arku_ensure_connection_id() to authenticated;

create or replace function public.arku_org_seat_limit() returns trigger language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_seats integer; v_used integer;
begin
  select o.owner_id into v_owner from public.organizations o where o.id = new.org_id;
  if v_owner is null then return new; end if;
  if new.user_id is not null and new.user_id = v_owner then return new; end if;
  select coalesce(max(s.seats), 1) into v_seats from public.subscriptions s where s.owner_id = v_owner and s.status = 'active';
  select count(*) into v_used from public.organization_members m where m.org_id = new.org_id and m.status <> 'disabled' and (m.user_id is null or m.user_id <> v_owner);
  if v_used >= v_seats then raise exception 'Koltuk siniri dolu (% koltuk).', v_seats using errcode = 'check_violation'; end if;
  return new;
end $$;
create trigger trg_org_seat_limit before insert on public.organization_members for each row execute function public.arku_org_seat_limit();
