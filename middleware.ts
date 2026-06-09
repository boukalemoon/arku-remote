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

export default function middleware(): Response {
  const configured = (process.env.ARKU_FRAME_ANCESTORS || '').trim();
  const frameAncestors = configured ? `'self' ${configured}` : "'self'";
  return next({
    headers: {
      'Content-Security-Policy': `frame-ancestors ${frameAncestors}`,
    },
  });
}
