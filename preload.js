const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  load: () => ipcRenderer.invoke('load'),
  save: (json) => ipcRenderer.invoke('save', json),
  openDataFolder: () => ipcRenderer.invoke('openDataFolder'),
  exportFile: (name, content, kind) => ipcRenderer.invoke('exportFile', { name, content, kind }),
  print: () => ipcRenderer.invoke('print'),
});
