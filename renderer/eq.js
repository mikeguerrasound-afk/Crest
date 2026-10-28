/*
 * Parametric EQ: state, Web Audio chain (live and offline) and the interactive graph.
 * A band is { id, type, freq, gain, q, slope, on }. Types are Web Audio biquad types.
 */
(function (root) {
  'use strict';
  const A = root.CrestAudio;
  const I = root.CrestI18n;
  const t = (k, v) => (I ? I.t(k, v) : k);

  const MAX_BANDS = 8;
  const F_MIN = 20;
  const F_MAX = 20000;
  const G_MAX = 24;
  const LOG_MIN = Math.log10(F_MIN);
  const LOG_SPAN = Math.log10(F_MAX) - LOG_MIN;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  const TYPE_KEY = { peaking: 'tBell', lowshelf: 'tLowShelf', highshelf: 'tHighShelf', highpass: 'tLowCut', lowpass: 'tHighCut', notch: 'tNotch' };
  const HAS_GAIN = new Set(['peaking', 'lowshelf', 'highshelf']);
  const IS_CUT = new Set(['highpass', 'lowpass']);
  const COLORS = ['#ffb454', '#6ec8ff', '#9be37a', '#ff7a90', '#c49bff', '#ffd86e', '#5ee0c4', '#ff9f6e'];

  let idCounter = 1;

  function defaultState() {
    return { bands: [], out: 0, bypass: false };
  }

  function sanitize(s) {
    const st = defaultState();
    if (!s || typeof s !== 'object') return st;
    st.out = clamp(Number(s.out) || 0, -12, 12);
    st.bypass = !!s.bypass;
    const bands = Array.isArray(s.bands) ? s.bands.slice(0, MAX_BANDS) : [];
    for (const b of bands) {
      if (!b || !TYPE_KEY[b.type]) continue;
      st.bands.push({
        id: idCounter++,
        type: b.type,
        freq: clamp(Number(b.freq) || 1000, F_MIN, F_MAX),
        gain: clamp(Number(b.gain) || 0, -G_MAX, G_MAX),
        q: clamp(Number(b.q) || 1, 0.1, 18),
        slope: clamp(parseInt(b.slope, 10) || 1, 1, 4),
        on: b.on !== false,
      });
    }
    return st;
  }

  const stages = (b) => (IS_CUT.has(b.type) ? clamp(b.slope || 1, 1, 4) : 1);
  const isActive = (st) => !st.bypass && (st.out !== 0 || st.bands.some((b) => b.on));
  const structureKey = (st) =>
    st.bypass ? 'bypass' : st.bands.filter((b) => b.on).map((b) => `${b.id}:${b.type}:${stages(b)}`).join('|');

  // Web Audio's low/high-pass take Q in dB; everything else takes a plain Q.
  const qValue = (b) => (IS_CUT.has(b.type) ? 20 * Math.log10(b.q) : b.q);

  function setParam(param, v, ctx, smooth) {
    if (smooth) param.setTargetAtTime(v, ctx.currentTime, 0.012);
    else param.value = v;
  }

  function applyParams(chain, ctx, st, smooth) {
    for (const b of st.bands) {
      const list = chain.nodes.get(b.id);
      if (!list) continue;
      for (const f of list) {
        setParam(f.frequency, b.freq, ctx, smooth);
        setParam(f.gain, b.gain, ctx, smooth);
        setParam(f.Q, qValue(b), ctx, smooth);
      }
    }
    setParam(chain.out.gain, st.bypass ? 1 : Math.pow(10, st.out / 20), ctx, smooth);
  }

  /** Connects input -> bands -> output gain. Works on live and offline contexts. */
  function buildChain(ctx, input, st) {
    const nodes = new Map();
    let node = input;
    if (!st.bypass) {
      for (const b of st.bands) {
        if (!b.on) continue;
        const list = [];
        for (let s = 0; s < stages(b); s++) {
          const f = ctx.createBiquadFilter();
          f.type = b.type;
          node.connect(f);
          node = f;
          list.push(f);
        }
        nodes.set(b.id, list);
      }
    }
    const out = ctx.createGain();
    node.connect(out);
    const chain = { out, nodes, key: structureKey(st) };
    applyParams(chain, ctx, st, false);
    return chain;
  }

  /** Live parameter update. Returns false when the chain's shape changed and must be rebuilt. */
  function updateChain(chain, ctx, st) {
    if (!chain || chain.key !== structureKey(st)) return false;
    applyParams(chain, ctx, st, true);
    return true;
  }

  /** Total response in dB at each frequency (matches what the audio chain does). */
  function responseDb(st, fs, freqs) {
    const total = new Float32Array(freqs.length);
    if (st.bypass) return total;
    for (const b of st.bands) {
      if (!b.on) continue;
      const r = A.biquadResponseDb(A.biquadCoeffs(b.type, fs, b.freq, b.gain, b.q), fs, freqs);
      const n = stages(b);
      for (let i = 0; i < total.length; i++) total[i] += r[i] * n;
    }
    for (let i = 0; i < total.length; i++) total[i] += st.out;
    return total;
  }

  /* ------------------------------------------------------------------ */
  /* Interactive graph                                                   */
  /* ------------------------------------------------------------------ */

  function createUI(opt) {
    const canvas = opt.canvas;
    const g = canvas.getContext('2d');
    const paramsEl = opt.paramsEl;
    const st = opt.state;
    let selected = null;
    let drag = null;
    let hover = null;
    let W = 0;
    let H = 0;
    let dpr = 1;
    const pad = { l: 38, r: 14, t: 12, b: 22 };
    const css = getComputedStyle(document.documentElement);
    const col = (n, d) => css.getPropertyValue(n).trim() || d;
    const C = { bg: col('--eq-bg', '#101217'), grid: col('--grid', 'rgba(255,255,255,.07)'), text: col('--muted', '#8b92a3'), accent: col('--accent', '#ffb454') };

    const L = () => pad.l;
    const R = () => W - pad.r;
    const T = () => pad.t;
    const B = () => H - pad.b;
    const f2x = (f) => L() + ((Math.log10(f) - LOG_MIN) / LOG_SPAN) * (R() - L());
    const x2f = (x) => Math.pow(10, LOG_MIN + clamp((x - L()) / (R() - L()), 0, 1) * LOG_SPAN);
    const g2y = (gn) => T() + (1 - (gn + G_MAX) / (2 * G_MAX)) * (B() - T());
    const y2g = (y) => clamp((1 - (y - T()) / (B() - T())) * 2 * G_MAX - G_MAX, -G_MAX, G_MAX);
    const band = (id) => st.bands.find((b) => b.id === id) || null;
    const nodeY = (b) => g2y(HAS_GAIN.has(b.type) ? b.gain : 0);
    const changed = (structural) => {
      if (opt.onChange) opt.onChange(structural);
    };

    function resize() {
      dpr = window.devicePixelRatio || 1;
      W = canvas.clientWidth;
      H = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
    }

    /* ----- drawing ----- */

    function drawGrid() {
      g.font = '10px ' + getComputedStyle(document.body).fontFamily;
      g.textBaseline = 'middle';
      g.textAlign = 'right';
      for (const gn of [-24, -18, -12, -6, 0, 6, 12, 18, 24]) {
        const y = Math.round(g2y(gn)) + 0.5;
        g.strokeStyle = gn === 0 ? 'rgba(255,255,255,.2)' : C.grid;
        g.beginPath();
        g.moveTo(L(), y);
        g.lineTo(R(), y);
        g.stroke();
        if (gn % 12 === 0 || gn === 6 || gn === -6) {
          g.fillStyle = C.text;
          g.fillText((gn > 0 ? '+' : '') + gn, L() - 6, y);
        }
      }
      g.textAlign = 'center';
      g.textBaseline = 'top';
      const marks = [20, 30, 40, 50, 60, 70, 80, 90, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 20000];
      const labelled = { 20: '20', 50: '50', 100: '100', 200: '200', 500: '500', 1000: '1k', 2000: '2k', 5000: '5k', 10000: '10k', 20000: '20k' };
      for (const f of marks) {
        const x = Math.round(f2x(f)) + 0.5;
        const major = f === 100 || f === 1000 || f === 10000;
        g.strokeStyle = major ? 'rgba(255,255,255,.14)' : C.grid;
        g.beginPath();
        g.moveTo(x, T());
        g.lineTo(x, B());
        g.stroke();
        if (labelled[f]) {
          g.fillStyle = C.text;
          g.fillText(labelled[f], x, B() + 6);
        }
      }
    }

    function drawAnalyzer() {
      const a = opt.analyser && opt.analyser();
      if (!a || !a.node) return;
      const node = a.node;
      if (!drawAnalyzer.buf || drawAnalyzer.buf.length !== node.frequencyBinCount) drawAnalyzer.buf = new Float32Array(node.frequencyBinCount);
      const buf = drawAnalyzer.buf;
      node.getFloatFrequencyData(buf);
      const nyq = a.sampleRate / 2;
      const grad = g.createLinearGradient(0, T(), 0, B());
      grad.addColorStop(0, 'rgba(110,200,255,.34)');
      grad.addColorStop(1, 'rgba(110,200,255,.04)');
      g.beginPath();
      g.moveTo(L(), B());
      let any = false;
      for (let x = L(); x <= R(); x += 2) {
        const f = x2f(x);
        const pos = (f / nyq) * buf.length;
        const i0 = Math.min(buf.length - 1, Math.floor(pos));
        const i1 = Math.min(buf.length - 1, i0 + 1);
        const fr = pos - i0;
        let db = buf[i0] * (1 - fr) + buf[i1] * fr;
        if (!isFinite(db)) db = -140;
        db += 3 * Math.log2(f / 1000); // slight tilt so pink-ish material looks level
        const v = clamp((db + 100) / 90, 0, 1);
        if (v > 0.02) any = true;
        g.lineTo(x, B() - v * (B() - T()));
      }
      g.lineTo(R(), B());
      g.closePath();
      if (any) {
        g.fillStyle = grad;
        g.fill();
      }
    }

    function drawCurve() {
      const n = Math.max(32, Math.round(R() - L()));
      const freqs = new Float32Array(n);
      for (let i = 0; i < n; i++) freqs[i] = x2f(L() + ((R() - L()) * i) / (n - 1));
      const fs = (opt.analyser && opt.analyser() && opt.analyser().sampleRate) || 48000;
      const resp = responseDb(st, fs, freqs);
      g.beginPath();
      for (let i = 0; i < n; i++) {
        const x = L() + ((R() - L()) * i) / (n - 1);
        const y = g2y(clamp(resp[i], -G_MAX, G_MAX));
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      }
      g.strokeStyle = st.bypass ? 'rgba(255,255,255,.3)' : C.accent;
      g.lineWidth = 2;
      g.stroke();
      g.lineWidth = 1;
      const zero = g2y(0);
      g.lineTo(R(), zero);
      g.lineTo(L(), zero);
      g.closePath();
      g.fillStyle = st.bypass ? 'rgba(255,255,255,.04)' : 'rgba(255,180,84,.12)';
      g.fill();
    }

    function drawNodes() {
      st.bands.forEach((b, i) => {
        const x = f2x(b.freq);
        const y = nodeY(b);
        const c = COLORS[i % COLORS.length];
        g.globalAlpha = b.on && !st.bypass ? 1 : 0.4;
        if (b.id === selected) {
          g.beginPath();
          g.arc(x, y, 11, 0, Math.PI * 2);
          g.strokeStyle = '#fff';
          g.lineWidth = 1.5;
          g.stroke();
          g.lineWidth = 1;
        }
        g.beginPath();
        g.arc(x, y, b.id === hover || b.id === selected ? 7 : 6, 0, Math.PI * 2);
        g.fillStyle = c;
        g.fill();
        g.strokeStyle = 'rgba(0,0,0,.55)';
        g.stroke();
        g.fillStyle = '#10121a';
        g.font = 'bold 9px ' + getComputedStyle(document.body).fontFamily;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(String(i + 1), x, y + 0.5);
        g.globalAlpha = 1;
      });
    }

    function draw() {
      if (!W || !H) resize();
      if (!W || !H) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      g.fillStyle = C.bg;
      g.fillRect(0, 0, W, H);
      drawGrid();
      g.save();
      g.beginPath();
      g.rect(L(), T(), R() - L(), B() - T());
      g.clip();
      drawAnalyzer();
      drawCurve();
      g.restore();
      drawNodes();
    }

    /* ----- interaction ----- */

    function pos(e) {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    function hit(p) {
      let best = null;
      let bd = 14;
      for (const b of st.bands) {
        const d = Math.hypot(f2x(b.freq) - p.x, nodeY(b) - p.y);
        if (d < bd) {
          bd = d;
          best = b;
        }
      }
      return best;
    }

    canvas.addEventListener('pointerdown', (e) => {
      const p = pos(e);
      const b = hit(p);
      if (b) {
        select(b.id);
        drag = { id: b.id, dx: f2x(b.freq) - p.x, dy: nodeY(b) - p.y };
        canvas.setPointerCapture(e.pointerId);
      } else select(null);
    });
    canvas.addEventListener('pointermove', (e) => {
      const p = pos(e);
      if (drag) {
        const b = band(drag.id);
        if (!b) return;
        b.freq = Math.round(x2f(p.x + drag.dx) * 10) / 10;
        if (HAS_GAIN.has(b.type)) b.gain = Math.round(y2g(p.y + drag.dy) * 10) / 10;
        syncParams();
        changed(false);
        return;
      }
      const h = hit(p);
      const nh = h ? h.id : null;
      if (nh !== hover) {
        hover = nh;
        canvas.style.cursor = nh ? 'grab' : 'default';
      }
    });
    const endDrag = () => {
      drag = null;
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    canvas.addEventListener('dblclick', (e) => {
      const p = pos(e);
      const b = hit(p);
      if (b) return;
      if (st.bands.length >= MAX_BANDS) return;
      if (p.x < L() || p.x > R() || p.y < T() || p.y > B()) return;
      const nb = { id: idCounter++, type: 'peaking', freq: Math.round(x2f(p.x)), gain: Math.round(y2g(p.y) * 10) / 10, q: 1, slope: 1, on: true };
      st.bands.push(nb);
      select(nb.id);
      changed(true);
    });

    canvas.addEventListener(
      'wheel',
      (e) => {
        const b = hit(pos(e)) || band(selected);
        if (!b) return;
        e.preventDefault();
        b.q = clamp(Math.round(b.q * Math.exp(-e.deltaY * 0.0018) * 100) / 100, 0.1, 18);
        select(b.id);
        syncParams();
        changed(false);
      },
      { passive: false }
    );

    function remove(id) {
      const i = st.bands.findIndex((b) => b.id === id);
      if (i < 0) return;
      st.bands.splice(i, 1);
      selected = null;
      renderParams();
      changed(true);
    }

    window.addEventListener('keydown', (e) => {
      if (!opt.isVisible()) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected != null) {
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        remove(selected);
      }
    });

    /* ----- parameter row ----- */

    const els = {};
    function buildParams() {
      paramsEl.innerHTML = '';
      const mk = (tag, props) => Object.assign(document.createElement(tag), props || {});
      const field = (labelKey, input, unit, cls) => {
        const w = mk('label', { className: 'eqf' + (cls ? ' ' + cls : '') });
        w.appendChild(mk('span', { textContent: t(labelKey) }));
        w.appendChild(input);
        if (unit) w.appendChild(mk('em', { textContent: unit }));
        return w;
      };
      els.badge = mk('span', { className: 'eq-badge' });
      els.type = mk('select');
      for (const k of Object.keys(TYPE_KEY)) els.type.appendChild(mk('option', { value: k, textContent: t(TYPE_KEY[k]) }));
      els.freq = mk('input', { type: 'number', min: F_MIN, max: F_MAX, step: 1 });
      els.gain = mk('input', { type: 'number', min: -G_MAX, max: G_MAX, step: 0.1 });
      els.q = mk('input', { type: 'number', min: 0.1, max: 18, step: 0.05 });
      els.slope = mk('select');
      [1, 2, 3, 4].forEach((n) => els.slope.appendChild(mk('option', { value: n, textContent: n * 12 + ' dB/oct' })));
      els.on = mk('input', { type: 'checkbox' });
      els.del = mk('button', { className: 'mini', textContent: t('eqDelete') });

      const onW = mk('label', { className: 'eqf chk' });
      onW.appendChild(els.on);
      onW.appendChild(mk('span', { textContent: t('eqOn') }));
      els.fFreq = field('eqFreq', els.freq, 'Hz');
      els.fGain = field('eqGain', els.gain, 'dB');
      els.fQ = field('eqQ', els.q);
      els.fSlope = field('eqSlope', els.slope);
      paramsEl.append(els.badge, field('eqType', els.type), els.fFreq, els.fGain, els.fQ, els.fSlope, onW, els.del);

      const edit = (fn, structural) => () => {
        const b = band(selected);
        if (!b) return;
        fn(b);
        syncParams();
        changed(!!structural);
      };
      els.type.addEventListener('change', edit((b) => { b.type = els.type.value; if (!HAS_GAIN.has(b.type)) b.gain = 0; if (IS_CUT.has(b.type) && b.q > 4) b.q = 0.71; }, true));
      els.freq.addEventListener('change', edit((b) => { b.freq = clamp(parseFloat(els.freq.value) || b.freq, F_MIN, F_MAX); }));
      els.gain.addEventListener('change', edit((b) => { b.gain = clamp(parseFloat(els.gain.value) || 0, -G_MAX, G_MAX); }));
      els.q.addEventListener('change', edit((b) => { b.q = clamp(parseFloat(els.q.value) || b.q, 0.1, 18); }));
      els.slope.addEventListener('change', edit((b) => { b.slope = parseInt(els.slope.value, 10) || 1; }, true));
      els.on.addEventListener('change', edit((b) => { b.on = els.on.checked; }, true));
      els.del.addEventListener('click', () => remove(selected));
    }

    function syncParams() {
      const b = band(selected);
      paramsEl.classList.toggle('empty', !b);
      if (!b) return;
      const i = st.bands.indexOf(b);
      els.badge.textContent = String(i + 1);
      els.badge.style.background = COLORS[i % COLORS.length];
      const set = (el, v) => {
        if (document.activeElement !== el) el.value = v;
      };
      set(els.type, b.type);
      set(els.freq, Math.round(b.freq * 10) / 10);
      set(els.gain, b.gain);
      set(els.q, b.q);
      set(els.slope, stages(b));
      els.on.checked = b.on;
      els.fGain.style.display = HAS_GAIN.has(b.type) ? '' : 'none';
      els.fQ.style.display = b.type === 'lowshelf' || b.type === 'highshelf' ? 'none' : '';
      els.fSlope.style.display = IS_CUT.has(b.type) ? '' : 'none';
    }

    function renderParams() {
      buildParams();
      syncParams();
    }

    function select(id) {
      selected = id;
      syncParams();
    }

    renderParams();

    return {
      draw, resize, renderParams, syncParams,
      select, remove,
      get selected() { return selected; },
      setState(ns) {
        st.bands = ns.bands;
        st.out = ns.out;
        st.bypass = ns.bypass;
        selected = null;
        syncParams();
      },
    };
  }

  root.CrestEQ = { MAX_BANDS, F_MIN, F_MAX, defaultState, sanitize, isActive, structureKey, buildChain, updateChain, responseDb, createUI };
})(typeof self !== 'undefined' ? self : this);
