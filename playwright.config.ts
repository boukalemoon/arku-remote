import { defineConfig } from '@playwright/test';

// Kullanıcı girişi uçtan uca testleri. Derlenmiş uygulamayı (dist/) yerel bir
// sunucuda açar; Supabase istekleri testlerde taklit edilir, ağa çıkılmaz.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
    // CI'da `npx playwright install chromium` ile kurulan tarayıcı kullanılır.
    // Önceden kurulu bir Chromium varsa (yerel/sandbox) yolu buradan verilir.
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  webServer: {
    command: 'npx vite preview --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
