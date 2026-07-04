-- =========================================================
-- Arku Remote - Yeni Supabase projesi tam kurulum şeması
-- Tarih: 2026-07-02
-- Kapsam: users, logs, connections, signals tabloları,
--         RLS politikaları ve Realtime yayını (signals).
-- Yeni/boş projede bir kez çalıştırılır; tekrar çalıştırmak güvenlidir.
-- =========================================================

begin;

create extension if not exists pgcrypto;

-- ---------------------------------------------------------
-- 1) users — profil tablosu (auth.users ile 1:1)
-- ---------------------------------------------------------
create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  phone text,
  role text not null default 'user',
  connection_id text unique,
  device_fingerprint text,
  last_seen timestamptz,
  theme text not null default 'otuken',
  created_at timestamptz not null default now(),
  qrtim_id text,
  qrtim_username text,
  qrtim_name text,
  qrtim_email text,
  qrtim_connected_at timestamptz
);

create index if not exists idx_users_connection_id on public.users (connection_id);

alter table public.users enable row level security;

drop policy if exists "users_select_authenticated" on public.users;
drop policy if exists "users_insert_own" on public.users;
drop policy if exists "users_update_own" on public.users;

-- Bağlantı kurarken hedef kimlik (connection_id -> id) çözümü için
-- giriş yapmış kullanıcılar diğer satırları okuyabilmeli.
create policy "users_select_authenticated"
on public.users for select
to authenticated
using (true);

create policy "users_insert_own"
on public.users for insert
to authenticated
with check (auth.uid() = id);

create policy "users_update_own"
on public.users for update
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

-- ---------------------------------------------------------
-- 2) logs — kullanıcı işlem günlüğü
-- ---------------------------------------------------------
create table if not exists public.logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  msg text not null,
  type text not null default 'info' check (type in ('info', 'warn', 'error', 'sys')),
  created_at timestamptz not null default now()
);

create index if not exists idx_logs_user_created on public.logs (user_id, created_at desc);

alter table public.logs enable row level security;

drop policy if exists "logs_select_own" on public.logs;
drop policy if exists "logs_insert_own" on public.logs;

create policy "logs_select_own"
on public.logs for select
to authenticated
using (auth.uid() = user_id);

create policy "logs_insert_own"
on public.logs for insert
to authenticated
with check (auth.uid() = user_id);

-- ---------------------------------------------------------
-- 3) connections — bağlantı geçmişi
-- ---------------------------------------------------------
create table if not exists public.connections (
  id uuid primary key default gen_random_uuid(),
  caller_id uuid not null references auth.users(id) on delete cascade,
  receiver_id text not null,
  status text not null default 'active',
  duration_seconds integer not null default 0,
  created_at timestamptz not null default now(),
  ended_at timestamptz
);

create index if not exists idx_connections_caller_created on public.connections (caller_id, created_at desc);

alter table public.connections enable row level security;

drop policy if exists "connections_select_own" on public.connections;
drop policy if exists "connections_insert_own" on public.connections;
drop policy if exists "connections_update_own" on public.connections;

create policy "connections_select_own"
on public.connections for select
to authenticated
using (auth.uid() = caller_id);

create policy "connections_insert_own"
on public.connections for insert
to authenticated
with check (auth.uid() = caller_id);

create policy "connections_update_own"
on public.connections for update
to authenticated
using (auth.uid() = caller_id)
with check (auth.uid() = caller_id);

-- ---------------------------------------------------------
-- 4) signals — WebRTC sinyalleşme
-- Not: Misafir (anon) akışı desteklendiği için anon rolüne de
-- izin verilmek zorunda. Kayıtlar kısa ömürlüdür; istemci 60 sn
-- üzeri kayıtları siler. Ek koruma için aşağıdaki cron önerisine bakın.
-- ---------------------------------------------------------
create table if not exists public.signals (
  id uuid primary key default gen_random_uuid(),
  from_id text not null,
  to_id text not null,
  type text not null check (type in ('offer', 'answer', 'ice-candidate', 'hangup')),
  payload jsonb not null,
  session_id text,
  created_at timestamptz not null default now()
);

create index if not exists idx_signals_to_id_created_at on public.signals (to_id, created_at desc);
create index if not exists idx_signals_session_id_created_at on public.signals (session_id, created_at desc);
create index if not exists idx_signals_from_to_created_at on public.signals (from_id, to_id, created_at desc);

alter table public.signals enable row level security;

drop policy if exists "signals_insert_test" on public.signals;
drop policy if exists "signals_select_test" on public.signals;
drop policy if exists "signals_delete_test" on public.signals;
drop policy if exists "signals_insert" on public.signals;
drop policy if exists "signals_select" on public.signals;
drop policy if exists "signals_delete" on public.signals;

create policy "signals_insert"
on public.signals for insert
to authenticated, anon
with check (from_id is not null and to_id is not null);

create policy "signals_select"
on public.signals for select
to authenticated, anon
using (true);

create policy "signals_delete"
on public.signals for delete
to authenticated, anon
using (true);

-- ---------------------------------------------------------
-- 5) Realtime — signals tablosunu yayına ekle
-- ---------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'signals'
  ) then
    alter publication supabase_realtime add table public.signals;
  end if;
end $$;

commit;

-- =========================================================
-- ÖNERİ (opsiyonel): eski sinyalleri sunucu tarafında da temizle.
-- Dashboard > Database > Extensions'tan pg_cron'u etkinleştirip:
--
-- select cron.schedule('clean-signals', '*/5 * * * *',
--   $$delete from public.signals where created_at < now() - interval '5 minutes'$$);
-- =========================================================
