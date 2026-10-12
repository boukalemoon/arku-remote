// Bağımsız denetçi ajanın yazdığı ek giriş testleri (2026-10-11). Ağa çıkılmaz.
import { test, expect, type Page, type Route } from '@playwright/test';
const SUPABASE = /https:\/\/[a-z0-9]+\.supabase\.co\/.*/;
const jwt = (sub: string, extra: object = {}) => `a.${Buffer.from(JSON.stringify({ sub, role: 'authenticated', exp: 4102444800, ...extra })).toString('base64url')}.s`;
type Opts = { userStatus?: number; tokenDelay?: number; tokenOk?: boolean };
async function mock(page: Page, o: Opts = {}) {
  const calls: { method: string; path: string; body: any; url: string; auth: string }[] = [];
  let anonN = 0;
  await page.route(SUPABASE, async (route: Route) => {
    const req = route.request(); const url = new URL(req.url());
    let body: any = null; try { body = req.postDataJSON(); } catch {}
    calls.push({ method: req.method(), path: url.pathname, body, url: req.url(), auth: req.headers()['authorization'] || '' });
    const json = (s: number, d: unknown) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(d) });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 200 });
    if (url.pathname === '/auth/v1/signup' && body?.email) return json(200, { id: 'u-1', email: body.email, aud: 'authenticated', identities: [{}] });
    if (url.pathname === '/auth/v1/signup') { anonN++; const user = { id: `anon-${anonN}`, aud: 'authenticated', role: 'authenticated', is_anonymous: true };
      return json(200, { access_token: jwt(user.id, { is_anonymous: true }), token_type: 'bearer', expires_in: 3600, expires_at: 4102444800, refresh_token: 'r', user }); }
    if (url.pathname === '/auth/v1/user' && req.method() === 'GET') {
      if (o.userStatus && o.userStatus !== 200) return json(o.userStatus, { code: o.userStatus, msg: 'invalid JWT' });
      const a = req.headers()['authorization'] || '';
      const anon = a.includes(Buffer.from('"is_anonymous":true').toString('base64url').slice(0,5)) && a.includes('anon-');
      return json(200, { id: 'real-1', email: 'real@example.com', aud: 'authenticated', role: 'authenticated', email_confirmed_at: '2026-10-11T00:00:00Z', is_anonymous: false });
    }
    if (url.pathname === '/auth/v1/user' && req.method() === 'PUT') return json(200, { id: 'real-1', email: 'real@example.com', aud: 'authenticated' });
    if (url.pathname === '/auth/v1/token') {
      if (o.tokenDelay) await new Promise(r => setTimeout(r, o.tokenDelay));
      return json(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
    }
    if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204 });
    if (url.pathname === '/auth/v1/resend' || url.pathname === '/auth/v1/recover') return json(200, {});
    if (url.pathname.startsWith('/rest/v1/rpc/')) return json(200, null);
    if (url.pathname.startsWith('/rest/v1/')) return json(200, []);
    if (url.pathname.startsWith('/functions/v1/')) return json(200, { iceServers: [] });
    return json(200, {});
  });
  await page.routeWebSocket(/supabase\.co/, ws => { ws.close(); });
  return calls;
}
const now = () => Math.floor(Date.now() / 1000);
const recHash = (type: string) => `#access_token=${jwt('real-1')}&expires_at=${now()+3600}&expires_in=3600&refresh_token=rt&token_type=bearer&type=${type}`;
const storedSession = (page: Page) => page.evaluate(() => { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i)!; if (k.includes('auth-token')) return JSON.parse(localStorage.getItem(k)!); } return null; });

test('R1 recovery: session from URL kept, updateUser sent with recovery token, no anon override', async ({ page }) => {
  const calls = await mock(page);
  await page.goto('/' + recHash('recovery'));
  await expect(page.getByText('Yeni Sifre Belirleyin')).toBeVisible();
  await page.waitForTimeout(1500);
  const s = await storedSession(page);
  expect(s?.user?.id).toBe('real-1');
  expect(calls.filter(c => c.path === '/auth/v1/signup' && !c.body?.email).length, 'anon sign-in over recovery session').toBe(0);
  await page.getByPlaceholder('YENI SIFRE (min. 10 karakter)').fill('yeni-sifre-12345');
  await page.getByPlaceholder('YENI SIFRE (tekrar)').fill('yeni-sifre-12345');
  await page.getByRole('button', { name: 'Sifreyi Kaydet' }).click();
  await expect(page.getByText('Yeni Sifre Belirleyin')).toBeHidden();
  const put = calls.find(c => c.path === '/auth/v1/user' && c.method === 'PUT');
  expect(put?.body?.password).toBe('yeni-sifre-12345');
  expect(put?.auth).toContain(jwt('real-1').split('.')[1]);
  expect(calls.some(c => c.path === '/auth/v1/logout')).toBe(false);
});

test('R2 signup return: session established in browser, URL cleaned, notice shown', async ({ page }) => {
  const calls = await mock(page);
  await page.goto('/' + recHash('signup'));
  await expect(page.getByText(/E-posta adresiniz dogrulandi/)).toBeVisible();
  await page.waitForTimeout(1500);
  expect((await storedSession(page))?.user?.id).toBe('real-1');
  expect(calls.filter(c => c.path === '/auth/v1/signup' && !c.body?.email).length).toBe(0);
  expect(page.url()).not.toContain('access_token');
});

test('R3 geçersiz sıfırlama bağlantısı: anonim oturumla şifre değiştirilmez, kullanıcı uyarılır', async ({ page }) => {
  const calls = await mock(page, { userStatus: 401 });
  await page.goto('/' + recHash('recovery'));
  await expect(page.getByText('Yeni Sifre Belirleyin')).toBeVisible();
  await page.waitForTimeout(2500);
  await page.getByPlaceholder('YENI SIFRE (min. 10 karakter)').fill('yeni-sifre-12345');
  await page.getByPlaceholder('YENI SIFRE (tekrar)').fill('yeni-sifre-12345');
  await page.getByRole('button', { name: 'Sifreyi Kaydet' }).click();
  await expect(page.getByText(/Sifirlama baglantisi gecersiz/)).toBeVisible();
  expect(calls.filter(c => c.path === '/auth/v1/user' && c.method === 'PUT').length).toBe(0);
});

test('R4 Electron: redirect_to is the public web app for signup AND resend', async ({ page }) => {
  await page.addInitScript(() => { (window as any).electronAPI = { isElectron: true }; });
  const calls = await mock(page);
  await page.goto('/');
  await page.getByRole('button', { name: /Giris Yap/i }).first().click();
  await page.getByRole('button', { name: /^Kayit Ol$/i }).click();
  await page.getByPlaceholder('AD SOYAD').fill('T');
  await page.getByPlaceholder('E-POSTA').fill('e@example.com');
  await page.getByPlaceholder(/SIFRE/).fill('cok-guclu-sifre-123');
  await page.getByRole('button', { name: /^Kayit Ol$/ }).click();
  await expect(page.getByText('E-postanizi Dogrulayin')).toBeVisible();
  await page.getByRole('button', { name: /yeniden gonder/i }).click();
  await expect(page.getByText(/Yeni dogrulama e-postasi/)).toBeVisible();
  const su = calls.find(c => c.path === '/auth/v1/signup' && c.body?.email)!;
  const rs = calls.find(c => c.path === '/auth/v1/resend')!;
  expect(new URL(su.url).searchParams.get('redirect_to')).toBe('https://arku-remote.vercel.app/');
  expect(new URL(rs.url).searchParams.get('redirect_to')).toBe('https://arku-remote.vercel.app/');
});

test('R5 login double click sends one token request', async ({ page }) => {
  const calls = await mock(page, { tokenDelay: 800 });
  await page.goto('/');
  await page.getByRole('button', { name: /Giris Yap/i }).first().click();
  await page.getByPlaceholder('E-POSTA').fill('a@example.com');
  await page.getByPlaceholder('SIFRE').fill('cok-guclu-sifre-123');
  await page.getByRole('button', { name: 'Devam Et', exact: true }).dblclick();
  await page.getByPlaceholder('SIFRE').press('Enter');
  await expect(page.getByText('E-posta veya sifre hatali.')).toBeVisible();
  expect(calls.filter(c => c.path === '/auth/v1/token').length).toBe(1);
});

test('R6 şifre sıfırlama çift tıklama tek istek gönderir', async ({ page }) => {
  await mock(page);
  await page.route(/\/auth\/v1\/recover/, async r => { await new Promise(x => setTimeout(x, 500)); await r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); });
  await page.goto('/');
  await page.getByRole('button', { name: /Giris Yap/i }).first().click();
  await page.getByRole('button', { name: /Sifremi Unuttum/ }).click();
  await page.getByPlaceholder('E-POSTA ADRESINIZ').fill('reset@example.com');
  let n = 0; page.on('request', r => { if (r.url().includes('/auth/v1/recover') && r.method() === 'POST') n++; });
  await page.getByRole('button', { name: /Sifirlama Baglantisi Gonder/ }).dblclick();
  await expect(page.getByText(/E-posta gonderildi/)).toBeVisible();
  expect(n).toBe(1);
});
