const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  isElectron: true,
  version: '1.0.0',
  // Forward remote input events to main process for OS-level injection
  sendInput: (event) => ipcRenderer.send('input-event', event),
});