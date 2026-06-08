-- =========================================================
-- Yırak Remote - signals tablo/policy düzeltmesi
-- Tarih: 2026-04-19
-- Amaç:
-- 1) signals tablosunu uygulama ile uyumlu hale getirmek
-- 2) 400 Bad Request hatalarına neden olan şema/policy sorunlarını gidermek
-- =========================================================

begin;

-- Gerekli extension (uuid üretimi için)
create extension if not exists pgcrypto;

-- ---------------------------------------------------------
-- 1) signals tablosu yoksa oluştur
-- ---------------------------------------------------------
create table if not exists public.signals (
  id uuid primary key default gen_random_uuid(),
  from_id text not null,
  to_id text not null,
  type text not null check (type in ('offer', 'answer', 'ice-candidate', 'hangup')),
  payload jsonb not null,
  session_id text null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------
-- 2) Eksik kolonları ekle (mevcut eski tablo için güvenli)
-- ---------------------------------------------------------
alter table public.signals add column if not exists from_id text;
alter table public.signals add column if not exists to_id text;
alter table public.signals add column if not exists type text;
alter table public.signals add column if not exists payload jsonb;
alter table public.signals add column if not exists session_id text;
alter table public.signals add column if not exists created_at timestamptz default now();

-- null olabilecek eski kayıtlar için temel düzeltmeler (boşsa geçici değer)
update public.signals set type = 'offer' where type is null;
update public.signals set payload = '{}'::jsonb where payload is null;
update public.signals set created_at = now() where created_at is null;

-- not null kısıtları
alter table public.signals alter column from_id set not null;
alter table public.signals alter column to_id set not null;
alter table public.signals alter column type set not null;
alter table public.signals alter column payload set not null;
alter table public.signals alter column created_at set not null;

-- check constraint yoksa ekle
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'signals_type_check'
  ) then
    alter table public.signals
      add constraint signals_type_check
      check (type in ('offer', 'answer', 'ice-candidate', 'hangup'));
  end if;
end $$;

-- ---------------------------------------------------------
-- 3) Performans için indexler
-- ---------------------------------------------------------
create index if not exists idx_signals_to_id_created_at on public.signals (to_id, created_at desc);
create index if not exists idx_signals_session_id_created_at on public.signals (session_id, created_at desc);
create index if not exists idx_signals_from_to_created_at on public.signals (from_id, to_id, created_at desc);

-- ---------------------------------------------------------
-- 4) RLS ve policy
-- ---------------------------------------------------------
alter table public.signals enable row level security;

-- Eski policy'leri temizle (varsa)
drop policy if exists "signals_insert_test" on public.signals;
drop policy if exists "signals_select_test" on public.signals;
drop policy if exists "signals_delete_test" on public.signals;
drop policy if exists "signals_insert_secure" on public.signals;
drop policy if exists "signals_select_secure" on public.signals;
drop policy if exists "signals_delete_secure" on public.signals;

-- ---------------------------------------------------------
-- 4.A) TEST POLICIES (hızlı doğrulama için)
-- Not: Bu bölüm geliştirme/test içindir. Production'da sıkı policy kullanın.
-- ---------------------------------------------------------
create policy "signals_insert_test"
on public.signals
for insert
to authenticated, anon
with check (true);

create policy "signals_select_test"
on public.signals
for select
to authenticated, anon
using (true);

create policy "signals_delete_test"
on public.signals
for delete
to authenticated, anon
using (true);

commit;

-- =========================================================
-- PRODUCTION İÇİN SIKI POLICY ÖNERİSİ (MANUEL UYGULAYIN)
-- =========================================================
-- Aşağıdakiler örnektir. Sizin users eşleme modelinize göre uyarlayın.
--
-- 1) Test policy'leri kaldır:
-- drop policy if exists "signals_insert_test" on public.signals;
-- drop policy if exists "signals_select_test" on public.signals;
-- drop policy if exists "signals_delete_test" on public.signals;
--
-- 2) authenticated kullanıcılarla sınırla:
-- create policy "signals_insert_secure"
-- on public.signals
-- for insert
-- to authenticated
-- with check (from_id is not null and to_id is not null);
--
-- create policy "signals_select_secure"
-- on public.signals
-- for select
-- to authenticated
-- using (from_id is not null and to_id is not null);
--
-- create policy "signals_delete_secure"
-- on public.signals
-- for delete
-- to authenticated
-- using (from_id is not null);
