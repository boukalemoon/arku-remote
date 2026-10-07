// Çalıştırma: node --experimental-strip-types --test src/lib/dcschema.test.ts
// (Node 22.6+; ek paket gerekmez, ağa çıkmaz.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChannelText, parseControlMsg, parseInputEvent, sanitizeDisplayName } from './dcschema.ts';

test('Y3: nesne olarak gelen dosya adı reddedilir (React çökmesi)', () => {
  assert.equal(parseControlMsg({ k: 'file-offer', id: 'x', name: {}, size: 1 }), null);
  assert.equal(parseChannelText('{"k":"file-offer","id":"x","name":{},"size":1}'), null);
});

test('O5: sayı olmayan, negatif, kesirli ya da dev boyut reddedilir', () => {
  for (const size of ['abc', '100', -1, 0, 1.5, Number.NaN, Infinity, 2 ** 53, null]) {
    assert.equal(parseControlMsg({ k: 'file-offer', id: 'x', name: 'a.txt', size }), null, String(size));
  }
});

test('geçerli dosya teklifi korunur, yön işaretleri temizlenir', () => {
  assert.deepEqual(parseControlMsg({ k: 'file-offer', id: 'f1', name: 'rapor.pdf', size: 1234 }),
    { k: 'file-offer', id: 'f1', name: 'rapor.pdf', size: 1234 });
  const spoof = parseControlMsg({ k: 'file-offer', id: 'f2', name: 'belge‮fdp.exe', size: 10 });
  assert.ok(spoof && spoof.k === 'file-offer');
  assert.equal(spoof.name, 'belgefdp.exe');
  assert.equal(parseControlMsg({ k: 'file-offer', id: 'f3', name: '‮\u0000', size: 10 }), null);
});

test('screens listesi tür ve boyutça doğrulanır', () => {
  assert.equal(parseControlMsg({ k: 'screens', list: [{ id: 's', name: {} }] }), null);
  assert.equal(parseControlMsg({ k: 'screens', list: 'x' }), null);
  assert.equal(parseControlMsg({ k: 'screens', list: new Array(33).fill({ id: 'a', name: 'b' }) }), null);
  assert.deepEqual(parseControlMsg({ k: 'screens', list: [{ id: 'screen:1', name: 'Ekran 1' }], current: 'screen:1' }),
    { k: 'screens', list: [{ id: 'screen:1', name: 'Ekran 1' }], current: 'screen:1' });
});

test('bilinmeyen kontrol türü ve bozuk JSON atılır', () => {
  assert.equal(parseControlMsg({ k: 'rm -rf' }), null);
  assert.equal(parseChannelText('{bozuk'), null);
  assert.equal(parseChannelText(42), null);
});

test('kayıt rızası sürümü zorunlu', () => {
  assert.equal(parseControlMsg({ k: 'rec-accept' }), null);
  assert.deepEqual(parseControlMsg({ k: 'rec-accept', consentVersion: 'v1' }), { k: 'rec-accept', consentVersion: 'v1' });
});

test('girdi olayları: sayı olmayan koordinat reddedilir, wheel sınırlanır', () => {
  assert.equal(parseInputEvent({ type: 'mousemove', x: '1', y: 0 }), null);
  assert.equal(parseInputEvent({ type: 'click', button: 9, x: 0, y: 0 }), null);
  assert.deepEqual(parseInputEvent({ type: 'wheel', dx: 0, dy: 1e12, x: 0.5, y: 0.5 }),
    { type: 'wheel', dx: 0, dy: 2000, x: 0.5, y: 0.5 });
  assert.equal(parseInputEvent({ type: 'keydown', key: 'a'.repeat(33), code: 'KeyA' }), null);
  assert.deepEqual(parseChannelText('{"type":"keydown","key":"a","code":"KeyA"}'),
    { kind: 'input', msg: { type: 'keydown', key: 'a', code: 'KeyA' } });
});

test('sanitizeDisplayName denetim karakterlerini atar', () => {
  assert.equal(sanitizeDisplayName(' a\u0007b⁦c '), 'abc');
});
