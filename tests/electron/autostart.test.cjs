// "Bilgisayar açılınca otomatik başlat" ana süreç testleri (2026-10-11).
// Çalıştırma: node --test tests/electron/autostart.test.cjs
// Electron sahte modülle değiştirilir; uygulama başlatılmaz, başlangıç
// kaydına (Windows kayıt defteri) gerçekten yazılmaz.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const MAIN = process.env.ARKU_MAIN || path.join(__dirname, '..', '..', 'electron', 'main.cjs');

let current = null;
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (current && req === 'electron') return current;
  if (req === 'electron-updater') throw new Error('test: yok');
  if (req === '@nut-tree-fork/nut-js') throw new Error('test: yok');
  return origLoad.call(this, req, ...rest);
};

function loadMain({ platform = 'win32', packaged = true } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'arku-autostart-'));
  const ipc = new Map();
  const loginCalls = [];
  let loginState = { openAtLogin: false };
  const noop = () => {};
  const evt = { on: noop, once: noop };
  current = {
    app: {
      isPackaged: packaged, whenReady: () => new Promise(noop), on: noop, getPath: () => userData,
      getVersion: () => '0.0.0', requestSingleInstanceLock: () => true, quit: noop,
      setLoginItemSettings: (s) => { loginCalls.push(s); loginState = { openAtLogin: !!s.openAtLogin }; },
      getLoginItemSettings: () => ({ ...loginState }),
    },
    BrowserWindow: Object.assign(function () {}, { fromWebContents: () => null, getAllWindows: () => [] }),
    session: { defaultSession: evt },
    desktopCapturer: { getSources: async () => [] },
    shell: { openExternal: noop, openPath: async () => '' },
    ipcMain: { on: noop, handle: (ch, fn) => ipc.set(ch, fn) },
    screen: { getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1, height: 1 } }), getAllDisplays: () => [] },
    dialog: { showMessageBox: async () => ({ response: 0 }), showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    webContents: { fromId: () => null },
    systemPreferences: { isTrustedAccessibilityClient: () => true, getMediaAccessStatus: () => 'granted' },
    clipboard: { readText: () => '', writeText: noop },
  };
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    delete require.cache[require.resolve(MAIN)];
    require(MAIN);
  } finally {
    Object.defineProperty(process, 'platform', realPlatform);
  }
  // Handler'lar çağrı anında process.platform okur: testte de taklit et.
  const call = async (ch, arg) => {
    Object.defineProperty(process, 'platform', { value: platform });
    try { return await ipc.get(ch)({ sender: { id: 1 } }, arg); }
    finally { Object.defineProperty(process, 'platform', realPlatform); }
  };
  return { call, loginCalls, userData };
}

test('Windows: varsayılan kapalı; açınca uygulamanın kendisi sabit argümanla kaydedilir', async () => {
  const m = loadMain();
  assert.deepEqual(await m.call('autostart:get'), { supported: true, enabled: false, minimized: false });
  const after = await m.call('autostart:set', { enabled: true, minimized: true });
  assert.deepEqual(after, { supported: true, enabled: true, minimized: true });
  assert.equal(m.loginCalls.length, 1);
  assert.equal(m.loginCalls[0].openAtLogin, true);
  assert.equal(m.loginCalls[0].path, process.execPath);
  assert.deepEqual(m.loginCalls[0].args, ['--arku-autostart']);
  // Tercih kalıcı: yeni süreç de okur.
  const saved = JSON.parse(fs.readFileSync(path.join(m.userData, 'arku-autostart.json'), 'utf8'));
  assert.deepEqual(saved, { minimized: true });
});

test('renderer başlangıca başka program ya da argüman yazdıramaz', async () => {
  const m = loadMain();
  await m.call('autostart:set', { enabled: true, path: 'C:\\kotu.exe', args: ['--kotu'], openAsHidden: true });
  assert.equal(m.loginCalls[0].path, process.execPath);
  assert.deepEqual(m.loginCalls[0].args, ['--arku-autostart']);
  assert.equal('openAsHidden' in m.loginCalls[0], false);
});

test('yalnızca gerçek true açar; "yes", 1, eksik değer kapalı sayılır', async () => {
  for (const v of ['yes', 1, undefined, null]) {
    const m = loadMain();
    await m.call('autostart:set', { enabled: v });
    assert.equal(m.loginCalls[0].openAtLogin, false, `enabled=${String(v)}`);
  }
  const m = loadMain();
  await m.call('autostart:set', null);
  assert.equal(m.loginCalls[0].openAtLogin, false);
});

test('kapatınca kayıt kaldırılır', async () => {
  const m = loadMain();
  await m.call('autostart:set', { enabled: true });
  const off = await m.call('autostart:set', { enabled: false });
  assert.equal(off.enabled, false);
  assert.equal(m.loginCalls.at(-1).openAtLogin, false);
});

test('geliştirme kipinde (paketlenmemiş) ve Linux\'ta desteklenmez, kayda dokunulmaz', async () => {
  for (const opts of [{ packaged: false }, { platform: 'linux' }]) {
    const m = loadMain(opts);
    assert.equal((await m.call('autostart:get')).supported, false);
    await m.call('autostart:set', { enabled: true });
    assert.equal(m.loginCalls.length, 0, JSON.stringify(opts));
  }
});
