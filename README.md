# Crest

A minimal audio and video player for Windows and macOS with a selectable waveform.
Click to seek, jump to the loudest part, select a region and drag it into your DAW or a folder.

## Features
- Waveform: click to seek, **Loudest** button, select a region and drag it out as a WAV (24-bit).
- Folder audition: open a folder, filter, move with Up/Down.
- Hit detection and batch slice export (Ctrl/Cmd+Shift+E); click-free export (zero-crossing snap, fades); optional UCS naming.
- Spectrogram view, selection meter (peak, RMS, LUFS).
- Varispeed (±24 semitones) from the "Vari" button (V), applied to exports.
- Multichannel (stereo to 7.1+): one lane per channel with a mute button each (keys 1-9, Shift+click or Shift+digit = solo). Muted channels are silenced in exports too.
- Tabs: Ctrl/Cmd+T new tab, Ctrl/Cmd+W close, Ctrl+Tab switch; each tab keeps its position. Ctrl/Cmd+click a file in the list opens it in a new tab.
- Parametric EQ with live analyzer (original design), applied to exports.
- Video: ProRes, DNxHD, HEVC, AVI and more via ffmpeg preview proxy; frame stepping (`,` `.`) with timecode; drag a selection out as a video clip.
- English / Spanish interface.
- On first launch Crest asks whether to use it as the default player (menu: Use Crest as Default Player…). Windows opens Default apps; macOS shows how to do it in Finder (Get Info > Open with > Change All).

## Shortcuts
Space play/pause · P/[ ] selection · L loudest · S spectrogram · E EQ · B hits · F fullscreen · `,` `.` frame step · Esc clear · Ctrl/Cmd+E export selection.

## Build
`npm ci && npm test && npm run dist`. Or run the **Build installers** GitHub Action and download the artifacts (Windows .exe, macOS .dmg for Apple silicon and Intel).

Builds are unsigned: Windows SmartScreen → More info → Run anyway; macOS → right-click → Open.

## Licenses
Crest is MIT. It bundles ffmpeg (ffmpeg-static), licensed GPLv3; license text is in the app's `licenses` folder and under Help/menu → Licenses. Source: https://github.com/eugeneware/ffmpeg-static and https://ffmpeg.org/download.html
