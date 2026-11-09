// Çalıştırma: npm test  (node --experimental-strip-types --test ...)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authRedirectUrl, parseAuthReturn, describeAuthError, PUBLIC_APP_URL,
  isDesktopReturn, desktopAppLink, describeDesktopAuthEvent,
} from './authRedirect.ts';

const web = (origin: string) => {
  const u = new URL(origin);
  return { protocol: u.protocol, hostname: u.hostname, origin: u.origin };
};

const DESKTOP_URL = `${PUBLIC_APP_URL}?kaynak=masaustu`;

test('masaüstü uygulaması asla localhost ya da file:// adresine yönlendirmez; masaüstü işareti eklenir', () => {
  assert.equal(authRedirectUrl(web('http://localhost:3000'), true), DESKTOP_URL);
  assert.equal(authRedirectUrl({ protocol: 'file:', hostname: '', origin: 'null' }, true), DESKTOP_URL);
  assert.equal(authRedirectUrl({ protocol: 'file:', hostname: '', origin: 'null' }, false), DESKTOP_URL);
});

test('masaüstü dönüşü tanınır, web dönüşü tanınmaz', () => {
  assert.equal(isDesktopReturn('?kaynak=masaustu'), true);
  assert.equal(isDesktopReturn('kaynak=masaustu&code=x'), true);
  assert.equal(isDesktopReturn(''), false);
  assert.equal(isDesktopReturn('?kaynak=web'), false);
  // Web kullanıcısının dönüş adresinde işaret YOK.
  assert.equal(isDesktopReturn(new URL(authRedirectUrl(web('https://arku-remote.vercel.app'), false)).search), false);
});

test('masaüstü bağlantıları ve mesajları', () => {
  assert.equal(desktopAppLink('dogrulandi'), 'arku://auth/dogrulandi');
  assert.match(describeDesktopAuthEvent('dogrulandi') ?? '', /dogrulandi/);
  assert.match(describeDesktopAuthEvent('sifre-guncellendi') ?? '', /guncellendi/);
  assert.equal(describeDesktopAuthEvent('ac'), null);
  assert.equal(describeDesktopAuthEvent('baska'), null);
});

test('web: sayfanın kendi kökü (canlı, önizleme, yerel geliştirme)', () => {
  assert.equal(authRedirectUrl(web('https://arku-remote.vercel.app'), false), 'https://arku-remote.vercel.app/');
  assert.equal(authRedirectUrl(web('https://arku-remote-git-x.vercel.app'), false), 'https://arku-remote-git-x.vercel.app/');
  assert.equal(authRedirectUrl(web('http://localhost:3000'), false), 'http://localhost:3000/');
});

test('ortam değişkeni önceliklidir; geçersizse yok sayılır', () => {
  assert.equal(authRedirectUrl(web('http://localhost:3000'), true, 'https://app.arku.com.tr/'), 'https://app.arku.com.tr/?kaynak=masaustu');
  assert.equal(authRedirectUrl(web('https://a.example'), false, 'https://app.arku.com.tr/'), 'https://app.arku.com.tr/');
  assert.equal(authRedirectUrl(web('https://a.example'), false, 'javascript:alert(1)'), 'https://a.example/');
});

test('müşterinin aldığı hata adresi doğru okunur', () => {
  const r = parseAuthReturn('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired', '');
  assert.deepEqual(r, { kind: 'error', code: 'otp_expired', description: 'Email link is invalid or has expired' });
  assert.match(describeAuthError('otp_expired'), /zaten dogrulandi/);
});

test('başarılı doğrulama ve şifre sıfırlama dönüşleri tanınır', () => {
  assert.deepEqual(parseAuthReturn('#access_token=abc&refresh_token=x&type=signup', ''), { kind: 'signup' });
  assert.deepEqual(parseAuthReturn('#access_token=abc&type=recovery', ''), { kind: 'recovery' });
  assert.deepEqual(parseAuthReturn('', '?code=xyz&type=recovery'), { kind: 'recovery' });
});

test('ilgisiz adresler yok sayılır', () => {
  assert.equal(parseAuthReturn('', ''), null);
  assert.equal(parseAuthReturn('#bolum2', '?embed=1'), null);
  assert.equal(parseAuthReturn('#type=signup', ''), null); // belirteçsiz tür bilgisi yetmez
});
