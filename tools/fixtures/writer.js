// Independent writer for synthetic Garmin BaseCamp libraries (docs/FORMAT.md §12).
//
// Written from docs/FORMAT.md alone. It never reads, imports or mirrors src/format/: the reader there is written by
// someone else from the same document, and the point of this module is that the two implementations cross-check each
// other. Where FORMAT.md leaves a choice open, the choice is listed in tools/fixtures/README.md.
//
// Test-only. A plain ES module with no node: imports, so the same code can feed a browser end-to-end test.
// Deterministic: the same description always gives the same bytes (UUIDs come from a seeded PRNG, nothing reads a clock).
// The writer throws on a bad *description* (a bug in a scenario). It never has to cope with hostile input.
//
// Units in a description follow src/model.js: degrees for coordinates, JS milliseconds (whole seconds) for times.
//
// Layouts: H-KBM (the default), H-OP, and H-MAC48 (FORMAT.md §15 and its reader contract §15.11: Mac BaseCamp 4.8.13).

/**
 * A track point: src/model.js's Point, with the two values only TrackSegments can hold (FORMAT.md §15.7, §15.11): air
 * temperature (°C, slot 6) and heart rate (bpm, slot 7). The reader returns them on track points (B44).
 * @typedef {import('../../src/model.js').Point & {atemp?: number|null, hr?: number|null}} Point
 */

export const TWO31 = 2 ** 31;
const TWO32 = 2 ** 32;
const U32_MAX = 0xffffffff;

/** The predefined root folder ("My Collection") of FolderData.gfi, FORMAT.md §8.1. */
export const ROOT_FOLDER_ID = 0xffffffff;

export const SIGNATURE = Object.freeze({ gdb: 'MsRc', gfi: 'DifG', trackSegments: 'MsRc' });

// ---------------------------------------------------------------------------------------------------------------------
// Text

/** @typedef {'utf8'|'latin1'|'cp1252'} Encoding */
/**
 * A string in a description: plain text (encoded with the field's encoding), raw bytes, or text with its own encoding.
 * @typedef {string | Uint8Array | { text: string, encoding: Encoding }} Text
 */

const UTF8 = new TextEncoder();
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// windows-1252 bytes 0x80-0x9F that map to printable characters. 0x81, 0x8D, 0x8F, 0x90 and 0x9D are left out on
// purpose: TextDecoder maps them to C1 controls, so they would not round-trip as text.
const CP1252_HIGH = new Map([
  ['€', 0x80], ['‚', 0x82], ['ƒ', 0x83], ['„', 0x84], ['…', 0x85], ['†', 0x86],
  ['‡', 0x87], ['ˆ', 0x88], ['‰', 0x89], ['Š', 0x8a], ['‹', 0x8b], ['Œ', 0x8c],
  ['Ž', 0x8e], ['‘', 0x91], ['’', 0x92], ['“', 0x93], ['”', 0x94], ['•', 0x95],
  ['–', 0x96], ['—', 0x97], ['˜', 0x98], ['™', 0x99], ['š', 0x9a], ['›', 0x9b],
  ['œ', 0x9c], ['ž', 0x9e], ['Ÿ', 0x9f],
]);

/**
 * Encodes text for a cstr. Throws on characters the encoding cannot hold and on NUL (a cstr cannot contain 0x00).
 * @param {Text} text
 * @param {Encoding} [encoding]  used when `text` is a plain string
 * @returns {Uint8Array}
 */
export function encodeText(text, encoding = 'utf8') {
  /** @type {Uint8Array} */
  let out;
  if (text instanceof Uint8Array) {
    out = text.slice();
  } else if (text !== null && typeof text === 'object') {
    return encodeText(text.text, text.encoding);
  } else if (typeof text !== 'string') {
    throw new TypeError(`text must be a string or bytes, got ${typeof text}`);
  } else if (encoding === 'utf8') {
    if (LONE_SURROGATE.test(text)) throw new RangeError('text has a lone surrogate; UTF-8 cannot encode it');
    out = UTF8.encode(text);
  } else if (encoding === 'latin1' || encoding === 'cp1252') {
    const bytes = [];
    for (const ch of text) {
      const code = /** @type {number} */ (ch.codePointAt(0));
      if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) bytes.push(code);
      else if (encoding === 'cp1252' && CP1252_HIGH.has(ch)) bytes.push(/** @type {number} */ (CP1252_HIGH.get(ch)));
      else throw new RangeError(`U+${code.toString(16).toUpperCase()} cannot be written as ${encoding}`);
    }
    out = Uint8Array.from(bytes);
  } else {
    throw new RangeError(`unknown encoding ${String(encoding)}`);
  }
  if (out.includes(0)) throw new RangeError('a cstr cannot contain a 0x00 byte');
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Numbers

/**
 * Latitude in degrees to semicircles (FORMAT.md §2 "coord"). |lat| ≤ 90 gives |v| ≤ 2^30.
 * @param {number} deg
 * @returns {number}
 */
export function latToSemicircles(deg) {
  if (!Number.isFinite(deg) || deg < -90 || deg > 90) throw new RangeError(`latitude out of range: ${deg}`);
  return Math.round((deg * TWO31) / 180) + 0; // + 0 turns -0 into 0
}

/**
 * Longitude in degrees to semicircles. +180° wraps to -2^31, because every i32 maps into [-180°, +180°).
 * @param {number} deg
 * @returns {number}
 */
export function lonToSemicircles(deg) {
  if (!Number.isFinite(deg) || deg < -180 || deg > 180) throw new RangeError(`longitude out of range: ${deg}`);
  let v = Math.round((deg * TWO31) / 180);
  if (v >= TWO31) v -= TWO32;
  return v + 0;
}

/**
 * Semicircles to degrees, exactly as FORMAT.md §2 defines it (v × 180 / 2^31; exact in binary64 for every i32).
 * @param {number} v
 * @returns {number}
 */
export function semicirclesToDegrees(v) {
  return ((v * 180) / TWO31) + 0;
}

/**
 * A model time (ms) to the file's i32 Unix seconds. Throws unless it is a whole number of seconds in i32 range.
 * @param {number} ms
 * @returns {number}
 */
export function msToSeconds(ms) {
  if (!Number.isInteger(ms) || ms % 1000 !== 0) throw new RangeError(`time must be whole seconds in ms, got ${ms}`);
  const s = ms / 1000;
  if (s < -TWO31 || s >= TWO31) throw new RangeError(`time does not fit an i32: ${ms}`);
  return s + 0;
}

/**
 * @param {unknown} v
 * @param {number} min
 * @param {number} max
 * @param {string} what
 */
function assertInt(v, min, max, what) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new RangeError(`${what} must be an integer in [${min}, ${max}], got ${String(v)}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Byte sink: little-endian primitives of FORMAT.md §2

export class ByteSink {
  constructor() {
    this.buf = new Uint8Array(256);
    this.view = new DataView(this.buf.buffer);
    this.length = 0;
  }

  /** @param {number} n */
  reserve(n) {
    if (this.length + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.length + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  /** @param {number} v */
  u8(v) {
    assertInt(v, 0, 0xff, 'u8');
    this.reserve(1);
    this.buf[this.length++] = v;
    return this;
  }

  /** @param {number} v */
  u16(v) {
    assertInt(v, 0, 0xffff, 'u16');
    this.reserve(2);
    this.view.setUint16(this.length, v, true);
    this.length += 2;
    return this;
  }

  /** @param {number} v */
  u32(v) {
    assertInt(v, 0, U32_MAX, 'u32');
    this.reserve(4);
    this.view.setUint32(this.length, v, true);
    this.length += 4;
    return this;
  }

  /** @param {number} v */
  i32(v) {
    assertInt(v, -TWO31, TWO31 - 1, 'i32');
    this.reserve(4);
    this.view.setInt32(this.length, v, true);
    this.length += 4;
    return this;
  }

  /** @param {number} v  any binary64, including NaN and ±Infinity (fixtures for FORMAT.md §2 rule 4) */
  f64(v) {
    if (typeof v !== 'number') throw new TypeError('f64 must be a number');
    this.reserve(8);
    this.view.setFloat64(this.length, v, true);
    this.length += 8;
    return this;
  }

  /** @param {ArrayLike<number>} bytes */
  bytes(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    for (const x of b) assertInt(x, 0, 0xff, 'byte');
    this.reserve(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
    return this;
  }

  /** @param {number} n */
  zeros(n) {
    assertInt(n, 0, 1 << 30, 'zero count');
    this.reserve(n);
    this.buf.fill(0, this.length, this.length + n);
    this.length += n;
    return this;
  }

  /**
   * cstr: the bytes, then 0x00.
   * @param {Text} text
   * @param {Encoding} [encoding]
   */
  cstr(text, encoding = 'utf8') {
    return this.bytes(encodeText(text, encoding)).u8(0);
  }

  /** @param {number|boolean} v  0 or 1 (a raw byte other than that only through `u8`) */
  flag(v) {
    return this.u8(v === true ? 1 : v === false ? 0 : v);
  }

  /**
   * fdouble: flag, then an f64 when present.
   * @param {number|null|undefined} v
   * @param {number} [presentFlag]  the byte written when present (1; a corrupt fixture may write 2)
   */
  fdouble(v, presentFlag = 1) {
    if (v === null || v === undefined) return this.u8(0);
    return this.u8(presentFlag).f64(v);
  }

  /**
   * fint: flag, then an i32 when present.
   * @param {number|null|undefined} v
   */
  fint(v) {
    if (v === null || v === undefined) return this.u8(0);
    return this.u8(1).i32(v);
  }

  /**
   * fstring: flag, then a cstr when present.
   * @param {Text|null|undefined} v
   */
  fstring(v) {
    if (v === null || v === undefined) return this.u8(0);
    return this.u8(1).cstr(v);
  }

  /**
   * position: latitude, then longitude, both semicircles.
   * @param {number} lat
   * @param {number} lon
   */
  position(lat, lon) {
    return this.i32(lat).i32(lon);
  }

  /**
   * uuid: a 36-character ASCII cstr. The shape is not checked here, so a negative fixture can write a bad one.
   * @param {string} uuid
   */
  uuid(uuid) {
    return this.cstr(uuid, 'latin1');
  }

  /**
   * links / categories: u32 n, then n cstrs.
   * @param {Text[]} list
   * @param {number} [countOverride]
   */
  cstrList(list, countOverride) {
    this.u32(countOverride ?? list.length);
    for (const t of list) this.cstr(t);
    return this;
  }

  toBytes() {
    return this.buf.slice(0, this.length);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Seeded PRNG and UUIDs (FORMAT.md §12: "UUIDs come from a seeded PRNG")

/**
 * mulberry32: small, fast, and good enough for fixture variety. Returns u32 values.
 * @param {number} seed
 * @returns {() => number}
 */
export function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/**
 * @param {() => number} next
 * @returns {string} 8-4-4-4-12 lowercase hex
 */
export function makeUuid(next) {
  let hex = '';
  while (hex.length < 32) hex += next().toString(16).padStart(8, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Deterministic junk bytes.
 * @param {number} n
 * @param {number} seed
 */
export function junkBytes(n, seed) {
  const next = prng(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = next() & 0xff;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Header and framing (FORMAT.md §3)

/**
 * @typedef {object} HeaderSpec
 * @property {string|Uint8Array} [signature]  4 bytes; default per file kind
 * @property {number} [primary]          primary format, default 0x0066
 * @property {number} [version]          'D' file-format version, default 188
 * @property {number} [programVersion]   'A' program version, default 407
 * @property {string} [builder]          default "bcr-fixture"
 * @property {string} [date]             default "Jan 01 2026"
 * @property {string} [time]             default "00:00:00"
 * @property {string} [application]      bare cstr after the 'A' record, default "BaseCamp"
 * @property {number} [dLength]          corrupt hook: the 'D' record length (must be 2)
 * @property {string} [dType]            corrupt hook: the 'D' record type byte
 * @property {number} [aExtra]           corrupt hook: extra zero bytes inside the 'A' body after the three cstrs
 */

/**
 * The common header of GDB, GFI and TrackSegments files (FORMAT.md §3.1).
 * @param {'gdb'|'gfi'|'trackSegments'} kind
 * @param {HeaderSpec} [spec]
 * @returns {Uint8Array}
 */
export function headerBytes(kind, spec = {}) {
  const s = new ByteSink();
  const sig = spec.signature ?? SIGNATURE[kind];
  const sigBytes = typeof sig === 'string' ? encodeText(sig, 'latin1') : sig;
  if (sigBytes.length !== 4) throw new RangeError('a signature is 4 bytes');
  s.bytes(sigBytes);
  s.u16(spec.primary ?? 0x0066);
  s.u32(spec.dLength ?? 2).u8((spec.dType ?? 'D').charCodeAt(0)).u16(spec.version ?? 188);
  const a = new ByteSink();
  a.u16(spec.programVersion ?? 407);
  a.cstr(spec.builder ?? 'bcr-fixture', 'latin1');
  a.cstr(spec.date ?? 'Jan 01 2026', 'latin1');
  a.cstr(spec.time ?? '00:00:00', 'latin1');
  a.zeros(spec.aExtra ?? 0);
  s.u32(a.length).u8(0x41).bytes(a.toBytes());
  s.cstr(spec.application ?? 'BaseCamp', 'latin1');
  return s.toBytes();
}

/**
 * One framed record: u32 body length, u8 type, body (FORMAT.md §3.2).
 * @param {string} type  one ASCII letter
 * @param {Uint8Array} body
 * @param {number} [lenOverride]  corrupt hook: the length field written instead of body.length
 */
export function frameRecord(type, body, lenOverride) {
  if (typeof type !== 'string' || type.length !== 1 || type.charCodeAt(0) > 0x7f) {
    throw new RangeError(`a record type is one ASCII character, got ${JSON.stringify(type)}`);
  }
  return new ByteSink().u32(lenOverride ?? body.length).u8(type.charCodeAt(0)).bytes(body).toBytes();
}

/** 'V' map-set record as GPSBabel writes it: empty name, auto-named (FORMAT.md §3.2). */
export const V_BODY = Uint8Array.of(0x00, 0x01);
/** 'E' record: u32 Unknown1 = 0. */
export const E_BODY = Uint8Array.of(0, 0, 0, 0);
/** 'E' as Mac BaseCamp 4.8 writes it: 8 zero bytes (FORMAT.md §15.6). */
export const E_BODY_MAC48 = new Uint8Array(8);
/**
 * The F record tail Mac BaseCamp 4.8 writes after the children (FORMAT.md §15.8): u8 1, u32 0, an i32 Unix time (a
 * made-up 2026-01-01T00:00:00Z here), u8 0.
 */
export const FOLDER_TAIL_MAC48 = Object.freeze([1, 0, 0, 0, 0, 0x80, 0xb8, 0x55, 0x69, 0]);
/** The I record tail of a smart list (created-by 3) on Mac 4.8 (FORMAT.md §15.8): u8 1, u32 0. */
export const SMART_LIST_TAIL = Object.freeze([1, 0, 0, 0, 0]);
/** 'X' record: cstr "EndOfFile". */
export const X_BODY = Uint8Array.of(...encodeText('EndOfFile', 'latin1'), 0);

// ---------------------------------------------------------------------------------------------------------------------
// Item descriptions

/**
 * @typedef {object} Address
 * @property {Text} [street]
 * @property {Text} [city]
 * @property {Text} [state]
 * @property {Text} [country]
 * @property {Text} [postal]
 */

/**
 * Byte-level choices for a 'W' record. Every field is optional.
 * @typedef {object} WaypointGdb
 * @property {'kbm'|'op'|'mac48'} [layout]   H-KBM (supported path, default), H-OP (documented hypothesis, §5) or
 *   H-MAC48 (supported path, §15.11: the H-KBM tail plus 8 opaque bytes)
 * @property {number} [class]        u32 waypoint class, default 0
 * @property {number} [icon]         u32 symbol number, default 0
 * @property {number} [display]      u32 display mode, default 1
 * @property {number|null} [proximity]
 * @property {Address} [address]     H-KBM K8-K12
 * @property {ArrayLike<number>|null} [subclass]  H-KBM K13: 24 opaque bytes (b = 1); absent gives the b = 0 branch
 * @property {number} [subclassStop] the second byte of K13's b = 0 branch, default 0
 * @property {number|null} [depth]   H-KBM K15
 * @property {Text[]} [links]        H-KBM K16 / H-OP O14
 * @property {number|null} [temperature]  H-KBM K17 / H-OP O15
 * @property {'B'|'A'} [timeIn]      H-KBM: which field carries the model time: 'B' = K22 (default), 'A' = K18
 * @property {number|null} [otherTime]  H-KBM: ms written to the *other* time field (K18 when timeIn is 'B')
 * @property {ArrayLike<number>} [opaque19]  H-KBM K19, 6 bytes, default zeros
 * @property {Text[]} [phones]       H-KBM K20/K21 (one phone is the supported shape)
 * @property {number} [phoneCount]   corrupt hook: K20 written instead of phones.length
 * @property {number} [phoneByte]    the opaque byte after each phone, default 0
 * @property {ArrayLike<number>} [opaque23]  H-KBM K23, 3 bytes, default zeros
 * @property {Text[]} [categories]   H-KBM K24
 * @property {ArrayLike<number>} [opaque48]  H-MAC48: the 8 bytes after K24, default zeros (never checked)
 * @property {number} [colour]       H-OP O8
 * @property {{origin: Text, uuid: string}|null} [thumbnail]  H-OP O18
 * @property {'altitude'|'proximity'} [badFlag]  corrupt hook: that fdouble's presence flag is written as 2
 * @property {number} [linksCount]   corrupt hook: the links count written instead of links.length
 * @property {-1|1} [lengthDelta]    corrupt hook: drop the last body byte (-1) or add one zero byte (+1)
 * @property {boolean} [afterV]      place the record after the 'V' record (an order violation)
 */

/**
 * A waypoint: the src/model.js Waypoint shape plus byte-level choices. `symbol` is ignored (the icon number is used).
 * @typedef {object} WaypointSpec
 * @property {'waypoint'} kind
 * @property {string} id
 * @property {string} name
 * @property {Encoding} [nameEncoding]   encoding of the name in AllData.gdb (default utf8)
 * @property {Text} [gfiName]            the name the FolderData.gfi reference carries (default: the same bytes)
 * @property {string} [comment]
 * @property {number} lat
 * @property {number} lon
 * @property {number|null} [ele]
 * @property {number|null} [time]
 * @property {WaypointGdb} [gdb]
 */

/**
 * @typedef {object} TrackSegmentsSpec
 * @property {boolean} [omit]            no TrackSegments file for this track
 * @property {17|11} [n]                 per-point size, default 17 (the 17-slot point of FORMAT.md §15.11)
 * @property {string|Uint8Array} [signature]
 * @property {number} [programVersion]
 * @property {'all'|'overlap'|number} [count]  which points are written: every stored point (default), the sequence
 *   with each later segment's first point removed, or the first `count` points
 * @property {{point: number, byte: number}} [extraByte]  corrupt hook: one of the N − 2 extra bytes set to 1. With
 *   N = 17, byte k is the presence byte of slot k + 3, so it must name a slot of unknown width (not 6 or 7, §15.11)
 * @property {number} [trailing]         corrupt hook: zero bytes after the last point
 * @property {number} [countOverride]    corrupt hook: the point count M written instead of the real one
 */

/**
 * @typedef {object} TrackGdb
 * @property {'kbm'|'op'|'mac48'} [layout]  H-MAC48: H-KBM through the uuid, then the Mac 4.8 tail (§15.11)
 * @property {number} [display]          default 1
 * @property {ArrayLike<number>} [gap1]  H-KBM only, 4 bytes, default zeros
 * @property {ArrayLike<number>} [gap2]  H-KBM only, 4 bytes, default zeros
 * @property {number} [colorIndex]       u32 colour, default 0
 * @property {Text[]} [links]
 * @property {Text} [notes]
 * @property {number} [area]
 * @property {number|null} [unknown2]
 * @property {number} [unknown3]
 * @property {number|null} [duration]    default: last time − first time when both exist
 * @property {number} [length]           default 0
 * @property {number|null} [startTime]   ms; default: the first point's time
 * @property {number} [segUnknown1]      default 0
 * @property {string} [uuid]             default from the library's PRNG
 * @property {'sum'|'overlap'|number} [totalCount]  field 16, default Σn
 * @property {{track?: number, segment?: number}} [boundsPad]  semicircles added around the tight bounds
 * @property {boolean} [pointOutsideSegment]  corrupt hook: the last point of the first non-empty segment lies outside
 * @property {boolean} [segmentOutsideTrack]  corrupt hook: the first non-empty segment's bounds poke out of the track's
 * @property {boolean} [minAboveMax]     corrupt hook: segment min and max latitude swapped (n ≥ 2, distinct lats)
 * @property {number} [segmentCount]     corrupt hook: S written instead of the real count
 * @property {ArrayLike<number>} [tail3]  H-MAC48: the 3 bytes after the uuid, default zeros (never checked)
 * @property {ArrayLike<number>} [tailFlags]  H-MAC48: the 11 flag bytes; default [elevation, time, sensor, sensor,
 *   0 × 7] from the track's points (the reader does not use them)
 * @property {number|null} [tailA]       H-MAC48: fdouble A; default present (0.5) when any point has an elevation
 * @property {number|null} [tailB]       H-MAC48: fdouble B; default present (0) when any point has an elevation
 * @property {ArrayLike<number>} [tail8]  H-MAC48: the last 8 bytes, default zeros (never checked)
 * @property {number} [badTailFlag]      corrupt hook (H-MAC48): flag byte 1 written as this value (> 1)
 */

/**
 * A track: the src/model.js Track shape plus byte-level choices. `color` and `comment` are ignored (colorIndex and
 * notes are used).
 * @typedef {object} TrackSpec
 * @property {'track'} kind
 * @property {string} id
 * @property {string} name
 * @property {Encoding} [nameEncoding]
 * @property {Text} [gfiName]
 * @property {Point[][]} segments
 * @property {TrackGdb} [gdb]
 * @property {TrackSegmentsSpec} [ts]
 */

/**
 * @typedef {object} RoutePointGdb
 * @property {boolean} [byName]          L = 0: the via point resolves by waypoint name and class. H-MAC48: the last
 *   via point is always by name (FORMAT.md §15.5), the others only when this is set
 * @property {number} [class]            default 0 (H-OP) or 8 (H-MAC48)
 * @property {Array<[number, number]>} [shaping]  extra link points (degrees) after the via point's own
 * @property {{count: number, junk: number}} [autoroute]  A > 0, followed by `junk` opaque bytes
 * @property {boolean} [badUnknown7]     corrupt hook: Unknown7 is not eight 0xFF bytes
 * @property {number} [nonZeroRun]       corrupt hook (H-MAC48): this index (6-18) of the 19-byte run is written as 1.
 *   Indexes 0-5 are where H-OP reads its own fields, so they are refused (the hook is a MAC48 negative only)
 */

/**
 * @typedef {object} RouteSpec
 * @property {'route'} kind
 * @property {string} id
 * @property {string} name
 * @property {Encoding} [nameEncoding]
 * @property {Text} [gfiName]
 * @property {Array<{name: string, lat: number, lon: number}>} points  the via points (src/model.js RoutePoint)
 * @property {{autoName?: number, via?: RoutePointGdb[], noBounds?: boolean, layout?: 'op'|'mac48', colour?: number,
 *   autorouteSettings?: boolean}} [gdb]  `layout` default 'op'. H-MAC48 only: `colour` (default 14) and the corrupt
 *   hook `autorouteSettings` (the trailer's autoroute-settings flag written as 1)
 */

/** @typedef {WaypointSpec|TrackSpec|RouteSpec} ItemSpec */

/**
 * A folder or list: the src/model.js Folder shape plus GFI choices.
 * @typedef {object} FolderSpec
 * @property {string} id
 * @property {Text} name
 * @property {'folder'|'list'} type
 * @property {string|null} parentId      null = directly under the root
 * @property {string[]} [itemIds]        lists only
 * @property {number} [createdBy]        lists: 0 user (no tail), 1 import, 3 a smart list (Mac 4.8, 5-byte tail),
 *   8 "Unlisted Data"
 * @property {ArrayLike<number>} [tail]  override the record tail (F: default [1]; I: default by createdBy)
 * @property {number} [gfiId]            override the numeric ID
 */

/**
 * @typedef {object} ExtraRef
 * @property {'T'|'W'|'R'|'K'|'J'} type
 * @property {string} list               a list id from `folders`
 * @property {Text} name
 * @property {number} [class]            'W' only, default 0
 */

/**
 * @typedef {object} ExtraRecord
 * @property {'start'|'beforeV'|'afterV'} at
 * @property {string} type
 * @property {ArrayLike<number>} body
 */

/**
 * @typedef {object} LibrarySpec
 * @property {number} [seed]             PRNG seed for UUIDs, default 1
 * @property {string} [databaseVersion]  the Database/<version> folder name, default "4.8"
 * @property {HeaderSpec} [header]       shared by all three file kinds
 * @property {{header?: HeaderSpec, end?: 'VEX'|'VE'|'VEX+junk', junkAfterEnd?: number, extra?: ExtraRecord[],
 *   truncate?: {item: string, keep: number}, absurdLength?: {item: string, len?: number},
 *   replace?: Uint8Array, eLength?: 4|8}} [gdb]  `eLength` 8: the Mac 4.8 'E' record
 * @property {null|{header?: HeaderSpec, rootName?: Text, rootId?: number, rootParent?: number,
 *   children?: Record<string, Array<['folder'|'list', string|number]>>, listParents?: Record<string, string|null>,
 *   extraRefs?: ExtraRef[], duplicateFolder?: string, folderTail?: 'op'|'mac48'}} [gfi]  null: no FolderData.gfi.
 *   `folderTail` 'mac48': every F record (the root too) ends in FOLDER_TAIL_MAC48 unless a folder sets its own
 * @property {{header?: HeaderSpec}} [trackSegments]
 * @property {ItemSpec[]} items
 * @property {FolderSpec[]} [folders]
 */

/**
 * @typedef {object} RecordInfo
 * @property {string} type
 * @property {number} offset      where the 5-byte frame starts
 * @property {number} bodyStart
 * @property {number} len         the body length actually present (not an overridden length field)
 * @property {number} lenField    the value written in the length field
 * @property {string|null} item   the item id, for W/T/R records
 * @property {'kbm'|'op'|'mac48'|'none'|null} intended  the layout hypothesis meant to validate (W and T)
 */

/**
 * @typedef {object} FileManifest
 * @property {'gdb'|'gfi'|'trackSegments'} role
 * @property {number} headerEnd
 * @property {number} length
 * @property {RecordInfo[]} records   GDB and GFI only
 * @property {string|null} [track]    TrackSegments: the track id
 * @property {number[]} [intendedN]   TrackSegments: the per-point sizes meant to validate ([] = none)
 * @property {number} [pointCount]    TrackSegments: points written
 * @property {Array<{ele: number|null, time: number|null}>} [points]  TrackSegments: values written, in order
 * @property {boolean} [sensors]         TrackSegments: some point holds a temperature or a heart rate (slots 6, 7)
 */

// ---------------------------------------------------------------------------------------------------------------------
// Record bodies

/**
 * @param {{name: string, nameEncoding?: Encoding}} item
 * @returns {Uint8Array}
 */
export function gdbNameBytes(item) {
  return encodeText(item.name, item.nameEncoding ?? 'utf8');
}

/**
 * @param {ItemSpec} item
 * @returns {Uint8Array}
 */
export function gfiNameBytes(item) {
  return item.gfiName !== undefined ? encodeText(item.gfiName) : gdbNameBytes(item);
}

/**
 * @param {number|null|undefined} ms
 * @returns {number|null}
 */
const sec = (ms) => (ms === null || ms === undefined ? null : msToSeconds(ms));

/**
 * 'W' record body (FORMAT.md §5, §15.11): agreed prefix, then the H-KBM, H-OP or H-MAC48 tail.
 * @param {WaypointSpec} wp
 * @returns {{body: Uint8Array, intended: 'kbm'|'op'|'mac48'|'none'}}
 */
export function waypointBody(wp) {
  const g = wp.gdb ?? {};
  const layout = g.layout ?? 'kbm';
  const s = new ByteSink();
  s.bytes(gdbNameBytes(wp)).u8(0);
  s.u32(g.class ?? 0);
  s.position(latToSemicircles(wp.lat), lonToSemicircles(wp.lon));
  s.cstr(wp.comment ?? '');
  s.fdouble(g.proximity ?? null, g.badFlag === 'proximity' ? 2 : 1);
  s.u32(g.display ?? 1);
  s.u32(g.icon ?? 0);
  const altFlag = g.badFlag === 'altitude' ? 2 : 1;
  const ele = wp.ele ?? null;
  if (g.badFlag === 'altitude' && ele === null) throw new RangeError('badFlag altitude needs an altitude value');
  if (layout === 'kbm' || layout === 'mac48') {
    const a = g.address ?? {};
    for (const part of [a.street, a.city, a.state, a.country, a.postal]) s.cstr(part ?? '');
    if (g.subclass) {
      if (g.subclass.length !== 24) throw new RangeError('subclass is 24 opaque bytes');
      s.u8(1).bytes(g.subclass);
    } else {
      s.u8(0).u8(g.subclassStop ?? 0);
    }
    s.fdouble(ele, altFlag);
    s.fdouble(g.depth ?? null);
    s.cstrList(g.links ?? [], g.linksCount);
    s.fdouble(g.temperature ?? null);
    const inA = g.timeIn === 'A';
    const timeA = inA ? sec(wp.time) : sec(g.otherTime);
    const timeB = inA ? sec(g.otherTime) : sec(wp.time);
    s.fint(timeA);
    s.bytes(fixedBytes(g.opaque19, 6, 'opaque19'));
    const phones = g.phones ?? [];
    s.u32(g.phoneCount ?? phones.length);
    for (const p of phones) s.cstr(p).u8(g.phoneByte ?? 0);
    s.fint(timeB);
    s.bytes(fixedBytes(g.opaque23, 3, 'opaque23'));
    s.cstrList(g.categories ?? []);
    if (layout === 'mac48') s.bytes(fixedBytes(g.opaque48, 8, 'opaque48'));
    else if (g.opaque48 !== undefined) throw new RangeError('opaque48 is H-MAC48 only');
  } else if (layout === 'op') {
    s.u32(g.colour ?? 0);
    s.u8(0).u8(0).u8(0); // O9 Unknown1, O10 Subclass1 present, O11 Subclass2 present
    s.fdouble(ele, altFlag);
    s.u8(0); // O13 Unknown2
    s.cstrList(g.links ?? [], g.linksCount);
    s.fdouble(g.temperature ?? null);
    s.fint(sec(wp.time));
    s.u8(0); // O17 Unknown3
    if (g.thumbnail) {
      s.u8(1).cstr(g.thumbnail.origin).uuid(g.thumbnail.uuid).zeros(8);
    } else {
      s.u8(0);
    }
  } else {
    throw new RangeError(`unknown waypoint layout ${String(layout)}`);
  }
  let body = s.toBytes();
  if (g.lengthDelta === -1) body = body.slice(0, body.length - 1);
  else if (g.lengthDelta === 1) body = Uint8Array.of(...body, 0);
  const phonesBad = g.phoneCount !== undefined && g.phoneCount !== (g.phones ?? []).length;
  const corrupt = g.badFlag !== undefined || g.linksCount !== undefined || g.lengthDelta !== undefined || phonesBad ||
    ((layout === 'kbm' || layout === 'mac48') && (g.phones ?? []).length > 1);
  return { body, intended: corrupt ? 'none' : layout };
}

/**
 * @param {ArrayLike<number>|undefined} bytes
 * @param {number} n
 * @param {string} what
 */
function fixedBytes(bytes, n, what) {
  if (bytes === undefined) return new Uint8Array(n);
  if (bytes.length !== n) throw new RangeError(`${what} is ${n} bytes`);
  return Uint8Array.from(bytes);
}

/**
 * Tight bounds of a list of [lat, lon] semicircle pairs: { maxLat, maxLon, minLat, minLon }.
 * @param {Array<[number, number]>} pts
 */
function boundsOf(pts) {
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let minLon = Infinity;
  for (const [la, lo] of pts) {
    if (la > maxLat) maxLat = la;
    if (la < minLat) minLat = la;
    if (lo > maxLon) maxLon = lo;
    if (lo < minLon) minLon = lo;
  }
  return { maxLat, maxLon, minLat, minLon };
}

/**
 * @param {{maxLat: number, maxLon: number, minLat: number, minLon: number}} b
 * @param {number} pad
 */
function padBounds(b, pad) {
  return {
    maxLat: Math.min(b.maxLat + pad, 2 ** 30),
    minLat: Math.max(b.minLat - pad, -(2 ** 30)),
    maxLon: Math.min(b.maxLon + pad, TWO31 - 1),
    minLon: Math.max(b.minLon - pad, -TWO31),
  };
}

/**
 * The stored points of a track as semicircles, per segment.
 * @param {TrackSpec} trk
 * @returns {Array<Array<[number, number]>>}
 */
export function trackSemicircles(trk) {
  return trk.segments.map((seg) => seg.map((p) => [latToSemicircles(p.lat), lonToSemicircles(p.lon)]));
}

/**
 * The points a TrackSegments file holds for this track, in order, before any corrupt hook.
 * @param {TrackSpec} trk
 * @returns {Point[]}
 */
export function trackSegmentsPoints(trk) {
  const count = trk.ts?.count ?? 'all';
  const all = trk.segments.flat();
  if (count === 'all') return all;
  if (count === 'overlap') {
    /** @type {Point[]} */
    const out = [];
    let first = true;
    for (const seg of trk.segments) {
      if (seg.length === 0) continue;
      out.push(...(first ? seg : seg.slice(1)));
      first = false;
    }
    return out;
  }
  assertInt(count, 0, all.length, 'ts.count');
  return all.slice(0, count);
}

/**
 * 'T' record body (FORMAT.md §6, §15.11): H-KBM has the two 4-byte gaps, H-OP does not; H-MAC48 is H-KBM plus the
 * Mac 4.8 tail after the uuid.
 * @param {TrackSpec} trk
 * @param {string} uuid
 * @returns {{body: Uint8Array, intended: 'kbm'|'op'|'mac48'|'none'}}
 */
export function trackBody(trk, uuid) {
  const g = trk.gdb ?? {};
  const layout = g.layout ?? 'kbm';
  if (layout !== 'kbm' && layout !== 'op' && layout !== 'mac48') throw new RangeError(`unknown track layout ${String(layout)}`);
  const gaps = layout !== 'op';
  const segs = trackSemicircles(trk);
  const segPad = g.boundsPad?.segment ?? 0;
  const trackPad = g.boundsPad?.track ?? 0;

  /** @type {Array<{maxLat: number, maxLon: number, minLat: number, minLon: number}>} */
  const segBounds = segs.map((pts) => (pts.length ? padBounds(boundsOf(pts), segPad) : { maxLat: 0, maxLon: 0, minLat: 0, minLon: 0 }));
  const nonEmpty = segs.map((pts, i) => (pts.length ? i : -1)).filter((i) => i >= 0);
  let trackB = nonEmpty.length
    ? padBounds(boundsOf(nonEmpty.flatMap((i) => [[segBounds[i].maxLat, segBounds[i].maxLon], [segBounds[i].minLat, segBounds[i].minLon]])), trackPad)
    : { maxLat: 0, maxLon: 0, minLat: 0, minLon: 0 };

  let corrupt = false;
  const firstSeg = nonEmpty[0];
  if (g.pointOutsideSegment) {
    if (firstSeg === undefined || segs[firstSeg].length < 2) throw new RangeError('pointOutsideSegment needs a segment with 2+ points');
    const pts = segs[firstSeg];
    const others = boundsOf(pts.slice(0, -1));
    const last = pts[pts.length - 1];
    if (last[0] <= others.maxLat && last[0] >= others.minLat && last[1] <= others.maxLon && last[1] >= others.minLon) {
      throw new RangeError('pointOutsideSegment: the last point must lie outside the other points\' bounds');
    }
    segBounds[firstSeg] = others; // the last point now falls outside its segment's bounds
    corrupt = true;
  }
  if (g.segmentOutsideTrack) {
    if (firstSeg === undefined) throw new RangeError('segmentOutsideTrack needs a non-empty segment');
    // Track bounds tight around the points; the segment's bounds stick out by 1000 semicircles.
    trackB = boundsOf(segs.flat());
    segBounds[firstSeg] = padBounds(boundsOf(segs[firstSeg]), 1000);
    corrupt = true;
  }
  if (g.minAboveMax) {
    if (firstSeg === undefined) throw new RangeError('minAboveMax needs a non-empty segment');
    const b = segBounds[firstSeg];
    if (b.maxLat === b.minLat) throw new RangeError('minAboveMax needs distinct latitudes');
    segBounds[firstSeg] = { ...b, maxLat: b.minLat, minLat: b.maxLat };
    corrupt = true;
  }
  if (g.segmentCount !== undefined) corrupt = true;
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(uuid)) corrupt = true;

  const times = trk.segments.flat().map((p) => p.time).filter((t) => t !== null && t !== undefined);
  const startTime = g.startTime !== undefined ? g.startTime : (times[0] ?? null);
  const duration = g.duration !== undefined ? g.duration : times.length >= 2 ? (times[times.length - 1] - times[0]) / 1000 : null;
  const sumN = segs.reduce((a, pts) => a + pts.length, 0);
  const total = g.totalCount === undefined || g.totalCount === 'sum' ? sumN
    : g.totalCount === 'overlap' ? sumN - Math.max(0, segs.length - 1)
    : g.totalCount;

  const s = new ByteSink();
  s.bytes(gdbNameBytes(trk)).u8(0);
  s.u8(g.display ?? 1);
  if (gaps) s.bytes(fixedBytes(g.gap1, 4, 'gap1'));
  s.u32(g.colorIndex ?? 0);
  s.cstrList(g.links ?? []);
  s.cstr(g.notes ?? '');
  s.f64(g.area ?? 0);
  s.fdouble(g.unknown2 ?? null);
  s.u8(g.unknown3 ?? 0);
  s.position(trackB.maxLat, trackB.maxLon);
  s.position(trackB.minLat, trackB.minLon);
  s.fdouble(duration);
  s.f64(g.length ?? 0);
  s.fint(sec(startTime));
  if (gaps) s.bytes(fixedBytes(g.gap2, 4, 'gap2'));
  s.u32(g.segmentCount ?? segs.length);
  segs.forEach((pts, i) => {
    s.u8(g.segUnknown1 ?? 0);
    s.position(segBounds[i].maxLat, segBounds[i].maxLon);
    s.position(segBounds[i].minLat, segBounds[i].minLon);
    s.u32(pts.length);
    for (const [la, lo] of pts) s.position(la, lo);
  });
  s.u32(total);
  s.uuid(uuid);
  if (layout === 'mac48') {
    // The Mac 4.8 tail (§15.4 rows 19-23, §15.11): 3 bytes, 11 flag bytes, fdouble A, fdouble B, 8 bytes.
    const points = trk.segments.flat();
    const has = (/** @type {(p: Point) => unknown} */ f) => (points.some((p) => f(p) !== null && f(p) !== undefined) ? 1 : 0);
    const withEle = has((p) => p.ele);
    const sensor = has((p) => p.atemp) || has((p) => p.hr) ? 1 : 0;
    const flags = g.tailFlags ? Array.from(g.tailFlags) : [withEle, has((p) => p.time), sensor, sensor, 0, 0, 0, 0, 0, 0, 0];
    if (flags.length !== 11 || flags.some((f) => f !== 0 && f !== 1)) throw new RangeError('tailFlags are 11 bytes of 0 or 1');
    if (g.badTailFlag !== undefined) {
      assertInt(g.badTailFlag, 2, 255, 'badTailFlag');
      flags[0] = g.badTailFlag;
      corrupt = true;
    }
    s.bytes(fixedBytes(g.tail3, 3, 'tail3'));
    for (const f of flags) s.u8(f);
    s.fdouble(g.tailA !== undefined ? g.tailA : withEle ? 0.5 : null);
    s.fdouble(g.tailB !== undefined ? g.tailB : withEle ? 0 : null);
    s.bytes(fixedBytes(g.tail8, 8, 'tail8'));
  } else {
    for (const k of ['tail3', 'tailFlags', 'tailA', 'tailB', 'tail8', 'badTailFlag']) {
      if (/** @type {any} */ (g)[k] !== undefined) throw new RangeError(`${k} is H-MAC48 only`);
    }
  }
  return { body: s.toBytes(), intended: corrupt ? 'none' : layout };
}

/**
 * 'R' record body (FORMAT.md §7, OP's ≥ 1.46 layout, applied to 1.88 as a GUESS), trailer as §12 lists it.
 * @param {RouteSpec} rte
 * @param {() => number} next  PRNG for the opaque autoroute bytes
 * @returns {{body: Uint8Array}}
 */
export function routeBody(rte, next) {
  const g = rte.gdb ?? {};
  if ((g.layout ?? 'op') === 'mac48') return routeBodyMac48(rte);
  if (g.layout !== undefined && g.layout !== 'op') throw new RangeError(`unknown route layout ${String(g.layout)}`);
  if (g.colour !== undefined || g.autorouteSettings !== undefined) throw new RangeError('colour and autorouteSettings are H-MAC48 only');
  const via = g.via ?? [];
  const s = new ByteSink();
  s.bytes(gdbNameBytes(rte)).u8(0);
  s.u8(g.autoName ?? 0);
  s.u32(rte.points.length);
  /** @type {Array<[number, number]>} */
  const all = [];
  rte.points.forEach((p, i) => {
    const v = via[i] ?? {};
    /** @type {Array<[number, number]>} */
    const links = v.byName ? [] : [[latToSemicircles(p.lat), lonToSemicircles(p.lon)]];
    for (const [la, lo] of v.shaping ?? []) links.push([latToSemicircles(la), lonToSemicircles(lo)]);
    if (v.byName && links.length) throw new RangeError('a by-name via point has no link points');
    all.push(...links);
    s.cstr(p.name);
    s.u32(v.class ?? 0);
    s.fstring(null); // Unknown1
    s.u32(0).u32(0).u32(0).u16(0); // Unknown2-Unknown5
    s.u32(v.autoroute ? 1 : 0); // Unknown6: 1 means "autoroute point follows"
    s.u32(links.length);
    for (const [la, lo] of links) s.position(la, lo);
    if (links.length) {
      const b = boundsOf(links);
      s.flag(0).position(b.maxLat, b.maxLon).position(b.minLat, b.minLon);
    } else {
      s.flag(1);
    }
    s.bytes(v.badUnknown7 ? [0xff, 0xff, 0xff, 0xff, 0x00, 0xff, 0xff, 0xff] : [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    s.fint(null); // Unknown11
    s.fint(null); // end time absent, so no duration byte at all
    if (v.autoroute) {
      s.u32(v.autoroute.count);
      for (let k = 0; k < v.autoroute.junk; k++) s.u8(next() & 0xff);
    } else {
      s.u32(0);
    }
  });
  s.u8(0).u8(0).u8(0); // Unknown1
  if (g.noBounds || all.length === 0) {
    s.flag(1);
  } else {
    const b = boundsOf(all);
    s.flag(0).position(b.maxLat, b.maxLon).position(b.minLat, b.minLon);
  }
  // Trailer (§7.3 / §12): links 0, colour 0, autoroute 0, notes "", filtered 0, filtered count 0, Unknown10 1,
  // Unknown11 0, activity profile 0.
  s.u32(0).u32(0).flag(0).cstr('').flag(0).u32(0).flag(1).u8(0).u32(0);
  return { body: s.toBytes() };
}

/**
 * 'R' record body in the Mac 4.8 layout (FORMAT.md §15.5, §15.11). Every via point but the last carries two link
 * points, [this via point, next via point], and its leg's bounding box; the last carries none (L = 0) and resolves
 * through a waypoint record of the same name and class (class 8 by default). After each point's eight 0xFF bytes come
 * 19 zero bytes. Trailer: route bounds, links 0, colour, autoroute settings 0, notes "", filtered 0, filtered count 0,
 * Unknown10 1, Unknown11 0, activity profile 6, then 01 and nine 0.
 * @param {RouteSpec} rte
 * @returns {{body: Uint8Array}}
 */
function routeBodyMac48(rte) {
  const g = rte.gdb ?? {};
  const via = g.via ?? [];
  const s = new ByteSink();
  s.bytes(gdbNameBytes(rte)).u8(0);
  s.u8(g.autoName ?? 0);
  s.u32(rte.points.length);
  /** @type {Array<[number, number]>} */
  const all = [];
  rte.points.forEach((p, i) => {
    const v = via[i] ?? {};
    if (v.shaping || v.autoroute || v.badUnknown7) throw new RangeError('shaping, autoroute and badUnknown7 are H-OP hooks');
    const last = i === rte.points.length - 1;
    /** @type {Array<[number, number]>} */
    const links = [];
    if (!last && !v.byName) {
      const q = rte.points[i + 1];
      links.push([latToSemicircles(p.lat), lonToSemicircles(p.lon)], [latToSemicircles(q.lat), lonToSemicircles(q.lon)]);
    }
    all.push(...links);
    s.cstr(p.name);
    s.u32(v.class ?? 8);
    s.fstring(null); // Unknown1
    s.u32(3).u32(U32_MAX).u32(0).u16(0).u32(0); // Unknown2-Unknown6 as Mac 4.8 writes them
    s.u32(links.length);
    for (const [la, lo] of links) s.position(la, lo);
    if (links.length) {
      const b = boundsOf(links);
      s.flag(0).position(b.maxLat, b.maxLon).position(b.minLat, b.minLon);
    } else {
      s.flag(1);
    }
    s.bytes([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    const run = new Uint8Array(19);
    if (v.nonZeroRun !== undefined) {
      assertInt(v.nonZeroRun, 6, 18, 'nonZeroRun');
      run[v.nonZeroRun] = 1;
    }
    s.bytes(run);
  });
  if (g.noBounds || all.length === 0) {
    s.flag(1);
  } else {
    const b = boundsOf(all);
    s.flag(0).position(b.maxLat, b.maxLon).position(b.minLat, b.minLon);
  }
  s.u32(0).u32(g.colour ?? 14).flag(g.autorouteSettings ? 1 : 0).cstr('').flag(0).u32(0).flag(1).u8(0).u32(6);
  s.bytes([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  return { body: s.toBytes() };
}

// ---------------------------------------------------------------------------------------------------------------------
// Library assembly

/**
 * Checks a description and indexes it. Throws on description bugs.
 * @param {LibrarySpec} lib
 */
export function indexSpec(lib) {
  /** @type {Map<string, ItemSpec>} */
  const items = new Map();
  for (const it of lib.items) {
    if (!it || typeof it.id !== 'string') throw new TypeError('every item needs a string id');
    if (items.has(it.id)) throw new RangeError(`duplicate item id ${it.id}`);
    if (it.kind !== 'waypoint' && it.kind !== 'track' && it.kind !== 'route') throw new RangeError(`bad kind on ${it.id}`);
    items.set(it.id, it);
  }
  /** @type {Map<string, FolderSpec>} */
  const folders = new Map();
  for (const f of lib.folders ?? []) {
    if (folders.has(f.id)) throw new RangeError(`duplicate folder id ${f.id}`);
    if (f.type !== 'folder' && f.type !== 'list') throw new RangeError(`bad folder type on ${f.id}`);
    if (f.type === 'folder' && f.itemIds && f.itemIds.length) throw new RangeError(`folder ${f.id} cannot hold items`);
    folders.set(f.id, f);
  }
  for (const f of folders.values()) {
    if (f.parentId !== null && folders.get(f.parentId)?.type !== 'folder') {
      throw new RangeError(`parent of ${f.id} must be a folder`);
    }
    for (const id of f.itemIds ?? []) if (!items.has(id)) throw new RangeError(`list ${f.id} names unknown item ${id}`);
  }
  // Numeric GFI IDs: folders and lists are separate ID spaces, both counting from 0 (FORMAT.md §8.4, GUESS).
  /** @type {Map<string, number>} */
  const gfiId = new Map();
  let nextFolder = 0;
  let nextList = 0;
  for (const f of folders.values()) {
    const auto = f.type === 'folder' ? nextFolder++ : nextList++;
    gfiId.set(f.id, f.gfiId ?? auto);
  }
  return { items, folders, gfiId };
}

/**
 * Builds AllData.gdb.
 * @param {LibrarySpec} lib
 * @param {ReturnType<typeof indexSpec>} idx
 * @param {Map<string, string>} uuids  track id → uuid
 * @param {() => number} next
 * @returns {{bytes: Uint8Array, manifest: FileManifest}}
 */
function buildGdb(lib, idx, uuids, next) {
  const g = lib.gdb ?? {};
  if (g.replace) {
    return { bytes: g.replace.slice(), manifest: { role: 'gdb', headerEnd: 0, length: g.replace.length, records: [] } };
  }
  const header = headerBytes('gdb', { ...lib.header, ...g.header });
  /** @type {Array<{type: string, body: Uint8Array, item: string|null, intended: RecordInfo['intended'], lenField?: number}>} */
  const before = [];
  /** @type {typeof before} */
  const after = [];
  const extra = g.extra ?? [];
  for (const e of extra) if (e.at === 'start') before.push({ type: e.type, body: Uint8Array.from(e.body), item: null, intended: null });
  const ordered = [
    ...lib.items.filter((i) => i.kind === 'waypoint'),
    ...lib.items.filter((i) => i.kind === 'route'),
    ...lib.items.filter((i) => i.kind === 'track'),
  ];
  for (const it of ordered) {
    /** @type {(typeof before)[number]} */
    let rec;
    if (it.kind === 'waypoint') {
      const { body, intended } = waypointBody(it);
      rec = { type: 'W', body, item: it.id, intended };
    } else if (it.kind === 'track') {
      const { body, intended } = trackBody(it, /** @type {string} */ (uuids.get(it.id)));
      rec = { type: 'T', body, item: it.id, intended };
    } else {
      rec = { type: 'R', body: routeBody(it, next).body, item: it.id, intended: null };
    }
    const placeAfter = it.kind === 'waypoint' && it.gdb?.afterV;
    (placeAfter ? after : before).push(rec);
  }
  for (const e of extra) if (e.at === 'beforeV') before.push({ type: e.type, body: Uint8Array.from(e.body), item: null, intended: null });
  const end = g.end ?? 'VEX';
  /** @type {typeof before} */
  const records = [...before, { type: 'V', body: V_BODY, item: null, intended: null }];
  for (const e of extra) if (e.at === 'afterV') after.push({ type: e.type, body: Uint8Array.from(e.body), item: null, intended: null });
  const eLength = g.eLength ?? 4;
  if (eLength !== 4 && eLength !== 8) throw new RangeError('eLength is 4 or 8');
  records.push(...after, { type: 'E', body: eLength === 8 ? E_BODY_MAC48 : E_BODY, item: null, intended: null });
  if (end !== 'VE') records.push({ type: 'X', body: X_BODY, item: null, intended: null });

  const out = new ByteSink().bytes(header);
  /** @type {RecordInfo[]} */
  const infos = [];
  for (const r of records) {
    const offset = out.length;
    out.bytes(frameRecord(r.type, r.body));
    infos.push({ type: r.type, offset, bodyStart: offset + 5, len: r.body.length, lenField: r.body.length, item: r.item, intended: r.intended });
  }
  if (end === 'VEX+junk') out.bytes(junkBytes(g.junkAfterEnd ?? 7, 0xe0f));
  let bytes = out.toBytes();

  if (g.absurdLength) {
    const info = infos.find((r) => r.item === g.absurdLength?.item);
    if (!info) throw new RangeError('absurdLength names an unknown item');
    const len = g.absurdLength.len ?? 0xfffffff0;
    new DataView(bytes.buffer).setUint32(info.offset, len, true);
    info.lenField = len;
  }
  if (g.truncate) {
    const info = infos.find((r) => r.item === g.truncate?.item);
    if (!info) throw new RangeError('truncate names an unknown item');
    if (g.truncate.keep < 0 || g.truncate.keep >= info.len) throw new RangeError('truncate.keep must cut inside the body');
    bytes = bytes.slice(0, info.bodyStart + g.truncate.keep);
  }
  return { bytes, manifest: { role: 'gdb', headerEnd: header.length, length: bytes.length, records: infos } };
}

/**
 * Builds FolderData.gfi (FORMAT.md §8).
 * @param {LibrarySpec} lib
 * @param {ReturnType<typeof indexSpec>} idx
 * @returns {{bytes: Uint8Array, manifest: FileManifest}}
 */
function buildGfi(lib, idx) {
  const gfi = lib.gfi ?? {};
  const header = headerBytes('gfi', { ...lib.header, ...gfi.header });
  const rootId = gfi.rootId ?? ROOT_FOLDER_ID;
  const folders = [...idx.folders.values()];
  /** @param {string|null} parentId */
  const childrenOf = (parentId) =>
    folders.filter((f) => f.parentId === parentId).map((f) => /** @type {['folder'|'list', string]} */ ([f.type, f.id]));
  /** @param {Array<['folder'|'list', string|number]>} kids  a number is a raw ID (a dangling reference fixture) */
  const childRefs = (kids) => kids.map(([type, id]) => {
    const n = typeof id === 'number' ? id : idx.gfiId.get(id);
    if (n === undefined) throw new RangeError(`unknown child ${id}`);
    if (typeof id === 'string' && idx.folders.get(id)?.type !== type) throw new RangeError(`child ${id} is not a ${type}`);
    return [type === 'list' ? 0 : 1, n];
  });
  /** @param {string|null} folderId */
  const folderNumber = (folderId) => (folderId === null ? rootId : /** @type {number} */ (idx.gfiId.get(folderId)));

  /** @type {Array<{type: string, body: Uint8Array}>} */
  const records = [];
  /**
   * @param {number} id
   * @param {Text} name
   * @param {number} parent
   * @param {number[][]} kids
   * @param {ArrayLike<number>} tail
   */
  const fRecord = (id, name, parent, kids, tail) => {
    const s = new ByteSink().u32(id).cstr(name).u32(parent).u32(kids.length);
    for (const [t, n] of kids) s.u32(t).u32(n);
    s.bytes(tail);
    records.push({ type: 'F', body: s.toBytes() });
  };
  const folderTail = (gfi.folderTail ?? 'op') === 'mac48' ? FOLDER_TAIL_MAC48 : [1];
  if (gfi.folderTail !== undefined && gfi.folderTail !== 'op' && gfi.folderTail !== 'mac48') throw new RangeError('folderTail is op or mac48');
  const rootKids = gfi.children?.['$root'] ?? childrenOf(null);
  fRecord(rootId, gfi.rootName ?? 'My Collection', gfi.rootParent ?? rootId, childRefs(rootKids), folderTail);
  for (const f of folders) {
    if (f.type !== 'folder') continue;
    const kids = gfi.children?.[f.id] ?? childrenOf(f.id);
    fRecord(/** @type {number} */ (idx.gfiId.get(f.id)), f.name, folderNumber(f.parentId), childRefs(kids), f.tail ?? folderTail);
    if (gfi.duplicateFolder === f.id) {
      // A second F record with the same ID: FORMAT.md §8.4 "duplicate IDs are ignored after the first".
      fRecord(/** @type {number} */ (idx.gfiId.get(f.id)), f.name, folderNumber(f.parentId), [], folderTail);
    }
  }
  for (const f of folders) {
    if (f.type !== 'list') continue;
    const createdBy = f.createdBy ?? 0;
    const parent = gfi.listParents && f.id in gfi.listParents ? gfi.listParents[f.id] : f.parentId;
    const s = new ByteSink().u32(/** @type {number} */ (idx.gfiId.get(f.id))).cstr(f.name).u32(createdBy).u32(folderNumber(parent ?? null));
    if (f.tail) s.bytes(f.tail);
    else if (createdBy === 3) s.bytes(SMART_LIST_TAIL);
    else if (createdBy !== 0) s.u8(1).u32(1).u32(9);
    records.push({ type: 'I', body: s.toBytes() });
  }
  // Item references, grouped R* T* W* K* J* (FORMAT.md §8, OP p.32).
  /** @type {Record<string, Uint8Array[]>} */
  const refs = { R: [], T: [], W: [], K: [], J: [] };
  for (const f of folders) {
    if (f.type !== 'list') continue;
    const listNo = /** @type {number} */ (idx.gfiId.get(f.id));
    for (const itemId of f.itemIds ?? []) {
      const it = /** @type {ItemSpec} */ (idx.items.get(itemId));
      const s = new ByteSink().u32(listNo).bytes(gfiNameBytes(it)).u8(0);
      if (it.kind === 'track') refs.T.push(s.u32(0).toBytes());
      else if (it.kind === 'waypoint') refs.W.push(s.u32(it.gdb?.class ?? 0).toBytes());
      else refs.R.push(s.u8(0).toBytes());
    }
  }
  for (const e of gfi.extraRefs ?? []) {
    const listNo = idx.gfiId.get(e.list);
    if (listNo === undefined || idx.folders.get(e.list)?.type !== 'list') throw new RangeError(`extra ref names unknown list ${e.list}`);
    const s = new ByteSink().u32(listNo).cstr(e.name);
    if (e.type === 'T') s.u32(0);
    else if (e.type === 'W') s.u32(e.class ?? 0);
    else if (e.type === 'R') s.u8(0);
    refs[e.type].push(s.toBytes());
  }
  for (const type of ['R', 'T', 'W', 'K', 'J']) for (const body of refs[type]) records.push({ type, body });

  const out = new ByteSink().bytes(header);
  /** @type {RecordInfo[]} */
  const infos = [];
  for (const r of records) {
    const offset = out.length;
    out.bytes(frameRecord(r.type, r.body));
    infos.push({ type: r.type, offset, bodyStart: offset + 5, len: r.body.length, lenField: r.body.length, item: null, intended: null });
  }
  const bytes = out.toBytes();
  return { bytes, manifest: { role: 'gfi', headerEnd: header.length, length: bytes.length, records: infos } };
}

/**
 * Builds one TrackSegments/<uuid> file (FORMAT.md §9).
 * @param {LibrarySpec} lib
 * @param {TrackSpec} trk
 * @returns {{bytes: Uint8Array, manifest: FileManifest}}
 */
function buildTrackSegments(lib, trk) {
  const ts = trk.ts ?? {};
  const n = ts.n ?? 17;
  if (n !== 17 && n !== 11) throw new RangeError('TrackSegments points are 17 or 11 bytes');
  const header = headerBytes('trackSegments', {
    ...lib.header,
    ...lib.trackSegments?.header,
    ...(ts.signature !== undefined ? { signature: ts.signature } : {}),
    ...(ts.programVersion !== undefined ? { programVersion: ts.programVersion } : {}),
  });
  const pts = trackSegmentsPoints(trk);
  const s = new ByteSink().bytes(header).u32(ts.countOverride ?? pts.length);
  let sensors = false;
  pts.forEach((p, i) => {
    s.fdouble(p.ele ?? null);
    s.fint(sec(p.time));
    const atemp = p.atemp ?? null;
    const hr = p.hr ?? null;
    if (atemp !== null || hr !== null) {
      if (n !== 17) throw new RangeError('temperature and heart rate exist only in the 17-slot point (FORMAT.md §15.11)');
      sensors = true;
    }
    if (ts.extraByte && ts.extraByte.point === i) {
      assertInt(ts.extraByte.byte, 0, n - 3, 'extraByte.byte');
      if (n === 17 && (ts.extraByte.byte === 3 || ts.extraByte.byte === 4)) {
        throw new RangeError('extraByte must name a slot of unknown width (slots 6 and 7 have values, §15.11)');
      }
    }
    if (n === 11) {
      const extra = new Uint8Array(9);
      if (ts.extraByte && ts.extraByte.point === i) extra[ts.extraByte.byte] = 1;
      s.bytes(extra);
      return;
    }
    // Slots 3-17 (FORMAT.md §15.11): presence bytes, with the value after slot 6 (f64) and slot 7 (u8) when present.
    for (let slot = 3; slot <= 17; slot++) {
      const hooked = ts.extraByte !== undefined && ts.extraByte.point === i && ts.extraByte.byte === slot - 3;
      if (slot === 6 && atemp !== null) s.u8(1).f64(atemp);
      else if (slot === 7 && hr !== null) {
        assertInt(hr, 0, 255, 'hr');
        s.u8(1).u8(hr);
      } else s.u8(hooked ? 1 : 0);
    }
  });
  s.zeros(ts.trailing ?? 0);
  const corrupt = ts.extraByte !== undefined || (ts.trailing ?? 0) > 0 || ts.countOverride !== undefined;
  return {
    bytes: s.toBytes(),
    manifest: {
      role: 'trackSegments',
      headerEnd: header.length,
      length: s.length,
      records: [],
      track: trk.id,
      intendedN: corrupt ? [] : pts.length === 0 && (ts.countOverride ?? 0) === 0 ? [17, 11] : [n],
      pointCount: pts.length,
      points: pts.map((p) => ({ ele: p.ele ?? null, time: p.time ?? null, atemp: p.atemp ?? null, hr: p.hr ?? null })),
      sensors,
    },
  };
}

/**
 * Builds a whole library from a description.
 * Paths are relative to the Database/<version> folder: "AllData.gdb", "FolderData.gfi", "TrackSegments/<uuid>".
 * @param {LibrarySpec} lib
 * @returns {{files: Map<string, Uint8Array>, manifest: Map<string, FileManifest>, uuids: Map<string, string>, databaseVersion: string}}
 */
export function buildLibrary(lib) {
  const idx = indexSpec(lib);
  const next = prng(lib.seed ?? 1);
  /** @type {Map<string, string>} */
  const uuids = new Map();
  for (const it of lib.items) {
    if (it.kind !== 'track') continue;
    const u = it.gdb?.uuid ?? makeUuid(next);
    if ([...uuids.values()].includes(u)) throw new RangeError(`duplicate track uuid on ${it.id}`);
    uuids.set(it.id, u);
  }
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  /** @type {Map<string, FileManifest>} */
  const manifest = new Map();
  const gdb = buildGdb(lib, idx, uuids, next);
  files.set('AllData.gdb', gdb.bytes);
  manifest.set('AllData.gdb', gdb.manifest);
  if (lib.gfi !== null) {
    const gfi = buildGfi(lib, idx);
    files.set('FolderData.gfi', gfi.bytes);
    manifest.set('FolderData.gfi', gfi.manifest);
  }
  for (const it of lib.items) {
    if (it.kind !== 'track' || it.ts?.omit) continue;
    const ts = buildTrackSegments(lib, it);
    const path = `TrackSegments/${uuids.get(it.id)}`;
    files.set(path, ts.bytes);
    manifest.set(path, ts.manifest);
  }
  return { files, manifest, uuids, databaseVersion: lib.databaseVersion ?? '4.8' };
}
