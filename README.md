# Crest

A minimal audio and video player for Windows and macOS with a selectable waveform.
Click to seek, select a region and drag it into your DAW or a folder.

## Features
- Waveform: click to seek, select a region and drag it out as a WAV (24-bit).
- Folder audition: open a folder, filter, move with Up/Down.
- Hit detection and batch slice export (Ctrl/Cmd+Shift+E); click-free export (zero-crossing snap, fades); optional UCS naming.
- Spectrogram view, selection meter (peak, RMS, LUFS).
- Varispeed (±24 semitones) from the "Vari" button (V), applied to exports.
- Multichannel (stereo to 7.1+): one lane per channel with a mute button each (keys 1-9, Shift+click or Shift+digit = solo). Muted channels are silenced in exports too.
- Export button: WAV 16/24-bit, AIFF, FLAC, MP3 (320 or V0), OGG Vorbis, AAC. Exports the selection, or the whole file when nothing is selected. Dragging out always gives a WAV.
- **Tools** menu:
  - *Audition with picture*: load a video once, then move through your sounds with the arrow keys; the video plays muted in sync with the open sound. Export the video with the sound you picked.
  - *Loop maker*: crossfaded seamless loops, "find best end", seam view, preview, WAV export with loop points (smpl chunk) for Wwise/FMOD/Unity.
  - *Quality check*: sample and true peak, loudness, clipping (marked on the waveform), DC offset, stereo correlation and goniometer.
  - *Batch process folder*: apply EQ/varispeed, normalize (peak or LUFS with a peak ceiling) and convert a whole folder.
  - *Metadata* (I): read and write name, description, keywords, category, creator and source inside WAV/FLAC/MP3/M4A/OGG (AIFF: name and description). The folder filter also searches these tags.
  - *Send to REAPER*: installs a small ReaScript ("Crest receiver", run it once in REAPER) and inserts your sound at the edit cursor. Not verified against a real REAPER install.
- **A/B and level match**: `\` jumps to the previous tab at the same position; **Match** (M) plays files at the loudness of the first tab.
- Tabs: Ctrl/Cmd+T new tab, Ctrl/Cmd+W close, Ctrl+Tab switch; each tab keeps its position. Ctrl/Cmd+click a file in the list opens it in a new tab.
- Parametric EQ with live analyzer (original design), applied to exports.
- Video: ProRes, DNxHD, HEVC, AVI and more via ffmpeg preview proxy; frame stepping (`,` `.`) with timecode; drag a selection out as a video clip.
- English / Spanish interface.
- On first launch Crest asks whether to use it as the default player (menu: Use Crest as Default Player…). Windows opens Default apps; macOS shows how to do it in Finder (Get Info > Open with > Change All).

## Shortcuts
Space play/pause · [ ] previous/next hit · S spectrogram · E EQ · B hits · F fullscreen · `,` `.` frame step · Esc clear · Ctrl/Cmd+E export selection.

## Build
`npm ci && npm test && npm run dist`. Or run the **Build installers** GitHub Action and download the artifacts (Windows .exe, macOS .dmg for Apple silicon and Intel).

Builds are unsigned: Windows SmartScreen → More info → Run anyway; macOS → right-click → Open.

## Licenses
Crest is MIT. It bundles ffmpeg (ffmpeg-static), licensed GPLv3; license text is in the app's `licenses` folder and under Help/menu → Licenses. Source: https://github.com/eugeneware/ffmpeg-static and https://ffmpeg.org/download.html
