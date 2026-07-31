const { app, BrowserWindow, session, desktopCapturer, shell, ipcMain, screen, dialog } = require('electron');
const path = require('path');

// ── Otomatik güncelleme ──────────────────────────────────────────────────────
// Windows (NSIS) ve Linux (AppImage): electron-updater ile indirilir, kullanıcı
// onayıyla kurulur. macOS imzasız uygulamada ve .deb kurulumlarında otomatik
// kurulum desteklenmediği için yalnızca yeni sürüm bildirimi gösterilir.
const UPDATE_CHECK_INTERVAL = 4 * 60 * 60 * 1000; // 4 saat
const GITHUB_REPO = 'boukalemoon/arku-remote';
const RELEASES_LATEST_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;
// İndirmeler web sitesi üzerinden yürür (indirme analitiği CRM'e bağlanacak).
// Boş bırakılırsa GitHub releases sayfası açılır.
const WEBSITE_DOWNLOAD_URL = 'https://www.arku.com.tr/#indir';
const downloadPageUrl = () => WEBSITE_DOWNLOAD_URL || RELEASES_LATEST_URL;
let updateNotified = false; // bildirim tabanlı yolda oturum başına tek uyarı

function canAutoInstallUpdates() {
  if (process.platform === 'win32') return true;
  if (process.platform === 'linux') return !!process.env.APPIMAGE; // .deb hariç
  return false; // macOS: imza olmadan Squirrel.Mac güncellemesi çalışmaz
}

// Yeni sürüm varsa kullanıcıya bildirir. `force` elle kontrolde oturum başına
// tek uyarı sınırını atlar. Dönüş: yeni sürüm bulundu mu?
async function checkLatestAndNotify(force = false) {
  if (updateNotified && !force) return false;
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
    if (!res.ok) return false;
    const rel = await res.json();
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    const current = app.getVersion();
    if (!latest || latest.localeCompare(current, undefined, { numeric: true }) <= 0) return false;
    updateNotified = true;
    const win = BrowserWindow.getAllWindows()[0];
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Yeni sürüm mevcut',
      message: `Arku Remote v${latest} yayınlandı (kurulu sürüm: v${current}).`,
      detail: 'Bu kurulum türünde otomatik güncelleme desteklenmiyor. Yeni sürümü indirip mevcut kurulumun üzerine kurmanız yeterli.',
      buttons: ['İndirme Sayfasını Aç', 'Daha Sonra'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) shell.openExternal(downloadPageUrl());
    return true;
  } catch { return false; /* çevrimdışı vb. — sessiz geç */ }
}

function setupUpdates() {
  if (!app.isPackaged) return; // geliştirmede güncelleme kontrolü yapma

  if (!canAutoInstallUpdates()) {
    checkLatestAndNotify();
    setInterval(checkLatestAndNotify, UPDATE_CHECK_INTERVAL);
    return;
  }

  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch { return; }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // kullanıcı "Daha Sonra" derse çıkışta kurulur

  autoUpdater.on('update-downloaded', async (info) => {
    const win = BrowserWindow.getAllWindows()[0];
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Güncelleme hazır',
      message: `Arku Remote v${info.version} indirildi.`,
      detail: 'Şimdi yeniden başlatarak güncelleyebilirsiniz; ertelerseniz uygulama kapanırken otomatik kurulur.',
      buttons: ['Şimdi Yeniden Başlat', 'Daha Sonra'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  // Eskiden hatalar tamamen yutuluyordu: autoUpdater yapılandırması bozuksa
  // (örn. app-update.yml eksik) kullanıcı NE güncelleme NE de uyarı görüyordu.
  // Artık bildirim yoluna düşülüyor, böylece elle güncelleyebilir.
  autoUpdater.on('error', () => { checkLatestAndNotify(); });

  const check = () => { autoUpdater.checkForUpdates().catch(() => {}); };
  check();
  setInterval(check, UPDATE_CHECK_INTERVAL);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
    icon: path.join(__dirname, '../dist/icons/icon.ico'),
    title: 'Arku Remote',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform !== 'darwin' && {
      titleBarOverlay: {
        color: '#111010',
        symbolColor: '#c5a059',
        height: 40
      }
    })
  });

  // Ekran paylaşımı için izin ver
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
      callback({ video: sources[0], audio: 'loopback' });
    });
  });

  // Dış linkleri tarayıcıda aç — sadece http/https protokollerine izin ver
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // QRtım SSO dönüşü: pencere QRtım girişine gider, QRtım web callback'e
  // (?qrtim_token=...) yönlendirir. Web uygulamasını yüklemek yerine token'ı
  // yakalayıp yerel index.html'i token ile yeniden yükle — SSO yerelde tamamlanır.
  const interceptQrtimReturn = (event, url) => {
    try {
      const u = new URL(url);
      const token = u.searchParams.get('qrtim_token');
      if (token && u.origin === 'https://arku-remote.vercel.app') {
        event.preventDefault();
        win.loadFile(path.join(__dirname, '../dist/index.html'), { query: { qrtim_token: token } });
      }
    } catch { /* geçersiz URL — yok say */ }
  };
  win.webContents.on('will-navigate', interceptQrtimReturn);
  win.webContents.on('will-redirect', interceptQrtimReturn);

  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
if (isDev) {
  win.loadURL('http://localhost:3000');
  win.webContents.openDevTools({ mode: 'detach' });
} else {
  win.loadFile(path.join(__dirname, '../dist/index.html'));
}

  win.setMenuBarVisibility(false);

  // Ctrl+N (mac: Cmd+N) -> yeni bağımsız oturum penceresi.
  // Her pencere kendi WebRTC oturumunu yönetir; aynı hesapla birden fazla
  // müşteriye eşzamanlı bağlanmayı sağlar.
  win.webContents.on('before-input-event', (_event, input) => {
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    if (mod && !input.shift && !input.alt && input.type === 'keyDown' && input.key.toLowerCase() === 'n') {
      createWindow();
    }
  });

  // Pencere hazır olduğunda göster
  win.once('ready-to-show', () => {
    win.show();
  });
}

// Renderer'daki "Yeni Oturum" butonu
ipcMain.on('new-window', () => createWindow());

// Ayarlar'daki "Güncellemeleri Kontrol Et" butonu. Otomatik kontrol açılışta ve
// 4 saatte bir çalışır; bu, kullanıcının beklemeden kontrol etmesini sağlar.
ipcMain.handle('check-for-updates', async () => {
  const current = app.getVersion();
  if (!app.isPackaged) return { status: 'dev', version: current };

  if (canAutoInstallUpdates()) {
    try {
      const { autoUpdater } = require('electron-updater');
      const result = await autoUpdater.checkForUpdates();
      const latest = result?.updateInfo?.version;
      if (latest && latest.localeCompare(current, undefined, { numeric: true }) > 0) {
        return { status: 'available', version: latest };
      }
      return { status: 'current', version: current };
    } catch (err) {
      // autoUpdater kullanılamıyorsa (yapılandırma/ağ) GitHub API'sine düş.
      const found = await checkLatestAndNotify(true);
      if (found) return { status: 'available' };
      return { status: 'error', message: String((err && err.message) || err) };
    }
  }

  const found = await checkLatestAndNotify(true);
  return found ? { status: 'available' } : { status: 'current', version: current };
});

app.whenReady().then(() => {
  createWindow();
  setupUpdates();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── Uzaktan girdi enjeksiyonu (alıcı taraf) ──────────────────────────────────
// OS düzeyinde fare/klavye enjeksiyonu @nut-tree-fork/nut-js ile yapılır.
// Bu bir NATIVE modüldür:
//   * asar dışına çıkarılmalı (package.json build.asarUnpack — ayarlandı),
//   * Electron ABI'sine göre yeniden derlenmeli (`npm run rebuild:native`).
// Kurulu/derlenmemişse require başarısız olur ve kontrol sessizce devre dışı
// kalır (uygulama yine açılır, yalnızca görüntüleme çalışır).
let nut = null;
let nutTried = false;
function loadNut() {
  if (nutTried) return nut;
  nutTried = true;
  try {
    const mod = require('@nut-tree-fork/nut-js');
    mod.mouse.config.autoDelayMs = 0;
    mod.keyboard.config.autoDelayMs = 0;
    nut = mod;
  } catch { nut = null; }
  return nut;
}

// Tarayıcı KeyboardEvent.code -> nut-js Key üye adı. `code` fiziksel tuştur,
// klavye düzeninden bağımsızdır; bu yüzden `key` yerine tercih edilir.
const NUT_KEY_BY_CODE = {
  Space: 'Space', Enter: 'Return', NumpadEnter: 'Enter', Tab: 'Tab', Escape: 'Escape',
  Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
  ShiftLeft: 'LeftShift', ShiftRight: 'RightShift',
  ControlLeft: 'LeftControl', ControlRight: 'RightControl',
  AltLeft: 'LeftAlt', AltRight: 'RightAlt',
  MetaLeft: 'LeftSuper', MetaRight: 'RightSuper',
  CapsLock: 'CapsLock', Minus: 'Minus', Equal: 'Equal', Backquote: 'Grave',
  BracketLeft: 'LeftBracket', BracketRight: 'RightBracket', Backslash: 'Backslash',
  Semicolon: 'Semicolon', Quote: 'Quote', Comma: 'Comma', Period: 'Period', Slash: 'Slash',
};

function resolveKey(K, code) {
  if (!code || typeof code !== 'string') return null;
  if (/^Key[A-Z]$/.test(code)) return K[code.slice(3)];               // KeyA -> A
  if (/^Digit[0-9]$/.test(code)) return K['Num' + code.slice(5)];     // Digit1 -> Num1
  if (/^Numpad[0-9]$/.test(code)) return K['NumPad' + code.slice(6)]; // Numpad1 -> NumPad1
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return K[code];          // F1..F24
  const name = NUT_KEY_BY_CODE[code];
  return name ? K[name] : null;
}

const clamp01 = (n) => (typeof n === 'number' && isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

async function applyInput(mod, event) {
  const { Point, Button, Key, mouse, keyboard } = mod;
  const { width, height } = screen.getPrimaryDisplay().size;
  const px = Math.round(clamp01(event.x) * width);
  const py = Math.round(clamp01(event.y) * height);
  const toBtn = (b) => (b === 2 ? Button.RIGHT : b === 1 ? Button.MIDDLE : Button.LEFT);

  switch (event.type) {
    case 'mousemove':
      await mouse.setPosition(new Point(px, py));
      break;
    case 'mousedown':
      await mouse.setPosition(new Point(px, py));
      await mouse.pressButton(toBtn(event.button));
      break;
    case 'mouseup':
      await mouse.setPosition(new Point(px, py));
      await mouse.releaseButton(toBtn(event.button));
      break;
    case 'wheel': {
      const dy = Math.round((event.dy || 0) / 100);
      const dx = Math.round((event.dx || 0) / 100);
      if (dy > 0) await mouse.scrollDown(dy); else if (dy < 0) await mouse.scrollUp(-dy);
      if (dx > 0) await mouse.scrollRight(dx); else if (dx < 0) await mouse.scrollLeft(-dx);
      break;
    }
    case 'keydown': {
      const k = resolveKey(Key, event.code);
      if (k !== null && k !== undefined) await keyboard.pressKey(k);
      break;
    }
    case 'keyup': {
      const k = resolveKey(Key, event.code);
      if (k !== null && k !== undefined) await keyboard.releaseKey(k);
      break;
    }
    default:
      break; // bilinmeyen olay türü — yok say
  }
}

// Olayları sırayla işle: mousedown/mouseup ve tuş bas/bırak sırası korunur.
let inputChain = Promise.resolve();
ipcMain.on('input-event', (_e, event) => {
  const mod = loadNut();
  if (!mod || !event || typeof event.type !== 'string') return;
  inputChain = inputChain.then(() => applyInput(mod, event)).catch(() => {});
});