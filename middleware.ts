import { next } from '@vercel/edge';

// Arku, Nexus (veya başka bir ana uygulama) içine iframe ile gömülebilir.
// Hangi origin'lerin gömebileceğini CSP "frame-ancestors" belirler.
//
// Çok kiracılı (multi-tenant): her müşterinin kendi Vercel deployment'ı vardır.
// İzin verilen ana uygulama domain(ler)i, ARKU_FRAME_ANCESTORS ortam değişkeninden
// okunur. Böylece kod değişmeden her deployment kendi Nexus domainine ayarlanır.
//
//   ARKU_FRAME_ANCESTORS = "https://nexus-musteri.com"
//   (birden fazla için boşlukla ayır: "https://a.com https://b.com")
//
// Ayarlanmazsa güvenli varsayılan yalnızca 'self'tir; yani harici hiçbir site
// Arku'yu iframe içine alamaz (clickjacking koruması).

export const config = {
  // Tüm rotalar (SPA route'ları ve statik dosyalar dahil).
  matcher: '/:path*',
};

// İçerik güvenlik politikası — YALNIZCA web dağıtımı için.
//
// Masaüstü (Electron) uygulaması sayfayı `file://` ile yükler ve bu
// middleware orada ÇALIŞMAZ. Bu bilinçli: `file://` origin'inde CSP'nin
// 'self' davranışı tarayıcı sürümüne göre değişir ve yanlış bir politika
// paketlenmiş uygulamada beyaz ekrana yol açabilir. Masaüstü tarafında
// asıl koruma, ana süreçteki gezinme muhafızıdır (electron/main.cjs):
// pencere kendi içeriği dışına çıkamaz, dolayısıyla köprüye erişebilecek
// yabancı bir sayfa yüklenemez.
//
// connect-src: Supabase REST + Realtime (wss). WebRTC bağlantıları CSP
// kapsamında değildir; STUN/TURN adreslerini burada saymaya gerek yok.
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  // Satır içi stil: React'in style prop'u CSSOM üzerinden çalıştığı için
  // CSP'ye takılmaz, ancak derlenmiş CSS bazı durumlarda satır içi stil
  // enjekte eder. Betik tarafı sıkı kaldığı için risk düşüktür.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
];

export default function middleware(): Response {
  const configured = (process.env.ARKU_FRAME_ANCESTORS || '').trim();
  const frameAncestors = configured ? `'self' ${configured}` : "'self'";
  return next({
    headers: {
      'Content-Security-Policy': [...CSP_DIRECTIVES, `frame-ancestors ${frameAncestors}`].join('; '),
      // Ek sertleştirmeler: tarayıcının içerik türü tahminini kapat,
      // dış sitelere referrer sızdırma.
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  });
}
