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
const M = require('../lib/media.js');

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
const surround = path.join(media, '06 surround.wav');
ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=48000', '-af', 'pan=5.1|FL=c0|FR=0.5*c0|FC=0.25*c0|LFE=0.1*c0|BL=0.5*c0|BR=0.5*c0', '-c:a', 'pcm_s24le', surround]);
const clipped = path.join(work, 'clipped.wav');
ff(['-f', 'lavfi', '-i', 'sine=frequency=300:duration=1:sample_rate=48000', '-af', 'volume=24dB', '-c:a', 'pcm_s16le', clipped]);
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
  const saveDir = path.join(work, 'save');
  fs.mkdirSync(saveDir);
  const reaperDir = path.join(work, 'reaper');
  fs.mkdirSync(reaperDir);
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', ROOT],
    cwd: ROOT,
    env: { ...process.env, CREST_E2E: '1', CREST_USER_DATA: path.join(work, 'ud'), CREST_EXPORT_DIR: exportsDir, CREST_CHOOSE_DIR: batchDir, CREST_SAVE_DIR: saveDir, CREST_PICK_VIDEO: mp4, CREST_REAPER_DIR: reaperDir, CREST_FFMPEG: FF },
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
    const r = await S('({ sr: S.audio.sampleRate, ch: S.audio.channels.length, dur: S.audio.duration, hits: S.hits.map(h => h.start / S.audio.sampleRate), plan: S.info.plan, kind: S.info.kind })');
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
    assert.strictEqual(await page.locator('.row-file').count(), 6);
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

  await step('multichannel: 5.1 lanes, per-channel mute / solo, applied to export', async () => {
    await open(surround, { newTab: true });
    await waitAudio();
    assert.strictEqual(await S('S.audio.channels.length'), 6);
    assert.strictEqual(await page.locator('#chStrip .ch').count(), 6);
    assert.deepStrictEqual(await page.locator('#chStrip .ch').allTextContents(), ['L', 'R', 'C', 'LFE', 'Ls', 'Rs']);
    await page.click('#play');
    await sleep(300);
    assert.strictEqual(await page.evaluate(() => window.__crest.G.stage.gains.length), 6);
    await page.click('#chStrip .ch:nth-child(2)');
    await sleep(250);
    assert.ok(await page.evaluate(() => window.__crest.G.stage.gains[1].gain.value < 0.01));
    assert.ok(await page.evaluate(() => window.__crest.G.stage.gains[0].gain.value > 0.99));
    await page.click('#chStrip .ch:nth-child(3)', { modifiers: ['Shift'] });
    await sleep(250);
    assert.deepStrictEqual(await S('S.mute.map(Boolean)'), [true, true, false, true, true, true]);
    await snap('11-multichannel');
    await page.click('#play');
    const r = await page.evaluate(async () => {
      const c = window.__crest;
      const ch = await c.renderChannels(1000, 5000);
      const peak = (a) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      return ch.map(peak);
    });
    assert.ok(r[2] > 0.01 && r[0] === 0 && r[1] === 0 && r[3] === 0 && r[5] === 0, 'only the soloed centre survives export: ' + r);
    await page.click('#chStrip .ch:nth-child(3)', { modifiers: ['Shift'] });
    assert.deepStrictEqual(await S('S.mute.filter(Boolean).length'), 0);
    await page.keyboard.press('Digit4');
    assert.strictEqual(await S('!!S.mute[3]'), true);
    await page.keyboard.press('Digit4');
  });

  await step('export button: formats WAV/AIFF/FLAC/MP3/OGG/AAC really encode; no selection exports the whole file', async () => {
    await open(hitsWav);
    await waitAudio();
    await page.click('#exportBtn');
    assert.ok(await page.isVisible('#exPop'));
    assert.ok(/whole file/.test(await page.textContent('#exScope')));
    const opts = await page.locator('#exFmt option').allTextContents();
    assert.ok(opts.includes('FLAC') && opts.some((o) => /MP3/.test(o)));
    await page.selectOption('#exFmt', 'flac');
    await snap('12-export');
    await page.keyboard.press('Escape');
    assert.ok(!(await page.isVisible('#exPop')));
    const outDir = path.join(work, 'fmt');
    fs.mkdirSync(outDir, { recursive: true });
    await page.evaluate(async () => { await window.api.chooseExportDir(); });
    const res = {};
    for (const fmt of ['wav24', 'wav16', 'aiff', 'flac', 'mp3_320', 'mp3_v0', 'ogg', 'm4a']) {
      res[fmt] = await page.evaluate(async ([f, dir]) => {
        const c = window.__crest;
        const chans = await c.renderChannels(0, c.S.audio.length, true);
        const bytes = window.A_encode(chans, c.S.audio.sampleRate);
        return window.api.exportAs('fmt-' + f + '.wav', bytes, f, chans.length, dir);
      }, [fmt, batchDir]);
    }
    const probe = (f) => spawnSync(FF, ['-hide_banner', '-i', f], { encoding: 'utf8' }).stderr;
    const expect = { wav24: ['pcm_s24le'], wav16: ['pcm_s16le'], aiff: ['pcm_s24be'], flac: ['flac'], mp3_320: ['mp3'], mp3_v0: ['mp3'], ogg: ['vorbis'], m4a: ['aac'] };
    for (const [fmt, codecs] of Object.entries(expect)) {
      assert.ok(res[fmt] && fs.existsSync(res[fmt]), fmt + ' file missing');
      const info = probe(res[fmt]);
      assert.ok(codecs.some((c) => info.includes(c)), fmt + ': ' + info.split('\n').filter((l) => /Audio:|Duration/.test(l)).join(' | '));
      const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(info);
      near(+m[1] * 3600 + +m[2] * 60 + +m[3], 6, 0.15, fmt + ' duration');
    }
    assert.ok(/\.flac$/.test(res.flac) && /\.mp3$/.test(res.mp3_v0) && /\.m4a$/.test(res.m4a));
  });

  const toolOpen = async (name) => {
    await page.click('#toolsBtn');
    await page.click(`#toolsPop [data-tool="${name}"]`);
  };
  const reopenFolder = () => page.evaluate(async (d) => { await window.__crest.handleResolved(await window.api.resolve(d)); }, media);
  const probeOut = (f) => spawnSync(FF, ['-hide_banner', '-i', f], { encoding: 'utf8' }).stderr;

  await step('tools menu lists the six tools', async () => {
    await page.click('#toolsBtn');
    assert.ok(await page.isVisible('#toolsPop'));
    assert.strictEqual(await page.locator('#toolsPop [data-tool]').count(), 6);
    await page.keyboard.press('Escape');
    assert.ok(!(await page.isVisible('#toolsPop')));
  });

  await step('quality check: clipping, true peak, goniometer, marks on the waveform', async () => {
    await open(clipped);
    await waitAudio();
    await toolOpen('qc');
    assert.ok(await page.isVisible('#qcPop'));
    await page.waitForFunction(() => /region/.test(document.getElementById('qcStats').textContent), null, { timeout: 8000 });
    const txt = await page.textContent('#qcStats');
    assert.ok(/Clipping/.test(txt) && /True peak/.test(txt) && /dBTP/.test(txt) && /correlation/i.test(txt), txt);
    await page.check('#qcMarks');
    await sleep(250);
    await snap('13-qc');
    await page.keyboard.press('Escape');
    await open(toneWav);
    await waitAudio();
    await toolOpen('qc');
    await page.waitForFunction(() => /none/.test(document.getElementById('qcStats').textContent), null, { timeout: 8000 });
    await page.keyboard.press('Escape');
  });

  await step('loop maker: best end, seam, preview, WAV export with smpl loop points', async () => {
    await open(toneWav);
    await waitAudio();
    await page.evaluate(() => window.__crest.setSel(0.3, 1.3));
    await toolOpen('loop');
    assert.ok(await page.isVisible('#loopPop'));
    await page.click('#loopBest');
    await page.waitForFunction(() => /match/.test(document.getElementById('loopScore').textContent), null, { timeout: 5000 });
    const sel = await S('({ a: S.sel.start, b: S.sel.end })');
    assert.ok(sel.b > 1.0 && sel.b <= 1.3 + 1e-6, 'end ' + sel.b);
    assert.ok(parseInt(await page.textContent('#loopScore').then((s) => /(\d+)%/.exec(s)[1]), 10) >= 98);
    await page.fill('#loopX', '50');
    await page.dispatchEvent('#loopX', 'input');
    await sleep(300);
    await snap('14-loop');
    await page.click('#loopPlay');
    await sleep(250);
    assert.ok(/Stop/.test(await page.textContent('#loopPlay')));
    await page.click('#loopPlay');
    assert.ok(/Preview/.test(await page.textContent('#loopPlay')));
    await page.evaluate(() => { window.__crest.prefs.exFmt = 'wav24'; });
    await page.click('#loopExport');
    let out = null;
    for (let i = 0; i < 80 && !out; i++) {
      out = fs.readdirSync(saveDir).find((f) => /_loop.*\.wav$/.test(f));
      if (!out) await sleep(100);
    }
    assert.ok(out, 'loop file written');
    const buf = fs.readFileSync(path.join(saveDir, out));
    const smpl = A.readSmplLoop(buf);
    const dataBytes = buf.readUInt32LE(40);
    const frames = dataBytes / 6;
    assert.deepStrictEqual(smpl, { start: 0, end: frames - 1 });
    const sr = 44100;
    near(frames, (sel.b - sel.a) * sr - 0.05 * sr, 80, 'loop length = region - crossfade');
    await page.keyboard.press('Escape');
  });

  await step('batch: whole folder to FLAC with peak normalisation', async () => {
    await reopenFolder();
    await page.waitForSelector('.row-file');
    await toolOpen('batch');
    assert.ok(await page.isVisible('#batchCard'));
    await page.selectOption('#bNorm', 'peak');
    await page.fill('#bTarget', '-3');
    await page.selectOption('#bFmt', 'flac');
    await page.fill('#bSuffix', '_proc');
    await snap('15-batch');
    await page.click('#bRun');
    await page.waitForFunction(() => /Done:/.test(document.getElementById('bStatus').textContent), null, { timeout: 150000 });
    const msg = await page.textContent('#bStatus');
    assert.ok(/Done: 6 files written\./.test(msg), msg);
    const outs = fs.readdirSync(batchDir).filter((f) => /_proc\.flac$/.test(f));
    assert.strictEqual(outs.length, 6, outs.join(','));
    const vd = spawnSync(FF, ['-hide_banner', '-i', path.join(batchDir, '01 hits_proc.flac'), '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    near(parseFloat(/max_volume: (-?[\d.]+) dB/.exec(vd)[1]), -3, 0.35, 'normalised peak');
    await page.keyboard.press('Escape');
    assert.ok(!(await page.isVisible('#modal')));
  });

  await step('metadata: write tags into the file, reload, search the folder by tag', async () => {
    page.on('dialog', (d) => d.accept());
    await open(toneWav);
    await waitAudio();
    await page.keyboard.press('i');
    await page.waitForSelector('#metaCard', { state: 'visible' });
    await page.fill('#mTitle', 'Door Slam');
    await page.fill('#mComment', 'Heavy wood door');
    await page.fill('#mKeywords', 'door, wood');
    await page.fill('#mGenre', 'DOORWood');
    await page.fill('#mArtist', 'MG');
    await page.fill('#mAlbum', 'GAME01');
    await page.click('#mSave');
    await page.waitForFunction(() => /saved/i.test(document.getElementById('metaNote').textContent), null, { timeout: 20000 });
    const tags = M.parseTags(probeOut(toneWav));
    assert.strictEqual(tags.title, 'Door Slam');
    assert.strictEqual(tags.keywords, 'door, wood');
    assert.strictEqual(tags.album, 'GAME01');
    await waitAudio();
    await page.click('#mFromName');
    assert.ok(/UCS/.test(await page.textContent('#metaNote')));
    await page.click('#mClose');
    assert.ok(!(await page.isVisible('#modal')));
    await reopenFolder();
    await page.waitForSelector('.row-file');
    await page.fill('#filter', 'heavy wood');
    await page.waitForFunction(() => document.querySelectorAll('.row-file').length === 1, null, { timeout: 15000 });
    assert.ok(/02 tone/.test(await page.textContent('.row-file')));
    await page.fill('#filter', '');
  });

  await step('level match and A/B toggle between tabs keep position', async () => {
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.evaluate(() => { const c = window.__crest; for (const tb of c.tabs().slice()) c.closeTab(tb.id); });
    await sleep(300);
    await open(toneWav, { newTab: true });
    await waitAudio();
    await open(hitsWav, { newTab: true });
    await waitAudio();
    assert.ok(await page.isVisible('#abBtn'));
    await page.keyboard.press('m');
    await sleep(200);
    const r = await page.evaluate(() => {
      const c = window.__crest;
      const ref = c.tabs()[0].lufs;
      const m = c.S.meterAll;
      return { ref, lufs: m.lufs, peak: m.peakDb, matchDb: c.S.matchDb };
    });
    console.log('   match debug', JSON.stringify(r), await S('S.file.name'));
    const want = Math.min(r.ref - r.lufs, -r.peak);
    near(r.matchDb, Math.max(-24, Math.min(12, want)), 0.06, 'match gain');
    assert.ok(Math.abs(r.matchDb) > 0.5, 'tracks differ in loudness');
    assert.ok(/dB match/.test(await page.textContent('#fx')));
    await page.evaluate(() => { document.getElementById('media').currentTime = 1.5; });
    await sleep(200);
    await page.keyboard.press('\\');
    await page.waitForFunction(() => window.__crest.S.file.name.startsWith('02'), null, { timeout: 15000 });
    await waitAudio();
    await page.waitForFunction(() => Math.abs(document.getElementById('media').currentTime - 1.5) < 0.1, null, { timeout: 8000 });
    near(await S('S.matchDb'), 0, 0.01, 'reference tab is not changed');
    await page.keyboard.press('m');
    assert.strictEqual(await page.getAttribute('#matchBtn', 'aria-pressed'), 'false');
  });

  await step('picture audition: muted video follows the sound, offset, export with this sound', async () => {
    await open(toneWav);
    await waitAudio();
    await toolOpen('pic');
    assert.ok(await page.isVisible('#picPop'));
    await page.click('#picChoose');
    await page.waitForFunction(() => document.body.classList.contains('has-pic'), null, { timeout: 20000 });
    console.log('   pic debug', JSON.stringify(await page.evaluate(() => { const v = document.getElementById('picVideo'); const o = document.getElementById('picOff'); return { dur: v.duration, rs: v.readyState, err: v.error && v.error.message, src: v.currentSrc, max: o.max, val: o.value, dis: o.disabled }; })));
    await page.fill('#picOff', '1');
    await page.dispatchEvent('#picOff', 'input');
    await page.evaluate(() => { document.getElementById('media').currentTime = 0.5; });
    await page.waitForFunction(() => {
      const v = document.getElementById('picVideo');
      return Math.abs(v.currentTime - 1.5) < 0.15;
    }, null, { timeout: 8000 });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Space');
    await page.waitForFunction(() => !document.getElementById('media').paused, null, { timeout: 5000 });
    await sleep(900);
    const d = await page.evaluate(() => {
      const v = document.getElementById('picVideo');
      const m = document.getElementById('media');
      return { v: v.currentTime, m: m.currentTime, muted: v.muted, playing: !v.paused };
    });
    assert.ok(d.muted && d.playing, JSON.stringify(d));
    near(d.v - d.m, 1, 0.3, 'picture is 1 s ahead of the sound clock');
    await snap('16-picture');
    await page.keyboard.press('Space');
    await toolOpen('pic');
    await page.click('#picExport');
    let out = null;
    for (let i = 0; i < 150 && !out; i++) {
      out = fs.readdirSync(saveDir).find((f) => /_picture\.mp4$/.test(f));
      if (!out) await sleep(200);
    }
    assert.ok(out, 'picture export written');
    await sleep(500);
    const info = M.parseProbe(probeOut(path.join(saveDir, out)));
    assert.ok(info.video && info.audio, 'mux has picture and sound');
    near(info.duration, 3, 0.25, 'duration = sound length');
    await page.click('#picClear');
    assert.ok(!(await page.evaluate(() => document.body.classList.contains('has-pic'))));
    await page.keyboard.press('Escape');
  });

  await step('REAPER link: receiver script installed, file queued in the inbox', async () => {
    await open(toneWav);
    await waitAudio();
    await toolOpen('reaper');
    const inbox = path.join(reaperDir, 'crest_inbox.txt');
    for (let i = 0; i < 80 && !fs.existsSync(inbox); i++) await sleep(100);
    assert.ok(fs.existsSync(inbox), 'inbox written');
    const queued = fs.readFileSync(inbox, 'utf8').trim().split(/\r?\n/).pop();
    assert.ok(/\.wav$/.test(queued) && fs.existsSync(queued), queued);
    const lua = fs.readFileSync(path.join(reaperDir, 'Scripts', 'Crest_receiver.lua'), 'utf8');
    assert.ok(/InsertMedia/.test(lua) && /crest_inbox\.txt/.test(lua));
  });

  await step('language switch re-renders the UI in Spanish', async () => {
    await page.click('#optsBtn');
    await page.click('#langSeg button[data-lang="es"]');
    await sleep(200);
    assert.strictEqual(await page.getAttribute('#play', 'title'), 'Reproducir / pausa (Espacio)');
    assert.ok(/Exportar/.test(await page.textContent('#exportBtn')));
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
