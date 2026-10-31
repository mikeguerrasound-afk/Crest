/*
 * Crest tools: quality check, loop maker, batch processing, picture audition, metadata, REAPER link.
 * renderer.js hands over everything these need through init(ctx); nothing here touches the player's state
 * except through that context.
 */
(function (root) {
  'use strict';

  let C = null;
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pct = (v, d) => (v >= 0 ? '' : '−') + Math.abs(v).toFixed(d == null ? 1 : d);
  const db = (lin) => (lin > 0 ? 20 * Math.log10(lin) : -Infinity);
  const dbStr = (v, unit) => (isFinite(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + (unit == null ? ' dB' : unit) : '−∞');

  /** Selected region in samples, or the whole file. */
  function region() {
    const A = C.S.audio;
    const sr = A.sampleRate;
    if (C.S.sel) return { a: Math.round(C.S.sel.start * sr), b: Math.round(C.S.sel.end * sr), whole: false };
    return { a: 0, b: A.length, whole: true };
  }
  const scopeText = (keySel, keyAll) => {
    if (!C.S.audio) return '';
    return C.S.sel ? C.t(keySel, { a: C.fmtT(C.S.sel.start), b: C.fmtT(C.S.sel.end) }) : C.t(keyAll);
  };
  const setRows = (box, rows) => {
    box.textContent = '';
    for (const [k, v, cls] of rows) {
      const a = document.createElement('span');
      a.className = 'k';
      a.textContent = k;
      const b = document.createElement('span');
      b.className = 'v' + (cls ? ' ' + cls : '');
      b.textContent = v;
      box.append(a, b);
    }
  };

  /* ================================================================== */
  /* Quality check                                                       */
  /* ================================================================== */

  const QC = { clipsAll: null, timer: null };

  function qcSchedule() {
    clearTimeout(QC.timer);
    QC.timer = setTimeout(qcUpdate, 160);
  }

  function qcWholeClips() {
    const S = C.S;
    if (!S.audio) return [];
    if (!QC.clipsAll || QC.clipsAll.audio !== S.audio) QC.clipsAll = { audio: S.audio, list: C.A.findClips(S.audio.channels, S.audio.sampleRate, 0.999, 3) };
    return QC.clipsAll.list;
  }

  function qcUpdate() {
    const pop = $('qcPop');
    if (pop.hidden || !C.S.audio) return;
    const A = C.A;
    const S = C.S;
    const sr = S.audio.sampleRate;
    const { a, b, whole } = region();
    $('qcScope').textContent = scopeText('qcScopeSel', 'qcScopeAll');
    const chans = S.audio.channels;
    const m = whole && S.meterAll ? S.meterAll : A.loudness(chans, sr, a, b);
    const tp = A.truePeak(chans, a, b);
    const sub = chans.map((c) => c.subarray(a, b));
    const clips = A.findClips(sub, sr, 0.999, 3);
    const dc = A.dcOffset(chans, a, b);
    const dcWorst = Math.max(...dc.map((v) => Math.abs(v)));
    const dcDb = db(dcWorst);
    const corr = A.phaseCorrelation(chans, sr, a, b);
    const rows = [
      [C.t('qcSamplePeak'), dbStr(m.peakDb, ' dBFS'), m.peakDb >= -0.05 ? 'bad' : ''],
      [C.t('qcTruePeak'), dbStr(tp, ' dBTP'), tp > -1 ? 'bad' : ''],
      [C.t('qcLufs'), isFinite(m.lufs) ? dbStr(m.lufs, ' LUFS') : '−∞', ''],
      [C.t('qcClips'), clips.length ? C.t('qcClipsN', { n: clips.length }) : C.t('qcClipsNone'), clips.length ? 'bad' : 'good'],
      [C.t('qcDc'), isFinite(dcDb) ? dbStr(dcDb, ' dBFS') : '−∞', dcDb > -50 ? 'bad' : ''],
      [C.t('qcCorr'), corr ? C.t('qcCorrVal', { avg: corr.avg.toFixed(2), min: corr.min.toFixed(2) }) : C.t('qcNoStereo'), corr && (corr.avg < 0 || corr.min < -0.5) ? 'bad' : ''],
    ];
    setRows($('qcStats'), rows);
    qcGonio(a, b);
    if ($('qcMarks').checked) C.requestDraw();
  }

  function qcGonio(a, b) {
    const cv = $('qcGonio');
    const dpr = window.devicePixelRatio || 1;
    const size = 200;
    cv.width = size * dpr;
    cv.height = size * dpr;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size, size);
    const c = size / 2;
    g.strokeStyle = 'rgba(255,255,255,0.09)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(c, 6); g.lineTo(c, size - 6); g.moveTo(6, c); g.lineTo(size - 6, c);
    g.moveTo(c - 80, c - 80); g.lineTo(c + 80, c + 80); g.moveTo(c + 80, c - 80); g.lineTo(c - 80, c + 80);
    g.stroke();
    g.beginPath();
    g.arc(c, c, 84, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = 'rgba(160,170,190,0.7)';
    g.font = '10px sans-serif';
    g.textAlign = 'center';
    g.fillText('M', c, 12);
    g.fillText('L', c - 88, c - 82);
    g.fillText('R', c + 88, c - 82);
    const pts = C.A.goniometerPoints(C.S.audio.channels, a, b, 5000);
    const k = 84 / 1.0;
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ffb454';
    g.fillStyle = accent;
    g.globalAlpha = 0.32;
    for (let i = 0; i < pts.length; i += 2) g.fillRect(c + pts[i] * k - 0.6, c - pts[i + 1] * k - 0.6, 1.4, 1.4);
    g.globalAlpha = 1;
  }

  function qcDraw(g, dpr, w, h) {
    if (!$('qcMarks').checked || !C.S.audio) return;
    const sr = C.S.audio.sampleRate;
    g.fillStyle = '#ff5a4a';
    for (const cl of qcWholeClips()) {
      const x0 = C.t2x(cl.start / sr);
      const x1 = C.t2x(cl.end / sr);
      if (x1 < 0 || x0 > w / dpr) continue;
      const wpx = Math.max(2, (x1 - x0)) * dpr;
      g.globalAlpha = 0.25;
      g.fillRect(Math.round(x0 * dpr), 28 * dpr, wpx, h);
      g.globalAlpha = 1;
      g.fillRect(Math.round(x0 * dpr), 28 * dpr, wpx, 4 * dpr);
    }
  }

  /* ================================================================== */
  /* Loop maker                                                          */
  /* ================================================================== */

  const LP = { src: null, buf: null, loop: null, timer: null };

  function loopRegion() {
    const S = C.S;
    if (!S.audio || !S.sel) return null;
    const [a, b] = C.snappedRegion(S.sel.start, S.sel.end);
    return b - a > 256 ? { a, b } : null;
  }

  function loopBuild() {
    const r = loopRegion();
    if (!r) return null;
    const sr = C.S.audio.sampleRate;
    const x = Math.round((+$('loopX').value / 1000) * sr);
    const ch = C.A.makeLoop(C.S.audio.channels, r.a, r.b, x);
    ch.forEach((c, i) => { if (C.S.mute[i]) c.fill(0); });
    return { ch, sr, a: r.a, b: r.b };
  }

  function loopRefresh() {
    const pop = $('loopPop');
    if (pop.hidden) return;
    const out = $('loopXOut');
    out.textContent = $('loopX').value + ' ms';
    const r = loopRegion();
    $('loopScope').textContent = r ? C.t('loopScope', { a: C.fmtT(r.a / C.S.audio.sampleRate), b: C.fmtT(r.b / C.S.audio.sampleRate) }) : C.t('loopNeedSel');
    $('loopPlay').disabled = $('loopExport').disabled = $('loopBest').disabled = !r;
    loopSeam();
    if (LP.src) loopStartPreview(true);
  }
  const loopSchedule = () => {
    clearTimeout(LP.timer);
    LP.timer = setTimeout(loopRefresh, 140);
  };

  function loopSeam() {
    const cv = $('loopSeam');
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 290;
    const h = 70;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const L = loopBuild();
    if (!L) return;
    const n = Math.round(L.sr * 0.03);
    const d = L.ch[0];
    if (d.length < 2 * n) return;
    const seg = new Float32Array(2 * n);
    seg.set(d.subarray(d.length - n), 0);
    seg.set(d.subarray(0, n), n);
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
    g.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--wave').trim() || '#bcc3d6';
    g.lineWidth = 1.2;
    g.beginPath();
    for (let x = 0; x < w; x++) {
      const i = Math.min(seg.length - 1, Math.floor((x / w) * seg.length));
      const y = h / 2 - seg[i] * (h / 2 - 4);
      if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
    g.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ffb454';
    g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.stroke();
  }

  function loopStop() {
    if (LP.src) {
      try { LP.src.stop(); } catch (e) { /* already stopped */ }
      try { LP.src.disconnect(); } catch (e) { /* ignore */ }
      LP.src = null;
    }
    $('loopPlay').textContent = C.t('loopPlay');
  }

  function loopStartPreview(restart) {
    const L = loopBuild();
    if (!L || !C.G.ctx || !C.G.pre) return;
    loopStop();
    C.el.media.pause();
    if (C.G.ctx.state === 'suspended') C.G.ctx.resume();
    const buf = C.G.ctx.createBuffer(L.ch.length, L.ch[0].length, L.sr);
    L.ch.forEach((c, i) => buf.copyToChannel(c, i));
    const src = C.G.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = C.A.semitoneRate(C.getPrefs().st);
    src.connect(C.G.pre);
    src.start();
    LP.src = src;
    $('loopPlay').textContent = C.t('loopStop');
  }

  async function loopExport() {
    const L = loopBuild();
    if (!L) return C.toast(C.t('loopNeedSel'));
    const prefs = C.getPrefs();
    try {
      C.toast(C.t('exporting'), 0);
      let ch = L.ch;
      if (C.processingActive()) ch = await C.processChans(ch, L.sr);
      const name = C.baseName(C.S.file.name) + '_loop' + C.fxSuffix() + '.wav';
      const bytes = C.A.encodeWav(ch, L.sr, 0, ch[0].length, { loop: { start: 0, end: ch[0].length - 1 } });
      const saved = await C.api.exportAs(name, bytes, prefs.exFmt, ch.length);
      C.toast(saved ? C.t('saved') : '');
    } catch (err) {
      console.error(err);
      C.toast(C.t('writeFail'));
    }
  }

  function loopBest() {
    const r = loopRegion();
    if (!r) return;
    const sr = C.S.audio.sampleRate;
    const best = C.A.bestLoopEnd(C.S.audio.channels, sr, r.a, r.b, { searchMs: 300 });
    $('loopScore').textContent = C.t('loopScore', { pct: Math.max(0, Math.round(best.score * 100)) });
    C.setSel(r.a / sr, best.end / sr);
  }

  /* ================================================================== */
  /* Batch                                                               */
  /* ================================================================== */

  const BT = { running: false, cancel: false };
  const NORM_DEF = { peak: { v: -1, unit: 'dBFS' }, lufs: { v: -23, unit: 'LUFS' } };

  function batchOpen() {
    const S = C.S;
    if (!S.folder || !S.folder.files.length) {
      C.toast(C.t('batchNoFolder'));
      return false;
    }
    const prefs = C.getPrefs();
    const files = S.folder.shown;
    $('batchSrc').textContent = C.t('batchSrc', { n: files.length, dir: S.folder.dir.split(/[\\/]/).filter(Boolean).pop() || S.folder.dir });
    $('bApplyFx').checked = prefs.applyFx !== false;
    const fmt = $('bFmt');
    if (!fmt.options.length) for (const [v, label] of C.exFormats) fmt.append(new Option(label, v));
    fmt.value = prefs.exFmt;
    $('bStatus').textContent = '';
    $('bProg').hidden = true;
    $('bBar').style.width = '0';
    batchNormUi();
    return true;
  }

  function batchNormUi() {
    const m = $('bNorm').value;
    $('bTarget').disabled = m === 'none';
    $('bCeilRow').hidden = m !== 'lufs';
    if (NORM_DEF[m]) {
      $('bUnit').textContent = NORM_DEF[m].unit;
      if ($('bTarget').dataset.mode !== m) $('bTarget').value = NORM_DEF[m].v;
    } else $('bUnit').textContent = '';
    $('bTarget').dataset.mode = m;
  }

  async function batchRun() {
    if (BT.running) return;
    const files = C.S.folder ? C.S.folder.shown.slice() : [];
    if (!files.length) return;
    const dir = await C.api.chooseExportDir();
    if (!dir) return;
    const prefs = C.getPrefs();
    const fmt = $('bFmt').value;
    const norm = $('bNorm').value;
    const target = parseFloat($('bTarget').value);
    const ceil = parseFloat($('bCeil').value);
    let suffix = $('bSuffix').value.trim();
    if (!suffix) suffix = '_proc'; // never write over a source file
    const applyFx = $('bApplyFx').checked && (prefs.st !== 0 || C.EQ.isActive(C.eqState));
    BT.running = true;
    BT.cancel = false;
    $('bRun').disabled = true;
    $('bProg').hidden = false;
    let done = 0, failed = 0, limited = 0;
    for (let i = 0; i < files.length && !BT.cancel; i++) {
      const f = files[i];
      $('bStatus').textContent = C.t('bRunning', { n: i + 1, m: files.length, name: f.name });
      $('bBar').style.width = (i / files.length) * 100 + '%';
      await sleep(0);
      try {
        const dec = await C.loadBufferFor(f.path);
        let ch = dec.channels.map((c) => c.slice());
        if (applyFx) ch = await C.processChans(ch, dec.sampleRate);
        if (norm !== 'none' && isFinite(target)) {
          const m = C.A.loudness(ch, dec.sampleRate, 0, ch[0].length);
          const r = C.A.normalizeGainDb(norm, target, m, isFinite(ceil) ? ceil : -1);
          if (r.limited) limited++;
          C.A.applyGain(ch, r.gainDb);
        }
        const base = f.name.replace(/\.[^.]+$/, '') + suffix + '.wav';
        const out = await C.api.exportAs(base, C.A.encodeWav(ch, dec.sampleRate), fmt, ch.length, dir);
        if (out) done++;
        else failed++;
      } catch (err) {
        console.error('batch', f.name, err);
        failed++;
      }
    }
    $('bBar').style.width = '100%';
    let msg;
    if (BT.cancel) msg = C.t('bCanceled', { n: done });
    else {
      const extra = (limited ? C.t('bDoneLimited', { k: limited }) : '') + (failed ? C.t('bDoneFailed', { k: failed }) : '');
      msg = C.t('bDone', { n: done, extra });
    }
    $('bStatus').textContent = msg;
    BT.running = false;
    $('bRun').disabled = false;
    $('bRun').textContent = C.t('bRun');
    $('bClose').textContent = C.t('close');
    if (done) C.api.reveal(dir + '/');
  }

  /* ================================================================== */
  /* Picture audition                                                    */
  /* ================================================================== */

  const PIC = { path: null, url: null, at: 0, dur: 0, timer: null, info: null };

  const picActive = () => !!PIC.url && C.S.info && C.S.info.kind !== 'video';

  function picClass() {
    document.body.classList.toggle('has-pic', picActive());
  }

  function picUi() {
    $('picName').textContent = PIC.path ? PIC.path.split(/[\\/]/).pop() : C.t('picNone');
    const off = $('picOff');
    off.max = String(Math.max(0, Math.floor(PIC.dur * 100) / 100));
    off.value = String(PIC.at);
    off.disabled = !PIC.url;
    $('picOffOut').textContent = C.fmtT(PIC.at);
    $('picExport').disabled = !PIC.url || !C.S.audio || (C.S.info && C.S.info.kind === 'video');
    $('picClear').disabled = !PIC.url;
  }

  function picSync(force) {
    const v = C.el.picVideo;
    const m = C.el.media;
    if (!picActive() || !isFinite(v.duration)) return;
    const want = PIC.at + (m.currentTime || 0);
    const inRange = want >= 0 && want < v.duration - 0.02;
    v.playbackRate = Math.min(16, Math.max(0.0625, m.playbackRate || 1));
    if (!inRange) {
      if (!v.paused) v.pause();
      const end = Math.min(Math.max(0, want), Math.max(0, v.duration - 0.04));
      if (Math.abs(v.currentTime - end) > 0.05) v.currentTime = end;
      return;
    }
    if (force || Math.abs(v.currentTime - want) > 0.09) v.currentTime = want;
    if (!m.paused && v.paused) v.play().catch(() => {});
    else if (m.paused && !v.paused) v.pause();
  }

  async function picChoose() {
    const p = await C.api.pickVideo();
    if (!p) return;
    const r = await C.api.resolve(p, { skipList: true });
    if (!r || r.type !== 'file' || r.info.kind !== 'video') return C.toast(C.t('picNeedVideo'));
    C.toast(C.t('picBusy'), 0);
    try {
      let url = r.info.url;
      if (r.info.plan === 'transcode') url = (await C.api.prepareProxy(r.info.path, 'transcode')).url;
      PIC.path = r.info.path;
      PIC.info = r.info;
      PIC.url = url;
      PIC.at = 0;
      const v = C.el.picVideo;
      v.muted = true;
      v.src = url;
      await new Promise((res) => {
        v.addEventListener('loadedmetadata', res, { once: true });
        v.addEventListener('error', res, { once: true });
        v.load();
      });
      PIC.dur = isFinite(v.duration) ? v.duration : 0;
      C.toast('');
    } catch (err) {
      console.error(err);
      PIC.url = null;
      C.toast(C.t('previewFail'), 4000);
    }
    picClass();
    picUi();
    picSync(true);
  }

  function picClear() {
    PIC.url = PIC.path = null;
    C.el.picVideo.removeAttribute('src');
    C.el.picVideo.load();
    picClass();
    picUi();
  }

  async function picExport() {
    if (!picActive() || !C.S.audio) return;
    const { a, b, whole } = region();
    const sr = C.S.audio.sampleRate;
    try {
      C.toast(C.t('picExporting'), 0);
      const ch = await C.renderChannels(a, b, whole);
      const name = C.baseName(C.S.file.name) + (whole ? '' : '_' + Math.round(a / sr * 1000) + 'ms') + C.fxSuffix() + '_picture.mp4';
      const bytes = C.A.encodeWav(ch, sr);
      const saved = await C.api.exportPicture(PIC.path, PIC.at + a / sr, ch[0].length / sr, bytes, name);
      C.toast(saved ? C.t('saved') : '');
    } catch (err) {
      console.error(err);
      C.toast(C.t('writeFail'));
    }
  }

  function picInit() {
    const m = C.el.media;
    for (const ev of ['play', 'pause', 'seeked', 'ratechange', 'loadedmetadata', 'ended']) m.addEventListener(ev, () => picSync(ev === 'seeked' || ev === 'loadedmetadata'));
    PIC.timer = setInterval(() => picSync(false), 100);
    $('picChoose').addEventListener('click', picChoose);
    $('picClear').addEventListener('click', picClear);
    $('picExport').addEventListener('click', picExport);
    $('picOff').addEventListener('input', () => {
      PIC.at = parseFloat($('picOff').value) || 0;
      $('picOffOut').textContent = C.fmtT(PIC.at);
      picSync(true);
    });
    C.addLoadHook(() => { picClass(); picUi(); picSync(true); });
  }

  /* ================================================================== */
  /* Metadata                                                            */
  /* ================================================================== */

  const MD = { confirmed: false, scanning: 0 };
  const TAGS = ['title', 'comment', 'keywords', 'genre', 'artist', 'album'];
  const FIELD = { title: 'mTitle', comment: 'mComment', keywords: 'mKeywords', genre: 'mGenre', artist: 'mArtist', album: 'mAlbum' };

  async function metaOpen() {
    if (!C.S.file) {
      C.toast(C.t('reaperNeedSel'));
      return false;
    }
    $('metaFile').textContent = C.S.file.name;
    const tags = (await C.api.readMeta(C.S.file.path)) || {};
    for (const k of TAGS) $(FIELD[k]).value = tags[k] || '';
    const ext = (C.S.file.name.split('.').pop() || '').toLowerCase();
    $('metaNote').textContent = ext === 'aif' || ext === 'aiff' ? C.t('metaAiff') : '';
    return true;
  }

  function metaFromName() {
    const u = C.A.parseUcsName(C.S.file.name);
    if (!u) {
      $('metaNote').textContent = C.t('metaNoUcs');
      return;
    }
    $('mTitle').value = u.fxName;
    $('mGenre').value = u.catId;
    if (u.creatorId) $('mArtist').value = u.creatorId;
    if (u.sourceId) $('mAlbum').value = u.sourceId;
    $('metaNote').textContent = '';
  }

  async function metaSave() {
    if (!C.S.file) return;
    if (!MD.confirmed && !window.confirm(C.t('metaConfirm'))) return;
    MD.confirmed = true;
    const tags = {};
    for (const k of TAGS) tags[k] = $(FIELD[k]).value;
    const time = C.el.media.currentTime || 0;
    C.S.reloadTime = time;
    try {
      C.releaseMedia();
      await sleep(80);
      const ok = await C.api.writeMeta(C.S.file.path, tags);
      $('metaNote').textContent = ok ? C.t('metaSaved') : C.t('metaFail');
      C.S.metaText[C.S.file.path] = Object.values(tags).join(' ').toLowerCase();
    } catch (err) {
      console.error(err);
      $('metaNote').textContent = C.t('metaFail');
    }
    await C.reloadCurrent();
    C.refreshFilter();
  }

  function metaScanFolder() {
    const S = C.S;
    if (!S.folder) return;
    S.metaText = {};
    const paths = S.folder.files.map((f) => f.path);
    C.api.scanMeta(paths);
  }

  /* ================================================================== */
  /* REAPER                                                              */
  /* ================================================================== */

  async function reaperSend() {
    if (!C.S.audio) return C.toast(C.t('reaperNeedSel'));
    const { a, b, whole } = region();
    const sr = C.S.audio.sampleRate;
    try {
      C.toast(C.t('reaperSending'), 0);
      const ch = await C.renderChannels(a, b, whole);
      const name = whole ? C.baseName(C.S.file.name) + C.fxSuffix() + '.wav' : C.exportName(a, b);
      const res = await C.api.sendReaper(name, C.A.encodeWav(ch, sr));
      if (!res || !res.ok) C.toast(C.t('reaperFail'), 5000);
      else C.toast(res.firstTime ? C.t('reaperSent') : C.t('saved'), res.firstTime ? 9000 : 2200);
    } catch (err) {
      console.error(err);
      C.toast(C.t('reaperFail'), 5000);
    }
  }

  /* ================================================================== */
  /* Wiring                                                              */
  /* ================================================================== */

  const MODALS = { batch: 'batchCard', meta: 'metaCard' };
  let modalName = null;

  function modalOpen() { return !$('modal').hidden; }
  function closeModal() {
    if (BT.running) BT.cancel = true;
    $('modal').hidden = true;
    for (const id of Object.values(MODALS)) $(id).hidden = true;
    modalName = null;
  }

  async function open(name) {
    C.closePops();
    if (name === 'qc') return C.togglePop('qc', true);
    if (name === 'loop') return C.togglePop('loop', true);
    if (name === 'pic') return C.togglePop('pic', true);
    if (name === 'reaper') return reaperSend();
    if (name === 'batch' || name === 'meta') {
      if (name === 'batch' && !batchOpen()) return;
      if (name === 'meta' && !(await metaOpen())) return;
      modalName = name;
      $('modal').hidden = false;
      for (const [k, id] of Object.entries(MODALS)) $(id).hidden = k !== name;
    }
  }

  function init(ctx) {
    C = ctx;
    const prefs = C.getPrefs;

    C.regPop('qc', $('qcPop'), C.el.toolsBtn, { onOpen: () => setTimeout(qcUpdate, 0), onClose: () => C.requestDraw() });
    C.regPop('loop', $('loopPop'), C.el.toolsBtn, { onOpen: () => setTimeout(loopRefresh, 0), onClose: loopStop });
    C.regPop('pic', $('picPop'), C.el.toolsBtn, { onOpen: picUi });

    for (const b of document.querySelectorAll('#toolsPop [data-tool]')) b.addEventListener('click', () => open(b.dataset.tool));

    // QC
    C.addDrawHook(qcDraw);
    C.addSelHook(() => { qcSchedule(); loopSchedule(); picUi(); });
    C.addLoadHook(() => { QC.clipsAll = null; qcSchedule(); loopSchedule(); });
    $('qcMarks').addEventListener('change', () => C.requestDraw());

    // loop
    $('loopX').addEventListener('input', () => { $('loopXOut').textContent = $('loopX').value + ' ms'; loopSchedule(); });
    $('loopBest').addEventListener('click', loopBest);
    $('loopPlay').addEventListener('click', () => (LP.src ? loopStop() : loopStartPreview()));
    $('loopExport').addEventListener('click', loopExport);
    C.el.media.addEventListener('play', loopStop);

    // batch
    $('bNorm').addEventListener('change', batchNormUi);
    $('bRun').addEventListener('click', batchRun);
    $('bClose').addEventListener('click', () => {
      if (BT.running) {
        BT.cancel = true;
        return;
      }
      closeModal();
    });
    $('modal').addEventListener('mousedown', (e) => { if (e.target === $('modal') && !BT.running) closeModal(); });

    // metadata
    $('mFromName').addEventListener('click', metaFromName);
    $('mSave').addEventListener('click', metaSave);
    $('mClose').addEventListener('click', closeModal);
    C.addFolderHook(metaScanFolder);
    C.api.onMeta((list) => {
      for (const [p, text] of list) C.S.metaText[p] = text;
      C.refreshFilter();
    });

    picInit();
    void prefs;
  }

  root.CrestTools = { init, open, modalOpen, closeModal, _region: () => region() };
})(window);
