// Ayarlar > Başlangıç: "Bilgisayar açılınca otomatik başlat" (2026-10-11).
// Masaüstü köprüsü (window.electronAPI) testte taklit edilir; gerçek başlangıç
// kaydına dokunulmaz. Supabase istekleri taklit edilir, ağa çıkılmaz.
import { test, expect, type Page } from '@playwright/test';

async function mockSupabase(page: Page) {
  await page.route(/https:\/\/[a-z0-9]+\.supabase\.co\/.*/, (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 200 });
    const p = new URL(req.url()).pathname;
    const body = p === '/auth/v1/signup'
      ? { access_token: 'a.eyJzdWIiOiJhbm9uLTEiLCJyb2xlIjoiYXV0aGVudGljYXRlZCIsImV4cCI6NDEwMjQ0NDgwMH0.s', token_type: 'bearer', expires_in: 3600, expires_at: 4102444800, refresh_token: 'r', user: { id: 'anon-1', aud: 'authenticated', role: 'authenticated', is_anonymous: true } }
      : p.startsWith('/rest/v1/rpc/') ? null : p.startsWith('/rest/v1/') ? [] : {};
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.routeWebSocket(/supabase\.co/, (ws) => { ws.close(); });
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: /^Ayarlar$/i }).first().click();
  await expect(page.getByText('Uygulama Ayarlari')).toBeVisible();
}

test('web sürümünde Başlangıç bölümü görünmez', async ({ page }) => {
  await mockSupabase(page);
  await page.goto('/');
  await openSettings(page);
  await expect(page.getByText('Bilgisayar acilinca otomatik baslat')).toHaveCount(0);
});

test('masaüstünde açılır/kapanır; küçültülmüş seçeneği yalnızca açıkken etkin', async ({ page }) => {
  await page.addInitScript(() => {
    const st = { supported: true, enabled: false, minimized: false };
    (window as any).__autoCalls = [];
    (window as any).electronAPI = {
      isElectron: true,
      getAutoStart: async () => ({ ...st }),
      setAutoStart: async (o: any) => { (window as any).__autoCalls.push(o); st.enabled = !!o.enabled; st.minimized = !!o.minimized; return { ...st }; },
    };
  });
  await mockSupabase(page);
  await page.goto('/');
  await openSettings(page);

  const main = page.getByLabel('Bilgisayar acilinca otomatik baslat');
  const mini = page.getByLabel('Kucultulmus baslat');
  await expect(main).not.toBeChecked();
  await expect(mini).toBeDisabled();

  await main.check();
  await expect(main).toBeChecked();
  await expect(mini).toBeEnabled();
  await mini.check();
  await expect(mini).toBeChecked();
  await main.uncheck();
  await expect(main).not.toBeChecked();

  const calls = await page.evaluate(() => (window as any).__autoCalls);
  expect(calls).toEqual([
    { enabled: true, minimized: false },
    { enabled: true, minimized: true },
    { enabled: false, minimized: true },
  ]);
});

test('desteklenmeyen masaüstünde (Linux/geliştirme) bölüm görünmez', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).electronAPI = { isElectron: true, getAutoStart: async () => ({ supported: false, enabled: false, minimized: false }), setAutoStart: async () => ({}) };
  });
  await mockSupabase(page);
  await page.goto('/');
  await openSettings(page);
  await expect(page.getByText('Bilgisayar acilinca otomatik baslat')).toHaveCount(0);
});
