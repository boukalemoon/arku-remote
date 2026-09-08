-- =========================================================
-- Arku Remote — Denetim izi (append-only, hash zincirli)
-- Tarih: 2026-09-09
--
-- AMAÇ: "kim, kimi, ne zaman, hangi rızayla" sorusuna sonradan
-- ÇÜRÜTÜLEMEZ biçimde cevap verebilmek.
--
-- NEDEN SIRADAN BİR TABLO YETMEZ
-- Bir denetim kaydının değeri, DEĞİŞTİRİLEMEZLİĞİNDEN gelir. Satırları
-- güncellenebilen/silinebilen bir tablo hiçbir şey ispat etmez: karşı taraf
-- "sonradan yazılmış" der ve haklı olur. Bu yüzden:
--
--   1) APPEND-ONLY — update/delete politikası YOK ve yetki REVOKE edildi.
--   2) HASH ZİNCİRİ — her kayıt bir öncekinin hash'ini taşır. Araya kayıt
--      eklenemez, kayıt silinemez, sıra değiştirilemez; hepsi zinciri kırar.
--   3) HASH SUNUCUDA hesaplanır (trigger). İstemci hesaplasaydı sahte zincir
--      üretebilirdi.
--   4) actor_id istemciden ALINMAZ; trigger auth.uid() ile yazar. Kimse
--      başkası adına denetim kaydı üretemez.
--
-- Bu yapı SİZİ de korur: kayıtları siz bile fark edilmeden değiştiremezsiniz.
-- Mahkemede söylenebilecek en güçlü cümle budur.
--
-- KİŞİSEL VERİ NOTU: `detail` alanına ekran içeriği, dosya içeriği veya pano
-- metni YAZILMAZ — yalnızca olayın kendisi ve teknik öznitelikler. Kayıt
-- videosu zaten sunucuya hiç gelmez; burada yalnızca üstverisi durur.
-- =========================================================

begin;

-- NOT: Supabase pgcrypto'yu `extensions` semasina kurar. Fonksiyonlar
-- `set search_path = public` ile calistigi icin digest() cagrisi TAM
-- NITELIKLI olmalidir (extensions.digest); aksi halde her denetim kaydi
-- "function digest does not exist" ile patlar. Oz-testte yakalandi.
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.session_audit (
  id             uuid primary key default gen_random_uuid(),
  -- Zincirdeki sıra numarası (1'den başlar, boşluk olmaz).
  seq            bigint not null,
  -- Olayı üreten kullanıcı — trigger auth.uid()'den yazar, istemci veremez.
  actor_id       uuid not null references auth.users(id) on delete restrict,
  -- Olay anında kullanılan kimlikler (123-456-789 veya UUID).
  actor_identity text,
  peer_identity  text,
  event          text not null,
  -- Olaya özgü teknik ayrıntı: rıza metni sürümü, süre, dosya hash'i,
  -- cihaz öznitelikleri. İÇERİK YAZILMAZ.
  detail         jsonb not null default '{}'::jsonb,
  prev_hash      text not null,
  hash           text not null,
  created_at     timestamptz not null default now()
);

create unique index if not exists idx_session_audit_seq on public.session_audit (seq);
create index if not exists idx_session_audit_actor on public.session_audit (actor_id, created_at desc);

-- ---------------------------------------------------------
-- Zincir trigger'ı
-- ---------------------------------------------------------
create or replace function public.arku_audit_chain()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev    record;
  v_payload text;
begin
  if auth.uid() is null then
    raise exception 'Denetim kaydı için oturum gerekli';
  end if;

  -- Zinciri serileştir: iki eşzamanlı ekleme aynı prev_hash'i almamalı,
  -- yoksa zincir çatallanır ve doğrulama kırılır.
  perform pg_advisory_xact_lock(hashtext('arku_session_audit'));

  select sa.seq, sa.hash into v_prev
  from public.session_audit sa
  order by sa.seq desc
  limit 1;

  new.seq        := coalesce(v_prev.seq, 0) + 1;
  new.prev_hash  := coalesce(v_prev.hash, repeat('0', 64));
  -- İstemcinin gönderdiği actor_id/hash/seq DEĞERLERİ YOK SAYILIR.
  new.actor_id   := auth.uid();
  new.created_at := now();

  v_payload :=
       new.seq::text
    || '|' || new.actor_id::text
    || '|' || coalesce(new.actor_identity, '')
    || '|' || coalesce(new.peer_identity, '')
    || '|' || new.event
    || '|' || new.detail::text
    || '|' || to_char(new.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
    || '|' || new.prev_hash;

  new.hash := encode(extensions.digest(v_payload, 'sha256'), 'hex');
  return new;
end $$;

drop trigger if exists trg_session_audit_chain on public.session_audit;
create trigger trg_session_audit_chain
  before insert on public.session_audit
  for each row execute function public.arku_audit_chain();

-- Güncelleme/silme denemesini sessizce reddetmek yerine PATLAT: yetkiler
-- ileride yanlışlıkla verilirse bu trigger son savunma hattıdır.
create or replace function public.arku_audit_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Denetim kaydı değiştirilemez veya silinemez (append-only)';
end $$;

drop trigger if exists trg_session_audit_immutable on public.session_audit;
create trigger trg_session_audit_immutable
  before update or delete on public.session_audit
  for each row execute function public.arku_audit_immutable();

-- ---------------------------------------------------------
-- RLS: yalnızca kendi adına yazabilir, kendi kayıtlarını okuyabilir.
-- update/delete politikası BİLEREK YOK — politikasız işlem reddedilir.
-- ---------------------------------------------------------
alter table public.session_audit enable row level security;

drop policy if exists "session_audit_insert" on public.session_audit;
drop policy if exists "session_audit_select" on public.session_audit;

create policy "session_audit_insert" on public.session_audit for insert
to authenticated
with check (actor_id = auth.uid());

create policy "session_audit_select" on public.session_audit for select
to authenticated
using (actor_id = auth.uid());

revoke update, delete on public.session_audit from authenticated, anon;

-- ---------------------------------------------------------
-- arku_audit_verify — zincir sağlam mı?
--
-- Hash'leri baştan yeniden hesaplar. İlk bozulan kaydın seq'ini döndürür;
-- her şey tutuyorsa ok=true. "Kayıt silinmedi/değiştirilmedi" iddiasının
-- ispatı budur.
-- ---------------------------------------------------------
create or replace function public.arku_audit_verify()
returns table (ok boolean, kontrol_edilen bigint, ilk_bozuk_seq bigint, mesaj text)
language plpgsql
security definer
set search_path = public
as $$
declare
  r          record;
  v_prev     text := repeat('0', 64);
  v_beklenen bigint := 1;
  v_payload  text;
  v_hash     text;
  v_sayac    bigint := 0;
begin
  for r in select * from public.session_audit order by seq asc loop
    if r.seq <> v_beklenen then
      return query select false, v_sayac, r.seq,
        format('Sıra atlaması: %s bekleniyordu, %s bulundu (kayıt silinmiş olabilir)', v_beklenen, r.seq);
      return;
    end if;
    if r.prev_hash <> v_prev then
      return query select false, v_sayac, r.seq, 'Önceki hash tutmuyor (zincir kırılmış)'::text;
      return;
    end if;

    v_payload :=
         r.seq::text
      || '|' || r.actor_id::text
      || '|' || coalesce(r.actor_identity, '')
      || '|' || coalesce(r.peer_identity, '')
      || '|' || r.event
      || '|' || r.detail::text
      || '|' || to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
      || '|' || r.prev_hash;
    v_hash := encode(extensions.digest(v_payload, 'sha256'), 'hex');

    if v_hash <> r.hash then
      return query select false, v_sayac, r.seq, 'Kayıt içeriği değiştirilmiş (hash tutmuyor)'::text;
      return;
    end if;

    v_prev := r.hash;
    v_beklenen := v_beklenen + 1;
    v_sayac := v_sayac + 1;
  end loop;

  return query select true, v_sayac, null::bigint, 'Zincir sağlam'::text;
end $$;

revoke all on function public.arku_audit_verify() from public;
grant execute on function public.arku_audit_verify() to authenticated;
revoke execute on function public.arku_audit_verify() from anon;

revoke all     on function public.arku_audit_chain() from public;
revoke execute on function public.arku_audit_chain() from anon;

commit;

-- =========================================================
-- DOĞRULAMA
--   select * from public.arku_audit_verify();     -- ok=true
--   update public.session_audit set event='x';    -- HATA (append-only)
--   delete from public.session_audit;             -- HATA (append-only)
-- =========================================================
