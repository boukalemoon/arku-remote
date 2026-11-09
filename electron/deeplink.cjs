// arku:// özel protokolü (2026-11-10).
//
// NEDEN: Kayıt doğrulama ve şifre sıfırlama bağlantıları kullanıcının
// varsayılan tarayıcısında açılır; masaüstü uygulamasının kendi web adresi
// yoktur. Bağlantı web uygulamasına döner (https://app.arku.com.tr/
// ?kaynak=masaustu), doğrulama orada tamamlanır ve sayfa arku://auth/... ile
// masaüstü uygulamasını öne getirir.
//
// GÜVENLİK — BİLİNÇLİ OLARAK OTURUM BELİRTECİ TAŞINMAZ:
//   * Özel protokolü makinedeki başka bir uygulama da sahiplenebilir;
//     belirteç taşısaydı o uygulamaya gidebilirdi.
//   * Herhangi bir web sayfası arku://... açabilir. Belirteç kabul etseydik
//     saldırgan kurbanı KENDİ hesabıyla oturum açtırabilirdi (login CSRF):
//     kurban farkında olmadan saldırganın hesabından bağlantı kurar.
//   Bu yüzden bağlantı yalnızca aşağıdaki sabit olay adlarından birini taşır.
//   Olay adı kullanıcıya yalnızca bilgi mesajı gösterir; hiçbir yetki vermez.
//
// Bu modül Electron'a bağlı değildir; birim testi Node ile çalışır.
'use strict';

const SCHEME = 'arku';

/** İzin verilen olaylar: arku://auth/<olay> */
const AUTH_EVENTS = new Set(['dogrulandi', 'sifre-guncellendi', 'ac']);

// Komut satırından ya da işletim sisteminden gelen bir bağlantı için makul
// üst sınır. Daha uzunu bizim ürettiğimiz bir bağlantı olamaz.
const MAX_LEN = 200;

/**
 * arku:// bağlantısını çözer.
 * @param {unknown} raw
 * @returns {null | { kind: 'auth', event: 'dogrulandi' | 'sifre-guncellendi' | 'ac' }}
 */
function parseDeepLink(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_LEN) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== `${SCHEME}:`) return null;
  // Kullanıcı adı/şifre, port gibi alanlar bizim bağlantımızda olmaz.
  if (u.username || u.password || u.port) return null;
  if (u.hostname !== 'auth') return null;
  // Sondaki eğik çizgi tarayıcıya göre eklenebiliyor: /dogrulandi ve /dogrulandi/
  const event = u.pathname.replace(/^\/+|\/+$/g, '');
  if (!AUTH_EVENTS.has(event)) return null;
  return { kind: 'auth', event };
}

/**
 * Windows/Linux'ta bağlantı süreç argümanı olarak gelir (ilk açılışta
 * process.argv, uygulama açıkken 'second-instance' olayının argv'si).
 * @param {unknown} argv
 */
function findDeepLinkInArgv(argv) {
  if (!Array.isArray(argv)) return null;
  for (const a of argv) {
    if (typeof a === 'string' && a.toLowerCase().startsWith(`${SCHEME}://`)) {
      const parsed = parseDeepLink(a);
      if (parsed) return parsed;
    }
  }
  return null;
}

module.exports = { SCHEME, AUTH_EVENTS, parseDeepLink, findDeepLinkInArgv };
