# Güvenlik Politikası

## Desteklenen Sürümler

| Sürüm | Destek Durumu |
|-------|--------------|
| 1.x   | Aktif destek |

## Güvenlik Açığı Bildirimi

Güvenlik açığı tespit ettiyseniz lütfen **GitHub Issues'u kullanmayın**.

Açığı doğrudan şu adrese gönderin: **burakakmese@gmail.com**

Bildiriminizde şunları belirtin:
- Açığın türü (XSS, injection, veri sızıntısı vb.)
- Etkilenen bileşen / dosya
- Yeniden üretme adımları
- Olası etkisi

48 saat içinde yanıt vermeye çalışıyoruz. Geçerli bildirimleri 90 gün içinde düzeltmeyi hedefliyoruz.

## Güvenlik Önlemleri

- Tüm P2P bağlantıları WebRTC üzerinden şifrelenmiş olarak iletilir
- Kimlik doğrulama Supabase Auth üzerinden yönetilir
- Electron uygulaması `contextIsolation: true` ve `nodeIntegration: false` ile çalışır
- Ortam değişkenleri `.env.local` dosyasında tutulur ve Git'e commit edilmez
