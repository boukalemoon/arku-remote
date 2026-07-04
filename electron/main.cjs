const { app, BrowserWindow, session, desktopCapturer, shell, ipcMain, screen, dialog } = require('electron');
const path = require('path');

// ── Otomatik güncelleme ──────────────────────────────────────────────────────
// Windows (NSIS) ve Linux (AppImage): electron-updater ile indirilir, kullanıcı
// onayıyla kurulur. macOS imzasız uygulamada ve .deb kurulumlarında otomatik
// kurulum desteklenmediği için yalnızca yeni sürüm bildirimi gösterilir.
const UPDATE_CHECK_INTERVAL = 4 * 60 * 60 * 1000; // 4 saat
const RELEASES_LATEST_URL = 'https://github.com/boukalemoon/arku-remote/releases/latest';
let updateNotified = false; // bildirim tabanlı yolda oturum başına tek uyarı

function canAutoInstallUpdates() {
  if (process.platform === 'win32') return true;
  if (process.platform === 'linux') return !!process.env.APPIMAGE; // .deb hariç
  return false; // macOS: imza olmadan Squirrel.Mac güncellemesi çalışmaz
}

async function checkLatestAndNotify() {
  if (updateNotified) return;
  try {
    const res = await fetch('https://api.github.com/repos/boukalemoon/arku-remote/releases/latest');
    if (!res.ok) return;
    const rel = await res.json();
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    const current = app.getVersion();
    if (!latest || latest.localeCompare(current, undefined, { numeric: true }) <= 0) return;
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
    if (response === 0) shell.openExternal(RELEASES_LATEST_URL);
  } catch { /* çevrimdışı vb. — sessiz geç */ }
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
  autoUpdater.on('error', () => { /* ağ hatası vb. — bir sonraki kontrolde tekrar denenir */ });

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

// Remote input injection — receiver side
// Koordinatlar 0-1 normalize. robotjs veya @nut-tree/nut-js kurulumu ile aktif hale gelir.
ipcMain.on('input-event', (_e, event) => {
  let robot;
  try { robot = require('robotjs'); } catch { return; } // robotjs kurulu değilse yoksay

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  if (event.type === 'mousemove') {
    robot.moveMouse(Math.round(event.x * width), Math.round(event.y * height));
  } else if (event.type === 'mousedown' || event.type === 'mouseup') {
    const btn = event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left';
    robot.moveMouse(Math.round(event.x * width), Math.round(event.y * height));
    robot.mouseToggle(event.type === 'mousedown' ? 'down' : 'up', btn);
  } else if (event.type === 'wheel') {
    robot.scrollMouse(Math.round(event.dx / 100), Math.round(event.dy / 100));
  } else if (event.type === 'keydown') {
    try { robot.keyToggle(event.key.toLowerCase(), 'down'); } catch {}
  } else if (event.type === 'keyup') {
    try { robot.keyToggle(event.key.toLowerCase(), 'up'); } catch {}
  }
});