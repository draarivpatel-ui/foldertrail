// AllData.gdb record parsers for file format 1.88 (FORMAT.md §2, §3.3, §5, §6, §7, §11), plus the bounds-checked
// primitives and the text decoder that gfi.js and tracksegments.js share.
//
// Written from FORMAT.md alone. Every parser here works on one record body (a Uint8Array view that container.js
// framed) and never reads outside it. Waypoint and track records have three layout hypotheses (H-KBM, H-OP, and
// H-MAC48, measured on Mac BaseCamp 4.8.13, §15.11); each is parsed in full, and a hypothesis is accepted only if it
// consumes the body exactly with every flag, count, latitude and record check valid (§3.3 rule 7). Exactly one
// accepted: use it. More than one: AllData.gdb's program version may pick one (decision B43, chooseLayout() in
// container.js); otherwise keep the agreed prefix only (§3.3 rule 8). Routes have two layouts: H-OP (§7.4, the
// trailer not read) and H-MAC48 (§15.11, read to the end of the record), chosen by the same rule.
//
// Hostile input: every read is checked against the bytes left before it happens, every count is checked against the
// bytes left before any loop (count × smallest element ≤ bytes left), and work per record is O(record length).
// A failed read never throws past this module: parse functions return a result object. Failure details carry a code,
// a byte offset inside the record and a field label, never a name, a coordinate, a time or a path.

import { lookup as symbolFor } from './symbols.js';
import { chooseLayout } from './container.js';

// ---------------------------------------------------------------------------------------------
// Primitives (FORMAT.md §2)

/** |latitude| ≤ 90° in semicircles (§2 rule 2). */
export const LAT_LIMIT = 2 ** 30;
/** Degrees per semicircle: v × 180 / 2^31 (exact in binary64 for every i32). */
const DEG_PER_SEMICIRCLE = 180 / 2 ** 31;
/** Altitudes and elevations at or above this are "absent" (§2 rule 4). */
export const ALTITUDE_ABSENT_AT = 1.0e24;

/**
 * A parse failure inside one hypothesis. Not an Error: it carries no stack and never any field value.
 */
export class ParseStop {
  /**
   * @param {string} code    e.g. "needs_more_bytes", "flag_not_0_or_1"
   * @param {number} offset  byte offset inside the record body
   * @param {string} field   FORMAT.md field label, e.g. "K13"
   */
  constructor(code, offset, field) {
    this.code = code;
    this.offset = offset;
    this.field = field;
  }
}

/**
 * A bounds-checked little-endian reader over [start, end) of a byte array. Every method throws a ParseStop
 * (never anything else) when the bytes are not there or a rule fails.
 */
export class Cursor {
  /**
   * @param {Uint8Array} bytes
   * @param {number} [start]
   * @param {number} [end]
   */
  constructor(bytes, start = 0, end = bytes.length) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.start = start;
    this.pos = start;
    this.end = end;
  }

  /** @returns {number} bytes left */
  get remaining() {
    return this.end - this.pos;
  }

  /**
   * @param {string} code
   * @param {string} field
   * @returns {never}
   */
  fail(code, field) {
    throw new ParseStop(code, this.pos - this.start, field);
  }

  /**
   * @param {number} n
   * @param {string} field
   */
  need(n, field) {
    if (n > this.end - this.pos) this.fail('needs_more_bytes', field);
  }

  /** @param {string} field */
  u8(field) {
    this.need(1, field);
    return this.bytes[this.pos++];
  }

  /** @param {string} field */
  u16(field) {
    this.need(2, field);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  /** @param {string} field */
  u32(field) {
    this.need(4, field);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  /** @param {string} field */
  i32(field) {
    this.need(4, field);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  /** @param {string} field */
  f64(field) {
    this.need(8, field);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  /**
   * @param {number} n
   * @param {string} field
   */
  skip(n, field) {
    this.need(n, field);
    this.pos += n;
  }

  /**
   * A flag byte: 0 or 1, anything else fails the hypothesis (§2 reader rule 1).
   * @param {string} field
   * @returns {0|1}
   */
  flag(field) {
    const v = this.u8(field);
    if (v > 1) this.fail('flag_not_0_or_1', field);
    return /** @type {0|1} */ (v);
  }

  /**
   * A byte that must be 0.
   * @param {string} field
   */
  zero(field) {
    if (this.u8(field) !== 0) this.fail('not_0', field);
  }

  /**
   * A cstr: returns the [start, end) range of its bytes, excluding the NUL; the cursor moves past the NUL.
   * @param {string} field
   * @returns {[number, number]}
   */
  cstr(field) {
    const s = this.pos;
    const nul = this.bytes.subarray(0, this.end).indexOf(0, s);
    if (nul < 0) this.fail('text_runs_past_end', field);
    this.pos = nul + 1;
    return [s, nul];
  }

  /**
   * An fdouble: null when the flag is 0, else the f64 as stored (absence rules are applied by the caller).
   * @param {string} field
   * @returns {number|null}
   */
  fdouble(field) {
    return this.flag(field) === 1 ? this.f64(field) : null;
  }

  /**
   * An fint: null when the flag is 0, else the i32.
   * @param {string} field
   * @returns {number|null}
   */
  fint(field) {
    return this.flag(field) === 1 ? this.i32(field) : null;
  }

  /**
   * An fstring: null when the flag is 0, else the cstr's range.
   * @param {string} field
   * @returns {[number, number]|null}
   */
  fstring(field) {
    return this.flag(field) === 1 ? this.cstr(field) : null;
  }

  /**
   * A latitude coord, checked against ±90° (§2 rule 2).
   * @param {string} field
   */
  lat(field) {
    const v = this.i32(field);
    if (v < -LAT_LIMIT || v > LAT_LIMIT) {
      this.pos -= 4;
      this.fail('latitude_out_of_range', field);
    }
    return v;
  }

  /**
   * A count followed by elements of at least `minSize` bytes: count × minSize must fit before it is used
   * (§3.3 rule 7c).
   * @param {number} minSize
   * @param {string} field
   */
  count(minSize, field) {
    const n = this.u32(field);
    if (n * minSize > this.end - this.pos) {
      this.pos -= 4;
      this.fail('count_too_large', field);
    }
    return n;
  }

  /**
   * u32 n, then n cstrs (links, categories). Returns n.
   * @param {string} field
   */
  stringList(field) {
    const n = this.count(1, field);
    for (let i = 0; i < n; i++) this.cstr(field);
    return n;
  }

  /**
   * A uuid: 36 ASCII characters 8-4-4-4-12 hexadecimal with '-', then 0x00 (§2). Letter case is free.
   * @param {string} field
   * @returns {string} lower-case
   */
  uuid(field) {
    this.need(37, field);
    const b = this.bytes;
    const s = this.pos;
    let out = '';
    for (let i = 0; i < 36; i++) {
      const c = b[s + i];
      if (i === 8 || i === 13 || i === 18 || i === 23) {
        if (c !== 0x2d) this.fail('uuid_shape', field);
        out += '-';
        continue;
      }
      const lower = c | 0x20;
      if (!((c >= 0x30 && c <= 0x39) || (lower >= 0x61 && lower <= 0x66))) this.fail('uuid_shape', field);
      out += String.fromCharCode(c >= 0x30 && c <= 0x39 ? c : lower);
    }
    if (b[s + 36] !== 0) this.fail('uuid_shape', field);
    this.pos = s + 37;
    return out;
  }

  /** @param {string} field */
  expectEnd(field) {
    if (this.pos < this.end) this.fail('bytes_left_over', field);
  }
}

/**
 * Semicircles to degrees (§2 coord).
 * @param {number} v  i32
 */
export function toDegrees(v) {
  return v * DEG_PER_SEMICIRCLE;
}

// ---------------------------------------------------------------------------------------------
// Counting (problems are counted by code; library.js turns codes into plain words)

/** A code → count tally. */
export class Counts {
  constructor() {
    /** @type {Map<string, number>} */
    this.map = new Map();
  }

  /**
   * @param {string} code
   * @param {number} [n]
   */
  add(code, n = 1) {
    if (n > 0) this.map.set(code, (this.map.get(code) ?? 0) + n);
  }

  /** @param {string} code */
  get(code) {
    return this.map.get(code) ?? 0;
  }
}

/**
 * Applies §2 rule 4 to an altitude or elevation: null stays null; NaN, ±Infinity and values ≥ 1e24 become null and
 * are counted.
 * @param {number|null} v
 * @param {Counts} counts
 * @returns {number|null}
 */
export function altitudeValue(v, counts) {
  if (v === null) return null;
  if (!Number.isFinite(v) || v >= ALTITUDE_ABSENT_AT) {
    counts.add('value_treated_as_absent');
    return null;
  }
  return v;
}

/**
 * Applies §2 rule 5 to a time in Unix seconds: null stays null; ≤ 0 becomes null and is counted. Returns ms.
 * @param {number|null} seconds  i32
 * @param {Counts} counts
 * @returns {number|null}
 */
export function timeValue(seconds, counts) {
  if (seconds === null) return null;
  if (seconds <= 0) {
    counts.add('value_treated_as_absent');
    return null;
  }
  return seconds * 1000;
}

// ---------------------------------------------------------------------------------------------
// Text (FORMAT.md §11)

/** @type {TextDecoder|null|undefined} */
let utf8Decoder;

/** windows-1252 for 0x80-0x9F (WHATWG Encoding table); the five unassigned bytes map to the C1 control. */
const CP1252_HIGH = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d,
  0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x009d, 0x017e, 0x0178,
];

const CHUNK = 4096;

/**
 * Bytes as one char per byte (for ASCII text and for link keys).
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 * @returns {string}
 */
function byteString(bytes, start, end) {
  let out = '';
  for (let at = start; at < end; at += CHUNK) {
    out += String.fromCharCode.apply(null, /** @type {any} */ (bytes.subarray(at, Math.min(end, at + CHUNK))));
  }
  return out;
}

/**
 * The link key of a name: its raw bytes (§10), as a string with one char per byte.
 * @param {Uint8Array} bytes
 * @param {[number, number]} range
 * @returns {string}
 */
export function rawKey(bytes, range) {
  return byteString(bytes, range[0], range[1]);
}

/**
 * Decodes text strictly as UTF-8; if that fails, as windows-1252, counted as "text_not_utf8" (§11).
 * A byte-order mark is kept as a character (it is part of the stored name).
 * @param {Uint8Array} bytes
 * @param {[number, number]} range
 * @param {Counts} counts
 * @returns {string}
 */
export function decodeText(bytes, range, counts) {
  const [start, end] = range;
  let ascii = true;
  for (let i = start; i < end; i++) {
    if (bytes[i] >= 0x80) {
      ascii = false;
      break;
    }
  }
  if (ascii) return byteString(bytes, start, end);
  if (utf8Decoder === undefined) {
    try {
      utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    } catch {
      utf8Decoder = null;
    }
  }
  if (utf8Decoder) {
    try {
      return utf8Decoder.decode(bytes.subarray(start, end));
    } catch {
      // not UTF-8: fall through
    }
  }
  counts.add('text_not_utf8');
  // In chunks of CHUNK characters: adding one character at a time built a rope that cost about 32 bytes of heap per
  // character (a 64 KB name held 2 MB).
  const units = new Uint16Array(Math.min(CHUNK, end - start));
  let out = '';
  for (let at = start; at < end; at += CHUNK) {
    const stop = Math.min(end, at + CHUNK);
    for (let i = at; i < stop; i++) {
      const b = bytes[i];
      units[i - at] = b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : b;
    }
    out += String.fromCharCode.apply(null, /** @type {any} */ (units.subarray(0, stop - at)));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 'W' waypoint (FORMAT.md §5)

/**
 * @typedef {object} WaypointRecord
 * @property {boolean} ok           the agreed prefix (fields 1-7) was read; false means the waypoint is unusable
 * @property {string|null} name     decoded name (null when not even the name could be read)
 * @property {string|null} key      raw name bytes as a link key
 * @property {number|null} cls      class (field 2)
 * @property {number} lat           degrees (valid only when ok)
 * @property {number} lon
 * @property {string} comment
 * @property {number|null} icon
 * @property {string} symbol        GPX <sym> name, "" when the icon is not in the table
 * @property {"H-KBM"|"H-OP"|"H-MAC48"|null} layout  the hypothesis used (the only one accepted, or the one the program
 *   version picked, B43), or null
 * @property {number} accepted      how many hypotheses were accepted (0 to 3), before any tie-break
 * @property {import('./container.js').LayoutDecision|null} decision  how `layout` was chosen; null when the prefix failed
 * @property {number|null} ele      metres, only from the hypothesis used
 * @property {number|null} time     ms, only from the accepted hypothesis
 * @property {ParseStop|null} prefixFailure
 */

/**
 * Parses one 'W' record body.
 * @param {Uint8Array} body
 * @param {Counts} counts  receives text_not_utf8, value_treated_as_absent, display_mode_unknown
 * @param {number|null} [programVersion]  AllData.gdb's 'A' record program version; breaks ties (B43). Without it, a
 *   record that fits more than one hypothesis is not decoded.
 * @returns {WaypointRecord}
 */
export function parseWaypoint(body, counts, programVersion = null) {
  /** @type {WaypointRecord} */
  const out = {
    ok: false,
    name: null,
    key: null,
    cls: null,
    lat: 0,
    lon: 0,
    comment: '',
    icon: null,
    symbol: '',
    layout: null,
    accepted: 0,
    decision: null,
    ele: null,
    time: null,
    prefixFailure: null,
  };
  const c = new Cursor(body);
  let tailStart;
  try {
    const name = c.cstr('1');
    out.key = rawKey(body, name);
    out.name = decodeText(body, name, counts);
    out.cls = c.u32('2');
    const lat = c.lat('3');
    const lon = c.i32('3');
    const comment = c.cstr('4');
    c.fdouble('5');
    const display = c.u32('6');
    out.icon = c.u32('7');
    out.lat = toDegrees(lat);
    out.lon = toDegrees(lon);
    out.comment = decodeText(body, comment, counts);
    out.symbol = symbolFor(out.icon);
    if (display > 4) counts.add('display_mode_unknown');
    tailStart = c.pos;
    out.ok = true;
  } catch (error) {
    if (!(error instanceof ParseStop)) throw error;
    out.prefixFailure = error;
    return out;
  }

  /** @type {Array<["H-KBM"|"H-OP"|"H-MAC48", {altitude: number|null, time: number|null}|null]>} */
  const tried = [
    ['H-KBM', tryLayout(() => waypointTailKbm(body, tailStart, false))],
    ['H-OP', tryLayout(() => waypointTailOp(body, tailStart))],
    ['H-MAC48', tryLayout(() => waypointTailKbm(body, tailStart, true))],
  ];
  const accepted = tried.filter(([, result]) => result !== null);
  out.accepted = accepted.length;
  const pick = chooseLayout('W', accepted.map(([label]) => label), programVersion);
  out.decision = pick.decision;
  const chosen = accepted.find(([label]) => label === pick.layout);
  if (chosen) {
    out.layout = chosen[0];
    out.ele = altitudeValue(/** @type {{altitude: number|null}} */ (chosen[1]).altitude, counts);
    out.time = timeValue(/** @type {{time: number|null}} */ (chosen[1]).time, counts);
  }
  return out;
}

/**
 * @template T
 * @param {() => T} parse
 * @returns {T|null}
 */
function tryLayout(parse) {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ParseStop) return null;
    throw error;
  }
}

/**
 * H-KBM tail, fields K8-K24 (§5.2); with `mac48`, the H-MAC48 tail: the same fields, then 8 opaque bytes (§15.11).
 * @param {Uint8Array} body
 * @param {number} start
 * @param {boolean} mac48
 * @returns {{altitude: number|null, time: number|null}}
 */
function waypointTailKbm(body, start, mac48) {
  const c = new Cursor(body, start);
  c.cstr('K8');
  c.cstr('K9');
  c.cstr('K10');
  c.cstr('K11');
  c.cstr('K12');
  const b = c.u8('K13');
  if (b === 1) c.skip(24, 'K13');
  else if (b === 0) {
    if (c.u8('K13') > 1) c.fail('not_0_or_1', 'K13');
  } else c.fail('flag_not_0_or_1', 'K13');
  const altitude = c.fdouble('K14');
  c.fdouble('K15');
  c.stringList('K16');
  c.fdouble('K17');
  const timeA = c.fint('K18');
  c.skip(6, 'K19');
  const phones = c.u32('K20');
  if (phones > 1) c.fail('phone_count_above_1', 'K20');
  if (phones === 1) {
    c.cstr('K21');
    c.skip(1, 'K21');
  }
  const timeB = c.fint('K22');
  c.skip(3, 'K23');
  c.stringList('K24');
  if (mac48) c.skip(8, '15.3 row 23'); // opaque, never checked (§15.11)
  c.expectEnd(mac48 ? '15.3 row 23' : 'K24');
  // §5.4 and B42: K22 (time B, BaseCamp's creation time) if present, otherwise K18.
  return { altitude, time: timeB !== null ? timeB : timeA };
}

/**
 * H-OP tail, fields O8-O18 (§5.2).
 * @param {Uint8Array} body
 * @param {number} start
 * @returns {{altitude: number|null, time: number|null}}
 */
function waypointTailOp(body, start) {
  const c = new Cursor(body, start);
  c.u32('O8');
  c.zero('O9');
  c.zero('O10');
  c.zero('O11');
  const altitude = c.fdouble('O12');
  c.zero('O13');
  c.stringList('O14');
  c.fdouble('O15');
  const time = c.fint('O16');
  c.zero('O17');
  if (c.flag('O18') === 1) {
    c.cstr('O18');
    c.uuid('O18');
    for (let i = 0; i < 8; i++) c.zero('O18');
  }
  c.expectEnd('O18');
  return { altitude, time };
}

// ---------------------------------------------------------------------------------------------
// 'T' track (FORMAT.md §6)

/**
 * Where a decoded track's points sit in its record body.
 * @typedef {object} TrackGeometry
 * @property {number[]} pointOffsets  body offset of each segment's first point
 * @property {number[]} pointCounts   n of each segment
 * @property {number} total           Σn
 * @property {number} totalField      field 16 as stored
 * @property {string} uuid            lower-case
 * @property {number} colorIndex      field 3
 */

/**
 * @typedef {object} TrackRecord
 * @property {string|null} name
 * @property {string|null} key
 * @property {"H-KBM"|"H-OP"|"H-MAC48"|null} layout  the hypothesis used (B43), or null
 * @property {number} accepted     hypotheses accepted (0 to 3), before any tie-break
 * @property {import('./container.js').LayoutDecision|null} decision  how `layout` was chosen; null when the name failed
 * @property {number|null} colorIndex
 * @property {string|null} uuid
 * @property {Int32Array|null} positions  [lat0, lon0, lat1, lon1, …] semicircles, all segments in order
 * @property {Uint32Array|null} segmentStarts  index (in points) of each segment's first point; length S + 1
 * @property {"sum"|"sum_minus_overlaps"|"neither"|null} totalCount  how field 16 relates to Σn (§6.4 g)
 * @property {number} emptySegments
 */

/**
 * Parses one 'T' record body.
 * @param {Uint8Array} body
 * @param {Counts} counts  receives text_not_utf8
 * @param {number|null} [programVersion]  AllData.gdb's 'A' record program version; breaks ties (B43)
 * @returns {TrackRecord}
 */
export function parseTrack(body, counts, programVersion = null) {
  /** @type {TrackRecord} */
  const out = {
    name: null,
    key: null,
    layout: null,
    accepted: 0,
    decision: null,
    colorIndex: null,
    uuid: null,
    positions: null,
    segmentStarts: null,
    totalCount: null,
    emptySegments: 0,
  };
  // Agreed prefix: the name only (§6.5).
  try {
    const name = new Cursor(body).cstr('1');
    out.key = rawKey(body, name);
    out.name = decodeText(body, name, counts);
  } catch (error) {
    if (!(error instanceof ParseStop)) throw error;
    return out;
  }
  /** @type {Array<["H-KBM"|"H-OP"|"H-MAC48", TrackGeometry|null]>} */
  const tried = [
    ['H-KBM', tryLayout(() => trackLayout(body, 'H-KBM'))],
    ['H-OP', tryLayout(() => trackLayout(body, 'H-OP'))],
    ['H-MAC48', tryLayout(() => trackLayout(body, 'H-MAC48'))],
  ];
  const accepted = tried.filter(([, result]) => result !== null);
  out.accepted = accepted.length;
  const pick = chooseLayout('T', accepted.map(([label]) => label), programVersion);
  out.decision = pick.decision;
  const chosen = accepted.find(([label]) => label === pick.layout);
  if (!chosen) return out;
  const g = /** @type {TrackGeometry} */ (chosen[1]);
  out.layout = chosen[0];
  out.colorIndex = g.colorIndex;
  out.uuid = g.uuid;
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const positions = new Int32Array(g.total * 2);
  const starts = new Uint32Array(g.pointCounts.length + 1);
  let k = 0;
  for (let s = 0; s < g.pointCounts.length; s++) {
    starts[s] = k / 2;
    const n = g.pointCounts[s];
    if (n === 0) out.emptySegments++;
    let at = g.pointOffsets[s];
    for (let i = 0; i < n; i++, at += 8) {
      positions[k++] = view.getInt32(at, true);
      positions[k++] = view.getInt32(at + 4, true);
    }
  }
  starts[g.pointCounts.length] = g.total;
  out.positions = positions;
  out.segmentStarts = starts;
  const S = g.pointCounts.length;
  if (g.totalField === g.total) out.totalCount = 'sum';
  else if (S > 0 && g.totalField === g.total - (S - 1)) out.totalCount = 'sum_minus_overlaps';
  else out.totalCount = 'neither';
  return out;
}

/**
 * One track hypothesis: H-KBM has the two 4-byte gaps (G1, G2), H-OP does not (§6.1); H-MAC48 is H-KBM followed by
 * the Mac 4.8 tail after the uuid (§15.11). Runs every check of §6.4.
 * @param {Uint8Array} body
 * @param {"H-KBM"|"H-OP"|"H-MAC48"} layout
 * @returns {TrackGeometry}
 */
function trackLayout(body, layout) {
  const gaps = layout !== 'H-OP';
  const c = new Cursor(body);
  c.cstr('1');
  if (c.u8('2') > 1) c.fail('not_0_or_1', '2');
  if (gaps) c.skip(4, 'G1');
  const colorIndex = c.u32('3');
  c.stringList('4');
  c.cstr('5');
  c.skip(8, '6');
  c.fdouble('7');
  if (c.u8('8') > 1) c.fail('not_0_or_1', '8');
  const maxLat = c.lat('9');
  const maxLon = c.i32('9');
  const minLat = c.lat('10');
  const minLon = c.i32('10');
  // §6.4 e: track min ≤ track max.
  if (minLat > maxLat || minLon > maxLon) c.fail('track_min_above_max', '10');
  c.fdouble('11');
  c.skip(8, '12');
  c.fint('13');
  if (gaps) c.skip(4, 'G2');
  const segments = c.count(21, '14');
  /** @type {number[]} */
  const pointOffsets = [];
  /** @type {number[]} */
  const pointCounts = [];
  let total = 0;
  const view = c.view;
  for (let s = 0; s < segments; s++) {
    if (c.u8('15') > 1) c.fail('not_0_or_1', '15');
    const sMaxLat = c.lat('15');
    const sMaxLon = c.i32('15');
    const sMinLat = c.lat('15');
    const sMinLon = c.i32('15');
    const n = c.count(8, '15');
    if (n > 0) {
      // §6.4 d (segment bounds in order) and e (track encloses segment).
      if (sMinLat > sMaxLat || sMinLon > sMaxLon) c.fail('segment_min_above_max', '15');
      if (sMinLat < minLat || sMinLon < minLon || sMaxLat > maxLat || sMaxLon > maxLon) {
        c.fail('segment_outside_track', '15');
      }
    }
    pointOffsets.push(c.pos);
    pointCounts.push(n);
    let at = c.pos;
    for (let i = 0; i < n; i++, at += 8) {
      const lat = view.getInt32(at, true);
      const lon = view.getInt32(at + 4, true);
      // §6.4 f (latitude range is implied by the bounds, which are range-checked) and d (point inside bounds).
      if (lat < sMinLat || lat > sMaxLat || lon < sMinLon || lon > sMaxLon) {
        c.pos = at;
        c.fail('point_outside_segment', '15');
      }
    }
    c.pos = at;
    total += n;
  }
  const totalField = c.u32('16');
  const uuid = c.uuid('17');
  if (layout === 'H-MAC48') {
    // The Mac 4.8 tail (§15.4 rows 19-23): 3 opaque bytes, 11 flag bytes, two fdoubles, 8 opaque bytes. Nothing in it
    // is exported.
    c.skip(3, '15.4 row 19');
    for (let i = 0; i < 11; i++) c.flag('15.4 row 20');
    c.fdouble('15.4 row 21');
    c.fdouble('15.4 row 22');
    c.skip(8, '15.4 row 23');
  }
  c.expectEnd(layout === 'H-MAC48' ? '15.4 row 23' : '17');
  return { pointOffsets, pointCounts, total, totalField, uuid, colorIndex };
}

/**
 * Materialises a decoded track's segments (Point objects) from its packed arrays. A point gets `hr` and `atemp` only
 * where it holds a value (model.js: they are optional, B44).
 * @param {Int32Array} positions
 * @param {Uint32Array} segmentStarts
 * @param {Float64Array|null} ele   NaN = absent
 * @param {Float64Array|null} time  ms, NaN = absent
 * @param {Float64Array|null} [hr]     bpm, NaN = absent
 * @param {Float64Array|null} [atemp]  °C, NaN = absent
 * @returns {import('../model.js').Point[][]}
 */
export function materialiseSegments(positions, segmentStarts, ele, time, hr = null, atemp = null) {
  /** @type {import('../model.js').Point[][]} */
  const segments = [];
  for (let s = 0; s + 1 < segmentStarts.length; s++) {
    const from = segmentStarts[s];
    const to = segmentStarts[s + 1];
    const points = new Array(to - from);
    for (let i = from; i < to; i++) {
      const e = ele ? ele[i] : NaN;
      const t = time ? time[i] : NaN;
      /** @type {import('../model.js').Point} */
      const point = {
        lat: toDegrees(positions[2 * i]),
        lon: toDegrees(positions[2 * i + 1]),
        ele: Number.isNaN(e) ? null : e,
        time: Number.isNaN(t) ? null : t,
      };
      if (hr !== null && !Number.isNaN(hr[i])) point.hr = hr[i];
      if (atemp !== null && !Number.isNaN(atemp[i])) point.atemp = atemp[i];
      points[i - from] = point;
    }
    segments.push(points);
  }
  return segments;
}

/** Track colour names for indices 1-17, in §6.3 order, spelled as GPX's DisplayColor_t (gpx.js GARMIN_COLORS). */
const COLOR_NAMES = [
  null, 'Black', 'DarkRed', 'DarkGreen', 'DarkYellow', 'DarkBlue', 'DarkMagenta', 'DarkCyan', 'LightGray', 'DarkGray',
  'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White', 'Transparent',
];

/**
 * The colour name for a §6.3 index: null for 0 (Default) and for anything above 17.
 * @param {number|null} index
 * @returns {string|null}
 */
export function colorName(index) {
  return index !== null && Number.isInteger(index) && index >= 1 && index <= 17 ? COLOR_NAMES[index] : null;
}

// ---------------------------------------------------------------------------------------------
// 'R' route (FORMAT.md §7, §15.11)

/**
 * @typedef {object} RouteViaPoint
 * @property {string} name
 * @property {string} key        raw name bytes
 * @property {number} cls
 * @property {number|null} lat   degrees from the first link point, or null when L = 0
 * @property {number|null} lon
 */

/**
 * @typedef {object} RouteRecord
 * @property {string|null} name
 * @property {string|null} key
 * @property {"ok"|"autoroute"|"not_decoded"} status
 * @property {RouteViaPoint[]} points  complete only when status is "ok"
 * @property {"H-OP"|"H-MAC48"|null} layout  the layout used (B43), or null
 * @property {number} accepted   how many layouts decoded it (0, 1 or 2), before any tie-break
 * @property {import('./container.js').LayoutDecision|null} decision  how `layout` was chosen; null when the name failed
 */

/**
 * A via point as one hypothesis read it: name range, class, and the first link point (semicircles) or null.
 * @typedef {object} RawViaPoint
 * @property {[number, number]} name
 * @property {number} cls
 * @property {number|null} lat
 * @property {number|null} lon
 */

/**
 * @typedef {object} RouteParse
 * @property {"ok"|"autoroute"|"not_decoded"} status
 * @property {RawViaPoint[]} points
 */

/** Smallest Mac 4.8 route point (§15.11): 1 + 4 + 1 + 18 + 4 + 1 + 8 + 19. */
const MAC48_ROUTE_POINT_MIN = 56;

/**
 * Parses one 'R' record body. Two layouts are tried (§15.11): H-OP (≥ 1.46, §7.1-§7.4; the trailer is not read) and
 * H-MAC48 (read to the end of the record). The layouts that decode the route go through chooseLayout() (B43): one
 * decodes it, use it, except H-OP alone in a Mac 4.8 file (not decoded); both, the program version picks one or
 * neither (not decoded, counted as matching more than one layout). Neither decodes it: "autoroute" when H-OP stopped
 * at an autoroute count A > 0, else not decoded.
 * @param {Uint8Array} body
 * @param {Counts} counts  receives text_not_utf8, route_several_layouts, route_layout_by_program_version,
 *   route_op_only_in_mac48_file
 * @param {number|null} [programVersion]  AllData.gdb's 'A' record program version
 * @returns {RouteRecord}
 */
export function parseRoute(body, counts, programVersion = null) {
  /** @type {RouteRecord} */
  const out = { name: null, key: null, status: 'not_decoded', points: [], layout: null, accepted: 0, decision: null };
  /** @type {[number, number]} */
  let name;
  try {
    name = new Cursor(body).cstr('1');
  } catch (error) {
    if (!(error instanceof ParseStop)) throw error;
    return out;
  }
  out.key = rawKey(body, name);
  out.name = decodeText(body, name, counts);
  const op = routeOp(body);
  const mac48 = routeMac48(body);
  /** @type {string[]} */
  const fits = [];
  if (op.status === 'ok') fits.push('H-OP');
  if (mac48.status === 'ok') fits.push('H-MAC48');
  out.accepted = fits.length;
  const pick = chooseLayout('R', fits, programVersion);
  out.decision = pick.decision;
  /** @type {RouteParse} */
  let chosen;
  if (pick.layout !== null) {
    chosen = pick.layout === 'H-OP' ? op : mac48;
    out.layout = pick.layout === 'H-OP' ? 'H-OP' : 'H-MAC48';
    out.status = 'ok';
    if (pick.decision === 'program_version') counts.add('route_layout_by_program_version');
  } else if (pick.decision === 'several') {
    counts.add('route_several_layouts');
    return out;
  } else if (pick.decision === 'not_for_version') {
    counts.add('route_op_only_in_mac48_file');
    return out;
  } else {
    if (op.status !== 'autoroute') return out;
    chosen = op;
    out.status = 'autoroute';
  }
  for (const p of chosen.points) {
    out.points.push({
      name: decodeText(body, p.name, counts),
      key: rawKey(body, p.name),
      cls: p.cls,
      lat: p.lat === null ? null : toDegrees(p.lat),
      lon: p.lon === null ? null : toDegrees(p.lon),
    });
  }
  return out;
}

/**
 * H-OP, the ≥ 1.46 layout (§7.1, §7.2, §7.4). The trailer is not parsed, so exact consumption is not checked.
 * @param {Uint8Array} body
 * @returns {RouteParse}
 */
function routeOp(body) {
  /** @type {RouteParse} */
  const out = { status: 'not_decoded', points: [] };
  const c = new Cursor(body);
  try {
    c.cstr('1');
    c.flag('2');
    const count = c.count(43, '3');
    for (let p = 0; p < count; p++) {
      const pointName = c.cstr('4');
      const cls = c.u32('4');
      c.fstring('4');
      c.skip(4 + 4 + 4 + 2 + 4, '4');
      const via = readLinks(c, pointName, cls, '4');
      if (c.flag('4') === 0) readBounds(c, '4');
      for (let i = 0; i < 8; i++) if (c.u8('4') !== 0xff) c.fail('not_ff', '4');
      c.fint('4');
      if (c.fint('4') !== null) c.fdouble('4');
      const autoroute = c.u32('4');
      out.points.push(via);
      if (autoroute > 0) {
        out.status = 'autoroute';
        return out;
      }
    }
    c.skip(3, '5');
    if (c.flag('6') === 0) readBounds(c, '7');
    out.status = 'ok';
  } catch (error) {
    if (!(error instanceof ParseStop)) throw error;
    out.status = 'not_decoded';
  }
  return out;
}

/**
 * H-MAC48, the Mac 4.8 layout (§15.5, §15.11), read to the end of the record. A non-zero byte in a point's 19-byte run
 * or an autoroute-settings flag of 1 fails it: those may announce road-following data whose layout is unknown.
 * @param {Uint8Array} body
 * @returns {RouteParse}
 */
function routeMac48(body) {
  /** @type {RouteParse} */
  const out = { status: 'not_decoded', points: [] };
  const c = new Cursor(body);
  try {
    c.cstr('15.5 row 1');
    c.flag('15.5 row 2');
    const count = c.count(MAC48_ROUTE_POINT_MIN, '15.5 row 3');
    for (let p = 0; p < count; p++) {
      const pointName = c.cstr('15.5 row a');
      const cls = c.u32('15.5 row b');
      c.fstring('15.5 row c');
      c.skip(4 + 4 + 4 + 2 + 4, '15.5 rows d-h');
      const via = readLinks(c, pointName, cls, '15.5 row j');
      if (c.flag('15.5 row k') === 0) readBounds(c, '15.5 row l');
      for (let i = 0; i < 8; i++) if (c.u8('15.5 row m') !== 0xff) c.fail('not_ff', '15.5 row m');
      for (let i = 0; i < 19; i++) c.zero('15.5 row n');
      out.points.push(via);
    }
    if (c.flag('15.5 row 5') === 0) readBounds(c, '15.5 row 6');
    c.stringList('15.5 row 7');
    c.u32('15.5 row 8');
    if (c.flag('15.5 row 9') !== 0) c.fail('autoroute_settings', '15.5 row 9');
    c.cstr('15.5 row 10');
    c.flag('15.5 row 11');
    const filtered = c.count(8, '15.5 row 12');
    for (let i = 0; i < filtered; i++) {
      c.lat('15.5 row 12');
      c.i32('15.5 row 12');
    }
    if (c.flag('15.5 row 13') === 0) readBounds(c, '15.5 row 13');
    c.u8('15.5 row 14');
    c.u32('15.5 row 15');
    c.skip(10, '15.5 row 16');
    c.expectEnd('15.5 row 16');
    out.status = 'ok';
  } catch (error) {
    if (!(error instanceof ParseStop)) throw error;
    out.status = 'not_decoded';
  }
  return out;
}

/**
 * A link-point count and its link points; returns the via point with its first link point (or none when L = 0).
 * @param {Cursor} c
 * @param {[number, number]} name
 * @param {number} cls
 * @param {string} field
 * @returns {RawViaPoint}
 */
function readLinks(c, name, cls, field) {
  const links = c.count(8, field);
  /** @type {number|null} */
  let lat = null;
  /** @type {number|null} */
  let lon = null;
  for (let i = 0; i < links; i++) {
    const la = c.lat(field);
    const lo = c.i32(field);
    if (i === 0) {
      lat = la;
      lon = lo;
    }
  }
  return { name, cls, lat, lon };
}

/**
 * Two positions (max, min), latitudes checked.
 * @param {Cursor} c
 * @param {string} field
 */
function readBounds(c, field) {
  c.lat(field);
  c.i32(field);
  c.lat(field);
  c.i32(field);
}
