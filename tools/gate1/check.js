// Gate 1 kit: the check page's logic. It takes in a dropped BaseCamp library (the Database/<version> folder, a whole
// BaseCamp folder, a .Backup or .zip file, a .bclibrary package, or the files themselves), reads it on this computer,
// and prints a structure-only report the founder can paste back. Nothing is sent anywhere: this code makes no network
// request of any kind, and the page's Content-Security-Policy blocks them as a second line of defence.
//
// The report never contains a name, a place, a time, a file name or a path. It holds versions, counts, sizes, byte
// offsets and yes/no, plus the kit's own labels for its made-up items (compare.js).
//
// tools/gate1/build.js bundles this module with the reader modules into one classic script inside check.html, because
// browsers do not run module scripts from a page opened from disk (file://) in the same way. The top level only
// defines things; init() wires the page and is called by the bundle when there is a document.

import { openZip } from '../../src/format/unzip.js';
import { readContainer, readHeader } from '../../src/format/container.js';
import { compareLibrary } from './compare.js';
import { buildSyntheticLibrary } from './synth.js';
import { structureDump } from './dump-adapter.js';

export const KIT_VERSION = 1;

/** Largest AllData.gdb or FolderData.gfi read (the whole file is held in memory). */
export const MAX_LIBRARY_FILE_BYTES = 512 * 2 ** 20;
/** Largest single TrackSegments file read. */
export const MAX_SEGMENTS_FILE_BYTES = 16 * 2 ** 20;
/** Most TrackSegments files read per library; more are counted, not read. */
export const MAX_SEGMENTS_FILES = 20_000;
/** Most TrackSegments bytes held per library. */
export const MAX_SEGMENTS_TOTAL_BYTES = 512 * 2 ** 20;
/** Limits for walking a dropped folder. */
export const MAX_WALK_FILES = 200_000;
export const MAX_WALK_ENTRIES = 400_000;
export const MAX_WALK_DEPTH = 32;

const UUID_SHAPE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/**
 * One file to look at. `path` is used only to find roles and group files; it is never printed.
 * @typedef {object} InputFile
 * @property {string} path
 * @property {number} size
 * @property {() => Promise<Uint8Array>} read
 * @property {(n: number) => Promise<Uint8Array>} [head]   the first n bytes (for sniffing)
 * @property {boolean} [topLevel]                           dropped or picked directly, not found inside a folder
 * @property {Blob} [blob]                                  the file itself, for the ZIP reader
 */

/**
 * @typedef {object} Report
 * @property {string} text   the report to paste back
 * @property {object} json   the same facts as JSON
 * @property {any} [compare] the comparison results (for the self-test)
 */

// ---------------------------------------------------------------------------------------------
// Roles and grouping

/**
 * @param {string} path
 * @returns {string[]}
 */
function parts(path) {
  return String(path).split(/[\\/]+/).filter((p) => p !== '' && p !== '.');
}

/**
 * What a file is for, from its path: "alldata", "folderdata", "tracksegment" or "other".
 * @param {string} path
 * @returns {"alldata"|"folderdata"|"tracksegment"|"other"}
 */
export function roleOf(path) {
  const p = parts(path);
  const base = p.length > 0 ? p[p.length - 1] : '';
  const lower = base.toLowerCase();
  if (lower === 'alldata.gdb') return 'alldata';
  if (lower === 'folderdata.gfi') return 'folderdata';
  if (p.length >= 2 && p[p.length - 2].toLowerCase() === 'tracksegments' && UUID_SHAPE.test(base)) return 'tracksegment';
  return 'other';
}

/**
 * The library a file belongs to: the folder holding AllData.gdb, FolderData.gfi and TrackSegments/.
 * @param {string} path
 * @param {string} role
 * @returns {string}
 */
export function libraryKey(path, role) {
  const p = parts(path);
  const up = role === 'tracksegment' ? 2 : 1;
  return p.slice(0, Math.max(0, p.length - up)).join('/');
}

/**
 * @param {string} path
 * @returns {string}
 */
function baseName(path) {
  const p = parts(path);
  return p.length > 0 ? p[p.length - 1] : '';
}

/**
 * An InputFile over a Blob or File.
 * @param {string} path
 * @param {Blob} blob
 * @param {boolean} [topLevel]
 * @returns {InputFile}
 */
export function fromBlob(path, blob, topLevel = false) {
  return {
    path,
    size: blob.size,
    topLevel,
    blob,
    read: async () => new Uint8Array(await blob.arrayBuffer()),
    head: async (n) => new Uint8Array(await blob.slice(0, n).arrayBuffer()),
  };
}

/**
 * @param {Uint8Array} b
 * @param {string} ascii
 * @returns {boolean}
 */
function startsWith(b, ascii) {
  if (b.length < ascii.length) return false;
  for (let i = 0; i < ascii.length; i++) if (b[i] !== ascii.charCodeAt(i)) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// The pipeline

/**
 * Counts that go into the report. Only numbers and fixed words.
 */
class Tally {
  constructor() {
    /** @type {Map<string, number>} */
    this.map = new Map();
  }
  /**
   * @param {string} key
   * @param {number} [n]
   */
  add(key, n = 1) {
    this.map.set(key, (this.map.get(key) ?? 0) + n);
  }
  /** @param {string} key */
  get(key) {
    return this.map.get(key) ?? 0;
  }
}

/**
 * Turns dropped or picked files into the files to read: opens ZIP archives (a .Backup is a ZIP) and sniffs files
 * dropped on their own whose names do not say what they are.
 * @param {InputFile[]} inputs
 * @param {Tally} tally
 * @param {string[]} notes   plain-words notes for the report (no names)
 * @returns {Promise<{ files: Array<InputFile & {role: string}>, kinds: Set<string> }>}
 */
async function expand(inputs, tally, notes) {
  /** @type {Array<InputFile & {role: string}>} */
  const files = [];
  /** @type {Set<string>} */
  const kinds = new Set();
  let zipIndex = 0;
  for (const input of inputs) {
    let role = roleOf(input.path);
    if (role === 'other' && input.topLevel && input.head) {
      let head;
      try {
        head = await input.head(4);
      } catch {
        tally.add('unreadable');
        continue;
      }
      if (startsWith(head, 'PK\u0003\u0004') || startsWith(head, 'PK\u0005\u0006')) {
        kinds.add(/\.backup$/i.test(baseName(input.path)) ? 'backup' : 'zip');
        zipIndex++;
        await expandZip(input, `zip${zipIndex}`, files, tally, notes);
        continue;
      }
      if (startsWith(head, 'MsRc')) role = 'alldata';
      else if (startsWith(head, 'DifG')) role = 'folderdata';
      else if (/\.bclibrary$/i.test(baseName(input.path))) {
        notes.push(
          'A library package was dropped as a single file, so its contents could not be read. In Finder, right-click it, ' +
            'choose Show Package Contents, and drag the folder you see inside (or drag the .Backup file instead).',
        );
        tally.add('package_as_file');
        continue;
      }
    }
    // A .Backup found inside a dropped folder (the whole "Gate1 results" folder, say) is not opened: a BaseCamp folder
    // can hold large backups the founder did not mean to send through. It is counted, and the report says what to do.
    if (role === 'other' && !input.topLevel && /\.backup$/i.test(baseName(input.path))) tally.add('backup_in_folder');
    kinds.add(input.topLevel ? 'files' : 'folder');
    files.push({ ...input, role });
  }
  if (tally.get('backup_in_folder') > 0) {
    notes.push(`A .Backup file was inside the dropped folder (${tally.get('backup_in_folder')}) and was not opened. To read it, drag the .Backup file on its own.`);
  }
  return { files, kinds };
}

/**
 * @param {InputFile} input
 * @param {string} prefix
 * @param {Array<InputFile & {role: string}>} files
 * @param {Tally} tally
 * @param {string[]} notes
 */
async function expandZip(input, prefix, files, tally, notes) {
  /** @type {any} */
  let archive;
  try {
    archive = await openZip(input.blob ?? (await input.read()));
  } catch (error) {
    const code = error && typeof error === 'object' && typeof (/** @type {any} */ (error).code) === 'string' ? /** @type {any} */ (error).code : 'unknown';
    notes.push(`A ZIP or .Backup file could not be opened (reason code: ${safeCode(code)}).`);
    tally.add('zip_unreadable');
    return;
  }
  tally.add('zip_entries', archive.entries.length);
  for (const problem of archive.problems) notes.push(`ZIP: ${problem.message} (${problem.count})`);
  for (const entry of archive.entries) {
    if (entry.isDirectory) continue;
    const role = roleOf(entry.name);
    if (role === 'other') {
      // Counted (and its size added to "other files"), never read.
      tally.add('zip_other_entries');
      files.push({ path: `${prefix}/${entry.name}`, size: entry.uncompressedSize, role, read: async () => new Uint8Array(0) });
      continue;
    }
    if (entry.issue) {
      tally.add('zip_entries_not_readable');
      continue;
    }
    files.push({
      path: `${prefix}/${entry.name}`,
      size: entry.uncompressedSize,
      role,
      read: () => entry.read(),
    });
  }
}

/**
 * Codes come from our own modules, but keep them to a safe shape before printing.
 * @param {unknown} code
 * @returns {string}
 */
function safeCode(code) {
  const s = String(code);
  return /^[a-z0-9_]{1,40}$/i.test(s) ? s : 'unknown';
}

/**
 * @param {InputFile} file
 * @param {number} limit
 * @param {Tally} tally
 * @param {string} what
 * @returns {Promise<Uint8Array|null>}
 */
async function readCapped(file, limit, tally, what) {
  if (!(file.size <= limit)) {
    tally.add(`${what}_too_large`);
    return null;
  }
  try {
    const bytes = await file.read();
    if (bytes.length > limit) {
      tally.add(`${what}_too_large`);
      return null;
    }
    return bytes;
  } catch {
    tally.add(`${what}_unreadable`);
    return null;
  }
}

/**
 * Reads and checks every library found among the inputs.
 * @param {InputFile[]} inputs
 * @param {{ expected: any, features?: Record<string, boolean>, onProgress?: (message: string) => void }} options
 * @returns {Promise<Report>}
 */
export async function runCheck(inputs, options) {
  const tally = new Tally();
  /** @type {string[]} */
  const notes = [];
  const progress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  /** @type {string[]} */
  const out = [];
  /** @type {any} */
  const json = { kit: 'BCR Gate 1', kitVersion: KIT_VERSION, libraries: [] };
  /** @type {any[]} */
  const compares = [];

  try {
    progress('Looking at what was dropped…');
    const { files, kinds } = await expand(Array.isArray(inputs) ? inputs : [], tally, notes);
    const byRole = { alldata: 0, folderdata: 0, tracksegment: 0, other: 0 };
    let otherBytes = 0;
    /** @type {Map<string, {alldata: InputFile[], folderdata: InputFile[], tracksegment: InputFile[]}>} */
    const libraries = new Map();
    for (const f of files) {
      byRole[/** @type {keyof typeof byRole} */ (f.role)]++;
      if (f.role === 'other') {
        otherBytes += Number.isFinite(f.size) ? f.size : 0;
        continue;
      }
      const key = libraryKey(f.path, f.role);
      let lib = libraries.get(key);
      if (!lib) {
        lib = { alldata: [], folderdata: [], tracksegment: [] };
        libraries.set(key, lib);
      }
      lib[/** @type {"alldata"|"folderdata"|"tracksegment"} */ (f.role)].push(f);
    }
    // A library is a folder with AllData.gdb or FolderData.gfi. TrackSegments files with neither are counted only.
    const keys = [...libraries.keys()].filter((k) => {
      const lib = /** @type {any} */ (libraries.get(k));
      return lib.alldata.length > 0 || lib.folderdata.length > 0;
    });
    let strayTrackSegments = 0;
    for (const [k, lib] of libraries) if (!keys.includes(k)) strayTrackSegments += lib.tracksegment.length;

    out.push(`BCR Gate 1 check, kit version ${KIT_VERSION}`);
    out.push('This report holds no names, places, times, file names or paths: only versions, counts, sizes, byte offsets and yes/no.');
    const features = options.features ?? {};
    const featureText = Object.entries(features).map(([k, v]) => `${k} ${v ? 'yes' : 'no'}`).join('; ');
    if (featureText) out.push(`Browser can do: ${featureText}`);
    out.push(`Input: ${[...kinds].sort().join(' + ') || 'nothing readable'}`);
    out.push(`Files by role: AllData.gdb ${byRole.alldata}, FolderData.gfi ${byRole.folderdata}, TrackSegments ${byRole.tracksegment}, other ${byRole.other}`);
    const context = {
      inputKind: kinds.size === 1 ? /** @type {any} */ ([...kinds][0]) : undefined,
      otherFiles: { count: byRole.other, bytes: otherBytes },
    };
    if (tally.get('zip_entries') > 0) {
      out.push(`ZIP entries: ${tally.get('zip_entries')} (not needed: ${tally.get('zip_other_entries')}, not readable: ${tally.get('zip_entries_not_readable')})`);
    }
    if (strayTrackSegments > 0) out.push(`TrackSegments files outside any library folder: ${strayTrackSegments}`);
    out.push(`Library folders found: ${keys.length}`);
    for (const n of notes) out.push(`Note: ${n}`);
    json.input = { kinds: [...kinds].sort(), byRole, zipEntries: tally.get('zip_entries'), strayTrackSegments, notes };
    if (keys.length === 0) {
      out.push('');
      out.push('No AllData.gdb or FolderData.gfi was found. Drag the folder named 4.8 (inside Database), or the .Backup file.');
    }

    // Several version folders (4.6, 4.7, 4.8) can sit side by side; each is reported, in path order (paths are
    // never printed, only the library's number).
    keys.sort();
    let index = 0;
    for (const key of keys) {
      index++;
      const lib = /** @type {{alldata: InputFile[], folderdata: InputFile[], tracksegment: InputFile[]}} */ (libraries.get(key));
      progress(`Reading library ${index} of ${keys.length}…`);
      const result = await checkLibrary(lib, options.expected, tally, context);
      out.push('');
      out.push(`=== Library ${index} of ${keys.length} ===`);
      out.push(...result.lines);
      json.libraries.push(result.json);
      compares.push(result.compare);
    }
  } catch {
    out.push('');
    out.push('The check stopped early because of an internal error. Anything printed above is still valid.');
    json.internalError = true;
  }
  return { text: out.join('\n') + '\n', json, compare: compares };
}

/**
 * @param {{alldata: InputFile[], folderdata: InputFile[], tracksegment: InputFile[]}} lib
 * @param {any} expected
 * @param {Tally} tally
 * @param {{ inputKind?: "folder"|"zip"|"backup"|"files", otherFiles: {count: number, bytes: number} }} context
 * @returns {Promise<{lines: string[], json: any, compare: any}>}
 */
async function checkLibrary(lib, expected, tally, context) {
  /** @type {string[]} */
  const lines = [];
  /** @type {any} */
  const json = {};
  if (lib.alldata.length > 1) lines.push(`More than one AllData.gdb in this folder: ${lib.alldata.length}; the first was read.`);
  if (lib.folderdata.length > 1) lines.push(`More than one FolderData.gfi in this folder: ${lib.folderdata.length}; the first was read.`);

  const gdbBytes = lib.alldata.length > 0 ? await readCapped(lib.alldata[0], MAX_LIBRARY_FILE_BYTES, tally, 'alldata') : null;
  const gfiBytes = lib.folderdata.length > 0 ? await readCapped(lib.folderdata[0], MAX_LIBRARY_FILE_BYTES, tally, 'folderdata') : null;
  if (lib.alldata.length > 0 && gdbBytes === null) lines.push('AllData.gdb could not be read (too large or unreadable).');
  if (lib.folderdata.length > 0 && gfiBytes === null) lines.push('FolderData.gfi could not be read (too large or unreadable).');
  const gdb = gdbBytes === null ? null : readContainer(gdbBytes, { role: 'gdb' });
  const gfi = gfiBytes === null ? null : readContainer(gfiBytes, { role: 'gfi' });

  /** @type {Array<{name: string, bytes: Uint8Array, header: any}>} */
  const segments = [];
  let segmentBytes = 0;
  let skipped = 0;
  for (const f of lib.tracksegment) {
    if (segments.length >= MAX_SEGMENTS_FILES || segmentBytes + f.size > MAX_SEGMENTS_TOTAL_BYTES) {
      skipped++;
      continue;
    }
    const bytes = await readCapped(f, MAX_SEGMENTS_FILE_BYTES, tally, 'tracksegment');
    if (bytes === null) {
      skipped++;
      continue;
    }
    segmentBytes += bytes.length;
    segments.push({ name: baseName(f.path), bytes, header: readHeader(bytes, { role: 'tracksegments' }) });
  }
  if (skipped > 0) lines.push(`TrackSegments files not read (too many, too large or unreadable): ${skipped}`);

  lines.push('--- Structure dump ---');
  try {
    const dump = structureDump({
      gdb,
      gfi,
      trackSegments: segments,
      inputKind: context.inputKind,
      otherFiles: context.otherFiles,
      toolVersion: `${KIT_VERSION}-gate1`,
    });
    lines.push(...dump.text.replace(/\n+$/, '').split('\n'));
    json.dump = dump.json;
  } catch {
    lines.push('The structure dump stopped because of an internal error.');
    json.dumpError = true;
  }

  lines.push('--- Comparison with the made-up content ---');
  const cmp = compareLibrary(
    {
      gdb,
      gfi,
      trackSegments: segments.map((s) => ({ name: s.name, bytes: s.bytes, bodyStart: s.header && s.header.ok ? s.header.bodyStart : undefined })),
    },
    expected,
  );
  lines.push(...cmp.lines);
  json.compare = cmp.json;
  return { lines, json, compare: cmp.json };
}

// ---------------------------------------------------------------------------------------------
// Self-test: a synthetic library made from expected.json, run through the same path.

/**
 * @param {any} expected
 * @returns {Promise<{ passed: boolean, report: Report|null }>}
 */
export async function selfTest(expected) {
  try {
    const library = buildSyntheticLibrary(expected);
    /** @type {InputFile[]} */
    const inputs = [];
    for (const [path, bytes] of library) {
      inputs.push({ path: `selftest/${path}`, size: bytes.length, read: async () => bytes, topLevel: false });
    }
    const report = await runCheck(inputs, { expected });
    return { passed: selfTestPassed(report, expected), report };
  } catch {
    return { passed: false, report: null };
  }
}

/**
 * Everything in the synthetic library must be found exactly.
 * @param {Report} report
 * @param {any} expected
 * @returns {boolean}
 */
export function selfTestPassed(report, expected) {
  const c = Array.isArray(report.compare) && report.compare.length === 1 ? report.compare[0] : null;
  if (!c || !c.gdb || !c.gfi) return false;
  const pointsOk = c.gdb.tracks.every((/** @type {any} */ t) => t.pointsFoundInOrder === t.pointsExpected && t.segmentsFileFound);
  const wpOk = c.gdb.waypoints.every((/** @type {any} */ w) => w.records === 1 && w.positionMatches);
  const rtOk = c.gdb.routes.every((/** @type {any} */ r) => r.records === 1 && r.viaNamesInOrder === r.viaExpected);
  const treeOk = c.gfi.placements.found === c.gfi.placements.expected && c.gfi.rootPresent;
  return pointsOk && wpOk && rtOk && treeOk && c.gdb.waypoints.length === expected.waypoints.length && !report.json.internalError;
}

// ---------------------------------------------------------------------------------------------
// Browser features (detected, never guessed from the browser's name)

/** @returns {Record<string, boolean>} */
export function detectFeatures() {
  const g = /** @type {any} */ (globalThis);
  let inflate = false;
  try {
    inflate = typeof g.DecompressionStream === 'function' && !!new g.DecompressionStream('deflate-raw');
  } catch {
    inflate = false;
  }
  const dt = typeof g.DataTransferItem === 'function' ? g.DataTransferItem.prototype : null;
  return {
    'read folders dropped on the page': !!dt && typeof dt.webkitGetAsEntry === 'function',
    'read .Backup files': inflate,
  };
}

// ---------------------------------------------------------------------------------------------
// Taking in files from the page

/**
 * Walks a dropped folder. readEntries() hands out entries in batches (Chrome: up to 100), so it is called until it
 * returns none. Every entry visited counts towards a cap, so a reader that never runs dry cannot loop forever, and an
 * entry the browser cannot open is counted and skipped without stopping the rest.
 * @param {any} entry   a FileSystemEntry
 * @param {InputFile[]} out
 * @param {{ files: number, entries: number, failed: number, truncated: boolean, limits: WalkLimits }} state
 * @param {number} depth
 * @returns {Promise<void>}
 */
async function walk(entry, out, state, depth) {
  if (!entry) return;
  const { maxFiles, maxEntries, maxDepth } = state.limits;
  if (state.files >= maxFiles || state.entries >= maxEntries) {
    state.truncated = true;
    return;
  }
  state.entries++;
  if (entry.isFile) {
    try {
      /** @type {File} */
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      state.files++;
      out.push(fromBlob(String(entry.fullPath || entry.name || ''), file, depth === 0));
    } catch {
      state.failed++;
    }
    return;
  }
  if (!entry.isDirectory) return;
  if (depth >= maxDepth) {
    state.truncated = true;
    return;
  }
  let reader;
  try {
    reader = entry.createReader();
  } catch {
    state.failed++;
    return;
  }
  for (;;) {
    /** @type {any[]} */
    let batch;
    try {
      batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    } catch {
      state.failed++;
      return;
    }
    if (!batch || batch.length === 0) return;
    for (const child of batch) {
      if (state.files >= maxFiles || state.entries >= maxEntries) {
        state.truncated = true;
        return;
      }
      await walk(child, out, state, depth + 1);
    }
  }
}

/**
 * @typedef {object} WalkLimits
 * @property {number} maxFiles
 * @property {number} maxEntries
 * @property {number} maxDepth
 */

/**
 * The files in a drop. Must be called inside the drop event: the dropped entries are taken synchronously, before the
 * first await, because the browser empties the list when the event ends.
 * @param {DataTransfer} dataTransfer
 * @param {Partial<WalkLimits>} [limits]   smaller caps (for tests); the defaults are the MAX_WALK_* constants
 * @returns {Promise<{ inputs: InputFile[], truncated: boolean, failed: number }>}
 */
export async function inputsFromDrop(dataTransfer, limits = {}) {
  /** @type {InputFile[]} */
  const inputs = [];
  const state = {
    files: 0,
    entries: 0,
    failed: 0,
    truncated: false,
    limits: {
      maxFiles: Math.min(limits.maxFiles ?? MAX_WALK_FILES, MAX_WALK_FILES),
      maxEntries: Math.min(limits.maxEntries ?? MAX_WALK_ENTRIES, MAX_WALK_ENTRIES),
      maxDepth: Math.min(limits.maxDepth ?? MAX_WALK_DEPTH, MAX_WALK_DEPTH),
    },
  };
  /** @type {any[]} */
  const entries = [];
  const items = dataTransfer && dataTransfer.items ? Array.from(dataTransfer.items) : [];
  for (const item of items) {
    if (!item || item.kind !== 'file') continue;
    let entry = null;
    try {
      entry = typeof (/** @type {any} */ (item).webkitGetAsEntry) === 'function' ? /** @type {any} */ (item).webkitGetAsEntry() : null;
    } catch {
      entry = null;
    }
    if (entry) entries.push(entry);
  }
  // The dropped File objects, also taken now (the list is empty once the event is over). Some browsers hand out
  // entries they then refuse to open: Chrome, for a page opened from disk, fails entry.file() and readEntries() with
  // EncodingError, while these File objects still read. A dropped file can then be read from here; a dropped folder
  // cannot (its File is an empty placeholder), so it stays counted as failed.
  /** @type {File[]} */
  let dropped = [];
  try {
    dropped = dataTransfer && dataTransfer.files ? Array.from(dataTransfer.files) : [];
  } catch {
    dropped = [];
  }
  if (entries.length === 0) {
    for (const file of dropped) inputs.push(fromBlob(file.name, file, true));
    return { inputs, truncated: false, failed: 0 };
  }
  /** @type {Set<File>} */
  const used = new Set();
  for (const entry of entries) {
    const failedBefore = state.failed;
    await walk(entry, inputs, state, 0);
    if (state.failed > failedBefore && entry.isFile && !entry.isDirectory) {
      const file = dropped.find((f) => f && !used.has(f) && f.name === entry.name);
      if (file) {
        used.add(file);
        state.failed = failedBefore;
        state.files++;
        inputs.push(fromBlob(String(entry.fullPath || entry.name || file.name), file, true));
      }
    }
  }
  return { inputs, truncated: state.truncated, failed: state.failed };
}

/**
 * @param {FileList|File[]} list
 * @returns {InputFile[]}
 */
export function inputsFromPicker(list) {
  return Array.from(list).map((file) => {
    const rel = /** @type {any} */ (file).webkitRelativePath;
    return fromBlob(typeof rel === 'string' && rel !== '' ? rel : file.name, file, !(typeof rel === 'string' && rel !== ''));
  });
}

// ---------------------------------------------------------------------------------------------
// The page

/**
 * Wires the page. Called by the bundle when a document exists.
 * @param {any} expected
 */
export function init(expected) {
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const drop = $('drop');
  const status = $('status');
  const report = /** @type {HTMLTextAreaElement} */ ($('report'));
  const copy = /** @type {HTMLButtonElement} */ ($('copy'));
  const save = /** @type {HTMLButtonElement} */ ($('save'));
  const pickFolder = /** @type {HTMLInputElement} */ ($('pick-folder'));
  const pickFiles = /** @type {HTMLInputElement} */ ($('pick-files'));
  const selftest = $('selftest');
  const features = detectFeatures();
  let busy = false;

  const setStatus = (/** @type {string} */ text, /** @type {string} */ state) => {
    status.textContent = text;
    status.setAttribute('data-state', state);
  };

  /** @param {Promise<{inputs: InputFile[], truncated?: boolean, failed?: number}>} gather */
  const run = async (gather) => {
    if (busy) return;
    busy = true;
    drop.setAttribute('aria-busy', 'true');
    copy.disabled = true;
    save.disabled = true;
    try {
      setStatus('Reading…', 'busy');
      const { inputs, truncated, failed } = await gather;
      const result = await runCheck(inputs, { expected, features, onProgress: (m) => setStatus(m, 'busy') });
      let text = result.text;
      if (truncated) text += 'Note: the dropped folder held more files than this page reads; the rest were skipped.\n';
      if (failed) {
        text +=
          `Note: the browser would not let this page open ${failed} dropped item(s). Chrome does this with folders dropped on a ` +
          'page opened from disk; there, use the "Choose a folder…" button or drag the .Backup file instead.\n';
      }
      report.value = text;
      copy.disabled = false;
      save.disabled = false;
      setStatus('Done. Copy the report below and paste it back into the chat.', 'done');
    } catch {
      setStatus('Something went wrong while reading. Try dragging the .Backup file instead.', 'error');
    } finally {
      busy = false;
      drop.removeAttribute('aria-busy');
    }
  };

  // The whole page takes the drop, so a drop that misses the box still works (and never makes the browser open the
  // file instead of this page). One handler on the window, so a drop is handled once.
  for (const type of ['dragenter', 'dragover']) {
    window.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.add('over');
    });
  }
  window.addEventListener('dragleave', (event) => {
    if (!event.relatedTarget) drop.classList.remove('over');
  });
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('over');
    // inputsFromDrop takes the dropped entries synchronously, before its first await, as the drop event requires.
    if (event.dataTransfer) run(inputsFromDrop(event.dataTransfer));
  });

  pickFolder.addEventListener('change', () => {
    if (pickFolder.files && pickFolder.files.length > 0) run(Promise.resolve({ inputs: inputsFromPicker(pickFolder.files) }));
    pickFolder.value = '';
  });
  pickFiles.addEventListener('change', () => {
    if (pickFiles.files && pickFiles.files.length > 0) run(Promise.resolve({ inputs: inputsFromPicker(pickFiles.files) }));
    pickFiles.value = '';
  });

  copy.addEventListener('click', async () => {
    let done = false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(report.value);
        done = true;
      }
    } catch {
      done = false;
    }
    if (!done) {
      report.focus();
      report.select();
      try {
        done = document.execCommand('copy');
      } catch {
        done = false;
      }
    }
    setStatus(done ? 'Copied. Paste it into the chat.' : 'Select the report text and press Command-C to copy it.', done ? 'done' : 'error');
  });

  save.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([report.value], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'gate1-report.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setStatus('Saved as gate1-report.txt (usually in your Downloads folder).', 'done');
  });

  const featureList = $('features');
  featureList.textContent = Object.entries(features)
    .map(([k, v]) => `${v ? 'Yes' : 'No'}: ${k}`)
    .join(' · ');

  selftest.textContent = 'Self-test: running…';
  selftest.setAttribute('data-state', 'busy');
  selfTest(expected).then(({ passed }) => {
    selftest.textContent = passed
      ? 'Self-test passed: this page can read a library in this browser.'
      : 'Self-test FAILED: this page cannot read a library in this browser. Try Safari, Chrome or Firefox, and say so in the chat.';
    selftest.setAttribute('data-state', passed ? 'passed' : 'failed');
  });
  setStatus('Waiting for a library.', 'idle');
}
