// Oturum kilidi kilitlenmesi (saha bildirimi 2026-10-11: "dışarıdan bağlanamıyor").
//
// supabase-js, onAuthStateChange dinleyicisini oturum kilidini (Web Locks)
// TUTARKEN çağırır. Dinleyici içinde başka bir supabase çağrısı beklenirse kilit
// hiç bırakılmaz; oturum isteyen her şey (TURN kimliği, bağlantı isteği, kabul)
// sonsuza dek bekler. Canlıda saatlik jeton yenilemesinden sonra yeniden üretildi.
//
// Bu testler kilidin olaydan sonra BIRAKILDIĞINI doğrular. Ağa çıkılmaz.
import { test, expect, type Page, type Route } from '@playwright/test';

const SUPABASE = /https:\/\/[a-z0-9]+\.supabase\.co\/.*/;
const LOCK = 'lock:sb-jpmbttlxyxrqmpghymbq-auth-token';
const STORE = 'sb-jpmbttlxyxrqmpghymbq-auth-token';
const jwt = (sub: string, extra: object = {}) =>
  `a.${Buffer.from(JSON.stringify({ sub, role: 'authenticated', exp: 4102444800, ...extra })).toString('base64url')}.s`;
const now = () => Math.floor(Date.now() / 1000);

async function mock(page: Page) {
  const calls: { method: string; path: string; url: string }[] = [];
  await page.route(SUPABASE, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    let body: any = null; try { body = req.postDataJSON(); } catch { /* gövdesiz */ }
    calls.push({ method: req.method(), path: url.pathname, url: req.url() });
    const json = (s: number, d: unknown) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(d) });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 200 });
    const session = (id: string, anon: boolean) => ({
      access_token: jwt(id, { is_anonymous: anon }), token_type: 'bearer', expires_in: 3600,
      expires_at: now() + 3600, refresh_token: 'r-' + Math.random(),
      user: { id, aud: 'authenticated', role: 'authenticated', is_anonymous: anon, email: anon ? null : 'real@example.com' },
    });
    if (url.pathname === '/auth/v1/signup' && !body?.email) return json(200, session('anon-1', true));
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      return json(200, session(body?.refresh_token?.startsWith('rec') ? 'real-1' : 'anon-1', !body?.refresh_token?.startsWith('rec')));
    }
    if (url.pathname === '/auth/v1/user' && req.method() === 'GET') {
      return json(200, { id: 'real-1', email: 'real@example.com', aud: 'authenticated', role: 'authenticated', is_anonymous: false });
    }
    if (url.pathname === '/auth/v1/user' && req.method() === 'PUT') {
      return json(200, { id: 'real-1', email: 'real@example.com', aud: 'authenticated', role: 'authenticated', is_anonymous: false });
    }
    // Canlıdaki gibi: sunucu kimliği atar (bağlama "hazır" olur).
    if (url.pathname === '/rest/v1/rpc/arku_ensure_connection_id') return json(200, '123-456-789');
    if (url.pathname.startsWith('/rest/v1/rpc/')) return json(200, null);
    if (url.pathname.startsWith('/rest/v1/')) return json(200, []);
    if (url.pathname.startsWith('/functions/v1/')) return json(200, { iceServers: [] });
    return json(200, {});
  });
  await page.routeWebSocket(/supabase\.co/, (ws) => { ws.close(); });
  return calls;
}

/** Kilit `ms` içinde serbest kalıyor mu? (kilitlenmede hiç kalmaz) */
async function lockReleasedWithin(page: Page, ms: number): Promise<boolean> {
  return page.evaluate(async ({ name, ms }) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const free = await navigator.locks.request(name, { ifAvailable: true }, async (l) => !!l);
      if (free) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }, { name: LOCK, ms });
}

test('saatlik jeton yenilemesinden sonra oturum kilidi bırakılır', async ({ page }) => {
  const calls = await mock(page);
  await page.goto('/');
  // Anonim oturum açılsın ve kimlik bağlansın.
  await expect.poll(() => page.evaluate((k) => !!localStorage.getItem(k), STORE)).toBe(true);
  await page.waitForTimeout(1000);

  // Jetonun süresini yaklaştır ve supabase-js'in yenilemesini tetikle
  // (sekme görünür olunca kilit içinde _recoverAndRefresh çalışır).
  await page.evaluate((k) => {
    const s = JSON.parse(localStorage.getItem(k)!);
    s.expires_at = Math.floor(Date.now() / 1000) + 20;
    localStorage.setItem(k, JSON.stringify(s));
    // bubbles: supabase-js dinleyicisi window'da; kabarcıklanmayan olay oraya ulaşmaz.
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  }, STORE);
  await expect.poll(() => calls.filter((c) => c.url.includes('grant_type=refresh_token')).length, { timeout: 10_000 }).toBeGreaterThan(0);

  expect(await lockReleasedWithin(page, 3000), 'oturum kilidi kalıcı tutuluyor (kilitlenme)').toBe(true);

  // Oturum isteyen bir işlem gerçekten tamamlanabiliyor mu?
  const ok = await page.evaluate(async (k) => {
    const s = JSON.parse(localStorage.getItem(k)!);
    return !!s.access_token;
  }, STORE);
  expect(ok).toBe(true);
});

test('yeni şifre kaydedildikten sonra (USER_UPDATED) oturum kilidi bırakılır', async ({ page }) => {
  await mock(page);
  await page.goto(`/#access_token=${jwt('real-1')}&expires_at=${now() + 3600}&expires_in=3600&refresh_token=rec-1&token_type=bearer&type=recovery`);
  await expect(page.getByText('Yeni Sifre Belirleyin')).toBeVisible();
  await page.waitForTimeout(1000);
  await page.getByPlaceholder('YENI SIFRE (min. 10 karakter)').fill('yeni-sifre-12345');
  await page.getByPlaceholder('YENI SIFRE (tekrar)').fill('yeni-sifre-12345');
  await page.getByRole('button', { name: 'Sifreyi Kaydet' }).click();
  await expect(page.getByText('Yeni Sifre Belirleyin')).toBeHidden();
  expect(await lockReleasedWithin(page, 3000), 'oturum kilidi kalıcı tutuluyor (kilitlenme)').toBe(true);
});

test('pencere tekrar görünür olunca (SIGNED_IN) kimlik yeniden bağlanmaz, günlük silinmez', async ({ page }) => {
  const calls = await mock(page);
  await page.goto('/');
  const binds = () => calls.filter((c) => c.path.startsWith('/rest/v1/rpc/arku_ensure_connection_id')).length;
  await expect.poll(binds).toBeGreaterThan(0);
  await page.waitForTimeout(1500);
  const before = binds();
  const logBefore = await page.evaluate(() => document.body.innerText.includes('Misafir olarak devam ediliyor.'));
  // Electron'da küçültülmüş pencereyi açmak ya da sekmeye dönmek budur:
  // supabase-js oturumu yeniden okur ve SIGNED_IN yayınlar.
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(1000);
  expect(binds(), 'kimlik RPC her görünürlükte yeniden çalıştı').toBe(before);
  expect(logBefore).toBe(true);
  expect(await lockReleasedWithin(page, 3000)).toBe(true);
});
