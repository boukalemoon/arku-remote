const { contextBridge, ipcRenderer } = require('electron');

// Ekran seçici penceresinin ana süreçle tek köprüsü. Seçici, uygulamanın
// web içeriğinden tamamen ayrı bir pencerede çalışır; uzak taraf buraya
// erişemez, dolayısıyla kaynak seçimi her zaman yerel kullanıcının elindedir.
contextBridge.exposeInMainWorld('arkuPicker', {
  init: () => ipcRenderer.invoke('picker:init'),
  choose: (payload) => ipcRenderer.send('picker:choose', payload),
  cancel: () => ipcRenderer.send('picker:cancel'),
});
