#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HELP = `
MKV Track Filter
================

Usage:
  node filter-mkv.js <input.mkv> <output.mkv> [--no-verbose]
  node filter-mkv.js --help

Arguments:
  <input.mkv>    Full path to the source MKV file.
  <output.mkv>   Full path for the output MKV file.

Options:
  -h, --help     Show this guide and exit.
  --no-verbose   Print only a short success summary.
                 Errors are still printed.

What it does:
  - Keeps all video tracks.
  - Keeps Japanese, English and eligible Spanish audio tracks.
  - Rejects explicitly Latin American Spanish audio tracks.
  - Prefers Castilian Spanish subtitles when available;
    otherwise prefers generic Spanish, then Latin American Spanish.
  - Keeps every subtitle in the chosen Spanish group and all
    English subtitles, including forced and CC/SDH tracks.
  - Sets default audio priority: Japanese, Spanish, English.
  - Sets default subtitle priority: Spanish, then English.
  - Renames recognized audio and subtitle tracks:
      ja      -> Japonés
      en      -> Inglés
      es-ES   -> Español
      es-419  -> Latino
    with suffix "Forzado", "Karaoke", "Carteles y Canciones" o "CC".
  - Preserves chapters, attachments, tags and other content
    unless explicitly excluded by mkvmerge.
  - Does not re-encode video or audio.
  - Never overwrites an existing output file.
  - Replaces input file if input and output are the same.

Examples:
  ./filter-mkv.js "/media/input.mkv" "/media/output.mkv"
  ./filter-mkv.js "/media/input.mkv" "/media/output.mkv" --no-verbose
  ./filter-mkv.js --help
  for file in /mnt/media/series/serie/Season\ 1/*.mkv; do ./filter-mkv.js "$file" "$file"; done
`;

function showHelp() {
  console.log(HELP.trim());
}

function parseArgs(argv) {
  const options = {
    verbose: true,
    input: null,
    output: null,
    help: false,
  };

  const positional = [];

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--no-verbose') {
      options.verbose = false;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}\nUse --help for usage.`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 2) {
    throw new Error('Too many file arguments. Use --help for usage.');
  }

  options.input = positional[0] || null;
  options.output = positional[1] || null;

  return options;
}

function log(...args) {
  if (CONFIG.verbose) {
    console.log(...args);
  }
}

let CONFIG = { verbose: true };

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error(
        `${command} was not found. Install MKVToolNix and ensure ` +
        `${command} is available in PATH.`
      );
    }
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `${command} failed with exit code ${result.status}.\n` +
      `${(result.stderr || result.stdout || '').trim()}`
    );
  }

  return result.stdout || '';
}

function normalize(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function props(track) {
  return track.properties || {};
}

function getName(track) {
  return normalize(props(track).track_name || '');
}

function getLanguage(track) {
  const p = props(track);
  return {
    lang: normalize(p.language || ''),
    ietf: normalize(p.language_ietf || ''),
    name: getName(track),
  };
}

function hasAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

// Explicit Spanish regional tags that indicate Latin American Spanish.
const LATAM_TAG = /^(?:es|spa) (?:419|mx|ar|bo|br|cl|co|cr|cu|do|ec|gt|hn|ni|pa|pe|pr|py|sv|us|uy|ve)(?: |$)/;

const LATAM_NAME = [
  /\blatin america(?:n)?\b/,
  /\blatin\b/,
  /\blatinoamerica(?:no|na)?s?\b/,
  /\blatino\b/,
  /\blatam\b/,
  /\bspanish lat\b/,
  /\bspanish latin\b/,
  /\b(?:^|[\s[(|_])la(?:$|[\s\])|_])/,
  /\b(?:^|[\s[(|_])lat(?:$|[\s\])|_])/,

  /\bsouth american spanish\b/,
  /\bhispanoamerica(?:no|na)?s?\b/,

  /\b(?:mexican|mexico|argentinian|argentina|venezuelan|venezuela)\b/,
  /\b(?:colombian|colombia|chilean|chile|peruvian|peru)\b/,
  /\b(?:bolivian|bolivia|ecuadorian|ecuador|uruguayan|uruguay)\b/,
  /\b(?:paraguayan|paraguay)\b/,
];

const CASTILIAN_NAME = [
  /\bcastilian\b/,
  /\bcastellano\b/,
  /\beuropean\b/,
  /\beuropean spanish\b/,
  /\bspanish europe\b/,
  /\bspanish spain\b/,
  /\bspain spanish\b/,

  /\bespanol espana\b/,
  /\bespanol de espana\b/,
  /\bespana\b/,

  /\bspanish esp\b/,
  /\bspanish es\b/,

  // Standalone ES/ESP labels.
  /(?:^|[\s[(|])esp(?:$|[\s\])|])/,
  /(?:^|[\s[(|])es(?:$|[\s\])|])/,
];

const FORCED_PATTERN = /\b(?:forced|forzado|forzados|forzada|forzadas)\b/i;
const KARAOKE_PATTERN = /\bkaraoke(?:s)?\b/i;
const CC_PATTERN = /\b(?:cc|closed captions?)\b/i;
const SDH_PATTERN = /\b(?:sdh|subtitles?\s+for\s+(?:the\s+)?deaf|hard\s+of\s+hearing)\b/i;
const DUB_PATTERN = /\b(?:dub|dubtitle?)\b/i;
const SIGNS_AND_SONGS_PATTERN = /\b(?:signs?\s*(?:and|&|\/)\s*songs?|carteles?\s*(?:y|&|\/)\s*canciones)\b/i;
const SIGNS_ONLY_PATTERN = /\b(?:signs?|titles?\s*(?:and|&|\/)\s*signs?|carteles?)\b/i;

function matchesLanguageTag(value, tags) {
  const text = String(value || '').trim().toLowerCase();

  return tags.some((tag) => {
    const normalizedTag = tag.toLowerCase();
    return text === normalizedTag ||
      text.startsWith(`${normalizedTag} `) ||
      text.startsWith(`${normalizedTag}-`);
  });
}

function getSpanishInfo(track) {
  const p = props(track);
  const info = getLanguage(track);

  const langTag = String(info.lang || '').toLowerCase();
  const ietfTag = String(info.ietf || '').toLowerCase();
  const text = normalize(p.track_name || '');

  // "es", "spa", "es-ES", etc. all identify the track as Spanish.
  const hasSpanishLanguageTag =
    langTag === 'es' ||
    langTag === 'spa' ||
    langTag.startsWith('es-') ||
    ietfTag === 'es' ||
    ietfTag.startsWith('es-');

  const latam =
    ietfTag === 'es-419' ||
    /^es-419(?:-|$)/.test(ietfTag) ||
    hasAny(text, LATAM_NAME);

  const castilian =
    /^es-es(?:-|$)/.test(ietfTag) ||
    /^spa-es(?:-|$)/.test(ietfTag) ||
    langTag === 'es-es' ||
    hasAny(text, CASTILIAN_NAME);

  return {
    ...info,
    text,
    isSpanish: hasSpanishLanguageTag || latam || castilian,
    latam,
    castilian,
  };
}

function isJapanese(track) {
  const { lang, ietf, name } = getLanguage(track);

  return (
    matchesLanguageTag(lang, ['ja', 'jpn']) ||
    matchesLanguageTag(ietf, ['ja', 'jpn']) ||
    /\bjapanese\b|\bjapones\b/.test(name)
  );
}

function isEnglish(track) {
  const { lang, ietf, name } = getLanguage(track);

  return (
    matchesLanguageTag(lang, ['en', 'eng']) ||
    matchesLanguageTag(ietf, ['en', 'eng']) ||
    /\benglish\b|\bingles\b/.test(name)
  );
}

function isSpanishAudio(track) {
  const s = getSpanishInfo(track);

  // Keep Castilian or generic Spanish; reject explicit Latin American.
  return s.isSpanish && !s.latam;
}

function isSpanishSubtitle(track, variant) {
  const info = getSpanishInfo(track);

  if (!info.isSpanish) {
    return false;
  }

  if (variant === 'castilian') {
    // Explicit es-ES metadata is always Castilian.
    return info.castilian && !info.latam;
  }

  if (variant === 'latam') {
    return info.latam;
  }

  if (variant === 'generic') {
    return !info.castilian && !info.latam;
  }

  return false;
}

function isUndefinedTrack(track) {
  const p = track.properties || {};

  const language = String(p.language || '').trim().toLowerCase();
  const languageIetf = String(p.language_ietf || '').trim().toLowerCase();
  const name = String(p.track_name || '').trim();

  // Treat tracks as undefined when mkvmerge provides no meaningful
  // language information and no track name that could identify them.
  const undefinedLanguage =
    !language ||
    language === 'und' ||
    !languageIetf ||
    languageIetf === 'und';

  return undefinedLanguage && !name;
}

function chooseSpanishSubtitleGroup(subtitles) {
  const spanishTracks = subtitles.filter(track => {
    return getSpanishInfo(track).isSpanish;
  });

  const latamTracks = [];
  const castilianTracks = [];
  const genericTracks = [];

  for (const track of spanishTracks) {
    const info = getSpanishInfo(track);

    if (info.latam) {
      latamTracks.push(track);
      continue;
    }

    if (info.castilian) {
      castilianTracks.push(track);
      continue;
    }

    genericTracks.push(track);
  }

  // Priority:
  // 1. Castilian + generic Spanish.
  // 2. Generic Spanish alone.
  // 3. Latin American Spanish.
  if (castilianTracks.length > 0) {
    return {
      variant: 'Castilian/European Spanish',
      tracks: [...castilianTracks, ...genericTracks],
    };
  }

  if (genericTracks.length > 0) {
    return {
      variant: 'generic Spanish',
      tracks: genericTracks,
    };
  }

  if (latamTracks.length > 0) {
    return {
      variant: 'Latin American Spanish',
      tracks: latamTracks,
    };
  }

  return {
    variant: 'none',
    tracks: [],
  };
}

function uniqueTracks(tracks) {
  const seen = new Set();

  return tracks.filter((track) => {
    if (seen.has(track.id)) return false;
    seen.add(track.id);
    return true;
  });
}

function chooseDefaultAudio(tracks) {
  return (
    tracks.find(isJapanese) ||
    tracks.find(isSpanishAudio) ||
    tracks.find(isEnglish) ||
    null
  );
}

function chooseDefaultSubtitle(tracks) {
  if (!tracks || tracks.length === 0) {
    return null;
  }

  function subtitleLanguagePriority(track) {
    const p = track.properties || {};

    const language = String(p.language || '')
      .trim()
      .toLowerCase();

    const ietf = String(p.language_ietf || '')
      .trim()
      .toLowerCase();

    // Explicit Castilian / European Spanish.
    if (
      ietf === 'es-es' ||
      ietf.startsWith('es-es-') ||
      language === 'es-es'
    ) {
      return 0;
    }

    // Generic Spanish. A plain "es" should be preferred over English.
    // It has no explicit regional variant, so we treat it as compatible
    // with the preferred Spanish subtitle group.
    if (
      ietf === 'es' ||
      language === 'es' ||
      language === 'spa'
    ) {
      return 1;
    }

    // Explicit Latin American Spanish.
    if (
      ietf === 'es-419' ||
      ietf.startsWith('es-419-')
    ) {
      return 2;
    }

    // English.
    if (
      ietf === 'en' ||
      ietf.startsWith('en-') ||
      language === 'en' ||
      language === 'eng'
    ) {
      return 3;
    }

    return 999;
  }

  // First pass: always prefer a normal/full subtitle, regardless of
  // where special tracks appear in the MKV.
  const fullCandidates = tracks
    .filter((track) => !isSpecialSubtitle(track))
    .map((track, index) => ({
      track,
      index,
      priority: subtitleLanguagePriority(track),
    }))
    .filter((item) => item.priority < 999)
    // Keep the original MKV order when two tracks have the same priority.
    .sort((a, b) =>
      a.priority - b.priority || a.index - b.index
    );

  if (fullCandidates.length > 0) {
    return fullCandidates[0].track;
  }

  // Second pass: only when there are no full subtitles at all.
  const specialCandidates = tracks
    .filter((track) => isSpecialSubtitle(track))
    .map((track, index) => ({
      track,
      index,
      priority: subtitleLanguagePriority(track),
    }))
    .filter((item) => item.priority < 999)
    .sort((a, b) =>
      a.priority - b.priority || a.index - b.index
    );

  return specialCandidates.length > 0
    ? specialCandidates[0].track
    : null;
}

function isSpecialSubtitle(track) {
  const p = track.properties || {};
  const name = normalize(String(p.track_name || ''));

  // mkvmerge's forced flag is the most reliable forced indicator.
  if (Boolean(p.forced_track)) {
    return true;
  }

  return hasAny(name, [
    FORCED_PATTERN,
    CC_PATTERN,
    SDH_PATTERN,
    KARAOKE_PATTERN,
    SIGNS_ONLY_PATTERN,
    SIGNS_AND_SONGS_PATTERN,
    DUB_PATTERN,
  ]);
}

function getDisplayLanguage(track) {
  const p = props(track);
  const ietf = normalize(p.language_ietf || '');
  const lang = normalize(p.language || '');
  const name = getName(track);

  // Use standardized language tags first.
  if (matchesLanguageTag(ietf, ['ja', 'jpn']) || matchesLanguageTag(lang, ['ja', 'jpn'])) {
    return 'Japonés';
  }

  if (matchesLanguageTag(ietf, ['en', 'eng']) || matchesLanguageTag(lang, ['en', 'eng'])) {
    return 'Inglés';
  }

  if (LATAM_TAG.test(ietf) || LATAM_TAG.test(lang)) {
    return 'Latino';
  }

  if (matchesLanguageTag(ietf, ['es', 'spa']) || matchesLanguageTag(lang, ['es', 'spa'])) {
    return 'Español';
  }

  const spanish = getSpanishInfo(track);

  if (spanish.latam) {
    return 'Latino';
  }
  if (spanish.castilian) {
    return 'Español';
  }
  if (spanish.isSpanish) {
    return 'Español';
  }

  // Fallback for missing or incomplete language metadata.
  if (/\bjapanese\b|\bjapones\b/.test(name)) {
    return 'Japonés';
  }
  if (/\benglish\b|\bingles\b/.test(name)) {
    return 'Inglés';
  }
  if (/\bspanish\b|\bespanol\b|\bcastellano\b/.test(name)) {
    return 'Español';
  }

  return null;
}

function getSubtitleSuffix(track) {
  const p = track.properties || {};
  const originalName = String(p.track_name || '');

  const name = normalize(originalName);
  const suffixes = [];

  const isForced = Boolean(p.forced_track) || FORCED_PATTERN.test(name);
  const isKaraoke = KARAOKE_PATTERN.test(name);
  const isSignsAndSongs = SIGNS_AND_SONGS_PATTERN.test(name);
  const isSignsOnly = !isSignsAndSongs && SIGNS_ONLY_PATTERN.test(name);
  const isCC = CC_PATTERN.test(name);
  const isSDH = SDH_PATTERN.test(name);
  const isDubTitle = DUB_PATTERN.test(name);

  // Keep a predictable order in renamed tracks.
  if (isKaraoke) suffixes.push('Karaoke');

  if (isSignsAndSongs) {
    suffixes.push('Carteles y Canciones');
  } else if (isSignsOnly) {
    suffixes.push('Carteles');
  }

  if (isCC) suffixes.push('CC');
  if (isSDH) suffixes.push('SDH');
  if (isForced) suffixes.push('Forzado');
  if (isDubTitle) suffixes.push('Dub');

  return suffixes;
}

function getAccessibilitySuffix(trackName) {
  if (CC_PATTERN.test(trackName)) {
    return 'CC';
  }

  if (SDH_PATTERN.test(trackName)) {
    return 'SDH';
  }

  return null;
}

function getSignsSuffix(trackName) {
  const name = normalize(trackName);

  if (SIGNS_AND_SONGS_PATTERN.test(name)) {
    return 'Carteles y Canciones';
  }

  if (SIGNS_ONLY_PATTERN.test(name)) {
    return 'Carteles';
  }

  return null;
}

function getDisplayTrackName(track) {
  const languageName = getDisplayLanguage(track);

  if (!languageName) {
    return null;
  }

  // Only subtitles receive these descriptive suffixes.
  if (track.type === 'subtitles') {
    const suffixes = getSubtitleSuffix(track);

    return suffixes.length
      ? `${languageName} ${suffixes.join(' ')}`
      : languageName;
  }

  // Audio tracks retain only the language name.
  return languageName;
}

function getTrackLabel(track) {
  const p = props(track);
  const lang = p.language_ietf || p.language || 'und';
  const name = p.track_name || '(unnamed)';
  const flags = [];

  if (p.default_track) {
    flags.push('default');
  }
  if (p.forced_track) {
    flags.push('forced');
  }
  if (p.hearing_impaired) {
    flags.push('hearing-impaired');
  }
  if (p.visual_impaired) {
    flags.push('visual-impaired');
  }

  return `ID ${track.id}: ${lang} | ${name}` +
    (flags.length ? ` [${flags.join(', ')}]` : '');
}

function makeOutputPath(inputPath) {
  const folder = path.join(
    path.dirname(inputPath),
    path.basename(inputPath, path.extname(inputPath)) + '_filtered'
  );

  fs.mkdirSync(folder, { recursive: true });

  const ext = path.extname(inputPath);
  const stem = path.basename(inputPath, ext);
  let candidate = path.join(folder, path.basename(inputPath));
  let number = 1;

  while (fs.existsSync(candidate)) {
    candidate = path.join(folder, `${stem}_${number}${ext}`);
    number++;
  }

  return candidate;
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help || (!options.input && !options.output)) {
    showHelp();
    return;
  }

  if (!options.input || !options.output) {
    throw new Error(
      'Both input and output paths are required.\nUse --help for usage.'
    );
  }

  CONFIG.verbose = options.verbose;

  const inputPath = path.resolve(options.input);
  const outputPath = path.resolve(options.output);

  if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
    throw new Error(`Input file does not exist: ${inputPath}`);
  }

  const sameInputOutput = inputPath === outputPath;

  let actualOutputPath = outputPath;

  if (sameInputOutput) {
    actualOutputPath = `${inputPath}_tmp`;

    if (fs.existsSync(actualOutputPath)) {
      throw new Error(
        `Temporary output already exists: ${actualOutputPath}\n` +
        `Remove it or rename it before continuing.`
      );
    }
  } else if (fs.existsSync(outputPath)) {
    throw new Error(`Output file already exists: ${outputPath}`);
  }

  log(`Inspecting: ${inputPath}`);

  const info = JSON.parse(run('mkvmerge', ['-J', inputPath]));
  const tracks = info.tracks || [];

  const video = tracks.filter((t) => t.type === 'video');
  const audio = tracks.filter((t) => t.type === 'audio');
  const subtitles = tracks.filter((t) => t.type === 'subtitles');

  if (!video.length) {
    throw new Error('The input file contains no video tracks.');
  }

  const keptVideo = video;

  const keptAudio = uniqueTracks(
    audio.filter((t) =>
      isJapanese(t) || isSpanishAudio(t) || isEnglish(t) || isUndefinedTrack(t)
    )
  );

  const spanishChoice = chooseSpanishSubtitleGroup(subtitles);

  const keptSubtitles = uniqueTracks([
    ...spanishChoice.tracks,
    ...subtitles.filter(isEnglish),
  ]);

  const defaultAudio = chooseDefaultAudio(keptAudio);
  const defaultSubtitle = chooseDefaultSubtitle(keptSubtitles);

  const keptVideoIds = new Set(keptVideo.map((t) => t.id));
  const keptAudioIds = new Set(keptAudio.map((t) => t.id));
  const undefinedSubtitles = keptSubtitles.filter(isUndefinedTrack);

  // Avoid duplicates if the selection logic already included one.
  const keptSubtitleIds = new Set(
    keptSubtitles.map(t => t.id)
  );

  for (const track of undefinedSubtitles) {
    if (!keptSubtitleIds.has(track.id)) {
      keptSubtitles.push(track);
      keptSubtitleIds.add(track.id);
    }
  }

  const droppedAudio = audio.filter((t) => !keptAudioIds.has(t.id));
  const droppedSubtitles = subtitles.filter(
    (t) => !keptSubtitleIds.has(t.id)
  );

  log('\n--- Video tracks kept ---');
  keptVideo.forEach((t) => log(' KEEP ', getTrackLabel(t)));

  log('\n--- Audio tracks kept ---');
  keptAudio.forEach((t) => {
    const marker = defaultAudio?.id === t.id ? ' (NEW DEFAULT)' : '';
    log(' KEEP ', getTrackLabel(t) + marker);
  });

  log('\n--- Audio tracks dropped ---');
  droppedAudio.forEach((t) => log(' DROP ', getTrackLabel(t)));

  log(`\nSpanish subtitle group selected: ${spanishChoice.variant}`);

  log('\n--- Subtitle tracks kept ---');
  keptSubtitles.forEach((t) => {
    const marker = defaultSubtitle?.id === t.id ? ' (NEW DEFAULT)' : '';
    log(' KEEP ', getTrackLabel(t) + marker);
  });

  log('\n--- Subtitle tracks dropped ---');
  droppedSubtitles.forEach((t) => log(' DROP ', getTrackLabel(t)));

  const args = ['-o', actualOutputPath];

  args.push('--video-tracks', keptVideo.map((t) => t.id).join(','));

  if (keptAudio.length) {
    args.push('--audio-tracks', keptAudio.map((t) => t.id).join(','));
  } else {
    args.push('--no-audio');
  }

  if (keptSubtitles.length) {
    args.push(
      '--subtitle-tracks',
      keptSubtitles.map((t) => t.id).join(',')
    );
  } else {
    args.push('--no-subtitles');
  }

  for (const t of keptVideo) {
    args.push('--default-track-flag', `${t.id}:no`);
  }

  for (const t of keptAudio) {
    args.push(
      '--default-track-flag',
      `${t.id}:${defaultAudio?.id === t.id ? 'yes' : 'no'}`
    );
  }

  for (const track of keptSubtitles) {
    const isDefault = defaultSubtitle &&
      track.id === defaultSubtitle.id;

    args.push(
      '--default-track-flag',
      `${track.id}:${isDefault ? 'yes' : 'no'}`
    );
  }

  // Rename recognized audio and subtitle tracks.
  for (const t of [...keptAudio, ...keptSubtitles]) {
    const name = getDisplayTrackName(t);

    if (name) {
      args.push('--track-name', `${t.id}:${name}`);
    }
  }

  // The input file must be the final argument.
  // No global-tags, chapters, attachments or other content are disabled.
  args.push(inputPath);

  log('\n--- mkvmerge command ---');
  log('mkvmerge ' + args.map((a) =>
    /\s/.test(a) ? JSON.stringify(a) : a
  ).join(' '));

  run('mkvmerge', args);

  // Verify the output and report its actual track names/default flags.
  const outInfo = JSON.parse(run('mkvmerge', ['-J', actualOutputPath]));
  const outTracks = outInfo.tracks || [];

  log('\n--- Verification of output ---');
  outTracks.forEach((t) => {
    const isDefault = Boolean(props(t).default_track);
    log(
      `${t.type.toUpperCase()} ${getTrackLabel(t)}` +
      (isDefault ? ' (DEFAULT)' : '')
    );
  });

  const outputAudio = outTracks.filter((t) => t.type === 'audio').map(e => e.properties.track_name).join();
  const outputSubs = outTracks.filter((t) => t.type === 'subtitles').map(e => e.properties.track_name).join();

  if (CONFIG.verbose) {
    console.log('\nFinished successfully.');
    console.log(`Output: ${actualOutputPath}`);
    console.log(
      `Tracks: ${outputAudio} audio; ${outputSubs} subtitles`
    );
  } else {
    console.log(
      `audio=${outputAudio}; subtitles=${outputSubs} | ` +
      `defaultAudio=${defaultAudio ? getDisplayTrackName(defaultAudio) : 'none'} | ` +
      `defaultSubtitle=${defaultSubtitle ? getDisplayTrackName(defaultSubtitle) : 'none'}`
    );
  }

  if (sameInputOutput) {
    if (CONFIG.verbose) {
      console.log("Replacing original file with processed file...");
    }

    try {
      fs.unlinkSync(inputPath);
      fs.renameSync(actualOutputPath, inputPath);
      if (CONFIG.verbose) {
        console.log(`Successfully replaced: ${inputPath}`);
      }
    } catch (error) {
      throw new Error(
        `Could not replace the original file.\n` +
        `Your processed file is preserved at: ${actualOutputPath}\n` +
        `Error: ${error.message}`
      );
    }
  }
}

try {
  main();
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  console.log(err)
  process.exitCode = 1;
}
