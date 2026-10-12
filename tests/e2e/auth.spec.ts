// Kullanıcı girişi uçtan uca testleri (müşteri bildirimi 2026-10-11).
//
// Gerçek tarayıcıda (Chromium) derlenmiş uygulama açılır ve kullanıcı gibi
// tıklanır. Supabase'e giden TÜM istekler test içinde taklit edilir: ağa
// çıkılmaz, gerçek hesap açılmaz, e-posta gönderilmez.
//
// Çalıştırma: npm run build && npm run test:e2e
import { test, expect, type Page, type Route } from '@playwright/test';

const SUPABASE = /https:\/\/[a-z0-9]+\.supabase\.co\/.*/;

/** Supabase'i taklit eder ve auth isteklerinin gövdelerini kaydeder. */
async function mockSupabase(page: Page) {
  const calls: { path: string; body: any; url: string }[] = [];
  let anonN = 0;
  await page.route(SUPABASE, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    let body: any = null;
    try { body = req.postDataJSON(); } catch { /* gövdesiz */ }
    calls.push({ path: url.pathname, body, url: req.url() });
    const json = (status: number, data: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });

    if (req.method() === 'OPTIONS') return route.fulfill({ status: 200 });
    if (url.pathname === '/auth/v1/signup' && body?.email) {
      // Confirm email açık: oturum dönmez.
      return json(200, { id: 'u-1', email: body.email, aud: 'authenticated', confirmation_sent_at: new Date().toISOString(), identities: [{}] });
    }
    if (url.pathname === '/auth/v1/signup') {
      // anonim oturum
      anonN++;
      const user = { id: `anon-${anonN}`, aud: 'authenticated', role: 'authenticated', is_anonymous: true };
      return json(200, { access_token: `a.${Buffer.from(JSON.stringify({ sub: user.id, role: 'authenticated', exp: 4102444800 })).toString('base64url')}.s`, token_type: 'bearer', expires_in: 3600, expires_at: 4102444800, refresh_token: 'r', user });
    }
    if (url.pathname === '/auth/v1/token') {
      return json(400, { code: 400, error_code: 'email_not_confirmed', msg: 'Email not confirmed' });
    }
    if (url.pathname === '/auth/v1/resend') return json(200, {});
    if (url.pathname === '/auth/v1/recover') return json(200, {});
    if (url.pathname.startsWith('/rest/v1/rpc/')) return json(200, null);
    if (url.pathname.startsWith('/rest/v1/')) return json(200, []);
    if (url.pathname.startsWith('/functions/v1/')) return json(200, { iceServers: [], turn: false });
    return json(200, {});
  });
  // Realtime websocket'i kapat (bağlanamasın, test ağdan bağımsız kalsın).
  await page.routeWebSocket(/supabase\.co/, (ws) => { ws.close(); });
  return calls;
}

async function openRegister(page: Page) {
  // Arayüz hesap kayıt ekranına birkaç yoldan gidiyor; en kararlısı Giriş → Kayıt Ol.
  await page.getByRole('button', { name: /Giris Yap/i }).first().click();
  await page.getByRole('button', { name: /^Kayit Ol$/i }).click();
}

test('kayıt: doğrulama bağlantısı localhost yerine uygulamanın adresine döner', async ({ page, baseURL }) => {
  const calls = await mockSupabase(page);
  await page.goto('/');
  await openRegister(page);
  await page.getByPlaceholder('AD SOYAD').fill('Test Kullanici');
  await page.getByPlaceholder('E-POSTA').fill('test@example.com');
  await page.getByPlaceholder(/SIFRE/).fill('cok-guclu-sifre-123');
  await page.getByRole('button', { name: /^Kayit Ol$/ }).click();

  // Kullanıcıya ne yapacağı açıkça söylenmeli (eskiden pencere sessizce kapanıyordu).
  await expect(page.getByText('E-postanizi Dogrulayin')).toBeVisible();
  await expect(page.getByText('bir kez', { exact: true })).toBeVisible();

  const signup = calls.find((c) => c.path === '/auth/v1/signup' && c.body?.email);
  expect(signup, 'signup istegi gitmedi').toBeTruthy();
  // supabase-js dönüş adresini sorgu parametresi olarak gönderir.
  const redirect = new URL(signup!.url).searchParams.get('redirect_to');
  expect(redirect).toBe(`${baseURL}/`);
  expect(redirect).not.toContain('localhost:3000');
});

test('kayıt: çift tıklama ikinci isteği göndermez', async ({ page }) => {
  const calls = await mockSupabase(page);
  await page.goto('/');
  await openRegister(page);
  await page.getByPlaceholder('AD SOYAD').fill('Test Kullanici');
  await page.getByPlaceholder('E-POSTA').fill('cift@example.com');
  await page.getByPlaceholder(/SIFRE/).fill('cok-guclu-sifre-123');
  const btn = page.getByRole('button', { name: /^Kayit Ol$/ });
  await btn.dblclick();
  await expect(page.getByText('E-postanizi Dogrulayin')).toBeVisible();
  expect(calls.filter((c) => c.path === '/auth/v1/signup' && c.body?.email).length).toBe(1);
});

test('tükenmiş bağlantı (müşterinin ekranı): hata yerine açıklama ve yeniden gönder', async ({ page }) => {
  const calls = await mockSupabase(page);
  await page.goto('/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
  await expect(page.getByText(/zaten dogrulandi/)).toBeVisible();
  await page.getByPlaceholder('E-POSTA').fill('selim@example.com');
  await page.getByRole('button', { name: /yeniden gonder/i }).click();
  await expect(page.getByText(/Yeni dogrulama e-postasi/)).toBeVisible();
  const resend = calls.find((c) => c.path === '/auth/v1/resend');
  expect(resend?.body?.email).toBe('selim@example.com');
  // Adres çubuğu temizlenmeli (yenileyince hata tekrar çıkmasın).
  expect(page.url()).not.toContain('otp_expired');
});

test('doğrulanmamış hesapla giriş: Türkçe açıklama ve yeniden gönder seçeneği', async ({ page }) => {
  await mockSupabase(page);
  await page.goto('/');
  await page.getByRole('button', { name: /Giris Yap/i }).first().click();
  await page.getByPlaceholder('E-POSTA').fill('yeni@example.com');
  await page.getByPlaceholder('SIFRE').fill('cok-guclu-sifre-123');
  await page.getByRole('button', { name: 'Devam Et', exact: true }).click();
  await expect(page.getByText(/henuz dogrulanmamis/)).toBeVisible();
  await expect(page.getByRole('button', { name: /yeniden gonder/i })).toBeVisible();
});

test('şifre sıfırlama: bağlantı uygulamanın adresine döner', async ({ page, baseURL }) => {
  const calls = await mockSupabase(page);
  await page.goto('/');
  await page.getByRole('button', { name: /Giris Yap/i }).first().click();
  await page.getByRole('button', { name: /Sifremi Unuttum/ }).click();
  await page.getByPlaceholder('E-POSTA ADRESINIZ').fill('reset@example.com');
  await page.getByRole('button', { name: /Sifirlama Baglantisi Gonder/ }).click();
  await expect(page.getByText(/E-posta gonderildi/)).toBeVisible();
  const rec = calls.find((c) => c.path === '/auth/v1/recover');
  expect(new URL(rec!.url).searchParams.get('redirect_to')).toBe(`${baseURL}/`);
});

test('şifre sıfırlama dönüşü: yeni şifre ekranı açılır', async ({ page }) => {
  await mockSupabase(page);
  await page.goto('/#access_token=x.y.z&refresh_token=r&expires_in=3600&token_type=bearer&type=recovery');
  await expect(page.getByText('Yeni Sifre Belirleyin')).toBeVisible();
});
