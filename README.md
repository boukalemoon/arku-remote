<div align="center">
<img width="1200" height="475" alt="Arku Remote Banner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Arku Remote

**Güvenli P2P Uzak Masaüstü Uygulaması** — Sunucusuz, uçtan uca şifreli, açık kaynak.

[arku-remote-website.vercel.app](https://arku-remote-website.vercel.app) · [Web'de Dene](https://arku-remote.vercel.app) · [Releases](https://github.com/boukalemoon/arku-remote/releases)

---

## Özellikler

- **P2P Bağlantı** — WebRTC ile sunucusuz, doğrudan bağlantı
- **Uçtan Uca Şifreleme** — Tüm veri akışı şifreli
- **Çapraz Platform** — Windows, macOS, Linux ve tarayıcı desteği
- **Açık Kaynak** — MIT lisansı

## Kurulum

[Releases](https://github.com/boukalemoon/arku-remote/releases) sayfasından platformunuza uygun dosyayı indirin:

| Platform | Dosya |
|----------|-------|
| Windows  | `Arku-Remote-Setup.exe` |
| macOS    | `Arku-Remote.dmg` |
| Linux    | `Arku-Remote.AppImage` |

## Geliştirme Ortamı

**Gereksinimler:** Node.js 20+

```bash
# Bağımlılıkları yükle
npm install

# .env.local dosyası oluştur
cp .env.example .env.local
# VITE_SUPABASE_URL ve VITE_SUPABASE_ANON_KEY değerlerini doldur

# Web uygulamasını başlat
npm run dev

# Electron uygulamasını başlat
npm run desktop:dev
```

## Yapı

```
src/          — React uygulaması
electron/     — Electron ana süreç
website/      — Landing page (statik HTML)
```

## Güvenlik

Güvenlik açığı bildirimi için: [SECURITY.md](SECURITY.md)

---

**ITrend Technology** tarafından geliştirildi.
