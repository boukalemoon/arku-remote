// Çalıştırma: node --experimental-strip-types --test supabase/functions/turn-credentials/handler.test.ts
// Deno ve Supabase sahte bağımlılıklarla değiştirilir; ağa çıkılmaz.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, hmacSha1Base64, type AdminApi } from './handler.ts';

const NOW = 1_800_000_000_000;
const SUB = '11111111-1111-4111-8111-111111111111';

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64(claims)}.imza`;
}
const userToken = jwt({ role: 'authenticated', sub: SUB, exp: NOW / 1000 + 3600 });

function req(token = userToken) {
  return new Request('https://x/functions/v1/turn-credentials', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
}

const okAdmin = (over: Partial<AdminApi> = {}): AdminApi => ({
  getUser: async () => ({ id: SUB, status: 200 }),
  rateLimit: async () => true,
  ...over,
});

function deps(env: Record<string, string>, admin: AdminApi, extra: Record<string, unknown> = {}) {
  const logs: string[] = [];
  return {
    logs,
    d: {
      env: { get: (k: string) => env[k] },
      admin: () => admin,
      now: () => NOW,
      log: (m: string, e?: unknown) => { logs.push(`${m} ${String(e ?? '')}`); },
      ...extra,
    },
  };
}

const HMAC_ENV = { TURN_STATIC_AUTH_SECRET: 's3cr3t', TURN_URLS: 'turn:turn.example:3478' };
const hasTurn = (body: { iceServers: { urls: unknown }[] }) =>
  body.iceServers.some((s) => String(s.urls).includes('turn:'));

test('temel durum: doğrulanmış kullanıcı coturn kimliği alır (A modu)', async () => {
  const { d } = deps(HMAC_ENV, okAdmin());
  const res = await handle(req(), d);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'hmac');
  assert.equal(body.turn, true);
  const expiry = NOW / 1000 + 43200;
  assert.equal(body.username, `${expiry}:${SUB}`);
  const turn = body.iceServers.find((s: { urls: unknown }) => String(s.urls).includes('turn:'));
  assert.equal(turn.credential, await hmacSha1Base64('s3cr3t', body.username));
});

test('anon anahtarı (role=anon) reddedilir', async () => {
  const { d } = deps(HMAC_ENV, okAdmin());
  const res = await handle(req(jwt({ role: 'anon', exp: NOW / 1000 + 60 })), d);
  assert.equal(res.status, 401);
});

test('O7: süresiz (exp yok) belirteç reddedilir', async () => {
  const { d } = deps(HMAC_ENV, okAdmin());
  const res = await handle(req(jwt({ role: 'authenticated', sub: SUB })), d);
  assert.equal(res.status, 401);
});

test('O7: auth sunucusuna ulaşılamazsa relay VERİLMEZ, yalnızca STUN döner', async () => {
  const { d, logs } = deps(HMAC_ENV, okAdmin({ getUser: async () => { throw new Error('ECONNRESET'); } }));
  const res = await handle(req(), d);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.turn, false);
  assert.equal(hasTurn(body), false);
  assert.ok(logs.some((l) => l.includes('ECONNRESET')), 'hata sunucu gunlugune yazilmadi');
});

test('O7: auth beklenmeyen yanıt verirse (500) relay verilmez', async () => {
  const { d } = deps(HMAC_ENV, okAdmin({ getUser: async () => ({ id: null, status: 500 }) }));
  const body = await (await handle(req(), d)).json();
  assert.equal(hasTurn(body), false);
});

test('auth kesin reddederse 401; başka kullanıcının belirteci 401', async () => {
  let { d } = deps(HMAC_ENV, okAdmin({ getUser: async () => ({ id: null, status: 403 }) }));
  assert.equal((await handle(req(), d)).status, 401);
  ({ d } = deps(HMAC_ENV, okAdmin({ getUser: async () => ({ id: 'baska', status: 200 }) })));
  assert.equal((await handle(req(), d)).status, 401);
});

test('O7: hız sınırı uygulanamazsa relay verilmez; sınır aşılınca 429', async () => {
  let { d } = deps(HMAC_ENV, okAdmin({ rateLimit: async () => { throw new Error('rpc yok'); } }));
  assert.equal(hasTurn(await (await handle(req(), d)).json()), false);
  ({ d } = deps(HMAC_ENV, okAdmin({ rateLimit: async () => false })));
  assert.equal((await handle(req(), d)).status, 429);
});

test('O7: sağlayıcı hatası apiKey içeren adresi istemciye sızdırmaz', async () => {
  const env = { TURN_PROVIDER_URL: 'https://app.metered.live/api/v1/turn/credentials?apiKey=GIZLI123' };
  const failingFetch = async (url: string) => { throw new TypeError(`fetch failed: ${url}`); };
  const { d, logs } = deps(env, okAdmin(), { fetch: failingFetch });
  const res = await handle(req(), d);
  const text = await res.text();
  assert.equal(text.includes('GIZLI123'), false, 'apiKey yanita sizdi');
  assert.equal(text.includes('metered'), false, 'saglayici adresi yanita sizdi');
  assert.ok(logs.some((l) => l.includes('GIZLI123')), 'hata sunucu gunlugunde olmali');
});

test('sağlayıcı modu başarılı yanıtı aktarır', async () => {
  const env = { TURN_PROVIDER_URL: 'https://p.example/creds' };
  const okFetch = async () => new Response(JSON.stringify([{ urls: 'turn:p.example:443', username: 'u', credential: 'c' }]));
  const { d } = deps(env, okAdmin(), { fetch: okFetch });
  const body = await (await handle(req(), d)).json();
  assert.equal(body.mode, 'provider');
  assert.equal(body.turn, true);
});

test('OPTIONS ön isteği kimlik istemeden yanıtlanır', async () => {
  const { d } = deps(HMAC_ENV, okAdmin());
  const res = await handle(new Request('https://x', { method: 'OPTIONS' }), d);
  assert.equal(res.status, 200);
});
