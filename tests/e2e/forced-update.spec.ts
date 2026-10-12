// Zorunlu güncelleme kapısı (2026-10-12). Sunucudaki app_config.min_desktop_version
// kurulu sürümün üstündeyse masaüstü uygulaması engelleme ekranı gösterir.
// Masaüstü köprüsü ve Supabase taklit edilir; ağa çıkılmaz.
import { test, expect, type Page } from '@playwright/test';

type MinVersion = string | { status: number };

async function mockSupabase(page: Page, minVersion: MinVersion) {
  await page.route(/https:\/\/[a-z0-9]+\.supabase\.co\/.*/, (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 200 });
    const p = new URL(req.url()).pathname;
    if (p === '/rest/v1/app_config') {
      (page as any).__appConfigHits = ((page as any).__appConfigHits ?? 0) + 1;
      if (typeof minVersion !== 'string') return route.fulfill({ status: minVersion.status, contentType: 'application/json', body: '{"message":"x"}' });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ value: minVersion }) });
    }
    const body = p === '/auth/v1/signup'
      ? { access_token: 'a.eyJzdWIiOiJhbm9uLTEiLCJyb2xlIjoiYXV0aGVudGljYXRlZCIsImV4cCI6NDEwMjQ0NDgwMH0.s', token_type: 'bearer', expires_in: 3600, expires_at: 4102444800, refresh_token: 'r', user: { id: 'anon-1', aud: 'authenticated', role: 'authenticated', is_anonymous: true } }
      : p === '/rest/v1/rpc/arku_ensure_connection_id' ? '123-456-789'
      : p.startsWith('/rest/v1/rpc/') ? null : p.startsWith('/rest/v1/') ? [] : {};
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.routeWebSocket(/supabase\.co/, (ws) => { ws.close(); });
}

async function fakeDesktop(page: Page, mode: 'auto' | 'manual' | 'none' = 'auto') {
  await page.addInitScript((m) => {
    const w = window as any;
    w.__installCalls = 0;
    w.__progressCbs = [];
    w.electronAPI = {
      isElectron: true,
      getAutoStart: async () => ({ supported: false, enabled: false, minimized: false }),
      setAutoStart: async () => ({}),
      installUpdateNow: async () => { w.__installCalls++; return { mode: m }; },
      onUpdateProgress: (cb: (p: unknown) => void) => { w.__progressCbs.push(cb); return () => {}; },
    };
    w.__emitProgress = (p: unknown) => { for (const cb of w.__progressCbs) cb(p); };
  }, mode);
}

const gate = (page: Page) => page.getByTestId('forced-update');

test('masaüstü, en düşük sürümün altındaysa engelleme ekranı çıkar ve güncelleme başlar', async ({ page }) => {
  await fakeDesktop(page, 'auto');
  await mockSupabase(page, '9.9.9');
  await page.goto('/');
  await expect(gate(page)).toBeVisible();
  await expect(gate(page)).toContainText('Guncelleme gerekli');
  await expect(gate(page)).toContainText('v9.9.9');

  await gate(page).getByRole('button', { name: 'Guncellemeyi indir ve kur' }).click();
  expect(await page.evaluate(() => (window as any).__installCalls)).toBe(1);
  await expect(page.getByTestId('forced-update-progress')).toBeVisible();

  await page.evaluate(() => (window as any).__emitProgress({ state: 'downloading', percent: 42 }));
  await expect(gate(page)).toContainText('Indiriliyor %42');
  await page.evaluate(() => (window as any).__emitProgress({ state: 'installing' }));
  await expect(gate(page)).toContainText('Kuruluyor');
});

test('kendini güncelleyemeyen kurulumda indirme sayfası yönlendirmesi gösterilir', async ({ page }) => {
  await fakeDesktop(page, 'manual');
  await mockSupabase(page, '9.9.9');
  await page.goto('/');
  await gate(page).getByRole('button', { name: 'Guncellemeyi indir ve kur' }).click();
  await expect(page.getByTestId('forced-update-note')).toContainText('Indirme sayfasi tarayicida acildi');
  await expect(gate(page).getByRole('button', { name: 'Tekrar dene' })).toBeVisible();
});

test('sürüm eşit ya da yeniyse ekran çıkmaz', async ({ page }) => {
  await fakeDesktop(page);
  await mockSupabase(page, '1.0.0');
  await page.goto('/');
  await expect.poll(() => (page as any).__appConfigHits ?? 0).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  await expect(gate(page)).toHaveCount(0);
});

test('sunucu okunamazsa (hata) kimse kilitlenmez', async ({ page }) => {
  await fakeDesktop(page);
  await mockSupabase(page, { status: 500 });
  await page.goto('/');
  await expect.poll(() => (page as any).__appConfigHits ?? 0).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  await expect(gate(page)).toHaveCount(0);
});

test('bozuk değer (ör. "1.7") kimseyi kilitlemez', async ({ page }) => {
  await fakeDesktop(page);
  await mockSupabase(page, '1.7');
  await page.goto('/');
  await expect.poll(() => (page as any).__appConfigHits ?? 0).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  await expect(gate(page)).toHaveCount(0);
});

test('web sürümü kapıyı hiç sorgulamaz', async ({ page }) => {
  await mockSupabase(page, '9.9.9');
  await page.goto('/');
  await page.waitForTimeout(1500);
  expect((page as any).__appConfigHits ?? 0).toBe(0);
  await expect(gate(page)).toHaveCount(0);
});
