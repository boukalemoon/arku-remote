-- =========================================================
-- Arku Remote — web sitesi yorumları (Nexus moderasyonlu)
-- Tarih: 2026-08-02
-- DURUM: ✅ UYGULANDI ve canlı doğrulandı
--
-- TASARIM KURALI: hiçbir yorum moderasyondan geçmeden GÖRÜNÜR OLAMAZ.
--   * Herkes yorum gönderebilir, ama yalnızca status='pending' olarak.
--   * Tabloda SELECT politikası YOKTUR → kimse ham tabloyu okuyamaz.
--   * Site yalnızca `arku_public_reviews` görünümünü okur; o görünüm sadece
--     onaylı satırları ve herkese açık kolonları içerir (contact_email yok).
-- =========================================================

create table if not exists public.arku_reviews (
  id            uuid primary key default gen_random_uuid(),
  author_name   text not null check (char_length(author_name) between 2 and 80),
  author_title  text check (char_length(author_title) <= 120),
  rating        smallint check (rating between 1 and 5),
  body          text not null check (char_length(body) between 10 and 2000),
  -- Doğrulama/iletişim için; ASLA herkese açık değildir.
  contact_email text check (char_length(contact_email) <= 160),
  status        text not null default 'pending' check (status in ('pending','approved','rejected')),
  source        text not null default 'website',
  moderated_by  text,
  created_at    timestamptz not null default now(),
  published_at  timestamptz
);

create index if not exists idx_arku_reviews_status_published
  on public.arku_reviews (status, published_at desc);

alter table public.arku_reviews enable row level security;

drop policy if exists "reviews_insert_public" on public.arku_reviews;

-- Gönderim herkese açık, ama yalnızca 'pending'. İstemci status='approved'
-- göndermeye çalışırsa policy reddeder (canlı test: HTTP 401, RLS ihlali).
create policy "reviews_insert_public"
on public.arku_reviews for insert
to anon, authenticated
with check (status = 'pending' and published_at is null and moderated_by is null);

revoke select on public.arku_reviews from anon, authenticated;

create or replace view public.arku_public_reviews as
select id, author_name, author_title, rating, body, published_at
from public.arku_reviews
where status = 'approved';

grant select on public.arku_public_reviews to anon, authenticated;

-- =========================================================
-- NEXUS MODERASYON ENTEGRASYONU
--
-- Nexus, service_role anahtarıyla bağlanır ve RLS'i aşar.
--
-- Bekleyen yorumları listele:
--   select id, author_name, author_title, rating, body, contact_email, created_at
--   from public.arku_reviews
--   where status = 'pending'
--   order by created_at asc;
--
-- Onayla (yayımla):
--   update public.arku_reviews
--   set status = 'approved', published_at = now(), moderated_by = '<operator>'
--   where id = '<uuid>';
--
-- Reddet:
--   update public.arku_reviews
--   set status = 'rejected', moderated_by = '<operator>'
--   where id = '<uuid>';
--
-- NOT (spam): gönderim uç noktası herkese açıktır. Onaysız hiçbir şey
-- yayımlanmadığı için görünür bir risk yoktur, ancak bekleyen kuyruk spam ile
-- dolabilir. Sayfada bot tuzağı (honeypot) ve uzunluk kontrolleri var.
-- Hacim sorun olursa Nexus tarafında captcha veya IP bazlı sınırlama eklenebilir.
-- =========================================================
