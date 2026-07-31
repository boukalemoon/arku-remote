const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  isElectron: true,
  // Forward remote input events to main process for OS-level injection
  sendInput: (event) => ipcRenderer.send('input-event', event),
  // Aynı hesapla ikinci bir bağımsız oturum penceresi aç (çoklu müşteri erişimi)
  newWindow: () => ipcRenderer.send('new-window'),
  // Ayarlar'dan elle güncelleme kontrolü
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  // Uzaktan kontrol izni: onayı ana süreç kendi penceresinde sorar, kararı
  // kendisi saklar. Web içeriği izni tek başına veremez.
  requestRemoteControl: () => ipcRenderer.invoke('remote-control:request'),
  revokeRemoteControl: () => ipcRenderer.send('remote-control:revoke'),
});