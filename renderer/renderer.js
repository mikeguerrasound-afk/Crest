(() => {
  'use strict';

  const A = window.CrestAudio;
  const EQ = window.CrestEQ;
  const I = window.CrestI18n;
  const api = window.api;
  const t = (k, v) => I.t(k, v);
  const $ = (id) => document.getElementById(id);

  const el = {
    media: $('media'), stage: $('stage'), stageMsg: $('stageMsg'), splitter: $('splitter'),
    wave: $('wave'), canvas: $('canvas'), playhead: $('playhead'), selection: $('selection'),
    status: $('status'), meter: $('meter'), fx: $('fx'), title: $('title'),
    play: $('play'), timeBtn: $('timeBtn'), cur: $('cur'), dur: $('dur'),
    exportBtn: $('exportBtn'), toolsBtn: $('toolsBtn'), toolsPop: $('toolsPop'), abBtn: $('abBtn'), matchBtn: $('matchBtn'), picVideo: $('picVideo'), exPop: $('exPop'), exFmt: $('exFmt'), exScope: $('exScope'), exFxNote: $('exFxNote'), exGo: $('exGo'), prevHit: $('prevHit'), nextHit: $('nextHit'), loop: $('loop'), vol: $('vol'),
    grip: $('grip'), gripText: $('gripText'), gripVideo: $('gripVideo'), gripVideoText: $('gripVideoText'),
    folderBtn: $('folderBtn'), open: $('open'), specBtn: $('specBtn'), eqBtn: $('eqBtn'), optsBtn: $('optsBtn'),
    openBig: $('openBig'), openFolderBig: $('openFolderBig'),
    side: $('side'), filter: $('filter'), folderName: $('folderName'), list: $('list'), listSpacer: $('listSpacer'),
    listRows: $('listRows'), listEmpty: $('listEmpty'),
    eqPanel: $('eqPanel'), eqCanvas: $('eqCanvas'), eqParams: $('eqParams'), eqBypass: $('eqBypass'), eqReset: $('eqReset'),
    eqOut: $('eqOut'), eqOutVal: $('eqOutVal'),
    opts: $('opts'), chStrip: $('chStrip'), viBtn: $('viBtn'), viLbl: $('viLbl'), viPop: $('viPop'), tabs: $('tabs'), tabList: $('tabList'), tabNew: $('tabNew'), st: $('st'), stOut: $('stOut'), stReset: $('stReset'), sens: $('sens'), sensOut: $('sensOut'),
    snap: $('snap'), fade: $('fade'), applyFx: $('applyFx'), nameOrig: $('nameOrig'), nameUcs: $('nameUcs'),
    ucsFields: $('ucsFields'), ucsCat: $('ucsCat'), ucsFx: $('ucsFx'), ucsCreator: $('ucsCreator'), ucsSource: $('ucsSource'),
    ucsPreview: $('ucsPreview'), langSeg: $('langSeg'), setDefault: $('setDefault'), openExports: $('openExports'),
  };
  const g = el.canvas.getContext('2d');

  const RULER_H = 24;
  const MAX_SAMPLES = 260e6; // ~1 GB of float32 once decoded
  const MAX_BYTES = 400 * 1024 * 1024;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const tick = () => new Promise((r) => setTimeout(r, 0));

  /* ---------- preferences (per-viewer, best effort) ---------- */

  const DEF = {
    st: 0, sens: 10, snap: true, fade: 2, applyFx: true, naming: 'orig',
    ucs: { catId: '', fxName: '', creatorId: '', sourceId: '' },
    exFmt: 'wav24', match: false, eq: null, vol: 1, sidebar: false, spec: false, tc: false, waveH: 210, eqOpen: false, lang: null,
  };
  let prefs = Object.assign({}, DEF, { ucs: Object.assign({}, DEF.ucs) });
  try {
    const saved = JSON.parse(localStorage.getItem('crest.prefs.v2') || 'null');
    if (saved && typeof saved === 'object') {
      prefs = Object.assign(prefs, saved, { ucs: Object.assign({}, DEF.ucs, saved.ucs || {}) });
    }
  } catch {}
  let saveTimer = null;
  function savePrefs() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem('crest.prefs.v2', JSON.stringify(prefs));
      } catch {}
    }, 150);
  }

  /* ---------- app state ---------- */

  const S = {
    info: null, file: null, audio: null, pyr: null, peaks: [], peakIdx: -1, hits: [], hitSel: -1,
    view: { start: 0, end: 1 }, sel: null, loop: false, playing: false, loadId: 0, endTimer: null,
    fps: null, metaText: {}, extract: null, triedFallback: false, meterAll: null, prepared: null, clip: null,
    folder: { dir: '', files: [], shown: [] },
  };

  const eqState = EQ.sanitize(prefs.eq);

  /* ---------- helpers ---------- */

  const duration = () => (S.audio ? S.audio.duration : isFinite(el.media.duration) ? el.media.duration : 0);
  const W = () => el.wave.clientWidth;
  const H = () => el.wave.clientHeight;
  const t2x = (tm) => ((tm - S.view.start) / (S.view.end - S.view.start)) * W();
  const x2t = (x) => S.view.start + (x / W()) * (S.view.end - S.view.start);
  const fmtT = (tm, d) => (prefs.tc && S.info && S.info.kind === 'video' ? A.fmtTimecode(tm, S.fps || 30) : A.fmtTime(tm, d));
  const fmtDb = (v) => (isFinite(v) ? v.toFixed(1) : '−∞');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const baseName = (n) => String(n).replace(/\.[^.]+$/, '');
  const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
  const lastPart = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || p;

  let toastTimer = null;
  function toast(msg, ms = 2200) {
    clearTimeout(toastTimer);
    if (!msg) return el.status.classList.remove('show');
    el.status.textContent = msg;
    el.status.classList.add('show');
    if (ms) toastTimer = setTimeout(() => el.status.classList.remove('show'), ms);
  }

  function stageMsg(msg) {
    el.stageMsg.textContent = msg || '';
    el.stageMsg.classList.toggle('show', !!msg);
  }

  const drawHooks = [];
  const selHooks = [];
  const loadHooks = [];
  const Tools = window.CrestTools;

  /* ---------- audio graph: media -> EQ -> match -> volume -> analyser -> speakers ---------- */

  const G = { ctx: null, src: null, chain: null, vol: null, analyser: null, stage: null, nch: 0 };

  function ensureGraph() {
    if (G.ctx) return;
    try {
      G.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      G.src = G.ctx.createMediaElementSource(el.media);
      G.vol = G.ctx.createGain();
      G.match = G.ctx.createGain();
      G.pre = G.ctx.createGain();
      G.analyser = G.ctx.createAnalyser();
      G.analyser.fftSize = 4096;
      G.analyser.smoothingTimeConstant = 0.82;
      G.analyser.minDecibels = -110;
      G.analyser.maxDecibels = 0;
      rebuildChain();
      applyVolume();
    } catch (err) {
      console.error('audio graph failed', err);
      G.ctx = null;
    }
  }

  function rebuildChain() {
    if (!G.ctx) return;
    try {
      G.src.disconnect();
      if (G.stage) {
        G.stage.split.disconnect();
        G.stage.merge.disconnect();
        G.stage.gains.forEach((x) => x.disconnect());
      }
      G.pre.disconnect();
      if (G.chain) G.chain.out.disconnect();
      G.match.disconnect();
      G.vol.disconnect();
      G.analyser.disconnect();
    } catch {}
    // per-channel mute stage: src -> splitter -> gain[i] -> merger (only for 2+ channels)
    const n = chanCount();
    G.nch = n;
    G.stage = null;
    let head = G.src;
    if (n >= 2 && n <= 32) {
      const split = G.ctx.createChannelSplitter(n);
      const merge = G.ctx.createChannelMerger(n);
      const gains = [];
      for (let i = 0; i < n; i++) {
        const gn = G.ctx.createGain();
        split.connect(gn, i, 0);
        gn.connect(merge, 0, i);
        gains.push(gn);
      }
      G.src.connect(split);
      G.stage = { split, merge, gains };
      head = merge;
    }
    // let multichannel files reach as many speakers as the device has (the rest is down-mixed by the browser)
    try {
      const d = G.ctx.destination;
      d.channelCount = Math.max(1, Math.min(d.maxChannelCount || 2, Math.max(2, n)));
      d.channelInterpretation = 'speakers';
    } catch {}
    head.connect(G.pre);
    G.head = G.pre;
    G.chain = EQ.buildChain(G.ctx, G.pre, eqState);
    G.chain.out.connect(G.match);
    G.match.connect(G.vol);
    G.vol.connect(G.analyser);
    G.analyser.connect(G.ctx.destination);
    applyMute();
    applyMatch();
  }

  /* ---------- channels: layout labels, mute / solo ---------- */

  const CH_LABELS = {
    2: ['L', 'R'],
    3: ['L', 'R', 'C'],
    4: ['L', 'R', 'Ls', 'Rs'],
    5: ['L', 'R', 'C', 'Ls', 'Rs'],
    6: ['L', 'R', 'C', 'LFE', 'Ls', 'Rs'],
    8: ['L', 'R', 'C', 'LFE', 'Lb', 'Rb', 'Ls', 'Rs'],
  };
  const chLabel = (n, i) => (CH_LABELS[n] && CH_LABELS[n][i]) || String(i + 1);
  function chanCount() {
    if (S.audio) return S.audio.channels.length;
    const pa = S.info && S.info.probe && S.info.probe.audio;
    return (pa && pa.channels) || 0;
  }
  const muteKey = () => Array.from({ length: chanCount() }, (_, k) => (S.mute[k] ? 1 : 0)).join('');
  function applyMute() {
    if (!G.ctx || !G.stage) return;
    G.stage.gains.forEach((gn, i) => gn.gain.setTargetAtTime(S.mute[i] ? 0 : 1, G.ctx.currentTime, 0.008));
  }
  function refreshStrip() {
    for (const b of el.chStrip.children) {
      const off = !!S.mute[Number(b.dataset.i)];
      b.classList.toggle('off', off);
      b.setAttribute('aria-pressed', String(off));
    }
  }
  function buildChStrip(n) {
    el.chStrip.textContent = '';
    el.chStrip.hidden = n < 2;
    document.body.classList.toggle('multi', n >= 2);
    for (let i = 0; n >= 2 && i < n; i++) {
      const b = document.createElement('button');
      b.className = 'ch';
      b.dataset.i = String(i);
      b.textContent = chLabel(n, i);
      b.title = t('tChMute', { n: i + 1 });
      el.chStrip.append(b);
    }
    refreshStrip();
  }
  function syncChannels() {
    const n = chanCount();
    if (G.ctx && n !== G.nch) rebuildChain();
    else applyMute();
    buildChStrip(n);
  }
  function toggleMute(i, solo) {
    const n = chanCount();
    if (n < 2 || i < 0 || i >= n) return;
    if (solo) {
      const alone = !S.mute[i] && Array.from({ length: n }, (_, k) => k).every((k) => k === i || S.mute[k]);
      S.mute = alone ? [] : Array.from({ length: n }, (_, k) => k !== i);
    } else {
      S.mute[i] = !S.mute[i];
    }
    applyMute();
    refreshStrip();
    requestDraw();
    schedulePrepare();
  }
  const silenceMuted = (chans) => {
    chans.forEach((c, i) => { if (S.mute[i]) c.fill(0); });
    return chans;
  };
  el.chStrip.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.chStrip.addEventListener('click', (e) => {
    const b = e.target.closest('button.ch');
    if (b) toggleMute(Number(b.dataset.i), e.altKey || e.shiftKey);
  });

  function applyVolume() {
    const v = clamp(prefs.vol, 0, 1);
    if (G.ctx) {
      el.media.volume = 1;
      G.vol.gain.setTargetAtTime(v * v, G.ctx.currentTime, 0.01);
    } else el.media.volume = v;
  }

  function applyRate() {
    const r = A.semitoneRate(prefs.st);
    el.media.preservesPitch = false;
    el.media.defaultPlaybackRate = r;
    el.media.playbackRate = r;
  }

  /* ---------- loading ---------- */

  async function decodeAudio(ab, preferredRate) {
    const rates = [];
    if (preferredRate && preferredRate >= 3000 && preferredRate <= 768000) rates.push(preferredRate);
    if (!rates.includes(48000)) rates.push(48000);
    let lastErr;
    for (let i = 0; i < rates.length; i++) {
      try {
        const ctx = new OfflineAudioContext(1, 1, rates[i]);
        return await ctx.decodeAudioData(i < rates.length - 1 ? ab.slice(0) : ab);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  function teardown() {
    el.media.pause();
    clearTimeout(S.endTimer);
    S.endTimer = null;
    api.cancelJob('proxy');
    api.cancelJob('extract');
    api.cancelJob('clip');
    clearTimeout(prepTimer);
    clearTimeout(clipTimer);
    prepSeq++;
    clipSeq++;
  }

  async function handleResolved(r, opts) {
    if (!r) return;
    if (r.type === 'folder') {
      setFolder(r.dir, r.files);
      setSidebar(true);
      return;
    }
    if (r.listed !== false && r.files) setFolder(r.dir, r.files);
    await openInTab(r.info, opts);
  }

  async function loadFile(info, opts) {
    opts = opts || {};
    const id = ++S.loadId;
    teardown();
    Object.assign(S, {
      info, file: { path: info.path, name: info.name }, audio: null, pyr: null, peaks: [], peakIdx: -1, hits: [], hitSel: -1,
      sel: null, meterAll: null, prepared: null, clip: null, triedFallback: false, extract: null, ready: false, restore: opts.restore || null,
      mute: (opts.restore && opts.restore.mute && opts.restore.mute.slice()) || [],
      fps: (info.probe && info.probe.video && info.probe.video.fps) || null,
    });
    el.media.removeAttribute('src'); // drop the previous picture right away
    el.media.load();
    syncChannels();
    document.body.classList.remove('empty');
    document.body.classList.add('loaded');
    document.body.classList.toggle('has-video', info.kind === 'video');
    el.title.textContent = info.name;
    document.title = info.name + ' — Crest';
    el.dur.textContent = fmtT((info.probe && info.probe.duration) || 0);
    el.meter.textContent = '';
    stageMsg('');
    updateSelInfo();
    applyLoop();
    layoutOverlays();
    requestDraw();
    renderRows();
    scrollToActive();
    toast('');

    let extractP = null;
    S.extract = () => (extractP = extractP || api.extractAudio(info.path));

    startPlayback(id, info, opts);
    startWaveform(id, info);
  }

  async function startPlayback(id, info, opts) {
    let url = info.url;
    try {
      if (info.plan === 'extract') url = (await S.extract()).url;
      else if (info.kind === 'video' && (info.plan === 'transcode' || info.plan === 'audio-fix')) {
        stageMsg(t('previewPrep', { pct: 0 }));
        url = (await api.prepareProxy(info.path, info.plan)).url;
      }
    } catch (err) {
      if (id !== S.loadId) return;
      stageMsg('');
      toast(t(/ffmpeg-missing/.test(String(err && err.message)) ? 'noFfmpeg' : 'previewFail'), 6000);
      return;
    }
    if (id !== S.loadId) return;
    stageMsg('');
    el.media.src = url;
    applyRate();
    el.media.load();
    if (S.restore && S.restore.time > 0) {
      const t0 = S.restore.time;
      el.media.addEventListener(
        'loadedmetadata',
        () => {
          if (id !== S.loadId) return;
          el.media.currentTime = Math.min(t0, (el.media.duration || t0) - 0.01);
          updatePlayhead();
        },
        { once: true }
      );
    }
    if (opts && opts.autoplay) {
      el.media.addEventListener(
        'canplay',
        () => {
          if (id === S.loadId) togglePlay(true);
        },
        { once: true }
      );
    }
  }

  async function startWaveform(id, info) {
    const pa = info.probe && info.probe.audio;
    if (info.probe && !pa) {
      toast(t('noAudio'), 4000);
      return;
    }
    const sr0 = (pa && pa.sampleRate) || 48000;
    const ch0 = (pa && pa.channels) || 2;
    const dur = info.probe && info.probe.duration;
    if ((dur && dur * sr0 * ch0 > MAX_SAMPLES) || (!dur && info.size > MAX_BYTES * 2)) {
      toast(t('tooLarge'), 6000);
      return;
    }
    toast(t('reading'), 0);
    try {
      const useExtract = info.kind === 'video' || info.plan === 'extract' || info.size > MAX_BYTES;
      let buf = null;
      if (!useExtract) {
        try {
          const ab = await (await fetch(info.url)).arrayBuffer();
          if (id !== S.loadId) return;
          const wav = A.sniffWavInfo(ab);
          buf = await decodeAudio(ab, (wav && wav.sampleRate) || (pa && pa.sampleRate));
        } catch (e) {
          if (id !== S.loadId) return;
          buf = null; // fall through to the ffmpeg route
        }
      }
      if (!buf) {
        const x = await S.extract();
        if (id !== S.loadId) return;
        const ab = await (await fetch(x.url)).arrayBuffer();
        if (id !== S.loadId) return;
        const wav = A.sniffWavInfo(ab);
        buf = await decodeAudio(ab, wav && wav.sampleRate);
      }
      if (id !== S.loadId) return;

      const channels = [];
      for (let i = 0; i < buf.numberOfChannels; i++) channels.push(buf.getChannelData(i));
      S.audio = { channels, sampleRate: buf.sampleRate, length: buf.length, duration: buf.duration };
      S.pyr = A.buildPyramid(channels, 256);
      syncChannels();
      await tick();
      if (id !== S.loadId) return;
      S.hits = A.detectHits(channels, buf.sampleRate, { riseDb: prefs.sens });
      el.dur.textContent = fmtT(buf.duration);
      fitView();
      toast('');
      S.ready = true;
      if (S.restore && S.restore.sel) setSel(S.restore.sel.start, S.restore.sel.end);
      S.restore = null;
      updateMeter();
      if (!S.meterAll) S.meterAll = A.loudness(S.audio.channels, S.audio.sampleRate, 0, S.audio.length);
      const tbn = tabById(activeTab);
      if (tbn) tbn.lufs = S.meterAll.lufs;
      applyMatch();
      for (const fn of loadHooks) fn('ready');
    } catch (err) {
      if (id !== S.loadId) return;
      console.error(err);
      S.audio = null;
      toast(t('noDraw'), 5000);
    }
    requestDraw();
  }

  /* ---------- view (zoom / pan) ---------- */

  function setView(start, end) {
    const dur = duration();
    if (!dur) return;
    const minSpan = S.audio ? Math.max(0.0005, W() / 8 / S.audio.sampleRate) : 0.05;
    const span = Math.min(Math.max(end - start, minSpan), dur);
    start = clamp(start, 0, dur - span);
    S.view = { start, end: start + span };
    requestDraw();
    layoutOverlays();
  }
  const fitView = () => setView(0, duration());
  function ensureVisible(tm) {
    if (tm >= S.view.start && tm <= S.view.end) return;
    const span = S.view.end - S.view.start;
    setView(tm - span / 2, tm + span / 2);
  }
  function zoomToSelection() {
    if (!S.sel) return fitView();
    const pad = (S.sel.end - S.sel.start) * 0.06;
    setView(S.sel.start - pad, S.sel.end + pad);
  }

  /* ---------- drawing ---------- */

  const css = getComputedStyle(document.documentElement);
  const COLOR = {
    wave: css.getPropertyValue('--wave').trim(),
    grid: css.getPropertyValue('--grid').trim(),
    muted: css.getPropertyValue('--muted').trim(),
    accent: css.getPropertyValue('--accent').trim(),
  };
  const FONT = getComputedStyle(document.body).fontFamily;

  let drawQueued = false;
  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      draw();
    });
  }

  function drawRuler(dpr, w) {
    const dur = duration();
    if (!dur) return;
    const span = S.view.end - S.view.start;
    const raw = span / (W() / 90);
    const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const step = steps.find((s) => s >= raw) || 3600;
    const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
    g.font = `${10 * dpr}px ${FONT}`;
    g.textBaseline = 'top';
    g.textAlign = 'left';
    g.fillStyle = COLOR.grid;
    g.fillRect(0, Math.round(RULER_H * dpr) - 1, w, 1);
    for (let k = Math.ceil(S.view.start / step); k * step <= S.view.end; k++) {
      const tm = k * step;
      const x = Math.round(t2x(tm) * dpr);
      g.fillStyle = COLOR.grid;
      g.fillRect(x, Math.round((RULER_H - 7) * dpr), Math.max(1, Math.round(dpr)), Math.round(7 * dpr));
      g.fillStyle = COLOR.muted;
      g.fillText(A.fmtTime(tm, decimals), x + 4 * dpr, 6 * dpr);
    }
  }

  function drawWave(dpr, w, h) {
    const chans = S.audio.channels;
    const perLane = chans.length <= 8;
    const lanes = perLane ? chans.length : 1;
    const top = (RULER_H + 6) * dpr;
    const bottom = h - 8 * dpr;
    const laneH = (bottom - top) / lanes;
    const sr = S.audio.sampleRate;
    const s0 = S.view.start * sr;
    const s1 = S.view.end * sr;
    const line = Math.max(1, Math.round(dpr));
    for (let lane = 0; lane < lanes; lane++) {
      const mid = top + laneH * (lane + 0.5);
      const amp = laneH * 0.5 * 0.96;
      const list = perLane ? [lane] : chans.map((_, i) => i);
      g.fillStyle = COLOR.grid;
      g.fillRect(0, Math.round(mid), w, line);
      const cols = A.columns(chans, S.pyr, list, s0, s1, w);
      g.fillStyle = COLOR.wave;
      g.globalAlpha = perLane && S.mute[lane] ? 0.22 : 1;
      for (let x = 0; x < w; x++) {
        const mx = cols.max[x];
        const mn = cols.min[x];
        if (mx < mn) continue;
        const y0 = mid - mx * amp;
        const y1 = mid - mn * amp;
        g.fillRect(x, y0, 1, Math.max(line, y1 - y0));
      }
      g.globalAlpha = 1;
    }
  }

  // inferno-like colour ramp
  const LUT = (() => {
    const stops = [[0, [0, 0, 4]], [0.2, [40, 11, 84]], [0.42, [120, 28, 109]], [0.62, [188, 55, 84]], [0.8, [237, 105, 37]], [0.92, [251, 180, 26]], [1, [252, 255, 164]]];
    const out = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const v = i / 255;
      let k = 0;
      while (k < stops.length - 2 && v > stops[k + 1][0]) k++;
      const [a, ca] = stops[k];
      const [b, cb] = stops[k + 1];
      const f = clamp((v - a) / (b - a), 0, 1);
      for (let c = 0; c < 3; c++) out[i * 3 + c] = ca[c] + (cb[c] - ca[c]) * f;
    }
    return out;
  })();
  const specCanvas = document.createElement('canvas');
  let specKey = '';

  function drawSpectrogram(dpr, w) {
    const top = RULER_H + 6;
    const hh = Math.max(8, H() - top - 4);
    const cols = Math.max(1, Math.round(W() / 2));
    const rows = Math.max(1, Math.round(hh / 2));
    const sr = S.audio.sampleRate;
    const s0 = S.view.start * sr;
    const s1 = S.view.end * sr;
    const maxHz = Math.min(20000, sr / 2);
    const key = [S.loadId, Math.round(s0), Math.round(s1), cols, rows].join();
    if (key !== specKey) {
      const data = A.spectrogram(S.audio.channels, sr, s0, s1, cols, rows, { fftSize: cols <= 700 ? 2048 : 1024, maxHz });
      specCanvas.width = cols;
      specCanvas.height = rows;
      const sctx = specCanvas.getContext('2d');
      const img = sctx.createImageData(cols, rows);
      for (let i = 0; i < data.length; i++) {
        const v = data[i] * 3;
        img.data[i * 4] = LUT[v];
        img.data[i * 4 + 1] = LUT[v + 1];
        img.data[i * 4 + 2] = LUT[v + 2];
        img.data[i * 4 + 3] = 255;
      }
      sctx.putImageData(img, 0, 0);
      specKey = key;
    }
    g.imageSmoothingEnabled = true;
    g.drawImage(specCanvas, 0, top * dpr, w, hh * dpr);
    g.font = `${10 * dpr}px ${FONT}`;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    for (const [f, label] of [[100, '100'], [1000, '1k'], [10000, '10k']]) {
      if (f >= maxHz) continue;
      const r = (rows * Math.log(f / maxHz)) / Math.log(30 / maxHz);
      const y = (top + (r / rows) * hh) * dpr;
      g.fillStyle = 'rgba(255,255,255,.22)';
      g.fillRect(0, Math.round(y), 8 * dpr, Math.max(1, Math.round(dpr)));
      g.fillStyle = 'rgba(255,255,255,.75)';
      g.fillText(label + ' Hz', 12 * dpr, y);
    }
  }

  function drawHitMarks(dpr) {
    if (!S.hits.length) return;
    const sr = S.audio.sampleRate;
    const y0 = (RULER_H + 1) * dpr;
    const sz = 5 * dpr;
    g.fillStyle = COLOR.accent;
    g.globalAlpha = 0.85;
    let lastX = -1e9;
    for (const h of S.hits) {
      const tm = h.start / sr;
      if (tm < S.view.start || tm > S.view.end) continue;
      const x = t2x(tm) * dpr;
      if (x - lastX < 3 * dpr) continue;
      lastX = x;
      g.beginPath();
      g.moveTo(x - sz, y0);
      g.lineTo(x + sz, y0);
      g.lineTo(x, y0 + sz * 1.4);
      g.closePath();
      g.fill();
    }
    g.globalAlpha = 1;
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(W() * dpr));
    const h = Math.max(1, Math.round(H() * dpr));
    if (el.canvas.width !== w || el.canvas.height !== h) {
      el.canvas.width = w;
      el.canvas.height = h;
    }
    g.clearRect(0, 0, w, h);
    drawRuler(dpr, w);
    if (!S.audio) return;
    if (prefs.spec) drawSpectrogram(dpr, w);
    else drawWave(dpr, w, h);
    drawHitMarks(dpr);
    for (const fn of drawHooks) fn(g, dpr, w, h);
  }

  function updatePlayhead() {
    const tm = el.media.currentTime || 0;
    const x = t2x(tm);
    el.playhead.style.display = x < -1 || x > W() + 1 ? 'none' : 'block';
    el.playhead.style.transform = `translateX(${Math.round(x)}px)`;
    el.cur.textContent = fmtT(tm);
  }

  function layoutOverlays() {
    updatePlayhead();
    if (!S.sel) {
      el.selection.style.display = 'none';
      return;
    }
    const w = W();
    const x0 = Math.max(t2x(S.sel.start), -5000);
    const x1 = Math.min(t2x(S.sel.end), w + 5000);
    el.selection.style.display = 'block';
    el.selection.style.left = x0 + 'px';
    el.selection.style.width = Math.max(2, x1 - x0) + 'px';
    el.selection.classList.toggle('narrow', x1 - x0 < 130);
  }

  new ResizeObserver(() => {
    requestDraw();
    layoutOverlays();
  }).observe(el.wave);

  /* ---------- meter and processing chip ---------- */

  let meterTimer = null;
  function renderMeter(r) {
    el.meter.innerHTML = `<b>${t('mPeak')}</b> ${fmtDb(r.peakDb)} &nbsp;<b>${t('mRms')}</b> ${fmtDb(r.rmsDb)} &nbsp;<b>${t('mLufs')}</b> ${fmtDb(r.lufs)}`;
    S.lastMeter = r;
  }
  function updateMeter() {
    clearTimeout(meterTimer);
    if (!S.audio) {
      el.meter.textContent = '';
      return;
    }
    meterTimer = setTimeout(() => {
      if (!S.audio) return;
      const sr = S.audio.sampleRate;
      let r;
      if (S.sel) r = A.loudness(S.audio.channels, sr, Math.round(S.sel.start * sr), Math.round(S.sel.end * sr));
      else r = S.meterAll || (S.meterAll = A.loudness(S.audio.channels, sr, 0, S.audio.length));
      renderMeter(r);
    }, S.sel ? 120 : 0);
  }

  const processingActive = () => prefs.applyFx && (prefs.st !== 0 || EQ.isActive(eqState));
  // Loudness matching: files play at the level of the first tab (or -23 LUFS when there is only one), never past 0 dBFS.
  function matchGainDb() {
    if (!prefs.match || !S.meterAll || !isFinite(S.meterAll.lufs)) return 0;
    const first = tabsList.length >= 2 ? tabsList[0] : null;
    const ref = first && first.lufs != null && isFinite(first.lufs) ? first.lufs : -23;
    return clamp(A.normalizeGainDb('lufs', ref, S.meterAll, 0).gainDb, -24, 12);
  }
  function applyMatch() {
    S.matchDb = matchGainDb();
    if (G.ctx && G.match) G.match.gain.setTargetAtTime(Math.pow(10, S.matchDb / 20), G.ctx.currentTime, 0.01);
    el.matchBtn.setAttribute('aria-pressed', String(!!prefs.match));
    updateFx();
  }
  function setMatch(on) {
    prefs.match = on;
    savePrefs();
    applyMatch();
    toast(on ? t('match') + ' · ' + (S.matchDb >= 0 ? '+' : '−') + Math.abs(S.matchDb || 0).toFixed(1) + ' dB' : '', 1400);
  }
  el.matchBtn.addEventListener('click', () => setMatch(!prefs.match));
  el.abBtn.addEventListener('click', () => abToggle());

  function updateFx() {
    const parts = [];
    if (prefs.match && Math.abs(S.matchDb || 0) >= 0.05) parts.push((S.matchDb > 0 ? '+' : '−') + Math.abs(S.matchDb).toFixed(1) + ' dB match');
    if (EQ.isActive(eqState)) parts.push('EQ');
    if (prefs.st !== 0) parts.push((prefs.st > 0 ? '+' : '−') + Math.abs(prefs.st).toFixed(1) + ' st');
    let s = parts.join(' · ');
    if (s && !prefs.applyFx) s += ` (${t('fxNotExported')})`;
    el.fx.textContent = s;
  }

  /* ---------- selection ---------- */

  function updateSelInfo() {
    el.gripText.textContent = S.sel ? t('gripSel') : t('gripFile');
    el.grip.classList.toggle('hot', !!S.sel);
  }
  const applyLoop = () => {
    el.media.loop = S.loop && !S.sel;
  };

  function onSelectionChanged() {
    layoutOverlays();
    updateSelInfo();
    applyLoop();
    updateMeter();
    schedulePrepare();
    scheduleClip();
    for (const fn of selHooks) fn();
  }
  function setSel(a, b, fromHit) {
    const dur = duration();
    S.sel = { start: clamp(a, 0, dur), end: clamp(b, 0, dur) };
    if (fromHit == null) S.hitSel = -1;
    onSelectionChanged();
  }
  function clearSel() {
    if (!S.sel) return;
    S.sel = null;
    S.hitSel = -1;
    onSelectionChanged();
  }

  /* ---------- playback ---------- */

  function seek(tm, reveal) {
    tm = clamp(tm, 0, duration() || 0);
    el.media.currentTime = tm;
    if (reveal) ensureVisible(tm);
    updatePlayhead();
  }

  function togglePlay(forcePlay) {
    if (!S.file) return;
    const m = el.media;
    if (!m.paused && !forcePlay) {
      m.pause();
      return;
    }
    ensureGraph();
    if (G.ctx && G.ctx.state === 'suspended') G.ctx.resume();
    if (S.sel) {
      if (m.currentTime < S.sel.start - 0.001 || m.currentTime >= S.sel.end - 0.01) m.currentTime = S.sel.start;
    } else if (m.ended || m.currentTime >= duration() - 0.01) m.currentTime = 0;
    m.play().catch(() => toast(t('cantPlay')));
  }

  function endOfSelection() {
    clearTimeout(S.endTimer);
    S.endTimer = null;
    if (!S.sel) return;
    if (!S.loop) el.media.pause();
    el.media.currentTime = S.sel.start;
  }

  function followPlayhead(tm) {
    const span = S.view.end - S.view.start;
    if (span >= duration() - 1e-6) return;
    if (tm > S.view.end - span * 0.02 || tm < S.view.start) setView(tm - span * 0.1, tm + span * 0.9);
  }

  function tickLoop() {
    if (!S.playing) return;
    const tm = el.media.currentTime;
    if (S.sel) {
      const rem = S.sel.end - tm;
      if (rem <= 0) endOfSelection();
      else if (rem < 0.06 * Math.max(1, el.media.playbackRate) && !S.endTimer) {
        S.endTimer = setTimeout(() => {
          S.endTimer = null;
          if (S.playing && S.sel && el.media.currentTime >= S.sel.end - 0.03) endOfSelection();
        }, (rem * 1000) / Math.max(0.25, el.media.playbackRate));
      }
    }
    followPlayhead(tm);
    updatePlayhead();
    requestAnimationFrame(tickLoop);
  }

  el.media.addEventListener('play', () => {
    S.playing = true;
    el.play.classList.add('is-playing');
    requestAnimationFrame(tickLoop);
  });
  el.media.addEventListener('pause', () => {
    S.playing = false;
    el.play.classList.remove('is-playing');
    updatePlayhead();
  });
  el.media.addEventListener('seeked', updatePlayhead);
  el.media.addEventListener('loadedmetadata', () => {
    applyRate();
    if (!S.audio) {
      el.dur.textContent = fmtT(el.media.duration);
      fitView();
    }
  });
  el.media.addEventListener('error', async () => {
    const info = S.info;
    if (!info || !el.media.getAttribute('src')) return;
    if (S.triedFallback) return toast(t('cantFormat'), 4000);
    S.triedFallback = true;
    const id = S.loadId;
    try {
      let url;
      if (info.kind === 'video') {
        stageMsg(t('previewPrep', { pct: 0 }));
        url = (await api.prepareProxy(info.path, 'transcode')).url;
      } else url = (await S.extract()).url;
      if (id !== S.loadId) return;
      stageMsg('');
      el.media.src = url;
      applyRate();
    } catch {
      stageMsg('');
      toast(t('cantFormat'), 4000);
    }
  });

  /* ---------- hits ---------- */

  function selectHit(i) {
    const h = S.hits[i];
    const sr = S.audio.sampleRate;
    S.hitSel = i;
    setSel(h.start / sr, h.end / sr, i);
    const span = S.view.end - S.view.start;
    if (h.start / sr < S.view.start || h.end / sr > S.view.end) setView(h.start / sr - span * 0.1, h.start / sr + span * 0.9);
    seek(h.start / sr);
    toast(t('hitN', { n: i + 1, m: S.hits.length }), 1400);
    if (S.playing) togglePlay(true);
  }

  function gotoHit(dir) {
    if (!S.audio) return toast(t('noWave'));
    if (!S.hits.length) return toast(t('noHits'));
    const sr = S.audio.sampleRate;
    const cur = el.media.currentTime;
    let i;
    if (S.hitSel >= 0 && S.sel) i = S.hitSel + dir;
    else if (dir > 0) i = S.hits.findIndex((h) => h.start / sr > cur + 0.001);
    else {
      i = -1;
      for (let k = S.hits.length - 1; k >= 0; k--) {
        if (S.hits[k].start / sr < cur - 0.001) {
          i = k;
          break;
        }
      }
    }
    if (i < 0 || i >= S.hits.length) return toast(t('hitN', { n: Math.max(1, S.hitSel + 1), m: S.hits.length }), 1200);
    selectHit(i);
  }

  /* ---------- pointer: seek, select, resize ---------- */

  let drag = null;
  el.wave.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !S.file) return;
    const handle = e.target.closest('.handle');
    if (handle && S.sel) {
      e.preventDefault();
      e.stopPropagation();
      drag = { type: 'resize', anchor: handle.dataset.side === 'l' ? S.sel.end : S.sel.start };
      return;
    }
    if (e.target.closest('#selection')) return;
    e.preventDefault();
    drag = { type: 'new', x0: e.clientX - el.wave.getBoundingClientRect().left, moved: false };
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const r = el.wave.getBoundingClientRect();
    const x = clamp(e.clientX - r.left, 0, r.width);
    if (drag.type === 'resize') {
      const tm = x2t(x);
      setSel(Math.min(drag.anchor, tm), Math.max(drag.anchor, tm));
      return;
    }
    if (!drag.moved && Math.abs(x - drag.x0) < 4) return;
    if (!S.audio) return;
    drag.moved = true;
    const a = x2t(drag.x0);
    const b = x2t(x);
    setSel(Math.min(a, b), Math.max(a, b));
  });
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.type === 'new' && !d.moved) {
      clearSel();
      seek(x2t(d.x0));
      return;
    }
    if (!S.sel || S.sel.end - S.sel.start < 0.002) clearSel();
    else seek(S.sel.start);
  });
  el.selection.addEventListener('click', (e) => seek(x2t(e.clientX - el.wave.getBoundingClientRect().left)));

  el.wave.addEventListener(
    'wheel',
    (e) => {
      if (!S.file || !duration()) return;
      e.preventDefault();
      const span = S.view.end - S.view.start;
      if (e.ctrlKey || e.metaKey) {
        const x = e.clientX - el.wave.getBoundingClientRect().left;
        const anchor = x2t(x);
        const newSpan = span * Math.exp(clamp(e.deltaY, -120, 120) * 0.0025);
        setView(anchor - (x / W()) * newSpan, anchor - (x / W()) * newSpan + newSpan);
      } else {
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        setView(S.view.start + (d / W()) * span, S.view.end + (d / W()) * span);
      }
    },
    { passive: false }
  );

  /* ---------- exporting ---------- */

  function snappedRegion(aSec, bSec) {
    const sr = S.audio.sampleRate;
    const chs = S.audio.channels;
    let a = clamp(Math.round(aSec * sr), 0, S.audio.length);
    let b = clamp(Math.round(bSec * sr), 0, S.audio.length);
    if (prefs.snap) {
      a = A.snapZero(chs, a, sr, 3);
      b = A.snapZero(chs, b, sr, 3);
    }
    if (b <= a) b = Math.min(S.audio.length, a + 1);
    return [a, b];
  }

  function renderChannelsSync(a, b) {
    const chans = silenceMuted(S.audio.channels.map((c) => c.slice(a, b)));
    A.applyFade(chans, S.audio.sampleRate, prefs.fade, prefs.fade);
    return chans;
  }

  // Cut, then (if asked) run through varispeed + EQ with the same graph the player uses.
  // Varispeed + EQ through an offline copy of the player's graph.
  async function processChans(chans, sr) {
    const rate = A.semitoneRate(prefs.st);
    const inLen = chans[0].length;
    const outLen = Math.max(1, Math.ceil(inLen / rate));
    const oc = new OfflineAudioContext(chans.length, outLen, sr);
    const buf = oc.createBuffer(chans.length, inLen, sr);
    chans.forEach((c, i) => buf.copyToChannel(c, i));
    const src = oc.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const chain = EQ.buildChain(oc, src, eqState);
    chain.out.connect(oc.destination);
    src.start();
    const rendered = await oc.startRendering();
    const out = [];
    for (let i = 0; i < rendered.numberOfChannels; i++) out.push(rendered.getChannelData(i).slice());
    return out;
  }

  async function renderChannels(a, b, noFade) {
    const sr = S.audio.sampleRate;
    let chans = silenceMuted(S.audio.channels.map((c) => c.slice(a, b)));
    if (processingActive()) chans = await processChans(chans, sr);
    if (!noFade) A.applyFade(chans, sr, prefs.fade, prefs.fade);
    return chans;
  }

  // Decodes any file of the folder (batch processing); uses ffmpeg for what Chromium cannot read.
  async function loadBufferFor(filePath) {
    const r = await api.resolve(filePath, { skipList: true });
    if (!r || r.type !== 'file') throw new Error('unreadable');
    const info = r.info;
    const pa = info.probe && info.probe.audio;
    if (info.probe && !pa) throw new Error('no audio');
    let buf = null;
    if (!(info.kind === 'video' || info.plan === 'extract' || info.size > MAX_BYTES)) {
      try {
        const ab = await (await fetch(info.url)).arrayBuffer();
        const wav = A.sniffWavInfo(ab);
        buf = await decodeAudio(ab, (wav && wav.sampleRate) || (pa && pa.sampleRate));
      } catch {
        buf = null;
      }
    }
    if (!buf) {
      const x = await api.extractAudio(info.path);
      const ab = await (await fetch(x.url)).arrayBuffer();
      const wav = A.sniffWavInfo(ab);
      buf = await decodeAudio(ab, wav && wav.sampleRate);
    }
    const channels = [];
    for (let i = 0; i < buf.numberOfChannels; i++) channels.push(buf.getChannelData(i));
    return { info, channels, sampleRate: buf.sampleRate };
  }

  const fxSuffix = () => {
    if (!processingActive()) return '';
    let s = '';
    if (EQ.isActive(eqState)) s += '_EQ';
    if (prefs.st !== 0) s += '_' + (prefs.st > 0 ? '+' : '') + prefs.st.toFixed(1) + 'st';
    return s;
  };

  function exportName(a, b, idx) {
    const sr = S.audio.sampleRate;
    const pad = (n) => String(n).padStart(2, '0');
    let name;
    if (prefs.naming === 'ucs') name = A.ucsName(prefs.ucs, idx);
    else if (idx != null) name = `${baseName(S.file.name)}_hit${pad(idx)}`;
    else name = `${baseName(S.file.name)}_${A.stamp(a / sr)}-${A.stamp(b / sr)}`;
    return name + fxSuffix() + '.wav';
  }

  function exportKey() {
    return JSON.stringify([
      S.file.path, S.sel && +S.sel.start.toFixed(5), S.sel && +S.sel.end.toFixed(5), prefs.snap, prefs.fade,
      processingActive() ? [prefs.st, eqState.bands, eqState.out, eqState.bypass] : 0,
      prefs.naming, prefs.naming === 'ucs' ? prefs.ucs : 0, muteKey(),
    ]);
  }

  // Processed exports are rendered a moment after the selection settles, so the drag can start instantly.
  let prepTimer = null;
  let prepSeq = 0;
  function schedulePrepare(delay) {
    clearTimeout(prepTimer);
    S.prepared = null;
    const seq = ++prepSeq;
    if (!S.audio || !S.sel || !processingActive()) {
      el.grip.classList.remove('busy');
      return;
    }
    el.grip.classList.add('busy');
    prepTimer = setTimeout(async () => {
      try {
        const key = exportKey();
        const [a, b] = snappedRegion(S.sel.start, S.sel.end);
        const chans = await renderChannels(a, b);
        if (seq !== prepSeq) return;
        S.prepared = { key, bytes: A.encodeWav(chans, S.audio.sampleRate), name: exportName(a, b) };
        el.grip.classList.remove('busy');
      } catch (err) {
        console.error(err);
        if (seq === prepSeq) el.grip.classList.remove('busy');
      }
    }, delay == null ? 280 : delay);
  }

  function dragPath() {
    if (!S.file) return null;
    if (!S.sel || !S.audio) return S.file.path;
    let p;
    if (processingActive()) {
      if (S.prepared && S.prepared.key === exportKey()) p = api.writeExportSync(S.prepared.name, S.prepared.bytes);
      else {
        toast(t('preparing'));
        schedulePrepare(0);
        return null;
      }
    } else {
      const [a, b] = snappedRegion(S.sel.start, S.sel.end);
      p = api.writeExportSync(exportName(a, b), A.encodeWav(renderChannelsSync(a, b), S.audio.sampleRate));
    }
    if (!p) toast(t('writeFail'));
    return p;
  }

  function onDragStart(e) {
    e.preventDefault(); // hand the drag to the OS so it carries a real file
    const p = dragPath();
    if (p) api.startDrag(p);
  }
  el.selection.addEventListener('dragstart', onDragStart);
  el.grip.addEventListener('dragstart', onDragStart);

  // Video clip: cut by ffmpeg in the background, then it's ready to drag.
  let clipTimer = null;
  let clipSeq = 0;
  const clipKey = () => S.info.path + '|' + S.sel.start.toFixed(3) + '|' + S.sel.end.toFixed(3);
  function scheduleClip() {
    clearTimeout(clipTimer);
    api.cancelJob('clip');
    S.clip = null;
    const seq = ++clipSeq;
    const ok = S.info && S.info.kind === 'video' && S.info.probe && S.info.probe.video && S.sel;
    el.gripVideo.hidden = !ok;
    if (!ok) return;
    if (S.sel.end - S.sel.start > 300) {
      el.gripVideoText.textContent = t('clipTooLong');
      el.gripVideo.classList.add('busy');
      return;
    }
    el.gripVideoText.textContent = t('gripVideoPrep', { pct: 0 });
    el.gripVideo.classList.add('busy');
    clipTimer = setTimeout(async () => {
      const key = clipKey();
      try {
        const r = await api.renderClip(S.info.path, S.sel.start, S.sel.end);
        if (seq !== clipSeq) return;
        S.clip = { path: r.path, key };
        el.gripVideoText.textContent = t('gripVideo');
        el.gripVideo.classList.remove('busy');
      } catch (err) {
        if (seq !== clipSeq) return;
        el.gripVideoText.textContent = t('previewFail');
      }
    }, 900);
  }
  el.gripVideo.addEventListener('dragstart', (e) => {
    e.preventDefault();
    if (!S.sel || !S.clip || S.clip.key !== clipKey()) return toast(t('preparing'));
    const name = `${baseName(S.file.name)}_${A.stamp(S.sel.start)}-${A.stamp(S.sel.end)}.mp4`;
    const p = api.copyExportSync(S.clip.path, name);
    if (p) api.startDrag(p);
    else toast(t('writeFail'));
  });

  let exporting = false;
  // Exports the selection (snapped, faded) or, with nothing selected, the whole file, in the chosen format.
  async function exportCurrent() {
    if (!S.audio) return toast(t('noWave'));
    if (exporting) return;
    const sr = S.audio.sampleRate;
    const whole = !S.sel;
    const [a, b] = whole ? [0, S.audio.length] : snappedRegion(S.sel.start, S.sel.end);
    exporting = true;
    try {
      toast(t('exporting'), 0);
      const chans = await renderChannels(a, b, whole);
      const name = whole ? baseName(S.file.name) + fxSuffix() + '.wav' : exportName(a, b);
      const saved = await api.exportAs(name, A.encodeWav(chans, sr), prefs.exFmt, chans.length);
      toast(saved ? t('saved') : '');
    } catch (err) {
      console.error(err);
      toast(t('writeFail'));
    } finally {
      exporting = false;
    }
  }

  async function exportAllHits() {
    if (!S.audio) return toast(t('noWave'));
    if (!S.hits.length) return toast(t('noHits'));
    if (exporting) return;
    const dir = await api.chooseExportDir();
    if (!dir) return;
    exporting = true;
    let last = null;
    try {
      for (let i = 0; i < S.hits.length; i++) {
        toast(t('exportingN', { n: i + 1, m: S.hits.length }), 0);
        const sr = S.audio.sampleRate;
        const [a, b] = snappedRegion(S.hits[i].start / sr, S.hits[i].end / sr);
        const chans = await renderChannels(a, b);
        last = await api.exportAs(exportName(a, b, i + 1), A.encodeWav(chans, sr), prefs.exFmt, chans.length, dir);
        await tick();
      }
      toast(t('savedN', { n: S.hits.length }), 3500);
      if (last) api.reveal(last);
    } catch (err) {
      console.error(err);
      toast(t('writeFail'));
    } finally {
      exporting = false;
    }
  }

  /* ---------- folder list ---------- */

  const ROW_H = 30;
  const folderHooks = [];
  function setFolder(dir, files) {
    S.folder = { dir, files, shown: files };
    el.filter.value = '';
    el.folderName.textContent = `${lastPart(dir)} · ${t('folderCount', { n: files.length })}`;
    el.folderName.title = dir;
    applyFilter();
    for (const fn of folderHooks) fn();
  }
  function applyFilter() {
    const q = el.filter.value.trim().toLowerCase();
    const f = S.folder.files;
    S.folder.shown = q ? f.filter((x) => x.name.toLowerCase().includes(q) || (S.metaText[x.path] || '').includes(q)) : f;
    el.listSpacer.style.height = S.folder.shown.length * ROW_H + 'px';
    el.listEmpty.hidden = S.folder.shown.length > 0;
    renderRows();
  }
  function renderRows() {
    if (el.side.hidden) return;
    const shown = S.folder.shown;
    const st = el.list.scrollTop;
    const h = el.list.clientHeight || 400;
    const i0 = Math.max(0, Math.floor(st / ROW_H) - 4);
    const i1 = Math.min(shown.length, Math.ceil((st + h) / ROW_H) + 4);
    let html = '';
    for (let i = i0; i < i1; i++) {
      const f = shown[i];
      const active = S.file && S.file.path === f.path ? ' active' : '';
      html += `<div class="row-file${active}" data-i="${i}" title="${esc(f.name)}"><span class="n">${esc(f.name)}</span><span class="s">${fmtSize(f.size)}</span></div>`;
    }
    el.listRows.innerHTML = html;
    el.listRows.style.transform = `translateY(${i0 * ROW_H}px)`;
  }
  function scrollToActive() {
    if (el.side.hidden || !S.file) return;
    const i = S.folder.shown.findIndex((f) => f.path === S.file.path);
    if (i < 0) return;
    const top = i * ROW_H;
    if (top < el.list.scrollTop || top + ROW_H > el.list.scrollTop + el.list.clientHeight) el.list.scrollTop = Math.max(0, top - el.list.clientHeight / 2);
    renderRows();
  }
  async function openFromList(f, newTab) {
    const r = await api.resolve(f.path, { skipList: true });
    if (r) handleResolved(r, { autoplay: true, newTab: !!newTab });
  }
  function navigate(delta) {
    const shown = S.folder.shown;
    if (!shown.length) return;
    let i = S.file ? shown.findIndex((f) => f.path === S.file.path) : -1;
    i = i < 0 ? (delta > 0 ? 0 : shown.length - 1) : clamp(i + delta, 0, shown.length - 1);
    openFromList(shown[i]);
  }
  el.list.addEventListener('scroll', renderRows);
  el.listRows.addEventListener('click', (e) => {
    const row = e.target.closest('.row-file');
    if (row) openFromList(S.folder.shown[Number(row.dataset.i)], e.ctrlKey || e.metaKey);
  });
  el.filter.addEventListener('input', applyFilter);
  function setSidebar(on) {
    prefs.sidebar = on;
    el.side.hidden = !on;
    el.folderBtn.setAttribute('aria-pressed', String(on));
    savePrefs();
    renderRows();
    scrollToActive();
  }


  /* ---------- tabs ---------- */

  const tabsList = [];
  let activeTab = null;
  let tabSeq = 0;
  const tabById = (id) => tabsList.find((x) => x.id === id);

  function saveTabState() {
    const tb = tabById(activeTab);
    if (tb && S.file) {
      tb.time = el.media.currentTime || 0;
      tb.sel = S.sel ? { start: S.sel.start, end: S.sel.end } : null;
      tb.mute = S.mute.slice();
    }
  }
  function renderTabs() {
    el.tabs.hidden = !tabsList.length;
    applyMatch();
    el.abBtn.hidden = tabsList.length < 2;
    document.body.classList.toggle('has-tabs', tabsList.length > 0);
    el.tabList.textContent = '';
    for (const tb of tabsList) {
      const d = document.createElement('div');
      d.className = 'tab' + (tb.id === activeTab ? ' on' : '');
      d.dataset.id = String(tb.id);
      d.setAttribute('role', 'tab');
      d.title = tb.path;
      const n = document.createElement('span');
      n.className = 'tab-name';
      n.textContent = tb.name;
      const x = document.createElement('button');
      x.className = 'tab-x';
      x.textContent = '×';
      x.title = t('tCloseTab');
      x.dataset.close = String(tb.id);
      d.append(n, x);
      el.tabList.append(d);
    }
    const on = el.tabList.querySelector('.tab.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  async function openInTab(info, opts) {
    opts = opts || {};
    saveTabState();
    const cur = tabById(activeTab);
    let tb = tabsList.find((x) => x.path === info.path);
    let restore = null;
    if (tb) {
      if (tb.id !== activeTab) restore = { time: tb.time, sel: tb.sel, mute: tb.mute };
    } else if (opts.newTab || !cur) {
      tb = { id: ++tabSeq, path: info.path, name: info.name, time: 0, sel: null, mute: [], lufs: null };
      tabsList.push(tb);
    } else {
      tb = cur;
      Object.assign(tb, { path: info.path, name: info.name, time: 0, sel: null, mute: [], lufs: null });
    }
    if (tb.id !== activeTab) prevTab = activeTab;
    activeTab = tb.id;
    renderTabs();
    await loadFile(info, Object.assign({}, opts, { restore }));
  }
  let prevTab = null;
  async function abToggle() {
    const other = tabById(prevTab);
    if (!other || other.id === activeTab || !S.file) return;
    const cur = el.media.currentTime || 0;
    const wasPlaying = !el.media.paused;
    other.time = cur;
    await activateTab(other.id);
    if (wasPlaying) togglePlay(true);
  }
  async function activateTab(id) {
    if (id === activeTab) return;
    prevTab = activeTab;
    const tb = tabById(id);
    if (!tb) return;
    saveTabState();
    const r = await api.resolve(tb.path, { skipList: true });
    if (!r || r.type !== 'file') {
      toast(t('previewFail'), 4000);
      closeTab(id);
      return;
    }
    activeTab = id;
    renderTabs();
    await loadFile(r.info, { restore: { time: tb.time, sel: tb.sel, mute: tb.mute } });
  }
  function showEmpty() {
    S.loadId++;
    teardown();
    el.media.pause();
    el.media.removeAttribute('src');
    el.media.load();
    Object.assign(S, { info: null, file: null, audio: null, pyr: null, peaks: [], hits: [], hitSel: -1, sel: null, prepared: null, clip: null, ready: false, restore: null, extract: null, mute: [] });
    syncChannels();
    document.body.classList.remove('loaded', 'has-video');
    document.body.classList.add('empty');
    el.title.textContent = 'Crest';
    document.title = 'Crest';
    stageMsg('');
    toast('');
    updateSelInfo();
    requestDraw();
    renderRows();
  }
  function closeTab(id) {
    if (id == null) id = activeTab;
    const i = tabsList.findIndex((x) => x.id === id);
    if (i < 0) return;
    const wasActive = id === activeTab;
    tabsList.splice(i, 1);
    if (!wasActive) return renderTabs();
    activeTab = null;
    if (tabsList.length) activateTab(tabsList[Math.min(i, tabsList.length - 1)].id);
    else showEmpty();
    renderTabs();
  }
  function cycleTab(dir) {
    if (tabsList.length < 2) return;
    const i = tabsList.findIndex((x) => x.id === activeTab);
    activateTab(tabsList[(i + dir + tabsList.length) % tabsList.length].id);
  }
  el.tabList.addEventListener('click', (e) => {
    const x = e.target.closest('[data-close]');
    if (x) return closeTab(Number(x.dataset.close));
    const tb = e.target.closest('.tab');
    if (tb) activateTab(Number(tb.dataset.id));
  });
  el.tabList.addEventListener('auxclick', (e) => {
    const tb = e.target.closest('.tab');
    if (e.button === 1 && tb) closeTab(Number(tb.dataset.id));
  });
  el.tabNew.addEventListener('click', () => chooseFile(true));

  /* ---------- EQ panel ---------- */

  const eqUI = EQ.createUI({
    canvas: el.eqCanvas,
    paramsEl: el.eqParams,
    state: eqState,
    analyser: () => (G.ctx ? { node: G.analyser, sampleRate: G.ctx.sampleRate } : null),
    isVisible: () => prefs.eqOpen,
    onChange: onEqChange,
  });
  function persistEq() {
    prefs.eq = { bands: eqState.bands, out: eqState.out, bypass: eqState.bypass };
    savePrefs();
  }
  function onEqChange() {
    persistEq();
    if (G.ctx && !EQ.updateChain(G.chain, G.ctx, eqState)) rebuildChain();
    el.eqBypass.classList.toggle('on', eqState.bypass);
    updateFx();
    schedulePrepare();
  }
  let eqRunning = false;
  function eqLoop() {
    if (!prefs.eqOpen) {
      eqRunning = false;
      return;
    }
    eqUI.draw();
    requestAnimationFrame(eqLoop);
  }
  function setEqOpen(on) {
    prefs.eqOpen = on;
    el.eqPanel.hidden = !on;
    document.body.classList.toggle('eq-open', on);
    el.eqBtn.setAttribute('aria-pressed', String(on));
    savePrefs();
    if (on) {
      ensureGraph();
      requestAnimationFrame(() => {
        eqUI.resize();
        if (!eqRunning) {
          eqRunning = true;
          eqLoop();
        }
      });
    }
  }
  new ResizeObserver(() => eqUI.resize()).observe(el.eqCanvas.parentElement);
  el.eqBypass.addEventListener('click', () => {
    eqState.bypass = !eqState.bypass;
    onEqChange();
  });
  el.eqReset.addEventListener('click', () => {
    eqState.bands.length = 0;
    eqState.out = 0;
    eqState.bypass = false;
    el.eqOut.value = '0';
    el.eqOutVal.textContent = '0.0 dB';
    eqUI.setState(eqState);
    onEqChange();
  });
  el.eqOut.addEventListener('input', () => {
    eqState.out = parseFloat(el.eqOut.value) || 0;
    el.eqOutVal.textContent = (eqState.out > 0 ? '+' : '') + eqState.out.toFixed(1) + ' dB';
    onEqChange();
  });

  /* ---------- options popover ---------- */

  function stLabel() {
    const r = A.semitoneRate(prefs.st);
    const lab = `${prefs.st > 0 ? '+' : ''}${prefs.st.toFixed(1)} st`;
    el.stOut.textContent = `${lab} · ${r.toFixed(2)}×`;
    el.viLbl.textContent = prefs.st === 0 ? t('vari') : lab;
    el.viBtn.classList.toggle('active', prefs.st !== 0);
  }
  function updateUcsPreview() {
    el.ucsPreview.textContent = A.ucsName(prefs.ucs) + '.wav';
  }
  function syncOptionsUI() {
    el.st.value = String(prefs.st);
    stLabel();
    el.sens.value = String(prefs.sens);
    el.sensOut.textContent = prefs.sens + ' dB';
    el.snap.checked = prefs.snap;
    el.fade.value = String(prefs.fade);
    el.applyFx.checked = prefs.applyFx;
    el.nameOrig.classList.toggle('on', prefs.naming !== 'ucs');
    el.nameUcs.classList.toggle('on', prefs.naming === 'ucs');
    el.ucsFields.hidden = prefs.naming !== 'ucs';
    el.ucsCat.value = prefs.ucs.catId;
    el.ucsFx.value = prefs.ucs.fxName;
    el.ucsCreator.value = prefs.ucs.creatorId;
    el.ucsSource.value = prefs.ucs.sourceId;
    updateUcsPreview();
    el.langSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.lang === I.lang));
    el.eqOut.value = String(eqState.out);
    el.eqOutVal.textContent = (eqState.out > 0 ? '+' : '') + eqState.out.toFixed(1) + ' dB';
    el.eqBypass.classList.toggle('on', eqState.bypass);
    el.vol.value = String(prefs.vol);
    el.specBtn.setAttribute('aria-pressed', String(prefs.spec));
  }

  const EX_FORMATS = [['wav24', 'WAV 24-bit'], ['wav16', 'WAV 16-bit'], ['aiff', 'AIFF 24-bit'], ['flac', 'FLAC'], ['mp3_320', 'MP3 320 kbps'], ['mp3_v0', 'MP3 V0 (VBR)'], ['ogg', 'OGG Vorbis'], ['m4a', 'AAC (.m4a)']];
  for (const [v, label] of EX_FORMATS) el.exFmt.append(new Option(label, v));
  const POPS = {};
  function regPop(name, pop, btn, o) {
    POPS[name] = Object.assign({ pop, btn, place: true }, o || {});
  }
  function placePop(pop, btn) {
    const r = btn.getBoundingClientRect();
    const w = pop.offsetWidth || 280;
    pop.style.right = 'auto';
    pop.style.left = clamp(r.left + r.width / 2 - w / 2, 8, window.innerWidth - w - 8) + 'px';
  }
  function togglePop(name, force) {
    const P = POPS[name];
    if (!P) return;
    const show = force != null ? force : P.pop.hidden;
    if (show) for (const k in POPS) if (k !== name && !POPS[k].pop.hidden) togglePop(k, false);
    const was = !P.pop.hidden;
    P.pop.hidden = !show;
    if (P.btn) P.btn.setAttribute('aria-pressed', String(show));
    if (show) {
      if (P.onOpen) P.onOpen();
      if (P.place && P.btn) placePop(P.pop, P.btn);
    } else if (was && P.onClose) P.onClose();
  }
  const closePops = () => Object.keys(POPS).forEach((k) => togglePop(k, false));
  const anyPopOpen = () => Object.keys(POPS).some((k) => !POPS[k].pop.hidden);
  const toggleOpts = (f) => togglePop('opts', f);
  const toggleVi = (f) => togglePop('vi', f);
  const toggleEx = (f) => togglePop('ex', f);
  function fillExPop() {
    el.exFmt.value = prefs.exFmt;
    el.exScope.textContent = S.sel ? t('exScopeSel', { a: fmtT(S.sel.start), b: fmtT(S.sel.end) }) : t('exScopeAll');
    el.exFxNote.textContent = processingActive() || S.mute.some(Boolean) ? t('exFxNote') : '';
  }
  regPop('opts', el.opts, el.optsBtn, { place: false });
  regPop('vi', el.viPop, el.viBtn);
  regPop('ex', el.exPop, el.exportBtn, { onOpen: fillExPop });
  regPop('tools', el.toolsPop, el.toolsBtn);
  el.toolsBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePop('tools'); });
  el.exportBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleEx(); });
  el.exFmt.addEventListener('change', () => { prefs.exFmt = el.exFmt.value; savePrefs(); });
  el.exGo.addEventListener('click', () => { toggleEx(false); exportCurrent(); });
  el.viBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleVi(); });
  el.optsBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleOpts(); });
  document.addEventListener('mousedown', (e) => {
    for (const k in POPS) {
      const P = POPS[k];
      if (!P.pop.hidden && !P.pop.contains(e.target) && !(P.btn && P.btn.contains(e.target))) togglePop(k, false);
    }
  });

  el.st.addEventListener('input', () => {
    prefs.st = Math.round(parseFloat(el.st.value) * 10) / 10 || 0;
    stLabel();
    applyRate();
    updateFx();
    schedulePrepare();
    savePrefs();
  });
  el.stReset.addEventListener('click', () => {
    el.st.value = '0';
    el.st.dispatchEvent(new Event('input'));
  });
  let sensTimer = null;
  el.sens.addEventListener('input', () => {
    prefs.sens = parseInt(el.sens.value, 10) || 10;
    el.sensOut.textContent = prefs.sens + ' dB';
    savePrefs();
    clearTimeout(sensTimer);
    sensTimer = setTimeout(() => {
      if (!S.audio) return;
      S.hits = A.detectHits(S.audio.channels, S.audio.sampleRate, { riseDb: prefs.sens });
      S.hitSel = -1;
      requestDraw();
    }, 120);
  });
  const onExportOpt = () => {
    prefs.snap = el.snap.checked;
    prefs.fade = parseInt(el.fade.value, 10) || 0;
    prefs.applyFx = el.applyFx.checked;
    updateFx();
    schedulePrepare();
    savePrefs();
  };
  el.snap.addEventListener('change', onExportOpt);
  el.fade.addEventListener('change', onExportOpt);
  el.applyFx.addEventListener('change', onExportOpt);
  const setNaming = (n) => {
    prefs.naming = n;
    syncOptionsUI();
    schedulePrepare();
    savePrefs();
  };
  el.nameOrig.addEventListener('click', () => setNaming('orig'));
  el.nameUcs.addEventListener('click', () => setNaming('ucs'));
  for (const [input, key] of [[el.ucsCat, 'catId'], [el.ucsFx, 'fxName'], [el.ucsCreator, 'creatorId'], [el.ucsSource, 'sourceId']]) {
    input.addEventListener('input', () => {
      prefs.ucs[key] = input.value;
      updateUcsPreview();
      schedulePrepare();
      savePrefs();
    });
  }
  el.langSeg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-lang]');
    if (b) setLang(b.dataset.lang);
  });
  el.setDefault.addEventListener('click', () => {
    toggleOpts(false);
    api.askDefault();
  });
  el.openExports.addEventListener('click', () => api.openExportsDir());

  function setLang(l) {
    I.lang = l;
    prefs.lang = l;
    savePrefs();
    api.setLang(l);
    I.apply();
    eqUI.renderParams();
    syncOptionsUI();
    updateSelInfo();
    if (S.folder.dir) el.folderName.textContent = `${lastPart(S.folder.dir)} · ${t('folderCount', { n: S.folder.files.length })}`;
    if (S.lastMeter) renderMeter(S.lastMeter);
    updateFx();
    scheduleClip();
  }

  /* ---------- buttons, keys, drop ---------- */

  async function chooseFile(newTab) {
    handleResolved(await api.openDialog(), { newTab: newTab !== false });
  }
  async function chooseFolder() {
    handleResolved(await api.openFolderDialog());
  }

  el.play.addEventListener('click', () => togglePlay());
  el.prevHit.addEventListener('click', () => gotoHit(-1));
  el.nextHit.addEventListener('click', () => gotoHit(1));
  el.open.addEventListener('click', chooseFile);
  el.openBig.addEventListener('click', chooseFile);
  el.openFolderBig.addEventListener('click', chooseFolder);
  el.folderBtn.addEventListener('click', () => {
    if (!S.folder.files.length && el.side.hidden) return chooseFolder();
    setSidebar(el.side.hidden);
  });
  el.loop.addEventListener('click', () => {
    S.loop = !S.loop;
    el.loop.classList.toggle('on', S.loop);
    el.loop.setAttribute('aria-pressed', String(S.loop));
    applyLoop();
  });
  el.specBtn.addEventListener('click', () => {
    prefs.spec = !prefs.spec;
    el.specBtn.setAttribute('aria-pressed', String(prefs.spec));
    savePrefs();
    requestDraw();
  });
  el.eqBtn.addEventListener('click', () => setEqOpen(!prefs.eqOpen));
  el.timeBtn.addEventListener('click', () => {
    prefs.tc = !prefs.tc;
    savePrefs();
    updatePlayhead();
    el.dur.textContent = fmtT(duration());
  });
  el.vol.addEventListener('input', () => {
    prefs.vol = parseFloat(el.vol.value);
    applyVolume();
    savePrefs();
  });

  // video: fullscreen, frame stepping, splitter
  function toggleFullscreen() {
    if (!S.info || S.info.kind !== 'video') return;
    if (document.fullscreenElement) document.exitFullscreen();
    else el.stage.requestFullscreen().catch(() => {});
  }
  el.media.addEventListener('dblclick', toggleFullscreen);
  el.media.addEventListener('click', () => togglePlay());
  function stepFrame(dir) {
    if (!S.fps || !S.info || S.info.kind !== 'video') return;
    el.media.pause();
    const n = Math.floor(el.media.currentTime * S.fps + 1e-6) + dir;
    const target = clamp((Math.max(0, n) + 0.5) / S.fps, 0, duration() || 0);
    seek(target, true);
    // a busy decoder can complete a seek without moving: check on 'seeked' and retry once
    el.media.addEventListener(
      'seeked',
      () => {
        if (Math.abs(el.media.currentTime - target) > 0.5 / S.fps) {
          el.media.currentTime = target;
          updatePlayhead();
        }
      },
      { once: true }
    );
  }
  let split = null;
  el.splitter.addEventListener('pointerdown', (e) => {
    split = { y: e.clientY, h: $('wavePanel').getBoundingClientRect().height };
    el.splitter.setPointerCapture(e.pointerId);
  });
  el.splitter.addEventListener('pointermove', (e) => {
    if (!split) return;
    const mainH = el.stage.parentElement.getBoundingClientRect().height;
    const h = clamp(split.h + (split.y - e.clientY), 110, mainH - 140);
    document.documentElement.style.setProperty('--wave-h', h + 'px');
    prefs.waveH = h;
  });
  el.splitter.addEventListener('pointerup', () => {
    split = null;
    savePrefs();
  });

  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && !b.closest('.pop')) b.blur();
  });

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (/^Digit[1-9]$/.test(e.code) && chanCount() >= 2) {
      toggleMute(Number(e.code.slice(5)) - 1, e.shiftKey);
      return;
    }
    switch (e.key) {
      case ' ':
        e.preventDefault();
        togglePlay();
        break;
      case ']': gotoHit(1); break;
      case '[': gotoHit(-1); break;
      case 'l': case 'L': el.loop.click(); break;
      case 's': case 'S': el.specBtn.click(); break;
      case 'e': case 'E': setEqOpen(!prefs.eqOpen); break;
      case 'v': case 'V': toggleVi(); break;
      case 'b': case 'B': el.folderBtn.click(); break;
      case 'f': case 'F': toggleFullscreen(); break;
      case 'm': case 'M': setMatch(!prefs.match); break;
      case '\\': abToggle(); break;
      case 'i': case 'I': Tools.open('meta'); break;
      case ',': stepFrame(-1); break;
      case '.': stepFrame(1); break;
      case 'Escape':
        if (Tools.modalOpen()) Tools.closeModal();
        else if (anyPopOpen()) closePops();
        else clearSel();
        break;
      case 'z': case 'Z': zoomToSelection(); break;
      case '0': fitView(); break;
      case 'Home': if (S.file) seek(0, true); break;
      case 'End': if (S.file) seek(duration(), true); break;
      case 'ArrowUp': e.preventDefault(); navigate(-1); break;
      case 'ArrowDown': e.preventDefault(); navigate(1); break;
      case 'ArrowLeft':
      case 'ArrowRight':
        if (!S.file) break;
        e.preventDefault();
        seek(el.media.currentTime + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1), true);
        break;
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ' && !/INPUT|SELECT|TEXTAREA/.test((e.target && e.target.tagName) || '')) e.preventDefault();
  });

  let dropDepth = 0;
  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dropDepth++;
    document.body.classList.add('dropping');
  });
  document.addEventListener('dragleave', () => {
    dropDepth = Math.max(0, dropDepth - 1);
    if (!dropDepth) document.body.classList.remove('dropping');
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropDepth = 0;
    document.body.classList.remove('dropping');
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (!files.length) return;
    const paths = files.map((f) => api.pathForFile(f)).filter(Boolean);
    if (paths[0]) await handleResolved(await api.resolve(paths[0]), { newTab: true });
    // extra files become background tabs
    for (const p of paths.slice(1)) {
      const r = await api.resolve(p, { skipList: true });
      if (r && r.type === 'file' && !tabsList.some((x) => x.path === r.info.path)) tabsList.push({ id: ++tabSeq, path: r.info.path, name: r.info.name, time: 0, sel: null, mute: [], lufs: null });
    }
    renderTabs();
  });

  api.onResolved((r) => handleResolved(r, { newTab: true }));
  api.onMenu((name) => {
    if (name === 'open') chooseFile(true);
    else if (name === 'new-tab') chooseFile(true);
    else if (name === 'close-tab') closeTab();
    else if (name === 'next-tab') cycleTab(1);
    else if (name === 'prev-tab') cycleTab(-1);
    else if (name === 'open-folder') chooseFolder();
    else if (name === 'export') exportCurrent();
    else if (name === 'export-hits') exportAllHits();
  });
  api.onProgress(({ kind, pct }) => {
    const p = Math.round(pct * 100);
    if (kind === 'proxy') stageMsg(t('previewPrep', { pct: p }));
    else if (kind === 'extract' && !S.audio) toast(t('readingPct', { pct: p }), 0);
    else if (kind === 'clip' && !S.clip) el.gripVideoText.textContent = t('gripVideoPrep', { pct: p });
  });

  /* ---------- tools (renderer/tools.js) ---------- */

  Tools.init({
    S, G, el, api, A, EQ, eqState, I, t, toast, fmtT, clamp, baseName,
    getPrefs: () => prefs, savePrefs, regPop, togglePop, closePops,
    addDrawHook: (fn) => drawHooks.push(fn), addSelHook: (fn) => selHooks.push(fn), addLoadHook: (fn) => loadHooks.push(fn),
    t2x, W, requestDraw, setSel, seek, ensureVisible, togglePlay, snappedRegion, renderChannels, processChans, loadBufferFor,
    exportName, fxSuffix, processingActive, processingLabel: () => fxSuffix(),
    exFormats: EX_FORMATS, addFolderHook: (fn) => folderHooks.push(fn), refreshFilter: () => { if (S.folder) applyFilter(); },
    releaseMedia: () => { teardown(); el.media.pause(); el.media.removeAttribute('src'); el.media.load(); },
    reloadCurrent: async () => {
      if (!S.file) return;
      const r = await api.resolve(S.file.path, { skipList: true });
      if (r && r.type === 'file') await loadFile(r.info, { restore: { time: S.reloadTime || 0, sel: S.sel && { start: S.sel.start, end: S.sel.end }, mute: S.mute.slice() } });
    },
    resolveRow: () => {}, activeSrc: () => (S.info ? S.info.path : null), setSetupHook: (fn) => { S.setupHook = fn; },
  });

  /* ---------- init ---------- */

  (async () => {
    I.lang = prefs.lang || (await api.getLang());
    I.apply();
    document.documentElement.style.setProperty('--wave-h', clamp(prefs.waveH || 210, 110, 900) + 'px');
    syncOptionsUI();
    stLabel();
    applyRate();
    updateSelInfo();
    updateFx();
    ensureGraph();
    el.side.hidden = !prefs.sidebar;
    el.folderBtn.setAttribute('aria-pressed', String(prefs.sidebar));
    if (prefs.eqOpen) setEqOpen(true);
    document.body.dataset.ready = '1';
  })();

  // exposed only for the automated end-to-end test (main adds ?e2e=1 under CREST_E2E)
  if (new URLSearchParams(location.search).has('e2e')) {
    window.A_encode = A.encodeWav;
    window.__crest = { tabs: () => tabsList, closeTab, abToggle, exportCurrent, G, toggleMute, S, prefs, eqState, G, A, EQ, I, loadFile, handleResolved, renderChannels, snappedRegion, exportName, setEqOpen, selectHit, gotoHit, dragPath, setSel, exportAllHits, navigate };
  }
})();
