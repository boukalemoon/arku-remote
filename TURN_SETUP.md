# Arku Remote — TURN Relay Kurulumu (Üretim)

## Neden gerekli?

WebRTC iki cihazı doğrudan bağlamaya çalışır. Bunun için STUN yeterlidir —
**ancak taraflardan biri simetrik NAT, kurumsal güvenlik duvarı veya CGNAT
arkasındaysa doğrudan bağlantı kurulamaz.** Bu durumda trafiğin bir relay
(TURN) sunucusu üzerinden aktarılması gerekir.

Türkiye'de mobil operatörlerin çoğu CGNAT kullanır ve kurumsal ağların önemli
bir kısmı UDP hole-punching'e izin vermez. **TURN olmadan bu kullanıcılar
Arku'ya hiç bağlanamaz** — arayüzde yalnızca "zaman aşımı" görürler.

> v1.0.16'ya kadar yayınlanan kurulumlarda TURN yapılandırması CI'ya hiç
> geçirilmiyordu; tüm binary'ler yalnızca STUN ile çıkıyordu. Bu belge o
> eksiği kapatır.

---

## Mimari

```
İstemci ──1── turn-credentials (Supabase Edge Function)
   │              │  HMAC-SHA1(paylaşılan sır, "expiry:userId")
   │              └─> { iceServers: [...], ttl: 43200 }
   │
   └──2── coturn (VPS)  ── use-auth-secret ile aynı sırdan doğrular
```

**Paylaşılan sır yalnızca iki yerde bulunur:** coturn'ün `turnserver.conf`
dosyasında ve Supabase Edge Function secret'ında. İstemciye asla gitmez;
istemci yalnızca 12 saat geçerli türetilmiş bir kimlik bilgisi alır.

---

## 1. Sunucu gereksinimleri

| Kalem | Öneri |
|---|---|
| Sunucu | 2 vCPU / 2 GB RAM VPS — relay CPU değil bant genişliği tüketir |
| Konum | Türkiye veya AB (gecikme + KVKK) |
| IP | **Genel (public), statik** IPv4 |
| Bant genişliği | Oturum başına ~0.4–2 Mbps çift yönlü. 100 eşzamanlı ≈ 200 Mbps |
| Alan adı | `turn.arku.com.tr` → sunucunun IP'sine A kaydı |

Relay trafiği ücretlidir; TURN yalnızca P2P kurulamadığında devreye girer
(tipik olarak oturumların %15–25'i).

---

## 2. Güvenlik duvarı

Açılacak portlar:

| Port | Protokol | Amaç |
|---|---|---|
| 3478 | UDP + TCP | STUN/TURN (düz) |
| 5349 | TCP | TURN over TLS (`turns:`) — kısıtlı ağları aşar |
| 49160–49300 | UDP | Relay port aralığı (`turnserver.conf` ile eşleşmeli) |

```bash
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw allow 5349/tcp
sudo ufw allow 49160:49300/udp
```

---

## 3. TLS sertifikası

Kurumsal güvenlik duvarlarının çoğu 443/TLS dışını engeller; `turns:` desteği
bu yüzden opsiyonel değil, pratikte zorunludur.

```bash
sudo apt install certbot
sudo certbot certonly --standalone -d turn.arku.com.tr
```

Yenilemede coturn'ün sertifikayı yeniden okuması için:

```bash
sudo crontab -e
# Ayda bir yenile ve konteyneri döndür
0 3 1 * * certbot renew --quiet && docker restart arku-turn
```

---

## 4. Paylaşılan sırrı üret

```bash
openssl rand -hex 32
```

Çıktıyı **iki yere** yazın (birebir aynı olmalı):

1. `turnserver.conf` → `static-auth-secret=...`
2. Supabase → Edge Functions → Secrets → `TURN_STATIC_AUTH_SECRET`

---

## 5. coturn'ü çalıştır

`turnserver.conf` içindeki `###` ile işaretli 4 yeri doldurun:
`external-ip`, `realm`/`server-name`, `static-auth-secret`, `cert`/`pkey`.

```bash
git clone https://github.com/boukalemoon/arku-remote.git
cd arku-remote
nano turnserver.conf          # ### satırlarını doldurun
docker compose up -d
docker compose logs -f coturn
```

Başarılı başlangıçta log'da şunlar görünür:

```
0: : Listener address to use: 0.0.0.0
0: : Relay address to use: <genel-ip>
0: : TLS listener opened on: 0.0.0.0:5349
```

---

## 6. Supabase Edge Function'ı yayına al

### Secret'ları tanımla

Supabase Dashboard → **Edge Functions → Secrets**:

| Ad | Değer |
|---|---|
| `TURN_STATIC_AUTH_SECRET` | 4. adımdaki sır (A modu — kendi coturn'ünüz) |
| `TURN_URLS` | `turn:turn.arku.com.tr:3478?transport=udp,turn:turn.arku.com.tr:3478?transport=tcp,turns:turn.arku.com.tr:5349?transport=tcp` |
| `TURN_TTL_SECONDS` | `43200` (opsiyonel, 12 saat) |

### Fonksiyonu dağıt

```bash
supabase functions deploy turn-credentials
```

`verify_jwt` **açık kalmalıdır** (varsayılan). Her Arku istemcisinin bir
oturumu vardır (misafirler dahil anonim oturum), dolayısıyla bu kimseyi
dışarıda bırakmaz ama oturumsuz kazıyıcıların relay kimliği almasını engeller.

---

## 7. Doğrulama

### a) Edge function yanıt veriyor mu?

```bash
curl -s -X POST \
  -H "apikey: <ANON_KEY>" \
  -H "Authorization: Bearer <ANON_KEY>" \
  -H "Content-Type: application/json" -d '{}' \
  https://jpmbttlxyxrqmpghymbq.supabase.co/functions/v1/turn-credentials | jq
```

Beklenen: `"turn": true` ve `iceServers` içinde `turn:`/`turns:` girdileri.
`"turn": false` dönüyorsa secret'lar tanımlanmamıştır.

### b) TURN gerçekten relay veriyor mu?

<https://icetest.info> veya Trickle ICE aracına aynı `iceServers` değerlerini
girin. **`typ relay` satırı görünmelidir.** Görünmüyorsa: sır uyuşmuyor,
`external-ip` yanlış veya relay port aralığı kapalı.

### c) Uygulamada

Bağlantı kurarken sistem günlüğünde şu satır görünmeli:

```
ICE: STUN + TURN (süreli kimlik)
```

Bağlantı kurulduğunda durum çubuğundaki rozet:
- **P2P** → doğrudan bağlantı (relay kullanılmadı, ideal)
- **RELAY** → TURN üzerinden aktarılıyor (çalışıyor, bant genişliği tüketiyor)
- **YEREL AG** → aynı ağdaki iki cihaz

`ICE: yalnızca STUN` yazıyorsa TURN devre dışıdır ve kısıtlı ağlardaki
kullanıcılar bağlanamaz.

---

## 8. İzleme

```bash
# Anlık relay oturumu sayısı
docker exec arku-turn turnutils_uclient -h 2>/dev/null; docker logs --tail 100 arku-turn | grep -c "allocated"

# Bant genişliği
docker stats arku-turn --no-stream
```

Relay oranı sürekli %40'ın üzerindeyse ağ tarafında bir sorun vardır
(UDP engelli olabilir) — `turns:` girdisinin `TURN_URLS` içinde olduğundan
emin olun.

---

## Alternatif: yönetilen TURN (hızlı başlangıç)

Kendi sunucunuzu işletmeden başlamak isterseniz edge fonksiyonu **B modunu**
destekler.

> **Önemli:** Yönetilen sağlayıcılar coturn'ün `use-auth-secret` (HMAC paylaşılan
> sır) şemasını **desteklemez**. Metered kimliği kendi REST API'sinden verir;
> bu yüzden **C modu** (`TURN_PROVIDER_URL`) kullanılır. İsteği edge fonksiyonu
> sunucu tarafında yapar, böylece `apiKey` istemciye hiç gitmez.

| Sağlayıcı | Ücretsiz kademe | Uygun mod |
|---|---|---|
| **Metered.ca** | Var (Open Relay; kota panelde görünür) | **C** — `TURN_PROVIDER_URL` |
| Twilio Network Traversal | Yok | C (kendi API adresiyle) veya B |
| Cloudflare Calls TURN | Var (sınırlı) | ⚠️ POST + API token ister; fonksiyona ek mod gerekir |

### Metered ile 10 dakikada devreye alma

**Metered tarafı**

1. <https://dashboard.metered.ca/signup?tool=turnserver> → ücretsiz hesap açın
   > Ücretsiz kademede bile **kredi kartı bilgisi ister** (2026-09 itibarıyla
   > doğrulandı). Pazarlama sayfası "kredi kartı gerekmez" dese de kayıt
   > akışında isteniyor. Kota aşımında otomatik ücretlendirme riskine karşı
   > panelden kullanım uyarısı tanımlayın.
2. **TURN Servers** sayfasında **Add Project** → projeye bir ad verin
   (örn. `arku`). Bu ad size `arku.metered.live` biçiminde bir alan adı verir
3. Proje kartında **Manage TURN Credentials** → **Add Credential**
4. Projenin **API Key**'ini kopyalayın (proje sayfasında görünür)

**Supabase tarafı** — Dashboard → Edge Functions → **Secrets**:

| Ad | Değer |
|---|---|
| `TURN_PROVIDER_URL` | `https://<proje>.metered.live/api/v1/turn/credentials?apiKey=<API_KEY>` |

Bu **tek secret yeterlidir**. `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`
ve `TURN_STATIC_AUTH_SECRET` **tanımlanmamalıdır** — Metered adresleri ve
kimliği kendi yanıtında döndürür, `TURN_STATIC_AUTH_SECRET` tanımlıysa A modu
öncelik alır ve Metered devre dışı kalır.

Secret ekledikten sonra fonksiyonu yeniden dağıtmaya gerek yoktur; yeni
çağrılar secret'ı hemen görür.

### Kendi sunucunuza geçiş

Hacim büyüyünce coturn'ü kurun (bölüm 1-5), sonra secret'ları değiştirin:
`TURN_PROVIDER_URL` **silin**, `TURN_STATIC_AUTH_SECRET` + `TURN_URLS`
**ekleyin**. İstemcide değişiklik gerekmez, yeni sürüm yayınlamaya gerek
yoktur — kimlik bilgisi zaten sunucudan geliyor.

---

## Geliştirme ortamı (yerel test)

Yerel ağda TURN'e gerek yoktur (host adayları çalışır). Yine de test etmek
isterseniz `.env.local` içine build zamanı TURN tanımlayabilirsiniz —
istemci, edge fonksiyonu TURN veremediğinde buna düşer:

```env
VITE_TURN_URL=turn:localhost:3478
VITE_TURN_USERNAME=test
VITE_TURN_CREDENTIAL=test
```

Bu yol yalnızca geliştirme içindir; üretimde **edge fonksiyonu kullanılmalıdır**.
