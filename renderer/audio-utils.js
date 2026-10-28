/*
 * Pure audio helpers — no DOM, no Electron. Runs in the renderer (as window.CrestAudio)
 * and in Node (for the tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CrestAudio = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  /* ------------------------------------------------------------------ */
  /* Waveform drawing                                                    */
  /* ------------------------------------------------------------------ */

  /** Min/max per block of `block` samples, per channel. Makes zoomed-out redraws cheap. */
  function buildPyramid(channels, block) {
    block = block || 256;
    const min = [];
    const max = [];
    for (const data of channels) {
      const n = Math.ceil(data.length / block);
      const mn = new Float32Array(n);
      const mx = new Float32Array(n);
      for (let b = 0; b < n; b++) {
        const s = b * block;
        const e = Math.min(s + block, data.length);
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = s; i < e; i++) {
          const v = data[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        mn[b] = lo;
        mx[b] = hi;
      }
      min.push(mn);
      max.push(mx);
    }
    return { block, min, max };
  }

  /**
   * Min/max for each of `width` pixel columns covering samples [s0, s1).
   * `chans` is the list of channel indices to merge into this lane.
   * Columns with no data come back with max < min.
   */
  function columns(channels, pyr, chans, s0, s1, width) {
    const min = new Float32Array(width).fill(1);
    const max = new Float32Array(width).fill(-1);
    const total = channels[0].length;
    const spp = (s1 - s0) / width;
    const usePyr = spp >= pyr.block * 2;
    for (let x = 0; x < width; x++) {
      const a = s0 + x * spp;
      const b = a + spp;
      let lo = Infinity;
      let hi = -Infinity;
      for (const ch of chans) {
        if (usePyr) {
          const mn = pyr.min[ch];
          const mx = pyr.max[ch];
          const b0 = Math.max(0, Math.floor(a / pyr.block));
          const b1 = Math.min(mn.length, Math.ceil(b / pyr.block));
          for (let k = b0; k < b1; k++) {
            if (mn[k] < lo) lo = mn[k];
            if (mx[k] > hi) hi = mx[k];
          }
        } else {
          const d = channels[ch];
          const i0 = Math.max(0, Math.floor(a));
          const i1 = Math.min(total, Math.max(i0 + 1, Math.ceil(b)));
          for (let i = i0; i < i1; i++) {
            const v = d[i];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
      }
      if (lo <= hi) {
        min[x] = lo;
        max[x] = hi;
      }
    }
    return { min, max };
  }

  /* ------------------------------------------------------------------ */
  /* Loudest moments and hit (onset) detection                           */
  /* ------------------------------------------------------------------ */

  /**
   * Loudest moments, loudest first. Looks at 5 ms windows and keeps picks at least
   * `minSepSec` apart so repeated presses walk through different hits, not one hit's neighbours.
   * Returns [{ sample, amp }].
   */
  function findPeaks(channels, sampleRate, count, minSepSec) {
    count = count || 8;
    minSepSec = minSepSec || 0.3;
    const n = channels.length ? channels[0].length : 0;
    if (!n) return [];
    const win = Math.max(1, Math.round(sampleRate * 0.005));
    const nWin = Math.ceil(n / win);
    const env = new Float32Array(nWin);
    const pos = new Int32Array(nWin);
    for (const d of channels) {
      for (let w = 0; w < nWin; w++) {
        const s = w * win;
        const e = Math.min(s + win, n);
        let best = env[w];
        let bi = pos[w];
        for (let i = s; i < e; i++) {
          const v = Math.abs(d[i]);
          if (v > best) {
            best = v;
            bi = i;
          }
        }
        env[w] = best;
        pos[w] = bi;
      }
    }
    const cand = [];
    for (let w = 0; w < nWin; w++) {
      const v = env[w];
      if (v <= 0) continue;
      const l = w > 0 ? env[w - 1] : -1;
      const r = w < nWin - 1 ? env[w + 1] : -1;
      if (v >= l && v >= r) cand.push(w);
    }
    cand.sort((a, b) => env[b] - env[a]);
    const sepWin = Math.max(1, Math.round(minSepSec / 0.005));
    const picked = [];
    for (const w of cand) {
      if (picked.every((p) => Math.abs(p.w - w) >= sepWin)) {
        picked.push({ w, sample: pos[w], amp: env[w] });
        if (picked.length >= count) break;
      }
    }
    return picked.map((p) => ({ sample: p.sample, amp: p.amp }));
  }

  /**
   * Finds individual sound events (impacts, steps, clicks...) and where each one ends.
   * A hit starts when the 2 ms peak envelope rises `riseDb` above the quietest point of the
   * last `lookbackMs`, and ends when the tail has fallen `tailDb` below its peak (or at the next hit).
   * Returns [{ start, end, peak, amp }] in samples, in time order.
   */
  function detectHits(channels, sr, opt) {
    const o = Object.assign(
      { winMs: 2, riseDb: 10, floorDb: -50, lookbackMs: 80, tailDb: 36, tailFloorDb: -75, holdMs: 30, padMs: 8, prerollMs: 3, minLenMs: 20 },
      opt || {}
    );
    const n = channels.length ? channels[0].length : 0;
    if (!n) return [];
    const win = Math.max(1, Math.round((sr * o.winMs) / 1000));
    const nW = Math.ceil(n / win);
    const env = new Float32Array(nW);
    for (const d of channels) {
      for (let w = 0; w < nW; w++) {
        const s = w * win;
        const e = Math.min(s + win, n);
        let m = env[w];
        for (let i = s; i < e; i++) {
          const v = d[i] < 0 ? -d[i] : d[i];
          if (v > m) m = v;
        }
        env[w] = m;
      }
    }
    const db = new Float32Array(nW);
    for (let w = 0; w < nW; w++) db[w] = env[w] > 1e-6 ? 20 * Math.log10(env[w]) : -120;

    const L = Math.max(2, Math.round(o.lookbackMs / o.winMs));
    const holdW = Math.max(1, Math.round(o.holdMs / o.winMs));
    const peakSpan = Math.max(1, Math.round(60 / o.winMs));
    const found = [];
    let lastPk = -1;
    let w = 0;
    while (w < nW) {
      let ref = -120;
      if (w > 0) {
        ref = Infinity;
        for (let k = Math.max(0, w - L, lastPk); k < w; k++) if (db[k] < ref) ref = db[k];
        if (ref === Infinity) ref = db[w - 1];
      }
      if (db[w] >= o.floorDb && db[w] - ref >= o.riseDb) {
        const lo = Math.max(0, w - L, lastPk + 1);
        let s = w;
        while (s > lo && db[s - 1] >= ref + 3) s--;
        let pk = w;
        for (let k = w; k <= Math.min(nW - 1, w + peakSpan); k++) if (db[k] > db[pk]) pk = k;
        found.push({ sw: s, pw: pk, pdb: db[pk] });
        lastPk = pk;
        w = pk + 1;
        continue;
      }
      w++;
    }

    const pre = Math.round((sr * o.prerollMs) / 1000);
    const pad = Math.round((sr * o.padMs) / 1000);
    const minLen = Math.round((sr * o.minLenMs) / 1000);
    const hits = [];
    for (let i = 0; i < found.length; i++) {
      const f = found[i];
      const next = found[i + 1];
      const limitW = next ? next.sw : nW;
      const thr = Math.max(f.pdb - o.tailDb, o.tailFloorDb);
      let endW = limitW;
      let run = 0;
      for (let k = f.pw; k < limitW; k++) {
        if (db[k] < thr) {
          run++;
          if (run >= holdW) {
            endW = k - run + 1;
            break;
          }
        } else run = 0;
      }
      let start = Math.max(0, f.sw * win - pre);
      let end = Math.min(n, endW * win + pad);
      if (next) end = Math.min(end, Math.max(start + 1, next.sw * win - pre));
      if (hits.length && start < hits[hits.length - 1].end) start = hits[hits.length - 1].end;
      if (end - start < minLen) end = Math.min(n, start + minLen);
      let peak = f.pw * win;
      let amp = 0;
      const pe = Math.min(n, (f.pw + 1) * win);
      for (const d of channels) {
        for (let k = f.pw * win; k < pe; k++) {
          const v = d[k] < 0 ? -d[k] : d[k];
          if (v > amp) {
            amp = v;
            peak = k;
          }
        }
      }
      hits.push({ start, end, peak, amp });
    }
    return hits;
  }

  /* ------------------------------------------------------------------ */
  /* Click-free cutting                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * Nearest zero crossing of the channel mix within ±maxMs of `idx` (returns `idx` if there is none).
   */
  function snapZero(channels, idx, sr, maxMs) {
    const n = channels[0].length;
    idx = clamp(Math.round(idx), 0, n);
    const R = Math.round((sr * (maxMs == null ? 3 : maxMs)) / 1000);
    const nc = channels.length;
    const mix = (i) => {
      let s = 0;
      for (let c = 0; c < nc; c++) s += channels[c][i];
      return s / nc;
    };
    const lo = Math.max(0, idx - R);
    const hi = Math.min(n - 1, idx + R);
    let best = idx;
    let bestD = Infinity;
    let prev = mix(lo);
    for (let i = lo + 1; i <= hi; i++) {
      const cur = mix(i);
      if ((prev <= 0 && cur >= 0) || (prev >= 0 && cur <= 0)) {
        const j = Math.abs(prev) < Math.abs(cur) ? i - 1 : i;
        const d = Math.abs(j - idx);
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      }
      prev = cur;
    }
    return best;
  }

  /** Half-cosine fades, applied in place. */
  function applyFade(channels, sr, inMs, outMs) {
    for (const d of channels) {
      const n = d.length;
      const fi = Math.min(Math.round((sr * (inMs || 0)) / 1000), n >> 1);
      const fo = Math.min(Math.round((sr * (outMs || 0)) / 1000), n >> 1);
      for (let i = 0; i < fi; i++) d[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fi);
      for (let i = 0; i < fo; i++) d[n - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fo);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Loudness (ITU-R BS.1770-4 / EBU R128)                               */
  /* ------------------------------------------------------------------ */

  function kWeighting(fs) {
    let f0 = 1681.974450955533;
    let G = 3.999843853973347;
    let Q = 0.7071752369554196;
    let K = Math.tan((Math.PI * f0) / fs);
    const Vh = Math.pow(10, G / 20);
    const Vb = Math.pow(Vh, 0.4996667741545416);
    let a0 = 1 + K / Q + K * K;
    const s1 = {
      b0: (Vh + (Vb * K) / Q + K * K) / a0,
      b1: (2 * (K * K - Vh)) / a0,
      b2: (Vh - (Vb * K) / Q + K * K) / a0,
      a1: (2 * (K * K - 1)) / a0,
      a2: (1 - K / Q + K * K) / a0,
    };
    f0 = 38.13547087602444;
    Q = 0.5003270373238773;
    K = Math.tan((Math.PI * f0) / fs);
    a0 = 1 + K / Q + K * K;
    const s2 = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
    return [s1, s2];
  }

  const toDb = (x) => (x > 0 ? 10 * Math.log10(x) : -Infinity);

  /**
   * Sample peak, RMS and integrated loudness of channels[*][start, end).
   * Regions shorter than 400 ms are measured as one block (no gating).
   * Returns { peakDb, rmsDb, lufs } (−Infinity for silence).
   */
  function loudness(channels, sr, start, end) {
    const nc = channels.length;
    const n = channels[0].length;
    start = clamp(Math.round(start || 0), 0, n);
    end = clamp(Math.round(end == null ? n : end), start, n);
    const len = end - start;
    if (!len) return { peakDb: -Infinity, rmsDb: -Infinity, lufs: -Infinity };

    const hop = Math.max(1, Math.round(sr * 0.1));
    const nHops = Math.ceil(len / hop);
    const hopSum = []; // per channel, per hop: sum of squares of K-weighted signal
    const [s1, s2] = kWeighting(sr);
    let peak = 0;
    let sumSq = 0;
    for (let c = 0; c < nc; c++) {
      const d = channels[c];
      const hs = new Float64Array(nHops);
      let x1a = 0, x2a = 0, y1a = 0, y2a = 0; // stage 1 state
      let x1b = 0, x2b = 0, y1b = 0, y2b = 0; // stage 2 state
      for (let i = 0; i < len; i++) {
        const x = d[start + i];
        const ax = x < 0 ? -x : x;
        if (ax > peak) peak = ax;
        sumSq += x * x;
        const y = s1.b0 * x + s1.b1 * x1a + s1.b2 * x2a - s1.a1 * y1a - s1.a2 * y2a;
        x2a = x1a; x1a = x; y2a = y1a; y1a = y;
        const z = s2.b0 * y + s2.b1 * x1b + s2.b2 * x2b - s2.a1 * y1b - s2.a2 * y2b;
        x2b = x1b; x1b = y; y2b = y1b; y1b = z;
        hs[(i / hop) | 0] += z * z;
      }
      hopSum.push(hs);
    }
    const weight = (c) => (nc === 6 ? (c === 3 ? 0 : c >= 4 ? 1.41 : 1) : 1);

    // 400 ms blocks (4 hops), 75 % overlap
    const hopLen = (h) => Math.min(hop, len - h * hop);
    const blocks = [];
    if (len < sr * 0.4 || nHops < 4) {
      let z = 0;
      for (let c = 0; c < nc; c++) {
        let s = 0;
        for (let h = 0; h < nHops; h++) s += hopSum[c][h];
        z += weight(c) * (s / len);
      }
      blocks.push(z);
    } else {
      for (let h = 0; h + 4 <= nHops; h++) {
        let samples = 0;
        for (let k = 0; k < 4; k++) samples += hopLen(h + k);
        let z = 0;
        for (let c = 0; c < nc; c++) {
          let s = 0;
          for (let k = 0; k < 4; k++) s += hopSum[c][h + k];
          z += weight(c) * (s / samples);
        }
        blocks.push(z);
      }
    }
    const lk = (z) => -0.691 + toDb(z);
    let kept = blocks.filter((z) => lk(z) > -70);
    let lufs = -Infinity;
    if (kept.length && blocks.length > 1) {
      const rel = lk(kept.reduce((a, b) => a + b, 0) / kept.length) - 10;
      kept = kept.filter((z) => lk(z) > rel);
    }
    if (kept.length) lufs = lk(kept.reduce((a, b) => a + b, 0) / kept.length);
    else if (blocks.length === 1) lufs = lk(blocks[0]);

    return {
      peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
      rmsDb: toDb(sumSq / (len * nc)),
      lufs,
    };
  }

  /* ------------------------------------------------------------------ */
  /* FFT + spectrogram                                                   */
  /* ------------------------------------------------------------------ */

  const fftCache = new Map();
  function fftTables(n) {
    let t = fftCache.get(n);
    if (t) return t;
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    const rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      rev[i] = r;
    }
    const hann = new Float64Array(n);
    for (let i = 0; i < n; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    t = { cos, sin, rev, hann };
    fftCache.set(n, t);
    return t;
  }

  /** In-place radix-2 FFT. re/im lengths must be the same power of two. */
  function fft(re, im) {
    const n = re.length;
    const { cos, sin, rev } = fftTables(n);
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j;
          const b = a + half;
          const tr = re[b] * cos[k] - im[b] * sin[k];
          const ti = re[b] * sin[k] + im[b] * cos[k];
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }

  /**
   * Log-frequency spectrogram of samples [s0, s1) as cols x rows intensities (0..255).
   * Row 0 is the highest frequency. Channels are mixed to mono. 0 dBFS sine = 0 dB.
   */
  function spectrogram(channels, sr, s0, s1, cols, rows, opt) {
    const o = Object.assign({ fftSize: 2048, minHz: 30, maxHz: Math.min(20000, sr / 2), minDb: -100, maxDb: 0 }, opt || {});
    const N = o.fftSize;
    const { hann } = fftTables(N);
    const out = new Uint8Array(cols * rows);
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    const mag = new Float32Array(N / 2 + 1);
    const nCh = channels.length;
    const total = channels[0].length;
    const spp = (s1 - s0) / cols;
    const rowBin = new Float64Array(rows + 1);
    for (let r = 0; r <= rows; r++) rowBin[r] = (o.maxHz * Math.pow(o.minHz / o.maxHz, r / rows) * N) / sr;
    const norm = 4 / N;
    const span = o.maxDb - o.minDb;

    for (let x = 0; x < cols; x++) {
      const c = Math.round(s0 + (x + 0.5) * spp);
      const st = c - (N >> 1);
      for (let i = 0; i < N; i++) {
        const idx = st + i;
        let v = 0;
        if (idx >= 0 && idx < total) {
          for (let ch = 0; ch < nCh; ch++) v += channels[ch][idx];
          v /= nCh;
        }
        re[i] = v * hann[i];
        im[i] = 0;
      }
      fft(re, im);
      for (let k = 0; k <= N / 2; k++) mag[k] = 20 * Math.log10(Math.hypot(re[k], im[k]) * norm + 1e-9);
      for (let r = 0; r < rows; r++) {
        const hiB = rowBin[r];
        const loB = rowBin[r + 1];
        const k0 = Math.ceil(loB);
        const k1 = Math.floor(hiB);
        let d;
        if (k1 >= k0) {
          d = -Infinity;
          for (let k = k0; k <= k1 && k <= N / 2; k++) if (mag[k] > d) d = mag[k];
        } else {
          const b = (hiB + loB) / 2;
          const b0 = Math.floor(b);
          const f = b - b0;
          d = mag[Math.min(b0, N / 2)] * (1 - f) + mag[Math.min(b0 + 1, N / 2)] * f;
        }
        out[r * cols + x] = Math.round(clamp((d - o.minDb) / span, 0, 1) * 255);
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Biquad maths (matches Web Audio's BiquadFilterNode)                 */
  /* ------------------------------------------------------------------ */

  /** RBJ coefficients, a0 normalised to 1. `q` is a plain (linear) Q. */
  function biquadCoeffs(type, fs, f0, gainDb, q) {
    f0 = clamp(f0, 1, fs * 0.499);
    q = Math.max(q, 0.01);
    const w0 = (2 * Math.PI * f0) / fs;
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    const A = Math.pow(10, (gainDb || 0) / 40);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'peaking') {
      const al = sin / (2 * q);
      b0 = 1 + al * A; b1 = -2 * cos; b2 = 1 - al * A;
      a0 = 1 + al / A; a1 = -2 * cos; a2 = 1 - al / A;
    } else if (type === 'lowshelf' || type === 'highshelf') {
      const al = (sin / 2) * Math.SQRT2;
      const sA = 2 * Math.sqrt(A) * al;
      if (type === 'lowshelf') {
        b0 = A * (A + 1 - (A - 1) * cos + sA);
        b1 = 2 * A * (A - 1 - (A + 1) * cos);
        b2 = A * (A + 1 - (A - 1) * cos - sA);
        a0 = A + 1 + (A - 1) * cos + sA;
        a1 = -2 * (A - 1 + (A + 1) * cos);
        a2 = A + 1 + (A - 1) * cos - sA;
      } else {
        b0 = A * (A + 1 + (A - 1) * cos + sA);
        b1 = -2 * A * (A - 1 + (A + 1) * cos);
        b2 = A * (A + 1 + (A - 1) * cos - sA);
        a0 = A + 1 - (A - 1) * cos + sA;
        a1 = 2 * (A - 1 - (A + 1) * cos);
        a2 = A + 1 - (A - 1) * cos - sA;
      }
    } else if (type === 'lowpass') {
      const al = sin / (2 * q);
      b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
      a0 = 1 + al; a1 = -2 * cos; a2 = 1 - al;
    } else if (type === 'highpass') {
      const al = sin / (2 * q);
      b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
      a0 = 1 + al; a1 = -2 * cos; a2 = 1 - al;
    } else if (type === 'notch') {
      const al = sin / (2 * q);
      b0 = 1; b1 = -2 * cos; b2 = 1;
      a0 = 1 + al; a1 = -2 * cos; a2 = 1 - al;
    } else throw new Error('unknown biquad type ' + type);
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }

  /** Magnitude in dB of one biquad at each frequency in `freqs`. */
  function biquadResponseDb(c, fs, freqs) {
    const out = new Float32Array(freqs.length);
    for (let i = 0; i < freqs.length; i++) {
      const w = (2 * Math.PI * freqs[i]) / fs;
      const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
      const nr = c.b0 + c.b1 * c1 + c.b2 * c2;
      const ni = -(c.b1 * s1 + c.b2 * s2);
      const dr = 1 + c.a1 * c1 + c.a2 * c2;
      const di = -(c.a1 * s1 + c.a2 * s2);
      out[i] = 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di) + 1e-30);
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Small formatters / helpers                                          */
  /* ------------------------------------------------------------------ */

  function fmtTime(t, decimals) {
    if (decimals == null) decimals = 3;
    if (!isFinite(t) || t < 0) t = 0;
    const totalMs = Math.round(t * 1000);
    const ms = totalMs % 1000;
    const s = Math.floor(totalMs / 1000) % 60;
    const m = Math.floor(totalMs / 60000) % 60;
    const h = Math.floor(totalMs / 3600000);
    const frac = decimals ? '.' + String(ms).padStart(3, '0').slice(0, decimals) : '';
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0') + frac;
  }

  function fmtTimecode(t, fps) {
    fps = fps > 0 ? fps : 30;
    const nominal = Math.round(fps);
    const frames = Math.floor(Math.max(0, t) * fps + 1e-6);
    const ff = frames % nominal;
    const secs = Math.floor(frames / nominal);
    const p = (v) => String(v).padStart(2, '0');
    return p(Math.floor(secs / 3600)) + ':' + p(Math.floor(secs / 60) % 60) + ':' + p(secs % 60) + ':' + p(ff);
  }

  /** 1m23s450 — safe in file names on every OS */
  function stamp(t) {
    const ms = Math.round(t * 1000);
    return Math.floor(ms / 60000) + 'm' + String(Math.floor(ms / 1000) % 60).padStart(2, '0') + 's' + String(ms % 1000).padStart(3, '0');
  }

  const semitoneRate = (st) => Math.pow(2, st / 12);

  function ucsClean(s) {
    return String(s == null ? '' : s)
      .replace(/[\\/:*?"<>|_\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** CatID_FXName_CreatorID_SourceID (Universal Category System). `index` numbers a batch. */
  function ucsName(f, index) {
    const cat = ucsClean(f.catId).replace(/\s/g, '') || 'MISC';
    let fx = ucsClean(f.fxName) || 'Untitled';
    if (index != null) fx += ' ' + String(index).padStart(2, '0');
    const parts = [cat, fx, ucsClean(f.creatorId), ucsClean(f.sourceId)];
    while (parts.length > 2 && !parts[parts.length - 1]) parts.pop();
    return parts.join('_');
  }

  /* ------------------------------------------------------------------ */
  /* WAV                                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * 24-bit PCM WAV of channels[*][start, end). Float32 in, exact round-trip for 24-bit sources.
   * More than two channels are written as WAVE_FORMAT_EXTENSIBLE.
   */
  function encodeWav(channels, sampleRate, start, end) {
    const nCh = channels.length;
    start = start || 0;
    if (end == null) end = channels[0].length;
    const frames = Math.max(0, end - start);
    const bytesPer = 3;
    const dataBytes = frames * nCh * bytesPer;
    const pad = dataBytes & 1;
    const ext = nCh > 2;
    const fmtSize = ext ? 40 : 16;
    const total = 12 + 8 + fmtSize + 8 + dataBytes + pad;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    let o = 0;
    const str = (s) => {
      for (let i = 0; i < s.length; i++) out[o++] = s.charCodeAt(i);
    };
    const u16 = (v) => {
      dv.setUint16(o, v, true);
      o += 2;
    };
    const u32 = (v) => {
      dv.setUint32(o, v, true);
      o += 4;
    };

    str('RIFF');
    u32(total - 8);
    str('WAVE');
    str('fmt ');
    u32(fmtSize);
    u16(ext ? 0xfffe : 1);
    u16(nCh);
    u32(sampleRate);
    u32(sampleRate * nCh * bytesPer);
    u16(nCh * bytesPer);
    u16(24);
    if (ext) {
      u16(22); // cbSize
      u16(24); // valid bits per sample
      u32(0); // channel mask: unspecified
      const pcmGuid = [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
      for (const b of pcmGuid) out[o++] = b;
    }
    str('data');
    u32(dataBytes);

    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < nCh; c++) {
        let v = Math.round(channels[c][start + f] * 8388608);
        if (v > 8388607) v = 8388607;
        else if (v < -8388608) v = -8388608;
        out[o++] = v & 255;
        out[o++] = (v >> 8) & 255;
        out[o++] = (v >> 16) & 255;
      }
    }
    return out;
  }

  /**
   * Reads channels / sample rate / bit depth from a WAV header, or null if it isn't a WAV.
   * Lets us decode at the file's own sample rate so exports aren't resampled.
   */
  function sniffWavInfo(ab) {
    if (!ab || ab.byteLength < 44) return null;
    const dv = new DataView(ab);
    const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    const t0 = tag(0);
    if ((t0 !== 'RIFF' && t0 !== 'RF64') || tag(8) !== 'WAVE') return null;
    let o = 12;
    while (o + 8 <= ab.byteLength) {
      const id = tag(o);
      const size = dv.getUint32(o + 4, true);
      if (id === 'fmt ' && o + 8 + 16 <= ab.byteLength) {
        return {
          channels: dv.getUint16(o + 10, true),
          sampleRate: dv.getUint32(o + 12, true),
          bits: dv.getUint16(o + 22, true),
        };
      }
      if (size === 0xffffffff) break;
      o += 8 + size + (size & 1);
    }
    return null;
  }

  return {
    buildPyramid, columns, findPeaks, detectHits, snapZero, applyFade, loudness,
    fft, spectrogram, biquadCoeffs, biquadResponseDb,
    fmtTime, fmtTimecode, stamp, semitoneRate, ucsName, ucsClean, encodeWav, sniffWavInfo,
  };
});
