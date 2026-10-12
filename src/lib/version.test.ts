// Çalıştırma: node --experimental-strip-types --test src/lib/version.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isVersionBelow, parseVersion } from './version.ts';

test('sürüm ayrıştırma: v öneki ve ekler', () => {
  assert.deepEqual(parseVersion('1.6.0'), [1, 6, 0]);
  assert.deepEqual(parseVersion('v1.10.2'), [1, 10, 2]);
  assert.deepEqual(parseVersion(' 2.0.0-beta.1 '), [2, 0, 0]);
  assert.equal(parseVersion('1.6'), null);
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion(null), null);
  assert.equal(parseVersion(160), null);
});

test('eski sürüm kapıya takılır, eşit ve yeni sürüm geçer', () => {
  assert.equal(isVersionBelow('1.4.0', '1.6.0'), true);
  assert.equal(isVersionBelow('1.5.9', '1.6.0'), true);
  assert.equal(isVersionBelow('1.6.0', '1.6.0'), false);
  assert.equal(isVersionBelow('1.6.1', '1.6.0'), false);
  assert.equal(isVersionBelow('2.0.0', '1.6.0'), false);
});

test('sayısal karşılaştırma: 1.10.0 > 1.9.0 (metin sırası değil)', () => {
  assert.equal(isVersionBelow('1.9.0', '1.10.0'), true);
  assert.equal(isVersionBelow('1.10.0', '1.9.0'), false);
});

test('bozuk yapılandırma kimseyi kilitlemez', () => {
  assert.equal(isVersionBelow('1.4.0', ''), false);
  assert.equal(isVersionBelow('1.4.0', 'son'), false);
  assert.equal(isVersionBelow('1.4.0', null), false);
  assert.equal(isVersionBelow('bilinmiyor', '1.6.0'), false);
});
