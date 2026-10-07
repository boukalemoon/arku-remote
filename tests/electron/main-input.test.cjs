// Ana süreç girdi kapısı testleri (denetim 2026-10-07: O3, D8).
// Çalıştırma: node --test tests/electron/main-input.test.cjs
// Electron ve nut-js sahte modüllerle değiştirilir; uygulama başlatılmaz,
// pencere açılmaz, ağa çıkılmaz.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const MAIN = process.env.ARKU_MAIN || path.join(__dirname, '..', '..', 'electron', 'main.cjs');

let current = null;
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (current && req === 'electron') return current.electron;
  if (current && req === '@nut-tree-fork/nut-js') return current.nut;
  if (req === 'electron-updater') throw new Error('test: yok');
  return origLoad.call(this, req, ...rest);
};

function loadMain() {
  const ipc = { on: new Map(), handle: new Map() };
  const calls = [];
  let dialogImpl = async () => ({ response: 0, canceled: true, filePaths: [] });
  const noop = () => {};
  const evt = { on: noop, once: noop };
  const electron = {
    app: { isPackaged: true, whenReady: () => new Promise(noop), on: noop, getPath: () => '/tmp', getVersion: () => '0.0.0', requestSingleInstanceLock: () => true, quit: noop },
    BrowserWindow: Object.assign(function () {}, { fromWebContents: () => null, getAllWindows: () => [] }),
    session: { defaultSession: evt },
    desktopCapturer: { getSources: async () => [] },
    shell: { openExternal: noop, openPath: async () => '' },
    ipcMain: {
      on: (ch, fn) => ipc.on.set(ch, fn),
      handle: (ch, fn) => ipc.handle.set(ch, fn),
    },
    screen: { getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 100, height: 100 } }), getAllDisplays: () => [] },
    dialog: {
      showMessageBox: (...a) => dialogImpl('box', ...a),
      showSaveDialog: (...a) => dialogImpl('save', ...a),
      showOpenDialog: (...a) => dialogImpl('open', ...a),
    },
    webContents: { fromId: () => null },
    systemPreferences: { isTrustedAccessibilityClient: () => true, getMediaAccessStatus: () => 'granted' },
    clipboard: { readText: () => '', writeText: noop },
  };
  const rec = (name) => async (...a) => { calls.push([name, ...a]); };
  const nut = {
    Point: function (x, y) { this.x = x; this.y = y; },
    Button: { LEFT: 'L', RIGHT: 'R', MIDDLE: 'M' },
    Key: new Proxy({}, { get: (_, k) => String(k) }),
    mouse: { config: {}, setPosition: rec('setPosition'), pressButton: rec('pressButton'), releaseButton: rec('releaseButton'),
      scrollDown: rec('scrollDown'), scrollUp: rec('scrollUp'), scrollLeft: rec('scrollLeft'), scrollRight: rec('scrollRight') },
    keyboard: { config: {}, pressKey: rec('pressKey'), releaseKey: rec('releaseKey'), type: rec('type') },
  };
  // nut-js tembel yüklendiği için kanca test süresince açık kalır.
  current = { electron, nut };
  delete require.cache[require.resolve(MAIN)];
  require(MAIN);
  return { ipc, calls, setDialog: (fn) => { dialogImpl = fn; } };
}

const tick = () => new Promise((r) => setTimeout(r, 20));
const sender = { id: 7 };

async function grant(m) {
  const res = await m.ipc.handle.get('remote-control:request')({ sender });
  assert.equal(res.granted, true, 'kontrol izni verilemedi');
}

test('izin verilince klavye olayı işlenir (temel durum)', async () => {
  const m = loadMain();
  await grant(m);
  m.ipc.on.get('input-event')({ sender }, { type: 'keydown', key: 'a', code: 'KeyA' });
  await tick();
  assert.ok(m.calls.some((c) => c[0] === 'pressKey'), 'tuş basılmadı');
});

test('O3: yerel onay/kaydetme penceresi açıkken uzaktan girdi atılır', async () => {
  const m = loadMain();
  await grant(m);
  let release;
  m.setDialog(() => new Promise((r) => { release = r; }));
  const pending = m.ipc.handle.get('recording:pick-folder')({ sender });
  await tick();
  m.calls.length = 0;
  m.ipc.on.get('input-event')({ sender }, { type: 'keydown', key: 'Enter', code: 'Enter' });
  await tick();
  assert.equal(m.calls.filter((c) => c[0] === 'pressKey').length, 0, 'pencere açıkken tuş basıldı');
  release({ canceled: true, filePaths: [] });
  await pending.catch(() => {});
  await tick();
  m.ipc.on.get('input-event')({ sender }, { type: 'keydown', key: 'a', code: 'KeyA' });
  await tick();
  assert.ok(m.calls.some((c) => c[0] === 'pressKey'), 'pencere kapandıktan sonra girdi geri gelmedi');
});

test('D8: tek wheel olayı en fazla 20 adım kaydırır', async () => {
  const m = loadMain();
  await grant(m);
  m.calls.length = 0;
  m.ipc.on.get('input-event')({ sender }, { type: 'wheel', dx: 0, dy: 1e9, x: 0.5, y: 0.5 });
  await tick();
  const down = m.calls.find((c) => c[0] === 'scrollDown');
  assert.ok(down, 'kaydırma yapılmadı');
  assert.ok(down[1] <= 20, `adım sayısı ${down[1]}`);
});
