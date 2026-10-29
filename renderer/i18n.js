/* English / Spanish strings. Missing keys fall back to English, then to the key itself. */
(function (root) {
  'use strict';

  const en = {
    dropTitle: 'Drop an audio or video file',
    openBtn: 'Open file…',
    openFolderBtn: 'Open a folder',
    emptyHint: 'Select part of the waveform, then drag it into your DAW or a folder.',

    tPlay: 'Play / pause (Space)',
    tTime: 'Click to switch between time and timecode',
    loudest: 'Loudest',
    tLoudest: 'Jump to the loudest part. Press again for the next loudest (P)',
    tPrevHit: 'Previous hit ( [ )',
    tNextHit: 'Next hit ( ] )',
    tLoop: 'Loop (L)',
    tVol: 'Volume',
    gripFile: 'Drag file',
    gripSel: 'Drag selection',
    tGrip: 'Drag the selection (or the whole file) into your DAW or a folder',
    gripVideo: 'Drag video clip',
    tGripVideo: 'Drag the selected part as a video clip',
    gripVideoPrep: 'Preparing clip… {pct}%',
    tFolder: 'Folder (B)',
    open: 'Open',
    tOpen: 'Open file (Ctrl/Cmd+O)',
    tSpec: 'Waveform / spectrogram (S)',
    eq: 'EQ',
    vari: 'Vari',
    tEq: 'Equalizer (E)',
    tOpts: 'Options',
    tVari: 'Varispeed (V)',
    tNewTab: 'New tab (Ctrl/Cmd+T)',
    tCloseTab: 'Close tab (Ctrl/Cmd+W)',
    selDrag: 'Drag to your DAW',

    filter: 'Filter files…',
    folderEmpty: 'No audio or video files here',
    folderCount: '{n} files',

    oVari: 'Varispeed',
    oVariHint: 'Speed and pitch change together, like tape.',
    oReset: 'Reset',
    oHits: 'Hit detection',
    oSens: 'Sensitivity',
    oExport: 'Export',
    oSnap: 'Snap cuts to zero-crossings',
    oFade: 'Fade in / out',
    oFadeOff: 'Off',
    oApplyFx: 'Include EQ and varispeed',
    oNaming: 'File names',
    oNameOrig: 'Original',
    oNameUcs: 'UCS',
    oUcsCat: 'CatID',
    oUcsFx: 'FX name',
    oUcsCreator: 'Creator',
    oUcsSource: 'Source',
    oLang: 'Language',
    oDefault: 'Use Crest as default player…',
    oExports: 'Open exports folder',

    eqBypass: 'Bypass',
    eqReset: 'Reset',
    eqOut: 'Output',
    eqHint: 'Double-click to add a band · scroll to change Q',
    eqType: 'Type',
    eqFreq: 'Freq',
    eqGain: 'Gain',
    eqQ: 'Q',
    eqSlope: 'Slope',
    eqOn: 'On',
    eqDelete: 'Remove',
    tBell: 'Bell',
    tLowShelf: 'Low shelf',
    tHighShelf: 'High shelf',
    tLowCut: 'Low cut',
    tHighCut: 'High cut',
    tNotch: 'Notch',

    reading: 'Reading waveform…',
    readingPct: 'Reading audio… {pct}%',
    tooLarge: 'This file is too long to draw a waveform — playback only.',
    noDraw: 'Couldn’t draw this file’s waveform — you can still play it.',
    noAudio: 'This file has no audio track.',
    cantPlay: 'This file can’t be played here.',
    cantFormat: 'This format can’t be played.',
    noWave: 'No waveform to analyse yet.',
    silent: 'This file is silent.',
    peakN: 'Peak {n} of {m}  ·  {db} dBFS',
    selectFirst: 'Select part of the waveform first.',
    saved: 'Saved.',
    preparing: 'Preparing…',
    previewPrep: 'Preparing video preview… {pct}%',
    previewFail: 'Couldn’t prepare a preview of this video.',
    noHits: 'No hits found in this file.',
    hitN: 'Hit {n} of {m}',
    exportingN: 'Exporting {n} of {m}…',
    savedN: 'Saved {n} files',
    writeFail: 'Couldn’t write the export file.',
    clipTooLong: 'Video clips are limited to 5 minutes.',
    noFfmpeg: 'This format needs a component that isn’t available.',

    mPeak: 'Peak',
    mRms: 'RMS',
    mLufs: 'LUFS',
    fxNotExported: 'not in exports',
  };

  const es = {
    dropTitle: 'Suelta un archivo de audio o video',
    openBtn: 'Abrir archivo…',
    openFolderBtn: 'Abrir una carpeta',
    emptyHint: 'Selecciona una parte de la onda y arrástrala a tu DAW o a una carpeta.',

    tPlay: 'Reproducir / pausa (Espacio)',
    tTime: 'Clic para alternar entre tiempo y timecode',
    loudest: 'Más fuerte',
    tLoudest: 'Ir a la parte más fuerte. Vuelve a pulsar para la siguiente (P)',
    tPrevHit: 'Golpe anterior ( [ )',
    tNextHit: 'Golpe siguiente ( ] )',
    tLoop: 'Repetir (L)',
    tVol: 'Volumen',
    gripFile: 'Arrastrar archivo',
    gripSel: 'Arrastrar selección',
    tGrip: 'Arrastra la selección (o el archivo completo) a tu DAW o a una carpeta',
    gripVideo: 'Arrastrar clip de video',
    tGripVideo: 'Arrastra la parte seleccionada como clip de video',
    gripVideoPrep: 'Preparando clip… {pct}%',
    tFolder: 'Carpeta (B)',
    open: 'Abrir',
    tOpen: 'Abrir archivo (Ctrl/Cmd+O)',
    tSpec: 'Onda / espectrograma (S)',
    eq: 'EQ',
    vari: 'Vari',
    tEq: 'Ecualizador (E)',
    tOpts: 'Opciones',
    tVari: 'Varispeed (V)',
    tNewTab: 'Nueva pestaña (Ctrl/Cmd+T)',
    tCloseTab: 'Cerrar pestaña (Ctrl/Cmd+W)',
    selDrag: 'Arrastra a tu DAW',

    filter: 'Filtrar archivos…',
    folderEmpty: 'No hay archivos de audio o video aquí',
    folderCount: '{n} archivos',

    oVari: 'Varispeed',
    oVariHint: 'Velocidad y tono cambian juntos, como una cinta.',
    oReset: 'Restablecer',
    oHits: 'Detección de golpes',
    oSens: 'Sensibilidad',
    oExport: 'Exportación',
    oSnap: 'Ajustar cortes al cruce por cero',
    oFade: 'Fade de entrada / salida',
    oFadeOff: 'Sin fade',
    oApplyFx: 'Incluir EQ y varispeed',
    oNaming: 'Nombres de archivo',
    oNameOrig: 'Original',
    oNameUcs: 'UCS',
    oUcsCat: 'CatID',
    oUcsFx: 'Nombre del FX',
    oUcsCreator: 'Creador',
    oUcsSource: 'Fuente',
    oLang: 'Idioma',
    oDefault: 'Usar Crest como reproductor predeterminado…',
    oExports: 'Abrir carpeta de exportaciones',

    eqBypass: 'Bypass',
    eqReset: 'Restablecer',
    eqOut: 'Salida',
    eqHint: 'Doble clic para añadir una banda · rueda para cambiar la Q',
    eqType: 'Tipo',
    eqFreq: 'Frec',
    eqGain: 'Ganancia',
    eqQ: 'Q',
    eqSlope: 'Pendiente',
    eqOn: 'Activa',
    eqDelete: 'Quitar',
    tBell: 'Campana',
    tLowShelf: 'Shelf grave',
    tHighShelf: 'Shelf agudo',
    tLowCut: 'Corte de graves',
    tHighCut: 'Corte de agudos',
    tNotch: 'Notch',

    reading: 'Leyendo la onda…',
    readingPct: 'Leyendo el audio… {pct}%',
    tooLarge: 'Este archivo es demasiado largo para dibujar su onda — solo reproducción.',
    noDraw: 'No se pudo dibujar la onda de este archivo — aún puedes reproducirlo.',
    noAudio: 'Este archivo no tiene pista de audio.',
    cantPlay: 'Este archivo no se puede reproducir aquí.',
    cantFormat: 'Este formato no se puede reproducir.',
    noWave: 'Aún no hay onda para analizar.',
    silent: 'Este archivo está en silencio.',
    peakN: 'Pico {n} de {m}  ·  {db} dBFS',
    selectFirst: 'Primero selecciona una parte de la onda.',
    saved: 'Guardado.',
    preparing: 'Preparando…',
    previewPrep: 'Preparando la vista previa del video… {pct}%',
    previewFail: 'No se pudo preparar una vista previa de este video.',
    noHits: 'No se encontraron golpes en este archivo.',
    hitN: 'Golpe {n} de {m}',
    exportingN: 'Exportando {n} de {m}…',
    savedN: 'Se guardaron {n} archivos',
    writeFail: 'No se pudo escribir el archivo exportado.',
    clipTooLong: 'Los clips de video están limitados a 5 minutos.',
    noFfmpeg: 'Este formato necesita un componente que no está disponible.',

    mPeak: 'Pico',
    mRms: 'RMS',
    mLufs: 'LUFS',
    fxNotExported: 'no se exporta',
  };

  const dict = { en, es };
  let lang = 'en';

  function t(key, vars) {
    let s = (dict[lang] && dict[lang][key]) || en[key] || key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (_m, k) => (vars[k] != null ? vars[k] : '{' + k + '}'));
    return s;
  }

  function apply(rootEl) {
    const scope = rootEl || document;
    scope.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
    scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.title = t(el.dataset.i18nTitle);
      el.setAttribute('aria-label', el.title);
    });
    scope.querySelectorAll('[data-i18n-ph]').forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
  }

  root.CrestI18n = {
    t,
    apply,
    dict,
    get lang() {
      return lang;
    },
    set lang(l) {
      lang = dict[l] ? l : 'en';
      document.documentElement.lang = lang;
    },
  };
})(typeof self !== 'undefined' ? self : this);
