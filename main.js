const { app, BrowserWindow, ipcMain, dialog, Menu, nativeImage, shell, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { pathToFileURL } = require('url');
const M = require('./lib/media');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const E2E = !!process.env.CREST_E2E;

if (process.env.CREST_USER_DATA) app.setPath('userData', process.env.CREST_USER_DATA);

// crest://media/?p=<path> serves local files with CORS headers, so the Web Audio graph
// (EQ, analyser) is allowed to read them. Must be declared before the app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'crest', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

const MIME = {
  wav: 'audio/wav', wave: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
  webm: 'video/webm', mkv: 'video/x-matroska', ogv: 'video/ogg',
};

let win = null;
let pendingOpen = null;

/* ---------- settings (tiny JSON file) ---------- */

let settings = null;
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  if (settings) return settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    settings = {};
  }
  return settings;
}
function saveSettings(patch) {
  settings = Object.assign(loadSettings(), patch);
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings));
  } catch {}
}
const lang = () => loadSettings().lang || (String(app.getLocale()).toLowerCase().startsWith('es') ? 'es' : 'en');

const T = {
  en: {
    file: 'File', view: 'View', help: 'Help',
    open: 'Open…', openFolder: 'Open Folder…', exportSel: 'Export Selection as WAV…',
    exportHits: 'Export All Hits as Files…', openExports: 'Open Exports Folder', setDefault: 'Use Crest as Default Player…',
    licenses: 'Third-Party Licenses',
    dTitle: 'Use Crest as your default player?',
    dDetailWin: 'Audio and video files will open in Crest when you double-click them. Windows will open its settings so you can choose Crest.',
    dDetailMac: 'Audio and video files will open in Crest when you double-click them. macOS asks you to do this from Finder, so I’ll show you how.',
    dYes: 'Yes, set it up', dNo: 'Not now', dNever: 'Don’t ask again',
    macTitle: 'Set Crest as the default in Finder',
    macSteps: '1. Select any audio or video file in Finder.\n2. Press ⌘I (Get Info).\n3. Under “Open with” choose Crest.\n4. Click “Change All…”.\n\nRepeat for each type you want (WAV, MP3, MP4…).',
    macReveal: 'Show the open file in Finder', ok: 'OK',
    licTitle: 'Third-party licenses',
    licBody: 'Crest uses FFmpeg (https://ffmpeg.org) to read formats the built-in player can’t, such as ProRes, DNxHD and AVI. FFmpeg is licensed under the GPL v3. Its license text is included with the app and its source code is available at https://ffmpeg.org/download.html.',
    licOpen: 'Open license folder',
    couldntOpen: 'Couldn’t open that file',
  },
  es: {
    file: 'Archivo', view: 'Ver', help: 'Ayuda',
    open: 'Abrir…', openFolder: 'Abrir carpeta…', exportSel: 'Exportar selección como WAV…',
    exportHits: 'Exportar todos los golpes como archivos…', openExports: 'Abrir carpeta de exportaciones', setDefault: 'Usar Crest como reproductor predeterminado…',
    licenses: 'Licencias de terceros',
    dTitle: '¿Usar Crest como reproductor predeterminado?',
    dDetailWin: 'Tus archivos de audio y video se abrirán en Crest con doble clic. Windows abrirá su configuración para que elijas Crest.',
    dDetailMac: 'Tus archivos de audio y video se abrirán en Crest con doble clic. macOS pide hacerlo desde Finder, así que te muestro cómo.',
    dYes: 'Sí, configurarlo', dNo: 'Ahora no', dNever: 'No volver a preguntar',
    macTitle: 'Poner Crest como predeterminado en Finder',
    macSteps: '1. Selecciona un archivo de audio o video en Finder.\n2. Presiona ⌘I (Obtener información).\n3. En “Abrir con” elige Crest.\n4. Pulsa “Cambiar todo…”.\n\nRepítelo para cada tipo que quieras (WAV, MP3, MP4…).',
    macReveal: 'Mostrar el archivo abierto en Finder', ok: 'Aceptar',
    licTitle: 'Licencias de terceros',
    licBody: 'Crest usa FFmpeg (https://ffmpeg.org) para leer formatos que el reproductor integrado no abre, como ProRes, DNxHD y AVI. FFmpeg tiene licencia GPL v3. El texto de la licencia se incluye con la app y su código fuente está en https://ffmpeg.org/download.html.',
    licOpen: 'Abrir carpeta de licencias',
    couldntOpen: 'No se pudo abrir ese archivo',
  },
};
const tr = (k) => (T[lang()] || T.en)[k] || T.en[k];

/* ---------- allow-list for crest:// ---------- */

const allowedFiles = new Set();
const allowedDirs = new Set();
const exportDirsChosen = new Set();
const cacheDir = () => path.join(app.getPath('temp'), 'Crest Cache');
const norm = (p) => path.resolve(String(p));
const mediaUrl = (p) => 'crest://media/?p=' + encodeURIComponent(p);

function canServe(p) {
  p = norm(p);
  return allowedFiles.has(p) || allowedDirs.has(path.dirname(p)) || path.dirname(p) === cacheDir();
}

/* ---------- ffmpeg ---------- */

function ffmpegPath() {
  if (process.env.CREST_FFMPEG) return process.env.CREST_FFMPEG;
  let p = null;
  try {
    p = require('ffmpeg-static');
  } catch {}
  if (p && app.isPackaged) p = p.replace('app.asar', 'app.asar.unpacked');
  return p && fs.existsSync(p) ? p : null;
}

function probeFile(p) {
  return new Promise((resolve) => {
    const bin = ffmpegPath();
    if (!bin) return resolve(null);
    execFile(bin, ['-hide_banner', '-i', p], { windowsHide: true, timeout: 20000, maxBuffer: 8e6 }, (_e, _so, se) => {
      const pr = M.parseProbe(se || '');
      resolve(pr.video || pr.audio ? pr : null);
    });
  });
}

const jobs = new Map();
function runFfmpeg(args, { kind, duration }) {
  return new Promise((resolve, reject) => {
    const bin = ffmpegPath();
    if (!bin) return reject(new Error('ffmpeg-missing'));
    const prev = jobs.get(kind);
    if (prev) prev.kill();
    const child = spawn(bin, args, { windowsHide: true });
    jobs.set(kind, child);
    let err = '';
    let last = -1;
    child.stderr.on('data', (d) => {
      err = (err + d.toString()).slice(-4000);
    });
    child.stdout.on('data', (d) => {
      const s = M.parseProgressChunk(d);
      if (s != null && duration) {
        const pct = Math.min(1, s / duration);
        if (pct - last >= 0.01) {
          last = pct;
          send('job:progress', { kind, pct });
        }
      }
    });
    child.on('error', reject);
    child.on('close', (code, sig) => {
      if (jobs.get(kind) === child) jobs.delete(kind);
      if (code === 0) resolve();
      else reject(new Error(sig || code === null ? 'canceled' : err.trim().split('\n').pop() || 'ffmpeg failed'));
    });
  });
}

async function cached(key, ext, make) {
  fs.mkdirSync(cacheDir(), { recursive: true });
  const out = path.join(cacheDir(), key + ext);
  if (!fs.existsSync(out)) {
    const part = out + '.part';
    try {
      await make(part);
      fs.renameSync(part, out);
    } catch (e) {
      try { fs.unlinkSync(part); } catch {}
      throw e;
    }
  }
  return out;
}
const hash = (...a) => crypto.createHash('sha1').update(a.join('|')).digest('hex').slice(0, 16);

function sweepCache() {
  fs.readdir(cacheDir(), (err, names) => {
    if (err) return;
    const old = Date.now() - 3 * 24 * 3600 * 1000;
    for (const n of names) {
      const f = path.join(cacheDir(), n);
      fs.stat(f, (e, st) => {
        if (!e && st.isFile() && st.mtimeMs < old) fs.unlink(f, () => {});
      });
    }
  });
}

/* ---------- files and folders ---------- */

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

const isMediaPath = (p) => typeof p === 'string' && M.MEDIA_EXT.includes(M.extOf(p));
const fileFromArgv = (argv) => argv.slice(1).find((a) => !a.startsWith('-') && isMediaPath(a) && fs.existsSync(a)) || null;

async function getInfo(p) {
  p = norm(p);
  const st = await fs.promises.stat(p);
  allowedFiles.add(p);
  const ext = M.extOf(p);
  const probe = await probeFile(p);
  const kind = probe ? (probe.video ? 'video' : 'audio') : M.VIDEO_EXT.includes(ext) ? 'video' : 'audio';
  return { path: p, name: path.basename(p), ext, size: st.size, mtimeMs: st.mtimeMs, url: mediaUrl(p), kind, probe, plan: M.playPlan(probe, ext) };
}

async function listFolder(dir) {
  dir = norm(dir);
  allowedDirs.add(dir);
  const ents = await fs.promises.readdir(dir, { withFileTypes: true });
  const names = ents.filter((e) => e.isFile() && isMediaPath(e.name)).map((e) => e.name);
  names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  const files = [];
  for (let i = 0; i < names.length; i += 64) {
    const chunk = await Promise.all(
      names.slice(i, i + 64).map(async (name) => {
        const p = path.join(dir, name);
        try {
          return { name, path: p, size: (await fs.promises.stat(p)).size };
        } catch {
          return null;
        }
      })
    );
    files.push(...chunk.filter(Boolean));
  }
  return { dir, files };
}

async function resolvePath(p, list = true) {
  p = norm(p);
  const st = await fs.promises.stat(p);
  if (st.isDirectory()) return { type: 'folder', ...(await listFolder(p)) };
  const info = await getInfo(p);
  let folder = { dir: path.dirname(p), files: [] };
  if (list) {
    try {
      folder = await listFolder(path.dirname(p));
    } catch {}
  } else allowedDirs.add(path.dirname(p));
  return { type: 'file', info, ...folder, listed: list };
}

async function openAny(p) {
  try {
    send('file:resolved', await resolvePath(p));
  } catch (err) {
    dialog.showErrorBox(tr('couldntOpen'), String((err && err.message) || err));
  }
}

/* ---------- exports ---------- */

function exportsDir() {
  let dir = process.env.CREST_EXPORT_DIR;
  try {
    if (!dir) dir = path.join(app.getPath('music'), 'Crest Exports');
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    dir = path.join(app.getPath('temp'), 'Crest Exports');
    fs.mkdirSync(dir, { recursive: true });
  }
  exportDirsChosen.add(dir);
  return dir;
}
const safeName = (name) => String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 180) || 'selection.wav';
const toBuffer = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);

let cachedIcon = null;
function dragIcon() {
  if (!cachedIcon) {
    cachedIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'drag-icon.png'));
    if (!cachedIcon.isEmpty()) cachedIcon = cachedIcon.resize({ width: 48, height: 48 });
  }
  return cachedIcon;
}

/* ---------- default player prompt ---------- */

async function askDefault(force) {
  const s = loadSettings();
  if (!force && (s.defaultDone || (s.defaultNos || 0) >= 2)) return;
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    message: tr('dTitle'),
    detail: isWin ? tr('dDetailWin') : tr('dDetailMac'),
    buttons: [tr('dYes'), tr('dNo'), tr('dNever')],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (r.response === 2) return saveSettings({ defaultDone: true });
  if (r.response === 1) return saveSettings({ defaultNos: (s.defaultNos || 0) + 1 });
  saveSettings({ defaultDone: true });
  if (isWin) {
    shell.openExternal('ms-settings:defaultapps?registeredAppUser=Crest').catch(() => shell.openExternal('ms-settings:defaultapps'));
  } else if (isMac) {
    const current = settings.lastOpened;
    const buttons = current ? [tr('macReveal'), tr('ok')] : [tr('ok')];
    const r2 = await dialog.showMessageBox(win, { type: 'info', message: tr('macTitle'), detail: tr('macSteps'), buttons, defaultId: 0, noLink: true });
    if (current && r2.response === 0) shell.showItemInFolder(current);
  }
}

/* ---------- window + menu ---------- */

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 780,
    minHeight: 480,
    backgroundColor: '#0f1013',
    show: false,
    autoHideMenuBar: true,
    title: 'Crest',
    titleBarStyle: isMac ? 'hiddenInset' : isWin ? 'hidden' : 'default',
    ...(isMac ? { trafficLightPosition: { x: 14, y: 12 } } : {}),
    ...(isWin ? { titleBarOverlay: { color: '#0f1013', symbolColor: '#aeb4c2', height: 40 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), E2E ? { query: { e2e: '1' } } : undefined);
  win.once('ready-to-show', () => {
    win.show();
    if (app.isPackaged && !E2E) setTimeout(() => askDefault(false).catch(() => {}), 1500);
  });
  win.webContents.on('did-finish-load', () => {
    if (pendingOpen) {
      const p = pendingOpen;
      pendingOpen = null;
      openAny(p);
    }
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => {
    win = null;
  });
}

function buildMenu() {
  const act = (name) => () => send('menu:action', name);
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: tr('file'),
      submenu: [
        { label: tr('open'), accelerator: 'CmdOrCtrl+O', click: act('open') },
        { label: tr('openFolder'), accelerator: 'CmdOrCtrl+Shift+O', click: act('open-folder') },
        { type: 'separator' },
        { label: tr('exportSel'), accelerator: 'CmdOrCtrl+E', click: act('export') },
        { label: tr('exportHits'), accelerator: 'CmdOrCtrl+Shift+E', click: act('export-hits') },
        { label: tr('openExports'), click: () => shell.openPath(exportsDir()) },
        { type: 'separator' },
        { label: tr('setDefault'), click: () => askDefault(true).catch(() => {}) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { label: tr('view'), submenu: [{ role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }])] },
    { role: 'windowMenu' },
    {
      label: tr('help'),
      submenu: [
        {
          label: tr('licenses'),
          click: async () => {
            const dir = path.join(process.resourcesPath || __dirname, 'licenses');
            const r = await dialog.showMessageBox(win, { type: 'info', message: tr('licTitle'), detail: tr('licBody'), buttons: [tr('licOpen'), tr('ok')], defaultId: 1, noLink: true });
            if (r.response === 0) shell.openPath(fs.existsSync(dir) ? dir : __dirname);
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------- IPC ---------- */

ipcMain.handle('file:resolve', async (_e, p, opts) => {
  if (typeof p !== 'string' || !fs.existsSync(p)) return null;
  try {
    const r = await resolvePath(p, !(opts && opts.skipList));
    if (r.type === 'file') saveSettings({ lastOpened: r.info.path });
    return r;
  } catch {
    return null;
  }
});

ipcMain.handle('dialog:open', async () => {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Audio & video', extensions: M.MEDIA_EXT }, { name: 'All files', extensions: ['*'] }],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const r = await resolvePath(res.filePaths[0]).catch(() => null);
  if (r && r.type === 'file') saveSettings({ lastOpened: r.info.path });
  return r;
});

ipcMain.handle('dialog:open-folder', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths[0]) return null;
  return resolvePath(res.filePaths[0]).catch(() => null);
});

ipcMain.handle('media:extract', async (_e, p) => {
  p = norm(p);
  if (!canServe(p)) throw new Error('not allowed');
  const st = await fs.promises.stat(p);
  const probe = await probeFile(p);
  const out = await cached('x-' + hash(p, st.mtimeMs, st.size), '.wav', (part) =>
    runFfmpeg(M.extractArgs(p, part), { kind: 'extract', duration: probe && probe.duration })
  );
  return { url: mediaUrl(out), path: out };
});

ipcMain.handle('media:proxy', async (_e, p, plan) => {
  p = norm(p);
  if (!canServe(p)) throw new Error('not allowed');
  const st = await fs.promises.stat(p);
  const probe = await probeFile(p);
  const out = await cached('p-' + plan + '-' + hash(p, st.mtimeMs, st.size), '.mp4', (part) =>
    runFfmpeg(withFormat(M.proxyArgs(p, part, plan)), { kind: 'proxy', duration: probe && probe.duration })
  );
  return { url: mediaUrl(out), path: out };
});

// ffmpeg picks the muxer from the extension; our temp name ends in ".part", so say it explicitly.
function withFormat(args) {
  const out = args.slice(0, -1);
  return out.concat(['-f', 'mp4', args[args.length - 1]]);
}

ipcMain.handle('media:clip', async (_e, p, start, end) => {
  p = norm(p);
  if (!canServe(p)) throw new Error('not allowed');
  const dur = Math.max(0.04, end - start);
  const out = await cached('c-' + hash(p, start.toFixed(3), end.toFixed(3)), '.mp4', (part) =>
    runFfmpeg(withFormat(M.clipArgs(p, part, start, end)), { kind: 'clip', duration: dur })
  );
  return { path: out };
});

ipcMain.on('job:cancel', (_e, kind) => {
  const c = jobs.get(kind);
  if (c) c.kill();
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

ipcMain.on('export:copy-sync', (e, src, name) => {
  try {
    src = norm(src);
    if (path.dirname(src) !== cacheDir()) throw new Error('not allowed');
    const p = path.join(exportsDir(), safeName(name));
    fs.copyFileSync(src, p);
    e.returnValue = p;
  } catch {
    e.returnValue = null;
  }
});

ipcMain.handle('export:choose-dir', async () => {
  if (E2E && process.env.CREST_CHOOSE_DIR) {
    // test hook: native dialogs can't be driven by the end-to-end test
    exportDirsChosen.add(norm(process.env.CREST_CHOOSE_DIR));
    return norm(process.env.CREST_CHOOSE_DIR);
  }
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: exportsDir() });
  if (res.canceled || !res.filePaths[0]) return null;
  exportDirsChosen.add(norm(res.filePaths[0]));
  return norm(res.filePaths[0]);
});

ipcMain.handle('export:write-to', async (_e, dir, name, bytes) => {
  dir = norm(dir);
  if (!exportDirsChosen.has(dir)) throw new Error('folder not chosen');
  const p = path.join(dir, safeName(name));
  await fs.promises.writeFile(p, toBuffer(bytes));
  return p;
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

ipcMain.on('export:open-dir', () => shell.openPath(exportsDir()));

ipcMain.on('export:reveal', (_e, p) => {
  if (typeof p === 'string' && fs.existsSync(p)) shell.showItemInFolder(p);
});

ipcMain.on('drag:start', (e, filePath) => {
  if (typeof filePath !== 'string' || !fs.existsSync(filePath)) return;
  e.sender.startDrag({ file: filePath, icon: dragIcon() });
});

ipcMain.on('lang:set', (_e, l) => {
  if (l !== 'es' && l !== 'en') return;
  saveSettings({ lang: l });
  buildMenu();
});
ipcMain.handle('lang:get', () => lang());
ipcMain.on('default:ask', () => askDefault(true).catch(() => {}));
ipcMain.handle('app:info', () => ({ ffmpeg: !!ffmpegPath(), platform: process.platform, packaged: app.isPackaged }));

/* ---------- app lifecycle ---------- */

app.on('open-file', (e, p) => {
  e.preventDefault();
  if (win && !win.webContents.isLoading()) openAny(p);
  else pendingOpen = p;
});

if (!app.requestSingleInstanceLock() && !E2E) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    const f = fileFromArgv(argv);
    if (f) openAny(f);
  });

  app.whenReady().then(() => {
    protocol.handle('crest', async (req) => {
      const u = new URL(req.url);
      const p = u.searchParams.get('p');
      if (!p || !canServe(p)) return new Response('Forbidden', { status: 403 });
      let st;
      try {
        st = await fs.promises.stat(norm(p));
        if (!st.isFile()) throw new Error('not a file');
      } catch {
        return new Response('Not found', { status: 404 });
      }
      const size = st.size;
      const h = new Headers({
        'Access-Control-Allow-Origin': '*',
        'Accept-Ranges': 'bytes',
        'Content-Type': MIME[M.extOf(p)] || 'application/octet-stream',
      });
      let start = 0;
      let end = size - 1;
      let status = 200;
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '');
      if (m && (m[1] || m[2])) {
        if (m[1]) {
          start = parseInt(m[1], 10);
          if (m[2]) end = Math.min(parseInt(m[2], 10), size - 1);
        } else {
          start = Math.max(0, size - parseInt(m[2], 10));
        }
        if (start > end || start >= size) {
          h.set('Content-Range', `bytes */${size}`);
          return new Response(null, { status: 416, headers: h });
        }
        status = 206;
        h.set('Content-Range', `bytes ${start}-${end}/${size}`);
      }
      h.set('Content-Length', String(size === 0 ? 0 : end - start + 1));
      if (req.method === 'HEAD' || size === 0) return new Response(null, { status, headers: h });
      const stream = fs.createReadStream(norm(p), { start, end });
      return new Response(Readable.toWeb(stream), { status, headers: h });
    });

    buildMenu();
    sweepCache();
    pendingOpen = fileFromArgv(process.argv);
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    for (const c of jobs.values()) c.kill();
    if (!isMac) app.quit();
  });
}
