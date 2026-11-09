/**
 * E-posta bağlantılarının (kayıt doğrulama, şifre sıfırlama) dönüş adresi ve
 * dönüşte adres çubuğuna eklenen sonucun okunması.
 *
 * NEDEN (müşteri bildirimi 2026-10-11): signUp ve resetPasswordForEmail dönüş
 * adresi göndermiyordu; Supabase de her kullanıcıyı panelindeki "Site URL"
 * değerine (http://localhost:3000) yönlendiriyordu. Doğrulama aslında başarılı
 * oluyor ama müşteri "Bu sayfaya ulaşılamıyor" görüyor, bağlantıya yeniden
 * tıklayınca da tek kullanımlık belirteç tükendiği için "otp_expired" alıyordu.
 *
 * Bu modül tarayıcı API'si kullanmaz; birim testi Node ile çalışır.
 */

/** Masaüstü uygulamasının kendi web adresi yok; dönüş buraya yapılır. */
export const PUBLIC_APP_URL = 'https://app.arku.com.tr/';

export interface LocationLike {
  protocol: string;
  hostname: string;
  origin: string;
}

/**
 * Masaüstünden başlatılan e-posta akışının işareti. Web sayfası bunu görünce
 * doğrulamadan sonra masaüstü uygulamasını arku:// ile öne getirir.
 * Supabase panelinde Redirect URLs listesinde bu adresin de izinli olması
 * gerekir (ör. https://app.arku.com.tr/**).
 */
export const DESKTOP_MARKER_PARAM = 'kaynak';
export const DESKTOP_MARKER_VALUE = 'masaustu';

function withDesktopMarker(base: string): string {
  const u = new URL(base);
  u.searchParams.set(DESKTOP_MARKER_PARAM, DESKTOP_MARKER_VALUE);
  return u.toString();
}

/**
 * E-posta bağlantısının döneceği adres.
 *   - Ortam değişkeniyle verilmişse o (VITE_AUTH_REDIRECT_URL).
 *   - Masaüstü uygulaması (Electron, file://) → herkese açık web uygulaması,
 *     sonuna ?kaynak=masaustu eklenir. Bağlantı kullanıcının varsayılan
 *     tarayıcısında açılır; file:// ya da localhost oraya hiçbir zaman
 *     ulaşamaz. Web sayfası doğrulamayı tamamlar, sonra arku:// ile
 *     masaüstü uygulamasını açar.
 *   - Web → sayfanın kendi kökü (önizleme ve yerel geliştirme dahil).
 */
export function authRedirectUrl(loc: LocationLike, isElectron: boolean, override?: string): string {
  const validOverride = override && /^https?:\/\//.test(override) ? override : undefined;
  const desktop = isElectron || (loc.protocol !== 'http:' && loc.protocol !== 'https:');
  if (desktop) return withDesktopMarker(validOverride ?? PUBLIC_APP_URL);
  if (validOverride) return validOverride;
  return `${loc.origin}/`;
}

/** Dönüş adresi masaüstünden başlatılmış bir akışa mı ait? */
export function isDesktopReturn(search: string): boolean {
  return new URLSearchParams(search.replace(/^\?/, '')).get(DESKTOP_MARKER_PARAM) === DESKTOP_MARKER_VALUE;
}

/** Web sayfasının masaüstü uygulamasını açmak için kullandığı bağlantılar. */
export type DesktopAuthEvent = 'dogrulandi' | 'sifre-guncellendi' | 'ac';
export const desktopAppLink = (event: DesktopAuthEvent): string => `arku://auth/${event}`;

/** Masaüstü uygulamasının arku:// olayı aldığında göstereceği bilgi. */
export function describeDesktopAuthEvent(event: string): string | null {
  switch (event) {
    case 'dogrulandi':
      return 'E-posta adresiniz dogrulandi. Simdi e-posta ve sifrenizle giris yapin.';
    case 'sifre-guncellendi':
      return 'Sifreniz guncellendi. Yeni sifrenizle giris yapin.';
    default:
      return null;
  }
}

export type AuthReturn =
  | { kind: 'error'; code: string; description: string }
  | { kind: 'signup' | 'recovery' | 'magiclink' | 'email_change' | 'invite'; }
  | null;

/**
 * Supabase'in dönüşte eklediği sonucu okur. Hem `#...` hem `?...` biçimini
 * kabul eder (implicit ve PKCE akışları).
 *   başarı: #access_token=...&type=signup
 *   hata:   #error=access_denied&error_code=otp_expired&error_description=...
 */
export function parseAuthReturn(hash: string, search: string): AuthReturn {
  const params = new URLSearchParams();
  for (const part of [search.replace(/^\?/, ''), hash.replace(/^#/, '')]) {
    for (const [k, v] of new URLSearchParams(part)) params.set(k, v);
  }
  const error = params.get('error') || params.get('error_code');
  if (error) {
    return {
      kind: 'error',
      code: params.get('error_code') || error,
      description: params.get('error_description') || '',
    };
  }
  const type = params.get('type');
  if (type && (params.get('access_token') || params.get('code') || params.get('token_hash'))) {
    if (type === 'signup' || type === 'recovery' || type === 'magiclink' || type === 'email_change' || type === 'invite') {
      return { kind: type };
    }
  }
  return null;
}

/** Kullanıcıya gösterilecek açıklama (Türkçe). */
export function describeAuthError(code: string): string {
  switch (code) {
    case 'otp_expired':
      return 'Bu baglanti daha once kullanilmis ya da suresi dolmus. E-posta adresiniz buyuk olasilikla zaten dogrulandi: '
        + 'e-posta ve sifrenizle giris yapmayi deneyin. Olmazsa asagidan yeni dogrulama e-postasi isteyin.';
    case 'access_denied':
      return 'Baglanti gecersiz. Giris yapmayi deneyin ya da yeni bir baglanti isteyin.';
    default:
      return `E-posta baglantisi islenemedi (${code}). Giris yapmayi deneyin ya da yeni bir baglanti isteyin.`;
  }
}
