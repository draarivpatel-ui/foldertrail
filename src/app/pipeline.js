// The parsing worker's logic as plain functions, so Node can test it (worker.js only wires it to postMessage).
//
// Worker protocol (shared with the UI; every message carries the page's `id`):
//   page → worker  {type:'parse', id, source}            source = toWorkerSource(found) from intake.js
//   worker → page  {type:'progress', id, phase, done, total}   phase: reading | parsing | linking | exporting
//   worker → page  {type:'parsed', id, preview, dump}    dump = {text, json} (structure only, src/format/dump.js)
//   page → worker  {type:'export', id, options:{kml, perItem}}   only after the licence check passed
//   worker → page  {type:'exported', id, zip: Blob, filename, report:{text, html}}
//   worker → page  {type:'error', id, code, message}     plain words, never a name, coordinate or path
// The full Library stays here; the page gets the preview, the dump and the finished ZIP only.
//
// Export layout (ARCHITECTURE.md §6):
//   GPX/<top folder>/<folder>/…/<list>.gpx      one GPX per list, mirroring the folders (src/export/paths.js)
//   GPX/Not in any list.gpx                     items no list names
//   GPX/_Duplicate names/<Kind> - <name>.gpx    one file per copy whose list could not be decided (FORMAT.md §10)
//   GPX/All items.gpx                           everything converted
//   GPX/Waypoints.gpx, Tracks.gpx, Routes.gpx   instead of the tree, when there is no usable FolderData.gfi (B11)
//   KML/<top folder>.kml                        optional; nested folders
//   report.txt, report.html, READ-ME-FIRST.txt
// With perItem, each list becomes a folder holding one GPX per item.

import { fromWorkerSource } from './intake.js';
import { readLibrary } from '../format/library.js';
import { buildDump } from '../format/dump.js';
import { planExportPaths, safeStem, fitName } from '../export/paths.js';
import { gpxChunks } from '../export/gpx.js';
import { kmlChunks } from '../export/kml.js';
import { Tally, WRITER_MESSAGES } from '../export/xml.js';
import { ZipWriter } from '../export/zip.js';
import { buildReport, folderPaths } from '../export/report.js';

/** @typedef {import('../model.js').Library} Library */
/** @typedef {import('../model.js').Item} Item */
/** @typedef {import('../model.js').Folder} Folder */
/** @typedef {import('../model.js').Problem} Problem */
/** @typedef {import('../format/library.js').ReadResult} ReadResult */
/** @typedef {import('../format/library.js').ReadDetails} ReadDetails */

const NOT_IN_ANY_LIST = 'Not in any list';
// Files written at the same time during export (see exportLibrary).
const EXPORT_PARALLEL = 2;
const ALL_ITEMS = 'All items';
const DUPLICATES_DIR = '_Duplicate names';
const KIND_WORD = Object.freeze({ waypoint: 'Waypoint', track: 'Track', route: 'Route' });
const BY_TYPE = Object.freeze([
  ['waypoint', 'Waypoints'],
  ['track', 'Tracks'],
  ['route', 'Routes'],
]);

/** Plain words for every error the worker can send. */
export const ERRORS = Object.freeze({
  bad_message: 'The page sent the reader something it did not understand. Reload the page and try again.',
  no_library: 'The library could not be handed over for reading. Give it again.',
  not_parsed: 'There is nothing to export yet. Give the library again.',
  export_failed: 'The download could not be made. Try again; if it keeps failing, try the other export settings.',
  internal: 'Something unexpected went wrong. Reload the page and give the library again.',
});

/**
 * @typedef {object} PipelineOptions
 * @property {string} [brand]
 * @property {string} [version]
 * @property {() => number} [now]       ms since epoch (tests fix it)
 * @property {{engine?: string, engineMajor?: number}} [environment]  for the dump (diagnostic only)
 * @property {import('../format/library.js').ReadLimits} [limits]
 * @property {"auto"|"store"} [compression]
 */

/**
 * @typedef {object} TreeEntry
 * @property {string} id
 * @property {string} name
 * @property {"folder"|"list"} type
 * @property {string|null} parentId
 * @property {{waypoints: number, tracks: number, routes: number}} counts  items directly in it (folders normally 0)
 */

/**
 * @typedef {object} Preview
 * @property {{source: string, version: string|null, experimental: boolean, libraryVersion: string|null}} meta
 * @property {{folders: number, lists: number, waypoints: number, tracks: number, routes: number}} totals
 * @property {TreeEntry[]} tree
 * @property {{waypoints: number, tracks: number, routes: number}} unlisted
 * @property {number} ambiguousCount
 * @property {boolean} treeMissing
 * @property {import('../model.js').NotConverted[]} notConverted
 * @property {Problem[]} problems   report level only
 * @property {{code: string, message: string}|null} fatal  set when nothing could be converted
 * @property {number} multiListItems
 * @property {Array<{kind: string, name: string, copies: number, listIds: string[]}>} duplicates
 */

/**
 * The worker's state machine. `post` receives every outgoing message (and its transfer list, always empty here:
 * a Blob is cloned cheaply by reference).
 */
export class Pipeline {
  /**
   * @param {PipelineOptions & {post: (message: object) => void}} options
   */
  constructor(options) {
    this.post = options.post;
    this.options = options;
    /** @type {{id: unknown, read: ReadResult, sourceProblems: Problem[], libraryVersion: string|null}|null} */
    this.current = null;
    /** @type {Promise<void>} messages are handled one at a time, in order */
    this.queue = Promise.resolve();
  }

  /**
   * Handles one message from the page. Never throws; failures become {type:'error'} messages.
   * @param {unknown} message
   * @returns {Promise<void>}
   */
  handle(message) {
    this.queue = this.queue.then(() => this.#dispatch(message)).catch(() => {});
    return this.queue;
  }

  /** @param {unknown} message */
  async #dispatch(message) {
    const msg = /** @type {any} */ (message);
    const id = msg && typeof msg === 'object' ? msg.id : undefined;
    try {
      if (!msg || typeof msg !== 'object' || (msg.type !== 'parse' && msg.type !== 'export')) {
        this.#error(id, 'bad_message');
        return;
      }
      if (msg.type === 'parse') await this.#parse(id, msg.source);
      else await this.#export(id, msg.options);
    } catch {
      this.#error(id, 'internal');
    }
  }

  /**
   * @param {unknown} id
   * @param {string} code
   * @param {string} [message]
   */
  #error(id, code, message) {
    this.post({ type: 'error', id, code, message: message ?? /** @type {Record<string, string>} */ (ERRORS)[code] ?? ERRORS.internal });
  }

  /**
   * @param {unknown} id
   * @param {unknown} source
   */
  async #parse(id, source) {
    this.current = null;
    const onProgress = (/** @type {{phase: string, done: number, total: number}} */ p) =>
      this.post({ type: 'progress', id, phase: p.phase, done: p.done, total: p.total });
    const revived = await fromWorkerSource(source);
    if (!revived.found.allData) {
      const first = revived.problems[0];
      this.#error(id, 'no_library', first ? first.message : undefined);
      return;
    }
    const read = await readLibrary(revived.found, { limits: this.options.limits, onProgress });
    const libraryVersion = typeof revived.found.version === 'string' ? revived.found.version : null;
    const dump = makeDump(read, source, this.options);
    // The dump is built; drop the container results (views over whole files) before keeping the library.
    read.diagnostics = { allData: null, folderData: null, trackSegments: null };
    const preview = buildPreview(read, { sourceProblems: revived.problems, libraryVersion });
    this.current = { id, read, sourceProblems: revived.problems, libraryVersion };
    this.post({ type: 'parsed', id, preview, dump });
  }

  /**
   * @param {unknown} id
   * @param {unknown} options
   */
  async #export(id, options) {
    const current = this.current;
    if (!current || current.id !== id || current.read.details.fatal) {
      this.#error(id, 'not_parsed');
      return;
    }
    const opts = /** @type {any} */ (options && typeof options === 'object' ? options : {});
    try {
      const result = await exportLibrary(current.read, {
        kml: opts.kml !== false,
        perItem: opts.perItem === true,
        brand: this.options.brand,
        version: this.options.version,
        now: this.options.now,
        compression: this.options.compression,
        sourceProblems: current.sourceProblems,
        libraryVersion: current.libraryVersion,
        onProgress: (p) => this.post({ type: 'progress', id, phase: 'exporting', done: p.done, total: p.total }),
      });
      this.post({ type: 'exported', id, zip: result.zip, filename: result.filename, report: result.report });
    } catch {
      this.#error(id, 'export_failed');
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Preview and dump

/**
 * The free preview: tree and counts, never geometry.
 * @param {ReadResult} read
 * @param {{sourceProblems?: Problem[], libraryVersion?: string|null}} [extra]
 * @returns {Preview}
 */
export function buildPreview(read, extra = {}) {
  const { library, details } = read;
  const kindKey = /** @type {const} */ ({ waypoint: 'waypoints', track: 'tracks', route: 'routes' });
  const byId = new Map(library.items.map((item) => [item.id, item]));
  const totals = { folders: 0, lists: 0, waypoints: 0, tracks: 0, routes: 0 };
  for (const item of library.items) totals[kindKey[item.kind]]++;
  /** @type {Set<string>} */
  const listed = new Set();
  /** @type {TreeEntry[]} */
  const tree = library.folders.map((folder) => {
    if (folder.type === 'list') totals.lists++;
    else if (folder.parentId !== null) totals.folders++;
    const counts = { waypoints: 0, tracks: 0, routes: 0 };
    for (const id of folder.itemIds) {
      const item = byId.get(id);
      if (!item) continue;
      counts[kindKey[item.kind]]++;
      listed.add(id);
    }
    return { id: folder.id, name: folder.name, type: folder.type, parentId: folder.parentId, counts };
  });
  const ambiguous = new Set(library.ambiguous ?? []);
  const unlisted = { waypoints: 0, tracks: 0, routes: 0 };
  // Without a tree the download groups items by type (planFiles, B11) and writes no "Not in any list" file, so the
  // preview must not count anything there either.
  if (!library.treeMissing) {
    for (const item of library.items) {
      if (!listed.has(item.id) && !ambiguous.has(item.id)) unlisted[kindKey[item.kind]]++;
    }
  }
  const problems = [...(extra.sourceProblems ?? []), ...library.problems].filter((p) => (p.level ?? 'report') === 'report');
  return {
    meta: {
      source: library.meta.source,
      version: library.meta.version,
      experimental: details.experimental,
      libraryVersion: extra.libraryVersion ?? null,
    },
    totals,
    tree,
    unlisted,
    ambiguousCount: ambiguous.size,
    treeMissing: library.treeMissing === true,
    notConverted: (library.notConverted ?? []).map((n) => ({ kind: n.kind, name: n.name, reason: n.reason, listIds: [...n.listIds] })),
    problems: problems.map((p) => ({ code: p.code, message: p.message, count: p.count, level: 'report' })),
    fatal: details.fatal,
    multiListItems: details.multiListItems,
    duplicates: details.duplicates.map((d) => ({ kind: d.kind, name: d.name, copies: d.copies, listIds: [...d.listIds] })),
  };
}

/**
 * The structure-only dump (src/format/dump.js). Never throws.
 * @param {ReadResult} read
 * @param {unknown} source  the worker source, only for the input kind
 * @param {PipelineOptions} options
 * @returns {{text: string, json: string}}
 */
export function makeDump(read, source, options) {
  try {
    const src = /** @type {any} */ (source);
    // A backup; loose files picked one by one (no version folder); or a dropped folder.
    const kind = src?.kind === 'zip' ? 'backup' : src?.versionFolder === '' ? 'files' : 'folder';
    const env = options.environment ?? detectEnvironment();
    const dump = buildDump({
      toolVersion: options.version,
      engine: env.engine,
      engineMajor: env.engineMajor,
      inputKind: kind,
      allData: read.diagnostics.allData,
      folderData: read.diagnostics.folderData,
      trackSegments: read.diagnostics.trackSegments,
    });
    return { text: dump.text, json: dump.json };
  } catch {
    const text = 'The structure summary could not be made for this library.\n';
    return { text, json: `${JSON.stringify({ dumpFailed: true })}\n` };
  }
}

/**
 * The engine family and major version, for the dump only (it never changes what the reader does).
 * @returns {{engine: string, engineMajor: number|undefined}}
 */
function detectEnvironment() {
  try {
    const nodeVersion = /** @type {any} */ (globalThis).process?.versions?.node;
    if (typeof nodeVersion === 'string') return { engine: 'Node', engineMajor: Number.parseInt(nodeVersion, 10) };
    const ua = typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string' ? navigator.userAgent : '';
    let m = /Firefox\/(\d+)/.exec(ua);
    if (m) return { engine: 'Gecko', engineMajor: Number(m[1]) };
    m = /(?:Chrome|Chromium|Edg)\/(\d+)/.exec(ua);
    if (m) return { engine: 'Blink', engineMajor: Number(m[1]) };
    m = /Version\/(\d+).*Safari/.exec(ua);
    if (m) return { engine: 'WebKit', engineMajor: Number(m[1]) };
  } catch {
    // fall through
  }
  return { engine: 'other', engineMajor: undefined };
}

// ---------------------------------------------------------------------------------------------
// Export

/**
 * @typedef {object} ExportOptions
 * @property {boolean} [kml]
 * @property {boolean} [perItem]
 * @property {string} [brand]
 * @property {string} [version]
 * @property {() => number} [now]
 * @property {"auto"|"store"} [compression]
 * @property {Problem[]} [sourceProblems]
 * @property {string|null} [libraryVersion]
 * @property {(p: {done: number, total: number}) => void} [onProgress]
 */

/**
 * One planned output file before it is written.
 * @typedef {object} OutFile
 * @property {string} path
 * @property {string} title
 * @property {string} desc
 * @property {Item[]} items
 * @property {boolean} [all]   the All items file (its writer counts go in the report)
 */

/**
 * Writes the download: GPX tree, optional KML, report, packed in one ZIP Blob.
 * @param {ReadResult} read
 * @param {ExportOptions} [options]
 * @returns {Promise<{zip: Blob, filename: string, report: {text: string, html: string}}>}
 */
export async function exportLibrary(read, options = {}) {
  const { library, details } = read;
  const brand = options.brand || 'Foldertrail';
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const perItem = options.perItem === true;
  const withKml = options.kml !== false;
  const progress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

  const ambiguous = new Set(library.ambiguous ?? []);
  const { directories, files, kmlLibrary, kmlName, planProblems } = planFiles(library, ambiguous, perItem);
  const total = files.length + (withKml ? 1 : 0) + 1;
  let done = 0;

  // Each file goes straight into the ZIP writer, which deflates it as it is made and keeps only the compressed bytes:
  // no file is ever held whole and uncompressed. Up to EXPORT_PARALLEL files are written at once, so an engine that
  // compresses off this thread can do two at a time while the next pieces are formatted (Node does, on its thread
  // pool: 4.9 s instead of 6.8 s for the large test library; browsers were not measured). The archive keeps the order
  // of the add() calls. A failure is reported by zip.finish().
  const zip = new ZipWriter({ compression: options.compression ?? 'auto' });
  const mtime = { mtime: now };
  /** @type {Set<Promise<void>>} */
  const running = new Set();
  /**
   * @param {string} path
   * @param {Iterable<string>} content
   */
  const write = async (path, content) => {
    while (running.size >= EXPORT_PARALLEL) await Promise.race(running);
    const job = zip.add(path, content, mtime).then(
      () => progress({ done: ++done, total }),
      () => {},
    );
    running.add(job);
    void job.then(() => running.delete(job));
  };
  for (const dir of directories) await zip.add(dir, undefined, mtime);
  const writerTally = new Tally(WRITER_MESSAGES);
  for (const file of files) {
    const tally = file.all ? writerTally : new Tally(WRITER_MESSAGES);
    await write(file.path, gpxChunks(file.items, { creator: brand, name: file.title, desc: file.desc }, tally));
  }
  const kmlTally = new Tally(WRITER_MESSAGES);
  if (withKml) {
    const kml = kmlChunks(kmlLibrary, { name: kmlName, unfiledName: NOT_IN_ANY_LIST }, kmlTally);
    await write(`KML/${fitName(safeStem(kmlName), '', '.kml')}`, kml);
  }
  await Promise.all(running);
  // The tallies are complete once every file is written.
  const kmlProblems = kmlTally.toProblems().filter((p) => p.code.startsWith('kml_'));

  const writerProblems = [...planProblems, ...writerTally.toProblems(), ...kmlProblems];
  const report = buildReport({
    library,
    details,
    exported: { files: files.length + (withKml ? 1 : 0) + 3, kml: withKml, perItem, writerProblems },
    sourceProblems: options.sourceProblems,
    brand,
    version: options.version,
    now,
    libraryVersion: options.libraryVersion ?? null,
  });
  // As bytes, so text with a lone surrogate (from a hostile name) becomes U+FFFD instead of being refused.
  const encoder = new TextEncoder();
  await zip.add('READ-ME-FIRST.txt', encoder.encode(readMe(brand, withKml, perItem, library.treeMissing === true)), mtime);
  await zip.add('report.txt', encoder.encode(report.text), mtime);
  await zip.add('report.html', encoder.encode(report.html), mtime);

  const parts = await zip.finish();
  progress({ done: ++done, total });
  return { zip: new Blob(parts, { type: 'application/zip' }), filename: `${brand} export ${localDate(now)}.zip`, report };
}

/**
 * Decides every output file and folder.
 * @param {Library} library
 * @param {Set<string>} ambiguous
 * @param {boolean} perItem
 * @returns {{directories: string[], files: OutFile[], kmlLibrary: Library, kmlName: string, planProblems: Problem[]}}
 */
export function planFiles(library, ambiguous, perItem) {
  /** @type {string[]} */
  const directories = ['GPX/'];
  /** @type {OutFile[]} */
  const files = [];
  /** @type {Problem[]} */
  let planProblems = [];
  const items = library.items;

  if (library.treeMissing) {
    // No tree to rebuild: group by type (B11). The KML gets the same three folders.
    /** @type {Folder[]} */
    const kmlFolders = [];
    for (const [kind, label] of BY_TYPE) {
      const ofKind = items.filter((i) => i.kind === kind);
      if (ofKind.length === 0) continue;
      kmlFolders.push({ id: `type-${kind}`, name: label, type: 'list', parentId: null, itemIds: ofKind.map((i) => i.id) });
      if (perItem) {
        directories.push(`GPX/${label}/`);
        // A loop, not push(...): Safari 15 throws RangeError for a call with more than 65,536 arguments.
        for (const file of perItemFiles(`GPX/${label}/`, ofKind, label)) files.push(file);
      } else files.push({ path: `GPX/${label}.gpx`, title: label, desc: '', items: ofKind });
    }
    files.push({ path: `GPX/${ALL_ITEMS}.gpx`, title: ALL_ITEMS, desc: '', items, all: true });
    return { directories, files, kmlLibrary: { ...library, folders: kmlFolders }, kmlName: ALL_ITEMS, planProblems };
  }

  const plan = planExportPaths(library, {
    allItemsName: ALL_ITEMS,
    unfiledName: NOT_IN_ANY_LIST,
    extension: perItem ? '' : '.gpx',
    // Names this function adds at the top: the duplicates folder, and (one file per item) All items.gpx, which is
    // written as a file although the plan names it like a folder.
    reserveRootNames: perItem ? [DUPLICATES_DIR, `${ALL_ITEMS}.gpx`] : [DUPLICATES_DIR],
  });
  planProblems = plan.problems;
  const paths = folderPaths(library.folders);
  for (const dir of plan.directories) directories.push(`GPX/${dir}`);
  for (const planned of plan.files) {
    if (planned.role === 'all') {
      files.push({ path: `GPX/${perItem ? planned.path + '.gpx' : planned.path}`, title: planned.title, desc: '', items, all: true });
      continue;
    }
    // Copies whose list could not be decided go to _Duplicate names, not to "Not in any list".
    const own = planned.role === 'unfiled' ? planned.items.filter((i) => !ambiguous.has(i.id)) : planned.items;
    if (planned.role === 'unfiled' && own.length === 0) continue;
    const desc = planned.folderId ? parentPath(library, planned.folderId, paths) : '';
    if (perItem) {
      const dir = `GPX/${planned.path}/`;
      directories.push(dir);
      const listPath = planned.folderId ? paths.get(planned.folderId) ?? planned.title : planned.title;
      for (const file of perItemFiles(dir, own, listPath)) files.push(file); // no push(...): see above
    } else files.push({ path: `GPX/${planned.path}`, title: planned.title, desc, items: own });
  }
  if (ambiguous.size > 0) {
    const dir = `GPX/${DUPLICATES_DIR}/`;
    directories.push(dir);
    const used = newUsedNames();
    for (const item of items) {
      if (!ambiguous.has(item.id)) continue;
      const stem = `${KIND_WORD[item.kind]} - ${safeStem(item.name)}`;
      files.push({ path: dir + uniqueName(used, stem, '.gpx'), title: item.name, desc: DUPLICATES_DIR, items: [item] });
    }
  }

  // The KML gets the same placement: duplicates in their own folder instead of "Not in any list".
  /** @type {Folder[]} */
  const kmlFolders = [...library.folders];
  if (ambiguous.size > 0) {
    kmlFolders.push({ id: 'kml-duplicates', name: DUPLICATES_DIR, type: 'list', parentId: null, itemIds: [...ambiguous] });
  }
  const root = library.folders.find((f) => f.parentId === null);
  return { directories, files, kmlLibrary: { ...library, folders: kmlFolders }, kmlName: root?.name || ALL_ITEMS, planProblems };
}

/**
 * The folder path above a list, for the GPX <metadata><desc>.
 * @param {Library} library
 * @param {string} folderId
 * @param {Map<string, string>} paths
 */
function parentPath(library, folderId, paths) {
  const folder = library.folders.find((f) => f.id === folderId);
  return folder && folder.parentId ? paths.get(folder.parentId) ?? '' : '';
}

/**
 * One GPX per item inside a directory, with names made unique there.
 * @param {string} dir  ends in "/"
 * @param {Item[]} items
 * @param {string} desc
 * @returns {OutFile[]}
 */
function perItemFiles(dir, items, desc) {
  const used = newUsedNames();
  return items.map((item) => ({ path: dir + uniqueName(used, safeStem(item.name), '.gpx'), title: item.name, desc, items: [item] }));
}

/**
 * The names already used in one directory, plus, per plain name, the next counter worth trying, so that N items with
 * the same name cost O(N) and not O(N²) (a library with thousands of same-named waypoints exported in seconds before).
 * @typedef {{names: Set<string>, next: Map<string, number>}} UsedNames
 * @returns {UsedNames}
 */
function newUsedNames() {
  return { names: new Set(), next: new Map() };
}

/**
 * A file name unique in one directory, compared the way macOS and Windows compare names (case and Unicode form
 * folded, the same key as paths.js and zip.js use), adding " (2)", " (3)", … as needed. Every counter below `next`
 * was already found taken, and names are only ever added, so starting there skips nothing that is free.
 * @param {UsedNames} used
 * @param {string} stem  from safeStem
 * @param {string} ext
 */
function uniqueName(used, stem, ext) {
  const base = foldKey(fitName(stem, '', ext));
  for (let n = used.next.get(base) ?? 1; ; n++) {
    const name = fitName(stem, n === 1 ? '' : ` (${n})`, ext);
    const key = foldKey(name);
    if (!used.names.has(key)) {
      used.names.add(key);
      used.next.set(base, n + 1);
      return name;
    }
  }
}

/** @param {string} name */
function foldKey(name) {
  let key = name.normalize('NFC');
  for (let round = 0; round < 4; round++) {
    const next = key.toUpperCase().toLowerCase().normalize('NFC');
    if (next === key) break;
    key = next;
  }
  return key;
}

/**
 * Text chunks to UTF-8 bytes, without ever holding the whole file as one string.
 * @param {Iterable<string>} chunks
 * @returns {Uint8Array}
 */
export function encodeChunks(chunks) {
  const encoder = new TextEncoder();
  let buffer = new Uint8Array(1 << 16);
  let length = 0;
  for (const chunk of chunks) {
    const most = chunk.length * 3;
    if (length + most > buffer.length) {
      const grown = new Uint8Array(Math.max(length + most, buffer.length * 2));
      grown.set(buffer.subarray(0, length));
      buffer = grown;
    }
    length += encoder.encodeInto(chunk, buffer.subarray(length)).written;
  }
  return buffer.slice(0, length);
}

/** @param {number} ms */
function localDate(ms) {
  const d = new Date(ms);
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * @param {string} brand
 * @param {boolean} kml
 * @param {boolean} perItem
 * @param {boolean} flat
 */
function readMe(brand, kml, perItem, flat) {
  const lines = [
    `Your BaseCamp library, converted by ${brand}`,
    '',
    flat
      ? 'GPX: your folders and lists could not be rebuilt, so items are grouped by type (Waypoints, Tracks, Routes).'
      : perItem
        ? 'GPX: one folder per BaseCamp list, holding one GPX file per item, inside folders named like yours.'
        : 'GPX: one GPX file per BaseCamp list, inside folders named like yours.',
    `GPX/${ALL_ITEMS}.gpx holds everything in one file.`,
    `GPX/${NOT_IN_ANY_LIST}.gpx (if present) holds items that were in no list.`,
    `GPX/${DUPLICATES_DIR} (if present) holds items whose list could not be decided because another item has the same name.`,
  ];
  if (kml) lines.push('KML: one file that keeps your folders, for Google Earth and other apps that read KML.');
  lines.push(
    'report.html (or report.txt): what was converted, what was not, and why.',
    '',
    'Most map apps import GPX files: look for Import or Open in the app. An item that was in several lists is in each',
    "of those lists' files, so import one list at a time, or All items once, to avoid copies.",
    '',
  );
  return lines.join('\n');
}

