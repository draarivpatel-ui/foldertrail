// Gate 1 kit: compares a real BaseCamp library, made by the founder from the kit's made-up GPX files, with
// expected.json. It prints ONLY the kit's own labels (from expected.json, never from the library), numbers and yes/no.
// No string, coordinate or time read from the library is ever put into the output; byte offsets and small integers
// (record lengths, class and icon numbers, counts) are structure, not content.
//
// What it can tell without the record parsers (which are not built yet and are exactly what Gate 1 tests):
// - which made-up items exist, found by the agreed leading name field (FORMAT §5.1, §6.1, §7.1, §8.1-§8.3);
// - whether a waypoint's agreed prefix (name, class, position, comment, FORMAT §5.1) reads as FORMAT.md says;
// - WHERE known made-up values sit inside a record (byte offsets of the elevation, time, address and phone):
//   that settles the H-KBM / H-OP question (§5.2) and the track gaps (§6) without decoding the layout first;
// - the folder and list tree (§8), items in two lists, the duplicate-name track pair (§10);
// - for each track, its TrackSegments file: point count, bytes per point and where elevation and time sit (§9). The
//   file's uuid is looked for at the record end (§6.1) and, failing that, after the last point found: on Mac BaseCamp
//   4.8 a 24- or 40-byte tail follows it (§15.4 row 18). Only its distance from the end is printed, never the uuid.
// - BaseCamp renames the second of two same-named imports "<name> 001" (§15.1, measured once); for the twin tracks that
//   one form, and only that form, is a candidate, told apart from the twin by its positions.
//
// The library is hostile input: every read is bounds-checked, every loop is bounded by the input size, and nothing
// throws out of compareLibrary(): an internal failure is reported as a line in plain words.

const SEMICIRCLES_PER_DEGREE = 2 ** 31 / 180;
/** Allowed difference in semicircles (1 unit is about 8.4e-8 degree) for GPX text rounding and conversion. */
export const POSITION_TOLERANCE = 3;
const ROOT_FOLDER_ID = 0xffffffff;
/** Bodies larger than this are not searched (a made-up item is far smaller). */
const MAX_SEARCH_BYTES = 1 << 20;
/** TrackSegments files larger than this are not probed. */
const MAX_SEGMENTS_FILE_BYTES = 16 << 20;
/** How far into a TrackSegments point area to look for the first point's values. */
const FIRST_POINT_WINDOW = 64;
const UUID_SHAPE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
/** Seconds from 1970-01-01 to Garmin's device epoch, 1989-12-31T00:00:00Z. Tried when Unix seconds are not found. */
export const GARMIN_EPOCH_OFFSET = 631065600;
/**
 * Largest number read at a guessed offset (a class, icon, point count or "created by" field) that the report prints
 * as it is. FORMAT.md's offsets are what Gate 1 tests, so such a slot may really hold a time (Unix seconds are far
 * above this) or a coordinate (semicircles pass it beyond about 0.0055 degree). Larger values print as "large".
 */
const MAX_PRINTED_RAW = 0xffff;

const encoder = new TextEncoder();

/**
 * A raw number read at a guessed offset, safe to print: itself when it is a small non-negative integer, else "large".
 * null (could not be read) stays null.
 * @param {number|null|undefined} v
 * @returns {number|"large"|null}
 */
function rawSmall(v) {
  if (v === null || v === undefined) return null;
  return Number.isInteger(v) && v >= 0 && v <= MAX_PRINTED_RAW ? v : 'large';
}

/**
 * @typedef {object} RecordIn
 * @property {string|number} type   a one-letter type ('W') or its byte value
 * @property {Uint8Array} body
 */

/**
 * @typedef {object} LibraryIn
 * @property {{records: RecordIn[]}|null} gdb            AllData.gdb as container.js read it, or null when absent
 * @property {{records: RecordIn[]}|null} gfi            FolderData.gfi, or null
 * @property {Array<{name: string, bytes: Uint8Array, bodyStart?: number}>} trackSegments   TrackSegments files: base name
 *   (the uuid), bytes, and where the point count starts (container.js readHeader().bodyStart) when known
 */

// ---------------------------------------------------------------------------------------------
// Bounds-checked reads. Each returns null when the read would leave the buffer.

/**
 * @param {Uint8Array} b
 * @param {number} o
 * @returns {number|null}
 */
function u8(b, o) {
  return Number.isInteger(o) && o >= 0 && o < b.length ? b[o] : null;
}

/**
 * @param {Uint8Array} b
 * @param {number} o
 * @returns {number|null}
 */
function u32(b, o) {
  if (!Number.isInteger(o) || o < 0 || o + 4 > b.length) return null;
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

/**
 * @param {Uint8Array} b
 * @param {number} o
 * @returns {number|null}
 */
function i32(b, o) {
  const v = u32(b, o);
  return v === null ? null : v | 0;
}

/**
 * @param {Uint8Array} b
 * @param {number} o
 * @returns {number|null}
 */
function f64(b, o) {
  if (!Number.isInteger(o) || o < 0 || o + 8 > b.length) return null;
  return new DataView(b.buffer, b.byteOffset + o, 8).getFloat64(0, true);
}

/**
 * Index just past the NUL that ends the cstr starting at `o`, or null when there is none inside the buffer.
 * @param {Uint8Array} b
 * @param {number} o
 * @returns {number|null}
 */
function cstrEnd(b, o) {
  if (!Number.isInteger(o) || o < 0 || o >= b.length) return null;
  const nul = b.indexOf(0, o);
  return nul < 0 ? null : nul + 1;
}

/**
 * True when the cstr at `o` is exactly `name` (UTF-8 bytes, then NUL).
 * @param {Uint8Array} b
 * @param {number} o
 * @param {Uint8Array} name
 * @returns {boolean}
 */
function cstrIs(b, o, name) {
  if (o < 0 || o + name.length >= b.length) return false;
  for (let i = 0; i < name.length; i++) if (b[o + i] !== name[i]) return false;
  return b[o + name.length] === 0;
}

/**
 * True when the cstr at `o` starts with `prefix`.
 * @param {Uint8Array} b
 * @param {number} o
 * @param {Uint8Array} prefix
 * @returns {boolean}
 */
function cstrStartsWith(b, o, prefix) {
  if (o < 0 || o + prefix.length > b.length) return false;
  for (let i = 0; i < prefix.length; i++) if (b[o + i] !== prefix[i]) return false;
  return true;
}

/**
 * BaseCamp's rename of a duplicate imported name (FORMAT.md §15.1, measured once on Mac 4.8.13: the second "Gate1 Twin
 * Track" became "Gate1 Twin Track 001"): the name, a space and exactly three digits. Only this measured form counts;
 * any other rename is not matched (no guessing).
 * @param {Uint8Array} b
 * @param {Uint8Array} name
 * @returns {boolean}
 */
function cstrIsRenamed(b, name) {
  const n = name.length;
  if (!cstrStartsWith(b, 0, name) || b.length < n + 5 || b[n] !== 0x20 || b[n + 4] !== 0) return false;
  for (let i = n + 1; i < n + 4; i++) if (b[i] < 0x30 || b[i] > 0x39) return false;
  return true;
}

/**
 * The uuid-shaped cstr (36 ASCII characters, then NUL) starting at `o`, or null.
 * @param {Uint8Array} b
 * @param {number} o
 * @returns {string|null}
 */
function uuidAt(b, o) {
  if (o < 0 || o + 37 > b.length || b[o + 36] !== 0) return null;
  if (b[o + 8] !== 0x2d || b[o + 13] !== 0x2d || b[o + 18] !== 0x2d || b[o + 23] !== 0x2d) return null;
  let ascii = '';
  for (let i = o; i < o + 36; i++) ascii += String.fromCharCode(b[i]);
  return UUID_SHAPE.test(ascii) ? ascii : null;
}

/**
 * Where a track record names its TrackSegments file. FORMAT §6.1 put the uuid cstr at the very end; on Mac 4.8 it
 * follows the point total and a 24- or 40-byte tail comes after it (§15.4 row 18). The end is tried first, then every
 * offset from `from` on; a uuid that names a file present in TrackSegments wins over one that does not.
 * @param {Uint8Array} b
 * @param {number} from
 * @param {Map<string, unknown>} files  TrackSegments files by lower-case name
 * @returns {{at: number, uuid: string}|null}
 */
function findTrackUuid(b, from, files) {
  const atEnd = uuidAt(b, b.length - 37);
  if (atEnd !== null && files.has(atEnd.toLowerCase())) return { at: b.length - 37, uuid: atEnd };
  /** @type {{at: number, uuid: string}|null} */
  let first = atEnd === null ? null : { at: b.length - 37, uuid: atEnd };
  for (let o = Math.max(0, from); o + 37 <= b.length; o++) {
    const uuid = uuidAt(b, o);
    if (uuid === null) continue;
    if (files.has(uuid.toLowerCase())) return { at: o, uuid };
    if (first === null) first = { at: o, uuid };
  }
  return first;
}

/**
 * First index of `needle` in `hay` at or after `from` and before `to`, or -1.
 * @param {Uint8Array} hay
 * @param {Uint8Array} needle
 * @param {number} [from]
 * @param {number} [to]   exclusive limit for the match start
 * @returns {number}
 */
function indexOfBytes(hay, needle, from = 0, to = hay.length) {
  if (needle.length === 0) return -1;
  const last = Math.min(to, hay.length - needle.length + 1);
  outer: for (let i = Math.max(0, from); i < last; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * @param {number} v
 * @returns {Uint8Array}
 */
function f64Bytes(v) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v, true);
  return b;
}

/**
 * @param {number} v
 * @returns {Uint8Array}
 */
function f32Bytes(v) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, v, true);
  return b;
}

/**
 * FORMAT.md says elevations are f64 and times are i32 Unix seconds. If the Mac files differ, these fallbacks still
 * say where the value is (and in which encoding), so one Gate 1 run is enough.
 * @typedef {{ encoding: string, bytes: Uint8Array, read: (b: Uint8Array, o: number) => number|null, value: number }} Needle
 */

/**
 * @param {number} v  metres
 * @returns {Needle[]}
 */
function elevationNeedles(v) {
  return [
    { encoding: 'f64', bytes: f64Bytes(v), read: f64, value: v },
    { encoding: 'f32', bytes: f32Bytes(v), read: f32, value: Math.fround(v) },
  ];
}

/**
 * @param {number} t  Unix seconds
 * @returns {Needle[]}
 */
function timeNeedles(t) {
  return [
    { encoding: 'unix', bytes: i32Bytes(t), read: i32, value: t },
    { encoding: 'garmin-1989', bytes: i32Bytes(t - GARMIN_EPOCH_OFFSET), read: i32, value: t - GARMIN_EPOCH_OFFSET },
  ];
}

/**
 * The first needle (in order of preference) found in [from, to), and where.
 * @param {Uint8Array} b
 * @param {Needle[]} needles
 * @param {number} [from]
 * @param {number} [to]
 * @returns {{ at: number, needle: Needle }|null}
 */
function findNeedle(b, needles, from = 0, to = b.length) {
  for (const needle of needles) {
    const at = indexOfBytes(b, needle.bytes, from, to);
    if (at >= 0) return { at, needle };
  }
  return null;
}

/**
 * @param {Uint8Array} b
 * @param {number} o
 * @returns {number|null}
 */
function f32(b, o) {
  if (!Number.isInteger(o) || o < 0 || o + 4 > b.length) return null;
  return new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0, true);
}

/**
 * @param {number} v
 * @returns {Uint8Array}
 */
function i32Bytes(v) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, v, true);
  return b;
}

/**
 * @param {string} s
 * @returns {Uint8Array}
 */
function cstrBytes(s) {
  const e = encoder.encode(s);
  const out = new Uint8Array(e.length + 1);
  out.set(e);
  return out;
}

/**
 * @param {number} deg
 * @returns {number}
 */
function semicircles(deg) {
  return Math.round(deg * SEMICIRCLES_PER_DEGREE) | 0;
}

/**
 * @param {string|null} iso
 * @returns {number|null}
 */
function unixSeconds(iso) {
  if (typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * Where a position (two LE i32 semicircles, within the tolerance) starts, searching from `from`; -1 when absent.
 * @param {Uint8Array} b
 * @param {number} lat
 * @param {number} lon
 * @param {number} [from]
 * @returns {number}
 */
function findPosition(b, lat, lon, from = 0) {
  const sLat = semicircles(lat);
  const sLon = semicircles(lon);
  for (let o = Math.max(0, from); o + 8 <= b.length; o++) {
    const a = /** @type {number} */ (i32(b, o));
    if (Math.abs(a - sLat) > POSITION_TOLERANCE) continue;
    const c = /** @type {number} */ (i32(b, o + 4));
    if (Math.abs(c - sLon) <= POSITION_TOLERANCE) return o;
  }
  return -1;
}

/**
 * The longest run of this segment's points stored back to back (8 bytes apart), searching from `from`. A track's
 * stored bounds (FORMAT §6.1 fields 9-10) can equal its first point, so the first single match is not enough.
 * @param {Uint8Array} b
 * @param {Array<{lat: number, lon: number}>} seg
 * @param {number} from
 * @returns {{at: number, run: number}}
 */
function longestRun(b, seg, from) {
  let best = { at: -1, run: 0 };
  if (seg.length === 0) return best;
  let o = findPosition(b, seg[0].lat, seg[0].lon, from);
  while (o >= 0) {
    let k = 1;
    while (k < seg.length && positionAt(b, o + 8 * k, seg[k].lat, seg[k].lon)) k++;
    if (k > best.run) best = { at: o, run: k };
    if (k === seg.length) break;
    o = findPosition(b, seg[0].lat, seg[0].lon, o + 1);
  }
  return best;
}

/**
 * @param {Uint8Array} b
 * @param {number} o
 * @param {number} lat
 * @param {number} lon
 * @returns {boolean}
 */
function positionAt(b, o, lat, lon) {
  const a = i32(b, o);
  const c = i32(b, o + 4);
  return a !== null && c !== null && Math.abs(a - semicircles(lat)) <= POSITION_TOLERANCE && Math.abs(c - semicircles(lon)) <= POSITION_TOLERANCE;
}

/**
 * @param {boolean} v
 * @returns {string}
 */
function yn(v) {
  return v ? 'yes' : 'no';
}

/**
 * @param {number} n
 * @returns {string}
 */
function signed(n) {
  return n >= 0 ? `+${n}` : String(n);
}

// ---------------------------------------------------------------------------------------------
// Records

/**
 * @param {unknown} container
 * @returns {{ records: Array<{type: string, body: Uint8Array}>, skipped: number }}
 */
function normalise(container) {
  /** @type {Array<{type: string, body: Uint8Array}>} */
  const records = [];
  let skipped = 0;
  const list = container && typeof container === 'object' ? /** @type {any} */ (container).records : null;
  if (!Array.isArray(list)) return { records, skipped };
  for (const r of list) {
    const t = r && typeof r === 'object' ? r.type : undefined;
    const type = typeof t === 'number' && Number.isInteger(t) && t >= 0 && t < 256 ? String.fromCharCode(t) : typeof t === 'string' && t.length === 1 ? t : null;
    const body = r && r.body instanceof Uint8Array ? r.body : null;
    if (type === null || body === null) {
      skipped++;
      continue;
    }
    records.push({ type, body });
  }
  return { records, skipped };
}

/**
 * Parse the agreed waypoint prefix (FORMAT §5.1). Returns null fields where the bytes do not allow a read.
 * @param {Uint8Array} b
 * @returns {{ classValue: number|null, positionAt: number|null, commentStart: number|null, prefixEnd: number|null, icon: number|null }}
 */
function waypointPrefix(b) {
  const out = { classValue: null, positionAt: null, commentStart: null, prefixEnd: null, icon: null };
  const p = cstrEnd(b, 0);
  if (p === null) return out;
  out.classValue = u32(b, p);
  if (p + 12 > b.length) return out;
  out.positionAt = p + 4;
  out.commentStart = p + 12;
  const c = cstrEnd(b, p + 12);
  if (c === null) return out;
  const flag = u8(b, c);
  if (flag !== 0 && flag !== 1) return out;
  const afterProx = c + 1 + (flag === 1 ? 8 : 0);
  const icon = u32(b, afterProx + 4);
  if (icon === null) return out;
  out.icon = icon;
  out.prefixEnd = afterProx + 8;
  return out;
}

// ---------------------------------------------------------------------------------------------
// TrackSegments

/**
 * @typedef {object} SegmentsProbe
 * @property {boolean} headerRead
 * @property {number|"large"|null} pointCount   the u32 after the header ("large" above MAX_PRINTED_RAW)
 * @property {number|null} bytesPerPoint
 * @property {number|null} elevationAt      offset of the first point's elevation inside its point
 * @property {string|null} elevationEncoding  "f64" (FORMAT.md) or "f32"
 * @property {number|null} timeAt           offset of the first point's time inside its point
 * @property {string|null} timeEncoding     "unix" (FORMAT.md) or "garmin-1989"
 * @property {number} elevationsMatched
 * @property {number} timesMatched
 * @property {string|null} firstPointPattern  each byte of the first point as 0, 1 or x (any other value)
 * @property {number|null} temperatureAt    sensor track only: the first air temperature as f64
 * @property {number|null} heartRateAt      sensor track only: the first heart rate as f64, else as u8
 */

/**
 * Where the bare u32 point count starts: after the §3.1 header (signature, primary format, 'D' record, 'A' record,
 * application cstr). Used only when the caller did not pass container.js's own `bodyStart`.
 * @param {Uint8Array} b
 * @returns {number|null}
 */
function segmentsBodyStart(b) {
  let p = 6;
  const dLen = u32(b, p);
  if (dLen !== 2 || u8(b, p + 4) !== 0x44) return null;
  p += 5 + dLen;
  const aLen = u32(b, p);
  if (aLen === null || u8(b, p + 4) !== 0x41 || p + 5 + aLen > b.length) return null;
  p += 5 + aLen;
  const appEnd = cstrEnd(b, p);
  if (appEnd === null || appEnd - p > 64) return null;
  return appEnd;
}

/**
 * @param {Uint8Array} b
 * @param {Array<{ele: number|null, time: string|null, atemp?: number, hr?: number}>} points
 * @param {number|undefined} bodyStart  container.js's readHeader().bodyStart, when the header was read
 * @returns {SegmentsProbe}
 */
function probeSegments(b, points, bodyStart) {
  /** @type {SegmentsProbe} */
  const out = {
    headerRead: false,
    pointCount: null,
    bytesPerPoint: null,
    elevationAt: null,
    elevationEncoding: null,
    timeAt: null,
    timeEncoding: null,
    elevationsMatched: 0,
    timesMatched: 0,
    firstPointPattern: null,
    temperatureAt: null,
    heartRateAt: null,
  };
  // FORMAT §9.1: the header, then a bare u32 point count, then the points.
  const appEnd = Number.isInteger(bodyStart) && /** @type {number} */ (bodyStart) > 0 ? /** @type {number} */ (bodyStart) : segmentsBodyStart(b);
  if (appEnd === null) return out;
  const m = u32(b, appEnd);
  if (m === null) return out;
  out.headerRead = true;
  out.pointCount = rawSmall(m);
  const start = appEnd + 4;
  const region = b.length - start;
  if (m > 0 && region % m === 0) out.bytesPerPoint = region / m;
  const window = Math.min(start + FIRST_POINT_WINDOW, b.length);
  const first = points[0];
  /** @type {Needle|null} */
  let eleNeedle = null;
  /** @type {Needle|null} */
  let timeNeedle = null;
  if (first && first.ele !== null) {
    const hit = findNeedle(b, elevationNeedles(first.ele), start, window);
    if (hit) {
      out.elevationAt = hit.at - start;
      out.elevationEncoding = hit.needle.encoding;
      eleNeedle = hit.needle;
    }
  }
  const t0 = first ? unixSeconds(first.time) : null;
  if (t0 !== null) {
    const hit = findNeedle(b, timeNeedles(t0), start, window);
    if (hit) {
      out.timeAt = hit.at - start;
      out.timeEncoding = hit.needle.encoding;
      timeNeedle = hit.needle;
    }
  }
  if (first && typeof first.atemp === 'number') {
    const at = indexOfBytes(b, f64Bytes(first.atemp), start, window);
    if (at >= 0) out.temperatureAt = at - start;
  }
  if (first && typeof first.hr === 'number') {
    let at = indexOfBytes(b, f64Bytes(first.hr), start, window);
    if (at < 0 && out.bytesPerPoint !== null) at = indexOfBytes(b, Uint8Array.of(first.hr), start, start + out.bytesPerPoint);
    if (at >= 0) out.heartRateAt = at - start;
  }
  const n = out.bytesPerPoint;
  if (n !== null) {
    const count = Math.min(m, points.length);
    for (let k = 0; k < count; k++) {
      const q = points[k];
      if (eleNeedle && out.elevationAt !== null && q.ele !== null) {
        const want = elevationNeedles(q.ele).find((x) => x.encoding === eleNeedle?.encoding);
        if (want && eleNeedle.read(b, start + k * n + out.elevationAt) === want.value) out.elevationsMatched++;
      }
      const t = unixSeconds(q.time);
      if (timeNeedle && out.timeAt !== null && t !== null) {
        const want = timeNeedles(t).find((x) => x.encoding === timeNeedle?.encoding);
        if (want && timeNeedle.read(b, start + k * n + out.timeAt) === want.value) out.timesMatched++;
      }
    }
    if (n <= 64 && m > 0) {
      let pattern = '';
      for (let i = 0; i < n; i++) {
        const v = b[start + i];
        pattern += v === 0 ? '0' : v === 1 ? '1' : 'x';
      }
      out.firstPointPattern = pattern;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// AllData.gdb

/**
 * @param {Array<{type: string, body: Uint8Array}>} records
 * @param {any} expected
 * @param {Array<{name: string, bytes: Uint8Array, bodyStart?: number}>} trackSegments
 * @param {string[]} lines
 * @returns {object}
 */
function compareGdb(records, expected, trackSegments, lines) {
  const W = records.filter((r) => r.type === 'W');
  const T = records.filter((r) => r.type === 'T');
  const R = records.filter((r) => r.type === 'R');
  let tooBig = 0;
  const searchable = (/** @type {Uint8Array} */ b) => {
    if (b.length <= MAX_SEARCH_BYTES) return true;
    tooBig++;
    return false;
  };

  /** @type {Set<string>} */
  const ourNames = new Set();
  for (const w of expected.waypoints) ourNames.add(w.name);
  for (const t of expected.tracks) ourNames.add(t.name);
  for (const r of expected.routes) {
    ourNames.add(r.name);
    for (const v of r.via) ourNames.add(v.name);
  }
  const ourNameBytes = [...ourNames].map((n) => encoder.encode(n));
  /** Track names expected.json uses twice (the twins): BaseCamp renames the second on import (cstrIsRenamed). */
  /** @type {Map<string, number>} */
  const nameUse = new Map();
  for (const t of expected.tracks) nameUse.set(t.name, (nameUse.get(t.name) ?? 0) + 1);
  const sharedNameBytes = [...nameUse].filter(([, n]) => n > 1).map(([name]) => encoder.encode(name));
  const isOurs = (/** @type {Uint8Array} */ b) => ourNameBytes.some((n) => cstrIs(b, 0, n)) || sharedNameBytes.some((n) => cstrIsRenamed(b, n));

  // ---- waypoints
  const wpResults = [];
  let wpFound = 0;
  let wpPos = 0;
  let wpComment = 0;
  let wpCommentExpected = 0;
  for (const w of expected.waypoints) {
    const name = encoder.encode(w.name);
    const matches = W.filter((r) => cstrIs(r.body, 0, name));
    /** @type {any} */
    const res = { label: w.label, records: matches.length };
    if (w.comment !== '') wpCommentExpected++;
    if (matches.length > 0) {
      wpFound++;
      const b = matches[0].body;
      const pre = waypointPrefix(b);
      res.length = b.length;
      res.classValue = rawSmall(pre.classValue);
      res.icon = rawSmall(pre.icon);
      res.prefixEnd = pre.prefixEnd;
      res.positionMatches = pre.positionAt !== null && positionAt(b, pre.positionAt, w.lat, w.lon);
      if (res.positionMatches) wpPos++;
      if (w.comment !== '') {
        res.commentMatches = pre.commentStart !== null && cstrIs(b, pre.commentStart, encoder.encode(w.comment));
        if (res.commentMatches) wpComment++;
      }
      /** @type {Record<string, any>} */
      const markers = {};
      if (searchable(b)) {
        if (w.ele !== null) markers.elevation = markerAt(b, elevationNeedles(w.ele), pre.prefixEnd, true);
        const t = unixSeconds(w.time);
        if (t !== null) markers.time = markerAt(b, timeNeedles(t), pre.prefixEnd, true);
        const texts = textMarkers(w);
        for (const [key, value] of texts) markers[key] = markerAt(b, [{ encoding: 'cstr', bytes: cstrBytes(value), read: () => null, value: 0 }], pre.prefixEnd, false);
        if (!res.positionMatches) {
          // FORMAT.md says semicircles; if they are not there, look for the position as two f64 degrees.
          const both = new Uint8Array(16);
          both.set(f64Bytes(w.lat));
          both.set(f64Bytes(w.lon), 8);
          const at = indexOfBytes(b, both);
          res.positionAsDegreesAt = at >= 0 ? at : null;
        }
      }
      res.markers = markers;
    }
    wpResults.push(res);
  }

  // ---- route via points stored as waypoints (BaseCamp may or may not create them)
  const viaResults = [];
  for (const r of expected.routes) {
    for (const v of r.via) {
      const matches = W.filter((x) => cstrIs(x.body, 0, encoder.encode(v.name)));
      viaResults.push({
        label: v.label,
        records: matches.length,
        classValues: matches.map((m) => rawSmall(waypointPrefix(m.body).classValue)),
        positionMatches: matches.filter((m) => {
          const pre = waypointPrefix(m.body);
          return pre.positionAt !== null && positionAt(m.body, pre.positionAt, v.lat, v.lon);
        }).length,
      });
    }
  }

  // ---- routes
  const rtResults = [];
  let rtFound = 0;
  for (const r of expected.routes) {
    const name = encoder.encode(r.name);
    const matches = R.filter((x) => cstrIs(x.body, 0, name));
    /** @type {any} */
    const res = { label: r.label, records: matches.length, viaExpected: r.via.length };
    if (matches.length > 0) {
      rtFound++;
      const b = matches[0].body;
      res.length = b.length;
      const after = name.length + 1;
      res.autoNameByte = u8(b, after);
      res.pointCountField = rawSmall(u32(b, after + 1));
      let from = 0;
      let inOrder = 0;
      let found = 0;
      /** @type {number[]} */
      const viaOffsets = [];
      let positions = 0;
      if (searchable(b)) {
        for (const v of r.via) {
          const at = indexOfBytes(b, cstrBytes(v.name));
          if (at >= 0) {
            found++;
            viaOffsets.push(at);
            if (at >= from) {
              inOrder++;
              from = at + 1;
            }
            if (findPosition(b, v.lat, v.lon, at) >= 0) positions++;
          }
        }
      }
      res.viaNamesFound = found;
      res.viaNamesInOrder = inOrder;
      res.viaPositionsAfterName = positions;
      res.viaNameSpacing = viaOffsets.slice(1).map((o, i) => o - viaOffsets[i]);
    }
    rtResults.push(res);
  }

  // ---- tracks
  /** @type {Map<string, {name: string, bytes: Uint8Array, bodyStart?: number}>} */
  const tsByName = new Map();
  for (const f of trackSegments) {
    if (f && typeof f.name === 'string' && f.bytes instanceof Uint8Array) tsByName.set(f.name.toLowerCase(), f);
  }
  const trResults = [];
  let trFound = 0;
  let pointsExpected = 0;
  let pointsFound = 0;
  let tsMatched = 0;
  let elevExpected = 0;
  let elevMatched = 0;
  let timeExpected = 0;
  let timeMatched = 0;
  /** @type {Set<Uint8Array>} */
  const usedBodies = new Set();
  for (const t of expected.tracks) {
    const name = encoder.encode(t.name);
    const matches = T.filter((x) => cstrIs(x.body, 0, name));
    const all = t.segments.flat();
    pointsExpected += all.length;
    for (const p of all) {
      if (p.ele !== null) elevExpected++;
      if (p.time !== null) timeExpected++;
    }
    /** @type {any} */
    const res = { label: t.label, records: matches.length, pointsExpected: all.length, segmentsExpected: t.segments.length };
    /** @type {typeof T} */
    let candidates = matches;
    if ((nameUse.get(t.name) ?? 0) > 1) {
      res.sharedName = true;
      res.recordsStartingWithName = T.filter((x) => cstrStartsWith(x.body, 0, name)).length;
      // BaseCamp renames the second of two same-named imports (cstrIsRenamed): that record is a candidate too.
      candidates = matches.concat(T.filter((x) => cstrIsRenamed(x.body, name)));
    }
    // With a shared name, take the unused record that holds the longest run of this track's first segment.
    const firstSegment = t.segments.find((/** @type {unknown[]} */ s) => s.length > 0) ?? [];
    let pick;
    let pickRun = -1;
    for (const m of candidates) {
      if (usedBodies.has(m.body)) continue;
      // Points are looked for after the record's own name (a renamed twin's name is longer than the expected one).
      const run = searchable(m.body) ? longestRun(m.body, firstSegment, cstrEnd(m.body, 0) ?? name.length + 1).run : 0;
      if (run > pickRun) {
        pick = m;
        pickRun = run;
      }
    }
    if (pick) {
      trFound++;
      usedBodies.add(pick.body);
      const b = pick.body;
      res.length = b.length;
      if (res.sharedName) res.renamedByBaseCamp = !cstrIs(b, 0, name);
      /** @type {number[]} */
      const segmentStarts = [];
      let found = 0;
      let from = cstrEnd(b, 0) ?? name.length + 1;
      if (searchable(b)) {
        for (const seg of t.segments) {
          if (seg.length === 0) continue;
          const { at, run } = longestRun(b, seg, from);
          if (at < 0) continue;
          segmentStarts.push(at);
          found += run;
          from = at + 8 * run;
        }
      }
      pointsFound += found;
      res.pointsFoundInOrder = found;
      res.firstPointAt = segmentStarts.length > 0 ? segmentStarts[0] : null;
      res.gapsBetweenSegments = segmentStarts.slice(1).map((o, i) => o - (segmentStarts[i] + 8 * t.segments[i].length));
      // FORMAT §6.1: the record ends with the uuid cstr (36 characters and a NUL); on Mac 4.8 a tail follows it
      // (§15.4 row 18), so it is also looked for after the last point found.
      const found37 = searchable(b) ? findTrackUuid(b, from, tsByName) : null;
      const uuid = found37 === null ? null : found37.uuid;
      res.endsWithUuid = found37 !== null && found37.at === b.length - 37;
      res.uuidBytesFromEnd = found37 === null ? null : b.length - found37.at;
      const file = uuid === null ? undefined : tsByName.get(uuid.toLowerCase());
      res.segmentsFileFound = file !== undefined;
      if (file !== undefined) {
        tsMatched++;
        if (file.bytes.length <= MAX_SEGMENTS_FILE_BYTES) {
          const probe = probeSegments(file.bytes, all, file.bodyStart);
          res.segments = probe;
          elevMatched += probe.elevationsMatched;
          timeMatched += probe.timesMatched;
        } else {
          res.segments = null;
          res.segmentsFileTooLarge = true;
        }
      }
    }
    trResults.push(res);
  }

  const others = {
    W: W.filter((r) => !isOurs(r.body)).length,
    T: T.filter((r) => !isOurs(r.body)).length,
    R: R.filter((r) => !isOurs(r.body)).length,
  };

  // ---- lines
  const via = viaResults.reduce((s, v) => s + v.records, 0);
  lines.push('AllData.gdb');
  lines.push(`  Waypoints found by name: ${wpFound} of ${expected.waypoints.length}; positions matched: ${wpPos} of ${expected.waypoints.length}; comments matched: ${wpComment} of ${wpCommentExpected}`);
  lines.push(`  Tracks found by name: ${trFound} of ${expected.tracks.length}; track points found in order: ${pointsFound} of ${pointsExpected}`);
  lines.push(`  Routes found by name: ${rtFound} of ${expected.routes.length}; via points stored as waypoint records: ${via} (BaseCamp may or may not make these)`);
  lines.push(`  TrackSegments files matched to our tracks: ${tsMatched} of ${expected.tracks.length}; elevations matched: ${elevMatched} of ${elevExpected}; times matched: ${timeMatched} of ${timeExpected}`);
  lines.push(`  Records that are not ours: W ${others.W}, T ${others.T}, R ${others.R} (a fresh BaseCamp should have none)`);
  if (tooBig > 0) lines.push(`  Records too large to search: ${tooBig}`);
  for (const r of wpResults) lines.push('  ' + waypointLine(r));
  for (const v of viaResults) {
    lines.push(`  ${v.label}: waypoint records ${v.records}; class ${v.classValues.length ? v.classValues.join('/') : '-'}; position matched ${v.positionMatches}`);
  }
  for (const r of rtResults) lines.push('  ' + routeLine(r));
  for (const r of trResults) lines.push('  ' + trackLine(r));
  return { waypoints: wpResults, viaPoints: viaResults, routes: rtResults, tracks: trResults, others, recordsTooLargeToSearch: tooBig };
}

/**
 * @param {any} w  an expected waypoint
 * @returns {Array<[string, string]>}
 */
function textMarkers(w) {
  /** @type {Array<[string, string]>} */
  const out = [];
  const a = w.address ?? w.typedByHand;
  if (a) {
    for (const key of ['street', 'city', 'state', 'country', 'postalCode']) if (typeof a[key] === 'string' && a[key] !== '') out.push([key, a[key]]);
  }
  const phone = w.phone ?? (w.typedByHand ? w.typedByHand.phone : null);
  if (typeof phone === 'string' && phone !== '') out.push(['phone', phone]);
  return out;
}

/**
 * @param {Uint8Array} b
 * @param {Needle[]} needles   encodings to try, preferred first
 * @param {number|null} prefixEnd
 * @param {boolean} flagged   a value that may sit behind a presence flag (fdouble, fint)
 * @returns {{at: number, afterPrefix: number|null, encoding: string, flagBefore?: boolean}|null}
 */
function markerAt(b, needles, prefixEnd, flagged) {
  const hit = findNeedle(b, needles);
  if (hit === null) return null;
  const at = hit.at;
  /** @type {{at: number, afterPrefix: number|null, encoding: string, flagBefore?: boolean}} */
  const m = { at, afterPrefix: prefixEnd === null ? null : at - prefixEnd, encoding: hit.needle.encoding };
  if (flagged) m.flagBefore = at > 0 && b[at - 1] === 1;
  return m;
}

/**
 * @param {any} r
 * @returns {string}
 */
function waypointLine(r) {
  if (r.records === 0) return `${r.label}: not found`;
  const parts = [`records ${r.records}`, `length ${r.length}`, `class ${r.classValue ?? '-'}`, `icon ${r.icon ?? '-'}`, `position ${yn(r.positionMatches)}`];
  if (r.positionAsDegreesAt !== undefined) parts.push(`position as f64 degrees ${r.positionAsDegreesAt === null ? 'not found' : `at ${r.positionAsDegreesAt}`}`);
  if (r.commentMatches !== undefined) parts.push(`comment ${yn(r.commentMatches)}`);
  parts.push(`prefix ends at ${r.prefixEnd ?? '-'}`);
  for (const [key, m] of Object.entries(r.markers ?? {})) {
    if (m === null) parts.push(`${key} not found`);
    else {
      const where = m.afterPrefix === null ? `at ${m.at}` : `at prefix${signed(m.afterPrefix)}`;
      const unusual = m.encoding === 'f64' || m.encoding === 'unix' || m.encoding === 'cstr' ? '' : ` as ${m.encoding}`;
      parts.push(`${key}${unusual} ${where}${m.flagBefore === undefined ? '' : m.flagBefore ? ' (flag 1 before)' : ' (no flag before)'}`);
    }
  }
  return `${r.label}: ${parts.join('; ')}`;
}

/**
 * @param {any} r
 * @returns {string}
 */
function routeLine(r) {
  if (r.records === 0) return `${r.label}: not found`;
  return (
    `${r.label}: records ${r.records}; length ${r.length}; auto-name byte ${r.autoNameByte ?? '-'}; ` +
    `point count field ${r.pointCountField ?? '-'} (expected ${r.viaExpected}); via names found ${r.viaNamesFound} of ${r.viaExpected}, ` +
    `in order ${r.viaNamesInOrder}; via positions after their name ${r.viaPositionsAfterName}; spacing ${r.viaNameSpacing.join('/') || '-'}`
  );
}

/**
 * @param {any} r
 * @returns {string}
 */
function trackLine(r) {
  const shared = r.sharedName ? `; records starting with this name ${r.recordsStartingWithName}` : '';
  if (r.length === undefined) return `${r.label}: not found (records with this name ${r.records}${shared})`;
  const parts = [
    `records with this name ${r.records}${shared}${r.renamedByBaseCamp ? '; renamed by BaseCamp (number added) yes' : ''}`,
    `length ${r.length}`,
    `points in order ${r.pointsFoundInOrder} of ${r.pointsExpected}`,
    `first point at ${r.firstPointAt ?? '-'}`,
  ];
  if (r.segmentsExpected > 1) parts.push(`bytes between segments ${r.gapsBetweenSegments.join('/') || '-'}`);
  parts.push(`ends with uuid ${yn(r.endsWithUuid)}`);
  if (!r.endsWithUuid && r.uuidBytesFromEnd !== null && r.uuidBytesFromEnd !== undefined) parts.push(`uuid ${r.uuidBytesFromEnd} bytes from the end`);
  parts.push(`TrackSegments file ${yn(r.segmentsFileFound)}`);
  const s = r.segments;
  if (s) {
    parts.push(
      `segment points ${s.pointCount ?? '-'}`,
      `bytes per point ${s.bytesPerPoint ?? '-'}`,
      `elevation${s.elevationEncoding && s.elevationEncoding !== 'f64' ? ` as ${s.elevationEncoding}` : ''} at ${s.elevationAt ?? '-'}`,
      `time${s.timeEncoding && s.timeEncoding !== 'unix' ? ` as ${s.timeEncoding}` : ''} at ${s.timeAt ?? '-'}`,
      `elevations matched ${s.elevationsMatched}`,
      `times matched ${s.timesMatched}`,
      `first point bytes ${s.firstPointPattern ?? '-'}`,
    );
    if (s.temperatureAt !== null) parts.push(`temperature at ${s.temperatureAt}`);
    if (s.heartRateAt !== null) parts.push(`heart rate at ${s.heartRateAt}`);
    if (!s.headerRead) parts.push('TrackSegments header not as expected');
  } else if (r.segmentsFileTooLarge) parts.push('TrackSegments file too large to probe');
  return `${r.label}: ${parts.join('; ')}`;
}

// ---------------------------------------------------------------------------------------------
// FolderData.gfi

/**
 * @param {Array<{type: string, body: Uint8Array}>} records
 * @param {any} expected
 * @param {string[]} lines
 * @returns {object}
 */
function compareGfi(records, expected, lines) {
  /** @type {Array<{id: number, nameEnd: number, parent: number|null, children: Array<[number, number]>|null, body: Uint8Array}>} */
  const folders = [];
  for (const r of records) {
    if (r.type !== 'F') continue;
    const b = r.body;
    const id = u32(b, 0);
    const nameEnd = cstrEnd(b, 4);
    if (id === null || nameEnd === null) continue;
    const parent = u32(b, nameEnd);
    const count = u32(b, nameEnd + 4);
    /** @type {Array<[number, number]>|null} */
    let children = null;
    if (count !== null && count * 8 <= b.length - (nameEnd + 8)) {
      children = [];
      for (let i = 0; i < count; i++) {
        children.push([/** @type {number} */ (u32(b, nameEnd + 8 + 8 * i)), /** @type {number} */ (u32(b, nameEnd + 12 + 8 * i))]);
      }
    }
    folders.push({ id, nameEnd, parent, children, body: b });
  }
  /** @type {Array<{id: number, createdBy: number|null, parent: number|null, body: Uint8Array}>} */
  const lists = [];
  for (const r of records) {
    if (r.type !== 'I') continue;
    const b = r.body;
    const id = u32(b, 0);
    const nameEnd = cstrEnd(b, 4);
    if (id === null || nameEnd === null) continue;
    lists.push({ id, createdBy: u32(b, nameEnd), parent: u32(b, nameEnd + 4), body: b });
  }
  /** @type {Array<{type: string, parent: number, body: Uint8Array}>} */
  const refs = [];
  for (const r of records) {
    if (r.type !== 'W' && r.type !== 'T' && r.type !== 'R') continue;
    const parent = u32(r.body, 0);
    if (parent === null || cstrEnd(r.body, 4) === null) continue;
    refs.push({ type: r.type, parent, body: r.body });
  }

  const rootPresent = folders.some((f) => f.id === ROOT_FOLDER_ID);
  /** @type {Map<string, any>} */
  const folderOf = new Map();
  const folderResults = [];
  for (const f of expected.tree.folders) {
    const name = encoder.encode(f.name);
    const matches = folders.filter((x) => cstrIs(x.body, 4, name));
    const hit = matches[0];
    if (hit) folderOf.set(f.name, hit);
    folderResults.push({ label: f.label, records: matches.length, hit });
  }
  for (const r of folderResults) {
    const f = expected.tree.folders.find((/** @type {any} */ x) => x.label === r.label);
    if (!r.hit) continue;
    const parentHit = f.parent === null ? null : folderOf.get(f.parent);
    const parentId = f.parent === null ? ROOT_FOLDER_ID : parentHit ? parentHit.id : undefined;
    r.parentFieldMatches = parentId !== undefined && r.hit.parent === parentId;
    const parentRecord = f.parent === null ? folders.find((x) => x.id === ROOT_FOLDER_ID) : parentHit;
    r.listedInParentChildren = !!parentRecord && !!parentRecord.children && parentRecord.children.some(([type, id]) => type === 1 && id === r.hit.id);
    r.tailBytes = r.hit.children === null ? null : r.hit.body.length - (r.hit.nameEnd + 8 + 8 * r.hit.children.length);
  }

  /** @type {Map<string, any>} */
  const listOf = new Map();
  const listResults = [];
  for (const l of expected.tree.lists) {
    const name = encoder.encode(l.name);
    const matches = lists.filter((x) => cstrIs(x.body, 4, name));
    const hit = matches[0];
    /** @type {any} */
    const res = { label: l.label, records: matches.length };
    if (hit) {
      listOf.set(l.name, hit);
      const folder = folderOf.get(l.folder);
      res.createdBy = rawSmall(hit.createdBy);
      res.parentFieldMatches = !!folder && hit.parent === folder.id;
      res.listedInFolderChildren = !!folder && !!folder.children && folder.children.some((/** @type {[number, number]} */ [type, id]) => type === 0 && id === hit.id);
    }
    listResults.push(res);
  }

  // Placements: every (item, list) pair the founder should end up with.
  let placementsExpected = 0;
  let placementsFound = 0;
  /** @type {Array<{label: string, lists: number, found: number}>} */
  const multi = [];
  /** @type {Map<string, {expected: number, ours: number, notOurs: number}>} */
  const perList = new Map();
  for (const l of expected.tree.lists) perList.set(l.name, { expected: 0, ours: 0, notOurs: 0 });
  /**
   * @param {string} type
   * @param {any} item
   */
  const place = (type, item) => {
    let found = 0;
    for (const listName of item.lists) {
      placementsExpected++;
      const counts = perList.get(listName);
      if (counts) counts.expected++;
      const list = listOf.get(listName);
      if (!list) continue;
      const name = encoder.encode(item.name);
      if (refs.some((r) => r.type === type && r.parent === list.id && cstrIs(r.body, 4, name))) {
        placementsFound++;
        found++;
      }
    }
    if (item.lists.length > 1) multi.push({ label: item.label, lists: item.lists.length, found });
  };
  for (const w of expected.waypoints) place('W', w);
  for (const t of expected.tracks) place('T', t);
  for (const r of expected.routes) place('R', r);

  /** @type {Set<string>} */
  const ourNames = new Set([...expected.waypoints, ...expected.tracks, ...expected.routes].map((x) => x.name));
  const ourNameBytes = [...ourNames].map((n) => encoder.encode(n));
  for (const [listName, counts] of perList) {
    const list = listOf.get(listName);
    if (!list) continue;
    for (const r of refs) {
      if (r.parent !== list.id) continue;
      if (ourNameBytes.some((n) => cstrIs(r.body, 4, n))) counts.ours++;
      else counts.notOurs++;
    }
  }

  // The duplicate-name tracks: how many references carry that name, per list.
  const twinNames = [...new Set(expected.tracks.map((/** @type {any} */ t) => t.name))].filter(
    (n) => expected.tracks.filter((/** @type {any} */ t) => t.name === n).length > 1,
  );
  const twinRefs = twinNames.map((n) => refs.filter((r) => r.type === 'T' && cstrIs(r.body, 4, encoder.encode(n))).length);

  const createdByHistogram = {};
  for (const l of lists) {
    // Every list, ours or not: only small values are printed as they are.
    const key = String(rawSmall(l.createdBy));
    /** @type {any} */ (createdByHistogram)[key] = (/** @type {any} */ (createdByHistogram)[key] ?? 0) + 1;
  }

  lines.push('FolderData.gfi');
  lines.push(`  Root folder (My Collection) present: ${yn(rootPresent)}; folder records ${folders.length}; list records ${lists.length}; item references ${refs.length}`);
  lines.push(`  Our folders found: ${folderResults.filter((r) => r.records > 0).length} of ${expected.tree.folders.length}; our lists found: ${listResults.filter((r) => r.records > 0).length} of ${expected.tree.lists.length}`);
  lines.push(`  Items placed in the right lists: ${placementsFound} of ${placementsExpected}; items in two lists: ${multi.filter((m) => m.found === m.lists).length} of ${multi.length}`);
  lines.push(`  List "created by" values: ${Object.entries(createdByHistogram).map(([k, v]) => `${k}:${v}`).join(', ') || '-'}`);
  if (twinNames.length > 0) lines.push(`  Track references carrying the shared track name: ${twinRefs.join('/')} (expected 2)`);
  for (const r of folderResults) {
    if (!r.hit) lines.push(`  ${r.label}: not found`);
    else {
      lines.push(
        `  ${r.label}: records ${r.records}; parent field right ${yn(r.parentFieldMatches)}; listed in parent's children ${yn(r.listedInParentChildren)}; bytes after children ${r.tailBytes ?? '-'}`,
      );
    }
  }
  for (const r of listResults) {
    if (r.records === 0) lines.push(`  ${r.label}: not found`);
    else {
      const counts = perList.get(expected.tree.lists.find((/** @type {any} */ l) => l.label === r.label).name);
      lines.push(
        `  ${r.label}: records ${r.records}; created by ${r.createdBy ?? '-'}; parent field right ${yn(r.parentFieldMatches)}; ` +
          `listed in folder's children ${yn(r.listedInFolderChildren)}; references ${counts ? counts.ours : 0} of ours (expected ${counts ? counts.expected : 0}), ${counts ? counts.notOurs : 0} not ours`,
      );
    }
  }
  for (const m of multi) lines.push(`  ${m.label}: in ${m.found} of its ${m.lists} lists`);

  return {
    rootPresent,
    folderRecords: folders.length,
    listRecords: lists.length,
    references: refs.length,
    folders: folderResults.map(({ hit, ...rest }) => rest),
    lists: listResults,
    placements: { expected: placementsExpected, found: placementsFound },
    itemsInSeveralLists: multi,
    createdBy: createdByHistogram,
    sharedNameTrackReferences: twinRefs,
  };
}

// ---------------------------------------------------------------------------------------------

/**
 * Compare one library with expected.json. Never throws: problems become lines in plain words.
 * @param {LibraryIn} library
 * @param {any} expected   the parsed expected.json
 * @returns {{ lines: string[], json: object }}
 */
export function compareLibrary(library, expected) {
  /** @type {string[]} */
  const lines = [`Compared with expected.json (kit version ${Number(expected?.kitVersion) || '?'}): only counts, yes/no, byte offsets and small numbers.`];
  /** @type {any} */
  const json = { kitVersion: expected?.kitVersion ?? null };
  const lib = library && typeof library === 'object' ? library : /** @type {LibraryIn} */ ({ gdb: null, gfi: null, trackSegments: [] });
  const ts = Array.isArray(lib.trackSegments) ? lib.trackSegments : [];
  try {
    if (!expected || !Array.isArray(expected.waypoints) || !Array.isArray(expected.tracks) || !Array.isArray(expected.routes) || !expected.tree) {
      lines.push('The expected.json built into this page is not usable, so nothing was compared.');
      return { lines, json };
    }
  } catch {
    lines.push('The expected.json built into this page is not usable, so nothing was compared.');
    return { lines, json };
  }

  try {
    if (lib.gdb) {
      const { records, skipped } = normalise(lib.gdb);
      json.gdb = compareGdb(records, expected, ts, lines);
      if (skipped > 0) lines.push(`  Records the comparison could not use: ${skipped}`);
    } else {
      lines.push('AllData.gdb: not found, so items were not compared.');
      json.gdb = null;
    }
  } catch {
    lines.push('AllData.gdb: the comparison stopped early because of an internal error. The structure dump above is unaffected.');
    json.gdbError = true;
  }

  try {
    if (lib.gfi) {
      const { records, skipped } = normalise(lib.gfi);
      json.gfi = compareGfi(records, expected, lines);
      if (skipped > 0) lines.push(`  Records the comparison could not use: ${skipped}`);
    } else {
      lines.push('FolderData.gfi: not found, so the folder and list tree was not compared.');
      json.gfi = null;
    }
  } catch {
    lines.push('FolderData.gfi: the comparison stopped early because of an internal error. The structure dump above is unaffected.');
    json.gfiError = true;
  }
  return { lines, json };
}

/** Exposed for tests. */
export const internals = Object.freeze({ waypointPrefix, probeSegments, findPosition, indexOfBytes, semicircles });
