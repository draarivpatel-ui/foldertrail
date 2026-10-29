// Assembles the neutral Library model (src/model.js) from a located BaseCamp library (FORMAT.md §3-§11).
//
// Order of work: FolderData.gfi first (small; the tree), then AllData.gdb record by record (items), then the routes'
// via points, then TrackSegments one file at a time (elevation and time), then the links from the tree's references
// to the items (§10). Every step counts what it could not do; nothing here throws for bad data, and an unexpected
// failure inside one record is counted and skipped.
//
// Memory: AllData.gdb and FolderData.gfi are read whole (container.js frames records as views over the file) through
// SourceFile.bytes() in 16 MiB windows into one buffer, under a size cap. Track positions are kept packed (an
// Int32Array per track, plus Float64Arrays for elevation and time); a track's `segments` property builds Point
// objects on each read and does not keep them, so a library of millions of points stays small until it is written.
// TrackSegments files are read and released one at a time.
//
// Privacy: names and comments go only into the Library (the user's own export and report). Problems carry codes,
// counts and fixed plain-words messages, never a name, coordinate, time or path.

import { readContainer } from './container.js';
import { parseWaypoint, parseTrack, parseRoute, materialiseSegments, colorName, Counts } from './gdb.js';
import { parseFolderData, buildTree, SMART_LIST } from './gfi.js';
import { parseTrackSegments, matchTrackSegments } from './tracksegments.js';

/** @typedef {import('../model.js').Library} Library */
/** @typedef {import('../model.js').Item} Item */
/** @typedef {import('../model.js').Waypoint} Waypoint */
/** @typedef {import('../model.js').Track} Track */
/** @typedef {import('../model.js').Route} Route */
/** @typedef {import('../model.js').Folder} Folder */
/** @typedef {import('../model.js').Problem} Problem */
/** @typedef {import('../model.js').NotConverted} NotConverted */
/** @typedef {import('../app/intake.js').SourceFile} SourceFile */

const WINDOW = 16 * 2 ** 20;

/** @type {Readonly<Required<ReadLimits>>} */
export const DEFAULT_READ_LIMITS = Object.freeze({
  maxAllDataBytes: 2 ** 30, // 1 GiB: read whole; a GUESS at what a browser tab can hold alongside the export
  maxFolderDataBytes: 256 * 2 ** 20,
  maxTrackSegmentBytes: 256 * 2 ** 20,
  dumpTrackSegmentBytes: 32 * 2 ** 20, // TrackSegments bytes kept for the structure dump; the rest go in as sizes
});

/**
 * @typedef {object} ReadLimits
 * @property {number} [maxAllDataBytes]
 * @property {number} [maxFolderDataBytes]
 * @property {number} [maxTrackSegmentBytes]
 * @property {number} [dumpTrackSegmentBytes]
 */

/**
 * @typedef {object} ReadOptions
 * @property {ReadLimits} [limits]
 * @property {(progress: {phase: "reading"|"parsing"|"linking", done: number, total: number}) => void} [onProgress]
 */

/**
 * The located library, as intake.js finds it (only these fields are used).
 * @typedef {object} LibrarySource
 * @property {SourceFile|null} allData
 * @property {SourceFile|null} folderData
 * @property {Map<string, SourceFile>} [trackSegments]
 */

/**
 * @typedef {object} DuplicateGroup
 * @property {"waypoint"|"track"|"route"} kind
 * @property {string} name
 * @property {number|null} cls       waypoint class (null for tracks and routes); never shown to the user
 * @property {string[]} itemIds      the copies that were converted (they go to _Duplicate names)
 * @property {number} copies         records with this key, converted or not
 * @property {string[]} listIds      the lists that named it
 */

/**
 * @typedef {object} ReadDetails
 * @property {{code: string, message: string}|null} fatal  why nothing could be converted, when that is the case
 * @property {boolean} experimental     the 'D' version is outside the supported 188 (FORMAT.md §4)
 * @property {{gdb: number|null, gfi: number|null, program: number|null}} versions  raw u16 values (diagnostic)
 * @property {string|null} application  "BaseCamp", "MapSource", "HomePort" or "other"
 * @property {DuplicateGroup[]} duplicates  duplicate link keys that a list named (§10)
 * @property {number} multiListItems
 * @property {Map<string, "attached"|"missing"|"not_decoded"|"mismatch"|"unreadable">} elevationTime  per track id
 */

/**
 * What the structure dump needs (src/format/dump.js buildDump input). Drop it once the dump is built: the container
 * results hold views over the whole files.
 * @typedef {object} ReadDiagnostics
 * @property {import('./container.js').ContainerResult|null} allData
 * @property {import('./container.js').ContainerResult|null} folderData
 * @property {Array<Uint8Array|{size: number}>|null} trackSegments
 */

/**
 * @typedef {object} ReadResult
 * @property {Library} library
 * @property {ReadDetails} details
 * @property {ReadDiagnostics} diagnostics
 */

// ---------------------------------------------------------------------------------------------
// Problems: every code this module reports, with its plain words and where it is shown.

/** @type {Readonly<Record<string, {level: "report"|"dump", message: string}>>} */
export const LIBRARY_PROBLEMS = Object.freeze({
  // Whole files
  not_a_library_file: {
    level: 'report',
    message: "This isn't a BaseCamp library this tool can read: its main file (AllData.gdb) is not in BaseCamp's library format, so nothing could be read from it.",
  },
  unreadable_file_header: {
    level: 'report',
    message: "The start of the library's main file (AllData.gdb) could not be read, so nothing could be read from it.",
  },
  exported_file_not_library: {
    level: 'report',
    message:
      'AllData.gdb is in the exchange format that MapSource and File › Export write, not the library format. It holds no folders or lists, so it was not converted.',
  },
  unsupported_version: {
    level: 'report',
    message: 'AllData.gdb is in a library format version this tool cannot read, so nothing was converted.',
  },
  experimental_version: {
    level: 'report',
    message:
      'This library is in a format version this tool was not built for. It was read with strict checks, but treat the result as experimental and compare it with BaseCamp.',
  },
  all_data_too_large: {
    level: 'report',
    message: 'AllData.gdb is larger than 1 GB, which is more than this tool can read in a browser tab. Nothing was converted.',
  },
  read_failed: {
    level: 'report',
    message: 'A library file could not be read. It may have been moved or changed while this page was open; give it again.',
  },
  record_truncated: {
    level: 'report',
    message: 'AllData.gdb ends in the middle of a record, so it looks cut short. Everything before that point was read.',
  },
  record_too_large: { level: 'report', message: 'Some records in AllData.gdb were too large to read and were skipped.' },
  too_many_records: { level: 'report', message: 'AllData.gdb holds more records than this tool reads. The rest were skipped.' },
  data_after_end_record: { level: 'report', message: 'AllData.gdb continues after its end-of-file mark. Those bytes were not read.' },
  unknown_record_type: {
    level: 'report',
    message: 'Some records in AllData.gdb are of a kind this tool does not know. They were counted and skipped.',
  },
  internal_error: {
    level: 'report',
    message: 'Something unexpected went wrong while reading part of the library. That part was skipped; the rest was read.',
  },
  // FolderData.gfi
  no_folder_data: {
    level: 'report',
    message:
      'FolderData.gfi was not found, so your folders and lists could not be rebuilt. Items are saved grouped by type instead.',
  },
  folder_data_unreadable: {
    level: 'report',
    message:
      'FolderData.gfi could not be read, so your folders and lists could not be rebuilt. Items are saved grouped by type instead.',
  },
  folder_data_truncated: {
    level: 'report',
    message: 'Part of FolderData.gfi could not be read (it looks cut short or damaged). Folders, lists and list entries in that part are missing.',
  },
  folder_data_version_differs: {
    level: 'report',
    message: 'FolderData.gfi and AllData.gdb have different format versions. They may not belong together; check your lists.',
  },
  folder_record_unreadable: { level: 'report', message: 'Some folders in FolderData.gfi could not be read and were skipped.' },
  name_shortened: {
    level: 'report',
    message: 'Some folder or list names were longer than 255 characters and were shortened (they end in "…").',
  },
  list_record_unreadable: { level: 'report', message: 'Some lists in FolderData.gfi could not be read and were skipped.' },
  reference_unreadable: { level: 'report', message: 'Some list entries in FolderData.gfi could not be read and were skipped.' },
  duplicate_id: { level: 'report', message: 'Some folders or lists in FolderData.gfi share an ID with another. Only the first was used.' },
  root_missing: { level: 'report', message: 'FolderData.gfi has no top folder, so one named "My Collection" was added.' },
  list_folder_disagreement: {
    level: 'report',
    message: 'For some lists, FolderData.gfi names two different folders. The folder that lists them was used.',
  },
  smart_lists_left_out: {
    level: 'report',
    message:
      'BaseCamp\'s smart lists (such as "Last Week" and "Last Month") were not saved as lists, because BaseCamp fills them by itself from your other items. Their items are saved in your own lists, or in "Not in any list".',
  },
  list_not_in_tree: {
    level: 'report',
    message: 'Some lists could not be reached from the top folder. They were placed directly in the top folder.',
  },
  folder_in_two_places: {
    level: 'report',
    message: 'Some folders or lists appear inside more than one folder. Each was kept in the first.',
  },
  folder_not_in_tree: {
    level: 'report',
    message: 'Some folders could not be reached from the top folder and were left out. Their lists were placed in the top folder.',
  },
  tree_too_deep: {
    level: 'report',
    message: 'Folders nested more than 64 levels deep were left out. Their lists were placed in the top folder.',
  },
  reference_to_unknown_list: {
    level: 'report',
    message: 'Some list entries belong to a list that is not in FolderData.gfi. Those items are in "Not in any list".',
  },
  not_converted_kind: {
    level: 'report',
    message: 'The library also holds things this tool does not convert, such as BirdsEye imagery, map sections or images. They were counted and skipped.',
  },
  // Items
  waypoint_not_decoded: { level: 'report', message: 'Some waypoints could not be read and were not converted.' },
  waypoint_details_not_decoded: {
    level: 'report',
    message: 'Some waypoints were converted without elevation and time, because the end of their record did not match a known layout.',
  },
  waypoint_several_layouts: {
    level: 'report',
    message: 'Some waypoints were converted without elevation and time, because their record matched more than one layout and this tool does not guess.',
  },
  waypoint_class_not_exported: {
    level: 'report',
    message: 'Some waypoint records are of a kind this tool does not convert. They were counted and left out.',
  },
  value_treated_as_absent: {
    level: 'report',
    message: 'Some elevations, times, heart rates or temperatures held impossible values and were left out. The points themselves were kept.',
  },
  text_not_utf8: {
    level: 'report',
    message: 'Some names or notes were not stored as UTF-8 and were read as Western (Windows-1252) text. Check accented letters.',
  },
  track_not_decoded: {
    level: 'report',
    message: 'Some tracks could not be decoded and were not converted. They are listed by name.',
  },
  track_total_count_unexpected: {
    level: 'report',
    message: 'Some tracks store a point total that matches neither way of counting their points. Their points were converted as stored.',
  },
  track_segments_missing: {
    level: 'report',
    message: 'Some tracks have no elevation and time file in TrackSegments. They kept their positions only.',
  },
  track_segments_not_decoded: {
    level: 'report',
    message: 'The elevation and time files of some tracks could not be decoded. Those tracks kept their positions only.',
  },
  track_segments_mismatch: {
    level: 'report',
    message: 'For some tracks, the elevation and time file does not match the track. Those tracks kept their positions only.',
  },
  track_segments_unreadable: {
    level: 'report',
    message: 'The elevation and time files of some tracks could not be read. Those tracks kept their positions only.',
  },
  track_sensor_data_kept: {
    level: 'report',
    message:
      'Some tracks also hold heart rate or air temperature readings. They are kept in the GPX files; the KML file has positions, elevations and times only.',
  },
  route_not_converted: {
    level: 'report',
    message: 'Some routes were not converted. They are listed by name, with the reason.',
  },
  // Links (§10)
  listed_but_not_found: {
    level: 'report',
    message: 'Some lists name items that are not in AllData.gdb. Those entries were skipped.',
  },
  duplicate_names: {
    level: 'report',
    message:
      'Some items share their name with another item of the same kind, so it cannot be told which copy belongs in which list. All copies are in the "_Duplicate names" folder.',
  },
  item_in_several_lists: {
    level: 'report',
    message: 'Some items are in more than one list. They go into each of those lists.',
  },
  name_matched_after_normalising: {
    level: 'report',
    message: 'Some list entries matched their item only after accented letters were normalized. Check those items.',
  },
  not_in_any_list: { level: 'report', message: 'Some items are not in any list. They are in "Not in any list".' },
  // Structure details: shown only in the structure dump
  no_end_record: { level: 'dump', message: 'AllData.gdb has no end-of-file record.' },
  record_order: { level: 'dump', message: 'Some records are not in the usual order.' },
  zero_padding: { level: 'dump', message: 'Zero bytes were skipped between records.' },
  empty_record: { level: 'dump', message: 'Some records are empty.' },
  author_record_unexpected: { level: 'dump', message: "A file's author record is not laid out as expected." },
  display_mode_unknown: { level: 'dump', message: 'Some waypoints have a display mode above 4.' },
  color_index_unknown: { level: 'dump', message: 'Some tracks have a color number above 17; no color was written.' },
  empty_segment: { level: 'dump', message: 'Some track segments hold no points.' },
  track_several_layouts: { level: 'dump', message: 'Some tracks matched more than one track layout.' },
  route_several_layouts: { level: 'dump', message: 'Some routes matched both route layouts.' },
  waypoint_layout_by_program_version: {
    level: 'dump',
    message: 'Some waypoints matched more than one layout; the program version in AllData.gdb decided which one was used.',
  },
  track_layout_by_program_version: {
    level: 'dump',
    message: 'Some tracks matched more than one layout; the program version in AllData.gdb decided which one was used.',
  },
  route_layout_by_program_version: {
    level: 'dump',
    message: 'Some routes matched both route layouts; the program version in AllData.gdb decided which one was used.',
  },
  route_op_only_in_mac48_file: {
    level: 'dump',
    message: 'Some routes matched only the older route layout in a file written by BaseCamp 4.8 for Mac, so they were not converted.',
  },
  route_via_point_record: {
    level: 'dump',
    message: 'Some waypoint records are the via points of a route. They are saved as part of that route, not as waypoints.',
  },
  track_segments_unused: { level: 'dump', message: 'Some files in TrackSegments belong to no decoded track.' },
  folder_tail_unexpected: { level: 'dump', message: 'Some folder records end differently than expected.' },
  list_tail_unexpected: { level: 'dump', message: 'Some list records end differently than expected.' },
  dangling_child: { level: 'dump', message: 'Some folders name a folder or list that does not exist.' },
  unknown_child_type: { level: 'dump', message: 'Some folders name a child of an unknown type.' },
  gfi_record_unexpected: { level: 'dump', message: 'FolderData.gfi holds records of a type not expected there.' },
  gdb_record_unexpected: { level: 'dump', message: 'AllData.gdb holds records of a type not expected there.' },
  item_repeated_in_list: { level: 'dump', message: 'Some lists name the same item more than once.' },
  folder_data_other: { level: 'dump', message: 'FolderData.gfi has framing details that differ from the usual.' },
});

/** container.js codes for AllData.gdb → this module's codes. */
const GDB_CONTAINER = Object.freeze({
  record_truncated: 'record_truncated',
  record_length_impossible: 'record_truncated',
  record_too_large: 'record_too_large',
  too_many_records: 'too_many_records',
  data_after_end: 'data_after_end_record',
  unknown_record_type: 'unknown_record_type',
  zero_padding: 'zero_padding',
  empty_record: 'empty_record',
  author_record_unexpected: 'author_record_unexpected',
  internal_error: 'internal_error',
});

/** container.js codes that mean part of FolderData.gfi was not read. */
const GFI_CUT_SHORT = new Set(['record_truncated', 'record_length_impossible', 'too_many_records', 'record_too_large']);

/** OP's record order in AllData.gdb (FORMAT.md §3.3 rule 4). */
const GDB_ORDER = new Map(['W', 'R', 'T', 'G', 'O', 'L', 'j', 'J', 'C', 'V', 'E', 'X'].map((t, i) => [t, i]));
/** Record types the library holds but v1 does not convert (ARCHITECTURE.md §7). */
const NOT_CONVERTED_TYPES = new Set(['C', 'G', 'O', 'L', 'j', 'J', 'K']);

// ---------------------------------------------------------------------------------------------
// Packed tracks

/**
 * @typedef {object} PackedTrack
 * @property {Int32Array} positions
 * @property {Uint32Array} segmentStarts
 * @property {Float64Array|null} ele
 * @property {Float64Array|null} time
 * @property {Float64Array|null} hr     bpm, NaN = absent; null when no point has one (B44)
 * @property {Float64Array|null} atemp  °C, NaN = absent; null when no point has one (B44)
 */

/** @type {WeakMap<object, PackedTrack>} */
const PACKED = new WeakMap();

/**
 * A Track whose `segments` are built from packed arrays on each read (a fresh Point[][] every time; changing it
 * changes nothing). Everything else is a plain data property. `sensorData` starts false and is set when heart rate or
 * air temperature is attached (attachTrackSegments), so writers never build points to find out (model.js).
 * @param {string} id
 * @param {string} name
 * @param {number|null} colorIndex
 * @param {PackedTrack} packed
 * @returns {Track}
 */
function packedTrack(id, name, colorIndex, packed) {
  const track = /** @type {Track} */ ({ kind: 'track', id, name, comment: '', color: colorName(colorIndex), colorIndex, sensorData: false });
  PACKED.set(track, packed);
  Object.defineProperty(track, 'segments', {
    enumerable: true,
    configurable: true,
    get() {
      return materialiseSegments(packed.positions, packed.segmentStarts, packed.ele, packed.time, packed.hr, packed.atemp);
    },
  });
  return track;
}

/**
 * Point and segment counts of a track, without building its points.
 * @param {Item} item
 * @returns {{points: number, segments: number, withElevation: boolean, withTime: boolean, withHeartRate: boolean,
 *   withTemperature: boolean}}
 */
export function trackShape(item) {
  const packed = PACKED.get(item);
  if (packed) {
    return {
      points: packed.positions.length / 2,
      segments: packed.segmentStarts.length - 1,
      withElevation: packed.ele !== null,
      withTime: packed.time !== null,
      withHeartRate: packed.hr !== null,
      withTemperature: packed.atemp !== null,
    };
  }
  const segments = item.kind === 'track' && Array.isArray(item.segments) ? item.segments : [];
  let points = 0;
  for (const s of segments) points += Array.isArray(s) ? s.length : 0;
  return { points, segments: segments.length, withElevation: false, withTime: false, withHeartRate: false, withTemperature: false };
}

// ---------------------------------------------------------------------------------------------
// Public API

/**
 * Reads a located library into the model. Never throws for bad data; a missing or unreadable AllData.gdb gives an
 * empty library and `details.fatal`.
 * @param {LibrarySource} source
 * @param {ReadOptions} [options]
 * @returns {Promise<ReadResult>}
 */
export async function readLibrary(source, options = {}) {
  const limits = { ...DEFAULT_READ_LIMITS, ...cleanLimits(options.limits) };
  const progress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const counts = new Counts();
  /** @type {ReadDetails} */
  const details = {
    fatal: null,
    experimental: false,
    versions: { gdb: null, gfi: null, program: null },
    application: null,
    duplicates: [],
    multiListItems: 0,
    elevationTime: new Map(),
  };
  /** @type {ReadDiagnostics} */
  const diagnostics = { allData: null, folderData: null, trackSegments: null };
  /** @type {Library} */
  const library = { items: [], folders: [], problems: [], notConverted: [], ambiguous: [], treeMissing: true, meta: { source: 'BaseCamp library', version: null } };

  const src = source && typeof source === 'object' ? source : /** @type {LibrarySource} */ ({ allData: null, folderData: null });
  const totalBytes = (src.folderData?.size ?? 0) + (src.allData?.size ?? 0);
  let bytesDone = 0;
  /** @param {number} n */
  const onBytes = (n) => {
    bytesDone += n;
    progress({ phase: 'reading', done: bytesDone, total: totalBytes });
  };

  // 1. FolderData.gfi: the tree.
  /** @type {ReturnType<typeof buildTree>|null} */
  let tree = null;
  /** @type {import('./gfi.js').GfiReference[]} */
  let references = [];
  /** @type {Set<number>} the IDs of smart lists (B40): left out of the tree, and their references place nothing */
  let smartLists = new Set();
  if (!src.folderData) {
    counts.add('no_folder_data');
  } else {
    const read = await readWhole(src.folderData, limits.maxFolderDataBytes, onBytes);
    if (!read.bytes) {
      counts.add('folder_data_unreadable');
    } else {
      const gfi = readContainer(read.bytes, { role: 'gfi' });
      diagnostics.folderData = gfi;
      if (!gfi.ok) {
        counts.add('folder_data_unreadable');
      } else {
        details.versions.gfi = gfi.formatVersion;
        for (const p of gfi.problems) {
          if (GFI_CUT_SHORT.has(p.code)) counts.add('folder_data_truncated');
          else if (p.code === 'internal_error') counts.add('internal_error');
          else if (p.code !== 'author_record_unexpected') counts.add('folder_data_other', p.count);
        }
        try {
          const content = parseFolderData(gfi.records, counts);
          tree = buildTree(content, counts);
          references = content.references;
          smartLists = new Set(content.lists.filter((l) => l.createdBy === SMART_LIST).map((l) => l.id));
        } catch {
          counts.add('internal_error');
          counts.add('folder_data_unreadable');
          tree = null;
        }
      }
    }
    src.folderData.release?.();
  }

  // 2. AllData.gdb: the items.
  /** @type {Parsed} */
  const parsed = { waypoints: [], tracks: [], routes: [] };
  if (!src.allData) {
    details.fatal = { code: 'read_failed', message: LIBRARY_PROBLEMS.read_failed.message };
  } else {
    const read = await readWhole(src.allData, limits.maxAllDataBytes, onBytes);
    if (!read.bytes) {
      const code = read.failure === 'too_large' ? 'all_data_too_large' : 'read_failed';
      details.fatal = { code, message: LIBRARY_PROBLEMS[code].message };
    } else {
      const gdb = readContainer(read.bytes, { role: 'gdb' });
      diagnostics.allData = gdb;
      details.versions.gdb = gdb.formatVersion;
      details.versions.program = gdb.programVersion;
      details.application = gdb.application;
      const fatal = headerVerdict(gdb);
      if (fatal) {
        details.fatal = { code: fatal, message: LIBRARY_PROBLEMS[fatal].message };
      } else {
        if (gdb.versionClass === 'experimental') {
          details.experimental = true;
          counts.add('experimental_version');
        }
        for (const p of gdb.problems) {
          const code = /** @type {Record<string, string>} */ (GDB_CONTAINER)[p.code] ?? 'internal_error';
          counts.add(code, p.count);
        }
        if (gdb.complete && !gdb.end.present) counts.add('no_end_record');
        parseRecords(gdb.records, parsed, counts, progress, gdb.programVersion);
      }
    }
    src.allData.release?.();
  }
  library.meta = {
    source: details.application && details.application !== 'other' ? `${details.application} library` : 'BaseCamp library',
    version: details.versions.gdb === null ? null : String(details.versions.gdb),
  };
  if (details.versions.gdb !== null && details.versions.gfi !== null && details.versions.gdb !== details.versions.gfi) {
    counts.add('folder_data_version_differs');
  }

  if (!details.fatal) {
    try {
      // 3. Items, with route via points resolved against the waypoints (§7.4).
      const { named, tracks } = buildItems(parsed, library, counts);

      // 4. TrackSegments, one file at a time (§9).
      diagnostics.trackSegments = await attachTrackSegments(tracks, src.trackSegments, limits, counts, details, progress);

      // 5. The tree and the links (§10).
      if (tree) {
        library.treeMissing = false;
        linkTree(tree, references, smartLists, named, library, counts, details);
      }
    } catch {
      // A bug, not bad data (every parser above counts bad data itself): keep what was built and say so.
      counts.add('internal_error');
    }
  } else if (tree) {
    library.treeMissing = false;
    for (const n of tree.nodes) {
      if (isSmartList(n, smartLists)) counts.add('smart_lists_left_out');
      else library.folders.push({ id: n.id, name: n.name, type: n.type, parentId: n.parentId, itemIds: [] });
    }
  }

  if (details.fatal) counts.add(details.fatal.code);
  library.problems = toProblems(counts);
  return { library, details, diagnostics };
}

/**
 * The problems as the model wants them: plain words, counts and a level, in a stable order (report first).
 * @param {Counts} counts
 * @returns {Problem[]}
 */
function toProblems(counts) {
  /** @type {Problem[]} */
  const out = [];
  for (const level of ['report', 'dump']) {
    for (const [code, spec] of Object.entries(LIBRARY_PROBLEMS)) {
      const count = counts.get(code);
      if (count > 0 && spec.level === level) out.push({ code, message: spec.message, count, level: spec.level });
    }
  }
  return out;
}

/**
 * @param {ReadLimits|undefined} limits
 * @returns {ReadLimits}
 */
function cleanLimits(limits) {
  /** @type {Record<string, number>} */
  const out = {};
  if (limits && typeof limits === 'object') {
    for (const key of Object.keys(DEFAULT_READ_LIMITS)) {
      const v = /** @type {any} */ (limits)[key];
      if (Number.isSafeInteger(v) && v >= 0) out[key] = v;
    }
  }
  return out;
}

/**
 * Whole-file verdict on AllData.gdb's header and version (FORMAT.md §3.1, §4), or null to go on.
 * @param {import('./container.js').ContainerResult} gdb
 * @returns {string|null}
 */
function headerVerdict(gdb) {
  if (!gdb.ok) return gdb.stopped === 'bad_header' ? 'unreadable_file_header' : 'not_a_library_file';
  switch (gdb.versionClass) {
    case 'supported':
    case 'experimental':
      return null;
    case 'exported':
      return 'exported_file_not_library';
    default:
      return 'unsupported_version';
  }
}

/**
 * Reads a whole file through SourceFile.bytes() in windows, into one buffer. Never throws.
 * @param {SourceFile} file
 * @param {number} cap
 * @param {(n: number) => void} onBytes
 * @returns {Promise<{bytes: Uint8Array|null, failure: "too_large"|"read_failed"|null}>}
 */
async function readWhole(file, cap, onBytes) {
  try {
    const size = file.size;
    if (!Number.isSafeInteger(size) || size < 0) return { bytes: null, failure: 'read_failed' };
    if (size > cap) return { bytes: null, failure: 'too_large' };
    if (file.origin !== 'file') {
      // A backup entry is inflated whole by bytes() anyway; one call, no copy.
      const bytes = await file.bytes(0, size);
      if (bytes.length !== size) return { bytes: null, failure: 'read_failed' };
      onBytes(size);
      return { bytes, failure: null };
    }
    const out = new Uint8Array(size);
    for (let at = 0; at < size; at += WINDOW) {
      const end = Math.min(size, at + WINDOW);
      const part = await file.bytes(at, end);
      if (part.length !== end - at) return { bytes: null, failure: 'read_failed' };
      out.set(part, at);
      onBytes(end - at);
    }
    return { bytes: out, failure: null };
  } catch (error) {
    const code = /** @type {any} */ (error)?.code;
    return { bytes: null, failure: code === 'too_large' ? 'too_large' : 'read_failed' };
  }
}

// ---------------------------------------------------------------------------------------------
// AllData.gdb records

/**
 * @typedef {object} Parsed
 * @property {import('./gdb.js').WaypointRecord[]} waypoints
 * @property {import('./gdb.js').TrackRecord[]} tracks
 * @property {import('./gdb.js').RouteRecord[]} routes
 */

/**
 * @param {import('./container.js').ContainerRecord[]} records
 * @param {Parsed} parsed
 * @param {Counts} counts
 * @param {(p: {phase: "parsing", done: number, total: number}) => void} progress
 * @param {number|null} programVersion  AllData.gdb's 'A' record program version: breaks layout ties (B43)
 */
function parseRecords(records, parsed, counts, progress, programVersion) {
  const total = records.length;
  const step = Math.max(1, Math.floor(total / 100));
  let maxRank = -1;
  for (let i = 0; i < total; i++) {
    const record = records[i];
    const type = record.type;
    const rank = GDB_ORDER.get(type);
    if (rank !== undefined) {
      if (rank < maxRank) counts.add('record_order');
      else maxRank = rank;
    }
    try {
      if (type === 'W') parsed.waypoints.push(parseWaypoint(record.body, counts, programVersion));
      else if (type === 'T') parsed.tracks.push(parseTrack(record.body, counts, programVersion));
      else if (type === 'R') parsed.routes.push(parseRoute(record.body, counts, programVersion));
      else if (NOT_CONVERTED_TYPES.has(type)) counts.add('not_converted_kind');
      else if (type === 'F' || type === 'I' || type === 'A' || type === 'D') counts.add('gdb_record_unexpected');
      // 'V', 'E', 'X' carry nothing to convert; unknown types are counted by the container.
    } catch {
      counts.add('internal_error');
    }
    if (i % step === 0 || i === total - 1) progress({ phase: 'parsing', done: i + 1, total });
  }
}

/**
 * One entry of the link index: a GDB record a list may name (§10), converted or not.
 * @typedef {object} Named
 * @property {"waypoint"|"track"|"route"} kind
 * @property {string} name
 * @property {number|null} cls
 * @property {Item|null} item       the converted item, or null
 * @property {NotConverted|null} nc the not-converted entry, or null (a waypoint of another class has neither)
 */

/**
 * @typedef {object} NamedIndex
 * @property {Map<string, Named[]>} byKey   link key → records with that key, in file order
 * @property {Named[]} all
 */

/**
 * The link key: kind, class for waypoints, and the raw name bytes (§10).
 * @param {string} kind
 * @param {number|null} cls
 * @param {string} raw
 */
function linkKey(kind, cls, raw) {
  return `${kind[0]}${cls === null ? '' : cls}\u0000${raw}`;
}

/**
 * Turns parsed records into Items and NotConverted entries, resolving route via points (§7.4).
 * @param {Parsed} parsed
 * @param {Library} library
 * @param {Counts} counts
 * @returns {{named: NamedIndex, tracks: Array<{item: Track, uuid: string|null}>}}
 */
function buildItems(parsed, library, counts) {
  /** @type {NamedIndex} */
  const index = { byKey: new Map(), all: [] };
  /** @param {string|null} key @param {Named} named */
  const remember = (key, named) => {
    index.all.push(named);
    if (key === null) return;
    const list = index.byKey.get(key);
    if (list) list.push(named);
    else index.byKey.set(key, [named]);
  };
  /** @type {NotConverted[]} */
  const notConverted = /** @type {NotConverted[]} */ (library.notConverted);
  /** @type {Array<{item: Track, uuid: string|null}>} */
  const tracks = [];
  let w = 0;
  let t = 0;
  let r = 0;

  /** @type {Map<string, import('./gdb.js').WaypointRecord[]>} waypoints by (raw name, class), for route lookups */
  const waypointsByKey = new Map();
  // Waypoint records that a parsed route point names (B42): a class that is not exported there is a route's via point
  // (class 8 on Mac 4.8), saved as part of the route, and counted in the dump only.
  /** @type {Set<string>} */
  const viaKeys = new Set();
  for (const route of parsed.routes) for (const p of route.points) viaKeys.add(linkKey('waypoint', p.cls, p.key));
  /** @param {string} key */
  const notExported = (key) => counts.add(viaKeys.has(key) ? 'route_via_point_record' : 'waypoint_class_not_exported');
  for (const rec of parsed.waypoints) {
    if (!rec.ok) {
      if (rec.cls !== null && rec.cls !== 0 && rec.cls !== 1) {
        // Would not have been converted anyway.
        notExported(rec.key === null ? '' : linkKey('waypoint', rec.cls, rec.key));
        continue;
      }
      counts.add('waypoint_not_decoded');
      if (rec.name !== null) {
        const nc = { kind: /** @type {const} */ ('waypoint'), name: rec.name, reason: 'waypoint_not_decoded', listIds: [] };
        notConverted.push(nc);
        // With its class read, lists can still name it (and the report says where it was); without, by name only.
        if (rec.cls !== null) remember(linkKey('waypoint', rec.cls, /** @type {string} */ (rec.key)), { kind: 'waypoint', name: rec.name, cls: rec.cls, item: null, nc });
      }
      continue;
    }
    const key = linkKey('waypoint', rec.cls, /** @type {string} */ (rec.key));
    const sameKey = waypointsByKey.get(key);
    if (sameKey) sameKey.push(rec);
    else waypointsByKey.set(key, [rec]);
    if (rec.decision === 'none') counts.add('waypoint_details_not_decoded');
    else if (rec.decision === 'several') counts.add('waypoint_several_layouts');
    else if (rec.decision === 'program_version') counts.add('waypoint_layout_by_program_version');
    if (rec.cls !== 0 && rec.cls !== 1) {
      notExported(key);
      remember(key, { kind: 'waypoint', name: /** @type {string} */ (rec.name), cls: rec.cls, item: null, nc: null });
      continue;
    }
    /** @type {Waypoint} */
    const item = {
      kind: 'waypoint',
      id: `w${w++}`,
      name: /** @type {string} */ (rec.name),
      comment: rec.comment,
      symbol: rec.symbol,
      icon: rec.icon,
      lat: rec.lat,
      lon: rec.lon,
      ele: rec.ele,
      time: rec.time,
    };
    library.items.push(item);
    remember(key, { kind: 'waypoint', name: item.name, cls: rec.cls, item, nc: null });
  }

  for (const rec of parsed.routes) {
    if (rec.name === null) {
      counts.add('route_not_converted');
      continue;
    }
    const key = linkKey('route', null, /** @type {string} */ (rec.key));
    /** @type {string|null} */
    let reason = rec.status === 'autoroute' ? 'route_autoroute' : rec.status === 'not_decoded' ? 'route_not_decoded' : null;
    /** @type {import('../model.js').RoutePoint[]} */
    const points = [];
    if (reason === null) {
      for (const p of rec.points) {
        const matches = waypointsByKey.get(linkKey('waypoint', p.cls, p.key));
        const unique = matches && matches.length === 1 ? matches[0] : null;
        if (p.lat !== null && p.lon !== null) {
          // The link point carries no elevation; take the waypoint's only when it sits at the same position.
          const ele = unique && unique.lat === p.lat && unique.lon === p.lon ? unique.ele : null;
          points.push({ lat: p.lat, lon: p.lon, ele, name: p.name, symbol: unique ? unique.symbol : '' });
        } else if (unique) {
          points.push({ lat: unique.lat, lon: unique.lon, ele: unique.ele, name: p.name, symbol: unique.symbol });
        } else {
          reason = 'route_via_unresolved';
          break;
        }
      }
    }
    if (reason !== null) {
      counts.add('route_not_converted');
      const nc = { kind: /** @type {const} */ ('route'), name: rec.name, reason, listIds: [] };
      notConverted.push(nc);
      remember(key, { kind: 'route', name: rec.name, cls: null, item: null, nc });
      continue;
    }
    /** @type {Route} */
    const item = { kind: 'route', id: `r${r++}`, name: rec.name, comment: '', points };
    library.items.push(item);
    remember(key, { kind: 'route', name: item.name, cls: null, item, nc: null });
  }

  for (const rec of parsed.tracks) {
    if (rec.name === null) {
      counts.add('track_not_decoded');
      continue;
    }
    const key = linkKey('track', null, /** @type {string} */ (rec.key));
    if (rec.layout === null || !rec.positions || !rec.segmentStarts) {
      counts.add('track_not_decoded');
      if (rec.decision === 'several') counts.add('track_several_layouts');
      const nc = { kind: /** @type {const} */ ('track'), name: rec.name, reason: 'track_not_decoded', listIds: [] };
      notConverted.push(nc);
      remember(key, { kind: 'track', name: rec.name, cls: null, item: null, nc });
      continue;
    }
    if (rec.decision === 'program_version') counts.add('track_layout_by_program_version');
    if (rec.totalCount === 'neither') counts.add('track_total_count_unexpected');
    if (rec.emptySegments > 0) counts.add('empty_segment', rec.emptySegments);
    if (rec.colorIndex !== null && rec.colorIndex > 17) counts.add('color_index_unknown');
    const item = packedTrack(`t${t++}`, rec.name, rec.colorIndex, {
      positions: rec.positions,
      segmentStarts: rec.segmentStarts,
      ele: null,
      time: null,
      hr: null,
      atemp: null,
    });
    library.items.push(item);
    tracks.push({ item, uuid: rec.uuid });
    remember(key, { kind: 'track', name: rec.name, cls: null, item, nc: null });
  }
  return { named: index, tracks };
}

/**
 * Reads each decoded track's TrackSegments file and attaches elevation and time when they match (§9.3).
 * @param {Array<{item: Track, uuid: string|null}>} tracks  decoded tracks with their TrackSegments uuid
 * @param {Map<string, SourceFile>|undefined} files
 * @param {Required<ReadLimits>} limits
 * @param {Counts} counts
 * @param {ReadDetails} details
 * @param {(p: {phase: "linking", done: number, total: number}) => void} progress
 * @returns {Promise<Array<Uint8Array|{size: number}>|null>}  for the structure dump
 */
async function attachTrackSegments(tracks, files, limits, counts, details, progress) {
  /** @type {Map<string, SourceFile>} lower-case name → file (FORMAT.md §2: uuid letter case is free) */
  const byName = new Map();
  if (files instanceof Map) {
    for (const [name, file] of files) {
      const key = typeof name === 'string' ? name.toLowerCase() : '';
      if (key && !byName.has(key)) byName.set(key, file);
    }
  }
  /** @type {Array<Uint8Array|{size: number}>} */
  const forDump = [];
  let dumpBytes = 0;
  /** @type {Set<string>} */
  const used = new Set();
  const total = tracks.length;
  let done = 0;
  const step = Math.max(1, Math.floor(total / 100));
  for (const { item, uuid } of tracks) {
    done++;
    if (done % step === 0 || done === total) progress({ phase: 'linking', done, total });
    const packed = PACKED.get(item);
    if (!packed || packed.positions.length === 0) continue; // nothing to attach to
    const file = uuid ? byName.get(uuid) : undefined;
    if (!file) {
      counts.add('track_segments_missing');
      details.elevationTime.set(item.id, 'missing');
      continue;
    }
    used.add(/** @type {string} */ (uuid));
    /** @type {Uint8Array|null} */
    let bytes = null;
    try {
      if (Number.isSafeInteger(file.size) && file.size <= limits.maxTrackSegmentBytes) {
        bytes = await file.bytes(0, file.size);
        if (bytes.length !== file.size) bytes = null;
      }
    } catch {
      bytes = null;
    }
    if (!bytes) {
      counts.add('track_segments_unreadable');
      details.elevationTime.set(item.id, 'unreadable');
      file.release?.();
      if (Number.isSafeInteger(file.size)) forDump.push({ size: file.size });
      continue;
    }
    if (dumpBytes + bytes.length <= limits.dumpTrackSegmentBytes) {
      forDump.push(bytes);
      dumpBytes += bytes.length;
    } else forDump.push({ size: bytes.length });
    const ts = parseTrackSegments(bytes, counts);
    const match = ts.status === 'decoded' ? matchTrackSegments(packed.positions, packed.segmentStarts, ts) : null;
    if (ts.status !== 'decoded') {
      counts.add('track_segments_not_decoded');
      details.elevationTime.set(item.id, 'not_decoded');
    } else if (!match) {
      counts.add('track_segments_mismatch');
      details.elevationTime.set(item.id, 'mismatch');
    } else {
      packed.ele = allNaN(match.ele) ? null : match.ele;
      packed.time = allNaN(match.time) ? null : match.time;
      // Heart rate and air temperature go with them (FORMAT.md §15.11, B44), only from a file that matched its track.
      packed.hr = match.hr && !allNaN(match.hr) ? match.hr : null;
      packed.atemp = match.atemp && !allNaN(match.atemp) ? match.atemp : null;
      details.elevationTime.set(item.id, 'attached');
      if (packed.hr !== null || packed.atemp !== null) {
        item.sensorData = true;
        counts.add('track_sensor_data_kept');
      }
    }
    file.release?.();
  }
  for (const [name, file] of byName) {
    if (used.has(name)) continue;
    counts.add('track_segments_unused');
    if (Number.isSafeInteger(file.size)) forDump.push({ size: file.size });
  }
  return files instanceof Map ? forDump : null;
}

/**
 * @param {Float64Array} values
 * @returns {boolean}
 */
function allNaN(values) {
  for (let i = 0; i < values.length; i++) if (!Number.isNaN(values[i])) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Linking (§10)

/**
 * Whether a tree node is a smart list (B40).
 * @param {import('./gfi.js').TreeNodeOut} node
 * @param {Set<number>} smartLists
 */
function isSmartList(node, smartLists) {
  return node.type === 'list' && smartLists.has(node.sourceId);
}

/**
 * Builds library.folders from the tree and places items in lists by their references. Smart lists (B40) are left
 * out, and their references place nothing.
 * @param {ReturnType<typeof buildTree>} tree
 * @param {import('./gfi.js').GfiReference[]} references
 * @param {Set<number>} smartLists  list IDs of smart lists
 * @param {NamedIndex} named
 * @param {Library} library
 * @param {Counts} counts
 * @param {ReadDetails} details
 */
function linkTree(tree, references, smartLists, named, library, counts, details) {
  /** @type {Map<string, Folder>} */
  const folders = new Map();
  for (const node of tree.nodes) {
    if (isSmartList(node, smartLists)) {
      counts.add('smart_lists_left_out');
      continue;
    }
    const folder = { id: node.id, name: node.name, type: node.type, parentId: node.parentId, itemIds: /** @type {string[]} */ ([]) };
    folders.set(node.id, folder);
    library.folders.push(folder);
  }

  /** @type {Map<string, Named[]>|null} built on first need: NFC name key → records */
  let byNfc = null;
  /** @type {Map<Item, Set<string>>} */
  const listsOf = new Map();
  /** @type {Map<string, {group: DuplicateGroup, lists: Set<string>}>} */
  const duplicates = new Map();
  /** @type {Set<string>} */
  const ambiguous = new Set();
  /** @type {Map<NotConverted, Set<string>>} the lists already recorded on a not-converted entry */
  const ncLists = new Map();
  // Every membership test below is a Set lookup, so linking is linear in the number of references whatever their
  // shape (one not-converted item or one duplicated name named by every list was quadratic with Array.includes).

  for (const ref of references) {
    if (smartLists.has(ref.listId)) continue;
    const listId = tree.listIds.get(ref.listId);
    const folder = listId === undefined ? undefined : folders.get(listId);
    if (!folder || listId === undefined) {
      counts.add('reference_to_unknown_list');
      continue;
    }
    const key = linkKey(ref.kind, ref.cls, ref.key);
    let matches = named.byKey.get(key);
    if (!matches) {
      if (byNfc === null) byNfc = nfcIndex(named.all);
      matches = byNfc.get(nfcKey(ref.kind, ref.cls, ref.name));
      if (matches) counts.add('name_matched_after_normalising');
    }
    if (!matches) {
      counts.add('listed_but_not_found');
      continue;
    }
    if (matches.length > 1) {
      // The lists are named once, on the group: they cannot say which copy they meant (§10), and recording every list
      // on every not-converted copy made memory grow with copies × lists.
      let entry = duplicates.get(key);
      if (!entry) {
        const itemIds = matches.flatMap((m) => (m.item ? [m.item.id] : []));
        entry = { group: { kind: ref.kind, name: matches[0].name, cls: ref.cls, itemIds, copies: matches.length, listIds: [] }, lists: new Set() };
        duplicates.set(key, entry);
        for (const id of itemIds) ambiguous.add(id);
      }
      if (!entry.lists.has(listId)) {
        entry.lists.add(listId);
        entry.group.listIds.push(listId);
      }
      continue;
    }
    const match = matches[0];
    if (match.nc) {
      let seen = ncLists.get(match.nc);
      if (!seen) {
        seen = new Set(match.nc.listIds);
        ncLists.set(match.nc, seen);
      }
      if (!seen.has(listId)) {
        seen.add(listId);
        match.nc.listIds.push(listId);
      }
      continue;
    }
    if (!match.item) continue; // a waypoint of a class that is not converted (already counted)
    let lists = listsOf.get(match.item);
    if (!lists) {
      lists = new Set();
      listsOf.set(match.item, lists);
    }
    if (lists.has(listId)) {
      counts.add('item_repeated_in_list');
      continue;
    }
    lists.add(listId);
    folder.itemIds.push(match.item.id);
  }

  let several = 0;
  for (const lists of listsOf.values()) if (lists.size > 1) several++;
  if (several > 0) counts.add('item_in_several_lists', several);
  details.multiListItems = several;
  if (duplicates.size > 0) counts.add('duplicate_names', duplicates.size);
  details.duplicates = [...duplicates.values()].map((d) => d.group);
  library.ambiguous = library.items.filter((item) => ambiguous.has(item.id)).map((item) => item.id);
  let unlisted = 0;
  for (const item of library.items) if (!listsOf.has(item) && !ambiguous.has(item.id)) unlisted++;
  if (unlisted > 0) counts.add('not_in_any_list', unlisted);
}

/**
 * @param {string} kind
 * @param {number|null} cls
 * @param {string} name  decoded
 */
function nfcKey(kind, cls, name) {
  return `${kind[0]}${cls === null ? '' : cls}\u0000${name.normalize('NFC')}`;
}

/**
 * @param {Named[]} all
 * @returns {Map<string, Named[]>}
 */
function nfcIndex(all) {
  /** @type {Map<string, Named[]>} */
  const map = new Map();
  for (const named of all) {
    const key = nfcKey(named.kind, named.cls, named.name);
    const list = map.get(key);
    if (list) list.push(named);
    else map.set(key, [named]);
  }
  return map;
}

