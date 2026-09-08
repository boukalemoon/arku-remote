const {
  app, BrowserWindow, session, desktopCapturer, shell, ipcMain, screen, dialog,
  webContents, systemPreferences,
} = require('electron');
const path = require('path');

// Ana süreçte yakalanmamış bir hata, Electron'un "A JavaScript error occurred in
// the main process" penceresini açar ve uygulamayı kullanılamaz hâle getirir.
// Kök nedenler ayrıca düzeltiliyor; bu ağ yalnızca son çare — tek bir hatanın
// tüm uygulamayı düşürmesini engeller.
process.on('uncaughtException', (err) => {
  console.error('[arku] yakalanmamis ana surec hatasi:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[arku] islenmemis promise reddi:', err);
});

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

  // Uzaktan kontrol izni pencereye ve o sayfa yüklemesine bağlıdır: sayfa
  // yenilenir veya başka bir adrese gidilirse izin düşer, yeniden sorulur.
  // ÖNEMLİ: id'yi şimdi yakala. 'closed' tetiklendiğinde webContents çoktan yok
  // edilmiştir ve `win.webContents` okumak "Object has been destroyed" fırlatır —
  // v1.0.14'te ana süreci çökerten hata buydu.
  const wcId = win.webContents.id;
  const dropGrant = () => {
    controlGrants.delete(wcId);
    captureTargets.delete(wcId);
    // Basılı kalmış tuşları bırak — pencere kapanırken/gezinirken keyup gelmez.
    queueRelease(wcId);
  };
  win.webContents.on('did-start-navigation', dropGrant);
  win.on('closed', dropGrant);

  // Pencere hazır olduğunda göster
  win.once('ready-to-show', () => {
    win.show();
  });
}

// ── Ekran paylaşım kaynağı seçici ────────────────────────────────────────────
// Eskiden `sources[0]` (birincil ekranın tamamı) + `audio: 'loopback'` sorgusuz
// veriliyordu: kullanıcı NE paylaştığını seçemiyordu ve renderer `audio:false`
// istediği hâlde sistem sesi yine de yakalanıyordu. Artık her istek için yerel
// kullanıcıya seçici gösterilir ve ses yalnızca hem istenmişse hem de kullanıcı
// onaylamışsa eklenir.
const pickerState = new Map(); // picker webContents.id -> { sources, settle }

function finishPicker(senderId, result) {
  const state = pickerState.get(senderId);
  if (!state) return;
  pickerState.delete(senderId);
  state.settle(result);
  const win = BrowserWindow.fromId(state.windowId);
  if (win && !win.isDestroyed()) win.close();
}

ipcMain.handle('picker:init', (e) => {
  const state = pickerState.get(e.sender.id);
  if (!state) return { sources: [], audioRequested: false };
  return {
    audioRequested: state.audioRequested,
    sources: state.sources.map((s) => ({
      id: s.id,
      name: s.name,
      isScreen: s.id.startsWith('screen:'),
      thumbnail: s.thumbnail.toDataURL(),
    })),
  };
});

ipcMain.on('picker:choose', (e, payload) => {
  const state = pickerState.get(e.sender.id);
  if (!state) return;
  const source = state.sources.find((s) => s.id === payload?.id) || null;
  finishPicker(e.sender.id, source ? { source, withAudio: !!payload.withAudio } : null);
});

ipcMain.on('picker:cancel', (e) => finishPicker(e.sender.id, null));

function pickDisplaySource(parent, audioRequested) {
  return new Promise((resolve) => {
    desktopCapturer
      .getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } })
      .then((sources) => {
        if (!sources.length) { resolve(null); return; }

        const picker = new BrowserWindow({
          width: 820,
          height: 620,
          parent: parent && !parent.isDestroyed() ? parent : undefined,
          modal: !!(parent && !parent.isDestroyed()),
          resizable: true,
          minimizable: false,
          maximizable: false,
          title: 'Paylaşılacak ekranı seçin',
          backgroundColor: '#111010',
          autoHideMenuBar: true,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'picker-preload.cjs'),
          },
        });

        let settled = false;
        const settle = (value) => { if (!settled) { settled = true; resolve(value); } };

        // id'yi kapanmadan önce yakala (bkz. yukarıdaki dropGrant notu).
        const pickerWcId = picker.webContents.id;
        pickerState.set(pickerWcId, {
          sources, audioRequested, settle, windowId: picker.id,
        });

        // Pencere kapatılırsa (X, Esc, üst pencere kapanması) istek reddedilir.
        picker.on('closed', () => {
          pickerState.delete(pickerWcId);
          settle(null);
        });

        picker.loadFile(path.join(__dirname, 'picker.html'));
      })
      .catch(() => resolve(null));
  });
}

// ── Paylaşılan kaynağın hangi ekran olduğu ───────────────────────────────────
// Uzaktan gelen fare koordinatları 0..1 aralığında normalize edilmiştir; onları
// mutlak ekran konumuna çevirmek için HANGİ ekranın paylaşıldığını bilmek
// gerekir. Eskiden her zaman birincil ekran varsayılıyordu.
const captureTargets = new Map(); // paylaşan renderer webContents.id -> { kind, display }

/** getDisplayMedia isteğini yapan renderer'ı bulur. */
function requesterOf(request) {
  try {
    if (request && request.frame) {
      const wc = webContents.fromFrame(request.frame);
      if (wc) return wc;
    }
  } catch { /* eski Electron / kare yok — aşağıya düş */ }
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  return win && !win.isDestroyed() ? win.webContents : null;
}

/** Seçilen kaynağı bir Electron display'ine bağlar (pencere ise display yok). */
function rememberCaptureTarget(wcId, source) {
  const isScreen = String(source.id || '').startsWith('screen:');
  if (!isScreen) {
    // Pencere paylaşımında pencerenin ekran üzerindeki dikdörtgeni bilinemez,
    // dolayısıyla fare koordinatı güvenilir şekilde eşlenemez.
    captureTargets.set(wcId, { kind: 'window', display: null });
    return;
  }
  const displays = screen.getAllDisplays();
  const match = displays.find((d) => String(d.id) === String(source.display_id));
  captureTargets.set(wcId, { kind: 'screen', display: match || screen.getPrimaryDisplay() });
}

function setupDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      const requester = requesterOf(request);
      const parent = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      pickDisplaySource(parent, !!request.audioRequested).then((choice) => {
        // Seçim yapılmadıysa isteği reddet: boş nesne "kaynak yok" demektir.
        if (!choice) { callback({}); return; }
        if (requester && !requester.isDestroyed()) {
          rememberCaptureTarget(requester.id, choice.source);
        }
        callback({
          video: choice.source,
          ...(request.audioRequested && choice.withAudio ? { audio: 'loopback' } : {}),
        });
      });
    },
    // Kendi seçicimizi kullanıyoruz; platformlar arası davranış aynı olsun.
    { useSystemPicker: false },
  );
}

// ── Uzaktan kontrol yetkisi (ana süreç tarafı) ───────────────────────────────
// Eskiden `input-event` gelen her olayı işletiyordu; tek kapı renderer'daki bir
// bayraktı. Web içeriği ele geçirilirse bu bayrak atlanabilir ve işletim sistemi
// düzeyinde kontrol elde edilebilirdi. Artık izin, ana sürecin gösterdiği yerel
// bir onay penceresiyle veriliyor ve ana süreçte tutuluyor.
const controlGrants = new Set(); // izin verilmiş renderer webContents.id'leri

/**
 * Girdi enjeksiyonu bu makinede gerçekten çalışabilir mi?
 *
 * Eskiden nut-js yüklenemediğinde her şey SESSİZCE yutuluyordu: kullanıcı
 * "Kontrol İzni: AÇIK" görüyor, karşı taraf "Kontrol Aktif" görüyor ama hiçbir
 * şey olmuyordu. macOS'ta Erişilebilirlik izni hiç istenmediği için kontrol
 * orada hiç çalışmıyordu ve sebebi hiçbir yerde görünmüyordu.
 */
function remoteControlStatus() {
  const mod = loadNut();
  const status = {
    available: !!mod,
    error: nutError,
    platform: process.platform,
    accessibility: true, // yalnızca macOS'ta anlamlı
  };
  if (process.platform === 'darwin') {
    try { status.accessibility = systemPreferences.isTrustedAccessibilityClient(false); }
    catch { status.accessibility = true; }
  }
  return status;
}

ipcMain.handle('remote-control:status', () => remoteControlStatus());

ipcMain.handle('remote-control:request', async (e) => {
  const target = captureTargets.get(e.sender.id);
  // Pencere paylaşımında pencerenin ekran koordinatları bilinemez; fareyi
  // yanlış yere göndermektense kapatıp durumu açıkça bildiriyoruz.
  const pointer = !target || target.kind !== 'window';
  const win = BrowserWindow.fromWebContents(e.sender);

  if (controlGrants.has(e.sender.id)) return { granted: true, pointer };

  const status = remoteControlStatus();
  if (!status.available) {
    await dialog.showMessageBox(win, {
      type: 'error',
      title: 'Uzaktan kontrol kullanılamıyor',
      message: 'Girdi bileşeni bu kurulumda yüklenemedi.',
      detail: (status.error ? `Hata: ${status.error}\n\n` : '')
        + 'Ekran paylaşımı çalışmaya devam eder, yalnızca karşı tarafın '
        + 'klavye/fare kullanması mümkün olmaz. Uygulamayı yeniden kurmak '
        + 'genellikle bu sorunu çözer.',
      buttons: ['Tamam'],
      noLink: true,
    });
    return { granted: false, pointer: false, reason: 'unavailable', error: status.error };
  }

  if (process.platform === 'darwin' && !status.accessibility) {
    // Sistem iznini iste (macOS bir kez sorar, sonra Sistem Ayarları'na yönlendirir).
    try { systemPreferences.isTrustedAccessibilityClient(true); } catch { /* yok say */ }
    await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Erişilebilirlik izni gerekli',
      message: 'macOS, klavye ve fare kontrolü için Erişilebilirlik izni ister.',
      detail: 'Sistem Ayarları → Gizlilik ve Güvenlik → Erişilebilirlik altında '
        + 'Arku Remote\'u işaretleyin, sonra uygulamayı yeniden başlatıp tekrar deneyin.',
      buttons: ['Tamam'],
      noLink: true,
    });
    return { granted: false, pointer: false, reason: 'accessibility' };
  }

  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Uzaktan kontrole izin ver',
    message: 'Karşı tarafın bilgisayarınızı kontrol etmesine izin verilsin mi?',
    detail:
      'İzin verirseniz bağlandığınız kişi fareyi ve klavyeyi sizin adınıza kullanabilir. '
      + 'Yalnızca tanıdığınız ve güvendiğiniz kişilere izin verin. '
      + 'İzni istediğiniz an kapatabilirsiniz.'
      + (pointer ? '' : '\n\nNOT: Tek bir pencere paylaştığınız için yalnızca klavye '
        + 'iletilecek. Fare kontrolü için tüm ekranı paylaşmanız gerekir.'),
    buttons: ['İzin Ver', 'Vazgeç'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) return { granted: false, pointer: false, reason: 'denied' };
  controlGrants.add(e.sender.id);
  return { granted: true, pointer };
});

ipcMain.on('remote-control:revoke', (e) => {
  controlGrants.delete(e.sender.id);
  // İzin kapanırken basılı kalmış tuş/düğme bırakılmalı; aksi halde uzak
  // makinede Ctrl veya sol tuş sonsuza kadar basılı kalır.
  queueRelease(e.sender.id);
});

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
  // Oturum genelinde bir kez bağlanır (pencere başına değil).
  setupDisplayMediaHandler();
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
let nutError = null;
function loadNut() {
  if (nutTried) return nut;
  nutTried = true;
  try {
    const mod = require('@nut-tree-fork/nut-js');
    mod.mouse.config.autoDelayMs = 0;
    mod.keyboard.config.autoDelayMs = 0;
    nut = mod;
  } catch (err) {
    nut = null;
    // Hatayı sakla: arayüz "kontrol açık ama hiçbir şey olmuyor" yerine
    // gerçek sebebi gösterebilsin.
    nutError = String((err && err.message) || err);
    console.error('[arku] nut-js yuklenemedi:', nutError);
  }
  return nut;
}

// Tarayıcı KeyboardEvent.code -> nut-js Key üye adı. `code` fiziksel tuştur,
// klavye düzeninden bağımsızdır; bu yüzden `key` yerine tercih edilir.
// Adlar @nut-tree-fork/shared'daki Key enum'ıyla birebir doğrulanmıştır;
// var olmayan bir ad yazmak tuşu sessizce çalışmaz hâle getirir.
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
  // Sayısal tuş takımı operatörleri ve kilitler — eskiden hiç iletilmiyordu.
  NumpadDivide: 'Divide', NumpadMultiply: 'Multiply', NumpadSubtract: 'Subtract',
  NumpadAdd: 'Add', NumpadDecimal: 'Decimal', NumpadEqual: 'NumPadEqual',
  NumLock: 'NumLock', ScrollLock: 'ScrollLock', Pause: 'Pause',
  PrintScreen: 'Print', ContextMenu: 'Menu',
  // NOT: IntlBackslash (ISO klavyelerde sol Shift yanındaki < > tuşu) nut-js'te
  // karşılıksızdır. Backslash'e eşlemek YANLIŞ karakter yazar — eşlenmiyor.
};

// Olayları sırayla işle: mousedown/mouseup ve tuş bas/bırak sırası korunur.
// queueRelease() de bu zinciri kullandığı için bildirimi ondan ÖNCE duruyor.
let inputChain = Promise.resolve();

// Uzak tarafta basılı kalan tuş/düğmeleri izle. Kontrol izni kapandığında,
// pencere kapandığında veya bağlantı düştüğünde keyup hiç gelmez; bunlar
// bırakılmazsa uzak makinede Ctrl/Shift sonsuza kadar basılı kalır.
const heldKeys = new Map();    // wcId -> Set<Key>
const heldButtons = new Map(); // wcId -> Set<Button>

function trackHold(map, wcId, value, pressed) {
  let set = map.get(wcId);
  if (pressed) {
    if (!set) { set = new Set(); map.set(wcId, set); }
    set.add(value);
  } else if (set) {
    set.delete(value);
    if (set.size === 0) map.delete(wcId);
  }
}

/** Bir renderer adına basılı kalmış her şeyi bırak (sıraya alınarak). */
function queueRelease(wcId) {
  const keys = heldKeys.get(wcId);
  const buttons = heldButtons.get(wcId);
  heldKeys.delete(wcId);
  heldButtons.delete(wcId);
  if (!keys && !buttons) return;
  const mod = nut; // yalnızca zaten yüklüyse — burada yüklemeye çalışma
  if (!mod) return;
  inputChain = inputChain.then(async () => {
    for (const b of buttons || []) { try { await mod.mouse.releaseButton(b); } catch { /* yok say */ } }
    for (const k of keys || []) { try { await mod.keyboard.releaseKey(k); } catch { /* yok say */ } }
  }).catch(() => {});
}

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

/**
 * DIP (ölçeklenmiş) koordinatı fiziksel ekran pikseline çevirir.
 *
 * Windows'ta Electron'un display.bounds değeri DIP'tir; nut-js ise SetCursorPos
 * ile FİZİKSEL piksel kullanır. %150 ölçekli bir ekranda ikisini eşitlemek
 * tıklamaları hedefin üçte ikisine düşürür — ve %125/%150 Windows
 * dizüstülerinde fabrika ayarıdır. Karışık DPI'da `bounds.x * scaleFactor`
 * da yanlıştır; doğru dönüşüm yalnızca Electron'un kendi API'sindedir.
 */
function dipToPhysical(pt) {
  if (process.platform === 'win32' && typeof screen.dipToScreenPoint === 'function') {
    try { return screen.dipToScreenPoint(pt); } catch { /* aşağıdaki yola düş */ }
  }
  // macOS: CGWarpMouseCursorPosition zaten nokta (DIP) alır — ölçekleme yok.
  // Linux/X11: XTest piksel alır, tipik kurulumda ölçek 1:1.
  return { x: Math.round(pt.x), y: Math.round(pt.y) };
}

/**
 * Normalize (0..1) koordinatı, PAYLAŞILAN EKRANIN mutlak konumuna çevirir.
 * Eskiden her zaman birincil ekran varsayılıyordu; ikinci monitör
 * paylaşıldığında imleç yanlış ekrana düşüyordu.
 */
function normalizedToScreen(target, nx, ny) {
  const display = (target && target.display) || screen.getPrimaryDisplay();
  const b = display.bounds; // DIP
  return dipToPhysical({
    x: b.x + clamp01(nx) * b.width,
    y: b.y + clamp01(ny) * b.height,
  });
}

async function applyInput(mod, event, wcId, target) {
  const { Point, Button, Key, mouse, keyboard } = mod;
  const isPointer = event.type === 'mousemove' || event.type === 'mousedown'
    || event.type === 'mouseup' || event.type === 'wheel';

  // Pencere paylaşımında pencerenin ekran dikdörtgeni bilinemez; fareyi
  // rastgele bir yere göndermek yerine yok sayıyoruz (klavye çalışmaya devam eder).
  if (isPointer && target && target.kind === 'window') return;

  const p = normalizedToScreen(target, event.x, event.y);
  const toBtn = (b) => (b === 2 ? Button.RIGHT : b === 1 ? Button.MIDDLE : Button.LEFT);

  switch (event.type) {
    case 'mousemove':
      await mouse.setPosition(new Point(p.x, p.y));
      break;
    case 'mousedown': {
      const btn = toBtn(event.button);
      await mouse.setPosition(new Point(p.x, p.y));
      await mouse.pressButton(btn);
      trackHold(heldButtons, wcId, btn, true);
      break;
    }
    case 'mouseup': {
      const btn = toBtn(event.button);
      await mouse.setPosition(new Point(p.x, p.y));
      await mouse.releaseButton(btn);
      trackHold(heldButtons, wcId, btn, false);
      break;
    }
    case 'wheel': {
      const dy = Math.round((event.dy || 0) / 100);
      const dx = Math.round((event.dx || 0) / 100);
      if (dy > 0) await mouse.scrollDown(dy); else if (dy < 0) await mouse.scrollUp(-dy);
      if (dx > 0) await mouse.scrollRight(dx); else if (dx < 0) await mouse.scrollLeft(-dx);
      break;
    }
    case 'keydown': {
      const k = resolveKey(Key, event.code);
      if (k !== null && k !== undefined) {
        await keyboard.pressKey(k);
        trackHold(heldKeys, wcId, k, true);
      }
      break;
    }
    case 'keyup': {
      const k = resolveKey(Key, event.code);
      if (k !== null && k !== undefined) {
        await keyboard.releaseKey(k);
        trackHold(heldKeys, wcId, k, false);
      }
      break;
    }
    case 'release-all':
      // Kontrol eden taraf odağı kaybetti: basılı olan her şeyi bırak.
      break; // asıl iş queueRelease'de; buraya düşerse yapılacak bir şey yok
    default:
      break; // bilinmeyen olay türü — yok say
  }
}

// Girdi seli koruması: kötü niyetli veya bozuk bir eş, veri kanalını
// mousemove ile doldurup inputChain'i sınırsız büyütebilir ve makineyi
// kullanılamaz hâle getirebilirdi. Bekleyen iş belli bir sınırı aşarsa
// yeni olaylar düşürülür (kullanıcı girdisi asla bu hıza ulaşmaz).
let pendingInputs = 0;
const MAX_PENDING_INPUTS = 120;

ipcMain.on('input-event', (e, event) => {
  // Ana süreç tarafı yetki kontrolü: yerel kullanıcı onay penceresinde açıkça
  // izin vermediyse hiçbir girdi işletilmez. Renderer'daki bayrak artık tek kapı değil.
  if (!controlGrants.has(e.sender.id)) return;
  if (!event || typeof event.type !== 'string') return;

  // Odak kaybında gelen toplu bırakma isteği zincire ayrıca eklenir.
  if (event.type === 'release-all') { queueRelease(e.sender.id); return; }

  const mod = loadNut();
  if (!mod) return;
  if (pendingInputs >= MAX_PENDING_INPUTS) return;

  const wcId = e.sender.id;
  const target = captureTargets.get(wcId);
  pendingInputs++;
  inputChain = inputChain
    .then(() => applyInput(mod, event, wcId, target))
    .catch(() => {})
    .finally(() => { pendingInputs--; });
});