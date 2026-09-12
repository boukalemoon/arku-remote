# Arku Remote — Yayına Alma Rehberi

Bu belge **gerçek mimariyi** anlatır. Önceki sürümü Firebase Hosting,
Firestore, Socket.io sinyalleşme sunucusu ve Capacitor mobil yapıyı
anlatıyordu; bunların hiçbiri kullanılmıyor ve o belge devralan bir
geliştiriciyi yanlış yönlendiriyordu.

---

## 1. Bileşenler

| Bileşen | Nerede | Ne yapar |
|---|---|---|
| Web uygulaması | Vercel — `arku-remote` | React/Vite arayüzü (`dist/`) |
| Tanıtım sitesi | Vercel — `arku-remote-website` (kök: `website/`) | Statik sayfa + `/api/track`, `/api/reviews` |
| Veritabanı + kimlik | Supabase `jpmbttlxyxrqmpghymbq` | Auth, sinyalleşme, denetim izi, RLS |
| Edge fonksiyonları | Supabase Functions | `turn-credentials`, `qrtim-auth`, `qrtim-sync` |
| TURN relay | Kendi sunucunuz (coturn, Docker) | Kısıtlı ağlarda bağlantı — bkz. `TURN_SETUP.md` |
| Masaüstü paketleri | GitHub Releases | Etiket push'unda GitHub Actions üretir |

**Sinyalleşme için ayrı bir sunucu YOKTUR.** SDP ve ICE adayları Supabase
`signals` tablosundan geçer; teslimat Realtime (WebSocket) ile, o düşerse HTTP
yedek sorgusuyla yapılır.

---

## 2. Sürüm yayınlama

Sürümün tek kaynağı `package.json`, sürüm notlarının tek kaynağı
`CHANGELOG.md`. Web sitesindeki sürüm alanları bunlardan **türetilir**.

```bash
# 1. package.json > version alanını yükselt
# 2. CHANGELOG.md'ye [yeni-sürüm] bölümünü yaz
npm run release:sync     # siteyi yeni sürüme işle
npm run release:check    # tutarsızlık var mı (CI de bunu çalıştırır)

git commit -am "vX.Y.Z"
git tag vX.Y.Z
git push origin main --tags
```

Etiket push'u `.github/workflows/build.yml`'i tetikler: Windows/macOS/Linux
paketleri derlenir, `CHANGELOG.md`'den sürüm notu üretilir ve GitHub Release
oluşturulur.

`release:check` başarısız olursa **derleme durur** — site ya da CHANGELOG
geride kalmışsa yayından sonra fark etmektense burada patlaması iyidir.

---

## 3. Veritabanı migration'ları

Supabase Dashboard → SQL Editor'da **dosya adı sırasıyla** çalıştırın.
Her dosyanın başında ne yaptığı, sonunda doğrulama sorgusu ve geri alma
bloğu vardır.

### Canlı durumu görmek

Hangi migration'ın uygulandığı dışarıdan görünmez. Değişiklik yapmadan önce:

```
supabase/verify_security_state.sql    ← SALT OKUNUR, hiçbir şeye dokunmaz
```

Bu betik RLS durumunu, politika metinlerini, `anon` yetkilerini, Realtime
yayınını ve sinyal hacmini tek tabloda gösterir.

> `verify_signals.sql` içindeki yazma ifadeleri **bilerek yorumludur** —
> üretim tablosuna test satırı yazıyordu. Teşhis için yukarıdaki dosyayı
> kullanın.

### ⛔ `20260702_arku_initial_schema.sql` — yalnızca boş projede

Bu dosya izinli politikaları yeniden oluşturur ve sonraki migration'ların
kapattığı açıkları (S1/S2, PII sızıntısı) **geri açar**. Mevcut projede asla
çalıştırılmamalı; zorunlu kalırsanız ardından sertleştirme migration'larını
sırayla tekrar uygulayın (dosyanın başındaki nota bakın).

### v1.5.0 ile gelen migration'lar

```
20260912_org_owner_bootstrap.sql   Kurumsal modülün açılış kilidi (ZORUNLU)
20260912_authz_hardening.sql       users kolon yetkileri + abonelik RPC'si
20260912_plan_enforcement.sql      Plan ve koltuk sınırı sunucuda
20260912_retention_cleanup.sql     logs 90 gün, yetim anonim hesap 30 gün
```

İlki olmadan Kurumsal sekmesi çalışmaz (firma açılır ama üye eklenemez).
Diğer üçü bağımsızdır.

---

## 4. Supabase panel ayarları (SQL ile yapılamaz)

| Ayar | Yer | Değer |
|---|---|---|
| Anonymous sign-ins | Authentication → Sign In / Providers | **AÇIK** (misafir akışının ön koşulu) |
| Minimum password length | Authentication → Policies | **10** (istemci de 10 istiyor) |
| Leaked password protection | Authentication → Policies | **AÇIK** (HaveIBeenPwned, ücretsiz) |
| Confirm email | Authentication → Providers → Email | AÇIK |
| `pg_cron` | Database → Extensions | AÇIK (saklama süreleri buna bağlı) |

### Edge fonksiyonu secret'ları

```
TURN_URLS                 turn:turn.arku.com.tr:3478?transport=udp, ...
TURN_STATIC_AUTH_SECRET   turnserver.conf'taki static-auth-secret ile AYNI
TURN_TTL_SECONDS          43200 (opsiyonel)
STUN_URLS                 kendi coturn'ünüz (opsiyonel — KVKK açısından önerilir,
                          aksi halde Google STUN kullanılır: bkz. KVKK.md §6)
QRTIM_SSO_ENABLED         TANIMLAMAYIN — QRtım askıya alındı (S1)
```

---

## 5. Web dağıtımı (Vercel)

İki proje aynı depodan beslenir:

| Proje | Kök dizin | Build |
|---|---|---|
| `arku-remote` | depo kökü | `npm run build` → `dist/` |
| `arku-remote-website` | `website/` | build yok, statik |

Ortam değişkenleri (`arku-remote`):

```
ARKU_FRAME_ANCESTORS    Nexus domaini — iframe'e gömecek origin(ler).
                        Tanımlanmazsa yalnızca 'self' (clickjacking koruması).
VITE_SUPABASE_URL       opsiyonel; tanımsızsa koddaki public fallback kullanılır
VITE_SUPABASE_ANON_KEY  aynı — anon key tasarım gereği client'ta, RLS korur
```

`arku-remote-website` için: `FIREBASE_SERVICE_ACCOUNT` (servis hesabı JSON'ının
tamamı) ve `ANALYTICS_IP_SALT` (uzun rastgele değer — **tanımlanmazsa hiçbir IP
türevi saklanmaz**).

> `.vercelignore` içindeki `website` satırını EKLEMEYİN — o klasör ikinci
> Vercel projesinin kök dizinidir, dışlanırsa site 404 verir.

İçerik güvenlik politikası kök dizindeki `middleware.ts`'den gelir (Edge
Middleware). Masaüstüne bilinçli olarak uygulanmaz; orada koruma ana süreçteki
gezinme muhafızıdır.

---

## 6. Masaüstü paketleri

```bash
npm run desktop:dev            # geliştirme (Vite + Electron)
npm run desktop:build:win      # yerel paket (Windows)
npm run rebuild:native         # nut-js Electron ABI'sine göre yeniden derlenir
```

`@nut-tree-fork/nut-js` bir **native** modüldür: `asarUnpack` ile asar dışına
çıkarılır ve Electron sürümüne göre derlenmesi gerekir. Yüklenemezse uygulama
açılır ama uzaktan kontrol çalışmaz — arayüz sebebi söyler.

**Kod imzalama yok.** Windows'ta "Bilinmeyen yayıncı", macOS'ta Gatekeeper
uyarısı görünür. Bunun bir güvenlik sonucu var: `electron-updater` imza
doğrulaması yapamadığı için otomatik güncelleme yalnızca GitHub release'inin
bütünlüğüne dayanır. Bu yüzden v1.5.0'da **çıkışta sessiz kurulum kapatıldı**;
güncelleme indirilir ama kullanıcı onay vermeden kurulmaz.

> Release oluşturma yetkisini korumalı tutun (GitHub environment onayı +
> zorunlu 2FA). O yetki, tüm kurulu istemcilere kod gönderme yetkisidir.

Sertifika eklemek için CI'ya `CSC_LINK` ve `CSC_KEY_PASSWORD` secret'larını
tanımlayın; `CSC_IDENTITY_AUTO_DISCOVERY: false` satırını kaldırın.

---

## 7. Yayın öncesi kontrol listesi

- [ ] `npm run lint` — tip hatası yok
- [ ] `npm run build` — derleme geçiyor
- [ ] `npm run release:check` — sürüm tutarlı
- [ ] `npm audit --omit=dev` — yeni yüksek/kritik uyarı yok
- [ ] Migration'lar SQL Editor'da uygulandı, `verify_security_state.sql` beklendiği gibi
- [ ] İki cihazla canlı test: bağlantı, parola, kontrol izni, pano, dosya, kayıt
- [ ] Doğrulama kodunun (SAS) iki ekranda **aynı** olduğu görüldü
- [ ] Kurumsal: firma aç → üye ekle → cihaz etiketi → `slug-01` ile bağlan
- [ ] TURN çalışıyor (günlükte "ICE: STUN + TURN (sunucudan)")

---

## 8. Güvenlik notları

- Anon key tasarım gereği istemcidedir ve RLS ile korunur. **`service_role`
  anahtarı asla istemciye veya depoya girmez** — yalnızca edge fonksiyonu
  secret'ı olarak durur.
- `.env*` dosyaları `.gitignore`'da (`.env.example` hariç).
- Saklama süreleri ve kişisel veri kararları: **`KVKK.md`**.
- Açık bildirimi: **`SECURITY.md`** → info@arku.com.tr
