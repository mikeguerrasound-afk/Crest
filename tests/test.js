// Logic tests for the pure audio helpers. Run with: npm test
const assert = require('assert');
const A = require('../renderer/audio-utils.js');

const sr = 48000;
let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log('ok  ' + name);
};

// ---- helper: read a 24-bit WAV back so we can check what we wrote ----
function parseWav(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  assert.strictEqual(tag(0), 'RIFF');
  assert.strictEqual(tag(8), 'WAVE');
  let o = 12;
  let fmt = null;
  while (o + 8 <= u8.length) {
    const id = tag(o);
    const size = dv.getUint32(o + 4, true);
    if (id === 'fmt ') {
      fmt = {
        tag: dv.getUint16(o + 8, true),
        channels: dv.getUint16(o + 10, true),
        sampleRate: dv.getUint32(o + 12, true),
        blockAlign: dv.getUint16(o + 20, true),
        bits: dv.getUint16(o + 22, true),
      };
    }
    if (id === 'data') {
      const frames = size / fmt.blockAlign;
      const ch = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
      let p = o + 8;
      for (let f = 0; f < frames; f++) {
        for (let c = 0; c < fmt.channels; c++) {
          let v = u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16);
          if (v & 0x800000) v -= 0x1000000;
          ch[c][f] = v / 8388608;
          p += 3;
        }
      }
      return { fmt, frames, ch, riffSize: dv.getUint32(4, true), total: u8.length, dataSize: size };
    }
    o += 8 + size + (size & 1);
  }
  throw new Error('no data chunk');
}

// ---- encodeWav ----
test('stereo 24-bit WAV: header fields and sizes are consistent', () => {
  const L = new Float32Array(1000).map((_, i) => Math.sin(i / 10) * 0.5);
  const R = new Float32Array(1000).map((_, i) => Math.cos(i / 7) * 0.25);
  const wav = A.encodeWav([L, R], sr, 100, 600);
  const p = parseWav(wav);
  assert.strictEqual(p.fmt.tag, 1);
  assert.strictEqual(p.fmt.channels, 2);
  assert.strictEqual(p.fmt.sampleRate, sr);
  assert.strictEqual(p.fmt.bits, 24);
  assert.strictEqual(p.frames, 500);
  assert.strictEqual(p.riffSize, p.total - 8);
});

test('selection contents match the source samples (within 24-bit precision)', () => {
  const L = new Float32Array(2000).map((_, i) => Math.sin(i / 13) * 0.9);
  const R = new Float32Array(2000).map((_, i) => Math.sin(i / 5) * -0.7);
  const p = parseWav(A.encodeWav([L, R], sr, 250, 750));
  for (let i = 0; i < 500; i++) {
    assert.ok(Math.abs(p.ch[0][i] - L[250 + i]) < 1.5e-7, 'L mismatch at ' + i);
    assert.ok(Math.abs(p.ch[1][i] - R[250 + i]) < 1.5e-7, 'R mismatch at ' + i);
  }
});

test('24-bit source values round-trip exactly', () => {
  const ints = [-8388608, -1, 0, 1, 12345, 8388607];
  const src = new Float32Array(ints.map((v) => v / 8388608));
  const p = parseWav(A.encodeWav([src], sr, 0, src.length));
  ints.forEach((v, i) => assert.strictEqual(Math.round(p.ch[0][i] * 8388608), v));
});

test('out-of-range samples clip instead of wrapping', () => {
  const src = new Float32Array([2, -2, 1, -1]);
  const p = parseWav(A.encodeWav([src], sr, 0, 4));
  assert.ok(p.ch[0][0] > 0.999 && p.ch[0][1] < -0.999);
});

test('mono with an odd byte count gets its RIFF pad byte', () => {
  const src = new Float32Array(7).fill(0.1); // 21 data bytes
  const wav = A.encodeWav([src], sr, 0, 7);
  const p = parseWav(wav);
  assert.strictEqual(p.dataSize, 21);
  assert.strictEqual(wav.length % 2, 0);
  assert.strictEqual(p.riffSize, wav.length - 8);
});

test('6-channel audio is written as WAVE_FORMAT_EXTENSIBLE', () => {
  const chans = Array.from({ length: 6 }, (_, c) => new Float32Array(100).fill((c + 1) / 10));
  const p = parseWav(A.encodeWav(chans, sr, 0, 100));
  assert.strictEqual(p.fmt.tag, 0xfffe);
  assert.strictEqual(p.fmt.channels, 6);
  assert.strictEqual(p.frames, 100);
  assert.ok(Math.abs(p.ch[5][50] - 0.6) < 1e-6);
});

test('empty selection produces a valid, empty WAV', () => {
  const p = parseWav(A.encodeWav([new Float32Array(10)], sr, 5, 5));
  assert.strictEqual(p.frames, 0);
});

// ---- findPeaks ----
test('findPeaks puts the loudest hit first and finds the others in order', () => {
  const n = sr * 4;
  const d = new Float32Array(n);
  const hit = (at, amp) => {
    for (let i = 0; i < 400; i++) d[at + i] = amp * Math.sin(i / 3) * Math.exp(-i / 120);
  };
  hit(sr * 1, 0.4);
  hit(sr * 2 + 123, 0.95);
  hit(sr * 3, 0.6);
  const peaks = A.findPeaks([d], sr, 8, 0.3);
  assert.ok(peaks.length >= 3);
  assert.ok(Math.abs(peaks[0].sample - (sr * 2 + 123)) < 400, 'loudest hit not first');
  assert.ok(peaks[0].amp > 0.8);
  assert.ok(Math.abs(peaks[1].sample - sr * 3) < 400, 'second loudest wrong');
  assert.ok(Math.abs(peaks[2].sample - sr) < 400, 'third loudest wrong');
  // picks respect the minimum separation
  for (let i = 0; i < peaks.length; i++)
    for (let j = i + 1; j < peaks.length; j++) assert.ok(Math.abs(peaks[i].sample - peaks[j].sample) >= 0.29 * sr);
});

test('findPeaks sees the loudest channel and handles silence', () => {
  const quiet = new Float32Array(sr).fill(0);
  const loud = new Float32Array(sr).fill(0);
  loud[30000] = -0.8;
  const peaks = A.findPeaks([quiet, loud], sr, 3, 0.3);
  assert.strictEqual(peaks[0].sample, 30000);
  assert.ok(Math.abs(peaks[0].amp - 0.8) < 1e-6);
  assert.deepStrictEqual(A.findPeaks([new Float32Array(1000)], sr), []);
});

// ---- waveform columns ----
function naiveColumns(d, s0, s1, width) {
  const spp = (s1 - s0) / width;
  const min = [];
  const max = [];
  for (let x = 0; x < width; x++) {
    const i0 = Math.floor(s0 + x * spp);
    const i1 = Math.max(i0 + 1, Math.ceil(s0 + (x + 1) * spp));
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = i0; i < Math.min(i1, d.length); i++) {
      lo = Math.min(lo, d[i]);
      hi = Math.max(hi, d[i]);
    }
    min.push(lo);
    max.push(hi);
  }
  return { min, max };
}

test('columns: zoomed-in (raw samples) matches a brute-force scan', () => {
  const d = new Float32Array(20000).map((_, i) => Math.sin(i / 17) * Math.cos(i / 300));
  const pyr = A.buildPyramid([d], 256);
  const got = A.columns([d], pyr, [0], 1000, 3000, 200);
  const want = naiveColumns(d, 1000, 3000, 200);
  for (let x = 0; x < 200; x++) {
    assert.ok(Math.abs(got.min[x] - want.min[x]) < 1e-6 && Math.abs(got.max[x] - want.max[x]) < 1e-6, 'col ' + x);
  }
});

test('columns: zoomed-out (pyramid) never underestimates the true envelope', () => {
  const d = new Float32Array(sr * 5).map((_, i) => Math.sin(i / 11) * (i % 40000 < 200 ? 1 : 0.2));
  const pyr = A.buildPyramid([d], 256);
  const width = 300;
  const got = A.columns([d], pyr, [0], 0, d.length, width);
  const want = naiveColumns(d, 0, d.length, width);
  for (let x = 0; x < width; x++) {
    assert.ok(got.max[x] >= want.max[x] - 1e-6, 'max under at ' + x);
    assert.ok(got.min[x] <= want.min[x] + 1e-6, 'min over at ' + x);
  }
});

test('columns: merging channels takes the widest envelope; empty columns are flagged', () => {
  const a = new Float32Array(5000).fill(0.2);
  const b = new Float32Array(5000).fill(-0.6);
  const pyr = A.buildPyramid([a, b], 256);
  const merged = A.columns([a, b], pyr, [0, 1], 0, 5000, 10);
  assert.ok(Math.abs(merged.max[3] - 0.2) < 1e-6 && Math.abs(merged.min[3] + 0.6) < 1e-6);
  const past = A.columns([a], A.buildPyramid([a], 256), [0], 6000, 7000, 4);
  assert.ok(past.max[0] < past.min[0]);
});

// ---- WAV header sniffing ----
test('sniffWavInfo reads rate/channels/bits, and returns null for non-WAV', () => {
  const wav = A.encodeWav([new Float32Array(100), new Float32Array(100)], 44100, 0, 100);
  const info = A.sniffWavInfo(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength));
  assert.deepStrictEqual(info, { channels: 2, sampleRate: 44100, bits: 24 });
  assert.strictEqual(A.sniffWavInfo(new Uint8Array(100).buffer), null);
  assert.strictEqual(A.sniffWavInfo(new ArrayBuffer(10)), null);
});

console.log(`\n${passed} tests passed`);
