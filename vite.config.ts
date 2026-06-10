import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'fs';
import path from 'path';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));

export default defineConfig({
  // Uygulama sürümü tek kaynaktan (package.json) gelir; UI'da elle sürüm yazma.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // Göreli asset yolları: Electron uygulamada index.html `file://` ile yüklenir;
  // mutlak '/assets/...' yolları dosya sisteminin köküne bakıp 404 verir (beyaz
  // ekran). './' göreli yolu hem web'de hem Electron'da çalışır.
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  server: {
    port: 3000,
    host: '0.0.0.0',
  },
});
