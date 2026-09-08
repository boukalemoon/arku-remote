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
  // Dönüş: { granted, pointer, reason?, error? }
  //   pointer=false -> tek pencere paylaşıldı, yalnızca klavye iletilir.
  requestRemoteControl: () => ipcRenderer.invoke('remote-control:request'),
  revokeRemoteControl: () => ipcRenderer.send('remote-control:revoke'),
  // Oturum kaydi. Klasor yolu ana surecte saklanir; renderer yol belirleyemez.
  getRecordingFolder: () => ipcRenderer.invoke('recording:get-folder'),
  pickRecordingFolder: () => ipcRenderer.invoke('recording:pick-folder'),
  saveRecording: (payload) => ipcRenderer.invoke('recording:save', payload),
  openRecordingFolder: () => ipcRenderer.invoke('recording:open-folder'),
  // Alinan dosyayi diske kaydet (kaydetme penceresi ana surecte acilir).
  saveFile: (payload) => ipcRenderer.invoke('file:save', payload),
  // Coklu monitor: paylasilan ekrani oturum ortasinda degistirme.
  // Ikisi de ana surecte kontrol iznine baglidir.
  listScreens: () => ipcRenderer.invoke('screens:list'),
  selectScreen: (sourceId) => ipcRenderer.invoke('screens:select', sourceId),
  // Pano paylaşımı. forRemote/fromRemote = "işlemi karşı taraf istedi";
  // bu durumda ana süreç kontrol iznini arar (klavye/fare ile aynı kapı).
  readClipboard: (opts) => ipcRenderer.invoke('clipboard:read', opts),
  writeClipboard: (payload) => ipcRenderer.send('clipboard:write', payload),
  // Girdi enjeksiyonu bu makinede çalışabilir mi (nut-js yüklü mü, macOS
  // erişilebilirlik izni var mı). Arayüz sessiz başarısızlık yerine sebebi gösterir.
  remoteControlStatus: () => ipcRenderer.invoke('remote-control:status'),
});