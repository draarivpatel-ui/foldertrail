// Intake: turns what the user gives the page into a normalised "library source".
//
// Accepted inputs (decisions B5, B20):
//   (a) a drop: a DataTransfer, or the DropCapture that captureDrop() makes from one. Folders are walked
//       with webkitGetAsEntry and FileSystemDirectoryReader.readEntries, which hands entries out in
//       batches (100 at a time in Chrome), so it is called until it returns an empty batch;
//   (b) the FileList of an <input type=file webkitdirectory> (paths come from webkitRelativePath);
//   (c) a single .Backup or .zip file, read with src/format/unzip.js (only its table of contents here);
//   (d) loose files, for example AllData.gdb and FolderData.gfi picked together.
// It then finds the BaseCamp database folder: AllData.gdb, FolderData.gfi and TrackSegments/*, either in
// a Database/<version> folder at any depth or at the top level, and picks one when there are several.
//
// It runs on the page thread, so it reads almost no bytes (ARCHITECTURE.md §4). The only reads are the
// ZIP table of contents and, when nothing was found by name, the first 4 bytes of at most `maxSniff`
// top-level loose files, to tell a backup, a package handed over as a file, or a folder handed over as a
// file apart. Everything else is only listed, and the files that are needed are statted (size and date).
//
// What the user gives is hostile input. Nothing here throws for bad data: problems are counted in plain
// words that never contain a file name, a path, a coordinate or a time. (Version folder names such as
// "4.8" are BaseCamp's, not the user's, and may appear; they are matched by a strict pattern first.)
// Names and paths in `found`, `listing` and DropCapture.raw are for on-page display only: never put them
// in a report, the diagnostic dump or a Problem.

import { openZip, ZipReadError } from '../format/unzip.js';

const ALL_DATA = 'AllData.gdb';
const FOLDER_DATA = 'FolderData.gfi';
const TRACK_SEGMENTS = 'TrackSegments';

/** The smallest a library file can be: its fixed header up to the 'A' record (FORMAT.md §3.1 rule 1). */
const MIN_LIBRARY_FILE = 18;

/** A version folder name such as "4.8"; anything else is never shown in a message. */
const VERSION_RE = /^\d{1,3}(?:\.\d{1,3}){0,3}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME_LENGTH = 1024;
const MAX_DROP_ITEMS = 10_000;
const SEP = '\u0000';

/** @type {Readonly<Required<IntakeLimits>>} */
export const DEFAULT_INTAKE_LIMITS = Object.freeze({
  maxEntries: 300_000,
  maxDepth: 32,
  maxTrackSegments: 200_000,
  maxAllDataBytes: 4e9,
  maxFolderDataBytes: 500e6,
  maxTrackSegmentBytes: 200e6,
  maxZipEntryBytes: 1e9,
  maxListing: 20_000,
  maxCandidates: 64,
  maxSniff: 16,
  callbackTimeoutMs: 30_000,
  statConcurrency: 8,
});

/**
 * @typedef {object} IntakeLimits
 * @property {number} [maxEntries]  files and folders looked at in all (walked, listed, or in a backup's table of contents)
 * @property {number} [maxDepth]    folder levels below the drop root that are looked inside
 * @property {number} [maxTrackSegments]  files taken from TrackSegments
 * @property {number} [maxAllDataBytes]
 * @property {number} [maxFolderDataBytes]
 * @property {number} [maxTrackSegmentBytes]
 * @property {number} [maxZipEntryBytes]  largest file inside a backup that may be read (it is inflated whole)
 * @property {number} [maxListing]  rows kept in `listing` (the probe)
 * @property {number} [maxCandidates]  folders holding an AllData.gdb that are compared
 * @property {number} [maxSniff]    top-level loose files whose first 4 bytes may be looked at
 * @property {number} [callbackTimeoutMs]  how long to wait for one readEntries or file() answer; 0 waits forever
 * @property {number} [statConcurrency]  file() calls in flight at once
 */

/**
 * @typedef {object} IntakeOptions
 * @property {IntakeLimits} [limits]  invalid values fall back to the defaults
 * @property {AbortSignal} [signal]   aborting returns a result with the problem "cancelled" and nothing found
 * @property {(progress: {phase: "listing"|"stat"|"backup", done: number, total: number|null}) => void} [onProgress]
 * @property {boolean} [listing]  also return every delivered item (names relative to the drop root, sizes) for the probe
 * @property {boolean} [sniff]    default true. false skips the 4-byte look at loose files: they are then classified
 *   by name only (a .Backup or .zip is still opened as a backup, which reads its table of contents)
 * @property {{inflateRaw?: boolean}} [features]  overrides feature detection (tests)
 */

/**
 * A file of the library. `bytes(start, end)` works like Blob.slice: `end` is clamped to `size`, and it
 * rejects with a SourceReadError (plain words, no names) when the file cannot be read.
 * @typedef {object} SourceFile
 * @property {string} name   base name as delivered
 * @property {string} path   relative to the drop root (or the archive root); on-page display only
 * @property {number} size   bytes (the uncompressed size inside a backup)
 * @property {number|null} lastModified  ms since epoch, or null when unknown
 * @property {"file"|"zip"} origin
 * @property {Blob|null} blob  the underlying File for folder and loose-file input; null inside a backup
 * @property {{archive: Blob, index: number, entryName: string}|null} zip  where a backup entry lives (for toWorkerSource)
 * @property {(start?: number, end?: number) => Promise<Uint8Array>} bytes  inside a backup the first call
 *   inflates the whole entry and keeps it until release(); the returned array may share that memory, so
 *   do not modify it
 * @property {() => void} release  drops the kept bytes of a backup entry (a no-op for other files)
 */

/**
 * @typedef {object} Found
 * @property {SourceFile|null} allData
 * @property {SourceFile|null} folderData
 * @property {Map<string, SourceFile>} trackSegments  keyed by file name as delivered (a UUID in BaseCamp's layout)
 * @property {string|null} versionFolder  path of the folder used ("" for loose files); on-page display only
 * @property {string|null} version  that folder's name when it is a version number, for example "4.8"
 */

/**
 * Structure-only facts about what was given: numbers and fixed words, safe for the diagnostic dump.
 * @typedef {object} InputInfo
 * @property {"entries"|"file-list"|"files"|"none"} delivery  how the browser handed things over
 * @property {"folder"|"package"|"zip"|"files"|null} kind  what the library used came in
 * @property {number} topFolders
 * @property {number} topFiles
 * @property {number} files
 * @property {number} folders
 * @property {number} skipped  hidden or system items, unusable names, too deep, duplicates, links
 * @property {number|null} archiveEntries
 * @property {boolean|null} archiveZip64
 * @property {number} libraryFolders  folders that hold an AllData.gdb
 * @property {{allData: number, folderData: number, trackSegments: number, trackSegmentsOtherNames: number, trackSegmentsEmpty: number}} roles
 * @property {number} windowsSigns  kinds of sign that the library came from Windows (0-3)
 */

/**
 * @typedef {object} ListingRow
 * @property {string} path   relative to the drop root (inside a backup: to the archive root); display only
 * @property {"file"|"folder"} kind
 * @property {number|null} size
 * @property {boolean} inArchive
 * @property {"allData"|"folderData"|"trackSegment"|null} role
 * @property {string|null} skipped  why it was not used, in plain words
 */

/**
 * @typedef {object} IntakeResult
 * @property {boolean} ok  an AllData.gdb that can be read was found
 * @property {Found} found
 * @property {import('../model.js').Problem[]} problems  what stops or limits the conversion
 * @property {import('../model.js').Problem[]} notes     worth telling the user, but not limiting
 * @property {InputInfo} input
 * @property {ListingRow[]|null} listing  only with options.listing
 * @property {number} listingOmitted  rows beyond maxListing
 * @property {{listMs: number, statMs: number}} timings
 */

/**
 * What the browser said about one dropped item; for the probe. Names are display only.
 * @typedef {object} DropItemInfo
 * @property {string} kind      DataTransferItem.kind ("file", "string", ...) or "files-list" for the fallback
 * @property {string} type      MIME type as given
 * @property {"folder"|"file"|"other"|"none"} entry  what webkitGetAsEntry returned
 * @property {string|null} name  the entry's name
 * @property {string|null} fullPath  the entry's fullPath
 * @property {string|null} fileName  getAsFile()'s name
 * @property {number|null} fileSize
 * @property {string|null} fileType
 */

/**
 * A drop, captured while the drop event runs (the browser empties the DataTransfer afterwards).
 * @typedef {object} DropCapture
 * @property {true} captured
 * @property {{entry: any, file: Blob|null}[]} items
 * @property {DropItemInfo[]} raw
 * @property {string[]} types
 * @property {number} itemCount
 * @property {number} fileCount
 * @property {boolean} usedFiles  the items gave nothing usable, so DataTransfer.files was used
 * @property {boolean} entryApi   at least one item gave an entry
 */

/**
 * @typedef {{type: "entry", entry: any, fallback: Blob|null} | {type: "file", file: Blob} | {type: "zip", entry: import('../format/unzip.js').ZipEntry, index: number}} NodeRef
 * @typedef {{ok: true, size: number, mtime: number|null, blob: Blob|null} | {ok: false, failure: string}} Stat
 * @typedef {{name: string, segments: string[], ref: NodeRef, size: number|null, stat: Stat|null, role: ListingRow["role"]}} FileNode
 * @typedef {{segments: string[], files: Map<string, FileNode>, lowerFiles: Map<string, string[]>, subdirs: Map<string, string[]>, order: number}} DirNode
 */

export class SourceReadError extends Error {
  /**
   * @param {"bad_range"|"read_failed"|"changed"|"too_large"|"damaged"|"unsupported_runtime"} code
   * @param {string} message plain words, never a name
   */
  constructor(code, message) {
    super(message);
    this.name = 'SourceReadError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------
// Plain words

const TEXT = Object.freeze({
  nothing_dropped:
    'Nothing that could be read arrived. Drop a folder or a backup file, or use the buttons to choose one.',
  no_library:
    'No BaseCamp library was found in what you chose. On a Mac it is the folder named with a version number ' +
    '(for example 4.8) in ~/Library/Application Support/Garmin/BaseCamp/Database, or a .Backup file made with ' +
    'File › Backup in BaseCamp.',
  backup_no_library: 'The backup file was opened, but no BaseCamp library (AllData.gdb) was found inside it.',
  exported_gdb:
    "A .gdb file that is not a library's AllData.gdb was given. Files exported from BaseCamp hold your items " +
    'but not your folders and lists, so this tool does not convert them. Give the library itself: its version ' +
    'folder (for example 4.8), or a .Backup file.',
  gpx_given:
    'GPX files were given. A GPX file exported from BaseCamp holds no folders or lists, so there is no tree to ' +
    'rebuild from it. Give the library itself: its version folder (for example 4.8), or a .Backup file.',
  no_all_data:
    'FolderData.gfi (the folders and lists) was found, but AllData.gdb (the items) was not. Both sit in the ' +
    'same folder; give that whole folder.',
  no_folder_data:
    'FolderData.gfi was not found next to AllData.gdb, so the folders and lists cannot be rebuilt. Items will ' +
    'be exported without folders, grouped by type.',
  no_track_segments:
    "The folder that holds track elevation and time (TrackSegments) wasn't found next to AllData.gdb, so tracks " +
    'keep their shape but lose elevation and time.',
  case_variant:
    'Two files had the same name apart from upper and lower case; the one spelled the way BaseCamp spells it was used.',
  duplicate_name: 'Some items had the same name as an earlier item in the same folder; only the first was used.',
  bad_name: 'Some items had names that cannot be used safely and were skipped.',
  bad_entry: 'Some dropped items were neither files nor folders the browser could describe, and were skipped.',
  folder_unreadable: 'Some folders could not be opened by the browser and were skipped.',
  browser_no_answer: 'The browser stopped answering while listing some folders; they were skipped.',
  folder_incomplete:
    'The browser stopped partway through listing some folders, so the files it had not listed yet were not used. If ' +
    'one of them was a TrackSegments folder, some tracks keep their positions but lose elevation and time.',
  library_file_twice:
    'More than one file named AllData.gdb or FolderData.gfi was given in the same place, for example because the ' +
    'browser passed the files on without the folders they were in. Only the first of each was used, and it may not ' +
    'be the newest or belong with the others. To be sure, give the version folder itself (for example ' +
    'Database/4.8), or a .Backup file.',
  folder_twice: 'Two folders with the same name were given at once. Only the first was looked at; to convert the other, give it on its own.',
  package_as_file:
    'Your browser handed over the .bclibrary package as a single file it cannot open. In Finder, right-click ' +
    'the package, choose Show Package Contents, and drag the folder inside onto this page.',
  folder_as_file:
    'Your browser could not open something you dropped. If it was a folder, use the Choose folder button ' +
    'instead, or give a .Backup file.',
  several_backups: 'More than one backup file was given. Give one at a time.',
  backup_inside_folder:
    'The folder holds a backup file (.Backup or .zip) but no library. Give the backup file on its own.',
  cannot_unzip_here:
    'This browser cannot unzip backups. Double-click the backup in Finder (rename it to end in .zip first if ' +
    'Finder will not open it), then drag the folder that appears onto this page.',
  cancelled: 'Reading was canceled.',
  internal: 'Something unexpected went wrong while looking at what you chose. Try again, or give the library another way.',
  package_as_zip: 'Your browser handed over the .bclibrary package as a ZIP file, and it was read as one.',
  windows_library:
    'Some signs suggest this library was copied from a Windows PC. Windows libraries should work the same ' +
    'way, but that has not been checked yet; the report will say if anything could not be read.',
  ignored_backups: 'A backup file was also given. It was not read, because a library folder was found.',
  link_skipped: 'Some items in the backup are links to other files and were skipped.',
  backup_changed: 'The backup file changed after it was first opened. Give it again.',
  bad_source: 'The library could not be handed over for reading. Give it again.',
  read_failed: 'A file could not be read. It may have been moved or changed while this page was open; give it again.',
  changed: 'A file changed while it was being read. Give it again.',
  bad_range: 'A read was asked for an impossible range of bytes.',
  zip_damaged: 'A file inside the backup is damaged and could not be read.',
  zip_too_large:
    'A file inside the backup is too large to read in this browser. Unzip the backup in Finder and drop the ' +
    'folder that appears instead.',
});

/** Plain words for openZip failures (unzip's own texts can carry error details, so they are not shown). */
const ZIP_TEXT = Object.freeze({
  empty_file: 'The backup file is empty (0 bytes).',
  not_zip: 'The file is not a BaseCamp backup: a .Backup file is a ZIP archive, and this one is not.',
  truncated: 'The backup file is incomplete: it ends early. Make the backup again, or copy it again if it was copied.',
  corrupt: 'The backup file is damaged and could not be opened.',
  multi_disk: 'The backup is split into several parts, which this tool cannot read.',
  too_many_entries: 'The backup holds more files than this tool looks at.',
  too_large: "The backup's table of contents is too large to read.",
  read_failed: 'The backup file could not be read. It may have been moved or changed; give it again.',
  unknown: 'The backup file could not be opened.',
});

/** @type {Record<string, {code: string, label: string, isAre: string, effect: string}>} */
const ROLE = {
  allData: { code: 'all_data', label: 'AllData.gdb', isAre: 'is', effect: 'There is nothing to convert without it.' },
  folderData: {
    code: 'folder_data',
    label: 'FolderData.gfi',
    isAre: 'is',
    effect: 'Without it the folders and lists cannot be rebuilt; items will be exported without folders, grouped by type.',
  },
  trackSegment: {
    code: 'track_segment',
    label: 'Some files in TrackSegments',
    isAre: 'are',
    effect: 'Those tracks keep their positions but lose elevation and time.',
  },
};

/** Short reasons used when a newer version folder had to be passed over. */
const REASON_PHRASE = Object.freeze({
  empty: 'it is empty',
  too_small: 'it is too small to be a library file',
  too_large: 'it is too large',
  cannot_unzip_here: 'this browser cannot unzip it',
});

const SKIP = Object.freeze({
  hidden: 'hidden or system item',
  name: 'name cannot be used safely',
  deep: 'nested too deeply',
  duplicate: 'same name as an earlier item in this folder',
  odd: 'neither a file nor a folder',
  link: 'link to another file',
});

// ---------------------------------------------------------------------------------------------
// Public API

/**
 * Captures a drop. Call it synchronously inside the drop event handler: browsers empty the DataTransfer
 * when the handler returns. (intake() does this itself before it awaits anything.) Never throws.
 * @param {unknown} dataTransfer
 * @returns {DropCapture}
 */
export function captureDrop(dataTransfer) {
  /** @type {DropCapture} */
  const capture = {
    captured: true,
    items: [],
    raw: [],
    types: [],
    itemCount: 0,
    fileCount: 0,
    usedFiles: false,
    entryApi: false,
  };
  if (dataTransfer === null || typeof dataTransfer !== 'object') return capture;
  const dt = /** @type {any} */ (dataTransfer);

  try {
    const types = dt.types;
    const n = Math.min(safeLength(types), 64);
    for (let i = 0; i < n; i++) if (typeof types[i] === 'string') capture.types.push(types[i]);
  } catch {
    // no types: fine
  }

  /** @type {any} */
  let items = null;
  try {
    items = dt.items ?? null;
  } catch {
    items = null;
  }
  capture.itemCount = safeLength(items);
  for (let i = 0; i < Math.min(capture.itemCount, MAX_DROP_ITEMS); i++) {
    /** @type {any} */
    let item = null;
    try {
      item = items[i];
    } catch {
      item = null;
    }
    if (item === null || typeof item !== 'object') continue;
    const kind = safeString(() => item.kind);
    const type = safeString(() => item.type);
    if (kind !== 'file') {
      capture.raw.push(itemInfo(kind, type, null, null));
      continue;
    }
    /** @type {any} */
    let entry = null;
    try {
      if (typeof item.webkitGetAsEntry === 'function') entry = item.webkitGetAsEntry();
      else if (typeof item.getAsEntry === 'function') entry = item.getAsEntry();
    } catch {
      entry = null;
    }
    if (entry === undefined || (entry !== null && typeof entry !== 'object')) entry = null;
    /** @type {any} */
    let file = null;
    try {
      file = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
    } catch {
      file = null;
    }
    if (!isBlobLike(file)) file = null;
    if (entry) capture.entryApi = true;
    capture.items.push({ entry, file });
    capture.raw.push(itemInfo(kind, type, entry, file));
  }

  /** @type {any} */
  let files = null;
  try {
    files = dt.files ?? null;
  } catch {
    files = null;
  }
  capture.fileCount = safeLength(files);
  if (!capture.items.some((item) => item.entry || item.file)) {
    capture.items = [];
    capture.usedFiles = capture.fileCount > 0;
    for (let i = 0; i < Math.min(capture.fileCount, MAX_DROP_ITEMS); i++) {
      /** @type {any} */
      let file = null;
      try {
        file = files[i];
      } catch {
        file = null;
      }
      if (!isBlobLike(file)) continue;
      capture.items.push({ entry: null, file });
      capture.raw.push(itemInfo('files-list', safeString(() => file.type), null, file));
    }
  }
  return capture;
}

/**
 * Finds a BaseCamp library in what the user gave. Never throws for bad input.
 * @param {unknown} input  a DataTransfer, a DropCapture, a FileList (webkitdirectory or plain), an array of
 *   Files, or one File
 * @param {IntakeOptions} [options]
 * @returns {Promise<IntakeResult>}
 */
export async function intake(input, options) {
  // A DataTransfer is emptied when the drop event ends, so it is captured before anything is awaited.
  /** @type {DropCapture|null} */
  let capture = null;
  /** @type {ArrayLike<unknown>|null} */
  let list = null;
  try {
    if (isDropCapture(input)) capture = /** @type {DropCapture} */ (input);
    else if (isDataTransferLike(input)) capture = captureDrop(input);
    else if (isBlobLike(input)) list = [input];
    else if (isListLike(input)) list = /** @type {ArrayLike<unknown>} */ (input);
  } catch {
    capture = null;
    list = null;
  }
  /** @type {Ctx} */
  let ctx;
  try {
    ctx = makeContext(options);
  } catch {
    ctx = makeContext(undefined); // options whose getters throw: the defaults
  }
  try {
    const tree = new Tree();
    if (capture) await walkDrop(capture, tree, ctx);
    else if (list) collectFileList(list, tree, ctx);
    addTreeCounts(ctx, tree);
    if (!checkAbort(ctx)) {
      const located = await locateAndFill(tree, ctx, 'file');
      if (located) noteIgnoredBackups(tree, ctx);
      else if (!ctx.aborted) await explainOrOpenBackup(tree, ctx);
    }
    if (ctx.listing && !ctx.aborted) await statListing(ctx);
  } catch {
    ctx.problems.add('internal', TEXT.internal);
  }
  return finish(ctx);
}

/**
 * Whether this runtime can inflate raw DEFLATE data (needed to read compressed backups).
 * @returns {boolean}
 */
export function canInflateRaw() {
  try {
    if (typeof DecompressionStream !== 'function') return false;
    // Constructing one is the only reliable test: some engines have the class but not this format.
    void new DecompressionStream(/** @type {any} */ ('deflate-raw'));
    return true;
  } catch {
    return false;
  }
}

/**
 * @typedef {object} WorkerFileRef
 * @property {string} name
 * @property {string} path
 * @property {number} size
 * @property {number|null} lastModified
 * @property {Blob|null} blob        folder and loose-file input
 * @property {number|null} index     backup input: the entry's position in the archive's table of contents
 * @property {string|null} entryName backup input: the entry's name, checked when the archive is reopened
 */

/**
 * Structured-cloneable form of `found`, to post to the parsing worker (B17: Files, not streams).
 * @typedef {object} WorkerSource
 * @property {"files"|"zip"} kind
 * @property {Blob|null} archive
 * @property {WorkerFileRef|null} allData
 * @property {WorkerFileRef|null} folderData
 * @property {[string, WorkerFileRef][]} trackSegments
 * @property {string|null} versionFolder
 * @property {string|null} version
 */

/**
 * @param {Found} found
 * @returns {WorkerSource}
 */
export function toWorkerSource(found) {
  /** @type {WorkerSource} */
  const out = {
    kind: 'files',
    archive: null,
    allData: null,
    folderData: null,
    trackSegments: [],
    versionFolder: null,
    version: null,
  };
  if (found === null || typeof found !== 'object') return out;
  /** @param {unknown} h @returns {WorkerFileRef|null} */
  const ref = (h) => {
    if (!isSourceFile(h)) return null;
    const file = /** @type {SourceFile} */ (h);
    if (file.origin === 'zip' && file.zip) {
      out.kind = 'zip';
      out.archive = file.zip.archive;
    }
    return {
      name: file.name,
      path: file.path,
      size: file.size,
      lastModified: file.lastModified,
      blob: file.origin === 'file' ? file.blob : null,
      index: file.zip ? file.zip.index : null,
      entryName: file.zip ? file.zip.entryName : null,
    };
  };
  out.allData = ref(found.allData);
  out.folderData = ref(found.folderData);
  if (found.trackSegments instanceof Map) {
    for (const [name, handle] of found.trackSegments) {
      const r = ref(handle);
      if (r) out.trackSegments.push([name, r]);
    }
  }
  out.versionFolder = typeof found.versionFolder === 'string' ? found.versionFolder : null;
  out.version = typeof found.version === 'string' ? found.version : null;
  return out;
}

/**
 * Rebuilds `found` from a WorkerSource (in the worker). A backup is reopened (its table of contents is
 * read again) and each entry is checked against the name it had. Never throws.
 * @param {unknown} source
 * @param {{limits?: IntakeLimits}} [options]
 * @returns {Promise<{found: Found, problems: import('../model.js').Problem[]}>}
 */
export async function fromWorkerSource(source, options) {
  const problems = new Counter();
  const found = emptyFound();
  const limits = resolveLimits(options?.limits);
  try {
    const src = /** @type {any} */ (source);
    if (src === null || typeof src !== 'object' || (src.kind !== 'files' && src.kind !== 'zip')) {
      problems.add('bad_source', TEXT.bad_source);
      return { found, problems: problems.list() };
    }
    found.versionFolder = typeof src.versionFolder === 'string' ? src.versionFolder : null;
    found.version = typeof src.version === 'string' && VERSION_RE.test(src.version) ? src.version : null;
    const segments = Array.isArray(src.trackSegments) ? src.trackSegments : [];

    /** @type {(ref: any) => SourceFile|null} */
    let revive;
    if (src.kind === 'zip') {
      if (!isBlobLike(src.archive)) {
        problems.add('bad_source', TEXT.bad_source);
        return { found, problems: problems.list() };
      }
      let archive;
      try {
        archive = await openZip(src.archive, { maxEntries: limits.maxEntries, maxEntryBytes: limits.maxZipEntryBytes });
      } catch (error) {
        const code = error instanceof ZipReadError ? error.code : 'unknown';
        problems.add(`backup_${code}`, zipText(code));
        return { found, problems: problems.list() };
      }
      revive = (ref) => {
        if (!isWorkerRef(ref) || !Number.isSafeInteger(ref.index) || typeof ref.entryName !== 'string') {
          problems.add('bad_source', TEXT.bad_source);
          return null;
        }
        const entry = archive.entries[ref.index];
        if (!entry || entry.name !== ref.entryName || !(entry.uncompressedSize >= 0)) {
          problems.add('backup_changed', TEXT.backup_changed);
          return null;
        }
        return zipHandle(entry, ref.index, src.archive, ref.name, ref.path, entry.uncompressedSize, ref.lastModified);
      };
    } else {
      revive = (ref) => {
        if (!isWorkerRef(ref) || !isBlobLike(ref.blob)) {
          problems.add('bad_source', TEXT.bad_source);
          return null;
        }
        return fileHandle(ref.blob, ref.name, ref.path, ref.lastModified);
      };
    }
    found.allData = src.allData ? revive(src.allData) : null;
    found.folderData = src.folderData ? revive(src.folderData) : null;
    for (const pair of segments) {
      if (!Array.isArray(pair) || typeof pair[0] !== 'string') {
        problems.add('bad_source', TEXT.bad_source);
        continue;
      }
      const handle = revive(pair[1]);
      if (handle && !found.trackSegments.has(pair[0])) found.trackSegments.set(pair[0], handle);
    }
  } catch {
    problems.add('internal', TEXT.internal);
  }
  return { found, problems: problems.list() };
}

// ---------------------------------------------------------------------------------------------
// Context and reporting

class Counter {
  constructor() {
    /** @type {Map<string, import('../model.js').Problem>} */
    this.map = new Map();
  }

  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [n]
   */
  add(code, message, n = 1) {
    const existing = this.map.get(code);
    if (existing) existing.count += n;
    else this.map.set(code, { code, message, count: n });
  }

  /** @param {string} code */
  has(code) {
    return this.map.has(code);
  }

  /** @returns {import('../model.js').Problem[]} */
  list() {
    return Array.from(this.map.values(), (p) => ({ code: p.code, message: p.message, count: p.count }));
  }
}

/**
 * @param {unknown} limits
 * @returns {Required<IntakeLimits>}
 */
function resolveLimits(limits) {
  /** @type {any} */
  const out = { ...DEFAULT_INTAKE_LIMITS };
  if (limits !== null && typeof limits === 'object') {
    for (const key of Object.keys(DEFAULT_INTAKE_LIMITS)) {
      const value = /** @type {any} */ (limits)[key];
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) out[key] = value;
    }
  }
  if (out.statConcurrency < 1) out.statConcurrency = 1;
  return out;
}

/** @param {unknown} options */
function makeContext(options) {
  const opts = /** @type {any} */ (options !== null && typeof options === 'object' ? options : {});
  const signal = opts.signal !== null && typeof opts.signal === 'object' && 'aborted' in opts.signal ? opts.signal : null;
  const features = opts.features !== null && typeof opts.features === 'object' ? opts.features : {};
  return {
    limits: resolveLimits(opts.limits),
    /** @type {AbortSignal|null} */
    signal,
    /** @type {Function|null} */
    onProgress: typeof opts.onProgress === 'function' ? opts.onProgress : null,
    listing: opts.listing === true,
    sniff: opts.sniff !== false,
    inflateRaw: typeof features.inflateRaw === 'boolean' ? features.inflateRaw : canInflateRaw(),
    problems: new Counter(),
    notes: new Counter(),
    seen: 0,
    full: false,
    aborted: false,
    inArchive: false,
    /** @type {Blob|null} */
    archive: null,
    /** @type {(ListingRow & {node?: FileNode})[]} */
    rows: [],
    rowsOmitted: 0,
    /** @type {Set<string>} */
    windows: new Set(),
    found: emptyFound(),
    /** @type {InputInfo} */
    input: {
      delivery: 'none',
      kind: null,
      topFolders: 0,
      topFiles: 0,
      files: 0,
      folders: 0,
      skipped: 0,
      archiveEntries: null,
      archiveZip64: null,
      libraryFolders: 0,
      roles: { allData: 0, folderData: 0, trackSegments: 0, trackSegmentsOtherNames: 0, trackSegmentsEmpty: 0 },
      windowsSigns: 0,
    },
    listMs: 0,
    statMs: 0,
  };
}

/** @typedef {ReturnType<typeof makeContext>} Ctx */

/** @returns {Found} */
function emptyFound() {
  return { allData: null, folderData: null, trackSegments: new Map(), versionFolder: null, version: null };
}

/**
 * @param {Ctx} ctx
 * @returns {IntakeResult}
 */
function finish(ctx) {
  let found = ctx.found;
  if (ctx.aborted) {
    ctx.problems.add('cancelled', TEXT.cancelled);
    found = emptyFound();
  }
  const roles = ctx.input.roles;
  roles.allData = found.allData ? 1 : 0;
  roles.folderData = found.folderData ? 1 : 0;
  roles.trackSegments = found.trackSegments.size;
  ctx.input.windowsSigns = ctx.windows.size;
  if (found.allData && ctx.windows.size > 0) ctx.notes.add('windows_library', TEXT.windows_library);
  // A code is in one list only: a backup's own note (for example "backup_encrypted") gives way to the problem
  // that says what it means for the conversion.
  const problems = ctx.problems.list();
  const problemCodes = new Set(problems.map((p) => p.code));
  const notes = ctx.notes.list().filter((n) => !problemCodes.has(n.code));
  const listing = ctx.listing
    ? ctx.rows.map((row) => ({
        path: row.path,
        kind: row.kind,
        size: row.size ?? row.node?.size ?? null,
        inArchive: row.inArchive,
        role: row.node?.role ?? null,
        skipped: row.skipped,
      }))
    : null;
  return {
    ok: found.allData !== null,
    found,
    problems,
    notes,
    input: ctx.input,
    listing,
    listingOmitted: ctx.rowsOmitted,
    timings: { listMs: Math.round(ctx.listMs), statMs: Math.round(ctx.statMs) },
  };
}

/**
 * @param {Ctx} ctx
 * @returns {boolean}
 */
function checkAbort(ctx) {
  if (!ctx.aborted && ctx.signal && ctx.signal.aborted) ctx.aborted = true;
  return ctx.aborted;
}

/**
 * @param {Ctx} ctx
 * @param {"listing"|"stat"|"backup"} phase
 * @param {number} done
 * @param {number|null} total
 */
function progress(ctx, phase, done, total) {
  if (!ctx.onProgress) return;
  try {
    ctx.onProgress({ phase, done, total });
  } catch {
    // a failing progress callback must not stop the intake
  }
}

/**
 * Counts `n` more items against maxEntries. Returns how many of them fit; when not all fit, the walk stops.
 * @param {Ctx} ctx
 * @param {number} n
 */
function countSeen(ctx, n) {
  const room = Math.max(0, ctx.limits.maxEntries - ctx.seen);
  const take = Math.min(n, room);
  ctx.seen += take;
  if (take < n && !ctx.full) {
    ctx.full = true;
    ctx.problems.add(
      'too_many_files',
      `What you gave holds more than ${formatCount(ctx.limits.maxEntries)} files and folders. Only the first ` +
        `${formatCount(ctx.limits.maxEntries)} were looked at. Give only the library folder (for example Database/4.8).`,
    );
  }
  return take;
}

/**
 * Waits for a callback-style browser call with a timeout, settling once even if the browser calls back
 * twice or never.
 * @param {(ok: (value: unknown) => void, fail: (error?: unknown) => void) => void} start
 * @param {Ctx} ctx
 * @returns {Promise<{status: "ok", value: unknown} | {status: "error"|"timeout"|"aborted"}>}
 */
function settle(start, ctx) {
  return new Promise((resolve) => {
    let done = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;
    const signal = ctx.signal;
    const onAbort = () => {
      ctx.aborted = true;
      finishWith({ status: 'aborted' });
    };
    /** @param {any} result */
    const finishWith = (result) => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      if (signal) {
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {
          // ignore
        }
      }
      resolve(result);
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      try {
        signal.addEventListener('abort', onAbort);
      } catch {
        // checked between steps instead
      }
    }
    const ms = ctx.limits.callbackTimeoutMs;
    if (ms > 0) timer = setTimeout(() => finishWith({ status: 'timeout' }), ms);
    try {
      start(
        (value) => finishWith({ status: 'ok', value }),
        () => finishWith({ status: 'error' }),
      );
    } catch {
      finishWith({ status: 'error' });
    }
  });
}

/**
 * Runs `task` over `items` with at most `concurrency` in flight.
 * @template T
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<void>} task
 * @param {Ctx} ctx
 */
async function pool(items, concurrency, task, ctx) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      if (checkAbort(ctx)) return;
      const i = next++;
      try {
        await task(items[i], i);
      } catch {
        // tasks report their own problems
      }
    }
  };
  const workers = [];
  for (let k = 0; k < Math.min(concurrency, items.length); k++) workers.push(worker());
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------------------------
// The folder tree of what was given

/** @param {string[]} segments */
const keyOf = (segments) => segments.join(SEP);
/** @param {string} s */
const lower = (s) => s.toLowerCase();

/**
 * @param {string[]} segments
 * @param {number} order
 * @returns {DirNode}
 */
function newDir(segments, order) {
  return { segments, files: new Map(), lowerFiles: new Map(), subdirs: new Map(), order };
}

/**
 * @param {Map<string, string[]>} index
 * @param {string} name
 */
function addIndex(index, name) {
  const key = lower(name);
  const list = index.get(key);
  if (!list) index.set(key, [name]);
  else if (!list.includes(name)) list.push(name);
}

class Tree {
  constructor() {
    /** @type {Map<string, DirNode>} */
    this.dirs = new Map();
    this.root = newDir([], 0);
    this.dirs.set('', this.root);
    this.fileCount = 0;
    this.folderCount = 0;
  }

  /**
   * The folder at `segments`, created with its parents when missing.
   * @param {string[]} segments
   * @param {(segments: string[]) => void} [onCreate]
   * @returns {DirNode}
   */
  ensure(segments, onCreate) {
    // Most calls are for a folder that exists (once per file): one lookup instead of one per level.
    const known = this.dirs.get(keyOf(segments));
    if (known) return known;
    let dir = this.root;
    for (let i = 0; i < segments.length; i++) {
      const path = segments.slice(0, i + 1);
      const key = keyOf(path);
      let child = this.dirs.get(key);
      if (!child) {
        child = newDir(path, this.dirs.size);
        this.dirs.set(key, child);
        addIndex(dir.subdirs, segments[i]);
        this.folderCount++;
        if (onCreate) onCreate(path);
      }
      dir = child;
    }
    return dir;
  }

  /**
   * @param {DirNode} dir
   * @param {string} name
   */
  hasName(dir, name) {
    return dir.files.has(name) || (dir.subdirs.get(lower(name)) ?? []).includes(name);
  }

  /**
   * @param {string[]} dirSegments
   * @param {string} name
   * @param {NodeRef} ref
   * @param {number|null} size
   * @returns {FileNode|null}  null when the name is already taken in that folder
   */
  addFile(dirSegments, name, ref, size) {
    const dir = this.ensure(dirSegments);
    if (this.hasName(dir, name)) return null;
    /** @type {FileNode} */
    const node = { name, segments: dirSegments, ref, size, stat: null, role: null };
    dir.files.set(name, node);
    addIndex(dir.lowerFiles, name);
    this.fileCount++;
    return node;
  }

  /**
   * The file named `canonical` in `dir`, ignoring case; the exact spelling wins when several match.
   * @param {DirNode} dir
   * @param {string} canonical
   * @returns {{node: FileNode, variants: number}|null}
   */
  pick(dir, canonical) {
    const names = dir.lowerFiles.get(lower(canonical));
    if (!names || names.length === 0) return null;
    const name = names.includes(canonical) ? canonical : names[0];
    const node = dir.files.get(name);
    return node ? { node, variants: names.length } : null;
  }

  /**
   * @param {DirNode} dir
   * @param {string} canonical
   * @returns {DirNode|null}
   */
  subdir(dir, canonical) {
    const names = dir.subdirs.get(lower(canonical));
    if (!names || names.length === 0) return null;
    const name = names.includes(canonical) ? canonical : names[0];
    return this.dirs.get(keyOf([...dir.segments, name])) ?? null;
  }
}

/**
 * @param {Ctx} ctx
 * @param {Tree} tree
 */
function addTreeCounts(ctx, tree) {
  ctx.input.files += tree.fileCount;
  ctx.input.folders += tree.folderCount;
}

/**
 * @param {unknown} name
 * @returns {string|null}  the name, or null when it cannot be used as one path segment
 */
function cleanName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) return null;
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\u0000')) return null;
  return name;
}

/** @param {string} name  .DS_Store, ._ AppleDouble files, .Trashes and other dot items */
const isHidden = (name) => name.startsWith('.');
/** @param {string} name */
const ignoredFolder = (name) => name === '__MACOSX' || name.startsWith('.');

/** @param {string} name */
function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? lower(name.slice(dot + 1)) : '';
}

/** @param {unknown} raw */
function displayName(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return '(no name)';
  return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
}

/**
 * @param {Ctx} ctx
 * @param {ListingRow & {node?: FileNode}} row
 */
function addRow(ctx, row) {
  if (!ctx.listing) return;
  if (ctx.rows.length >= ctx.limits.maxListing) {
    ctx.rowsOmitted++;
    return;
  }
  ctx.rows.push(row);
}

/**
 * @param {Ctx} ctx
 * @param {keyof typeof SKIP} reason
 * @param {string[]} segments  display path of the skipped item
 * @param {"file"|"folder"} kind
 */
function skip(ctx, reason, segments, kind) {
  ctx.input.skipped++;
  if (reason === 'name') ctx.problems.add('bad_name', TEXT.bad_name);
  else if (reason === 'duplicate') ctx.problems.add('duplicate_name', TEXT.duplicate_name);
  else if (reason === 'odd') ctx.problems.add('bad_entry', TEXT.bad_entry);
  else if (reason === 'link') ctx.notes.add('link_skipped', TEXT.link_skipped);
  else if (reason === 'deep') {
    ctx.problems.add(
      'too_deep',
      `Some folders are nested more than ${ctx.limits.maxDepth} levels deep and were not looked inside.`,
    );
  }
  addRow(ctx, { path: segments.join('/'), kind, size: null, inArchive: ctx.inArchive, role: null, skipped: SKIP[reason] });
}

/**
 * @param {Ctx} ctx
 * @param {string[]} segments
 */
function noteFolder(ctx, segments) {
  const name = lower(segments[segments.length - 1]);
  if (name === 'appdata' || name === 'roaming') ctx.windows.add('appdata');
  addRow(ctx, { path: segments.join('/'), kind: 'folder', size: null, inArchive: ctx.inArchive, role: null, skipped: null });
}

/**
 * Adds one file named `rawName` in the folder `dirSegments` (already checked).
 * @param {Ctx} ctx
 * @param {Tree} tree
 * @param {string[]} dirSegments
 * @param {unknown} rawName
 * @param {NodeRef} ref
 * @param {number|null} size
 * @returns {FileNode|null}
 */
function addFile(ctx, tree, dirSegments, rawName, ref, size) {
  const name = cleanName(rawName);
  if (name === null) {
    skip(ctx, 'name', [...dirSegments, displayName(rawName)], 'file');
    return null;
  }
  if (isHidden(name)) {
    skip(ctx, 'hidden', [...dirSegments, name], 'file');
    return null;
  }
  const node = tree.addFile(dirSegments, name, ref, size);
  if (!node) {
    skip(ctx, 'duplicate', [...dirSegments, name], 'file');
    // Which copy is the right one cannot be told (they may come from different versions), so say so plainly.
    const low = lower(name);
    if (low === lower(ALL_DATA) || low === lower(FOLDER_DATA)) ctx.problems.add('library_file_twice', TEXT.library_file_twice);
    return null;
  }
  const low = lower(name);
  if (low === 'thumbs.db' || low === 'desktop.ini') ctx.windows.add('windows-files');
  addRow(ctx, { path: [...dirSegments, name].join('/'), kind: 'file', size, inArchive: ctx.inArchive, role: null, skipped: null, node });
  return node;
}

/**
 * Adds a file given by a whole relative path (FileList and backup input).
 * @param {Ctx} ctx
 * @param {Tree} tree
 * @param {string[]} segments  path segments, the file name last
 * @param {NodeRef} ref
 * @param {number|null} size
 */
function addPathFile(ctx, tree, segments, ref, size) {
  if (segments.length === 0) {
    skip(ctx, 'name', ['(no name)'], 'file');
    return null;
  }
  for (const segment of segments) {
    if (cleanName(segment) === null) {
      skip(ctx, 'name', segments.map(displayName), 'file');
      return null;
    }
  }
  const dirSegments = segments.slice(0, -1);
  if (dirSegments.some(ignoredFolder)) {
    skip(ctx, 'hidden', segments, 'file');
    return null;
  }
  if (dirSegments.length > ctx.limits.maxDepth) {
    skip(ctx, 'deep', segments, 'file');
    return null;
  }
  tree.ensure(dirSegments, (path) => noteFolder(ctx, path));
  return addFile(ctx, tree, dirSegments, segments[segments.length - 1], ref, size);
}

// ---------------------------------------------------------------------------------------------
// Collecting: drops, file lists, backups

/**
 * @param {DropCapture} capture
 * @param {Tree} tree
 * @param {Ctx} ctx
 */
async function walkDrop(capture, tree, ctx) {
  const started = now();
  ctx.input.delivery = capture.entryApi ? 'entries' : capture.items.length > 0 ? 'files' : 'none';
  // Folders are listed breadth first, in the order the browser handed them over, and folders named the way
  // BaseCamp names them (Garmin, BaseCamp, Database, a version, TrackSegments, a .bclibrary) before the others.
  // So a symlink loop, a huge cache folder or a deep tree next to the library cannot use up maxEntries before
  // the library itself has been listed.
  const queue = new WalkQueue();

  for (const item of capture.items) {
    if (checkAbort(ctx) || ctx.full) break;
    if (countSeen(ctx, 1) < 1) break;
    const entry = item.entry;
    const kind = entryKind(entry);
    if (kind === 'folder') {
      ctx.input.topFolders++;
      const rawName = safeValue(() => entry.name);
      const name = cleanName(rawName);
      if (name === null) skip(ctx, 'name', [displayName(rawName)], 'folder');
      else if (ignoredFolder(name)) skip(ctx, 'hidden', [name], 'folder');
      else if (tree.hasName(tree.root, name)) {
        // Two folders dragged in together that share a name (from two Finder windows, say): the second may
        // well be the newer library, so this is said plainly rather than only counted as a duplicate.
        skip(ctx, 'duplicate', [name], 'folder');
        ctx.problems.add('folder_twice', TEXT.folder_twice);
      } else {
        tree.ensure([name], (path) => noteFolder(ctx, path));
        queue.push({ entry, segments: [name] });
      }
    } else if (kind === 'file') {
      ctx.input.topFiles++;
      addFile(ctx, tree, [], safeValue(() => entry.name), { type: 'entry', entry, fallback: item.file }, null);
    } else if (item.file) {
      ctx.input.topFiles++;
      const file = item.file;
      addFile(ctx, tree, [], safeValue(() => /** @type {any} */ (file).name), { type: 'file', file }, file.size);
    } else {
      skip(ctx, 'odd', ['(no name)'], 'file');
    }
  }

  let listed = 0;
  while (!ctx.full) {
    if (checkAbort(ctx)) break;
    const next = queue.shift();
    if (next === null) break;
    const { entry, segments } = next;
    const children = await readDirectory(entry, ctx);
    progress(ctx, 'listing', ++listed, null);
    const parent = tree.ensure(segments);
    for (const child of children) {
      const kind = entryKind(child);
      const rawName = safeValue(() => /** @type {any} */ (child).name);
      if (kind === 'folder') {
        const name = cleanName(rawName);
        if (name === null) {
          skip(ctx, 'name', [...segments, displayName(rawName)], 'folder');
          continue;
        }
        const path = [...segments, name];
        if (ignoredFolder(name)) skip(ctx, 'hidden', path, 'folder');
        else if (tree.hasName(parent, name)) skip(ctx, 'duplicate', path, 'folder');
        else if (path.length > ctx.limits.maxDepth) skip(ctx, 'deep', path, 'folder');
        else {
          tree.ensure(path, (p) => noteFolder(ctx, p));
          queue.push({ entry: child, segments: path });
        }
      } else if (kind === 'file') {
        addFile(ctx, tree, segments, rawName, { type: 'entry', entry: child, fallback: null }, null);
      } else {
        skip(ctx, 'odd', [...segments, displayName(rawName)], 'file');
      }
    }
  }
  ctx.listMs += now() - started;
}

/** @param {string} name  a folder name BaseCamp itself uses on the way to, or inside, a library */
function libraryLike(name) {
  const low = lower(name);
  return (
    low === 'garmin' ||
    low === 'basecamp' ||
    low === 'database' ||
    low === lower(TRACK_SEGMENTS) ||
    low.endsWith('.bclibrary') ||
    VERSION_RE.test(name)
  );
}

/**
 * Two first-in, first-out queues of folders still to list: library-like names first. Taken items are
 * dropped from memory as the walk goes.
 */
class WalkQueue {
  constructor() {
    /** @type {{entry: any, segments: string[]}[][]} */
    this.lanes = [[], []];
    this.heads = [0, 0];
  }

  /** @param {{entry: any, segments: string[]}} item */
  push(item) {
    this.lanes[libraryLike(item.segments[item.segments.length - 1]) ? 0 : 1].push(item);
  }

  /** @returns {{entry: any, segments: string[]}|null} */
  shift() {
    for (let k = 0; k < 2; k++) {
      const lane = this.lanes[k];
      if (this.heads[k] < lane.length) {
        const item = lane[this.heads[k]++];
        if (this.heads[k] >= 4096 && this.heads[k] * 2 >= lane.length) {
          lane.splice(0, this.heads[k]);
          this.heads[k] = 0;
        }
        return item;
      }
    }
    return null;
  }
}

/**
 * Every entry of a folder: readEntries is called until it returns an empty batch. Errors, timeouts and
 * odd answers end the listing of that folder (what was read so far is kept).
 * @param {any} entry
 * @param {Ctx} ctx
 * @returns {Promise<unknown[]>}
 */
async function readDirectory(entry, ctx) {
  /** @type {unknown[]} */
  const out = [];
  /** @type {any} */
  let reader = null;
  try {
    reader = entry.createReader();
  } catch {
    reader = null;
  }
  if (reader === null || typeof reader !== 'object' || typeof reader.readEntries !== 'function') {
    ctx.problems.add('folder_unreadable', TEXT.folder_unreadable);
    return out;
  }
  // A failure after some batches arrived leaves the folder half listed: what was listed is used, and the
  // problem says the listing stopped partway rather than that the folder was skipped.
  /** @param {"browser_no_answer"|"folder_unreadable"} code */
  const stopped = (code) => {
    if (out.length > 0) ctx.problems.add('folder_incomplete', TEXT.folder_incomplete);
    else ctx.problems.add(code, TEXT[code]);
  };
  for (;;) {
    if (checkAbort(ctx) || ctx.full) break;
    const result = await settle((ok, fail) => reader.readEntries(ok, fail), ctx);
    if (result.status === 'aborted') break;
    if (result.status === 'timeout') {
      stopped('browser_no_answer');
      break;
    }
    if (result.status !== 'ok') {
      stopped('folder_unreadable');
      break;
    }
    const batch = /** @type {any} */ (result.value);
    let shapeOk = false;
    try {
      shapeOk = batch !== null && typeof batch === 'object' && typeof batch.length === 'number';
    } catch {
      shapeOk = false;
    }
    if (!shapeOk) {
      stopped('folder_unreadable');
      break;
    }
    const length = safeLength(batch);
    if (length === 0) break;
    // Every entry counts against the limit, duplicates too, so a reader that never runs dry still stops.
    const take = countSeen(ctx, length);
    for (let i = 0; i < take; i++) {
      try {
        out.push(batch[i]);
      } catch {
        out.push(null);
      }
    }
    if (take < length) break;
  }
  return out;
}

/**
 * @param {ArrayLike<unknown>} list
 * @param {Tree} tree
 * @param {Ctx} ctx
 */
function collectFileList(list, tree, ctx) {
  const started = now();
  const length = safeLength(list);
  let relative = false;
  /** @type {Set<string>} */
  const topFolders = new Set();
  for (let i = 0; i < length; i++) {
    if (checkAbort(ctx) || ctx.full) break;
    if (countSeen(ctx, 1) < 1) break;
    /** @type {any} */
    let file = null;
    try {
      file = list[i];
    } catch {
      file = null;
    }
    if (!isBlobLike(file)) {
      skip(ctx, 'odd', ['(no name)'], 'file');
      continue;
    }
    const rel = safeString(() => file.webkitRelativePath);
    /** @type {string[]} */
    let segments;
    if (rel !== '') {
      relative = true;
      segments = rel.split('/').filter((s) => s !== '' && s !== '.');
    } else {
      segments = [safeString(() => file.name)];
    }
    if (segments.length > 1) topFolders.add(segments[0]);
    else ctx.input.topFiles++;
    addPathFile(ctx, tree, segments, { type: 'file', file }, file.size);
  }
  ctx.input.topFolders += topFolders.size;
  ctx.input.delivery = relative ? 'file-list' : length > 0 ? 'files' : 'none';
  ctx.listMs += now() - started;
}

/**
 * Opens a backup and looks for the library inside it.
 * @param {Blob} blob
 * @param {Ctx} ctx
 * @param {boolean} fromPackage  the browser handed a .bclibrary package over as this ZIP
 */
async function intakeArchive(blob, ctx, fromPackage) {
  const started = now();
  progress(ctx, 'backup', 0, null);
  let archive;
  try {
    archive = await openZip(blob, { maxEntries: ctx.limits.maxEntries, maxEntryBytes: ctx.limits.maxZipEntryBytes });
  } catch (error) {
    const code = error instanceof ZipReadError ? error.code : 'unknown';
    ctx.problems.add(`backup_${code}`, zipText(code));
    ctx.listMs += now() - started;
    return;
  }
  ctx.archive = blob;
  ctx.input.archiveEntries = archive.entries.length;
  ctx.input.archiveZip64 = archive.zip64;
  for (const p of archive.problems) ctx.notes.add(`backup_${p.code}`, p.message, p.count);
  if (fromPackage) ctx.notes.add('package_as_zip', TEXT.package_as_zip);

  const tree = new Tree();
  ctx.inArchive = true;
  const entries = archive.entries;
  for (let i = 0; i < entries.length; i++) {
    if (checkAbort(ctx) || ctx.full) break;
    if (countSeen(ctx, 1) < 1) break;
    const entry = entries[i];
    if (entry.name.includes('\\')) ctx.windows.add('backslash-names');
    const segments = entry.name.split(/[\\/]/).filter((s) => s !== '' && s !== '.');
    if (entry.unsafeName) {
      skip(ctx, 'name', segments.length ? segments.map(displayName) : ['(no name)'], entry.isDirectory ? 'folder' : 'file');
      continue;
    }
    if (entry.isDirectory) {
      if (segments.some((s) => cleanName(s) === null)) skip(ctx, 'name', segments.map(displayName), 'folder');
      else if (segments.some(ignoredFolder)) ctx.input.skipped++;
      else if (segments.length > ctx.limits.maxDepth) skip(ctx, 'deep', segments, 'folder');
      else tree.ensure(segments, (path) => noteFolder(ctx, path));
      continue;
    }
    if (entry.isSymlink) {
      skip(ctx, 'link', segments.map(displayName), 'file');
      continue;
    }
    addPathFile(ctx, tree, segments, { type: 'zip', entry, index: i }, entry.uncompressedSize >= 0 ? entry.uncompressedSize : null);
  }
  addTreeCounts(ctx, tree);
  ctx.listMs += now() - started;
  if (ctx.aborted) return;
  const located = await locateAndFill(tree, ctx, 'zip');
  if (!located && !ctx.aborted) ctx.problems.add('backup_no_library', TEXT.backup_no_library);
}

// ---------------------------------------------------------------------------------------------
// Statting

/**
 * Size and date of a file, without reading it. Cached on the node.
 * @param {FileNode} node
 * @param {Ctx} ctx
 * @returns {Promise<Stat>}
 */
async function statNode(node, ctx) {
  if (node.stat) return node.stat;
  /** @type {Stat} */
  let stat;
  const ref = node.ref;
  if (ref.type === 'zip') {
    const entry = ref.entry;
    if (entry.issue) stat = { ok: false, failure: `zip_${entry.issue}` };
    else if (entry.method === 8 && !ctx.inflateRaw) stat = { ok: false, failure: 'cannot_unzip_here' };
    else if (!(entry.uncompressedSize >= 0)) stat = { ok: false, failure: 'zip_bad_size' };
    else stat = { ok: true, size: entry.uncompressedSize, mtime: entry.modified, blob: null };
  } else if (ref.type === 'file') {
    stat = blobStat(ref.file);
  } else {
    const result = await settle((ok, fail) => ref.entry.file(ok, fail), ctx);
    if (result.status === 'ok' && isBlobLike(result.value)) stat = blobStat(/** @type {Blob} */ (result.value));
    else if (result.status === 'aborted') return { ok: false, failure: 'aborted' };
    else if (ref.fallback) stat = blobStat(ref.fallback);
    else stat = { ok: false, failure: result.status === 'timeout' ? 'no_answer' : 'unreadable' };
  }
  node.stat = stat;
  if (stat.ok) node.size = stat.size;
  return stat;
}

/**
 * @param {Blob} blob
 * @returns {Stat}
 */
function blobStat(blob) {
  const modified = /** @type {any} */ (blob).lastModified;
  return { ok: true, size: blob.size, mtime: Number.isFinite(modified) ? modified : null, blob };
}

/**
 * Sizes for the probe's listing (stat only, never a read).
 * @param {Ctx} ctx
 */
async function statListing(ctx) {
  const started = now();
  /** @type {FileNode[]} */
  const nodes = [];
  for (const row of ctx.rows) if (row.node && row.node.size === null && row.node.stat === null) nodes.push(row.node);
  let done = 0;
  await pool(
    nodes,
    ctx.limits.statConcurrency,
    async (node) => {
      await statNode(node, ctx);
      if (++done % 64 === 0) progress(ctx, 'stat', done, nodes.length);
    },
    ctx,
  );
  ctx.statMs += now() - started;
}

/**
 * Reports why a needed file cannot be used.
 * @param {Ctx} ctx
 * @param {"allData"|"folderData"|"trackSegment"} role
 * @param {string} failure
 * @param {number} [limit]  the size limit, for "too_large"
 */
function addFailure(ctx, role, failure, limit) {
  const r = ROLE[role];
  if (failure === 'aborted') return;
  if (failure === 'cannot_unzip_here') {
    ctx.problems.add('cannot_unzip_here', TEXT.cannot_unzip_here);
    return;
  }
  if (failure === 'zip_encrypted') {
    ctx.problems.add('backup_encrypted', `The backup is password-protected, which this tool cannot read. ${r.effect}`);
    return;
  }
  if (failure === 'zip_too_large') {
    ctx.problems.add(
      `${r.code}_too_large`,
      `${r.label} inside the backup ${r.isAre} larger than ${formatBytes(ctx.limits.maxZipEntryBytes)}, more than can ` +
        `be read from a backup. Unzip the backup in Finder and drop the folder that appears instead. ${r.effect}`,
    );
    return;
  }
  if (failure.startsWith('zip_')) {
    ctx.problems.add(`${r.code}_damaged`, `${r.label} inside the backup ${r.isAre} damaged or stored in a way this tool cannot read. ${r.effect}`);
    return;
  }
  if (failure === 'empty') ctx.problems.add(`${r.code}_empty`, `${r.label} ${r.isAre} empty (0 bytes). ${r.effect}`);
  else if (failure === 'too_small') ctx.problems.add(`${r.code}_too_small`, `${r.label} ${r.isAre} too small to be a BaseCamp library file. ${r.effect}`);
  else if (failure === 'too_large') {
    ctx.problems.add(`${r.code}_too_large`, `${r.label} ${r.isAre} larger than ${formatBytes(limit ?? 0)}, more than this tool can read. ${r.effect}`);
  } else ctx.problems.add(`${r.code}_unreadable`, `${r.label} could not be opened by the browser. ${r.effect}`);
}

// ---------------------------------------------------------------------------------------------
// Finding the library

/**
 * @typedef {object} Candidate
 * @property {DirNode} dir
 * @property {FileNode} allData
 * @property {number} variants
 * @property {number[]|null} version
 * @property {string|null} versionText
 * @property {boolean} layout  sits where BaseCamp puts a library (see inLibraryLayout)
 * @property {number} completeness
 * @property {boolean} usable
 * @property {string|null} verdict  why AllData.gdb cannot be used
 * @property {number|null} mtime
 */

/**
 * Finds every folder holding an AllData.gdb, picks one, and fills ctx.found from it.
 * @param {Tree} tree
 * @param {Ctx} ctx
 * @param {"file"|"zip"} origin
 * @returns {Promise<boolean>}  whether any such folder exists
 */
async function locateAndFill(tree, ctx, origin) {
  /** @type {Candidate[]} */
  const candidates = [];
  let extra = 0;
  for (const dir of tree.dirs.values()) {
    const picked = tree.pick(dir, ALL_DATA);
    if (!picked) continue;
    if (candidates.length >= ctx.limits.maxCandidates) {
      extra++;
      continue;
    }
    const version = versionOf(dir.segments);
    candidates.push({
      dir,
      allData: picked.node,
      variants: picked.variants,
      version,
      versionText: version ? dir.segments[dir.segments.length - 1] : null,
      layout: inLibraryLayout(dir.segments),
      completeness: (tree.pick(dir, FOLDER_DATA) ? 2 : 0) + (tree.subdir(dir, TRACK_SEGMENTS) ? 1 : 0),
      usable: false,
      verdict: null,
      mtime: null,
    });
  }
  ctx.input.libraryFolders += candidates.length + extra;
  if (extra > 0) {
    ctx.notes.add(
      'too_many_libraries',
      `More than ${ctx.limits.maxCandidates} folders hold an AllData.gdb; only the first ${ctx.limits.maxCandidates} were compared.`,
    );
  }
  if (candidates.length === 0) return false;

  const statStarted = now();
  await pool(
    candidates,
    ctx.limits.statConcurrency,
    async (c) => {
      const stat = await statNode(c.allData, ctx);
      c.verdict = allDataVerdict(stat, ctx);
      c.usable = c.verdict === null;
      c.mtime = stat.ok ? stat.mtime : null;
    },
    ctx,
  );
  ctx.statMs += now() - statStarted;
  if (checkAbort(ctx)) return true;

  candidates.sort(compareCandidates);
  const chosen = candidates[0];
  const found = ctx.found;
  found.versionFolder = chosen.dir.segments.join('/');
  found.version = chosen.versionText;
  ctx.input.kind =
    origin === 'zip'
      ? 'zip'
      : chosen.dir.segments.some((s) => lower(s).endsWith('.bclibrary'))
        ? 'package'
        : chosen.dir.segments.length === 0
          ? 'files'
          : 'folder';

  if (!chosen.usable) {
    addFailure(ctx, 'allData', chosen.verdict ?? 'unreadable', ctx.limits.maxAllDataBytes);
    return true;
  }
  if (chosen.variants > 1) ctx.problems.add('case_variant', TEXT.case_variant);
  found.allData = makeHandle(chosen.allData, ctx);
  chosen.allData.role = 'allData';
  noteChoice(candidates, ctx);
  await fillCompanions(tree, chosen.dir, ctx);
  return true;
}

/**
 * @param {string[]} segments  a library folder's path
 * @returns {number[]|null}  its name as a version number, when it is one
 */
function versionOf(segments) {
  const name = segments.length ? segments[segments.length - 1] : '';
  return VERSION_RE.test(name) ? name.split('.').map(Number) : null;
}

/**
 * Whether a library folder sits where BaseCamp puts one: in a Database folder (any spelling), directly in a
 * .bclibrary package (its layout is not known yet), or given itself (loose files, or the top level of the drop
 * or of the backup). A folder elsewhere that only looks like a version (an unrelated app's "Cache/12.25", a copy
 * a user named "10.5") must not beat the real Database/4.8 just because its number is higher.
 * @param {string[]} segments
 */
function inLibraryLayout(segments) {
  if (segments.length <= 1) return true;
  const parent = lower(segments[segments.length - 2]);
  return parent === 'database' || parent.endsWith('.bclibrary');
}

/**
 * @param {Stat} stat
 * @param {Ctx} ctx
 * @returns {string|null}
 */
function allDataVerdict(stat, ctx) {
  if (!stat.ok) return stat.failure;
  if (stat.size === 0) return 'empty';
  if (stat.size < MIN_LIBRARY_FILE) return 'too_small';
  if (stat.size > ctx.limits.maxAllDataBytes) return 'too_large';
  return null;
}

/**
 * Positive when `a` is the newer version; a folder without a version number is the oldest.
 * @param {number[]|null} a
 * @param {number[]|null} b
 */
function versionCmp(a, b) {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? -1;
    const y = b[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Usable first, then one in BaseCamp's layout, then the highest version number, then the most complete
 * (FolderData.gfi, TrackSegments), then the most recently changed AllData.gdb, then the order the browser
 * delivered them in.
 * @param {Candidate} a
 * @param {Candidate} b
 */
function compareCandidates(a, b) {
  if (a.usable !== b.usable) return a.usable ? -1 : 1;
  if (a.layout !== b.layout) return a.layout ? -1 : 1;
  const v = versionCmp(b.version, a.version);
  if (v !== 0) return v;
  if (a.completeness !== b.completeness) return b.completeness - a.completeness;
  const am = a.mtime ?? -Infinity;
  const bm = b.mtime ?? -Infinity;
  if (am !== bm) return bm > am ? 1 : -1;
  return a.dir.order - b.dir.order;
}

/**
 * Tells the user which of several libraries or versions was used.
 * @param {Candidate[]} candidates  sorted, the chosen one first and usable
 * @param {Ctx} ctx
 */
function noteChoice(candidates, ctx) {
  if (candidates.length < 2) return;
  const chosen = candidates[0];
  // A version-like folder outside BaseCamp's layout ("Cache/12.25") is not called the newer version of a
  // library in its place; one in its place still is, even when a copy from elsewhere had to be used.
  const newer = candidates.filter(
    (c) => !c.usable && (c.layout || !chosen.layout) && versionCmp(c.version, chosen.version) > 0,
  );
  if (newer.length > 0) {
    const list = versionList(newer);
    const phrase = /** @type {Record<string, string>} */ (REASON_PHRASE)[newer[0].verdict ?? ''] ?? 'it could not be read';
    ctx.problems.add(
      'newer_version_unusable',
      `The newer version folder ${list} holds an AllData.gdb that cannot be used (${phrase}), so ` +
        `${chosen.versionText ? `the older version ${chosen.versionText}` : 'another copy of the library'} was used ` +
        'instead. Its data may be out of date.',
    );
  }
  const parentOf = (/** @type {Candidate} */ c) => keyOf(c.dir.segments.slice(0, -1));
  const sameParent = candidates.every((c) => parentOf(c) === parentOf(chosen));
  if (sameParent && candidates.every((c) => c.versionText !== null)) {
    ctx.notes.add(
      'several_versions',
      `Several versions of the library were found (${versionList(candidates)}). Version ${chosen.versionText} was ` +
        'used; the others were not read.',
    );
  } else {
    ctx.notes.add(
      'several_libraries',
      `${candidates.length} libraries were found. One in a Database folder was preferred, then the highest version ` +
        'number (for equal versions: the most complete, then the most recently changed). To convert another, give ' +
        'it on its own.',
    );
  }
}

/**
 * Version numbers of candidates, oldest first, for a message.
 * @param {Candidate[]} candidates
 */
function versionList(candidates) {
  /** @type {Candidate[]} */
  const versioned = [];
  for (const c of candidates) if (c.versionText !== null && !versioned.some((v) => v.versionText === c.versionText)) versioned.push(c);
  versioned.sort((a, b) => versionCmp(a.version, b.version));
  const shown = versioned.slice(0, 8).map((c) => c.versionText);
  if (versioned.length > 8) shown.push(`and ${versioned.length - 8} more`);
  return shown.length ? shown.join(', ') : 'without a version number';
}

/**
 * FolderData.gfi and TrackSegments next to the chosen AllData.gdb.
 * @param {Tree} tree
 * @param {DirNode} dir
 * @param {Ctx} ctx
 */
async function fillCompanions(tree, dir, ctx) {
  const found = ctx.found;
  const started = now();
  const folderData = tree.pick(dir, FOLDER_DATA);
  if (!folderData) ctx.problems.add('no_folder_data', TEXT.no_folder_data);
  else {
    if (folderData.variants > 1) ctx.problems.add('case_variant', TEXT.case_variant);
    const stat = await statNode(folderData.node, ctx);
    if (!stat.ok) addFailure(ctx, 'folderData', stat.failure);
    else if (stat.size === 0) addFailure(ctx, 'folderData', 'empty');
    else if (stat.size > ctx.limits.maxFolderDataBytes) addFailure(ctx, 'folderData', 'too_large', ctx.limits.maxFolderDataBytes);
    else {
      found.folderData = makeHandle(folderData.node, ctx);
      folderData.node.role = 'folderData';
    }
  }

  const segmentsDir = tree.subdir(dir, TRACK_SEGMENTS);
  if (!segmentsDir) {
    ctx.problems.add('no_track_segments', TEXT.no_track_segments);
    ctx.statMs += now() - started;
    return;
  }
  let nodes = Array.from(segmentsDir.files.values());
  if (nodes.length > ctx.limits.maxTrackSegments) {
    ctx.problems.add(
      'too_many_track_segments',
      `TrackSegments holds more than ${formatCount(ctx.limits.maxTrackSegments)} files; only the first ` +
        `${formatCount(ctx.limits.maxTrackSegments)} were used. The other tracks keep their positions but lose elevation and time.`,
    );
    nodes = nodes.slice(0, ctx.limits.maxTrackSegments);
  }
  let done = 0;
  await pool(
    nodes,
    ctx.limits.statConcurrency,
    async (node) => {
      await statNode(node, ctx);
      if (++done % 64 === 0) progress(ctx, 'stat', done, nodes.length);
    },
    ctx,
  );
  if (checkAbort(ctx)) return;
  const roles = ctx.input.roles;
  for (const node of nodes) {
    const stat = node.stat;
    if (!stat) continue;
    if (!stat.ok) {
      addFailure(ctx, 'trackSegment', stat.failure);
      continue;
    }
    if (stat.size > ctx.limits.maxTrackSegmentBytes) {
      addFailure(ctx, 'trackSegment', 'too_large', ctx.limits.maxTrackSegmentBytes);
      continue;
    }
    // Empty files are kept: the TrackSegments reader reports them per track.
    if (stat.size === 0) roles.trackSegmentsEmpty++;
    if (!UUID_RE.test(node.name)) roles.trackSegmentsOtherNames++;
    found.trackSegments.set(node.name, makeHandle(node, ctx));
    node.role = 'trackSegment';
  }
  ctx.statMs += now() - started;
}

/**
 * @param {Tree} tree
 * @param {Ctx} ctx
 */
function noteIgnoredBackups(tree, ctx) {
  let n = 0;
  for (const node of tree.root.files.values()) {
    const ext = extensionOf(node.name);
    if (ext === 'backup' || ext === 'zip') n++;
  }
  if (n > 0 && !ctx.inArchive) ctx.notes.add('ignored_backups', TEXT.ignored_backups, n);
}

/**
 * Nothing was found by name: open a single backup if one was given, or explain what was given instead.
 * @param {Tree} tree
 * @param {Ctx} ctx
 */
async function explainOrOpenBackup(tree, ctx) {
  /** @type {FileNode[]} */
  const zips = [];
  let unreadablePackages = 0;
  let unreadableOther = 0;
  let notZip = 0;
  let emptyBackups = 0;
  let exported = 0;
  if (ctx.sniff) {
    // Backup-like names are looked at first, so a backup among many other loose files is not passed over.
    /** @param {FileNode} node */
    const rank = (node) => {
      const ext = extensionOf(node.name);
      return ext === 'backup' || ext === 'zip' ? 0 : ext === 'bclibrary' || ext === '' ? 1 : 2;
    };
    const toSniff = Array.from(tree.root.files.values())
      .filter((node) => !['gdb', 'gfi', 'gpx'].includes(extensionOf(node.name)))
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, ctx.limits.maxSniff);
    for (const node of toSniff) {
      if (checkAbort(ctx)) return;
      const kind = await sniffNode(node, ctx);
      const ext = extensionOf(node.name);
      const backupName = ext === 'backup' || ext === 'zip';
      if (kind === 'zip') zips.push(node);
      else if (kind === 'gdb') exported++;
      else if (kind === 'unreadable' || (kind === 'empty' && (ext === 'bclibrary' || ext === ''))) {
        if (ext === 'bclibrary') unreadablePackages++;
        else unreadableOther++;
      } else if (kind === 'empty' && backupName) emptyBackups++;
      else if (kind === 'other' && backupName) notZip++;
    }
  } else {
    // No byte is looked at: a backup is recognised by its name only.
    for (const node of tree.root.files.values()) {
      const ext = extensionOf(node.name);
      if (ext !== 'backup' && ext !== 'zip') continue;
      const stat = await statNode(node, ctx);
      if (stat.ok && stat.blob) zips.push(node);
      else unreadableOther++;
    }
  }
  if (zips.length === 1) {
    const stat = zips[0].stat;
    if (stat && stat.ok && stat.blob) {
      await intakeArchive(stat.blob, ctx, extensionOf(zips[0].name) === 'bclibrary');
      return;
    }
  }
  if (zips.length > 1) {
    ctx.problems.add('several_backups', TEXT.several_backups);
    return;
  }

  let explained = false;
  /** @param {string} code @param {string} message @param {number} n */
  const explain = (code, message, n) => {
    if (n <= 0) return;
    ctx.problems.add(code, message, n);
    explained = true;
  };
  explain('package_as_file', TEXT.package_as_file, unreadablePackages);
  explain('folder_as_file', TEXT.folder_as_file, unreadableOther);
  explain('backup_empty_file', ZIP_TEXT.empty_file, emptyBackups);
  explain('backup_not_zip', ZIP_TEXT.not_zip, notZip);

  let folderData = 0;
  let gpx = 0;
  let nested = 0;
  for (const dir of tree.dirs.values()) {
    for (const node of dir.files.values()) {
      const name = lower(node.name);
      const ext = extensionOf(node.name);
      if (name === 'folderdata.gfi') folderData++;
      else if (ext === 'gdb') exported++;
      else if (ext === 'gpx') gpx++;
      else if ((ext === 'backup' || ext === 'zip') && dir.segments.length > 0) nested++;
    }
  }
  explain('exported_gdb', TEXT.exported_gdb, exported);
  explain('gpx_given', TEXT.gpx_given, gpx);
  explain('no_all_data', TEXT.no_all_data, folderData);
  explain('backup_inside_folder', TEXT.backup_inside_folder, nested);
  if (!explained) {
    if (tree.fileCount === 0 && tree.folderCount === 0 && ctx.input.skipped === 0) {
      ctx.problems.add('nothing_dropped', TEXT.nothing_dropped);
    } else {
      ctx.problems.add('no_library', TEXT.no_library);
    }
  }
}

/**
 * Looks at the first 4 bytes of a top-level loose file.
 * @param {FileNode} node
 * @param {Ctx} ctx
 * @returns {Promise<"zip"|"gdb"|"empty"|"unreadable"|"other">}
 */
async function sniffNode(node, ctx) {
  const stat = await statNode(node, ctx);
  if (!stat.ok || !stat.blob) return 'unreadable';
  if (stat.size === 0) return 'empty';
  const blob = stat.blob;
  const result = await settle((ok, fail) => {
    blob.slice(0, 4).arrayBuffer().then(ok, fail);
  }, ctx);
  if (result.status !== 'ok' || !isArrayBuffer(result.value)) return 'unreadable';
  const b = new Uint8Array(/** @type {ArrayBuffer} */ (result.value));
  if (b.length < 4) return 'other';
  if (b[0] === 0x50 && b[1] === 0x4b && ((b[2] === 3 && b[3] === 4) || (b[2] === 5 && b[3] === 6))) return 'zip';
  if (b[0] === 0x4d && b[1] === 0x73 && b[2] === 0x52 && b[3] === 0x63) return 'gdb';
  return 'other';
}

// ---------------------------------------------------------------------------------------------
// Handles

/**
 * @param {FileNode} node  statted, ok
 * @param {Ctx} ctx
 * @returns {SourceFile}
 */
function makeHandle(node, ctx) {
  const stat = /** @type {{ok: true, size: number, mtime: number|null, blob: Blob|null}} */ (node.stat);
  const path = [...node.segments, node.name].join('/');
  if (node.ref.type === 'zip') {
    return zipHandle(node.ref.entry, node.ref.index, ctx.archive, node.name, path, stat.size, stat.mtime);
  }
  return fileHandle(/** @type {Blob} */ (stat.blob), node.name, path, stat.mtime);
}

/**
 * @param {Blob} blob
 * @param {string} name
 * @param {string} path
 * @param {number|null} lastModified
 * @returns {SourceFile}
 */
function fileHandle(blob, name, path, lastModified) {
  const size = blob.size;
  return {
    name,
    path,
    size,
    lastModified: Number.isFinite(lastModified) ? lastModified : null,
    origin: 'file',
    blob,
    zip: null,
    bytes: (start = 0, end = size) => readBlobRange(blob, size, start, end),
    release() {},
  };
}

/**
 * @param {Blob} blob
 * @param {number} size
 * @param {number} start
 * @param {number} end
 * @returns {Promise<Uint8Array>}
 */
async function readBlobRange(blob, size, start, end) {
  const [s, e] = clampRange(start, end, size);
  if (e === s) return new Uint8Array(0);
  let buffer;
  try {
    buffer = await blob.slice(s, e).arrayBuffer();
  } catch {
    throw new SourceReadError('read_failed', TEXT.read_failed);
  }
  if (!isArrayBuffer(buffer) || buffer.byteLength !== e - s) throw new SourceReadError('changed', TEXT.changed);
  return new Uint8Array(buffer);
}

/**
 * @param {import('../format/unzip.js').ZipEntry} entry
 * @param {number} index
 * @param {Blob|null} archive
 * @param {string} name
 * @param {string} path
 * @param {number} size
 * @param {number|null} lastModified
 * @returns {SourceFile}
 */
function zipHandle(entry, index, archive, name, path, size, lastModified) {
  /** @type {Promise<Uint8Array>|null} */
  let kept = null;
  return {
    name,
    path,
    size,
    lastModified: Number.isFinite(lastModified) ? lastModified : null,
    origin: 'zip',
    blob: null,
    zip: archive ? { archive, index, entryName: entry.name } : null,
    async bytes(start = 0, end = size) {
      const [s, e] = clampRange(start, end, size);
      if (kept === null) kept = Promise.resolve().then(() => entry.read());
      /** @type {Uint8Array} */
      let all;
      try {
        all = await kept;
      } catch (error) {
        kept = null;
        throw zipReadFailure(error);
      }
      return all.subarray(Math.min(s, all.length), Math.min(e, all.length));
    },
    release() {
      kept = null;
    },
  };
}

/**
 * @param {unknown} error
 * @returns {SourceReadError}
 */
function zipReadFailure(error) {
  const code = error instanceof ZipReadError ? error.code : '';
  if (code === 'unsupported_runtime') return new SourceReadError('unsupported_runtime', TEXT.cannot_unzip_here);
  if (code === 'limit_exceeded' || code === 'out_of_memory' || code === 'too_large') {
    return new SourceReadError('too_large', TEXT.zip_too_large);
  }
  if (code === 'read_failed' || code === '') return new SourceReadError('read_failed', TEXT.read_failed);
  return new SourceReadError('damaged', TEXT.zip_damaged);
}

/**
 * @param {unknown} start
 * @param {unknown} end
 * @param {number} size
 * @returns {[number, number]}
 */
function clampRange(start, end, size) {
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start
  ) {
    throw new SourceReadError('bad_range', TEXT.bad_range);
  }
  return [Math.min(start, size), Math.min(end, size)];
}

// ---------------------------------------------------------------------------------------------
// Small helpers

/** @returns {number} */
function now() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

/** @param {unknown} value */
function isBlobLike(value) {
  if (value === null || typeof value !== 'object') return false;
  if (typeof Blob === 'function' && value instanceof Blob) return true;
  const v = /** @type {any} */ (value);
  try {
    return Number.isSafeInteger(v.size) && v.size >= 0 && typeof v.slice === 'function';
  } catch {
    return false;
  }
}

/** @param {unknown} value */
function isArrayBuffer(value) {
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]';
}

/** @param {unknown} value */
function isSourceFile(value) {
  const v = /** @type {any} */ (value);
  return v !== null && typeof v === 'object' && typeof v.bytes === 'function' && (v.origin === 'file' || v.origin === 'zip');
}

/** @param {unknown} value */
function isWorkerRef(value) {
  const v = /** @type {any} */ (value);
  return v !== null && typeof v === 'object' && typeof v.name === 'string' && typeof v.path === 'string';
}

/** @param {unknown} value */
function isDropCapture(value) {
  const v = /** @type {any} */ (value);
  return v !== null && typeof v === 'object' && v.captured === true && Array.isArray(v.items);
}

/** @param {unknown} value */
function isDataTransferLike(value) {
  if (value === null || typeof value !== 'object') return false;
  if (typeof DataTransfer === 'function' && value instanceof DataTransfer) return true;
  return 'types' in value && ('items' in value || 'files' in value);
}

/** @param {unknown} value */
function isListLike(value) {
  if (Array.isArray(value)) return true;
  if (typeof FileList === 'function' && value instanceof FileList) return true;
  return value !== null && typeof value === 'object' && safeLength(value) > 0;
}

/**
 * @param {unknown} value
 * @returns {number}  a usable length, or 0
 */
function safeLength(value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return 0;
  try {
    const n = /** @type {any} */ (value).length;
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * @param {() => unknown} get
 * @returns {string}
 */
function safeString(get) {
  try {
    const v = get();
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

/**
 * @param {() => unknown} get
 * @returns {unknown}
 */
function safeValue(get) {
  try {
    return get();
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} entry
 * @returns {"folder"|"file"|"other"|"none"}
 */
function entryKind(entry) {
  if (entry === null || entry === undefined) return 'none';
  if (typeof entry !== 'object') return 'other';
  try {
    const e = /** @type {any} */ (entry);
    if (e.isDirectory === true && typeof e.createReader === 'function') return 'folder';
    if (e.isFile === true && typeof e.file === 'function') return 'file';
  } catch {
    // fall through
  }
  return 'other';
}

/**
 * @param {string} kind
 * @param {string} type
 * @param {any} entry
 * @param {any} file
 * @returns {DropItemInfo}
 */
function itemInfo(kind, type, entry, file) {
  const name = safeValue(() => entry?.name);
  const fullPath = safeValue(() => entry?.fullPath);
  const fileName = safeValue(() => file?.name);
  const fileSize = safeValue(() => file?.size);
  return {
    kind,
    type,
    entry: entryKind(entry),
    name: typeof name === 'string' ? name : null,
    fullPath: typeof fullPath === 'string' ? fullPath : null,
    fileName: typeof fileName === 'string' ? fileName : null,
    fileSize: typeof fileSize === 'number' && Number.isFinite(fileSize) ? fileSize : null,
    fileType: file ? safeString(() => file.type) : null,
  };
}

/** @param {string} code */
function zipText(code) {
  return /** @type {Record<string, string>} */ (ZIP_TEXT)[code] ?? ZIP_TEXT.unknown;
}

/** @param {number} n */
function formatCount(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Decimal units, as Finder shows them.
 * @param {number} n
 */
function formatBytes(n) {
  /** @param {number} x */
  const one = (x) => String(Math.round(x * 10) / 10);
  if (n >= 1e9) return `${one(n / 1e9)} GB`;
  if (n >= 1e6) return `${one(n / 1e6)} MB`;
  if (n >= 1e3) return `${one(n / 1e3)} KB`;
  return `${n} bytes`;
}
