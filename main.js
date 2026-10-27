const { app, BrowserWindow, ipcMain, dialog, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

const MEDIA_EXT = [
  'wav', 'wave', 'aif', 'aiff', 'flac', 'mp3', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'wma',
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi',
];
// Above this we skip the waveform (decoding to float32 would need several GB) and just play.
const MAX_DECODE_BYTES = 400 * 1024 * 1024;

let win = null;
let pendingOpen = null;

/* ---------- helpers ---------- */

function isMediaPath(p) {
  return typeof p === 'string' && MEDIA_EXT.includes(path.extname(p).slice(1).toLowerCase());
}

function fileFromArgv(argv) {
  return argv.slice(1).find((a) => !a.startsWith('-') && isMediaPath(a) && fs.existsSync(a)) || null;
}

async function readInfo(p) {
  const stat = await fs.promises.stat(p);
  const info = {
    path: p,
    name: path.basename(p),
    url: pathToFileURL(p).href,
    bytes: null,
    tooLarge: stat.size > MAX_DECODE_BYTES,
  };
  if (!info.tooLarge) info.bytes = await fs.promises.readFile(p);
  return info;
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

async function openPath(p) {
  try {
    send('file:opened', await readInfo(p));
  } catch (err) {
    dialog.showErrorBox('Couldn’t open that file', String((err && err.message) || err));
  }
}

async function pickFile() {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'Audio & video', extensions: MEDIA_EXT },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  try {
    return await readInfo(res.filePaths[0]);
  } catch (err) {
    dialog.showErrorBox('Couldn’t open that file', String((err && err.message) || err));
    return null;
  }
}

function exportsDir() {
  let dir;
  try {
    dir = path.join(app.getPath('music'), 'Crest Exports');
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    dir = path.join(app.getPath('temp'), 'Crest Exports');
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function safeName(name) {
  return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 180) || 'selection.wav';
}

function toBuffer(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

let cachedIcon = null;
function dragIcon() {
  if (!cachedIcon) {
    cachedIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'drag-icon.png'));
    if (!cachedIcon.isEmpty()) cachedIcon = cachedIcon.resize({ width: 48, height: 48 });
  }
  return cachedIcon;
}

/* ---------- window + menu ---------- */

function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 620,
    minWidth: 680,
    minHeight: 420,
    backgroundColor: '#0f1013',
    show: false,
    autoHideMenuBar: true,
    title: 'Crest',
    titleBarStyle: isMac || isWin ? (isMac ? 'hiddenInset' : 'hidden') : 'default',
    ...(isMac ? { trafficLightPosition: { x: 14, y: 12 } } : {}),
    ...(isWin ? { titleBarOverlay: { color: '#0f1013', symbolColor: '#aeb4c2', height: 40 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => {
    if (pendingOpen) {
      const p = pendingOpen;
      pendingOpen = null;
      openPath(p);
    }
  });
  // A dropped file must never navigate the window away.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => {
    win = null;
  });
}

function buildMenu() {
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const info = await pickFile();
            if (info) send('file:opened', info);
          },
        },
        {
          label: 'Export Selection as WAV…',
          accelerator: 'CmdOrCtrl+E',
          click: () => send('menu:export'),
        },
        { label: 'Open Exports Folder', click: () => shell.openPath(exportsDir()) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [{ role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }])],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------- IPC ---------- */

ipcMain.handle('dialog:open', () => pickFile());

ipcMain.handle('file:read', async (_e, p) => {
  if (typeof p !== 'string' || !fs.existsSync(p)) return null;
  try {
    return await readInfo(p);
  } catch {
    return null;
  }
});

// Written synchronously on purpose: the drag must start with the file already on disk.
ipcMain.on('export:write-sync', (e, name, bytes) => {
  try {
    const p = path.join(exportsDir(), safeName(name));
    fs.writeFileSync(p, toBuffer(bytes));
    e.returnValue = p;
  } catch {
    e.returnValue = null;
  }
});

ipcMain.on('drag:start', (e, filePath) => {
  if (typeof filePath !== 'string' || !fs.existsSync(filePath)) return;
  e.sender.startDrag({ file: filePath, icon: dragIcon() });
});

ipcMain.handle('export:save-as', async (_e, name, bytes) => {
  const res = await dialog.showSaveDialog(win, {
    defaultPath: path.join(exportsDir(), safeName(name)),
    filters: [{ name: 'WAV audio', extensions: ['wav'] }],
  });
  if (res.canceled || !res.filePath) return null;
  await fs.promises.writeFile(res.filePath, toBuffer(bytes));
  return res.filePath;
});

/* ---------- app lifecycle ---------- */

app.on('open-file', (e, p) => {
  e.preventDefault();
  if (win && !win.webContents.isLoading()) openPath(p);
  else pendingOpen = p;
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    const f = fileFromArgv(argv);
    if (f) openPath(f);
  });

  app.whenReady().then(() => {
    buildMenu();
    pendingOpen = fileFromArgv(process.argv);
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });
}
