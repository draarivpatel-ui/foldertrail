// Structure-only diagnostic dump (decision B23, ARCHITECTURE.md §11, FORMAT.md §13).
//
// This is what the founder and volunteers paste to us, so its privacy has to be airtight. It is built in two
// steps, and only the first one looks at the library:
//   1. buildDump() makes a plain data object from an ALLOW-LIST: numbers we computed (sizes, counts, lengths,
//      version numbers, bytes left over), booleans, and strings taken from fixed tables in this file. Nothing
//      read from a string field, no coordinate, time, ID value, UUID or path is ever copied into it.
//   2. The text and the JSON are both rendered from that object alone.
// The sentinel tests in test/dump.test.js plant unique names, coordinates, times and UUIDs in synthetic files
// and check that none of them reaches the output in any encoding.
//
// The layout walkers below are a second, structure-only implementation of FORMAT.md §5-§9 and §15.11: they consume bytes
// and check flags, and they return only an outcome (fits exactly, bytes left over, bytes missing, stopped),
// failed-check codes and presence notes, all from fixed vocabularies. Inside a walker, latitude and longitude
// integers live only as long as the bounds comparisons of FORMAT.md §6.4 need them. The dump exists before the
// W/T/R parsers are relied on (FORMAT.md §13), which is why it does not use them.

import { readHeader, PROBLEM_CODES, chooseLayout, programFamily } from './container.js';

export const DUMP_FORMAT = 'bcr-structure-dump';
export const DUMP_VERSION = 1;

const LAT_LIMIT = 2 ** 30; // |latitude| <= 90 degrees, in semicircles (FORMAT.md §2 rule 2)
const ROOT_FOLDER_ID = 0xffffffff;
const MAX_TREE_DEPTH = 64;
const MAX_PATTERNS = 32;
const MAX_TALLY_KEYS = 16; // distinct values kept per TrackSegments header tally; the rest are counted as "other"

// ---------------------------------------------------------------------------------------------
// Fixed vocabularies. Every string in the output comes from here, from FORMAT.md's field labels, or is a
// number turned into text.

const ENGINES = new Set(['WebKit', 'Blink', 'Gecko', 'Node']);
const INPUT_KINDS = new Set(['folder', 'zip', 'package', 'backup', 'files']);
const SIGNATURES = new Set(['MsRc', 'DifG']);
const APPLICATIONS = new Set(['BaseCamp', 'MapSource', 'HomePort', 'other']);
const VERSION_CLASSES = new Set(['exported', 'too_old', 'experimental', 'supported', 'unknown']);
const CONTAINER_PROBLEMS = new Set(PROBLEM_CODES);

/** What each record type is, by file kind (FORMAT.md §3.2, §8). */
const TYPE_NAMES = Object.freeze({
  gdb: {
    W: 'waypoint', T: 'track', R: 'route', V: 'map-set name', E: 'purpose unknown', X: 'end of file', A: 'author',
    D: 'file format', C: 'geocaching', G: 'image', O: 'BirdsEye', L: 'map section', j: 'image', J: 'BirdsEye',
    K: 'BirdsEye', F: 'folder', I: 'list',
  },
  gfi: {
    F: 'folder', I: 'list', T: 'track reference', W: 'waypoint reference', R: 'route reference',
    K: 'BirdsEye reference', J: 'BirdsEye reference', X: 'end of file',
  },
});

/** Record order per OP (FORMAT.md §3.3 rules 4 and 5). */
const ORDER = Object.freeze({
  gdb: ['W', 'R', 'T', 'G', 'O', 'L', 'j', 'J', 'C', 'V', 'E', 'X'],
  gfi: ['F', 'I', 'R', 'T', 'W', 'K', 'J'],
});

/** Plain words for the program families of decision B43 (container.js programFamily). */
const FAMILY_WORDS = Object.freeze({
  mac48: 'BaseCamp 4.8 for Mac, so H-MAC48 is preferred',
  older: 'an older BaseCamp, so H-KBM or H-OP is preferred',
  unknown: 'not a known version, so nothing is preferred',
});

/** Plain words for failure and check codes, used by the text rendering. */
const CODE_WORDS = Object.freeze({
  needs_more_bytes: 'the record ended too soon',
  count_too_large: 'a count is larger than the bytes left',
  text_runs_past_end: 'a text field runs past the end of the record',
  flag_not_0_or_1: 'a yes/no byte that decides what follows is not 0 or 1',
  not_0_or_1: 'a yes/no byte is not 0 or 1',
  not_0: 'a byte that should be 0 is not',
  not_1: 'a value that should be 1 is not',
  not_9: 'a value that should be 9 is not',
  not_ff: 'bytes that should all be FF are not',
  value_too_high: 'a value is higher than any seen so far',
  latitude_out_of_range: 'a latitude is beyond 90 degrees',
  uuid_shape: 'an identifier does not have the expected shape',
  phone_count_above_1: 'the phone count is above 1',
  unknown_field_present: 'a field of unknown size is present',
  subclass_present_size_unknown: 'a sub-block of unknown size is present',
  segment_min_above_max: "a segment's bounds are upside down",
  segment_outside_track: "a segment lies outside its track's bounds",
  point_outside_segment: "a point lies outside its segment's bounds",
  track_min_above_max: "a track's bounds are upside down",
  end_text_unexpected: 'the end-of-file record does not hold the usual text',
  autoroute_points: 'a route point has road-following points (not read in this version)',
  autoroute_settings: 'the route has road-following settings (not read in this version)',
  extra_byte_not_0: 'an extra byte that should be 0 is not (or a value of unknown size is present)',
  walker_failed: 'this layout could not be checked',
  other: 'a reason this version does not describe',
});

/** Plain words for presence notes, used by the text rendering (the JSON keeps the short keys). */
const NOTE_WORDS = Object.freeze({
  display_above_4: 'display mode above 4',
  address: 'address filled in',
  subclass_block: 'long sub-block (K13 = 1)',
  altitude: 'altitude',
  depth: 'depth',
  links: 'links',
  temperature: 'temperature',
  time_K18: 'time A (K18)',
  time_K22: 'time B (K22)',
  time_O16: 'time (O16)',
  phone: 'phone number',
  categories: 'categories',
  colour: 'color set',
  colour_above_17: 'color above 17',
  thumbnail: 'thumbnail',
  empty_segment: 'an empty segment',
  no_segments: 'no segments',
  total_equals_points: 'point total equals the points stored',
  total_equals_points_minus_joins: 'point total equals the points stored minus one per segment join',
  total_matches_neither: 'point total matches neither rule',
  segment_ends_shared: 'segments share their end points',
  segment_ends_not_shared: 'segments do not share their end points',
  track_bounds_tight: 'track bounds exactly tight',
  track_bounds_loose: 'track bounds loose',
  no_route_points: 'no route points',
  child_type_other: 'a child of another kind',
  created_by_0: 'made by the user (0)',
  created_by_1: 'made on import (1)',
  created_by_3: 'a smart list (3)',
  created_by_8: 'the Unlisted Data list (8)',
  created_by_other: 'made by another value',
  class_0: 'class 0',
  class_1: 'class 1',
  class_other: 'another class',
  heart_rate: 'heart rate',
  track_flag_elevation: 'track flag 1 set (has elevation)',
  track_flag_time: 'track flag 2 set (has time)',
  track_flags_3_4: 'track flags 3 or 4 set (temperature or heart rate)',
  track_flags_5_11: 'track flags 5 to 11 set',
  tail_value_a: 'track tail value A present',
  tail_value_b: 'track tail value B present',
  route_colour: 'route color set',
  activity_profile_other: 'activity profile other than 6',
  mac48_length: 'the Mac 4.8 length',
  mac48_tail: 'the Mac 4.8 tail',
  other: 'a note this version does not describe',
});

/**
 * Plain words for the problem codes of container.js and of the TrackSegments section, used by the text rendering
 * (the JSON keeps the codes). A code without words here is shown with its underscores turned into spaces.
 */
const PROBLEM_WORDS = Object.freeze({
  not_library_file: 'not a BaseCamp library file',
  wrong_file_kind: 'a different kind of BaseCamp file than the one expected here',
  bad_header: 'the header could not be read',
  author_record_unexpected: 'the author record is not laid out as expected',
  record_truncated: 'the file ends in the middle of a record',
  record_length_impossible: 'a record claims to be longer than the whole file',
  record_too_large: 'records larger than the size limit were skipped',
  empty_record: 'empty records',
  zero_padding: 'runs of zero bytes were skipped',
  unknown_record_type: 'records of a kind this tool does not know',
  data_after_end: 'bytes after the end-of-file record',
  too_many_records: 'more records than the limit (the rest were not read)',
  internal_error: 'something unexpected went wrong while reading',
  dump_failed: 'part of this report could not be made',
  no_point_count: 'the file ends before its point count',
  count_too_large: 'the point count is larger than the file',
  other: 'a problem this version does not describe',
});

// Codes and notes must be keys of the tables above, and field labels must be one of FORMAT.md's own labels (1-17,
// 8.1-8.9, K8-K24, O8-O18, G1, G2, P1-P17, §15's rows as "15.3.23", "15.4.19"-"15.4.23", "15.5.1"-"15.5.16" and
// "15.5.a"-"15.5.n", and the three TrackSegments point parts). A character-class check is not enough: replacement
// layouts (the real parsers) could otherwise put a decoded name, or a number such as "47.62", into a code, a field or a
// note.
const FIELD_RE =
  /^(?:[1-9]|1[0-7]|8\.[1-9]|K(?:[89]|1\d|2[0-4])|O(?:[89]|1[0-8])|G[12]|P(?:[1-9]|1[0-7])|15\.3\.23|15\.4\.(?:19|2[0-3])|15\.5\.(?:[1-9]|1[0-6]|[a-n])|elevation|time|extra)$/;
const OPAQUE_NOTE_RE = /^nonzero_([A-Za-z0-9.]+)$/;
const LABEL_RE = /^[A-Za-z0-9 .§-]{1,24}$/;

// ---------------------------------------------------------------------------------------------
// Cursor with sticky failure: after the first failure every read returns 0 and every count 0, so loops stop
// without exceptions and a hostile count costs nothing.

/**
 * @typedef {object} WalkResult
 * @property {"exact"|"left_over"|"missing"|"stopped"} outcome
 * @property {number} by           bytes left over, or (at least) bytes missing; 0 otherwise
 * @property {string|null} code    why the walk stopped (missing/stopped)
 * @property {string|null} field   FORMAT.md field label where it stopped
 * @property {string[]} checks     failed checks as "code@field" (unique)
 * @property {string[]} notes      presence notes (unique), fixed vocabulary
 */

class Cursor {
  /** @param {Uint8Array} body */
  constructor(body) {
    this.b = body;
    this.v = new DataView(body.buffer, body.byteOffset, body.byteLength);
    this.n = body.length;
    this.p = 0;
    this.ok = true;
    /** @type {WalkResult["outcome"]} */
    this.outcome = 'exact';
    this.by = 0;
    /** @type {string|null} */
    this.code = null;
    /** @type {string|null} */
    this.field = null;
    /** @type {string[]} */
    this.checks = [];
    /** @type {string[]} */
    this.notes = [];
  }

  /**
   * @param {number} k
   * @param {string} field
   * @returns {boolean} true when k more bytes are there
   */
  has(k, field) {
    if (!this.ok) return false;
    const left = this.n - this.p;
    if (k <= left) return true;
    this.ok = false;
    this.outcome = 'missing';
    this.by = k - left;
    this.code = 'needs_more_bytes';
    this.field = field;
    return false;
  }

  /**
   * @param {string} code
   * @param {string} field
   */
  halt(code, field) {
    if (!this.ok) return;
    this.ok = false;
    this.outcome = 'stopped';
    this.code = code;
    this.field = field;
  }

  /**
   * A failed check that does not stop the walk (the layout is then not accepted).
   * @param {string} code
   * @param {string} field
   */
  check(code, field) {
    if (!this.ok) return;
    const key = `${code}@${field}`;
    if (!this.checks.includes(key)) this.checks.push(key);
  }

  /** @param {string} key */
  note(key) {
    if (this.ok && !this.notes.includes(key)) this.notes.push(key);
  }

  /** @param {string} field */
  u8(field) {
    if (!this.has(1, field)) return 0;
    return this.b[this.p++];
  }

  /** @param {string} field */
  u16(field) {
    if (!this.has(2, field)) return 0;
    const value = this.v.getUint16(this.p, true);
    this.p += 2;
    return value;
  }

  /** @param {string} field */
  u32(field) {
    if (!this.has(4, field)) return 0;
    const value = this.v.getUint32(this.p, true);
    this.p += 4;
    return value;
  }

  /** @param {string} field */
  i32(field) {
    if (!this.has(4, field)) return 0;
    const value = this.v.getInt32(this.p, true);
    this.p += 4;
    return value;
  }

  /**
   * @param {number} k
   * @param {string} field
   */
  skip(k, field) {
    if (this.has(k, field)) this.p += k;
  }

  /**
   * Opaque bytes: never checked, only noted as zero or non-zero (FORMAT.md §5.3).
   * @param {number} k
   * @param {string} field
   */
  opaque(k, field) {
    if (!this.has(k, field)) return;
    if (!this.allEqual(k, 0)) this.note(`nonzero_${field}`);
    this.p += k;
  }

  /**
   * @param {number} k
   * @param {string} field
   */
  zeros(k, field) {
    if (!this.has(k, field)) return;
    if (!this.allEqual(k, 0)) this.check('not_0', field);
    this.p += k;
  }

  /**
   * @param {number} k
   * @param {string} field
   */
  allFF(k, field) {
    if (!this.has(k, field)) return;
    if (!this.allEqual(k, 0xff)) this.check('not_ff', field);
    this.p += k;
  }

  /**
   * @param {number} k
   * @param {number} value
   * @returns {boolean}
   */
  allEqual(k, value) {
    for (let i = 0; i < k; i++) if (this.b[this.p + i] !== value) return false;
    return true;
  }

  /**
   * A NUL-terminated string. Returns its byte length (without the NUL); the bytes are never looked at.
   * @param {string} field
   * @returns {number}
   */
  cstr(field) {
    if (!this.ok) return 0;
    const nul = this.b.indexOf(0, this.p);
    if (nul < 0) {
      this.halt('text_runs_past_end', field);
      return 0;
    }
    const length = nul - this.p;
    this.p = nul + 1;
    return length;
  }

  /**
   * A string compared with a fixed value, byte for byte. Only the yes/no answer leaves.
   * @param {Uint8Array} expected
   * @param {string} field
   * @returns {boolean}
   */
  cstrEquals(expected, field) {
    const start = this.p;
    const length = this.cstr(field);
    if (!this.ok || length !== expected.length) return false;
    for (let i = 0; i < length; i++) if (this.b[start + i] !== expected[i]) return false;
    return true;
  }

  /**
   * A presence flag that decides what follows: anything but 0 or 1 stops the walk.
   * @param {string} field
   * @returns {number}
   */
  flag(field) {
    const value = this.u8(field);
    if (value > 1) {
      this.halt('flag_not_0_or_1', field);
      return 0;
    }
    return value;
  }

  /**
   * A byte that must be 0 or 1 but decides nothing about the layout.
   * @param {string} field
   * @returns {number}
   */
  bit(field) {
    const value = this.u8(field);
    if (value > 1) this.check('not_0_or_1', field);
    return value;
  }

  /** @param {string} field */
  fdouble(field) {
    const present = this.flag(field);
    if (present) this.skip(8, field);
    return present;
  }

  /** @param {string} field */
  fint(field) {
    const present = this.flag(field);
    if (present) this.skip(4, field);
    return present;
  }

  /** @param {string} field */
  fstring(field) {
    const present = this.flag(field);
    if (present) this.cstr(field);
    return present;
  }

  /** @param {string} field */
  lat(field) {
    const value = this.i32(field);
    if (value < -LAT_LIMIT || value > LAT_LIMIT) this.check('latitude_out_of_range', field);
    return value;
  }

  /**
   * A u32 count whose elements take at least `minSize` bytes each; checked before any loop.
   * @param {number} minSize
   * @param {string} field
   * @returns {number}
   */
  count(minSize, field) {
    const n = this.u32(field);
    if (!this.ok) return 0;
    const need = n * minSize;
    const left = this.n - this.p;
    if (need > left) {
      this.ok = false;
      this.outcome = 'missing';
      this.by = need - left;
      this.code = 'count_too_large';
      this.field = field;
      return 0;
    }
    return n;
  }

  /**
   * u32 n, then n strings (links, categories).
   * @param {string} field
   * @returns {number}
   */
  strings(field) {
    const n = this.count(1, field);
    for (let i = 0; i < n && this.ok; i++) this.cstr(field);
    return n;
  }

  /**
   * 36 ASCII characters 8-4-4-4-12 hex digits, then a NUL (FORMAT.md §2). The shape is checked; the value is
   * never kept.
   * @param {string} field
   */
  uuid(field) {
    if (!this.has(37, field)) return;
    const at = this.p;
    let good = this.b[at + 36] === 0;
    for (let i = 0; i < 36 && good; i++) {
      const c = this.b[at + i];
      if (i === 8 || i === 13 || i === 18 || i === 23) good = c === 0x2d;
      else good = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
    }
    if (!good) this.check('uuid_shape', field);
    this.p += 37;
  }

  /** @returns {WalkResult} */
  result() {
    if (this.ok && this.p < this.n) {
      this.outcome = 'left_over';
      this.by = this.n - this.p;
    }
    return { outcome: this.outcome, by: this.by, code: this.code, field: this.field, checks: this.checks, notes: this.notes };
  }
}

// ---------------------------------------------------------------------------------------------
// Walkers. Field labels are FORMAT.md's own: numbers from its tables, K8-K24 and O8-O18 for the waypoint
// tails, G1/G2 for the track gaps, P1-P17 for route-point rows (§7.2, in table order) and 8.1-8.9 for the
// route trailer items (§7.3).

/** @typedef {(body: Uint8Array) => WalkResult} Walker */
/** @typedef {{ label: string, walk: Walker }} Layout */

/** @param {Cursor} c */
function waypointPrefix(c) {
  c.cstr('1');
  c.u32('2');
  c.lat('3');
  c.i32('3');
  c.cstr('4');
  c.fdouble('5');
  if (c.u32('6') > 4) c.note('display_above_4');
  c.u32('7');
}

/** @type {Walker} */
function waypointKbm(body) {
  return walkWaypointKbm(body, false);
}

/** H-MAC48 (FORMAT.md §15.11): the H-KBM tail, then 8 opaque bytes. @type {Walker} */
function waypointMac48(body) {
  return walkWaypointKbm(body, true);
}

/**
 * @param {Uint8Array} body
 * @param {boolean} mac48
 * @returns {WalkResult}
 */
function walkWaypointKbm(body, mac48) {
  const c = new Cursor(body);
  waypointPrefix(c);
  let address = 0;
  for (const field of ['K8', 'K9', 'K10', 'K11', 'K12']) address += c.cstr(field);
  if (address > 0) c.note('address');
  if (c.flag('K13') === 1) {
    c.note('subclass_block');
    c.opaque(24, 'K13');
  } else {
    c.bit('K13');
  }
  if (c.fdouble('K14')) c.note('altitude');
  if (c.fdouble('K15')) c.note('depth');
  if (c.strings('K16') > 0) c.note('links');
  if (c.fdouble('K17')) c.note('temperature');
  if (c.fint('K18')) c.note('time_K18');
  c.opaque(6, 'K19');
  const phones = c.u32('K20');
  if (phones > 1) {
    c.halt('phone_count_above_1', 'K20');
  } else if (phones === 1) {
    c.note('phone');
    c.cstr('K21');
    c.opaque(1, 'K21');
  }
  if (c.fint('K22')) c.note('time_K22');
  c.opaque(3, 'K23');
  if (c.strings('K24') > 0) c.note('categories');
  if (mac48) c.opaque(8, '15.3.23');
  return c.result();
}

/** @type {Walker} */
function waypointOp(body) {
  const c = new Cursor(body);
  waypointPrefix(c);
  const colour = c.u32('O8');
  if (colour > 17) c.note('colour_above_17');
  else if (colour > 0) c.note('colour');
  const unknown1 = c.u8('O9');
  if (unknown1 === 1) c.halt('unknown_field_present', 'O9');
  else if (unknown1 > 1) c.check('not_0', 'O9');
  for (const field of ['O10', 'O11']) {
    const present = c.u8(field);
    if (present === 1) c.halt('subclass_present_size_unknown', field);
    else if (present > 1) c.halt('flag_not_0_or_1', field);
  }
  if (c.fdouble('O12')) c.note('altitude');
  if (c.u8('O13') !== 0) c.check('not_0', 'O13');
  if (c.strings('O14') > 0) c.note('links');
  if (c.fdouble('O15')) c.note('temperature');
  if (c.fint('O16')) c.note('time_O16');
  if (c.u8('O17') !== 0) c.check('not_0', 'O17');
  if (c.flag('O18') === 1) {
    c.note('thumbnail');
    c.cstr('O18');
    c.uuid('O18');
    c.zeros(8, 'O18');
  }
  return c.result();
}

/**
 * GDB 'T' (FORMAT.md §6), with the mandatory bounds checks of §6.4; with `mac48`, H-KBM plus the Mac 4.8 tail
 * (§15.11).
 * @param {Uint8Array} body
 * @param {boolean} kbm  H-KBM reads the two 4-byte gaps G1 and G2
 * @param {boolean} [mac48]
 * @returns {WalkResult}
 */
function walkTrack(body, kbm, mac48 = false) {
  const c = new Cursor(body);
  c.cstr('1');
  c.bit('2');
  if (kbm) c.opaque(4, 'G1');
  c.u32('3');
  c.strings('4');
  c.cstr('5');
  c.skip(8, '6');
  c.fdouble('7');
  c.bit('8');
  const trackMaxLat = c.lat('9');
  const trackMaxLon = c.i32('9');
  const trackMinLat = c.lat('10');
  const trackMinLon = c.i32('10');
  c.fdouble('11');
  c.skip(8, '12');
  c.fint('13');
  if (kbm) c.opaque(4, 'G2');
  const segments = c.count(21, '14');

  let points = 0;
  let nonEmpty = 0;
  let joinsChecked = 0;
  let joinsShared = 0;
  let lastLat = 0;
  let lastLon = 0;
  let previousNonEmpty = false;
  let allNonEmpty = true;
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  for (let s = 0; s < segments && c.ok; s++) {
    c.bit('15');
    const segMaxLat = c.lat('15');
    const segMaxLon = c.i32('15');
    const segMinLat = c.lat('15');
    const segMinLon = c.i32('15');
    const n = c.count(8, '15');
    if (!c.ok) break;
    if (n === 0) {
      c.note('empty_segment');
      allNonEmpty = false;
      previousNonEmpty = false;
      continue;
    }
    nonEmpty++;
    if (segMinLat > segMaxLat || segMinLon > segMaxLon) c.check('segment_min_above_max', '15');
    if (segMinLat < trackMinLat || segMinLon < trackMinLon || segMaxLat > trackMaxLat || segMaxLon > trackMaxLon) {
      c.check('segment_outside_track', '15');
    }
    for (let i = 0; i < n; i++) {
      const lat = c.lat('15');
      const lon = c.i32('15');
      if (lat < segMinLat || lat > segMaxLat || lon < segMinLon || lon > segMaxLon) c.check('point_outside_segment', '15');
      if (i === 0 && previousNonEmpty) {
        joinsChecked++;
        if (lat === lastLat && lon === lastLon) joinsShared++;
      }
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      lastLat = lat;
      lastLon = lon;
    }
    points += n;
    previousNonEmpty = true;
  }
  if (nonEmpty > 0 && (trackMinLat > trackMaxLat || trackMinLon > trackMaxLon)) c.check('track_min_above_max', '9');
  const total = c.u32('16');
  c.uuid('17');
  if (mac48) {
    c.opaque(3, '15.4.19');
    /** @type {number[]} */
    const flags = [];
    for (let i = 0; i < 11; i++) flags.push(c.flag('15.4.20'));
    if (flags[0]) c.note('track_flag_elevation');
    if (flags[1]) c.note('track_flag_time');
    if (flags[2] || flags[3]) c.note('track_flags_3_4');
    if (flags.slice(4).some((f) => f === 1)) c.note('track_flags_5_11');
    if (c.fdouble('15.4.21')) c.note('tail_value_a');
    if (c.fdouble('15.4.22')) c.note('tail_value_b');
    c.opaque(8, '15.4.23');
  }

  if (c.ok) {
    // §6.4 g: never an acceptance rule, only noted.
    if (total === points) c.note('total_equals_points');
    else if (segments > 1 && total === points - (segments - 1)) c.note('total_equals_points_minus_joins');
    else c.note('total_matches_neither');
    if (segments > 1 && allNonEmpty && joinsChecked === segments - 1) {
      c.note(joinsShared === joinsChecked ? 'segment_ends_shared' : 'segment_ends_not_shared');
    }
    if (nonEmpty > 0) {
      const tight = minLat === trackMinLat && maxLat === trackMaxLat && minLon === trackMinLon && maxLon === trackMaxLon;
      c.note(tight ? 'track_bounds_tight' : 'track_bounds_loose');
    }
    if (segments === 0) c.note('no_segments');
  }
  return c.result();
}

/** @type {Walker} */
const trackKbm = (body) => walkTrack(body, true);
/** @type {Walker} */
const trackOp = (body) => walkTrack(body, false);
/** @type {Walker} */
const trackMac48 = (body) => walkTrack(body, true, true);

/** GDB 'R', OP's ≥ 1.46 layout (FORMAT.md §7), including the trailer when it can be read. @type {Walker} */
function route(body) {
  const c = new Cursor(body);
  c.cstr('1');
  c.bit('2');
  const routePoints = c.count(43, '3');
  for (let i = 0; i < routePoints && c.ok; i++) {
    c.cstr('P1');
    c.u32('P2');
    c.fstring('P3');
    if (c.u32('P4') > 3) c.check('value_too_high', 'P4');
    c.skip(4, 'P5');
    c.skip(4, 'P6');
    c.skip(2, 'P7');
    if (c.u32('P8') > 2) c.check('value_too_high', 'P8');
    const links = c.count(8, 'P9');
    for (let l = 0; l < links && c.ok; l++) {
      c.lat('P10');
      c.i32('P10');
    }
    if (c.flag('P11') === 0) {
      c.lat('P12');
      c.i32('P12');
      c.lat('P12');
      c.i32('P12');
    }
    c.allFF(8, 'P13');
    c.fint('P14');
    if (c.fint('P15')) c.fdouble('P16');
    if (c.u32('P17') > 0) c.halt('autoroute_points', 'P17');
  }
  c.zeros(3, '5');
  if (c.flag('6') === 0) {
    c.lat('7');
    c.i32('7');
    c.lat('7');
    c.i32('7');
  }
  c.strings('8.1');
  c.u32('8.2');
  if (c.flag('8.3') === 1) c.halt('autoroute_settings', '8.3');
  c.cstr('8.4');
  c.bit('8.5');
  const filtered = c.count(8, '8.6');
  c.skip(filtered * 8, '8.6');
  if (c.flag('8.7') === 0) c.skip(16, '8.7');
  if (c.u8('8.8') !== 0) c.check('not_0', '8.8');
  if (c.u32('8.9') > 6) c.check('value_too_high', '8.9');
  if (c.ok && routePoints === 0) c.note('no_route_points');
  return c.result();
}

/** GDB 'R', the Mac 4.8 layout (FORMAT.md §15.5, §15.11), read to the end of the record. @type {Walker} */
function routeMac48(body) {
  const c = new Cursor(body);
  c.cstr('15.5.1');
  c.bit('15.5.2');
  const routePoints = c.count(56, '15.5.3');
  for (let i = 0; i < routePoints && c.ok; i++) {
    c.cstr('15.5.a');
    c.u32('15.5.b');
    c.fstring('15.5.c');
    c.skip(18, '15.5.d');
    const links = c.count(8, '15.5.i');
    for (let l = 0; l < links && c.ok; l++) {
      c.lat('15.5.j');
      c.i32('15.5.j');
    }
    if (c.flag('15.5.k') === 0) {
      c.lat('15.5.l');
      c.i32('15.5.l');
      c.lat('15.5.l');
      c.i32('15.5.l');
    }
    c.allFF(8, '15.5.m');
    c.zeros(19, '15.5.n');
  }
  if (c.flag('15.5.5') === 0) {
    c.lat('15.5.6');
    c.i32('15.5.6');
    c.lat('15.5.6');
    c.i32('15.5.6');
  }
  if (c.strings('15.5.7') > 0) c.note('links');
  if (c.u32('15.5.8') !== 0) c.note('route_colour');
  if (c.flag('15.5.9') === 1) c.halt('autoroute_settings', '15.5.9');
  c.cstr('15.5.10');
  c.bit('15.5.11');
  const filtered = c.count(8, '15.5.12');
  for (let f = 0; f < filtered && c.ok; f++) {
    c.lat('15.5.12');
    c.i32('15.5.12');
  }
  if (c.flag('15.5.13') === 0) {
    // Two positions, latitudes checked, as the reader does (gdb.js routeMac48).
    c.lat('15.5.13');
    c.i32('15.5.13');
    c.lat('15.5.13');
    c.i32('15.5.13');
  }
  c.opaque(1, '15.5.14');
  if (c.u32('15.5.15') !== 6) c.note('activity_profile_other');
  c.opaque(10, '15.5.16');
  if (c.ok && routePoints === 0) c.note('no_route_points');
  return c.result();
}

/** @type {Walker} */
function mapSetName(body) {
  const c = new Cursor(body);
  c.cstr('1');
  c.bit('2');
  return c.result();
}

/** 'E': OP's u32 0, or Mac 4.8's 8 zero bytes (FORMAT.md §15.6, §15.11). @type {Walker} */
function recordE(body) {
  const c = new Cursor(body);
  const size = body.length === 8 ? 8 : 4;
  c.zeros(size, '1');
  if (size === 8) c.note('mac48_length');
  return c.result();
}

const END_OF_FILE = Uint8Array.from('EndOfFile', (ch) => ch.charCodeAt(0));

/** @type {Walker} */
function endOfFile(body) {
  const c = new Cursor(body);
  const usual = c.cstrEquals(END_OF_FILE, '1');
  if (c.ok && !usual) c.check('end_text_unexpected', '1');
  return c.result();
}

/** GFI 'F' (FORMAT.md §8.1). @type {Walker} */
function folder(body) {
  const c = new Cursor(body);
  c.u32('1');
  c.cstr('2');
  c.u32('3');
  const children = c.count(8, '4');
  for (let i = 0; i < children && c.ok; i++) {
    if (c.u32('5') > 1) c.note('child_type_other');
    c.u32('5');
  }
  if (c.u8('6') !== 1) c.check('not_1', '6');
  // Mac 4.8 adds nine bytes (u32, i32 time, u8; FORMAT.md §15.8, §15.11): skipped, never kept.
  if (c.ok && c.n - c.p === 9) {
    c.skip(9, '6');
    c.note('mac48_tail');
  }
  return c.result();
}

/** GFI 'I' (FORMAT.md §8.2). @type {Walker} */
function list(body) {
  const c = new Cursor(body);
  c.u32('1');
  c.cstr('2');
  const createdBy = c.u32('3');
  c.u32('4');
  if (createdBy === 3 && c.n - c.p === 5) {
    // A smart list on Mac 4.8 (FORMAT.md §15.8, §15.11): u8 1, u32 0.
    if (c.u8('5') !== 1) c.check('not_1', '5');
    if (c.u32('6') !== 0) c.check('not_0', '6');
  } else if (createdBy !== 0) {
    if (c.u8('5') !== 1) c.check('not_1', '5');
    if (c.u32('6') !== 1) c.check('not_1', '6');
    if (c.u32('7') !== 9) c.check('not_9', '7');
  }
  c.note(createdBy === 0 || createdBy === 1 || createdBy === 3 || createdBy === 8 ? `created_by_${createdBy}` : 'created_by_other');
  return c.result();
}

/** GFI 'T' reference (FORMAT.md §8.3): parent item ID, name, u32 Unknown1 (0 or 1). @type {Walker} */
function trackReference(body) {
  const c = new Cursor(body);
  c.u32('1');
  c.cstr('2');
  if (c.u32('3') > 1) c.check('not_0_or_1', '3');
  return c.result();
}

/** @type {Walker} */
function waypointReference(body) {
  const c = new Cursor(body);
  c.u32('1');
  c.cstr('2');
  const cls = c.u32('3');
  c.note(cls === 0 || cls === 1 ? `class_${cls}` : 'class_other');
  return c.result();
}

/** @type {Walker} */
function routeReference(body) {
  const c = new Cursor(body);
  c.u32('1');
  c.cstr('2');
  c.bit('3');
  return c.result();
}

/** @type {Walker} */
function birdsEyeReference(body) {
  const c = new Cursor(body);
  c.u32('1');
  c.cstr('2');
  return c.result();
}

/**
 * The layouts the dump tries, by file kind and record type. W and T have three hypotheses and R two (FORMAT.md §3.3,
 * §15.11). E, F and I have one walker each that accepts both OP's and Mac 4.8's lengths, as the reader does.
 */
export const DEFAULT_LAYOUTS = Object.freeze({
  gdb: Object.freeze({
    W: [{ label: 'H-KBM', walk: waypointKbm }, { label: 'H-OP', walk: waypointOp }, { label: 'H-MAC48', walk: waypointMac48 }],
    T: [{ label: 'H-KBM', walk: trackKbm }, { label: 'H-OP', walk: trackOp }, { label: 'H-MAC48', walk: trackMac48 }],
    R: [{ label: 'H-OP', walk: route }, { label: 'H-MAC48', walk: routeMac48 }],
    V: [{ label: 'FORMAT.md §3.2', walk: mapSetName }],
    E: [{ label: 'FORMAT.md §3.2', walk: recordE }],
    X: [{ label: 'FORMAT.md §3.2', walk: endOfFile }],
  }),
  gfi: Object.freeze({
    F: [{ label: 'FORMAT.md §8.1', walk: folder }],
    I: [{ label: 'FORMAT.md §8.2', walk: list }],
    T: [{ label: 'FORMAT.md §8.3', walk: trackReference }],
    W: [{ label: 'FORMAT.md §8.3', walk: waypointReference }],
    R: [{ label: 'FORMAT.md §8.3', walk: routeReference }],
    K: [{ label: 'FORMAT.md §8.3', walk: birdsEyeReference }],
    J: [{ label: 'FORMAT.md §8.3', walk: birdsEyeReference }],
  }),
});

// ---------------------------------------------------------------------------------------------
// Public API

/**
 * @typedef {object} DumpInput
 * @property {string} [toolVersion]   e.g. "0.1.0"; anything that is not a plain version number shows as "other"
 * @property {string} [engine]        "WebKit", "Blink", "Gecko" or "Node"; anything else shows as "other"
 * @property {number} [engineMajor]   the engine's major version number
 * @property {string} [inputKind]     "folder", "zip", "package", "backup" or "files"; anything else "other"
 * @property {import('./container.js').ContainerResult|null} [allData]     readContainer(AllData.gdb, {role:"gdb"}), records kept
 * @property {import('./container.js').ContainerResult|null} [folderData]  readContainer(FolderData.gfi, {role:"gfi"})
 * @property {Array<Uint8Array|ArrayBuffer|{size: number}>|null} [trackSegments]  the files in TrackSegments/, as bytes or as
 *   sizes only; null or absent when there is no TrackSegments folder. Their names are not wanted.
 * @property {{count?: number, bytes?: number}} [otherFiles]  every other file that came with the library
 */

/**
 * @typedef {object} DumpOptions
 * @property {Record<"gdb"|"gfi", Record<string, Layout[]>>} [layouts]  replace the built-in layout walkers
 *   (for example with the real parsers, so both can be compared). Labels, codes and field labels they return
 *   are filtered through strict patterns before they reach the output.
 */

/**
 * Builds the structure-only dump. Never throws for bad data: a part that cannot be analysed is reported as such.
 * @param {DumpInput} input
 * @param {DumpOptions} [options]
 * @returns {{ data: object, json: string, text: string }}
 */
export function buildDump(input, options = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const layouts = (options && typeof options === 'object' && options.layouts) || DEFAULT_LAYOUTS;
  const data = {
    format: DUMP_FORMAT,
    version: DUMP_VERSION,
    privacy: 'Structure only: sizes, counts, lengths and version numbers. No names, notes, places, coordinates, times, IDs or file paths.',
    tool: { version: toolVersion(source.toolVersion) },
    environment: {
      engine: typeof source.engine === 'string' && ENGINES.has(source.engine) ? source.engine : 'other',
      engineMajor: smallInt(source.engineMajor, 9999),
    },
    input: {
      kind: typeof source.inputKind === 'string' && INPUT_KINDS.has(source.inputKind) ? source.inputKind : 'other',
      otherFiles: count(source.otherFiles?.count),
      otherFileBytes: count(source.otherFiles?.bytes),
    },
    files: {
      'AllData.gdb': containerSection(source.allData, 'gdb', layouts),
      'FolderData.gfi': containerSection(source.folderData, 'gfi', layouts),
      TrackSegments: trackSegmentsSection(source.trackSegments),
    },
  };
  return { data, json: `${JSON.stringify(data, null, 2)}\n`, text: renderText(data) };
}

/**
 * Which of Garmin's fixed names a path ends in. Used to count files by role; the path itself goes nowhere.
 * @param {string} path  "/"- or "\"-separated
 * @returns {"AllData.gdb"|"FolderData.gfi"|"TrackSegments"|"other"}
 */
export function classifyLibraryPath(path) {
  if (typeof path !== 'string') return 'other';
  const parts = path.split(/[\\/]+/).filter((part) => part.length > 0);
  const name = (parts[parts.length - 1] ?? '').toLowerCase();
  const parent = (parts[parts.length - 2] ?? '').toLowerCase();
  if (name === 'alldata.gdb') return 'AllData.gdb';
  if (name === 'folderdata.gfi') return 'FolderData.gfi';
  if (parent === 'tracksegments' && !name.startsWith('.')) return 'TrackSegments';
  return 'other';
}

// ---------------------------------------------------------------------------------------------
// Container files

/**
 * @param {unknown} container
 * @param {"gdb"|"gfi"} kind
 * @param {Record<"gdb"|"gfi", Record<string, Layout[]>>} layouts
 */
function containerSection(container, kind, layouts) {
  if (!container || typeof container !== 'object') return { present: false };
  const c = /** @type {Record<string, any>} */ (container);
  const section = {
    present: true,
    size: count(c.size),
    readable: c.ok === true,
    signature: signatureLabel(c.signature, c.signatureHex),
    expectedSignature: kind === 'gdb' ? 'MsRc' : 'DifG',
    containerFormat: smallInt(c.primaryFormat, 0xffff),
    fileFormat: smallInt(c.formatVersion, 0xffff),
    fileFormatClass: typeof c.versionClass === 'string' && VERSION_CLASSES.has(c.versionClass) ? c.versionClass : null,
    programVersion: smallInt(c.programVersion, 0xffff),
    application: typeof c.application === 'string' && APPLICATIONS.has(c.application) ? c.application : null,
    authorRecordAsExpected: typeof c.authorRecordAsExpected === 'boolean' ? c.authorRecordAsExpected : null,
    headerBytes: c.ok === true ? count(c.bodyStart) : null,
    readToEnd: c.complete === true,
    endRecord: {
      present: c.end?.present === true,
      bytesAfter: count(c.end?.bytesAfter) ?? 0,
    },
    zeroBytesSkipped: count(c.zeroBytes) ?? 0,
    problems: problemList(c.problems),
    recordCount: count(c.recordCount) ?? 0,
    recordsAnalysed: 0,
    orderViolations: 0,
    recordTypes: /** @type {Record<string, object>} */ ({}),
    /** @type {object|null} */
    tree: null,
  };
  try {
    const records = Array.isArray(c.records) ? c.records : [];
    const kindLayouts = layouts && typeof layouts === 'object' ? layouts[kind] : null;
    // Only AllData.gdb's program version breaks layout ties (decision B43); a number, never shown beyond its value.
    const programVersion = kind === 'gdb' ? smallInt(c.programVersion, 0xffff) : null;
    const analysis = analyseRecords(records, kind, kindLayouts && typeof kindLayouts === 'object' ? kindLayouts : {}, programVersion);
    section.recordsAnalysed = analysis.analysed;
    section.orderViolations = analysis.orderViolations;
    section.recordTypes = analysis.types;
    if (kind === 'gfi') section.tree = treeShape(records);
  } catch {
    section.problems.push({ code: 'dump_failed', count: 1 });
  }
  return section;
}

/**
 * @param {unknown[]} records
 * @param {"gdb"|"gfi"} kind
 * @param {Record<string, Layout[]>} kindLayouts
 * @param {number|null} programVersion  AllData.gdb's program version (decision B43), null for FolderData.gfi
 */
function analyseRecords(records, kind, kindLayouts, programVersion) {
  const rank = new Map(ORDER[kind].map((t, i) => [t, i]));
  /** @type {Map<string, TypeStats>} */
  const stats = new Map();
  let highestRank = -1;
  let orderViolations = 0;
  let analysed = 0;
  for (const raw of records) {
    const record = /** @type {Record<string, any>} */ (raw);
    const typeCode = record?.typeCode;
    const length = record?.length;
    if (!Number.isInteger(typeCode) || typeCode < 0 || typeCode > 255 || !Number.isSafeInteger(length) || length < 0) continue;
    const key = typeKey(typeCode);
    let entry = stats.get(key);
    if (!entry) {
      entry = new TypeStats(kind, key, Object.prototype.hasOwnProperty.call(kindLayouts, key) ? kindLayouts[key] : [], programVersion);
      stats.set(key, entry);
    }
    const r = rank.get(key);
    if (r !== undefined) {
      if (r < highestRank) orderViolations++;
      else highestRank = r;
    }
    /** @type {unknown} */
    let body = null;
    try {
      body = record.body;
    } catch {
      body = null;
    }
    entry.add(length, body instanceof Uint8Array && body.length === length ? body : null);
    analysed++;
  }
  /** @type {Record<string, object>} */
  const types = {};
  for (const key of [...stats.keys()].sort(compareTypeKeys)) types[key] = /** @type {TypeStats} */ (stats.get(key)).toJSON();
  return { analysed, orderViolations, types };
}

class TypeStats {
  /**
   * @param {"gdb"|"gfi"} kind
   * @param {string} key
   * @param {Layout[]} layouts
   * @param {number|null} [programVersion]  breaks ties for AllData.gdb's W, T and R records (decision B43)
   */
  constructor(kind, key, layouts, programVersion = null) {
    this.kind = kind;
    this.key = key;
    this.layouts = (Array.isArray(layouts) ? layouts : []).filter(
      (l) => l && typeof l.walk === 'function' && typeof l.label === 'string' && LABEL_RE.test(l.label),
    );
    this.count = 0;
    this.bytes = 0;
    /** @type {number[]} */
    this.lengths = [];
    this.notWalked = 0;
    this.layoutStats = this.layouts.map(() => new LayoutStats());
    this.onlyOne = this.layouts.map(() => 0);
    this.none = 0;
    this.several = 0;
    /** The tie-break of decision B43 (chooseLayout in container.js) applies to these record types only. */
    this.tieBreak = kind === 'gdb' && (key === 'W' || key === 'T' || key === 'R') && this.layouts.length > 1;
    this.programVersion = this.tieBreak ? programVersion : null;
    this.byProgramVersion = this.layouts.map(() => 0);
    this.stillSeveral = 0;
    this.refusedForVersion = 0;
    /** @type {Map<string, number>|null} */
    this.classes = key === 'W' && kind === 'gdb' ? new Map() : null;
  }

  /**
   * @param {number} length
   * @param {Uint8Array|null} body
   */
  add(length, body) {
    this.count++;
    this.bytes += length;
    this.lengths.push(length);
    if (this.layouts.length === 0) return;
    if (!body) {
      this.notWalked++;
      return;
    }
    if (this.classes) bump(this.classes, waypointClass(body));
    let accepted = 0;
    let which = -1;
    /** @type {string[]} */
    const fits = [];
    for (let i = 0; i < this.layouts.length; i++) {
      const result = safeWalk(this.layouts[i].walk, body);
      if (this.layoutStats[i].add(result)) {
        accepted++;
        which = i;
        fits.push(this.layouts[i].label);
      }
    }
    if (this.layouts.length > 1) {
      if (accepted === 1) this.onlyOne[which]++;
      else if (accepted === 0) this.none++;
      else this.several++;
    }
    if (this.tieBreak) {
      const pick = chooseLayout(/** @type {"W"|"T"|"R"} */ (this.key), fits, this.programVersion);
      if (pick.decision === 'program_version') this.byProgramVersion[this.layouts.findIndex((l) => l.label === pick.layout)]++;
      else if (pick.decision === 'several') this.stillSeveral++;
      else if (pick.decision === 'not_for_version') this.refusedForVersion++;
    }
  }

  toJSON() {
    const kindNames = /** @type {Record<string, Record<string, string>>} */ (TYPE_NAMES)[this.kind];
    const known = Object.prototype.hasOwnProperty.call(kindNames, this.key);
    /** @type {Record<string, any>} */
    const out = {
      name: known ? kindNames[this.key] : 'not known',
      count: this.count,
      bytes: this.bytes,
      // A type byte this tool does not know is most often a misframed byte, and then its "length" is four bytes
      // of other data (a latitude, an ID, a time) read as a number. Only the power-of-two buckets are kept for it.
      length: known ? lengthSummary(this.lengths) : { ...lengthSummary(this.lengths), min: null, median: null, max: null },
    };
    if (this.classes) out.waypointClass = sortedObject(this.classes);
    if (this.layouts.length === 0) {
      out.layouts = null;
      return out;
    }
    if (this.notWalked > 0) out.notChecked = this.notWalked;
    /** @type {Record<string, object>} */
    const layouts = {};
    this.layouts.forEach((layout, i) => {
      layouts[layout.label] = this.layoutStats[i].toJSON();
    });
    out.layouts = layouts;
    if (this.layouts.length > 1) {
      /** @type {Record<string, number>} */
      const onlyOne = {};
      this.layouts.forEach((layout, i) => {
        onlyOne[layout.label] = this.onlyOne[i];
      });
      out.verdict = { matchedOnlyOne: onlyOne, matchedNone: this.none, matchedMoreThanOne: this.several };
    }
    if (this.tieBreak) {
      /** @type {Record<string, number>} */
      const decided = {};
      this.layouts.forEach((layout, i) => {
        decided[layout.label] = this.byProgramVersion[i];
      });
      // Decision B43: which family the program version names, what it decided among the records that matched more
      // than one layout, and (routes) how many matched only H-OP in a Mac 4.8 file and were therefore not used.
      out.tieBreak = {
        programVersion: programFamily(this.programVersion),
        decidedByProgramVersion: decided,
        stillMoreThanOne: this.stillSeveral,
        refusedForProgramVersion: this.refusedForVersion,
      };
    }
    return out;
  }
}

class LayoutStats {
  constructor() {
    this.accepted = 0;
    this.exactButFailedCheck = 0;
    /** @type {Map<string, number>} */
    this.leftOver = new Map();
    /** @type {Map<string, number>} */
    this.missing = new Map();
    /** @type {Map<string, number>} where the too-short records ran out */
    this.missingAt = new Map();
    /** @type {Map<string, number>} */
    this.stopped = new Map();
    /** @type {Map<string, number>} */
    this.checksFailed = new Map();
    /** @type {Map<string, number>} */
    this.notes = new Map();
  }

  /**
   * @param {WalkResult|null} result
   * @returns {boolean} accepted
   */
  add(result) {
    if (!result) {
      bump(this.stopped, 'walker_failed');
      return false;
    }
    const checks = Array.isArray(result.checks) ? result.checks : [];
    for (const check of checks) bump(this.checksFailed, checkKey(check));
    switch (result.outcome) {
      case 'exact':
        break;
      case 'left_over':
        bump(this.leftOver, byteBucket(result.by));
        return false;
      case 'missing':
        // A too-large count gives only where it happened: its shortfall is computed from the count's own value.
        if (result.code !== 'count_too_large') bump(this.missing, byteBucket(result.by));
        bump(this.missingAt, failureKey(result.code ?? 'needs_more_bytes', result.field));
        return false;
      case 'stopped':
        bump(this.stopped, failureKey(result.code, result.field));
        return false;
      default:
        bump(this.stopped, 'walker_failed');
        return false;
    }
    if (checks.length > 0) {
      this.exactButFailedCheck++;
      return false;
    }
    this.accepted++;
    for (const note of Array.isArray(result.notes) ? result.notes : []) {
      if (typeof note === 'string') bump(this.notes, noteKey(note));
    }
    return true;
  }

  toJSON() {
    return {
      accepted: this.accepted,
      fitExactlyButFailedACheck: this.exactButFailedCheck,
      bytesLeftOver: sortedObject(this.leftOver),
      bytesMissing: sortedObject(this.missing),
      ranOutAt: sortedObject(this.missingAt),
      stopped: sortedObject(this.stopped),
      checksFailed: sortedObject(this.checksFailed),
      amongAccepted: sortedObject(this.notes),
    };
  }
}

/**
 * @param {Walker} walk
 * @param {Uint8Array} body
 * @returns {WalkResult|null}
 */
function safeWalk(walk, body) {
  try {
    const result = walk(body);
    return result && typeof result === 'object' ? result : null;
  } catch {
    return null;
  }
}

/**
 * The class of a GDB waypoint (prefix field 2), bucketed. Shown as a count only.
 * @param {Uint8Array} body
 * @returns {string}
 */
function waypointClass(body) {
  const nul = body.indexOf(0);
  if (nul < 0 || nul + 5 > body.length) return 'unreadable';
  const value = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(nul + 1, true);
  return value === 0 || value === 1 ? String(value) : 'other';
}

// ---------------------------------------------------------------------------------------------
// FolderData.gfi tree shape (counts only; IDs are compared in memory and never leave)

/**
 * Where a folder's children are: they are read from the record's own bytes when needed and never copied, so a
 * folder record that claims millions of children costs one small object, not millions of arrays.
 * @typedef {{parent: number, index: number, at: number, n: number}} FolderEntry
 */

/**
 * The (type, id) pairs of a folder's children as a view over its record, or null when the bytes are gone.
 * @param {unknown[]} records
 * @param {FolderEntry} entry
 * @returns {DataView|null}
 */
function folderChildren(records, entry) {
  let body;
  try {
    body = /** @type {Record<string, any>} */ (records[entry.index])?.body;
  } catch {
    return null;
  }
  if (!(body instanceof Uint8Array) || entry.at + entry.n * 8 > body.length) return null;
  return new DataView(body.buffer, body.byteOffset + entry.at, entry.n * 8);
}

/** @param {unknown[]} records */
function treeShape(records) {
  /** @type {Map<number, FolderEntry>} */
  const folders = new Map();
  /** @type {Map<number, number>} list id -> parent folder id */
  const lists = new Map();
  /** @type {Map<number, number>} list id -> reference count */
  const itemsPerList = new Map();
  const shape = {
    folders: 0,
    lists: 0,
    duplicateFolderIds: 0,
    duplicateListIds: 0,
    root: 'none',
    childReferences: { list: 0, folder: 0, other: 0 },
    childReferencesNotFound: 0,
    foldersReachedFromRoot: 0,
    foldersNotReached: 0,
    foldersListedTwice: 0,
    listsListedTwice: 0,
    deepestFolder: 0,
    depthLimitReached: false,
    listsNotInAnyFolder: 0,
    listsWhoseParentDisagrees: 0,
    references: /** @type {Record<string, number>} */ ({}),
    referencesToUnknownList: 0,
    itemsPerList: /** @type {Record<string, number>} */ ({}),
  };
  /** @type {Map<string, number>} */
  const references = new Map();

  for (let index = 0; index < records.length; index++) {
    const record = /** @type {Record<string, any>} */ (records[index]);
    let body;
    try {
      body = record?.body;
    } catch {
      continue;
    }
    if (!(body instanceof Uint8Array)) continue;
    const type = typeKey(record.typeCode);
    const c = new Cursor(body);
    if (type === 'F') {
      const id = c.u32('1');
      c.cstr('2');
      const parent = c.u32('3');
      const n = c.count(8, '4'); // checked: the n children fit in the bytes left
      if (!c.ok) continue;
      shape.folders++;
      if (folders.has(id)) {
        shape.duplicateFolderIds++;
        continue;
      }
      folders.set(id, { parent, index, at: c.p, n });
    } else if (type === 'I') {
      const id = c.u32('1');
      c.cstr('2');
      c.u32('3');
      const parent = c.u32('4');
      if (!c.ok) continue;
      shape.lists++;
      if (lists.has(id)) {
        shape.duplicateListIds++;
        continue;
      }
      lists.set(id, parent);
      itemsPerList.set(id, 0);
    } else if (type === 'T' || type === 'W' || type === 'R' || type === 'K' || type === 'J') {
      const parent = c.u32('1');
      if (!c.ok) continue;
      bump(references, type);
      const current = itemsPerList.get(parent);
      if (current === undefined) shape.referencesToUnknownList++;
      else itemsPerList.set(parent, current + 1);
    }
  }

  // The root: folder 0xFFFFFFFF, else a folder that is its own parent (FORMAT.md §8.1).
  let rootId = null;
  if (folders.has(ROOT_FOLDER_ID)) {
    rootId = ROOT_FOLDER_ID;
    shape.root = 'standard';
  } else {
    for (const [id, f] of folders) {
      if (f.parent === id) {
        rootId = id;
        shape.root = 'own parent';
        break;
      }
    }
  }

  /** @type {Map<number, number>} list id -> folder that lists it (first one) */
  const listFolder = new Map();
  /** @type {Set<number>} */
  const childFolders = new Set();
  for (const [id, f] of folders) {
    const children = folderChildren(records, f);
    if (!children) continue;
    for (let k = 0; k < f.n; k++) {
      const type = children.getUint32(k * 8, true);
      const childId = children.getUint32(k * 8 + 4, true);
      if (type === 0) {
        shape.childReferences.list++;
        if (!lists.has(childId)) shape.childReferencesNotFound++;
        else if (listFolder.has(childId)) shape.listsListedTwice++;
        else listFolder.set(childId, id);
      } else if (type === 1) {
        shape.childReferences.folder++;
        if (!folders.has(childId)) shape.childReferencesNotFound++;
        else if (childFolders.has(childId)) shape.foldersListedTwice++;
        else childFolders.add(childId);
      } else {
        shape.childReferences.other++;
      }
    }
  }

  // Walk down from the root with a visited set and a depth cap.
  if (rootId !== null) {
    /** @type {Set<number>} */
    const visited = new Set([rootId]);
    /** @type {Array<[number, number]>} */
    let frontier = [[rootId, 0]];
    while (frontier.length > 0) {
      /** @type {Array<[number, number]>} */
      const next = [];
      for (const [id, depth] of frontier) {
        if (depth > shape.deepestFolder) shape.deepestFolder = depth;
        const f = folders.get(id);
        if (!f) continue;
        const children = folderChildren(records, f);
        if (!children) continue;
        for (let k = 0; k < f.n; k++) {
          const type = children.getUint32(k * 8, true);
          const childId = children.getUint32(k * 8 + 4, true);
          if (type !== 1 || visited.has(childId) || !folders.has(childId)) continue;
          if (depth + 1 > MAX_TREE_DEPTH) {
            shape.depthLimitReached = true;
            continue;
          }
          visited.add(childId);
          next.push([childId, depth + 1]);
        }
      }
      frontier = next;
    }
    shape.foldersReachedFromRoot = visited.size;
  }
  shape.foldersNotReached = folders.size - shape.foldersReachedFromRoot;

  for (const [id, parent] of lists) {
    const folderId = listFolder.get(id);
    if (folderId === undefined) shape.listsNotInAnyFolder++;
    else if (folderId !== parent) shape.listsWhoseParentDisagrees++;
  }
  shape.references = sortedObject(references);
  /** @type {Map<string, number>} */
  const perList = new Map();
  for (const n of itemsPerList.values()) bump(perList, lengthBucket(n));
  shape.itemsPerList = sortedObject(perList);
  return shape;
}

// ---------------------------------------------------------------------------------------------
// TrackSegments (FORMAT.md §9)

/** @param {unknown} files */
function trackSegmentsSection(files) {
  if (!Array.isArray(files)) return { present: false };
  /** @type {number[]} */
  const sizes = [];
  /** @type {number[]} */
  const pointCounts = [];
  const tally = {
    signatures: new Map(),
    containerFormats: new Map(),
    fileFormats: new Map(),
    programVersions: new Map(),
    applications: new Map(),
    headerProblems: new Map(),
    pointCountProblems: new Map(),
  };
  const widths = [17, 11];
  const layoutStats = widths.map(() => new LayoutStats());
  /** @type {Map<string, number>[]} */
  const patterns = widths.map(() => new Map());
  const verdict = { only17: 0, only11: 0, both: 0, neither: 0 };
  let pointsInDecidedFiles = 0;
  let withElevation = 0;
  let withTime = 0;
  /** @type {Map<string, number>} */
  const bytesPerPoint = new Map();
  let undecidedEvenlyDivided = 0;
  let read = 0;
  let notRead = 0;

  for (const entry of files) {
    const file = entry instanceof ArrayBuffer ? new Uint8Array(entry) : entry;
    if (file instanceof Uint8Array) {
      sizes.push(file.length);
    } else {
      const size = count(/** @type {any} */ (file)?.size);
      if (size !== null) sizes.push(size);
      notRead++;
      continue;
    }
    read++;
    try {
      analyseOne(file);
    } catch {
      bump(tally.headerProblems, 'dump_failed');
    }
  }

  /** @param {Uint8Array} file */
  function analyseOne(file) {
    const header = readHeader(file, { role: 'tracksegments' });
    // Capped: in a real library every file shares one header, and a folder of other files must not be able to
    // copy the first bytes of each one into the dump.
    bumpCapped(tally.signatures, signatureLabel(header.signature, header.signatureHex) ?? 'too short', MAX_TALLY_KEYS);
    bumpCapped(tally.containerFormats, numberKey(header.primaryFormat), MAX_TALLY_KEYS);
    bumpCapped(tally.fileFormats, numberKey(header.formatVersion), MAX_TALLY_KEYS);
    bumpCapped(tally.programVersions, numberKey(header.programVersion), MAX_TALLY_KEYS);
    bump(tally.applications, header.application ?? 'none');
    for (const problem of header.problems) bump(tally.headerProblems, CONTAINER_PROBLEMS.has(problem.code) ? problem.code : 'other');
    if (!header.ok) return;

    const body = file.subarray(header.bodyStart);
    if (body.length < 4) {
      bump(tally.pointCountProblems, 'no_point_count');
      return;
    }
    const points = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0, true);
    if (points * 11 > body.length - 4) {
      bump(tally.pointCountProblems, 'count_too_large');
      return;
    }
    pointCounts.push(points);

    const walks = widths.map((width) => walkTrackSegment(body, points, width));
    const accepted = walks.map((walk, w) => layoutStats[w].add(walk.result));
    walks.forEach((walk, w) => {
      if (walk.pattern !== null) bumpCapped(patterns[w], walk.pattern, MAX_PATTERNS);
    });
    if (accepted[0] && accepted[1]) verdict.both++;
    else if (!accepted[0] && !accepted[1]) verdict.neither++;
    else if (accepted[0]) verdict.only17++;
    else verdict.only11++;
    if (accepted[0] !== accepted[1]) {
      // Presence is counted only where exactly one width fits, so the flags were read in step.
      const walk = walks[accepted[0] ? 0 : 1];
      pointsInDecidedFiles += points;
      withElevation += walk.present.elevation;
      withTime += walk.present.time;
    } else if (points > 0) {
      const after = body.length - 4;
      bump(bytesPerPoint, byteBucket(Math.floor(after / points)));
      if (after % points === 0) undecidedEvenlyDivided++;
    }
  }

  return {
    present: true,
    files: sizes.length,
    filesRead: read,
    filesNotRead: notRead,
    bytes: sizes.reduce((a, b) => a + b, 0),
    size: lengthSummary(sizes, false),
    signatures: sortedObject(tally.signatures),
    containerFormats: sortedObject(tally.containerFormats),
    fileFormats: sortedObject(tally.fileFormats),
    programVersions: sortedObject(tally.programVersions),
    applications: sortedObject(tally.applications),
    headerProblems: sortedObject(tally.headerProblems),
    pointCountProblems: sortedObject(tally.pointCountProblems),
    pointsPerFile: lengthSummary(pointCounts, false),
    layouts: {
      '17 bytes per point': { ...layoutStats[0].toJSON(), extraBytePatterns: sortedObject(patterns[0]) },
      '11 bytes per point': { ...layoutStats[1].toJSON(), extraBytePatterns: sortedObject(patterns[1]) },
    },
    verdict: {
      only17: verdict.only17,
      only11: verdict.only11,
      both: verdict.both,
      neither: verdict.neither,
    },
    decidedFiles: { points: pointsInDecidedFiles, withElevation, withTime },
    undecidedFiles: { bytesPerPoint: sortedObject(bytesPerPoint), evenlyDivided: undecidedEvenlyDivided },
  };
}

/** Value width of TrackSegments slots 3-17 when present (FORMAT.md §15.11): 6 temperature, 7 heart rate, else unknown. */
const SLOT_WIDTH = Object.freeze({ 6: 8, 7: 1 });

/**
 * Walks M points of `width` nominal bytes: an fdouble elevation (slot 1), an fint time (slot 2), then width - 2 more
 * bytes. With width 11 those 9 bytes must all be 0 (FORMAT.md §9.3 step 3). With width 17 they are the presence bytes
 * of slots 3-17 (§15.11): each 0 or 1, followed by its value when 1, and only slots 6 (temperature, 8 bytes) and 7
 * (heart rate, 1 byte) may be present. On the first point that breaks the rule the walk stops, and the 15 or 9 bytes
 * after that point's time are summarised as a pattern of digits: 0, 1, or 2 for any value above 1.
 * @param {Uint8Array} body  starts at the point count
 * @param {number} points
 * @param {number} width
 */
function walkTrackSegment(body, points, width) {
  const c = new Cursor(body);
  c.p = 4;
  const extra = width - 2;
  let elevation = 0;
  let time = 0;
  let temperature = 0;
  let heartRate = 0;
  /** @type {string|null} */
  let pattern = null;
  /** @param {number} from */
  const patternAt = (from) => {
    let p = '';
    for (let j = 0; j < extra && from + j < c.n; j++) {
      const v = c.b[from + j];
      p += v === 0 ? '0' : v === 1 ? '1' : '2';
    }
    return p;
  };
  for (let i = 0; i < points && c.ok; i++) {
    if (c.fdouble('elevation')) elevation++;
    if (c.fint('time')) time++;
    if (!c.ok) break;
    const from = c.p;
    if (width === 17) {
      for (let slot = 3; slot <= 17 && c.ok; slot++) {
        if (!c.has(1, 'extra')) break;
        const present = c.b[c.p];
        const size = /** @type {Record<number, number>} */ (SLOT_WIDTH)[slot];
        if (present > 1 || (present === 1 && size === undefined)) {
          pattern = patternAt(from);
          c.halt('extra_byte_not_0', 'extra');
          break;
        }
        c.p++;
        if (present === 1) {
          if (!c.has(size, 'extra')) break;
          c.p += size;
          if (slot === 6) temperature++;
          else heartRate++;
        }
      }
      continue;
    }
    if (!c.has(extra, 'extra')) break;
    if (!c.allEqual(extra, 0)) {
      pattern = patternAt(from);
      c.halt('extra_byte_not_0', 'extra');
      break;
    }
    c.p += extra;
  }
  if (temperature) c.note('temperature');
  if (heartRate) c.note('heart_rate');
  return { result: c.result(), pattern, present: { elevation, time } };
}

// ---------------------------------------------------------------------------------------------
// Text rendering: from the data object only.

/**
 * @param {any} data
 * @returns {string}
 */
function renderText(data) {
  /** @type {string[]} */
  const out = [];
  out.push(`BCR library structure report (${DUMP_FORMAT} version ${DUMP_VERSION})`);
  out.push('');
  out.push('This report shows only how the library files are built: file sizes, version numbers, how many');
  out.push('records of each kind there are, how long they are, and whether each one matches the layouts this');
  out.push('tool knows. It contains no names, notes, places, coordinates, times, IDs or file paths.');
  out.push('');
  const engine = data.environment.engine === 'other' ? 'other' : data.environment.engine;
  const major = data.environment.engineMajor === null ? '' : ` ${data.environment.engineMajor}`;
  out.push(`Tool version: ${data.tool.version}. Browser engine: ${engine}${major}. Input: ${data.input.kind}.`);
  out.push('');
  out.push('Files');
  out.push('-----');
  for (const name of ['AllData.gdb', 'FolderData.gfi']) {
    const f = data.files[name];
    out.push(`- ${name}: ${f.present ? `${fmt(f.size)} bytes` : 'not found'}`);
  }
  const ts = data.files.TrackSegments;
  out.push(
    ts.present
      ? `- TrackSegments folder: ${fmt(ts.files)} ${plural(ts.files, 'file')}, ${fmt(ts.bytes)} bytes in all`
      : '- TrackSegments folder: not found',
  );
  const others = data.input.otherFiles;
  out.push(
    `- Other files: ${others === null ? 'not counted' : `${fmt(others)}${data.input.otherFileBytes === null ? '' : `, ${fmt(data.input.otherFileBytes)} bytes`} (not read)`}`,
  );

  for (const name of ['AllData.gdb', 'FolderData.gfi']) {
    const f = data.files[name];
    if (!f.present) continue;
    out.push('');
    out.push(name);
    out.push('-'.repeat(name.length));
    renderContainer(out, f);
  }
  if (ts.present) {
    out.push('');
    out.push('TrackSegments folder');
    out.push('--------------------');
    renderTrackSegments(out, ts);
  }
  out.push('');
  out.push('End of report.');
  return `${out.join('\n')}\n`;
}

/**
 * @param {string[]} out
 * @param {any} f
 */
function renderContainer(out, f) {
  const sig = f.signature === null ? 'none (file too short)' : f.signature;
  out.push(`- Signature: ${sig}${f.signature === f.expectedSignature ? ' (as expected)' : ` (expected ${f.expectedSignature})`}`);
  out.push(
    `- Container format: ${show(f.containerFormat)}. File format: ${show(f.fileFormat)}${
      f.fileFormatClass ? ` (${/** @type {Record<string, string>} */ (VERSION_WORDS)[f.fileFormatClass]})` : ''
    }. Program version: ${show(f.programVersion)}. Made by: ${f.application ?? 'unknown'}.`,
  );
  if (f.authorRecordAsExpected !== null) out.push(`- Author record as expected: ${yesNo(f.authorRecordAsExpected)}`);
  out.push(`- Header could be read: ${yesNo(f.readable)}${f.headerBytes === null ? '' : ` (${fmt(f.headerBytes)} bytes)`}`);
  out.push(`- Read to the end: ${yesNo(f.readToEnd)}`);
  out.push(
    `- End-of-file record: ${f.endRecord.present ? `present, ${fmt(f.endRecord.bytesAfter)} bytes after it` : 'not present'}`,
  );
  if (f.zeroBytesSkipped) out.push(`- Zero bytes skipped as padding: ${fmt(f.zeroBytesSkipped)}`);
  out.push(`- Records: ${fmt(f.recordCount)}, of which ${fmt(f.recordsAnalysed)} analyzed. Out of the usual order: ${fmt(f.orderViolations)}`);
  if (f.problems.length === 0) out.push('- Problems: none');
  else out.push(`- Problems: ${f.problems.map((/** @type {any} */ p) => `${problemWords(p.code)} (${fmt(p.count)})`).join('; ')}`);

  for (const [type, t] of Object.entries(f.recordTypes)) {
    const s = /** @type {any} */ (t);
    out.push('');
    if (s.length.min === null) {
      out.push(
        `Record type ${type} (${s.name}): ${fmt(s.count)} ${plural(s.count, 'record')}. Exact sizes are not shown for a kind this tool does not know, because its length may have been misread from other data.`,
      );
    } else {
      out.push(
        `Record type ${type} (${s.name}): ${fmt(s.count)} ${plural(s.count, 'record')}, ${fmt(s.bytes)} bytes. Length ${fmt(
          s.length.min,
        )} to ${fmt(s.length.max)}, median ${fmt(s.length.median)}.`,
      );
    }
    out.push(`  Lengths: ${histogramText(s.length.histogram)}`);
    if (s.waypointClass) out.push(`  Waypoint class: ${histogramText(s.waypointClass)}`);
    if (s.layouts === null) {
      out.push('  No layout is known for this record type; it is only counted.');
      continue;
    }
    if (s.notChecked) out.push(`  Not checked (bytes unavailable): ${fmt(s.notChecked)}`);
    for (const [label, l] of Object.entries(s.layouts)) renderLayout(out, label, /** @type {any} */ (l));
    if (s.verdict) {
      const only = Object.entries(s.verdict.matchedOnlyOne)
        .map(([label, n]) => `${fmt(/** @type {number} */ (n))} only ${label}`)
        .join(', ');
      out.push(
        `  Result: ${only}, ${fmt(s.verdict.matchedNone)} matched none, ${fmt(s.verdict.matchedMoreThanOne)} matched more than one.`,
      );
    }
    if (s.tieBreak && (s.verdict?.matchedMoreThanOne > 0 || s.tieBreak.refusedForProgramVersion > 0)) {
      const b = s.tieBreak;
      const decided = Object.entries(b.decidedByProgramVersion)
        .filter(([, n]) => /** @type {number} */ (n) > 0)
        .map(([label, n]) => `${fmt(/** @type {number} */ (n))} read as ${label}`);
      const parts = [...decided, `${fmt(b.stillMoreThanOne)} still matched more than one and were not read`];
      if (b.refusedForProgramVersion > 0) {
        parts.push(`${fmt(b.refusedForProgramVersion)} matched only H-OP and were not read, because H-OP is not used for routes in a file from BaseCamp 4.8 for Mac`);
      }
      out.push(`  Decided by the program version (${/** @type {Record<string, string>} */ (FAMILY_WORDS)[b.programVersion]}): ${parts.join(', ')}.`);
    }
  }

  if (f.tree) {
    const t = f.tree;
    out.push('');
    out.push('Folder and list tree (counts only):');
    out.push(`  Folders: ${fmt(t.folders)}, reached from the top folder: ${fmt(t.foldersReachedFromRoot)}, not reached: ${fmt(t.foldersNotReached)}.`);
    out.push(`  Top folder: ${/** @type {Record<string, string>} */ (ROOT_WORDS)[t.root]}. Deepest folder level: ${fmt(t.deepestFolder)}${t.depthLimitReached ? ' (depth limit reached)' : ''}.`);
    out.push(`  Lists: ${fmt(t.lists)}, not in any folder: ${fmt(t.listsNotInAnyFolder)}, whose two parent records disagree: ${fmt(t.listsWhoseParentDisagrees)}.`);
    out.push(
      `  Child references: ${fmt(t.childReferences.list)} to lists, ${fmt(t.childReferences.folder)} to folders, ${fmt(
        t.childReferences.other,
      )} of another kind, ${fmt(t.childReferencesNotFound)} not found.`,
    );
    out.push(`  Listed twice: ${fmt(t.foldersListedTwice)} folders, ${fmt(t.listsListedTwice)} lists. Repeated IDs: ${fmt(t.duplicateFolderIds)} folders, ${fmt(t.duplicateListIds)} lists.`);
    out.push(`  Item references: ${histogramText(t.references)}; pointing to no known list: ${fmt(t.referencesToUnknownList)}.`);
    out.push(`  Items per list: ${histogramText(t.itemsPerList)}`);
  }
}

/**
 * @param {string[]} out
 * @param {string} label
 * @param {any} l
 */
function renderLayout(out, label, l) {
  const parts = [`${fmt(l.accepted)} fit exactly and passed every check`];
  if (l.fitExactlyButFailedACheck) parts.push(`${fmt(l.fitExactlyButFailedACheck)} fit exactly but failed a check`);
  const left = sum(l.bytesLeftOver);
  if (left) parts.push(`${fmt(left)} with bytes left over`);
  const missing = sum(l.ranOutAt);
  if (missing) parts.push(`${fmt(missing)} too short`);
  const stopped = sum(l.stopped);
  if (stopped) parts.push(`${fmt(stopped)} stopped early`);
  out.push(`  Layout ${label}: ${parts.join('; ')}.`);
  if (left) out.push(`    Bytes left over: ${bytesText(l.bytesLeftOver)}`);
  if (Object.keys(l.bytesMissing).length) out.push(`    Bytes missing (at least): ${bytesText(l.bytesMissing)}`);
  if (Object.keys(l.ranOutAt).length) out.push(`    Ran out: ${failureText(l.ranOutAt)}`);
  if (Object.keys(l.stopped).length) out.push(`    Stopped: ${failureText(l.stopped)}`);
  if (Object.keys(l.checksFailed).length) out.push(`    Failed checks: ${failureText(l.checksFailed)}`);
  if (Object.keys(l.amongAccepted).length) out.push(`    Among accepted records: ${notesText(l.amongAccepted)}`);
  if (l.extraBytePatterns && Object.keys(l.extraBytePatterns).length) {
    out.push(`    Extra-byte patterns where a byte was not 0 (each byte as 0, 1, or 2 for any higher value): ${histogramText(l.extraBytePatterns)}`);
  }
}

/**
 * @param {string[]} out
 * @param {any} ts
 */
function renderTrackSegments(out, ts) {
  out.push(`- Files: ${fmt(ts.files)} (${fmt(ts.filesRead)} read, ${fmt(ts.filesNotRead)} counted by size only)`);
  if (ts.size.min !== null) out.push(`- File size: ${fmt(ts.size.min)} to ${fmt(ts.size.max)} bytes, median ${fmt(ts.size.median)}`);
  out.push(`- Signatures: ${histogramText(ts.signatures)}`);
  out.push(`- Container formats: ${histogramText(ts.containerFormats)}. File formats: ${histogramText(ts.fileFormats)}.`);
  out.push(`- Program versions: ${histogramText(ts.programVersions)}. Made by: ${histogramText(ts.applications)}.`);
  if (Object.keys(ts.headerProblems).length) out.push(`- Header problems: ${problemsText(ts.headerProblems)}`);
  if (Object.keys(ts.pointCountProblems).length) out.push(`- Point count problems: ${problemsText(ts.pointCountProblems)}`);
  if (ts.pointsPerFile.min !== null) {
    out.push(`- Points per file: ${fmt(ts.pointsPerFile.min)} to ${fmt(ts.pointsPerFile.max)}, median ${fmt(ts.pointsPerFile.median)}`);
  }
  for (const [label, l] of Object.entries(ts.layouts)) renderLayout(out, label, l);
  out.push(
    `  Result: ${fmt(ts.verdict.only17)} only 17, ${fmt(ts.verdict.only11)} only 11, ${fmt(ts.verdict.both)} both, ${fmt(ts.verdict.neither)} neither.`,
  );
  out.push(
    `- In files with one clear layout: ${fmt(ts.decidedFiles.points)} points, ${fmt(ts.decidedFiles.withElevation)} with elevation, ${fmt(
      ts.decidedFiles.withTime,
    )} with time.`,
  );
  if (Object.keys(ts.undecidedFiles.bytesPerPoint).length) {
    out.push(
      `- Other files, average bytes per point: ${histogramText(ts.undecidedFiles.bytesPerPoint)}; evenly divided: ${fmt(
        ts.undecidedFiles.evenlyDivided,
      )}`,
    );
  }
}

const VERSION_WORDS = Object.freeze({
  exported: 'an exported file, not a library',
  too_old: 'an older library format, not supported',
  experimental: 'experimental support',
  supported: 'the supported version',
  unknown: 'not a known version',
});

const ROOT_WORDS = Object.freeze({
  standard: 'found (the usual one)',
  'own parent': 'found (a folder that is its own parent)',
  none: 'not found',
});

// ---------------------------------------------------------------------------------------------
// Helpers

/**
 * @param {Record<string, number>} histogram
 * @returns {string}
 */
function histogramText(histogram) {
  const entries = Object.entries(histogram);
  if (entries.length === 0) return 'none';
  return entries.map(([k, v]) => `${k}: ${fmt(v)}`).join(', ');
}

/**
 * "16 bytes in 3 records, 1 byte in 1 record"
 * @param {Record<string, number>} histogram
 * @returns {string}
 */
function bytesText(histogram) {
  return Object.entries(histogram)
    .map(([k, v]) => `${k} ${k === '1' ? 'byte' : 'bytes'} in ${fmt(v)} ${plural(v, 'record')}`)
    .join(', ');
}

/**
 * @param {Record<string, number>} histogram  presence notes
 * @returns {string}
 */
function notesText(histogram) {
  return Object.entries(histogram)
    .map(([key, n]) => {
      const opaque = OPAQUE_NOTE_RE.exec(key);
      const words = hasOwn(NOTE_WORDS, key)
        ? /** @type {Record<string, string>} */ (NOTE_WORDS)[key]
        : opaque
          ? `non-zero unchecked bytes in ${opaque[1]}`
          : NOTE_WORDS.other;
      return `${words}: ${fmt(n)}`;
    })
    .join(', ');
}

/**
 * @param {Record<string, number>} histogram  keys "code at field"
 * @returns {string}
 */
function failureText(histogram) {
  return Object.entries(histogram)
    .map(([key, n]) => {
      const [code, field] = key.split(' at ');
      const words = hasOwn(CODE_WORDS, code) ? /** @type {Record<string, string>} */ (CODE_WORDS)[code] : CODE_WORDS.other;
      return `${words}${field ? ` (field ${field})` : ''}: ${fmt(n)}`;
    })
    .join('; ');
}

/**
 * @param {unknown} code  a problem code (from a fixed vocabulary by the time it is rendered)
 * @returns {string}
 */
function problemWords(code) {
  if (typeof code !== 'string') return PROBLEM_WORDS.other;
  return hasOwn(PROBLEM_WORDS, code) ? /** @type {Record<string, string>} */ (PROBLEM_WORDS)[code] : code.replace(/_/g, ' ');
}

/**
 * "not a BaseCamp library file (2); the file ends before its point count (1)"
 * @param {Record<string, number>} histogram  keys are problem codes
 * @returns {string}
 */
function problemsText(histogram) {
  return Object.entries(histogram)
    .map(([code, n]) => `${problemWords(code)} (${fmt(n)})`)
    .join('; ');
}

/** @param {Record<string, number>} h */
function sum(h) {
  return Object.values(h).reduce((a, b) => a + b, 0);
}

/**
 * Lengths as min / median / max and power-of-two buckets.
 * @param {number[]} values
 * @param {boolean} [withHistogram]
 */
function lengthSummary(values, withHistogram = true) {
  if (values.length === 0) return withHistogram ? { min: null, median: null, max: null, histogram: {} } : { min: null, median: null, max: null };
  const sorted = Float64Array.from(values).sort();
  const summary = { min: sorted[0], median: sorted[(sorted.length - 1) >> 1], max: sorted[sorted.length - 1] };
  if (!withHistogram) return summary;
  /** @type {Map<string, number>} */
  const buckets = new Map();
  for (const v of values) bump(buckets, lengthBucket(v));
  return { ...summary, histogram: sortedObject(buckets) };
}

/**
 * "0", "1", "2-3", "4-7", ... (power-of-two buckets).
 * @param {number} n
 * @returns {string}
 */
function lengthBucket(n) {
  if (n <= 1) return String(n);
  let lo = 1;
  while (lo * 2 <= n) lo *= 2;
  return `${lo}-${lo * 2 - 1}`;
}

/**
 * Exact up to 64, then power-of-two buckets: leftover and missing byte counts are what Gate 1 needs exactly.
 * @param {unknown} n
 * @returns {string}
 */
function byteBucket(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 'unknown';
  const v = Math.floor(n);
  if (v <= 64) return String(v);
  let lo = 64;
  while (lo * 2 <= v) lo *= 2;
  return `${lo === 64 ? 65 : lo}-${lo * 2 - 1}`;
}

/**
 * @param {unknown} check  "code@field"
 * @returns {string}
 */
function checkKey(check) {
  if (typeof check !== 'string') return 'walker_failed';
  const at = check.indexOf('@');
  return at < 0 ? failureKey(check, null) : failureKey(check.slice(0, at), check.slice(at + 1));
}

/**
 * @param {unknown} code
 * @param {unknown} field
 * @returns {string}
 */
function failureKey(code, field) {
  const safeCode = typeof code === 'string' && hasOwn(CODE_WORDS, code) ? code : 'other';
  const safeField = typeof field === 'string' && FIELD_RE.test(field) ? field : null;
  return safeField === null ? safeCode : `${safeCode} at ${safeField}`;
}

/**
 * A presence note from the fixed vocabulary, else "other".
 * @param {string} note
 * @returns {string}
 */
function noteKey(note) {
  if (hasOwn(NOTE_WORDS, note)) return note;
  const opaque = OPAQUE_NOTE_RE.exec(note);
  return opaque && FIELD_RE.test(opaque[1]) ? note : 'other';
}

/**
 * @param {object} table
 * @param {string} key
 * @returns {boolean}
 */
function hasOwn(table, key) {
  return Object.prototype.hasOwnProperty.call(table, key);
}

/**
 * @param {Map<string, number>} map
 * @param {string} key
 */
function bump(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/**
 * @param {Map<string, number>} map
 * @param {string} key
 * @param {number} cap  distinct keys kept; the rest go to "other"
 */
function bumpCapped(map, key, cap) {
  bump(map, map.has(key) || map.size < cap ? key : 'other');
}

/**
 * Keys in a stable order: numbers and number ranges by their first number, then text.
 * @param {Map<string, number>} map
 * @returns {Record<string, number>}
 */
function sortedObject(map) {
  /** @type {Record<string, number>} */
  const out = {};
  const keys = [...map.keys()].sort((a, b) => {
    const na = leadingNumber(a);
    const nb = leadingNumber(b);
    if (na !== null && nb !== null && na !== nb) return na - nb;
    if (na !== null && nb === null) return -1;
    if (na === null && nb !== null) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (const key of keys) out[key] = /** @type {number} */ (map.get(key));
  return out;
}

/**
 * @param {string} key
 * @returns {number|null}
 */
function leadingNumber(key) {
  const m = /^(\d+)/.exec(key);
  return m ? Number(m[1]) : null;
}

/**
 * Record-type keys: an ASCII letter stands for itself; any other byte is grouped as "non-letter" so that a
 * misframed file cannot spell out content one type byte at a time.
 * @param {unknown} code
 * @returns {string}
 */
function typeKey(code) {
  if (typeof code !== 'number') return 'non-letter';
  if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) return String.fromCharCode(code);
  return 'non-letter';
}

/**
 * Upper-case letters first, then lower-case, then "non-letter".
 * @param {string} a
 * @param {string} b
 */
function compareTypeKeys(a, b) {
  const ra = a === 'non-letter' ? 2 : a === a.toUpperCase() ? 0 : 1;
  const rb = b === 'non-letter' ? 2 : b === b.toUpperCase() ? 0 : 1;
  if (ra !== rb) return ra - rb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A known signature, or exactly 8 upper-case hex digits (the first 4 bytes), or null.
 * @param {unknown} signature
 * @param {unknown} signatureHex
 * @returns {string|null}
 */
function signatureLabel(signature, signatureHex) {
  if (typeof signature === 'string' && SIGNATURES.has(signature)) return signature;
  if (typeof signatureHex === 'string' && /^[0-9A-F]{8}$/.test(signatureHex)) return `hex ${signatureHex}`;
  return null;
}

/**
 * @param {unknown} problems
 * @returns {Array<{code: string, count: number}>}
 */
function problemList(problems) {
  if (!Array.isArray(problems)) return [];
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const p of problems) {
    const code = typeof p?.code === 'string' && CONTAINER_PROBLEMS.has(p.code) ? p.code : 'other';
    counts.set(code, (counts.get(code) ?? 0) + (count(p?.count) ?? 1));
  }
  return [...counts].map(([code, n]) => ({ code, count: n }));
}

/**
 * @param {unknown} value
 * @returns {number|null}  a non-negative safe integer, else null
 */
function count(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {number|null}
 */
function smallInt(value, max) {
  const n = count(value);
  return n !== null && n <= max ? n : null;
}

/**
 * @param {number|null} value
 * @returns {string}
 */
function numberKey(value) {
  return value === null ? 'none' : String(value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function toolVersion(value) {
  return typeof value === 'string' && /^\d{1,4}(\.\d{1,4}){0,3}(-[a-z0-9]{1,12})?$/.test(value) ? value : 'other';
}

/**
 * Digits grouped in threes with commas (not locale-dependent, so the dump reads the same everywhere).
 * @param {number|null} n
 * @returns {string}
 */
function fmt(n) {
  if (n === null || n === undefined) return 'unknown';
  const s = String(n);
  if (!/^\d+$/.test(s)) return s;
  return s.replace(/\B(?=(\d{3})+$)/g, ',');
}

/**
 * @param {number|null} n
 * @returns {string}
 */
function show(n) {
  return n === null ? 'unknown' : String(n);
}

/** @param {boolean} b */
function yesNo(b) {
  return b ? 'yes' : 'no';
}

/**
 * @param {number} n
 * @param {string} word
 */
function plural(n, word) {
  return n === 1 ? word : `${word}s`;
}
