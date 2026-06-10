import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
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
