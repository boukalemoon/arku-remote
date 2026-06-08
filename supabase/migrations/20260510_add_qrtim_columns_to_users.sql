-- =========================================================
-- Arku Remote - users tablosuna QRtım entegrasyon kolonları
-- Tarih: 2026-05-10
-- Amaç:
--   QRtım hesabı bağlama akışında kullanıcının QRtım kimliğini saklamak.
--   handleQrtimCallback bu kolonlara yazar; eksiklerse bağlama kalıcı olmaz.
--   Bu migration idempotenttir; kolonlar zaten varsa güvenle atlanır.
-- Çalıştırma: Arku Supabase projesi (bxakaxylrfjldhtdjjmf) > SQL Editor
-- =========================================================

begin;

alter table public.users add column if not exists qrtim_id text;
alter table public.users add column if not exists qrtim_username text;
alter table public.users add column if not exists qrtim_name text;
alter table public.users add column if not exists qrtim_email text;
alter table public.users add column if not exists qrtim_connected_at timestamptz;

-- Aynı QRtım hesabının birden çok Arku kullanıcısına bağlanmasını önlemek için
-- (NULL değerler kısıtlamadan etkilenmez)
create unique index if not exists users_qrtim_id_unique
  on public.users (qrtim_id)
  where qrtim_id is not null;

commit;
