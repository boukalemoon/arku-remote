# Arku Remote - TURN Sunucusu Kurulumu

## Seçenek 1: Docker Desktop ile (Windows)

### Adım 1: Docker Desktop Kurulumu

1. [Docker Desktop İndir](https://www.docker.com/products/docker-desktop) (Windows)
2. Kurulum dosyasını çalıştır
3. İşlem tamamlandıktan sonra PowerShell'i yeniden aç
4. Kontrol et:
   ```powershell
   docker --version
   ```

### Adım 2: Coturn Docker Image Hazırlama

Proje klasöründe `docker-compose.yml` oluştur:

```yaml
version: '3.8'
services:
  coturn:
    image: coturn/coturn:latest
    ports:
      - "3478:3478/udp"
      - "3478:3478/tcp"
      - "5349:5349/udp"
      - "5349:5349/tcp"
    volumes:
      - ./turnserver.conf:/etc/coturn/turnserver.conf:ro
    restart: always
    environment:
      - TURNSERVER_ENABLED=1
```

### Adım 3: Coturn Yapılandırması

Proje klasöründe `turnserver.conf` oluştur:

```conf
# TURN Server configuration for Arku Remote

# Network settings
listening-port=3478
listening-ip=0.0.0.0
external-ip=YOUR_PUBLIC_IP/YOUR_PRIVATE_IP

# Firewall ports
min-bps-capacity=0

# User database
user=turnuser:turnpass123

# Logging
log-file=/var/log/coturn/turnserver.log
log-file-max=10M

# Performance
bps-capacity=0
max-bps=0
max-sessions=0

# Security
realm=turn.arku.local
server-name=turn.arku.local

# WebRTC friendly settings
fingerprint
verbose
```

### Adım 4: Docker Konteynerini Başlat

```powershell
cd C:\Users\BurakAkmeşeITrendTec\Desktop\Otukenrdp
docker-compose up -d
```

Kontrol et:
```powershell
docker ps
```

---

## Seçenek 2: Bulut Sunucuda (DigitalOcean / Linode) - ÖNERİLEN

### Adım 1: Sunucu Oluştur

1. [DigitalOcean](https://www.digitalocean.com/?refcode=YOUR_CODE) üzerinde hesap aç
2. **Create** > **Droplet** > **Ubuntu 22.04**
3. Plan: **$5/month** yeterli
4. Bölge: Türkiye veya Avrupa
5. **Create Droplet**

### Adım 2: SSH ile Bağlan

```powershell
ssh root@YOUR_DROPLET_IP
```

### Adım 3: Coturn Kur

```bash
apt update
apt install -y coturn

# TURN sunucusunu etkinleştir
nano /etc/default/coturn
# TURNSERVER_ENABLED=1 değerini kaldır mı #

# Yapılandırma dosyasını düzenle
nano /etc/coturn/turnserver.conf
```

Düzenle:
```conf
listening-port=3478
listening-ip=0.0.0.0
external-ip=YOUR_DROPLET_IP

user=turnuser:turnpass123
realm=turn.arku.local

fingerprint
verbose
```

### Adım 4: Başlat

```bash
systemctl restart coturn
systemctl enable coturn

# Status kontrol et
systemctl status coturn
```

---

## Adım 5: Uygulamaya Entegre Et

### .env.local Dosyanı Güncelle

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=your_anon_key

# TURN Sunucusu (değiştir)
VITE_TURN_URL=turn:YOUR_PUBLIC_IP:3478
VITE_TURN_USERNAME=turnuser
VITE_TURN_CREDENTIAL=turnpass123
```

### Build ve Deploy

```powershell
npm run build
vercel --prod
```

---

## Adım 6: Test Et

1. https://arku-remote.vercel.app açın
2. İki cihazdan:
   - Cihaz A: Kimlik kopyala
   - Cihaz B: Kimliği gir, Bağlantı Kur
3. Ekran paylaşımını seç
4. Sistem Günlüğüne bak:
   - `ICE durumu: checking`
   - `ICE durumu: connected`
   - `P2P bağlantısı kuruldu!`

---

## Sorun Giderme

### TURN Sunucusu Bağlanmıyor

```bash
# Port açık mı?
netstat -an | grep 3478

# Firewall açık mı?
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
```

### TURN Sunucusu Çok Yavaş

- CPU/RAM artır
- TURN sunucusunun bölgesini kontrol et

### Docker Konteyneri Çöküyor

```powershell
docker logs coturn
```

---

## 📊 Maliyet Özeti

| Yöntem | Aylık Maliyet | Setup | Hız |
|--------|--------------|-------|-----|
| Docker Desktop (Local) | Ücretsiz | 15 min | Orta |
| DigitalOcean $5 | $5 | 20 min | İyi |
| Metered.ca Free | Ücretsiz (100 min) | 5 min | Hızlı |

**Tavsiye**: Başta Metered.ca ile test et, sonra DigitalOcean'a geç.

