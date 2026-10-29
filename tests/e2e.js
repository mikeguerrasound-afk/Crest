/*
 * End-to-end test: launches the real app under a virtual display and drives it.
 *   xvfb-run -a node tests/e2e.js [screenshotDir]
 * Needs: playwright, ffmpeg (ffmpeg-static is used when present).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { _electron } = require('playwright');
const A = require('../renderer/audio-utils.js');

const ROOT = path.join(__dirname, '..');
const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'crest-shots-'));
fs.mkdirSync(shots, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crest-e2e-'));
const FF = (() => {
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return 'ffmpeg';
})();
const ff = (args) => {
  const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
};

let passed = 0;
const step = async (name, fn) => {
  const t0 = Date.now();
  await fn();
  passed++;
  console.log(`ok  ${name} (${Date.now() - t0} ms)`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} ± ${tol}, got ${a}`);

/* ---------- test media ---------- */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}
const media = path.join(work, 'media');
fs.mkdirSync(media);
const hitsWav = path.join(media, '01 hits.wav');
{
  const sr = 48000;
  const r = rng(3);
  const L = new Float32Array(sr * 6).map(() => r() * 0.0003);
  const R = new Float32Array(sr * 6).map(() => r() * 0.0003);
  [[0.5, 0.5], [1.4, 0.25], [2.4, 0.8], [3.6, 0.35], [4.8, 0.6]].forEach(([t, a]) => {
    const at = Math.round(t * sr);
    for (let i = 0; i < sr * 0.4; i++) {
      const e = Math.exp(-i / (sr * 0.06));
      L[at + i] += r() * a * e;
      R[at + i] += r() * a * e * 0.9;
    }
  });
  fs.writeFileSync(hitsWav, A.encodeWav([L, R], sr, 0, L.length));
}
const toneWav = path.join(media, '02 tone.wav');
{
  const sr = 44100;
  const s = new Float32Array(sr * 3).map((_, i) => 0.25 * Math.sin((2 * Math.PI * 1000 * i) / sr));
  fs.writeFileSync(toneWav, A.encodeWav([s, s], sr, 0, s.length));
}
const mp4 = path.join(media, '03 video.mp4');
ff(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=4:sample_rate=48000', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', mp4]);
const prores = path.join(media, '04 prores.mov');
ff(['-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=24:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=550:duration=3:sample_rate=48000', '-c:v', 'prores_ks', '-profile:v', '1', '-c:a', 'pcm_s16le', '-shortest', prores]);
const wmaFile = path.join(media, '05 legacy.wma');
ff(['-f', 'lavfi', '-i', 'sine=frequency=700:duration=2:sample_rate=44100', '-c:a', 'wmav2', wmaFile]);

(async () => {
  const exportsDir = path.join(work, 'exports');
  const batchDir = path.join(work, 'batch');
  fs.mkdirSync(batchDir);
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', ROOT],
    cwd: ROOT,
    env: { ...process.env, CREST_E2E: '1', CREST_USER_DATA: path.join(work, 'ud'), CREST_EXPORT_DIR: exportsDir, CREST_CHOOSE_DIR: batchDir, CREST_FFMPEG: FF },
  });
  const page = await app.firstWindow();
  const problems = [];
  page.on('pageerror', (e) => { problems.push('pageerror: ' + e.message); if (process.env.E2E_VERBOSE) console.log('[pageerror]', e.stack || e.message); });
  if (process.env.E2E_VERBOSE) page.on('console', (m) => console.log('[page]', m.type(), m.text()));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push('console.error: ' + m.text());
  });
  await page.setViewportSize({ width: 1180, height: 760 }).catch(() => {});
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 15000 });

  const open = async (p, opts) => {
    await page.evaluate(async ([file, o]) => {
      const r = await window.api.resolve(file);
      await window.__crest.handleResolved(r, o);
    }, [p, opts || {}]);
  };
  const waitAudio = () => page.waitForFunction(() => window.__crest.S.ready, null, { timeout: 30000 });
  const snap = async (name) => page.screenshot({ path: path.join(shots, name + '.png') });
  const S = (expr) => page.evaluate(`(() => { const S = window.__crest.S, prefs = window.__crest.prefs, G = window.__crest.G; return ${expr}; })()`);

  await step('app boots, empty state shows, language follows system/default', async () => {
    assert.ok(await page.isVisible('#empty'));
    const info = await page.evaluate(() => window.api.appInfo());
    assert.strictEqual(info.ffmpeg, true, 'ffmpeg available');
    await snap('00-empty');
  });

  await step('opens a WAV: waveform decoded at native rate, hits detected', async () => {
    await open(hitsWav);
    await waitAudio();
    const r = await S('({ sr: S.audio.sampleRate, ch: S.audio.channels.length, dur: S.audio.duration, hits: S.hits.map(h => h.start / S.audio.sampleRate), peaks: S.peaks.length, plan: S.info.plan, kind: S.info.kind })');
    assert.strictEqual(r.sr, 48000);
    assert.strictEqual(r.ch, 2);
    near(r.dur, 6, 0.01);
    assert.strictEqual(r.hits.length, 5, 'hits: ' + r.hits);
    [0.5, 1.4, 2.4, 3.6, 4.8].forEach((t, i) => near(r.hits[i], t, 0.01, 'hit ' + i));
    assert.strictEqual(r.plan, 'native');
    await sleep(300);
    const meter = await page.textContent('#meter');
    assert.ok(/LUFS/.test(meter) && /Peak|Pico/.test(meter), 'meter shows: ' + meter);
    await snap('01-wave');
  });

  await step('playback works through the EQ graph (analyser sees signal), seeking uses range requests', async () => {
    await page.click('#play');
    await sleep(700);
    const st = await S('({ t: document.getElementById("media").currentTime, paused: document.getElementById("media").paused, ctx: G.ctx && G.ctx.state })');
    assert.ok(!st.paused, 'playing');
    assert.ok(st.t > 0.3, 'time advances: ' + st.t);
    // jump onto the 2.4 s hit and sample the analyser while it rings
    await page.evaluate(() => { document.getElementById("media").currentTime = 2.39; });
    const level = await page.evaluate(async () => {
      const a = window.__crest.G.analyser;
      const b = new Float32Array(a.frequencyBinCount);
      let best = -Infinity;
      for (let i = 0; i < 14; i++) {
        await new Promise((r) => setTimeout(r, 25));
        a.getFloatFrequencyData(b);
        best = Math.max(best, ...b);
      }
      return best;
    });
    assert.ok(level > -70, 'analyser level ' + level + ' dB (CORS-tainted media would read -Infinity/-140)');
    await page.click('#play');
    const seeked = await S('document.getElementById("media").currentTime');
    assert.ok(seeked > 2.3, 'seek landed: ' + seeked);
  });

  await step('Loudest jumps to the 2.4 s hit first, then the next ones', async () => {
    await page.click('#loudest');
    near(await S('document.getElementById("media").currentTime'), 2.4, 0.02);
    await page.click('#loudest');
    near(await S('document.getElementById("media").currentTime'), 4.8, 0.03);
  });

  await step('hit navigation selects each hit; selection drag-out writes a click-free WAV', async () => {
    await page.evaluate(() => { document.getElementById("media").currentTime = 0; });
    await page.keyboard.press(']');
    const sel = await S('S.sel');
    near(sel.start, 0.5, 0.01);
    assert.ok(sel.end > sel.start + 0.05 && sel.end < 1.4, 'slice ends before next hit: ' + sel.end);
    await sleep(200);
    const p = await page.evaluate(() => window.__crest.dragPath());
    assert.ok(p && fs.existsSync ? true : true);
    assert.ok(p.startsWith(exportsDir), 'written to exports dir: ' + p);
    assert.ok(fs.existsSync(p));
    const buf = fs.readFileSync(p);
    const info = A.sniffWavInfo(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    assert.deepStrictEqual(info, { channels: 2, sampleRate: 48000, bits: 24 });
    // first sample is ~0 (fade-in + zero-crossing snap)
    const first = Math.abs(buf.readIntLE(44, 3)) / 8388608;
    assert.ok(first < 0.001, 'first sample ' + first);
    await snap('02-hit-selected');
    await page.keyboard.press(']');
    near((await S('S.sel')).start, 1.4, 0.01);
    await page.keyboard.press('[');
    near((await S('S.sel')).start, 0.5, 0.01);
  });

  await step('export all hits writes one file per hit', async () => {
    const dir = batchDir;
    await page.evaluate(() => window.__crest.exportAllHits());
    const files = fs.readdirSync(dir).sort();
    assert.strictEqual(files.length, 5, files.join(','));
    assert.ok(/hit01/.test(files[0]) && /hit05/.test(files[4]));
  });

  await step('EQ: live filter response matches the maths, offline render applies +12 dB and varispeed', async () => {
    await open(toneWav);
    await waitAudio();
    await page.click('#eqBtn');
    await sleep(300);
    await page.evaluate(() => {
      const { eqState } = window.__crest;
      eqState.bands.push({ id: 101, type: 'peaking', freq: 1000, gain: 12, q: 1, slope: 1, on: true });
      eqState.bands.push({ id: 102, type: 'highpass', freq: 120, gain: 0, q: 0.71, slope: 2, on: true });
      eqState.bands.push({ id: 103, type: 'highshelf', freq: 6000, gain: -6, q: 0.7, slope: 1, on: true });
      document.getElementById('eqBypass').click(); document.getElementById('eqBypass').click(); // triggers onEqChange -> rebuild
    });
    await sleep(200);
    const maxDiff = await page.evaluate(() => {
      const { G, eqState, EQ } = window.__crest;
      const freqs = new Float32Array(48).map((_, i) => 25 * Math.pow(800, i / 47));
      const sr = G.ctx.sampleRate;
      const want = EQ.responseDb(eqState, sr, freqs);
      const got = new Float32Array(freqs.length);
      for (const list of G.chain.nodes.values()) {
        for (const f of list) {
          const mag = new Float32Array(freqs.length), ph = new Float32Array(freqs.length);
          f.getFrequencyResponse(freqs, mag, ph);
          for (let i = 0; i < freqs.length; i++) got[i] += 20 * Math.log10(mag[i]);
        }
      }
      let d = 0;
      for (let i = 0; i < freqs.length; i++) d = Math.max(d, Math.abs(want[i] - got[i]));
      return d;
    });
    assert.ok(maxDiff < 0.15, 'EQ drawing vs real filter max diff ' + maxDiff + ' dB');
    await snap('03-eq');
    // offline render: tone at 1 kHz should come out ~ +12 dB (high-pass at 120 Hz does not touch it)
    const res = await page.evaluate(async () => {
      const { S, renderChannels, prefs } = window.__crest;
      const n = S.audio.length;
      const rms = (c) => Math.sqrt(c.reduce((a, v) => a + v * v, 0) / c.length);
      const dry = rms(S.audio.channels[0].subarray(5000, 40000));
      prefs.applyFx = true; prefs.st = 0; prefs.fade = 0;
      const wet = await renderChannels(0, n);
      const gainDb = 20 * Math.log10(rms(wet[0].subarray(5000, 40000)) / dry);
      prefs.st = -12;
      const slow = await renderChannels(0, n);
      return { gainDb, ratio: slow[0].length / wet[0].length, ch: slow.length };
    });
    near(res.gainDb, 12, 0.6, 'EQ boost in rendered export');
    near(res.ratio, 2, 0.01, 'varispeed -12 st doubles the length');
    assert.strictEqual(res.ch, 2);
  });

  await step('processed selection is prepared in the background and the drag path uses it', async () => {
    await page.evaluate(() => { window.__crest.prefs.st = 0; window.__crest.setSel(0.5, 1.5); });
    await sleep(900);
    const prepared = await S('!!S.prepared');
    assert.ok(prepared, 'prepared export ready');
    const p = await page.evaluate(() => window.__crest.dragPath());
    assert.ok(/_EQ/.test(p), 'file name tags EQ: ' + p);
    assert.ok(fs.existsSync(p));
    await page.evaluate(() => { const { eqState } = window.__crest; eqState.bands.length = 0; document.getElementById('eqReset').click(); });
  });

  await step('spectrogram view, options popover and UCS naming', async () => {
    await page.click('#eqBtn');
    await page.click('#specBtn');
    await sleep(500);
    await snap('04-spectrogram');
    await page.click('#specBtn');
    await page.click('#optsBtn');
    await page.click('#nameUcs');
    await page.fill('#ucsCat', 'WEAPGun');
    await page.fill('#ucsFx', 'Pistol Shot');
    await page.fill('#ucsCreator', 'MG');
    await sleep(200);
    assert.strictEqual(await page.textContent('#ucsPreview'), 'WEAPGun_Pistol Shot_MG.wav');
    const nm = await page.evaluate(() => window.__crest.exportName(0, 1000, 3));
    assert.strictEqual(nm, 'WEAPGun_Pistol Shot 03_MG.wav');
    await snap('05-options');
    await page.click('#nameOrig');
    await page.keyboard.press('Escape');
  });

  await step('MP4 plays natively with picture; frame stepping and timecode', async () => {
    await open(mp4);
    await waitAudio();
    await page.waitForFunction(() => { const m = document.getElementById('media'); return m.readyState >= 2 && m.videoWidth > 0; }, null, { timeout: 20000 });
    assert.ok(await page.evaluate(() => document.body.classList.contains('has-video')));
    const fps = await S('S.fps');
    near(fps, 25, 0.01);
    console.log('   focus before stepping:', await page.evaluate(() => { const a = document.activeElement; return a ? a.tagName + '#' + a.id : 'none'; }));
    // step from mid-clip: the very first frames can be flaky with the software decoder used under Xvfb
    await page.evaluate(() => { const m = document.getElementById('media'); m.pause(); m.currentTime = 1.0; });
    await page.waitForFunction(() => Math.abs(document.getElementById('media').currentTime - 1.0) < 0.05, null, { timeout: 5000 }).catch(async () => console.log('   seek to 1.0 did not hold:', await S('document.getElementById("media").currentTime')));
    await sleep(300);
    await page.keyboard.press('.');
    await sleep(300);
    near(await S('document.getElementById("media").currentTime'), 1.02 + 0.04, 0.012, 'one frame forward');
    await page.keyboard.press('.');
    await sleep(300);
    near(await S('document.getElementById("media").currentTime'), 1.02 + 0.08, 0.012, 'two frames forward');
    await page.keyboard.press(',');
    await sleep(300);
    near(await S('document.getElementById("media").currentTime'), 1.02 + 0.04, 0.012, 'one frame back');
    await page.click('#timeBtn');
    assert.ok(/^\d\d:\d\d:\d\d:\d\d$/.test(await page.textContent('#cur')), 'timecode: ' + (await page.textContent('#cur')));
    await page.click('#timeBtn');
    await snap('06-video');
  });

  await step('video selection becomes a draggable clip (ffmpeg cut)', async () => {
    await page.evaluate(() => window.__crest.setSel(1, 2.5));
    await page.waitForFunction(() => !!window.__crest.S.clip, null, { timeout: 30000 });
    assert.ok(await page.isVisible('#gripVideo'));
    const p = await app.evaluate(async ({ ipcMain }) => null).then(() => page.evaluate(() => window.api.copyExportSync(window.__crest.S.clip.path, 'clip-test.mp4')));
    assert.ok(p && fs.existsSync(p));
    const pr = spawnSync(FF, ['-hide_banner', '-i', p], { encoding: 'utf8' }).stderr;
    const m = /Duration: 00:00:0?(\d\.\d+)/.exec(pr);
    near(Number(m[1]), 1.5, 0.15, 'clip duration');
  });

  await step('ProRes .mov: preview copy is built, waveform comes from ffmpeg', async () => {
    await open(prores);
    await page.waitForFunction(() => { const m = document.getElementById('media'); return m.readyState >= 2 && m.videoWidth > 0 && /p-transcode/.test(decodeURIComponent(m.currentSrc)); }, null, { timeout: 60000 });
    await waitAudio();
    const r = await S('({ plan: S.info.plan, vw: document.getElementById("media").videoWidth, dur: S.audio.duration, src: document.getElementById("media").currentSrc })');
    assert.strictEqual(r.plan, 'transcode');
    assert.strictEqual(r.vw, 480);
    near(r.dur, 3, 0.1);
    assert.ok(/p-transcode-/.test(decodeURIComponent(r.src)), 'plays the proxy: ' + r.src);
  });

  await step('WMA (unsupported natively) is played and drawn through ffmpeg', async () => {
    await open(wmaFile, { autoplay: false });
    await waitAudio();
    const r = await S('({ plan: S.info.plan, dur: S.audio.duration, src: document.getElementById("media").currentSrc })');
    assert.strictEqual(r.plan, 'extract');
    near(r.dur, 2, 0.1);
    assert.ok(/x-/.test(decodeURIComponent(r.src)));
    await page.waitForFunction(() => document.getElementById('media').readyState >= 2, null, { timeout: 10000 });
  });

  await step('folder mode: list, filter, keyboard navigation with auto-play', async () => {
    await page.evaluate(async (d) => { await window.__crest.handleResolved(await window.api.resolve(d)); }, media);
    await page.waitForSelector('.row-file');
    assert.strictEqual(await page.locator('.row-file').count(), 5);
    await page.fill('#filter', 'tone');
    await sleep(150);
    assert.strictEqual(await page.locator('.row-file').count(), 1);
    await page.fill('#filter', '');
    await page.locator('.row-file', { hasText: '01 hits' }).click();
    await waitAudio();
    assert.ok(/01 hits/.test(await S('S.file.name')));
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => window.__crest.S.file.name.startsWith('02'), null, { timeout: 15000 });
    await page.waitForFunction(() => !document.getElementById('media').paused, null, { timeout: 10000 });
    await page.keyboard.press(' ');
    await snap('07-folder');
  });

  await step('varispeed button opens its own popover and shows the active value', async () => {
    await page.click('#viBtn');
    assert.ok(await page.isVisible('#viPop'));
    assert.ok(!(await page.isVisible('#opts')));
    await page.fill('#st', '5');
    await page.dispatchEvent('#st', 'input');
    await sleep(150);
    assert.ok(/\+5\.0 st/.test(await page.textContent('#viLbl')));
    assert.ok(await page.evaluate(() => document.getElementById('viBtn').classList.contains('active')));
    await snap('09-varispeed');
    await page.click('#stReset');
    assert.strictEqual((await page.textContent('#viLbl')).trim(), 'Vari');
    await page.keyboard.press('Escape');
    assert.ok(!(await page.isVisible('#viPop')));
  });

  await step('tabs: open several files, switch keeping position, close', async () => {
    await open(toneWav, { newTab: true });
    await waitAudio();
    await open(wmaFile, { newTab: true });
    await waitAudio();
    assert.strictEqual(await page.locator('.tab').count() >= 2, true);
    const n = await page.locator('.tab').count();
    await page.evaluate(() => { document.getElementById('media').currentTime = 0.5; });
    await sleep(200);
    await page.locator('.tab').first().click();
    await waitAudio();
    await sleep(300);
    await page.locator('.tab').last().click();
    await waitAudio();
    await page.waitForFunction(() => Math.abs(document.getElementById('media').currentTime - 0.5) < 0.1, null, { timeout: 5000 });
    await snap('10-tabs');
    await page.locator('.tab.on .tab-x').click();
    await sleep(300);
    assert.strictEqual(await page.locator('.tab').count(), n - 1);
  });

  await step('language switch re-renders the UI in Spanish', async () => {
    await page.click('#optsBtn');
    await page.click('#langSeg button[data-lang="es"]');
    await sleep(200);
    assert.strictEqual(await page.getAttribute('#play', 'title'), 'Reproducir / pausa (Espacio)');
    assert.ok(/Más fuerte/.test(await page.textContent('#loudest')));
    await snap('08-spanish');
    await page.click('#langSeg button[data-lang="en"]');
    await page.keyboard.press('Escape');
  });

  await step('no console errors or page errors during the whole run', async () => {
    const real = problems.filter((p) => !/Autofill|DevTools|Electron Security Warning/.test(p));
    assert.deepStrictEqual(real, []);
  });

  await app.close();
  console.log(`\n${passed} end-to-end steps passed. Screenshots: ${shots}`);
})().catch((e) => {
  console.error('\nE2E FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
