const { app, BrowserWindow, session, desktopCapturer, shell, ipcMain, screen } = require('electron');
const path = require('path');

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
    icon: path.join(__dirname, '../public/icon.ico'),
    title: 'Yırak Remote',
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

  // Dış linkleri tarayıcıda aç
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
if (isDev) {
  win.loadURL('http://localhost:3000');
  win.webContents.openDevTools({ mode: 'detach' });
} else {
  win.loadFile(path.join(__dirname, '../dist/index.html'));
}

  win.setMenuBarVisibility(false);

  // Pencere hazır olduğunda göster
  win.once('ready-to-show', () => {
    win.show();
  });
}

app.whenReady().then(() => {
  createWindow();
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