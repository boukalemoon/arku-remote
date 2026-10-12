// Zorunlu güncelleme: ana süreç "update:install-now" yolu (2026-10-12).
// Çalıştırma: node --test tests/electron/forced-update.test.cjs
// Electron ve electron-updater sahte modüllerle değiştirilir; hiçbir şey
// indirilmez, kurulmaz, ağa çıkılmaz.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');

const MAIN = process.env.ARKU_MAIN || path.join(__dirname, '..', '..', 'electron', 'main.cjs');

// Ağa çıkılmaz: GitHub sürüm sorgusu (bildirim yolu) sahte fetch'e düşer.
const fetchCalls = [];
global.fetch = async (u) => { fetchCalls.push(String(u)); throw new Error('test: ag yok'); };

// setupUpdates 4 saatlik bir zamanlayıcı kurar; test süreci onu beklemesin.
const realSetInterval = setInterval;
global.setInterval = (...a) => { const t = realSetInterval(...a); if (t && t.unref) t.unref(); return t; };

// Her özelliği ve her çağrıyı kabul eden sahte nesne (pencere, oturum...).
// `then` tanımsız: await edilince takılmasın.
function stub() {
  const fn = function () { return proxy; };
  const proxy = new Proxy(fn, {
    get: (_t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : proxy),
    apply: () => proxy,
    construct: () => proxy,
  });
  return proxy;
}

let currentElectron = null;
let currentUpdater = null;
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (currentElectron && req === 'electron') return currentElectron;
  if (req === 'electron-updater') {
    if (!currentUpdater) throw new Error('test: yok');
    return { autoUpdater: currentUpdater };
  }
  if (req === '@nut-tree-fork/nut-js') throw new Error('test: yok');
  return origLoad.call(this, req, ...rest);
};

function makeUpdater({ latest = '1.6.0', fail = false, current = '1.4.0', declines = false } = {}) {
  const u = new EventEmitter();
  u.checks = 0;
  u.installs = 0;
  u.checkForUpdates = async () => {
    u.checks++;
    if (fail) throw new Error('ag yok');
    const newer = latest.localeCompare(current, undefined, { numeric: true }) > 0 && !declines;
    // electron-updater 6: indirme yalnizca isUpdateAvailable iken baslar.
    return { updateInfo: { version: latest }, isUpdateAvailable: newer, downloadPromise: newer ? Promise.resolve([]) : null };
  };
  u.quitAndInstall = () => { u.installs++; };
  return u;
}

async function loadMain({ platform = 'win32', current = '1.4.0', updater = makeUpdater(), dialogResponse = 1, portable = false } = {}) {
  if (portable) process.env.PORTABLE_EXECUTABLE_FILE = 'C:\\Users\\x\\Arku-Remote.exe';
  else delete process.env.PORTABLE_EXECUTABLE_FILE;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'arku-upd-'));
  const ipc = new Map();
  const sent = [];
  const dialogs = [];
  const opened = [];
  const win = { isDestroyed: () => false, webContents: { send: (ch, p) => sent.push({ ch, p }) } };
  let ready;
  const readyP = new Promise((r) => { ready = r; });
  currentUpdater = updater;
  currentElectron = {
    app: {
      isPackaged: true, whenReady: () => readyP, on: () => {}, getPath: () => userData,
      getVersion: () => current, requestSingleInstanceLock: () => true, quit: () => {},
      setLoginItemSettings: () => {}, getLoginItemSettings: () => ({ openAtLogin: false }),
      commandLine: { appendSwitch: () => {} },
    },
    BrowserWindow: Object.assign(function () { return stub(); }, { fromWebContents: () => null, getAllWindows: () => [win] }),
    session: { defaultSession: stub() },
    desktopCapturer: { getSources: async () => [] },
    shell: { openExternal: (u) => { opened.push(u); }, openPath: async () => '' },
    ipcMain: { on: () => {}, handle: (ch, fn) => ipc.set(ch, fn) },
    screen: { getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1, height: 1 } }), getAllDisplays: () => [] },
    dialog: {
      showMessageBox: async (_w, o) => { dialogs.push(o); return { response: dialogResponse }; },
      showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    },
    webContents: { fromId: () => null },
    systemPreferences: { isTrustedAccessibilityClient: () => true, getMediaAccessStatus: () => 'granted' },
    clipboard: { readText: () => '', writeText: () => {} },
  };
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    delete require.cache[require.resolve(MAIN)];
    require(MAIN);
    ready();
    await new Promise((r) => setImmediate(r)); // whenReady -> setupUpdates
  } finally {
    Object.defineProperty(process, 'platform', realPlatform);
  }
  const call = async (ch, arg) => {
    Object.defineProperty(process, 'platform', { value: platform });
    try { return await ipc.get(ch)({ sender: { id: 1 } }, arg); }
    finally { Object.defineProperty(process, 'platform', realPlatform); }
  };
  return { call, updater, sent, dialogs, opened };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('Windows: Güncelle -> indirir, ilerleme pencereye gider, bitince ONAY SORMADAN kurar', async () => {
  const m = await loadMain();
  const r = await m.call('update:install-now');
  assert.equal(r.mode, 'auto');
  assert.equal(r.version, '1.6.0');
  m.updater.emit('download-progress', { percent: 41.6 });
  assert.deepEqual(m.sent.at(-1), { ch: 'update:progress', p: { state: 'downloading', percent: 42 } });
  m.updater.emit('update-downloaded', { version: '1.6.0' });
  await wait(400);
  assert.equal(m.updater.installs, 1);
  assert.equal(m.dialogs.length, 0, 'kullanıcı zaten onay verdi; ikinci pencere sorulmamalı');
  // Kurulum başarısız oldu (uygulama hâlâ açık): tekrar dene yeniden kontrol eder.
  const checksBefore = m.updater.checks;
  await m.call('update:install-now');
  assert.equal(m.updater.checks, checksBefore + 1);
});

test('Windows: kendiliğinden (zorunlu olmadan) inen güncelleme eskisi gibi ONAY sorar', async () => {
  const m = await loadMain({ dialogResponse: 1 });
  m.updater.emit('update-downloaded', { version: '1.6.0' });
  await wait(50);
  assert.equal(m.dialogs.length, 1);
  assert.equal(m.updater.installs, 0, '"Daha Sonra" denince kurulmamalı');
  // Ardından zorunlu ekrandan "Güncelle": zaten inmiş olanı hemen kurar.
  const r = await m.call('update:install-now');
  assert.equal(r.mode, 'auto');
  await wait(400);
  assert.equal(m.updater.installs, 1);
});

test('sunucuda daha yeni sürüm yoksa "none" döner, kurulum yapılmaz', async () => {
  const m = await loadMain({ current: '1.6.0', updater: makeUpdater({ latest: '1.6.0', current: '1.6.0' }) });
  const r = await m.call('update:install-now');
  assert.equal(r.mode, 'none');
  m.updater.emit('update-downloaded', { version: '1.6.0' });
  await wait(50);
  assert.equal(m.updater.installs, 0);
});

test('güncelleyici hata verirse indirme sayfası açılır ("manual")', async () => {
  const m = await loadMain({ updater: makeUpdater({ fail: true }) });
  const r = await m.call('update:install-now');
  assert.equal(r.mode, 'manual');
  assert.deepEqual(m.opened, ['https://www.arku.com.tr/#indir']);
});

test('indirme sırasında hata: pencereye "error" bildirilir, eski uyarı penceresi açılmaz', async () => {
  const m = await loadMain();
  await m.call('update:install-now');
  m.updater.emit('error', new Error('imza/ag'));
  await wait(20);
  assert.equal(m.sent.at(-1).p.state, 'error');
  assert.equal(m.dialogs.length, 0);
});

test('macOS (imzasız, kendini güncelleyemez): indirme sayfası açılır', async () => {
  const m = await loadMain({ platform: 'darwin' });
  const r = await m.call('update:install-now');
  assert.equal(r.mode, 'manual');
  assert.deepEqual(m.opened, ['https://www.arku.com.tr/#indir']);
  assert.equal(m.updater.checks, 0);
  // Açılıştaki "yeni sürüm var mı" sorgusu sahte fetch'e gitti (ağa değil).
  assert.ok(fetchCalls.some((u) => u.includes('/releases/latest')));
});

test('Windows portable: kendini güncelleyemez, indirme sayfasına yönlendirir (ayrı kurulum yapmaz)', async () => {
  const m = await loadMain({ portable: true });
  const r = await m.call('update:install-now');
  assert.equal(r.mode, 'manual');
  assert.equal(m.updater.checks, 0, 'portable üzerinde electron-updater çalıştırılmamalı');
  assert.deepEqual(m.opened, ['https://www.arku.com.tr/#indir']);
  delete process.env.PORTABLE_EXECUTABLE_FILE;
});

test('yeni sürüm var ama güncelleyici indirmeyi reddediyor: %0 da beklemez, sayfaya yönlendirir', async () => {
  const m = await loadMain({ updater: makeUpdater({ declines: true }) });
  const r = await m.call('update:install-now');
  assert.equal(r.mode, 'manual');
  assert.deepEqual(m.opened, ['https://www.arku.com.tr/#indir']);
});

test('inmiş dosyayla kurulum başarısızsa ikinci basış önbelleğe güvenmez, yeniden kontrol eder', async () => {
  const m = await loadMain();
  m.updater.emit('update-downloaded', { version: '1.6.0' }); // onay penceresi: Daha Sonra
  await wait(20);
  await m.call('update:install-now');
  await wait(400);
  assert.equal(m.updater.installs, 1);
  assert.equal(m.updater.checks, 1, 'açılıştaki kontrol');
  // Uygulama kapanmadı (kurulum başarısız): tekrar dene
  const r = await m.call('update:install-now');
  assert.equal(r.mode, 'auto');
  assert.equal(m.updater.checks, 2, 'ikinci basış yeniden kontrol etmeli');
});
