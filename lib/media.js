/*
 * Pure helpers for dealing with ffmpeg output and deciding how a file should be played.
 * No Electron, no I/O: everything here is unit-tested in Node.
 */
'use strict';

const AUDIO_EXT = ['wav', 'wave', 'aif', 'aiff', 'flac', 'mp3', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'wma', 'ac3', 'caf'];
const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'mpg', 'mpeg', 'wmv', 'mxf', 'ogv'];
const MEDIA_EXT = AUDIO_EXT.concat(VIDEO_EXT);

// What Chromium (and therefore Crest) can play without help.
const NATIVE_AUDIO_EXT = new Set(['wav', 'wave', 'mp3', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac']);
const NATIVE_CONTAINER = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv']);
const NATIVE_VCODEC = new Set(['h264', 'vp8', 'vp9', 'av1', 'theora']);
const NATIVE_ACODEC = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

function extOf(p) {
  const m = /\.([^./\\]+)$/.exec(String(p));
  return m ? m[1].toLowerCase() : '';
}

/** "01:02:03.50" -> seconds, or null */
function parseClock(s) {
  const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(s));
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function channelsFromLayout(word) {
  if (!word) return null;
  const w = word.trim().toLowerCase();
  if (w === 'mono') return 1;
  if (w === 'stereo') return 2;
  let m = /^(\d+)\s+channels?/.exec(w);
  if (m) return Number(m[1]);
  m = /^(\d+)\.(\d)/.exec(w); // 5.1, 7.1, 2.1 ...
  if (m) return Number(m[1]) + Number(m[2]);
  m = /^(\d+)\.(\d)\(/.exec(w); // 5.1(side)
  if (m) return Number(m[1]) + Number(m[2]);
  return null;
}

/** Parse the text `ffmpeg -i file` prints on stderr. */
function parseProbe(text) {
  const out = { duration: null, video: null, audio: null };
  const t = String(text || '');
  const d = /Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/.exec(t);
  if (d) out.duration = parseClock(d[1]);

  for (const line of t.split(/\r?\n/)) {
    const m = /^\s*Stream #\d+:\d+(?:\[[^\]]*\])?(?:\(([^)]*)\))?: (Video|Audio): ([^\s,(]+)(.*)$/.exec(line);
    if (!m) continue;
    const kind = m[2];
    const codec = m[3].toLowerCase();
    const rest = m[4] || '';
    if (kind === 'Video' && !out.video) {
      if (/attached pic/.test(line)) continue; // cover art, not a video track
      const res = /,\s*(\d{2,5})x(\d{2,5})/.exec(rest);
      let fps = null;
      const f1 = /(\d+(?:\.\d+)?)\s*fps/.exec(rest);
      const f2 = /(\d+(?:\.\d+)?)\s*tbr/.exec(rest);
      if (f1) fps = Number(f1[1]);
      else if (f2) fps = Number(f2[1]);
      out.video = {
        codec,
        width: res ? Number(res[1]) : null,
        height: res ? Number(res[2]) : null,
        fps: fps && fps > 0 && fps < 1000 ? fps : null,
      };
    } else if (kind === 'Audio' && !out.audio) {
      const hz = /(\d+)\s*Hz/.exec(rest);
      const lay = /Hz,\s*([^,]+)/.exec(rest);
      out.audio = {
        codec,
        sampleRate: hz ? Number(hz[1]) : null,
        channels: channelsFromLayout(lay ? lay[1] : ''),
      };
    }
  }
  return out;
}

/**
 * How should this file be played?
 *   'native'      play the file as is
 *   'audio-fix'   picture is fine, audio codec isn't: copy video, re-encode audio (fast)
 *   'transcode'   build an H.264/AAC preview copy
 *   'extract'     audio-only file Chromium can't play: play a WAV extracted by ffmpeg
 */
function playPlan(probe, ext) {
  ext = String(ext || '').toLowerCase();
  if (probe && probe.video) {
    const containerOk = NATIVE_CONTAINER.has(ext);
    const vOk = NATIVE_VCODEC.has(probe.video.codec);
    const aOk = !probe.audio || NATIVE_ACODEC.has(probe.audio.codec);
    if (containerOk && vOk && aOk) return 'native';
    if (containerOk && vOk) return 'audio-fix';
    return 'transcode';
  }
  if (probe && probe.audio) {
    const ok = NATIVE_AUDIO_EXT.has(ext) && (ext !== 'm4a' || NATIVE_ACODEC.has(probe.audio.codec));
    return ok ? 'native' : 'extract';
  }
  // no probe (ffmpeg unavailable): trust the extension and hope for the best
  if (VIDEO_EXT.includes(ext)) return NATIVE_CONTAINER.has(ext) ? 'native' : 'transcode';
  return NATIVE_AUDIO_EXT.has(ext) ? 'native' : 'extract';
}

const BASE = ['-hide_banner', '-y', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats'];

function extractArgs(input, out) {
  return BASE.concat(['-i', input, '-vn', '-map', '0:a:0', '-c:a', 'pcm_s24le', '-rf64', 'auto', '-f', 'wav', out]);
}

function proxyArgs(input, out, plan) {
  const maps = ['-map', '0:v:0', '-map', '0:a:0?'];
  if (plan === 'audio-fix') {
    return BASE.concat(['-i', input, ...maps, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out]);
  }
  return BASE.concat([
    '-i', input, ...maps,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-vf', 'scale=min(1280\\,iw):-2',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out,
  ]);
}

function clipArgs(input, out, start, end) {
  const dur = Math.max(0.04, end - start);
  return BASE.concat([
    '-ss', start.toFixed(3), '-i', input, '-t', dur.toFixed(3),
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', out,
  ]);
}

/** Lines from `-progress pipe:1` -> seconds processed, or null. */
function parseProgressChunk(chunk) {
  let sec = null;
  for (const line of String(chunk).split(/\r?\n/)) {
    const m = /^out_time=(.+)$/.exec(line.trim());
    if (m) {
      const v = parseClock(m[1]);
      if (v != null) sec = v;
    }
  }
  return sec;
}

// Export formats offered by the Export button. `args: null` means "write the 24-bit WAV as is".
const EXPORT_FORMATS = {
  wav24: { label: 'WAV 24-bit', ext: 'wav', args: null },
  wav16: { label: 'WAV 16-bit', ext: 'wav', args: ['-c:a', 'pcm_s16le'] },
  aiff: { label: 'AIFF 24-bit', ext: 'aif', args: ['-c:a', 'pcm_s24be', '-f', 'aiff'] },
  flac: { label: 'FLAC', ext: 'flac', args: ['-c:a', 'flac', '-compression_level', '8'] },
  mp3_320: { label: 'MP3 320 kbps', ext: 'mp3', args: ['-c:a', 'libmp3lame', '-b:a', '320k'], maxCh: 2 },
  mp3_v0: { label: 'MP3 V0 (VBR)', ext: 'mp3', args: ['-c:a', 'libmp3lame', '-q:a', '0'], maxCh: 2 },
  ogg: { label: 'OGG Vorbis', ext: 'ogg', args: ['-c:a', 'libvorbis', '-q:a', '8'], maxCh: 8 },
  m4a: { label: 'AAC (.m4a)', ext: 'm4a', args: ['-c:a', 'aac', '-b:a', '256k'], maxCh: 8 },
};

/** ffmpeg arguments that turn a 24-bit WAV into the chosen format. Formats limited to stereo are down-mixed. */
function exportArgs(fmt, input, output, channels) {
  const f = EXPORT_FORMATS[fmt];
  if (!f || !f.args) return null;
  const args = ['-hide_banner', '-nostdin', '-y', '-i', input, '-vn', ...f.args];
  if (f.maxCh && channels > f.maxCh) args.push('-ac', String(f.maxCh));
  args.push('-map_metadata', '-1', output);
  return args;
}

module.exports = {
  AUDIO_EXT, VIDEO_EXT, MEDIA_EXT, extOf, parseClock, parseProbe, playPlan,
  extractArgs, proxyArgs, clipArgs, parseProgressChunk, EXPORT_FORMATS, exportArgs,
};
