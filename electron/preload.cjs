const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  closeWindow: () => ipcRenderer.send('window-close'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  getAutoStart: () => ipcRenderer.invoke('get-auto-start'),
  setAutoStart: (enabled) => ipcRenderer.send('set-auto-start', enabled),
});
