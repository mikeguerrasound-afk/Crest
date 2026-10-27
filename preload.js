const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openDialog: () => ipcRenderer.invoke('dialog:open'),
  readFile: (p) => ipcRenderer.invoke('file:read', p),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onFileOpened: (cb) => ipcRenderer.on('file:opened', (_e, info) => cb(info)),
  onMenuExport: (cb) => ipcRenderer.on('menu:export', () => cb()),
  writeExportSync: (name, bytes) => ipcRenderer.sendSync('export:write-sync', name, bytes),
  saveAs: (name, bytes) => ipcRenderer.invoke('export:save-as', name, bytes),
  startDrag: (filePath) => ipcRenderer.send('drag:start', filePath),
});
