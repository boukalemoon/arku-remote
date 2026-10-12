// Çalıştırma: node --experimental-strip-types --test src/lib/hangup.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeHangup, HANGUP_PROTO } from './hangup.ts';

test('v1.4.0 alıcısından badpass (proto yok): eski sürüm açıklaması', () => {
  const m = describeHangup({ reason: 'badpass' });
  assert.match(m, /eski bir surum \(v1\.4\.0/);
  assert.match(m, /guncellemesi gerekiyor/);
});

test('yeni alıcıdan badpass: gerçekten parola hatalı', () => {
  const m = describeHangup({ reason: 'badpass', proto: HANGUP_PROTO });
  assert.match(m, /^Oturum parolasi hatali/);
  assert.doesNotMatch(m, /eski bir surum/);
});

test('outdated: karşı taraf güncellemeli', () => {
  assert.match(describeHangup({ reason: 'outdated', proto: 2 }), /guncel degil/);
});

test('diğer sebepler eskisi gibi; bozuk payload çökertmez', () => {
  assert.match(describeHangup({ reason: 'busy' }), /mesgul/);
  assert.match(describeHangup({ reason: 'rejected', proto: 2 }), /reddedildi/);
  assert.match(describeHangup(null), /baglantıyi kesti/);
  assert.match(describeHangup('x'), /baglantıyi kesti/);
  assert.match(describeHangup({ reason: 'badpass', proto: '2' }), /eski bir surum/); // metin "2" sayılmaz
});
