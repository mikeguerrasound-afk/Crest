// Tests for hits, click-free cutting, loudness, spectrogram, biquad maths, naming and ffmpeg probing.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const A = require('../renderer/audio-utils.js');
const M = require('../lib/media.js');

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log('ok  ' + name);
};
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} ± ${tol}, got ${a}`);

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}
const sine = (sr, secs, hz, amp) => new Float32Array(Math.round(sr * secs)).map((_, i) => amp * Math.sin((2 * Math.PI * hz * i) / sr));
const dbToLin = (db) => Math.pow(10, db / 20);

/* ---------------- hits ---------------- */

test('detectHits finds each impact, its start and a sensible end', () => {
  const sr = 48000;
  const rand = rng(7);
  const d = new Float32Array(sr * 6).map(() => rand() * dbToLin(-72)); // noise floor
  const truth = [
    [0.5, -6], [1.2, -14], [2.0, -9], [2.25, -12], [3.5, -3], [4.4, -20],
  ];
  for (const [t, db] of truth) {
    const at = Math.round(t * sr);
    for (let i = 0; i < sr * 0.4 && at + i < d.length; i++) d[at + i] += rand() * dbToLin(db) * Math.exp(-i / (sr * 0.05));
  }
  const hits = A.detectHits([d], sr);
  assert.strictEqual(hits.length, truth.length, 'hit count: ' + hits.map((h) => (h.start / sr).toFixed(3)).join(','));
  hits.forEach((h, i) => {
    near(h.start / sr, truth[i][0], 0.008, 'start ' + i);
    assert.ok(h.end > h.start + 0.02 * sr, 'end after start');
    if (i < hits.length - 1) assert.ok(h.end <= hits[i + 1].start, 'slices must not overlap');
    assert.ok(h.peak >= h.start && h.peak <= h.end, 'peak inside slice');
  });
  assert.ok(hits[0].end / sr < 1.2, 'first slice ends before the next hit');
  // the loudest hit has the biggest amp
  const loud = hits.reduce((a, b) => (b.amp > a.amp ? b : a));
  near(loud.start / sr, 3.5, 0.01);
});

test('detectHits: sensitivity, silence and stereo', () => {
  const sr = 44100;
  assert.deepStrictEqual(A.detectHits([new Float32Array(sr)], sr), []);
  const L = new Float32Array(sr * 2);
  const R = new Float32Array(sr * 2);
  for (let i = 0; i < 4000; i++) R[sr + i] = 0.5 * Math.sin(i / 3) * Math.exp(-i / 800); // only in the right channel
  const hits = A.detectHits([L, R], sr);
  assert.strictEqual(hits.length, 1);
  near(hits[0].start / sr, 1.0, 0.01);
});

/* ---------------- click-free ---------------- */

test('snapZero lands on a zero crossing near the request', () => {
  const sr = 48000;
  const d = sine(sr, 1, 200, 0.8);
  const idx = 12345;
  const z = A.snapZero([d], idx, sr, 3);
  assert.ok(Math.abs(z - idx) <= 0.003 * sr);
  assert.ok(Math.abs(d[z]) < 0.8 * Math.sin((2 * Math.PI * 200) / sr) * 1.01, 'sample at snap is ~0: ' + d[z]);
  assert.strictEqual(A.snapZero([new Float32Array(100).fill(0.3)], 50, sr, 3), 50, 'no crossing: unchanged');
});

test('applyFade shapes the ends and leaves the middle alone', () => {
  const sr = 48000;
  const d = new Float32Array(2000).fill(1);
  A.applyFade([d], sr, 5, 5);
  assert.strictEqual(d[0], 0);
  assert.ok(d[1999] < 1e-6);
  assert.strictEqual(d[1000], 1);
  assert.ok(d[100] > 0 && d[100] < 1);
  // fades never overlap on very short audio
  const tiny = new Float32Array(10).fill(1);
  A.applyFade([tiny], sr, 50, 50);
  assert.ok(tiny.every((v) => v >= 0 && v <= 1));
});

/* ---------------- loudness ---------------- */

test('loudness: 997 Hz stereo sine reads its level in LUFS (BS.1770)', () => {
  for (const sr of [48000, 44100, 96000]) {
    const s = sine(sr, 6, 997, dbToLin(-23));
    const r = A.loudness([s, s], sr, 0, s.length);
    near(r.lufs, -23.0, 0.15, 'LUFS @' + sr);
    near(r.peakDb, -23, 0.05, 'peak');
    near(r.rmsDb, -26.01, 0.05, 'rms');
  }
});

test('loudness: one channel is 3 LU quieter; silence is gated out; short regions still measure', () => {
  const sr = 48000;
  const s = sine(sr, 5, 997, dbToLin(-23));
  near(A.loudness([s], sr, 0, s.length).lufs, -26.0, 0.15);
  const both = new Float32Array(sr * 10);
  both.set(s, 0); // 5 s tone + 5 s silence
  near(A.loudness([both, both], sr, 0, both.length).lufs, -23.0, 0.2, 'gated');
  const short = A.loudness([s, s], sr, 1000, 1000 + 4800); // 100 ms
  near(short.lufs, -23.0, 0.6, 'short region');
  assert.strictEqual(A.loudness([new Float32Array(sr)], sr, 0, sr).lufs, -Infinity);
});

test('loudness: 5.1 ignores LFE and boosts surrounds', () => {
  const sr = 48000;
  const t = sine(sr, 4, 997, 0.1);
  const z = new Float32Array(t.length);
  const lfeOnly = A.loudness([z, z, z, t, z, z], sr, 0, t.length);
  assert.strictEqual(lfeOnly.lufs, -Infinity);
  const front = A.loudness([t, z, z, z, z, z], sr, 0, t.length).lufs;
  const surround = A.loudness([z, z, z, z, t, z], sr, 0, t.length).lufs;
  near(surround - front, 1.49, 0.05); // 10*log10(1.41)
});

/* ---------------- FFT / spectrogram ---------------- */

test('fft: a bin-centred sine peaks in the right bin with the right size', () => {
  const N = 1024;
  const re = new Float64Array(N).map((_, i) => Math.cos((2 * Math.PI * 64 * i) / N));
  const im = new Float64Array(N);
  A.fft(re, im);
  near(Math.hypot(re[64], im[64]), N / 2, 1e-6);
  near(Math.hypot(re[10], im[10]), 0, 1e-6);
});

test('spectrogram: a 1 kHz tone lights up the 1 kHz row at about its level', () => {
  const sr = 48000;
  const s = sine(sr, 1, 1000, 0.5);
  const cols = 20;
  const rows = 200;
  const img = A.spectrogram([s], sr, 0, s.length, cols, rows, { fftSize: 2048, minHz: 30, maxHz: 20000, minDb: -100, maxDb: 0 });
  const col = 10;
  let best = 0;
  for (let r = 0; r < rows; r++) if (img[r * cols + col] > img[best * cols + col]) best = r;
  const hz = 20000 * Math.pow(30 / 20000, (best + 0.5) / rows);
  near(hz, 1000, 90, 'peak row frequency');
  near((img[best * cols + col] / 255) * 100 - 100, -6, 3, 'peak level dB');
  assert.ok(img[0 * cols + col] < 40, 'top row is quiet');
});

/* ---------------- biquad maths ---------------- */

test('biquad: peaking, shelf, low/high-pass and notch behave', () => {
  const fs = 48000;
  const at = (c, f) => A.biquadResponseDb(c, fs, [f])[0];
  near(at(A.biquadCoeffs('peaking', fs, 1000, 6, 1), 1000), 6, 0.01);
  near(at(A.biquadCoeffs('peaking', fs, 1000, -9, 4), 1000), -9, 0.01);
  near(at(A.biquadCoeffs('peaking', fs, 1000, 6, 1), 30), 0, 0.2);
  near(at(A.biquadCoeffs('lowshelf', fs, 200, 8, 0.7), 20), 8, 0.2);
  near(at(A.biquadCoeffs('highshelf', fs, 5000, -8, 0.7), 18000), -8, 0.3);
  near(at(A.biquadCoeffs('lowpass', fs, 1000, 0, Math.SQRT1_2), 1000), -3.01, 0.02);
  near(at(A.biquadCoeffs('highpass', fs, 1000, 0, Math.SQRT1_2), 1000), -3.01, 0.02);
  assert.ok(at(A.biquadCoeffs('highpass', fs, 1000, 0, 0.7), 50) < -35);
  assert.ok(at(A.biquadCoeffs('notch', fs, 1000, 0, 8), 1000) < -60);
});

/* ---------------- naming / formatting ---------------- */

test('ucsName follows CatID_FXName_CreatorID_SourceID and cleans illegal characters', () => {
  assert.strictEqual(A.ucsName({ catId: 'WEAPGun', fxName: 'Pistol Shot', creatorId: 'MG', sourceId: 'GAME01' }), 'WEAPGun_Pistol Shot_MG_GAME01');
  assert.strictEqual(A.ucsName({ catId: 'DOOR Wood', fxName: 'a/b_c:d', creatorId: 'MG', sourceId: '' }, 3), 'DOORWood_a b c d 03_MG');
  assert.strictEqual(A.ucsName({ catId: '', fxName: '', creatorId: '', sourceId: '' }), 'MISC_Untitled');
});

test('time formatting', () => {
  assert.strictEqual(A.fmtTime(83.4567), '1:23.457');
  assert.strictEqual(A.fmtTime(3725.5, 0), '1:02:05');
  assert.strictEqual(A.fmtTimecode(3725.5, 25), '01:02:05:12');
  assert.strictEqual(A.fmtTimecode(0.5, 29.97), '00:00:00:14');
  assert.strictEqual(A.fmtTimecode(2, 25), '00:00:02:00', 'exact frame boundaries do not slip back');
  assert.strictEqual(A.stamp(83.45), '1m23s450');
  near(A.semitoneRate(12), 2, 1e-9);
  near(A.semitoneRate(-24), 0.25, 1e-9);
});

/* ---------------- ffmpeg probing, with real files ---------------- */

const FF = (() => {
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return 'ffmpeg';
})();
const ffAvailable = spawnSync(FF, ['-version']).status === 0;

if (!ffAvailable) {
  console.log('skip ffmpeg tests (no ffmpeg)');
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crest-test-'));
  const run = (args) => {
    const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, 'ffmpeg failed: ' + r.stderr);
  };
  const probe = (f) => M.parseProbe(spawnSync(FF, ['-hide_banner', '-i', f], { encoding: 'utf8' }).stderr);
  const src = ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=44100'];

  test('probe + plan: H.264/AAC mp4 plays natively', () => {
    const f = path.join(dir, 'a.mp4');
    run([...src, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]);
    const p = probe(f);
    assert.strictEqual(p.video.codec, 'h264');
    assert.strictEqual(p.video.width, 320);
    assert.strictEqual(p.video.height, 180);
    near(p.video.fps, 25, 0.01);
    assert.strictEqual(p.audio.codec, 'aac');
    assert.strictEqual(p.audio.sampleRate, 44100);
    assert.strictEqual(p.audio.channels, 1, 'the lavfi sine source is mono');
    near(p.duration, 2, 0.1);
    const st = path.join(dir, 'a-stereo.mp4');
    run([...src, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-af', 'pan=stereo|c0=c0|c1=c0', '-c:a', 'aac', '-shortest', st]);
    assert.strictEqual(probe(st).audio.channels, 2);
    assert.strictEqual(M.playPlan(p, 'mp4'), 'native');
  });

  test('probe + plan: ProRes .mov and mpeg4 .avi need a preview copy', () => {
    const f1 = path.join(dir, 'b.mov');
    run([...src, '-c:v', 'prores_ks', '-profile:v', '1', '-c:a', 'pcm_s16le', '-shortest', f1]);
    const p1 = probe(f1);
    assert.strictEqual(p1.video.codec, 'prores');
    assert.strictEqual(M.playPlan(p1, 'mov'), 'transcode');
    const f2 = path.join(dir, 'c.avi');
    run([...src, '-c:v', 'mpeg4', '-c:a', 'mp3', '-shortest', f2]);
    assert.strictEqual(M.playPlan(probe(f2), 'avi'), 'transcode');
  });

  test('plan: H.264 with unsupported audio only re-encodes the audio', () => {
    const f = path.join(dir, 'd.mkv');
    run([...src, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-shortest', f]);
    const p = probe(f);
    assert.strictEqual(p.audio.codec, 'ac3');
    assert.strictEqual(M.playPlan(p, 'mkv'), 'audio-fix');
  });

  test('probe + plan: audio-only files, 5.1 layouts, cover art ignored', () => {
    const w = path.join(dir, 'e.wav');
    run(['-f', 'lavfi', '-i', 'sine=frequency=300:duration=1:sample_rate=96000', '-c:a', 'pcm_s24le', w]);
    const pw = probe(w);
    assert.strictEqual(pw.video, null);
    assert.strictEqual(pw.audio.sampleRate, 96000);
    assert.strictEqual(pw.audio.channels, 1);
    assert.strictEqual(M.playPlan(pw, 'wav'), 'native');
    const wma = path.join(dir, 'f.wma');
    run(['-f', 'lavfi', '-i', 'sine=frequency=300:duration=1', '-c:a', 'wmav2', wma]);
    assert.strictEqual(M.playPlan(probe(wma), 'wma'), 'extract');
    const six = path.join(dir, 'g.wav');
    run(['-f', 'lavfi', '-i', 'anoisesrc=d=1:c=pink:sample_rate=48000', '-af', 'pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0', six]);
    assert.strictEqual(probe(six).audio.channels, 6);
  });

  test('extract/clip/proxy ffmpeg commands really run', () => {
    const mp4 = path.join(dir, 'a.mp4');
    const mov = path.join(dir, 'b.mov');
    const wavOut = path.join(dir, 'x.wav');
    run(M.extractArgs(mov, wavOut).slice(M.extractArgs(mov, wavOut).indexOf('-i')));
    const pw = probe(wavOut);
    assert.strictEqual(pw.audio.codec, 'pcm_s24le');
    const clip = path.join(dir, 'clip.mp4');
    run(M.clipArgs(mp4, clip, 0.5, 1.5).slice(M.clipArgs(mp4, clip, 0.5, 1.5).indexOf('-ss')));
    near(probe(clip).duration, 1.0, 0.12, 'clip length');
    const prox = path.join(dir, 'proxy.mp4');
    const a = M.proxyArgs(mov, prox, 'transcode');
    run(a.slice(a.indexOf('-i')));
    const pp = probe(prox);
    assert.strictEqual(M.playPlan(pp, 'mp4'), 'native');
    near(pp.video.fps, 25, 0.01);
    assert.strictEqual(M.parseProgressChunk('frame=3\nout_time=00:00:01.500000\nprogress=continue\n'), 1.5);
  });
}

console.log(`\n${passed} feature tests passed`);
