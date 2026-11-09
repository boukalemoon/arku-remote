// arku:// bağlantı ayrıştırıcısı (2026-11-10).
// Çalıştırma: node --test tests/electron/deeplink.test.cjs
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseDeepLink, findDeepLinkInArgv } = require(path.join(__dirname, '..', '..', 'electron', 'deeplink.cjs'));

test('izin verilen olaylar çözülür (sondaki / dahil)', () => {
  assert.deepEqual(parseDeepLink('arku://auth/dogrulandi'), { kind: 'auth', event: 'dogrulandi' });
  assert.deepEqual(parseDeepLink('arku://auth/dogrulandi/'), { kind: 'auth', event: 'dogrulandi' });
  assert.deepEqual(parseDeepLink('arku://auth/sifre-guncellendi'), { kind: 'auth', event: 'sifre-guncellendi' });
  assert.deepEqual(parseDeepLink('ARKU://auth/ac'), { kind: 'auth', event: 'ac' });
});

test('bilinmeyen, belirteçli ya da biçimsiz bağlantılar reddedilir', () => {
  for (const bad of [
    'arku://auth/giris',
    'arku://auth/',
    'arku://baska/dogrulandi',
    'arku://kullanici:sifre@auth/dogrulandi',
    'arku://auth:99/dogrulandi',
    'https://auth/dogrulandi',
    'arku://auth/dogrulandi/ek',
    'arku://auth/../dogrulandi/x',
    'arku://auth/' + 'a'.repeat(300),
    '',
    null,
    42,
  ]) {
    assert.equal(parseDeepLink(bad), null, String(bad));
  }
});

test('belirteç taşıyan ek alanlar olayı değiştirmez ve dışarı verilmez', () => {
  const r = parseDeepLink('arku://auth/dogrulandi#access_token=abc&refresh_token=def');
  assert.deepEqual(r, { kind: 'auth', event: 'dogrulandi' });
  assert.equal(Object.keys(r).length, 2);
});

test('komut satırından bağlantı bulunur (Windows ikinci kopya / ilk açılış)', () => {
  assert.deepEqual(
    findDeepLinkInArgv(['C:\\Arku\\Arku-Remote.exe', '--allow-file-access', 'arku://auth/dogrulandi']),
    { kind: 'auth', event: 'dogrulandi' },
  );
  assert.equal(findDeepLinkInArgv(['C:\\Arku\\Arku-Remote.exe', '--hidden']), null);
  assert.equal(findDeepLinkInArgv(['x', 'arku://auth/giris']), null);
  assert.equal(findDeepLinkInArgv(undefined), null);
});
