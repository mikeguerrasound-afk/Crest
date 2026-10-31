const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // files and folders
  openDialog: () => ipcRenderer.invoke('dialog:open'),
  openFolderDialog: () => ipcRenderer.invoke('dialog:open-folder'),
  resolve: (p, opts) => ipcRenderer.invoke('file:resolve', p, opts),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onResolved: (cb) => ipcRenderer.on('file:resolved', (_e, r) => cb(r)),
  onMenu: (cb) => ipcRenderer.on('menu:action', (_e, name) => cb(name)),

  // ffmpeg-backed media
  extractAudio: (p) => ipcRenderer.invoke('media:extract', p),
  prepareProxy: (p, plan) => ipcRenderer.invoke('media:proxy', p, plan),
  renderClip: (p, start, end) => ipcRenderer.invoke('media:clip', p, start, end),
  cancelJob: (kind) => ipcRenderer.send('job:cancel', kind),
  onProgress: (cb) => ipcRenderer.on('job:progress', (_e, d) => cb(d)),

  // exports and drag-out
  writeExportSync: (name, bytes) => ipcRenderer.sendSync('export:write-sync', name, bytes),
  copyExportSync: (src, name) => ipcRenderer.sendSync('export:copy-sync', src, name),
  chooseExportDir: () => ipcRenderer.invoke('export:choose-dir'),
  writeTo: (dir, name, bytes) => ipcRenderer.invoke('export:write-to', dir, name, bytes),
  saveAs: (name, bytes) => ipcRenderer.invoke('export:save-as', name, bytes),
  exportAs: (name, bytes, fmt, channels, dir) => ipcRenderer.invoke('export:convert', name, bytes, fmt, channels, dir),
  reveal: (p) => ipcRenderer.send('export:reveal', p),
  openExportsDir: () => ipcRenderer.send('export:open-dir'),
  startDrag: (filePath) => ipcRenderer.send('drag:start', filePath),

  // tools
  pickVideo: () => ipcRenderer.invoke('dialog:pick-video'),
  readMeta: (p) => ipcRenderer.invoke('meta:read', p),
  writeMeta: (p, tags) => ipcRenderer.invoke('meta:write', p, tags),
  scanMeta: (paths) => ipcRenderer.invoke('meta:scan', paths),
  onMeta: (cb) => ipcRenderer.on('meta:update', (_e, list) => cb(list)),
  exportPicture: (video, start, duration, bytes, name) => ipcRenderer.invoke('pic:export', video, start, duration, bytes, name),
  sendReaper: (name, bytes) => ipcRenderer.invoke('reaper:send', name, bytes),

  // app
  setLang: (l) => ipcRenderer.send('lang:set', l),
  getLang: () => ipcRenderer.invoke('lang:get'),
  askDefault: () => ipcRenderer.send('default:ask'),
  appInfo: () => ipcRenderer.invoke('app:info'),
});
