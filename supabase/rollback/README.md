# Geri alma ve tarihsel dosyalar

Bu klasördeki dosyalar **migration değildir** ve `supabase db push` / `db reset`
tarafından çalıştırılmamalıdır.

- `20260801_signals_rls_identity_revert.sql` — kimlik tabanlı sinyal RLS'ini
  geri alır ve `signals` tablosunu `using (true)` ile herkese açar. Eskiden
  `migrations/` içindeydi; dosya adı sırasında kimlik RLS'inden SONRA geldiği
  için sıfırdan kurulan her ortam (staging, felaket kurtarma) güvensiz
  durumda kalıyordu (denetim 2026-10-07, Y6). Yalnızca acil durumda, bilinçli
  olarak elle çalıştırın.

`../legacy/20260702_arku_initial_schema.sql` — ilk şema. Kendi başlığı
"mevcut projede asla çalıştırmayın" diyor ve `users_select_authenticated
using (true)` gibi sonradan sıkılaştırılmış politikaları yeniden yaratıyor.
