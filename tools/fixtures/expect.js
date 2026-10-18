// What a correct reader must produce for a fixture library: derived from the scenario's description by applying the
// rules of docs/FORMAT.md (§2-§11) at the level of meaning, not bytes. Written from FORMAT.md alone, never from
// src/format/.
//
// The result is independent of reader-defined ids: items are matched by (kind, name), lists by their name path from
// the root, and list membership compares as a set (FORMAT.md fixes no order). See tools/fixtures/README.md for the
// shape, the problem vocabulary and every choice made where FORMAT.md is silent.
//
// Where a description reaches a case FORMAT.md does not settle, this module throws instead of guessing, so a scenario
// can never carry an invented expectation by accident.

import {
  encodeText, gdbNameBytes, gfiNameBytes, indexSpec, latToSemicircles, lonToSemicircles, semicirclesToDegrees,
  trackSemicircles, ROOT_FOLDER_ID, FOLDER_TAIL_MAC48, SMART_LIST_TAIL,
} from './writer.js';

/**
 * The problem vocabulary. `level: 'report'` means FORMAT.md says the case is reported to the user; `level: 'count'`
 * means it is counted (in the report or the structure-only dump). `per` is the unit a count is given in. Messages are
 * plain words and never carry a name, a coordinate, a time or a path.
 * @type {Readonly<Record<string, {level: 'report'|'count', per: string, ref: string, message: string}>>}
 */
export const PROBLEMS = Object.freeze({
  not_a_library_file: {
    level: 'report', per: 'file', ref: 'FORMAT.md §3.1 rule 1',
    message: 'This file is not a BaseCamp library file.',
  },
  unreadable_file_header: {
    level: 'report', per: 'file', ref: 'FORMAT.md §3.1 rule 2',
    message: 'The file header could not be read.',
  },
  exported_file_not_library: {
    level: 'report', per: 'file', ref: 'FORMAT.md §4 (107-109)',
    message: 'This is an exported file; it contains no folders or lists.',
  },
  unsupported_version: {
    level: 'report', per: 'file', ref: 'FORMAT.md §4 (115-138), B6',
    message: 'This library was made by an older BaseCamp version that is not supported.',
  },
  experimental_version: {
    level: 'report', per: 'file', ref: 'FORMAT.md §4 (146-187, >188), B6',
    message: 'This library version is read experimentally; check the results.',
  },
  folder_data_version_differs: {
    level: 'report', per: 'library', ref: 'FORMAT.md §4',
    message: 'The folder file and the item file carry different version numbers.',
  },
  record_truncated: {
    level: 'report', per: 'file', ref: 'FORMAT.md §3.3 rule 2',
    message: 'The file ends in the middle of a record; everything before it was read.',
  },
  data_after_end_record: {
    level: 'report', per: 'file', ref: 'FORMAT.md §3.3 rule 4',
    message: 'There is data after the end-of-file record; it was not read.',
  },
  track_not_decoded: {
    level: 'report', per: 'track', ref: 'FORMAT.md §6.5',
    message: 'A track could not be decoded; it is listed by name without its points.',
  },
  track_total_count_unexpected: {
    level: 'report', per: 'track', ref: 'FORMAT.md §6.4 g',
    message: 'A track\'s stored point total matched neither expected count.',
  },
  track_segments_missing: {
    level: 'report', per: 'track', ref: 'FORMAT.md §9.3 step 6',
    message: 'A track has no elevation and time file; it keeps its positions only.',
  },
  track_segments_not_decoded: {
    level: 'report', per: 'track', ref: 'FORMAT.md §9.3 step 4, B13',
    message: 'A track\'s elevation and time could not be read; it keeps its positions only.',
  },
  track_segments_mismatch: {
    level: 'report', per: 'track', ref: 'FORMAT.md §9.3 step 5, B13',
    message: 'Elevation and time did not match the track; it keeps its positions only.',
  },
  route_not_converted: {
    level: 'report', per: 'route', ref: 'FORMAT.md §7.4, B14',
    message: 'A route was not converted; it is listed by name.',
  },
  no_folder_data: {
    level: 'report', per: 'library', ref: 'FORMAT.md §10, B11',
    message: 'The folder and list file is missing, so items are grouped by type only.',
  },
  listed_but_not_found: {
    level: 'report', per: 'reference', ref: 'FORMAT.md §10',
    message: 'A list names an item that is not in the library file.',
  },
  duplicate_names: {
    level: 'report', per: 'link key (type, name bytes, class)', ref: 'FORMAT.md §10, B10',
    message: 'Several items share a name, so their lists cannot be told apart.',
  },
  item_in_several_lists: {
    level: 'report', per: 'item', ref: 'FORMAT.md §10, B9',
    message: 'An item is in several lists and was written into each.',
  },
  name_matched_after_normalising: {
    level: 'report', per: 'reference', ref: 'FORMAT.md §11',
    message: 'A list entry matched its item only after normalising the text.',
  },
  smart_lists_left_out: {
    level: 'report', per: 'list', ref: 'FORMAT.md §15.11 (smart lists), B40',
    message: 'Smart lists were not exported as lists; their items are in their own lists.',
  },
  track_sensor_data_kept: {
    level: 'report', per: 'track', ref: 'FORMAT.md §15.11 (TrackSegments), B44',
    message: 'Some tracks hold temperature or heart rate, which is kept on their points.',
  },
  list_folder_disagreement: {
    level: 'report', per: 'list', ref: 'FORMAT.md §8.4',
    message: 'A list\'s folder was recorded two different ways; the folder\'s own list of children was used.',
  },
  list_not_in_tree: {
    level: 'report', per: 'list', ref: 'FORMAT.md §8.4',
    message: 'A list was not inside any folder; it was put under the top folder.',
  },
  folder_in_two_places: {
    level: 'report', per: 'extra parent reference', ref: 'FORMAT.md §8.4',
    message: 'A folder was listed in two places; it was kept in the first.',
  },
  waypoint_details_not_decoded: {
    level: 'count', per: 'waypoint', ref: 'FORMAT.md §3.3 rule 8',
    message: 'Some waypoint details (altitude, time) could not be decoded.',
  },
  waypoint_class_not_exported: {
    level: 'count', per: 'waypoint', ref: 'FORMAT.md §5.4',
    message: 'Some map or route-support points were not exported.',
  },
  route_via_point_record: {
    level: 'count', per: 'waypoint', ref: 'FORMAT.md §15.11 (class 8), B42',
    message: 'Some waypoint records are route via points and were kept in their route only.',
  },
  unknown_record_type: {
    level: 'count', per: 'record', ref: 'FORMAT.md §3.3 rule 3',
    message: 'Some records of an unknown kind were skipped.',
  },
  no_end_record: {
    level: 'count', per: 'file', ref: 'FORMAT.md §3.3 rule 4 (dump only)',
    message: 'The file has no end-of-file record.',
  },
  record_order: {
    level: 'count', per: 'record (granularity not fixed)', ref: 'FORMAT.md §3.3 rule 4 (dump only)',
    message: 'Records were not in the usual order.',
  },
  author_record_unexpected: {
    level: 'count', per: 'file', ref: 'FORMAT.md §3.1 rule 3',
    message: 'The author record was not as expected.',
  },
  text_not_utf8: {
    level: 'count', per: 'string (granularity not fixed)', ref: 'FORMAT.md §11',
    message: 'Some text was not UTF-8 and was read as Windows Latin-1.',
  },
  empty_segment: {
    level: 'count', per: 'segment', ref: 'FORMAT.md §6.4 notes',
    message: 'A track has an empty segment.',
  },
  value_treated_as_absent: {
    level: 'count', per: 'value', ref: 'FORMAT.md §2 rules 4-5',
    message: 'Some impossible elevations or times were left out.',
  },
  folder_tail_unexpected: {
    level: 'count', per: 'record', ref: 'FORMAT.md §8.1',
    message: 'A folder record ended unexpectedly.',
  },
  list_tail_unexpected: {
    level: 'count', per: 'record', ref: 'FORMAT.md §8.2',
    message: 'A list record ended unexpectedly.',
  },
  dangling_child: {
    level: 'count', per: 'child reference', ref: 'FORMAT.md §8.4',
    message: 'A folder names a child that does not exist.',
  },
  duplicate_id: {
    level: 'count', per: 'record', ref: 'FORMAT.md §8.4',
    message: 'A folder or list ID appeared twice; the later one was ignored.',
  },
  not_converted_kind: {
    level: 'count', per: 'reference', ref: 'FORMAT.md §8.3 (K, J)',
    message: 'Some BirdsEye entries are not converted.',
  },
  not_in_any_list: {
    level: 'count', per: 'item', ref: 'FORMAT.md §10',
    message: 'Some items are in no list.',
  },
});

/**
 * @typedef {object} ExpectedProblem
 * @property {string} code   a key of PROBLEMS
 * @property {number|null} count  in PROBLEMS[code].per units; null = at least one, the granularity is not fixed
 */

/**
 * @typedef {object} ExpectedWaypoint
 * @property {'waypoint'} kind
 * @property {string} name
 * @property {string} comment
 * @property {number} icon     the u32 symbol number (the icon → <sym> table is not this module's business, B31)
 * @property {number} class
 * @property {number} lat      exactly what the semicircle integer decodes to
 * @property {number} lon
 * @property {number|null} ele
 * @property {number|null} time   ms
 */

/**
 * @typedef {object} ExpectedTrack
 * @property {'track'} kind
 * @property {string} name
 * @property {number} colorIndex  FORMAT.md §6.3 index (0 = no colour)
 * @property {Array<Array<{lat: number, lon: number, ele: number|null, time: number|null, hr?: number, atemp?: number}>>} segments
 *   hr (bpm) and atemp (°C) are present only on points that keep one (B44)
 */

/**
 * @typedef {object} ExpectedRoute
 * @property {'route'} kind
 * @property {string} name
 * @property {Array<{name: string, lat: number, lon: number}>} points
 */

/**
 * @typedef {(ExpectedWaypoint|ExpectedTrack|ExpectedRoute) & {
 *   placement: 'lists'|'not-in-any-list'|'duplicate-names'|'flat', lists: string[][], specId: string}} ExpectedItem
 */

/**
 * @typedef {object} Expected
 * @property {{file: string, code: string}|null} fatal   AllData.gdb could not be used at all
 * @property {{gdb: number|null, gfi: number|null}} versions  raw 'D' versions
 * @property {boolean} experimental
 * @property {Array<{path: string[], type: 'folder'|'list'}>|null} tree  null when not asserted (fatal) ; [] without a GFI
 * @property {ExpectedItem[]} items      every item the export writes
 * @property {Array<{kind: 'track', name: string, lists: string[][]}>} notDecoded   listed by name, no geometry
 * @property {Array<{name: string, reason: 'autoroute'|'not_decoded'|'via_unresolved', lists: string[][]}>} routesNotConverted
 * @property {Array<{kind: string, name: string, class: number|null, copies: number, referencedBy: string[][]}>} duplicates
 * @property {ExpectedProblem[]} problems   level 'report' codes
 * @property {ExpectedProblem[]} counted    level 'count' codes
 * @property {string[]} tolerated   codes a correct reader MAY add (FORMAT.md does not settle whether it reports them)
 */

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });
const CP1252 = new TextDecoder('windows-1252');

/**
 * FORMAT.md §11: strict UTF-8, else windows-1252.
 * @param {Uint8Array} bytes
 * @returns {{text: string, fallback: boolean}}
 */
export function decodeText(bytes) {
  try {
    return { text: UTF8_STRICT.decode(bytes), fallback: false };
  } catch {
    return { text: CP1252.decode(bytes), fallback: true };
  }
}

/** @param {import('./writer.js').Text} t */
function textOf(t) {
  if (typeof t === 'string') return t;
  return decodeText(encodeText(t)).text;
}

/** @param {Uint8Array} b */
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

class Tally {
  constructor() {
    /** @type {Map<string, number|null>} */
    this.map = new Map();
  }

  /**
   * @param {string} code
   * @param {number|null} [n]  null = at least one, granularity not fixed
   */
  add(code, n = 1) {
    if (!(code in PROBLEMS)) throw new RangeError(`unknown problem code ${code}`);
    const old = this.map.get(code);
    this.map.set(code, old === null || n === null ? null : (old ?? 0) + n);
  }

  /** @returns {ExpectedProblem[]} */
  list() {
    return [...this.map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([code, count]) => ({ code, count }));
  }
}

const KNOWN_TYPES = new Set('ACDEFGIjJKLORTVWX'.split(''));

/**
 * FORMAT.md §2 rule 4: NaN, ±Infinity and ≥ 1e24 are absent.
 * @param {number|null|undefined} v
 * @param {Tally} counted
 */
function elevation(v, counted) {
  if (v === null || v === undefined) return null;
  if (!Number.isFinite(v) || v >= 1e24) {
    counted.add('value_treated_as_absent');
    return null;
  }
  return v;
}

/**
 * FORMAT.md §15.11 (B44): a present heart rate of 0 is absent (no beats per minute; Garmin's schema starts at 1).
 * @param {number|null|undefined} bpm
 * @param {Tally} counted
 */
function heartRate(bpm, counted) {
  if (bpm === null || bpm === undefined) return null;
  if (bpm === 0) {
    counted.add('value_treated_as_absent');
    return null;
  }
  return bpm;
}

/**
 * FORMAT.md §15.11 (B44): a present air temperature that is NaN or infinite is absent, as for elevation.
 * @param {number|null|undefined} c
 * @param {Tally} counted
 */
function temperature(c, counted) {
  if (c === null || c === undefined) return null;
  if (!Number.isFinite(c)) {
    counted.add('value_treated_as_absent');
    return null;
  }
  return c;
}

/**
 * FORMAT.md §2 rule 5: a present time ≤ 0 is absent.
 * @param {number|null|undefined} ms
 * @param {Tally} counted
 */
function time(ms, counted) {
  if (ms === null || ms === undefined) return null;
  if (ms <= 0) {
    counted.add('value_treated_as_absent');
    return null;
  }
  return ms;
}

/**
 * Classifies the 'D' version of AllData.gdb (FORMAT.md §4). Throws on numbers FORMAT.md does not place.
 * @param {number} v
 * @returns {'exported'|'rejected'|'experimental'|'supported'}
 */
function versionClass(v) {
  if (v >= 107 && v <= 109) return 'exported';
  if (v >= 115 && v <= 138) return 'rejected';
  if (v === 188) return 'supported';
  if ((v >= 146 && v <= 187) || v > 188) return 'experimental';
  throw new RangeError(`FORMAT.md does not say how to treat version ${v}; do not use it in a scenario`);
}

/**
 * Derives the expected neutral result for a scenario.
 * @param {import('./writer.js').LibrarySpec} lib
 * @param {ReturnType<typeof import('./writer.js').buildLibrary>} built
 * @param {{tolerated?: string[]}} [extra]
 * @returns {Expected}
 */
export function deriveExpected(lib, built, extra = {}) {
  const idx = indexSpec(lib);
  const problems = new Tally();
  const counted = new Tally();
  const tolerated = new Set(extra.tolerated ?? []);
  const gdbHeader = { ...lib.header, ...lib.gdb?.header };
  const gdbVersion = gdbHeader.version ?? 188;
  // FORMAT.md §3.3 rule 8 and §15.11 (B43): AllData.gdb's program version (the writer's default is 407).
  const programVersion = gdbHeader.programVersion ?? 407;
  const hasGfi = built.files.has('FolderData.gfi');
  const gfiHeader = { ...lib.header, ...lib.gfi?.header };
  const gfiVersion = hasGfi ? (gfiHeader.version ?? 188) : null;

  /**
   * @param {string} code
   * @param {number|null} [version]  the 'D' version when the header was readable enough to give it
   */
  const fatal = (code, version = null) => {
    problems.add(code);
    return {
      fatal: { file: 'AllData.gdb', code },
      versions: { gdb: version, gfi: gfiVersion },
      experimental: false,
      tree: null,
      items: [],
      notDecoded: [],
      routesNotConverted: [],
      duplicates: [],
      problems: problems.list(),
      counted: [],
      tolerated: [...tolerated].sort(),
    };
  };

  // Whole-file problems (§3.1, §4).
  if (lib.gdb?.replace) {
    const b = lib.gdb.replace;
    const sig = b.length >= 4 ? String.fromCharCode(b[0], b[1], b[2], b[3]) : '';
    if (sig === 'MsRc') throw new RangeError('a replaced AllData.gdb must not start with MsRc; its meaning would be unspecified');
    return /** @type {Expected} */ (fatal('not_a_library_file'));
  }
  const sig = gdbHeader.signature ?? 'MsRc';
  if ((typeof sig === 'string' ? sig : String.fromCharCode(...sig)) !== 'MsRc' || (gdbHeader.primary ?? 0x66) !== 0x66) {
    return /** @type {Expected} */ (fatal('not_a_library_file'));
  }
  if ((gdbHeader.dLength ?? 2) !== 2 || (gdbHeader.dType ?? 'D') !== 'D') return /** @type {Expected} */ (fatal('unreadable_file_header'));
  const vclass = versionClass(gdbVersion);
  if (vclass === 'exported') return /** @type {Expected} */ (fatal('exported_file_not_library', gdbVersion));
  if (vclass === 'rejected') return /** @type {Expected} */ (fatal('unsupported_version', gdbVersion));
  if (vclass === 'experimental') problems.add('experimental_version');
  if ((gdbHeader.aExtra ?? 0) > 0) counted.add('author_record_unexpected');
  if (hasGfi) {
    for (const k of ['signature', 'primary', 'dLength', 'dType']) {
      if (lib.gfi?.header && k in lib.gfi.header) throw new RangeError('a broken FolderData.gfi header is not specified; do not use it');
    }
    if (gfiVersion !== gdbVersion) problems.add('folder_data_version_differs');
  }

  // Which GDB records the reader gets to see (§3.3 rules 1-4).
  const man = /** @type {import('./writer.js').FileManifest} */ (built.manifest.get('AllData.gdb'));
  /** @type {Set<string>} */
  const survived = new Set();
  let truncated = false;
  let seenV = false;
  for (const r of man.records) {
    if (r.lenField !== r.len || r.bodyStart + r.len > man.length) {
      truncated = true;
      break;
    }
    if (r.type === 'V') seenV = true;
    else if (seenV && (r.type === 'W' || r.type === 'R' || r.type === 'T')) counted.add('record_order', null);
    if (!KNOWN_TYPES.has(r.type)) counted.add('unknown_record_type');
    if (r.item) survived.add(r.item);
  }
  const end = lib.gdb?.end ?? 'VEX';
  if (truncated) problems.add('record_truncated');
  else if (end === 'VE') counted.add('no_end_record');
  else if (end === 'VEX+junk') problems.add('data_after_end_record');

  // Text (§11).
  let fallback = false;
  /** @param {Uint8Array} b */
  const decodeCounting = (b) => {
    const d = decodeText(b);
    if (d.fallback) fallback = true;
    return d.text;
  };

  // Items (§5-§7).
  /** @type {Map<string, ExpectedItem>} */
  const exported = new Map();
  /** @type {Map<string, {kind: 'track', name: string, lists: string[][]}>} */
  const notDecoded = new Map();
  /** @type {Map<string, {name: string, reason: 'autoroute'|'not_decoded'|'via_unresolved', lists: string[][]}>} */
  const routesNot = new Map();
  /** @type {Map<string, import('./writer.js').RecordInfo>} */
  const recordOf = new Map();
  for (const r of man.records) if (r.item) recordOf.set(r.item, r);
  const survivors = lib.items.filter((it) => survived.has(it.id));
  const waypointsBySurvivingKey = new Map();
  for (const it of survivors) {
    if (it.kind !== 'waypoint') continue;
    const key = `${hex(gdbNameBytes(it))}/${it.gdb?.class ?? 0}`;
    waypointsBySurvivingKey.set(key, [...(waypointsBySurvivingKey.get(key) ?? []), it]);
  }

  // B42: a waypoint record of a class that is not exported, whose raw name and class a route point the reader parses
  // names, is a route via point: counted as route_via_point_record instead of waypoint_class_not_exported. A route's
  // points are parsed when its route is decoded (converted or with a via point that does not resolve), and up to the
  // first autoroute point when the route stops there (§7.4).
  /** @type {Set<string>} */
  const viaKeys = new Set();
  for (const it of survivors) {
    if (it.kind !== 'route') continue;
    const r = expectRoute(it, waypointsBySurvivingKey, programVersion);
    if ('reason' in r && r.reason === 'not_decoded') continue;
    const via = it.gdb?.via ?? [];
    const mac48 = it.gdb?.layout === 'mac48';
    for (let i = 0; i < it.points.length; i++) {
      viaKeys.add(`${hex(encodeText(it.points[i].name))}/${via[i]?.class ?? (mac48 ? 8 : 0)}`);
      if (!mac48 && via[i]?.autoroute) break;
    }
  }

  for (const it of survivors) {
    const name = decodeCounting(gdbNameBytes(it));
    const rec = /** @type {import('./writer.js').RecordInfo} */ (recordOf.get(it.id));
    if (it.kind === 'waypoint') {
      const g = it.gdb ?? {};
      const cls = g.class ?? 0;
      if (cls !== 0 && cls !== 1) {
        counted.add(viaKeys.has(`${hex(gdbNameBytes(it))}/${cls}`) ? 'route_via_point_record' : 'waypoint_class_not_exported');
        continue;
      }
      let ele = null;
      let t = null;
      if (rec.intended === 'none') {
        counted.add('waypoint_details_not_decoded');
      } else {
        ele = elevation(it.ele, counted);
        if (rec.intended === 'op') {
          t = it.time ?? null;
        } else {
          // H-KBM and H-MAC48: K22 ("creation date") if present, otherwise K18 (§5.4, §15.11, B42).
          const k18 = g.timeIn === 'A' ? (it.time ?? null) : (g.otherTime ?? null);
          const k22 = g.timeIn === 'A' ? (g.otherTime ?? null) : (it.time ?? null);
          t = k22 !== null ? k22 : k18;
        }
        t = time(t, counted);
      }
      exported.set(it.id, {
        kind: 'waypoint',
        name,
        comment: decodeCounting(encodeText(it.comment ?? '')),
        icon: g.icon ?? 0,
        class: cls,
        lat: semicirclesToDegrees(latToSemicircles(it.lat)),
        lon: semicirclesToDegrees(lonToSemicircles(it.lon)),
        ele,
        time: t,
        placement: 'flat',
        lists: [],
        specId: it.id,
      });
    } else if (it.kind === 'track') {
      if (rec.intended === 'none') {
        problems.add('track_not_decoded');
        notDecoded.set(it.id, { kind: 'track', name, lists: [] });
        continue;
      }
      exported.set(it.id, { ...expectTrack(it, name, built, problems, counted, tolerated), placement: 'flat', lists: [], specId: it.id });
    } else {
      const r = expectRoute(it, waypointsBySurvivingKey, programVersion);
      if ('reason' in r) {
        problems.add('route_not_converted');
        routesNot.set(it.id, { name, reason: r.reason, lists: [] });
      } else {
        exported.set(it.id, { kind: 'route', name, points: r.points, placement: 'flat', lists: [], specId: it.id });
      }
    }
  }

  /** @type {Expected['duplicates']} */
  const duplicates = [];
  /** @type {Expected['tree']} */
  let tree = [];
  if (!hasGfi) {
    problems.add('no_folder_data');
  } else {
    const t = expectTree(lib, idx, problems, counted, decodeCounting);
    tree = t.tree;
    linkItems(lib, idx, survivors, t.listPath, exported, notDecoded, routesNot, duplicates, problems, counted, decodeCounting);
  }
  if (fallback) counted.add('text_not_utf8', null);

  return {
    fatal: null,
    versions: { gdb: gdbVersion, gfi: gfiVersion },
    experimental: vclass === 'experimental',
    tree,
    items: [...exported.values()],
    notDecoded: [...notDecoded.values()],
    routesNotConverted: [...routesNot.values()],
    duplicates,
    problems: problems.list(),
    counted: counted.list(),
    tolerated: [...tolerated].sort(),
  };
}

/**
 * A decoded track: positions from the record, elevation and time only per §9.3.
 * @param {import('./writer.js').TrackSpec} trk
 * @param {string} name
 * @param {ReturnType<typeof import('./writer.js').buildLibrary>} built
 * @param {Tally} problems
 * @param {Tally} counted
 * @param {Set<string>} tolerated
 * @returns {ExpectedTrack}
 */
function expectTrack(trk, name, built, problems, counted, tolerated) {
  const g = trk.gdb ?? {};
  const semis = trackSemicircles(trk);
  const S = semis.length;
  const sumN = semis.reduce((a, s) => a + s.length, 0);
  for (const s of semis) if (s.length === 0) counted.add('empty_segment');
  if (typeof g.totalCount === 'number' && g.totalCount !== sumN && g.totalCount !== sumN - Math.max(0, S - 1)) {
    problems.add('track_total_count_unexpected');
  }
  /** @type {Array<Array<{ele: number|null, time: number|null, atemp: number|null, hr: number|null}>>|null} */
  let values = null;
  const uuid = built.uuids.get(trk.id);
  const tsMan = built.manifest.get(`TrackSegments/${uuid}`);
  if (!tsMan) {
    problems.add('track_segments_missing');
  } else if ((tsMan.intendedN ?? []).length !== 1) {
    if (sumN === 0 && (tsMan.intendedN ?? []).length === 2) tolerated.add('track_segments_not_decoded');
    else problems.add('track_segments_not_decoded');
  } else {
    const written = /** @type {Array<{ele: number|null, time: number|null, atemp: number|null, hr: number|null}>} */ (tsMan.points);
    const M = written.length;
    if (M === sumN) {
      let k = 0;
      values = semis.map((s) => s.map(() => written[k++]));
    } else if (S > 1 && M === sumN - (S - 1)) {
      if (semis.some((s) => s.length === 0)) throw new RangeError('overlap counts with empty segments are not settled by FORMAT.md');
      const shared = semis.every((s, i) => i === 0 || (s[0][0] === semis[i - 1].at(-1)?.[0] && s[0][1] === semis[i - 1].at(-1)?.[1]));
      if (shared) {
        let k = 0;
        values = semis.map((s, i) => s.map((_, j) => (i > 0 && j === 0 ? written[k - 1] : written[k++])));
      } else {
        problems.add('track_segments_mismatch');
      }
    } else {
      problems.add('track_segments_mismatch');
    }
  }
  // §15.11 (B44): temperature and heart rate go onto the points with elevation and time, only from a file that matched
  // its track; a point gets each only where it has a value. A track that kept any is reported, per track.
  let sensorsKept = false;
  const segments = semis.map((s, i) => s.map(([la, lo], j) => {
    const v = values ? values[i][j] : null;
    /** @type {{lat: number, lon: number, ele: number|null, time: number|null, hr?: number, atemp?: number}} */
    const point = {
      lat: semicirclesToDegrees(la),
      lon: semicirclesToDegrees(lo),
      ele: v ? elevation(v.ele, counted) : null,
      time: v ? time(v.time, counted) : null,
    };
    if (v) {
      const bpm = heartRate(v.hr, counted);
      if (bpm !== null) point.hr = bpm;
      const c = temperature(v.atemp, counted);
      if (c !== null) point.atemp = c;
      if (bpm !== null || c !== null) sensorsKept = true;
    }
    return point;
  }));
  if (sensorsKept) problems.add('track_sensor_data_kept');
  return { kind: 'track', name, colorIndex: g.colorIndex ?? 0, segments };
}

/**
 * Route conversion per §7.4: every point must parse (A = 0, Unknown7 all 0xFF) and every via point must resolve. In a
 * file whose program version is 408 (Mac BaseCamp 4.8), a route in OP's layout that would decode is not decoded: §3.3
 * rule 8 and §15.11 (B43) do not use H-OP alone for routes there. (The writer's OP routes of two or more points do
 * not fit H-MAC48, whose 19-byte run they lack.)
 * @param {import('./writer.js').RouteSpec} rte
 * @param {Map<string, import('./writer.js').WaypointSpec[]>} waypointsByKey  surviving W records by (name bytes, class)
 * @param {number} programVersion  AllData.gdb's 'A' record program version
 * @returns {{points: ExpectedRoute['points']} | {reason: 'autoroute'|'not_decoded'|'via_unresolved'}}
 */
function expectRoute(rte, waypointsByKey, programVersion) {
  const via = rte.gdb?.via ?? [];
  if (rte.gdb?.layout === 'mac48') return expectRouteMac48(rte, waypointsByKey, programVersion);
  for (let i = 0; i < rte.points.length; i++) {
    if (via[i]?.badUnknown7) return { reason: 'not_decoded' };
    if (via[i]?.autoroute) return { reason: 'autoroute' };
  }
  if (programVersion === 408) {
    if (rte.points.length < 2) throw new RangeError('an OP route of fewer than two points in a 408 file is not settled here');
    return { reason: 'not_decoded' };
  }
  /** @type {ExpectedRoute['points']} */
  const points = [];
  for (let i = 0; i < rte.points.length; i++) {
    const p = rte.points[i];
    const v = via[i] ?? {};
    if (v.byName) {
      const hits = waypointsByKey.get(`${hex(encodeText(p.name))}/${v.class ?? 0}`) ?? [];
      if (hits.length !== 1) return { reason: 'via_unresolved' };
      points.push({ name: p.name, lat: semicirclesToDegrees(latToSemicircles(hits[0].lat)), lon: semicirclesToDegrees(lonToSemicircles(hits[0].lon)) });
    } else {
      points.push({ name: p.name, lat: semicirclesToDegrees(latToSemicircles(p.lat)), lon: semicirclesToDegrees(lonToSemicircles(p.lon)) });
    }
  }
  return { points };
}

/**
 * A Mac 4.8 route (§15.11): not decoded when a 19-byte run is not all 0 or the autoroute-settings flag is 1 (those fail
 * H-MAC48, and the writer's hooks avoid the bytes where H-OP would read an autoroute count). Otherwise every via point
 * but the last sits at its own position (its first link point), and the last (or one written by name) resolves
 * through the one surviving waypoint record of the same raw name and class. A route of 0 or 1 via points also fits OP's
 * layout (§15.11), so it is decoded only when the program version breaks the tie (§3.3 rule 8, B43): 1-408 do (both
 * layouts read the same via point), anything else does not.
 * @param {import('./writer.js').RouteSpec} rte
 * @param {Map<string, import('./writer.js').WaypointSpec[]>} waypointsByKey
 * @param {number} programVersion
 * @returns {{points: ExpectedRoute['points']} | {reason: 'not_decoded'|'via_unresolved'}}
 */
function expectRouteMac48(rte, waypointsByKey, programVersion) {
  const via = rte.gdb?.via ?? [];
  if (rte.gdb?.autorouteSettings) return { reason: 'not_decoded' };
  if (via.some((v) => v?.nonZeroRun !== undefined)) return { reason: 'not_decoded' };
  if (rte.points.length < 2 && !(Number.isInteger(programVersion) && programVersion >= 1 && programVersion <= 408)) {
    return { reason: 'not_decoded' };
  }
  /** @type {ExpectedRoute['points']} */
  const points = [];
  for (let i = 0; i < rte.points.length; i++) {
    const p = rte.points[i];
    const v = via[i] ?? {};
    if (i === rte.points.length - 1 || v.byName) {
      const hits = waypointsByKey.get(`${hex(encodeText(p.name))}/${v.class ?? 8}`) ?? [];
      if (hits.length !== 1) return { reason: 'via_unresolved' };
      points.push({ name: p.name, lat: semicirclesToDegrees(latToSemicircles(hits[0].lat)), lon: semicirclesToDegrees(lonToSemicircles(hits[0].lon)) });
    } else {
      points.push({ name: p.name, lat: semicirclesToDegrees(latToSemicircles(p.lat)), lon: semicirclesToDegrees(lonToSemicircles(p.lon)) });
    }
  }
  return { points };
}

/**
 * The folder tree per §8.4: F.children from the root (depth-first, file order), a visited set, a list's folder from
 * F.children, I.parent compared and reported, unreached lists under the root.
 * @param {import('./writer.js').LibrarySpec} lib
 * @param {ReturnType<typeof indexSpec>} idx
 * @param {Tally} problems
 * @param {Tally} counted
 * @param {(b: Uint8Array) => string} decode
 */
function expectTree(lib, idx, problems, counted, decode) {
  const gfi = lib.gfi ?? {};
  const rootId = gfi.rootId ?? ROOT_FOLDER_ID;
  if (rootId !== ROOT_FOLDER_ID || (gfi.rootParent ?? rootId) !== rootId) throw new RangeError('a non-standard root is not used by any scenario');
  const rootName = decode(encodeText(gfi.rootName ?? 'My Collection'));
  const folders = [...idx.folders.values()];
  /** @param {string|null} parentId */
  const kidsOf = (parentId) => {
    const key = parentId ?? '$root';
    if (gfi.children && key in gfi.children) return gfi.children[key];
    return folders.filter((f) => f.parentId === parentId).map((f) => /** @type {['folder'|'list', string|number]} */ ([f.type, f.id]));
  };
  for (const f of folders) {
    if (f.type === 'folder') {
      // §8.1: one byte (OP); §15.11: or the ten bytes Mac 4.8 writes.
      const tail = f.tail ? Array.from(f.tail) : gfi.folderTail === 'mac48' ? [...FOLDER_TAIL_MAC48] : [1];
      if (tail.length !== 1 && tail.length !== 10) counted.add('folder_tail_unexpected');
    } else {
      // §8.2 and §15.11: no tail for created-by 0; OP's 9 bytes for any other; 1, 0 (5 bytes) for a smart list too.
      const createdBy = f.createdBy ?? 0;
      const op = [1, 1, 0, 0, 0, 9, 0, 0, 0];
      const tail = f.tail ? Array.from(f.tail) : createdBy === 0 ? [] : createdBy === 3 ? [...SMART_LIST_TAIL] : op;
      const same = (/** @type {number[]} */ want) => tail.length === want.length && tail.every((b, i) => b === want[i]);
      const ok = createdBy === 0 ? tail.length === 0 : same(op) || (createdBy === 3 && same([...SMART_LIST_TAIL]));
      if (!ok) counted.add('list_tail_unexpected');
    }
  }
  // B40, §15.11: smart lists (created-by 3) are left out of the tree and place nothing; reported per list.
  for (const f of folders) if (f.type === 'list' && (f.createdBy ?? 0) === 3) problems.add('smart_lists_left_out');
  if (gfi.duplicateFolder) counted.add('duplicate_id');

  /** @type {Array<{path: string[], type: 'folder'|'list'}>} */
  const tree = [{ path: [rootName], type: 'folder' }];
  /** @type {Map<string, string[]>} */
  const listPath = new Map();
  /** @type {Map<string, string|null>} list id → folder id (null = root) that holds it per F.children */
  const listHolder = new Map();
  const visited = new Set();
  /**
   * @param {string|null} folderId
   * @param {string[]} path
   * @param {number} depth
   */
  const visit = (folderId, path, depth) => {
    if (depth > 64) throw new RangeError('scenario trees stay well inside the depth cap');
    for (const [type, id] of kidsOf(folderId)) {
      if (typeof id === 'number') {
        counted.add('dangling_child');
        continue;
      }
      const child = /** @type {import('./writer.js').FolderSpec} */ (idx.folders.get(id));
      if (type === 'folder') {
        if (visited.has(id)) {
          problems.add('folder_in_two_places');
          continue;
        }
        visited.add(id);
        const p = [...path, decode(encodeText(child.name))];
        tree.push({ path: p, type: 'folder' });
        visit(id, p, depth + 1);
      } else {
        if (listPath.has(id)) throw new RangeError('a list under two folders is not settled by FORMAT.md');
        const p = [...path, decode(encodeText(child.name))];
        listPath.set(id, p);
        listHolder.set(id, folderId);
        if ((child.createdBy ?? 0) !== 3) tree.push({ path: p, type: 'list' });
      }
    }
  };
  visit(null, [rootName], 0);
  for (const f of folders) {
    if (f.type === 'folder' && !visited.has(f.id)) throw new RangeError('folders no path reaches are not settled by FORMAT.md');
    if (f.type !== 'list') continue;
    const iParent = gfi.listParents && f.id in gfi.listParents ? gfi.listParents[f.id] : f.parentId;
    if (!listPath.has(f.id)) {
      if ((f.createdBy ?? 0) === 3) throw new RangeError('an unreached smart list is not used by any scenario');
      if (iParent !== null) throw new RangeError('an unreached list whose I.parent names a folder is not settled by FORMAT.md');
      problems.add('list_not_in_tree');
      const p = [rootName, decode(encodeText(f.name))];
      listPath.set(f.id, p);
      tree.push({ path: p, type: 'list' });
    } else if (listHolder.get(f.id) !== iParent) {
      problems.add('list_folder_disagreement');
    }
  }
  return { tree, listPath };
}

/**
 * Links GFI references to GDB items per §10 and §11.
 * @param {import('./writer.js').LibrarySpec} lib
 * @param {ReturnType<typeof indexSpec>} idx
 * @param {import('./writer.js').ItemSpec[]} survivors
 * @param {Map<string, string[]>} listPath
 * @param {Map<string, ExpectedItem>} exported
 * @param {Map<string, {kind: 'track', name: string, lists: string[][]}>} notDecoded
 * @param {Map<string, {name: string, reason: 'autoroute'|'not_decoded'|'via_unresolved', lists: string[][]}>} routesNot
 * @param {Expected['duplicates']} duplicates
 * @param {Tally} problems
 * @param {Tally} counted
 * @param {(b: Uint8Array) => string} decode
 */
function linkItems(lib, idx, survivors, listPath, exported, notDecoded, routesNot, duplicates, problems, counted, decode) {
  const letter = { waypoint: 'W', track: 'T', route: 'R' };
  /** @param {string} type @param {Uint8Array} name @param {number|null} cls */
  const keyOf = (type, name, cls) => `${type}/${hex(name)}/${type === 'W' ? cls : ''}`;
  /** @type {Map<string, import('./writer.js').ItemSpec[]>} */
  const byKey = new Map();
  for (const it of survivors) {
    const k = keyOf(letter[it.kind], gdbNameBytes(it), it.kind === 'waypoint' ? (it.gdb?.class ?? 0) : null);
    byKey.set(k, [...(byKey.get(k) ?? []), it]);
  }

  /** @type {Array<{type: string, list: string, name: Uint8Array, cls: number|null}>} */
  const refs = [];
  /** @param {string} listId  a smart list's references place nothing (B40, §15.11) */
  const smart = (listId) => (idx.folders.get(listId)?.createdBy ?? 0) === 3;
  for (const f of idx.folders.values()) {
    if (f.type !== 'list' || smart(f.id)) continue;
    for (const id of f.itemIds ?? []) {
      const it = /** @type {import('./writer.js').ItemSpec} */ (idx.items.get(id));
      refs.push({ type: letter[it.kind], list: f.id, name: gfiNameBytes(it), cls: it.kind === 'waypoint' ? (it.gdb?.class ?? 0) : null });
    }
  }
  for (const e of lib.gfi?.extraRefs ?? []) {
    if (smart(e.list)) continue;
    refs.push({ type: e.type, list: e.list, name: encodeText(e.name), cls: e.type === 'W' ? (e.class ?? 0) : null });
  }

  /** @type {Map<string, string[][]>} */
  const listsOf = new Map();
  /** @type {Map<string, string[][]>} */
  const dupRefs = new Map();
  for (const r of refs) {
    const path = /** @type {string[]} */ (listPath.get(r.list));
    if (r.type === 'K' || r.type === 'J') {
      counted.add('not_converted_kind');
      continue;
    }
    const key = keyOf(r.type, r.name, r.cls);
    let hits = byKey.get(key) ?? [];
    if (hits.length === 0) {
      // §11: raw bytes failed; compare NFC-normalised decoded text of the same type (and class).
      const want = decode(r.name).normalize('NFC');
      hits = survivors.filter((it) => letter[it.kind] === r.type &&
        (r.type !== 'W' || (it.gdb?.class ?? 0) === r.cls) &&
        decode(gdbNameBytes(it)).normalize('NFC') === want);
      if (hits.length > 1) throw new RangeError('a normalised match that hits several items is not settled by FORMAT.md');
      if (hits.length === 1) problems.add('name_matched_after_normalising');
    }
    if (hits.length === 0) {
      problems.add('listed_but_not_found');
    } else if (hits.length > 1) {
      dupRefs.set(key, [...(dupRefs.get(key) ?? []), path]);
    } else {
      const it = hits[0];
      if (it.kind === 'waypoint' && (it.gdb?.class ?? 0) > 1) throw new RangeError('a list referring to a class 2+ waypoint is not settled by FORMAT.md');
      listsOf.set(it.id, [...(listsOf.get(it.id) ?? []), path]);
    }
  }

  for (const [key, items] of byKey) {
    if (items.length < 2) continue;
    problems.add('duplicate_names');
    const first = items[0];
    duplicates.push({
      kind: first.kind,
      name: decode(gdbNameBytes(first)),
      class: first.kind === 'waypoint' ? (first.gdb?.class ?? 0) : null,
      copies: items.length,
      referencedBy: dupRefs.get(key) ?? [],
    });
    for (const it of items) {
      const e = exported.get(it.id);
      if (e) e.placement = 'duplicate-names';
      if (notDecoded.has(it.id) || routesNot.has(it.id)) throw new RangeError('undecoded duplicates are not settled by FORMAT.md');
    }
  }

  for (const it of survivors) {
    const lists = listsOf.get(it.id) ?? [];
    if (lists.length > 1) problems.add('item_in_several_lists');
    const target = exported.get(it.id) ?? notDecoded.get(it.id) ?? routesNot.get(it.id);
    if (!target) continue; // a waypoint class that is not exported
    target.lists = lists;
    const e = exported.get(it.id);
    if (e && e.placement !== 'duplicate-names') {
      e.placement = lists.length ? 'lists' : 'not-in-any-list';
      if (!lists.length) counted.add('not_in_any_list');
    }
  }
}
