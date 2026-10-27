# Crest

A minimal audio and video player for Windows and macOS. Open a file, see the waveform, jump to the loudest part, select a slice and drag it straight into your DAW or a folder.

## Run it

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm start
```

## Make an installer

Each installer has to be built on its own OS (an Electron limitation, not a Crest one):

```bash
npm run dist:mac   # on a Mac    -> dist/Crest-1.0.0-universal.dmg
npm run dist:win   # on Windows  -> dist/Crest Setup 1.0.0.exe
```

No Mac or no PC handy? Push this folder to GitHub, then open **Actions → Build installers → Run workflow**. It builds both and attaches them as downloads.

The macOS build is unsigned, so the first launch needs right-click → Open. To remove that warning you need an Apple Developer ID; Windows may show a SmartScreen notice for the same reason.

## Using it

| Action | How |
| --- | --- |
| Open a file | Drop it on the window, **Open**, or Ctrl/Cmd+O |
| Seek | Click the waveform |
| Select | Click and drag on the waveform. Drag the amber handles to adjust |
| Jump to the loudest part | **Loudest** or `P`. Press again for the next loudest hit |
| Drag into a DAW or folder | Drag the amber selection itself, or the **Drag selection** pill |
| Drag the whole file | With nothing selected, drag the **Drag file** pill |
| Zoom / pan | Ctrl/Cmd + scroll or pinch to zoom, plain scroll to pan, `Z` zoom to selection, `0` fit all |
| Play / pause | `Space`. With a selection, playback stays inside it |
| Loop | `L` |
| Clear selection | `Esc` |
| Save selection as a WAV | Ctrl/Cmd+E |

## What you get when you drag a selection

A **24-bit PCM WAV** of exactly the selected range, with the original channel count and sample rate. Files are written to `Music/Crest Exports` (File → Open Exports Folder) rather than a temp folder, so a DAW that references the file instead of copying it never loses it. Crest never deletes them. Clear that folder whenever you like.

WAV sources are decoded at their own sample rate, so cuts are not resampled. Other formats (MP3, AAC, FLAC, video) are decoded at 48 kHz.

## Good to know

- Video files (MP4, MOV, WebM, MKV) play with picture, and the waveform comes from the audio track.
- The waveform needs the whole file decoded in memory. That is comfortable up to roughly 30 minutes of stereo audio. Anything over 400 MB still plays, just without a waveform or selection.
- Dragging a video file's selection exports its audio as WAV.

## Project layout

```
main.js                 window, menu, file dialogs, drag-out
preload.js              the small, safe bridge to the UI
renderer/               UI (index.html, style.css, renderer.js)
renderer/audio-utils.js waveform peaks, loudest-hit finder, WAV encoder (unit-tested)
scripts/make-icons.js   regenerates the app icon
tests/test.js           npm test
```
