(() => {
  'use strict';

  const A = window.CrestAudio;
  const api = window.api;
  const $ = (id) => document.getElementById(id);

  const el = {
    media: $('media'),
    wave: $('wave'),
    canvas: $('canvas'),
    playhead: $('playhead'),
    selection: $('selection'),
    status: $('status'),
    title: $('title'),
    play: $('play'),
    cur: $('cur'),
    dur: $('dur'),
    loudest: $('loudest'),
    loop: $('loop'),
    vol: $('vol'),
    selInfo: $('selInfo'),
    grip: $('grip'),
    gripText: $('gripText'),
    open: $('open'),
    openBig: $('openBig'),
  };
  const g = el.canvas.getContext('2d');

  const rootStyle = getComputedStyle(document.documentElement);
  const COLOR = {
    wave: rootStyle.getPropertyValue('--wave').trim(),
    grid: rootStyle.getPropertyValue('--grid').trim(),
    muted: rootStyle.getPropertyValue('--muted').trim(),
    accent: rootStyle.getPropertyValue('--accent').trim(),
  };
  const FONT = getComputedStyle(document.body).fontFamily;
  const RULER_H = 24;

  const S = {
    file: null, // { path, name }
    audio: null, // { channels, sampleRate, length, duration } once decoded
    pyr: null,
    peaks: [],
    peakIdx: -1,
    view: { start: 0, end: 1 },
    sel: null, // { start, end } in seconds
    loop: false,
    playing: false,
    loadId: 0,
    endTimer: null,
  };

  /* ---------- small helpers ---------- */

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const duration = () => (S.audio ? S.audio.duration : isFinite(el.media.duration) ? el.media.duration : 0);
  const W = () => el.wave.clientWidth;
  const H = () => el.wave.clientHeight;
  const t2x = (t) => ((t - S.view.start) / (S.view.end - S.view.start)) * W();
  const x2t = (x) => S.view.start + (x / W()) * (S.view.end - S.view.start);

  function fmtTime(t, decimals = 3) {
    if (!isFinite(t) || t < 0) t = 0;
    const totalMs = Math.round(t * 1000);
    const ms = totalMs % 1000;
    const s = Math.floor(totalMs / 1000) % 60;
    const m = Math.floor(totalMs / 60000) % 60;
    const h = Math.floor(totalMs / 3600000);
    const frac = decimals ? '.' + String(ms).padStart(3, '0').slice(0, decimals) : '';
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0') + frac;
  }

  // 1m23s450 — safe in file names on every OS
  function stamp(t) {
    const ms = Math.round(t * 1000);
    return Math.floor(ms / 60000) + 'm' + String(Math.floor(ms / 1000) % 60).padStart(2, '0') + 's' + String(ms % 1000).padStart(3, '0');
  }

  let toastTimer = null;
  function toast(msg, ms = 2200) {
    clearTimeout(toastTimer);
    if (!msg) {
      el.status.classList.remove('show');
      return;
    }
    el.status.textContent = msg;
    el.status.classList.add('show');
    if (ms) toastTimer = setTimeout(() => el.status.classList.remove('show'), ms);
  }

  function toArrayBuffer(u8) {
    if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) return u8.buffer;
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  }

  /* ---------- loading ---------- */

  async function decodeAudio(ab, preferredRate) {
    const rates = preferredRate ? [preferredRate, 48000] : [48000];
    for (const rate of rates) {
      let ctx;
      try {
        ctx = new OfflineAudioContext(1, 1, rate);
      } catch {
        continue; // rate not supported here, try the next
      }
      return ctx.decodeAudioData(ab);
    }
    throw new Error('No audio context available');
  }

  async function loadFile(info) {
    if (!info) return;
    const id = ++S.loadId;

    el.media.pause();
    clearTimeout(S.endTimer);
    S.endTimer = null;
    Object.assign(S, { file: { path: info.path, name: info.name }, audio: null, pyr: null, peaks: [], peakIdx: -1, sel: null });

    document.body.classList.remove('empty', 'has-video');
    document.body.classList.add('loaded');
    el.title.textContent = info.name;
    document.title = info.name + ' — Crest';
    el.dur.textContent = '0:00.000';
    el.media.src = info.url;
    el.media.load();
    updateSelInfo();
    applyLoop();
    layoutOverlays();
    requestDraw();

    if (info.tooLarge || !info.bytes) {
      toast('This file is too large to draw a waveform — playback only.', 5000);
      return;
    }

    toast('Reading waveform…', 0);
    try {
      const ab = toArrayBuffer(info.bytes);
      const wav = A.sniffWavInfo(ab);
      const buf = await decodeAudio(ab, wav && wav.sampleRate);
      if (id !== S.loadId) return;

      const channels = [];
      for (let i = 0; i < buf.numberOfChannels; i++) channels.push(buf.getChannelData(i));
      S.audio = { channels, sampleRate: buf.sampleRate, length: buf.length, duration: buf.duration };
      S.pyr = A.buildPyramid(channels, 256);
      S.peaks = A.findPeaks(channels, buf.sampleRate, 8, 0.3);

      el.dur.textContent = fmtTime(buf.duration);
      fitView();
      toast('');
    } catch (err) {
      if (id !== S.loadId) return;
      console.error(err);
      S.audio = null;
      toast('Couldn’t draw this file’s waveform — you can still play it.', 5000);
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

  function ensureVisible(t) {
    if (t >= S.view.start && t <= S.view.end) return;
    const span = S.view.end - S.view.start;
    setView(t - span / 2, t + span / 2);
  }

  function zoomToSelection() {
    if (!S.sel) return fitView();
    const pad = (S.sel.end - S.sel.start) * 0.06;
    setView(S.sel.start - pad, S.sel.end + pad);
  }

  /* ---------- drawing ---------- */

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
    g.fillStyle = COLOR.grid;
    g.fillRect(0, Math.round(RULER_H * dpr) - 1, w, 1);

    for (let k = Math.ceil(S.view.start / step); k * step <= S.view.end; k++) {
      const t = k * step;
      const x = Math.round(t2x(t) * dpr);
      g.fillStyle = COLOR.grid;
      g.fillRect(x, Math.round((RULER_H - 7) * dpr), Math.max(1, Math.round(dpr)), Math.round(7 * dpr));
      g.fillStyle = COLOR.muted;
      g.fillText(fmtTime(t, decimals), x + 4 * dpr, 6 * dpr);
    }
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

    const chans = S.audio.channels;
    const lanes = chans.length <= 2 ? chans.length : 1;
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
      const list = chans.length <= 2 ? [lane] : chans.map((_, i) => i);

      g.fillStyle = COLOR.grid;
      g.fillRect(0, Math.round(mid), w, line);

      const cols = A.columns(chans, S.pyr, list, s0, s1, w);
      g.fillStyle = COLOR.wave;
      for (let x = 0; x < w; x++) {
        const mx = cols.max[x];
        const mn = cols.min[x];
        if (mx < mn) continue;
        const y0 = mid - mx * amp;
        const y1 = mid - mn * amp;
        g.fillRect(x, y0, 1, Math.max(line, y1 - y0));
      }
    }

    // marker for the loudest-part target
    if (S.peakIdx >= 0 && S.peaks[S.peakIdx]) {
      const t = S.peaks[S.peakIdx].sample / sr;
      const x = Math.round(t2x(t) * dpr);
      if (x >= 0 && x <= w) {
        g.fillStyle = COLOR.accent;
        g.globalAlpha = 0.35;
        g.fillRect(x, Math.round(RULER_H * dpr), line, h);
        g.globalAlpha = 1;
      }
    }
  }

  function updatePlayhead() {
    const t = el.media.currentTime || 0;
    const x = t2x(t);
    el.playhead.style.display = x < -1 || x > W() + 1 ? 'none' : 'block';
    el.playhead.style.transform = `translateX(${Math.round(x)}px)`;
    el.cur.textContent = fmtTime(t);
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

  /* ---------- selection ---------- */

  function updateSelInfo() {
    if (S.sel) {
      const d = S.sel.end - S.sel.start;
      el.selInfo.textContent = `${fmtTime(S.sel.start)} – ${fmtTime(S.sel.end)}  ·  ${fmtTime(d)}`;
      el.selInfo.hidden = false;
      el.gripText.textContent = 'Drag selection';
      el.grip.classList.add('hot');
    } else {
      el.selInfo.hidden = true;
      el.gripText.textContent = 'Drag file';
      el.grip.classList.remove('hot');
    }
  }

  function applyLoop() {
    el.media.loop = S.loop && !S.sel;
  }

  function setSel(a, b) {
    const dur = duration();
    S.sel = { start: clamp(a, 0, dur), end: clamp(b, 0, dur) };
    layoutOverlays();
    updateSelInfo();
    applyLoop();
  }

  function clearSel() {
    if (!S.sel) return;
    S.sel = null;
    layoutOverlays();
    updateSelInfo();
    applyLoop();
  }

  /* ---------- playback ---------- */

  function seek(t, reveal) {
    t = clamp(t, 0, duration() || 0);
    el.media.currentTime = t;
    if (reveal) ensureVisible(t);
    updatePlayhead();
  }

  function togglePlay() {
    if (!S.file) return;
    const m = el.media;
    if (!m.paused) {
      m.pause();
      return;
    }
    if (S.sel) {
      if (m.currentTime < S.sel.start - 0.001 || m.currentTime >= S.sel.end - 0.01) m.currentTime = S.sel.start;
    } else if (m.ended || m.currentTime >= duration() - 0.01) {
      m.currentTime = 0;
    }
    m.play().catch(() => toast('This file can’t be played here.'));
  }

  function endOfSelection() {
    clearTimeout(S.endTimer);
    S.endTimer = null;
    if (!S.sel) return;
    if (!S.loop) el.media.pause();
    el.media.currentTime = S.sel.start;
  }

  function followPlayhead(t) {
    const span = S.view.end - S.view.start;
    if (span >= duration() - 1e-6) return;
    if (t > S.view.end - span * 0.02 || t < S.view.start) setView(t - span * 0.1, t + span * 0.9);
  }

  function tick() {
    if (!S.playing) return;
    const t = el.media.currentTime;
    if (S.sel) {
      const rem = S.sel.end - t;
      if (rem <= 0) endOfSelection();
      else if (rem < 0.06 && !S.endTimer) {
        // stop on time instead of up to a frame late
        S.endTimer = setTimeout(() => {
          S.endTimer = null;
          if (S.playing && S.sel && el.media.currentTime >= S.sel.end - 0.03) endOfSelection();
        }, rem * 1000);
      }
    }
    followPlayhead(t);
    updatePlayhead();
    requestAnimationFrame(tick);
  }

  el.media.addEventListener('play', () => {
    S.playing = true;
    el.play.classList.add('is-playing');
    requestAnimationFrame(tick);
  });
  el.media.addEventListener('pause', () => {
    S.playing = false;
    el.play.classList.remove('is-playing');
    updatePlayhead();
  });
  el.media.addEventListener('seeked', updatePlayhead);
  el.media.addEventListener('loadedmetadata', () => {
    document.body.classList.toggle('has-video', el.media.videoWidth > 0);
    if (!S.audio) {
      el.dur.textContent = fmtTime(el.media.duration);
      fitView();
    }
  });
  el.media.addEventListener('error', () => toast('This format can’t be played.', 4000));

  /* ---------- loudest part ---------- */

  function jumpToLoudest() {
    if (!S.audio) return toast('No waveform to analyse yet.');
    if (!S.peaks.length) return toast('This file is silent.');
    S.peakIdx = (S.peakIdx + 1) % S.peaks.length;
    const p = S.peaks[S.peakIdx];
    const t = p.sample / S.audio.sampleRate;
    if (S.sel && (t < S.sel.start || t > S.sel.end)) clearSel();
    seek(t, true);
    requestDraw();
    const db = 20 * Math.log10(p.amp);
    toast(`Peak ${S.peakIdx + 1} of ${S.peaks.length}  ·  ${db.toFixed(1)} dBFS`);
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
    if (e.target.closest('#selection')) return; // let the browser start a drag-out
    e.preventDefault();
    drag = { type: 'new', x0: e.clientX - el.wave.getBoundingClientRect().left, moved: false };
  });

  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const r = el.wave.getBoundingClientRect();
    const x = clamp(e.clientX - r.left, 0, r.width);
    if (drag.type === 'resize') {
      const t = x2t(x);
      setSel(Math.min(drag.anchor, t), Math.max(drag.anchor, t));
      return;
    }
    if (!drag.moved && Math.abs(x - drag.x0) < 4) return;
    if (!S.audio) return; // can only select what we can export
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

  // plain click on the selection (no drag-out) places the playhead
  el.selection.addEventListener('click', (e) => {
    seek(x2t(e.clientX - el.wave.getBoundingClientRect().left));
  });

  el.wave.addEventListener(
    'wheel',
    (e) => {
      if (!S.file || !duration()) return;
      e.preventDefault();
      const span = S.view.end - S.view.start;
      if (e.ctrlKey || e.metaKey) {
        const x = e.clientX - el.wave.getBoundingClientRect().left;
        const anchor = x2t(x);
        const factor = Math.exp(clamp(e.deltaY, -120, 120) * 0.0025);
        const newSpan = span * factor;
        setView(anchor - (x / W()) * newSpan, anchor - (x / W()) * newSpan + newSpan);
      } else {
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        setView(S.view.start + (d / W()) * span, S.view.end + (d / W()) * span);
      }
    },
    { passive: false }
  );

  /* ---------- drag out (selection or whole file) ---------- */

  function renderSelection() {
    const sr = S.audio.sampleRate;
    const a = clamp(Math.round(S.sel.start * sr), 0, S.audio.length);
    const b = clamp(Math.round(S.sel.end * sr), 0, S.audio.length);
    const base = S.file.name.replace(/\.[^.]+$/, '');
    return {
      bytes: A.encodeWav(S.audio.channels, sr, a, b),
      name: `${base}_${stamp(a / sr)}-${stamp(b / sr)}.wav`,
    };
  }

  function pathToDrag() {
    if (!S.file) return null;
    if (!S.sel || !S.audio) return S.file.path; // nothing selected: hand over the original
    const { bytes, name } = renderSelection();
    const p = api.writeExportSync(name, bytes);
    if (!p) toast('Couldn’t write the export file.');
    return p;
  }

  function onDragStart(e) {
    e.preventDefault(); // hand the drag to the OS so it carries a real file
    const p = pathToDrag();
    if (p) api.startDrag(p);
  }
  el.selection.addEventListener('dragstart', onDragStart);
  el.grip.addEventListener('dragstart', onDragStart);

  api.onMenuExport(async () => {
    if (!S.audio || !S.sel) return toast('Select part of the waveform first.');
    const { bytes, name } = renderSelection();
    const saved = await api.saveAs(name, bytes);
    if (saved) toast('Saved.');
  });

  /* ---------- buttons, keys, drop ---------- */

  async function chooseFile() {
    const info = await api.openDialog();
    if (info) loadFile(info);
  }

  el.play.addEventListener('click', togglePlay);
  el.loudest.addEventListener('click', jumpToLoudest);
  el.open.addEventListener('click', chooseFile);
  el.openBig.addEventListener('click', chooseFile);
  el.loop.addEventListener('click', () => {
    S.loop = !S.loop;
    el.loop.classList.toggle('on', S.loop);
    el.loop.setAttribute('aria-pressed', String(S.loop));
    applyLoop();
  });

  try {
    const v = parseFloat(localStorage.getItem('crest.vol'));
    if (isFinite(v)) el.vol.value = String(clamp(v, 0, 1));
  } catch {}
  el.media.volume = parseFloat(el.vol.value);
  el.vol.addEventListener('input', () => {
    el.media.volume = parseFloat(el.vol.value);
    try {
      localStorage.setItem('crest.vol', el.vol.value);
    } catch {}
  });

  // keep keyboard focus off buttons so Space always means play/pause
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) b.blur();
  });

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const onSlider = e.target === el.vol;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        togglePlay();
        break;
      case 'p':
      case 'P':
        jumpToLoudest();
        break;
      case 'l':
      case 'L':
        el.loop.click();
        break;
      case 'Escape':
        clearSel();
        break;
      case 'z':
      case 'Z':
        zoomToSelection();
        break;
      case '0':
        fitView();
        break;
      case 'Home':
        if (S.file) seek(0, true);
        break;
      case 'End':
        if (S.file) seek(duration(), true);
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
        if (onSlider || !S.file) break;
        e.preventDefault();
        seek(el.media.currentTime + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1), true);
        break;
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') e.preventDefault();
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
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (!f) return;
    const p = api.pathForFile(f);
    if (!p) return;
    const info = await api.readFile(p);
    if (info) loadFile(info);
  });

  api.onFileOpened(loadFile);
})();
