/*
 * Pure audio helpers — no DOM, no Electron. Runs in the renderer (as window.CrestAudio)
 * and in Node (for the tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CrestAudio = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

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
   * 24-bit PCM WAV of channels[*][start, end). Float32 in, exact round-trip for 24-bit sources.
   * More than two channels are written as WAVE_FORMAT_EXTENSIBLE.
   */
  function encodeWav(channels, sampleRate, start, end) {
    const nCh = channels.length;
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
    if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
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
      o += 8 + size + (size & 1);
    }
    return null;
  }

  return { buildPyramid, columns, findPeaks, encodeWav, sniffWavInfo };
});
