#!/usr/bin/env node
// hexmap: prints an annotated byte map of a BaseCamp library's records, using the Mac BaseCamp 4.8.13 layouts that
// were measured on real output (docs/FORMAT.md §15, "H-MAC48"). It is a developer tool for checking a layout against a
// library, not part of the shipped app.
//
// For every record it prints each field's offset inside the body, its size, its name, its value and a tag:
//   V  verified on the real sample (testdata/basecamp-real/run1-gate1): the field held a known made-up value there (or a value computed from them);
//   C  constant in the sample: same value in every record, so its meaning (and, for runs of zeros, the split) is untested;
//   G  guess.
// and then whether the record was consumed exactly ("mapped exactly"), left bytes over, or could not be mapped.
//
// PRIVACY. By default nothing that could be personal is printed: no string (names, comments, addresses, notes), no
// position, no time, no measured value (altitude, length, area...), no UUID, no TrackSegments file name, no build
// string from the 'A' record, and runs of unknown bytes only as "n bytes, k non-zero". Flags, counts, sizes, offsets
// and small numbers (class, icon, colour, list and folder ids) are printed. `--show-text` prints everything, including
// hex for the unknown runs: use it ONLY on made-up libraries such as testdata/basecamp-real/.
//
// The library is hostile input: every read is bounds-checked, every count is checked against the bytes left before a
// loop, and a record that does not fit is reported and skipped. mapLibrary() never throws on bad bytes.
//
// Usage: node tools/hexmap.js <library folder> [--show-text] [--summary]
//   <library folder>  the folder that holds AllData.gdb, FolderData.gfi and TrackSegments/ (for example .../4.8)
//   --show-text       also print strings, positions, times, measured values, UUIDs and unknown bytes (made-up data only)
//   --summary         print only the per-file summary and the track pairing
// Exit code: 0 every record and TrackSegments file mapped exactly and every track found its file; 1 otherwise; 2 usage.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readContainer, readHeader } from '../src/format/container.js';

/** Files above this size are not read (a dev tool; a real AllData.gdb of this size would print far too much anyway). */
export const MAX_FILE_BYTES = 1 << 30;
/** TrackSegments files above this size are not read. */
export const MAX_TRACKSEGMENTS_BYTES = 256 << 20;
/** Unknown integers above this print as "large" without --show-text (they could be a time or a coordinate). */
const MAX_PRINTED_RAW = 0xffff;
const UUID_SHAPE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const LAT_LIMIT = 2 ** 30;

/**
 * Value kinds decide what the default (private) output shows.
 * text: a string; pos: a position; time: Unix seconds; measure: an f64; opaque: unknown bytes; uuid: a UUID string;
 * small: a flag, count, enum or id (always shown); raw: an integer of unknown meaning (shown when small);
 * flags: a run of bytes shown as they are when every byte is 0 or 1 (else counted like opaque).
 * @typedef {"text"|"pos"|"time"|"measure"|"opaque"|"uuid"|"small"|"raw"|"flags"} Kind
 */

/**
 * @typedef {object} Line
 * @property {number} off     offset inside the record body (or the TrackSegments body)
 * @property {number} size
 * @property {string} name
 * @property {Kind} kind
 * @property {unknown} value  the raw value (kept in memory for tests; the formatter decides what to print)
 * @property {"V"|"C"|"G"} tag
 * @property {string} [note]
 */

/**
 * @typedef {object} MappedRecord
 * @property {string} type
 * @property {number} index     index among the file's records
 * @property {number} offset    file offset of the 5-byte frame
 * @property {number} length    body length
 * @property {"exact"|"left"|"stopped"|"no-layout"} status
 * @property {number} left      bytes left over after the layout (status "left")
 * @property {{code: string, off: number, field: string}|null} stop
 * @property {Line[]} lines
 * @property {Record<string, unknown>} facts  a few decoded values other parts of the map need (uuid, total point count)
 */

class Stop extends Error {
  /**
   * @param {string} code
   * @param {number} off
   * @param {string} field
   */
  constructor(code, off, field) {
    super(code);
    this.code = code;
    this.off = off;
    this.field = field;
  }
}

/** A bounds-checked reader over one record body that records a Line per field. */
class Mapper {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    this.b = bytes;
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.p = 0;
    /** @type {Line[]} */
    this.lines = [];
  }

  left() {
    return this.b.length - this.p;
  }

  /**
   * @param {number} n
   * @param {string} field
   */
  need(n, field) {
    if (n > this.left()) throw new Stop('runs past the end', this.p, field);
  }

  /**
   * @param {number} off
   * @param {string} name
   * @param {Kind} kind
   * @param {unknown} value
   * @param {"V"|"C"|"G"} tag
   * @param {string} [note]
   */
  line(off, name, kind, value, tag, note) {
    this.lines.push({ off, size: this.p - off, name, kind, value, tag, note });
  }

  /** @param {string} name @param {"V"|"C"|"G"} tag @param {string} [note] */
  cstr(name, tag, note) {
    const off = this.p;
    let end = off;
    while (end < this.b.length && this.b[end] !== 0) end++;
    if (end >= this.b.length) throw new Stop('string has no terminator', off, name);
    const value = new TextDecoder('utf-8', { fatal: false }).decode(this.b.subarray(off, end));
    this.p = end + 1;
    this.line(off, name, 'text', value, tag, note);
    return value;
  }

  /** @param {string} name @param {Kind} kind @param {"V"|"C"|"G"} tag @param {string} [note] */
  u8(name, kind, tag, note) {
    this.need(1, name);
    const off = this.p;
    const value = this.b[this.p++];
    this.line(off, name, kind, value, tag, note);
    return value;
  }

  /** A byte that must be 0 or 1. @param {string} name @param {"V"|"C"|"G"} tag @param {string} [note] */
  flag(name, tag, note) {
    const off = this.p;
    const value = this.u8(name, 'small', tag, note);
    if (value > 1) throw new Stop(`flag is ${value}, not 0 or 1`, off, name);
    return value;
  }

  /** @param {string} name @param {Kind} kind @param {"V"|"C"|"G"} tag @param {string} [note] */
  u16(name, kind, tag, note) {
    this.need(2, name);
    const off = this.p;
    const value = this.v.getUint16(off, true);
    this.p += 2;
    this.line(off, name, kind, value, tag, note);
    return value;
  }

  /** @param {string} name @param {Kind} kind @param {"V"|"C"|"G"} tag @param {string} [note] */
  u32(name, kind, tag, note) {
    this.need(4, name);
    const off = this.p;
    const value = kind === 'time' ? this.v.getInt32(off, true) : this.v.getUint32(off, true);
    this.p += 4;
    this.line(off, name, kind, value, tag, note);
    return value;
  }

  /** @param {string} name @param {"V"|"C"|"G"} tag @param {string} [note] */
  f64(name, tag, note) {
    this.need(8, name);
    const off = this.p;
    const value = this.v.getFloat64(off, true);
    this.p += 8;
    this.line(off, name, 'measure', value, tag, note);
    return value;
  }

  /** @param {string} name @param {"V"|"C"|"G"} tag @param {string} [note] */
  pos(name, tag, note) {
    this.need(8, name);
    const off = this.p;
    const lat = this.v.getInt32(off, true);
    const lon = this.v.getInt32(off + 4, true);
    this.p += 8;
    if (lat < -LAT_LIMIT || lat > LAT_LIMIT) throw new Stop('latitude out of range', off, name);
    this.line(off, name, 'pos', [lat, lon], tag, note);
    return [lat, lon];
  }

  /** Flag, then an f64 when the flag is 1. @param {string} name @param {"V"|"C"|"G"} tag @param {string} [note] */
  fdouble(name, tag, note) {
    const off = this.p;
    this.need(1, name);
    const f = this.b[this.p];
    if (f > 1) throw new Stop(`flag is ${f}, not 0 or 1`, off, name);
    this.p++;
    if (f === 0) {
      this.line(off, name, 'small', null, tag, note);
      return null;
    }
    this.need(8, name);
    const value = this.v.getFloat64(this.p, true);
    this.p += 8;
    this.line(off, name, 'measure', value, tag, note);
    return value;
  }

  /** Flag, then an i32 when the flag is 1. @param {string} name @param {Kind} kind @param {"V"|"C"|"G"} tag @param {string} [note] */
  fint(name, kind, tag, note) {
    const off = this.p;
    this.need(1, name);
    const f = this.b[this.p];
    if (f > 1) throw new Stop(`flag is ${f}, not 0 or 1`, off, name);
    this.p++;
    if (f === 0) {
      this.line(off, name, 'small', null, tag, note);
      return null;
    }
    this.need(4, name);
    const value = this.v.getInt32(this.p, true);
    this.p += 4;
    this.line(off, name, kind, value, tag, note);
    return value;
  }

  /** Flag, then a cstr when the flag is 1. @param {string} name @param {"V"|"C"|"G"} tag @param {string} [note] */
  fstring(name, tag, note) {
    const off = this.p;
    this.need(1, name);
    const f = this.b[this.p];
    if (f > 1) throw new Stop(`flag is ${f}, not 0 or 1`, off, name);
    this.p++;
    if (f === 0) {
      this.line(off, name, 'small', null, tag, note);
      return null;
    }
    let end = this.p;
    while (end < this.b.length && this.b[end] !== 0) end++;
    if (end >= this.b.length) throw new Stop('string has no terminator', off, name);
    const value = new TextDecoder('utf-8', { fatal: false }).decode(this.b.subarray(this.p, end));
    this.p = end + 1;
    this.line(off, name, 'text', value, tag, note);
    return value;
  }

  /** @param {number} n @param {string} name @param {"V"|"C"|"G"} tag @param {string} [note] */
  bytes(n, name, tag, note) {
    this.need(n, name);
    const off = this.p;
    const value = this.b.subarray(off, off + n);
    this.p += n;
    this.line(off, name, 'opaque', value, tag, note);
    return value;
  }

  /** A NUL-terminated 36-character UUID. @param {string} name @param {"V"|"C"|"G"} tag @param {string} [note] */
  uuid(name, tag, note) {
    this.need(37, name);
    const off = this.p;
    let s = '';
    for (let i = 0; i < 36; i++) s += String.fromCharCode(this.b[off + i]);
    if (this.b[off + 36] !== 0 || !UUID_SHAPE.test(s)) throw new Stop('not a UUID', off, name);
    this.p += 37;
    this.line(off, name, 'uuid', s, tag, note);
    return s;
  }

  /**
   * A u32 count, checked against the bytes left: count × minEach must fit.
   * @param {string} name @param {number} minEach @param {"V"|"C"|"G"} tag @param {string} [note]
   */
  count(name, minEach, tag, note) {
    const off = this.p;
    const n = this.u32(name, 'small', tag, note);
    if (n * minEach > this.left()) throw new Stop(`count ${n} does not fit in the bytes left`, off, name);
    return n;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Layouts (docs/FORMAT.md §15). Each function maps one record body field by field.

/** 'W' waypoint, Mac 4.8 (§15.3). @param {Mapper} m */
function mapWaypoint(m) {
  m.cstr('name', 'V', 'link key for GFI W references');
  m.u32('class', 'small', 'V', '0 = user waypoint, 8 = route via point');
  m.pos('position', 'V');
  m.cstr('comment', 'V');
  m.fdouble('proximity (m)', 'C');
  m.u32('display mode', 'small', 'C', '1 on class 0, 0 on class 8 in the sample');
  m.u32('icon', 'small', 'C', '141 (Flag, Blue) in every record');
  m.cstr('street', 'V');
  m.cstr('city', 'V');
  m.cstr('state', 'V');
  m.cstr('country', 'V');
  m.cstr('postal code', 'V');
  const b = m.flag('subclass flag', 'C', 'KBM: 1 = 24 more bytes follow; only 0 seen');
  if (b === 1) m.bytes(24, 'subclass (24 bytes)', 'G');
  else m.u8('subclass second byte', 'raw', 'C', "KBM's stop byte; 0 in every record");
  m.fdouble('altitude (m)', 'V');
  m.fdouble('depth (m)', 'C', 'position inside 6 zero bytes is KBM\'s');
  const links = m.count('link count', 1, 'C');
  for (let i = 0; i < links; i++) m.cstr(`link ${i + 1}`, 'G');
  m.fdouble('temperature', 'C');
  m.fint('time A (set on import)', 'time', 'V', 'the import time in every record');
  m.bytes(6, 'unknown (6 bytes)', 'C', 'zero; length pinned by the phone count after it');
  const phones = m.count('phone count', 2, 'V', '1 on the waypoint imported with a phone number');
  for (let i = 0; i < phones; i++) {
    m.cstr(`phone ${i + 1}`, 'V');
    m.fstring(`phone ${i + 1} category`, 'G', 'one 0 byte after the phone in the sample');
  }
  m.fint('time B (creation; GPX <time>)', 'time', 'V', 'the GPX <time> when there was one, else the import time');
  m.bytes(3, 'unknown (3 bytes)', 'C', 'with the next two fields: 15 zero bytes; only the sum is verified');
  const cats = m.count('category count', 1, 'C', "KBM's position for categories");
  for (let i = 0; i < cats; i++) m.cstr(`category ${i + 1}`, 'G');
  m.bytes(8, 'unknown (8 bytes, Mac 4.8)', 'C', 'not in KBM or OP; zero in every record');
}

/** 'T' track, Mac 4.8 (§15.4). @param {Mapper} m @param {Record<string, unknown>} facts */
function mapTrack(m, facts) {
  m.cstr('name', 'V');
  m.bytes(5, 'display flag + 4-byte gap (order unknown)', 'C', '00 00 00 00 01 in every track');
  m.u32('colour', 'small', 'C', '9 in every track');
  const links = m.count('link count', 1, 'C');
  for (let i = 0; i < links; i++) m.cstr(`link ${i + 1}`, 'G');
  m.cstr('notes', 'C');
  m.f64('area (m²)', 'V', 'planar closed-polygon area at the mid latitude, R = 6378137 m (§15.4)');
  m.fdouble('average speed (m/s)', 'V', 'length / duration; absent without times');
  m.u8('unknown', 'raw', 'C', '0');
  m.pos('track max (lat, lon)', 'V');
  m.pos('track min (lat, lon)', 'V');
  m.fdouble('duration (s)', 'V', 'last time - first time');
  m.f64('length (m)', 'V', 'great-circle sum, sphere R = 6378137 m');
  m.fint('start time', 'time', 'V');
  m.u32('unknown u32 (KBM gap 2)', 'raw', 'C', '1 in every track; this or the next is the segment count');
  const segs = m.count('segment count', 21, 'C', '1 in every track (the 2-segment GPX came back as 1)');
  let points = 0;
  /** @type {Array<[number, number]>} */
  const positions = [];
  for (let s = 0; s < segs; s++) {
    m.u8(`segment ${s + 1}: unknown`, 'raw', 'C', '0');
    m.pos(`segment ${s + 1}: max`, 'V');
    m.pos(`segment ${s + 1}: min`, 'V');
    const n = m.count(`segment ${s + 1}: point count`, 8, 'V');
    const off = m.p;
    m.need(n * 8, `segment ${s + 1}: points`);
    for (let i = 0; i < n; i++) {
      const lat = m.v.getInt32(m.p, true);
      if (lat < -LAT_LIMIT || lat > LAT_LIMIT) throw new Stop('latitude out of range', m.p, `segment ${s + 1}: point ${i + 1}`);
      positions.push([lat, m.v.getInt32(m.p + 4, true)]);
      m.p += 8;
    }
    m.line(off, `segment ${s + 1}: ${n} positions`, 'pos', null, 'V', '8 bytes each: lat, lon');
    points += n;
  }
  facts.points = points;
  facts.positions = positions;
  facts.total = m.u32('total point count', 'small', 'V', 'equals the TrackSegments point count (S = 1 in the sample)');
  facts.uuid = m.uuid('TrackSegments UUID', 'V', 'names TrackSegments/<UUID>');
  m.bytes(3, 'unknown (3 bytes)', 'C', 'zero');
  const flags = m.bytes(11, 'per-track flags (11 bytes)', 'V', '1st = has elevation, 2nd = has time (V); 3rd+4th set together on the sensor track (which is which: G); 5th-11th 0 (C)');
  /** @type {Line} */ (m.lines.at(-1)).kind = 'flags';
  facts.flags = [...flags];
  m.fdouble('ascent? (m)', 'G', 'present when the track has elevation; equals raw ascent only on the track without times');
  m.fdouble('descent? (m)', 'G', 'present when the track has elevation; 0 in every track (all only climb)');
  m.bytes(8, 'unknown (8 bytes, Mac 4.8)', 'C', 'zero');
}

/** 'R' route, Mac 4.8 (§15.5). @param {Mapper} m */
function mapRoute(m) {
  m.cstr('name', 'V');
  m.flag('auto-name', 'C', '0');
  const points = m.count('route point count', 55, 'V');
  for (let i = 0; i < points; i++) {
    const p = `point ${i + 1}`;
    m.cstr(`${p}: name`, 'V', 'names a class-8 W record');
    m.u32(`${p}: class`, 'small', 'V', '8 = the via-point waypoint');
    m.fstring(`${p}: unknown fstring`, 'C', 'OP Unknown1; absent');
    m.u32(`${p}: unknown u32`, 'raw', 'C', 'OP Unknown2; 3');
    m.u32(`${p}: unknown u32`, 'raw', 'C', 'OP Unknown3; 0xFFFFFFFF');
    m.u32(`${p}: unknown u32`, 'raw', 'C', 'OP Unknown4; 0');
    m.u16(`${p}: unknown u16`, 'raw', 'C', 'OP Unknown5; 0');
    m.u32(`${p}: unknown u32`, 'raw', 'C', 'OP Unknown6; 0');
    const links = m.count(`${p}: link point count`, 8, 'V', '2 = this via point and the next; 0 on the last');
    for (let k = 0; k < links; k++) m.pos(`${p}: link point ${k + 1}`, 'V');
    const omit = m.flag(`${p}: no bounding box`, 'V', '0 with link points, 1 without');
    if (omit === 0) {
      m.pos(`${p}: max`, 'V', 'OP order; max/min not told from end/start in the sample');
      m.pos(`${p}: min`, 'V');
    }
    const ff = m.bytes(8, `${p}: marker`, 'C', 'eight 0xFF bytes (as OP)');
    if (!ff.every((x) => x === 0xff)) throw new Stop('marker is not eight 0xFF bytes', m.p - 8, `${p}: marker`);
    m.bytes(19, `${p}: unknown (19 bytes)`, 'C', 'zero; OP has 6 here (two fint flags, autoroute count)');
  }
  const noBounds = m.flag('no bounds', 'C', '0');
  if (noBounds === 0) {
    m.pos('route max', 'V', 'OP order; max/min not told from last/first in the sample');
    m.pos('route min', 'V');
  }
  const links = m.count('link count', 1, 'C');
  for (let i = 0; i < links; i++) m.cstr(`link ${i + 1}`, 'G');
  m.u32('colour', 'small', 'C', '14 (Magenta)');
  const auto = m.flag('autoroute settings present', 'C', '0');
  if (auto === 1) throw new Stop('autoroute settings block not mapped', m.p, 'autoroute settings');
  m.cstr('notes', 'C');
  m.flag('is filtered route', 'C', '0');
  const filtered = m.count('filtered point count', 8, 'C');
  for (let i = 0; i < filtered; i++) m.pos(`filtered point ${i + 1}`, 'G');
  const u10 = m.flag('unknown flag (OP Unknown10)', 'C', '1');
  if (u10 === 0) {
    m.pos('unknown position 1', 'G');
    m.pos('unknown position 2', 'G');
  }
  m.u8('unknown (OP Unknown11)', 'raw', 'C', '0');
  m.u32('activity profile', 'small', 'C', '6 = Direct (OP p.25)');
  m.bytes(10, 'unknown (10 bytes, Mac 4.8)', 'C', '01 then nine 0');
}

/** 'F' folder (§15.6). @param {Mapper} m */
function mapFolder(m) {
  m.u32('folder id', 'small', 'V', '0xFFFFFFFF = My Collection');
  m.cstr('name', 'V');
  m.u32('parent folder id', 'small', 'V');
  const n = m.count('child count', 8, 'V');
  for (let i = 0; i < n; i++) {
    m.u32(`child ${i + 1}: type`, 'small', 'V', '0 = list, 1 = folder');
    m.u32(`child ${i + 1}: id`, 'small', 'V');
  }
  m.u8('unknown', 'raw', 'C', '1 (OP Unknown1)');
  m.u32('unknown u32', 'raw', 'C', '0');
  m.u32('time', 'time', 'V', 'a Unix time during the session; created or modified: G');
  m.u8('unknown', 'raw', 'C', '0');
}

/** 'I' list (§15.6). @param {Mapper} m */
function mapList(m) {
  m.u32('list id', 'small', 'V');
  m.cstr('name', 'V');
  const by = m.u32('created by', 'small', 'V', '0 = user/import list, 3 = smart list, 8 = Unlisted Data');
  m.u32('parent folder id', 'small', 'V');
  if (by !== 0) {
    m.u8('unknown', 'raw', 'C', '1');
    const n = m.count('value count?', 4, 'G', '1 on Unlisted Data, 0 on the smart lists');
    for (let i = 0; i < n; i++) m.u32(`value ${i + 1}?`, 'raw', 'G', '9 on Unlisted Data');
  }
}

/** GFI item references (§15.6). @param {Mapper} m @param {string} type */
function mapReference(m, type) {
  m.u32('list id', 'small', 'V');
  m.cstr('item name', 'V');
  if (type === 'W') m.u32('waypoint class', 'small', 'C', '0 in every reference (OP: the class)');
  else if (type === 'T') m.u32('unknown u32', 'raw', 'C', '0');
  else if (type === 'R') m.u8('origin', 'raw', 'C', '0');
}

/** @type {Record<string, Record<string, (m: Mapper, facts: Record<string, unknown>) => void>>} */
const LAYOUTS = {
  gdb: {
    W: (m) => mapWaypoint(m),
    T: (m, facts) => mapTrack(m, facts),
    R: (m) => mapRoute(m),
    V: (m) => {
      m.cstr('map-set name', 'C', 'empty');
      m.u8('auto-name', 'raw', 'C', '1');
    },
    E: (m) => m.bytes(8, 'unknown (8 bytes; OP: a u32)', 'C', 'zero'),
    X: (m) => m.cstr('end marker', 'C', 'the fixed end-of-file text (as OP)'),
  },
  gfi: {
    F: (m) => mapFolder(m),
    I: (m) => mapList(m),
    R: (m) => mapReference(m, 'R'),
    T: (m) => mapReference(m, 'T'),
    W: (m) => mapReference(m, 'W'),
    K: (m) => mapReference(m, 'K'),
    J: (m) => mapReference(m, 'J'),
  },
};

/**
 * Maps one record body with the layout for its file kind and type.
 * @param {"gdb"|"gfi"} kind
 * @param {string} type
 * @param {Uint8Array} body
 * @returns {Pick<MappedRecord, "status"|"left"|"stop"|"lines"|"facts">}
 */
export function mapRecord(kind, type, body) {
  const layout = LAYOUTS[kind]?.[type];
  /** @type {Record<string, unknown>} */
  const facts = {};
  if (!layout) return { status: 'no-layout', left: 0, stop: null, lines: [], facts };
  const m = new Mapper(body);
  try {
    layout(m, facts);
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    return { status: 'stopped', left: m.left(), stop: { code: error.code, off: error.off, field: error.field }, lines: m.lines, facts };
  }
  const left = m.left();
  return { status: left === 0 ? 'exact' : 'left', left, stop: null, lines: m.lines, facts };
}

// ---------------------------------------------------------------------------------------------------------------
// TrackSegments (§15.7): a bare u32 point count after the header, then per point 17 optional fields, each a presence
// byte (0/1) followed by its value when 1. Widths are known only for the fields seen present in the sample.

/** Field slot (0-based) to [name, payload width, kind]. Slots not listed were never present: width unknown. */
export const TS_FIELDS = Object.freeze({
  0: ['elevation (m)', 8, 'measure'],
  1: ['time', 4, 'time'],
  5: ['temperature (°C)', 8, 'measure'],
  6: ['heart rate (bpm)', 1, 'measure'], // width 1 under the fixed 17-slot model (GUESS, well supported)
});
export const TS_FIELD_COUNT = 17;

/**
 * @typedef {object} MappedTrackSegments
 * @property {"exact"|"left"|"stopped"} status
 * @property {number} left
 * @property {{code: string, off: number, field: string}|null} stop
 * @property {object} header       signature, versions (never the build strings)
 * @property {number|null} count   the point count M
 * @property {Array<{from: number, to: number, size: number, present: string}>} runs  consecutive points with the same fields
 * @property {Array<Record<number, number>>} points  decoded values per point (slot -> value), for tests
 */

/**
 * @param {Uint8Array} bytes
 * @returns {MappedTrackSegments}
 */
export function mapTrackSegments(bytes) {
  const h = readHeader(bytes, { role: 'tracksegments' });
  const header = {
    signature: h.signatureHex ? hexToAscii(h.signatureHex) : null,
    formatVersion: h.formatVersion,
    programVersion: h.programVersion,
    application: h.application,
  };
  /** @type {MappedTrackSegments} */
  const out = { status: 'stopped', left: 0, stop: null, header, count: null, runs: [], points: [] };
  if (!h.ok) {
    out.stop = { code: `header not read (${h.stopped})`, off: 0, field: 'header' };
    return out;
  }
  const m = new Mapper(bytes.subarray(h.bodyStart));
  try {
    const n = m.count('point count', TS_FIELD_COUNT, 'V');
    out.count = n;
    for (let i = 0; i < n; i++) {
      const start = m.p;
      /** @type {Record<number, number>} */
      const values = {};
      const present = [];
      for (let f = 0; f < TS_FIELD_COUNT; f++) {
        m.need(1, `point ${i + 1}: field ${f + 1}`);
        const flag = m.b[m.p];
        if (flag > 1) throw new Stop(`flag is ${flag}, not 0 or 1`, m.p, `point ${i + 1}: field ${f + 1}`);
        m.p++;
        if (flag === 0) continue;
        const spec = /** @type {Record<number, [string, number, Kind]>} */ (TS_FIELDS)[f];
        if (!spec) throw new Stop('present field of unknown width', m.p - 1, `point ${i + 1}: field ${f + 1}`);
        m.need(spec[1], `point ${i + 1}: ${spec[0]}`);
        values[f] = spec[1] === 8 ? m.v.getFloat64(m.p, true) : spec[1] === 4 ? m.v.getInt32(m.p, true) : m.b[m.p];
        m.p += spec[1];
        present.push(spec[0]);
      }
      out.points.push(values);
      const size = m.p - start;
      const key = present.join(', ') || 'none';
      const last = out.runs.at(-1);
      if (last && last.present === key && last.size === size) last.to = i;
      else out.runs.push({ from: i, to: i, size, present: key });
    }
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    out.stop = { code: error.code, off: error.off, field: error.field };
    out.left = m.left();
    return out;
  }
  out.left = m.left();
  out.status = out.left === 0 ? 'exact' : 'left';
  return out;
}

/** @param {string} hex */
function hexToAscii(hex) {
  let s = '';
  for (let i = 0; i < hex.length; i += 2) {
    const c = parseInt(hex.slice(i, i + 2), 16);
    s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.';
  }
  return s;
}

// ---------------------------------------------------------------------------------------------------------------
// Library

/**
 * @typedef {object} MappedFile
 * @property {string} file
 * @property {object} header
 * @property {string|null} stopped   a whole-file problem from the container reader
 * @property {MappedRecord[]} records
 * @property {Record<string, {count: number, exact: number, left: number, stopped: number, noLayout: number}>} byType
 */

/**
 * @param {Uint8Array} bytes
 * @param {"gdb"|"gfi"} kind
 * @param {string} file
 * @returns {MappedFile}
 */
function mapContainerFile(bytes, kind, file) {
  const c = readContainer(bytes, { role: kind });
  const header = {
    signature: c.signature,
    primaryFormat: c.primaryFormat,
    formatVersion: c.formatVersion,
    programVersion: c.programVersion,
    application: c.application,
    complete: c.complete,
    endRecord: c.end.present,
    bytesAfterEnd: c.end.bytesAfter,
  };
  /** @type {MappedRecord[]} */
  const records = [];
  /** @type {MappedFile["byType"]} */
  const byType = {};
  c.records.forEach((r, index) => {
    const mapped = mapRecord(kind, r.type, r.body);
    records.push({ type: r.type, index, offset: r.offset, length: r.length, ...mapped });
    const t = (byType[r.type] ??= { count: 0, exact: 0, left: 0, stopped: 0, noLayout: 0 });
    t.count++;
    if (mapped.status === 'exact') t.exact++;
    else if (mapped.status === 'left') t.left++;
    else if (mapped.status === 'stopped') t.stopped++;
    else t.noLayout++;
  });
  return { file, header, stopped: c.stopped, records, byType };
}

/**
 * @typedef {object} LibraryMap
 * @property {MappedFile|null} gdb
 * @property {MappedFile|null} gfi
 * @property {Array<{name: string, map: MappedTrackSegments}>} trackSegments
 * @property {Array<{track: number, uuid: string|null, file: number|null, total: number|null, points: number|null, count: number|null, ok: boolean}>} pairing
 * @property {number} unpairedFiles   TrackSegments files no track names
 * @property {boolean} allExact
 */

/**
 * Maps a whole library. Never throws on bad bytes.
 * @param {{gdb?: Uint8Array|null, gfi?: Uint8Array|null, trackSegments?: Array<{name: string, bytes: Uint8Array}>}} input
 * @returns {LibraryMap}
 */
export function mapLibrary(input) {
  const gdb = input.gdb ? mapContainerFile(input.gdb, 'gdb', 'AllData.gdb') : null;
  const gfi = input.gfi ? mapContainerFile(input.gfi, 'gfi', 'FolderData.gfi') : null;
  const trackSegments = (input.trackSegments ?? []).map((f) => ({ name: f.name, map: mapTrackSegments(f.bytes) }));
  const byName = new Map(trackSegments.map((f, i) => [f.name.toUpperCase(), i]));
  const used = new Set();
  const pairing = [];
  for (const r of gdb?.records ?? []) {
    if (r.type !== 'T') continue;
    const uuid = typeof r.facts.uuid === 'string' ? r.facts.uuid : null;
    const file = uuid !== null ? (byName.get(uuid.toUpperCase()) ?? null) : null;
    if (file !== null) used.add(file);
    const total = typeof r.facts.total === 'number' ? r.facts.total : null;
    const points = typeof r.facts.points === 'number' ? r.facts.points : null;
    const count = file !== null ? trackSegments[file].map.count : null;
    const ok = file !== null && trackSegments[file].map.status === 'exact' && count === total && total === points;
    pairing.push({ track: r.index, uuid, file, total, points, count, ok });
  }
  const files = [gdb, gfi].filter((f) => f !== null);
  const allExact =
    files.every((f) => f.stopped === null && f.records.every((r) => r.status === 'exact')) &&
    trackSegments.every((f) => f.map.status === 'exact') &&
    pairing.every((p) => p.ok) &&
    used.size === trackSegments.length;
  return { gdb, gfi, trackSegments, pairing, unpairedFiles: trackSegments.length - used.size, allExact };
}

// ---------------------------------------------------------------------------------------------------------------
// Formatting

const deg = (/** @type {number} */ v) => ((v * 180) / 2 ** 31).toFixed(7);

/**
 * @param {Line} l
 * @param {boolean} show
 */
function valueText(l, show) {
  const v = l.value;
  if (v === null) return l.kind === 'pos' ? (show ? '(see points)' : 'positions') : 'absent';
  switch (l.kind) {
    case 'small':
      return String(v);
    case 'raw':
      return show || /** @type {number} */ (v) <= MAX_PRINTED_RAW ? `${v}${/** @type {number} */ (v) > 9 ? ` (0x${(/** @type {number} */ (v)).toString(16)})` : ''}` : 'large';
    case 'text':
      return show ? JSON.stringify(v) : `text, ${new TextEncoder().encode(/** @type {string} */ (v)).length} bytes`;
    case 'pos': {
      const [lat, lon] = /** @type {number[]} */ (v);
      return show ? `${deg(lat)}, ${deg(lon)}` : 'position';
    }
    case 'time': {
      if (!show) return 'present (a time)';
      const t = /** @type {number} */ (v);
      const d = new Date(t * 1000);
      return Number.isNaN(d.getTime()) ? String(t) : d.toISOString().replace('.000Z', 'Z');
    }
    case 'measure':
      return show ? String(v) : 'present (a value)';
    case 'uuid':
      return show ? String(v) : 'UUID (well-formed)';
    case 'flags':
    case 'opaque': {
      const b = /** @type {Uint8Array} */ (v);
      if (l.kind === 'flags' && b.every((x) => x <= 1)) return [...b].join(' ');
      if (show) return [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');
      const nz = b.reduce((n, x) => n + (x !== 0 ? 1 : 0), 0);
      return nz === 0 ? 'all zero' : `${nz} of ${b.length} non-zero`;
    }
    default:
      return '';
  }
}

/**
 * @param {MappedRecord} r
 * @param {string} file
 * @param {boolean} show
 */
function formatRecord(r, file, show) {
  const status =
    r.status === 'exact'
      ? 'mapped exactly'
      : r.status === 'left'
        ? `${r.left} bytes LEFT OVER`
        : r.status === 'no-layout'
          ? 'no layout for this type (not mapped)'
          : `COULD NOT MAP: ${r.stop?.code} at +${r.stop?.off} (${r.stop?.field})`;
  const out = [`${file}  ${r.type} #${r.index}  @${r.offset}  body ${r.length} bytes  ${status}`];
  for (const l of r.lines) {
    const note = l.note ? `  - ${l.note}` : '';
    out.push(`  +${String(l.off).padEnd(5)}${String(l.size).padStart(4)}  ${l.tag}  ${l.name.padEnd(40)} ${valueText(l, show)}${note}`);
  }
  if (r.status === 'left') out.push(`  +${String(r.length - r.left).padEnd(5)}${String(r.left).padStart(4)}  ?  (bytes not in the layout)`);
  return out.join('\n');
}

/**
 * Formats a LibraryMap as text. Without `showText` it holds no string, position, time, measured value, UUID or
 * unknown byte value from the library.
 * @param {LibraryMap} map
 * @param {{showText?: boolean, summary?: boolean}} [options]
 * @returns {string}
 */
export function formatMap(map, options = {}) {
  const show = options.showText === true;
  const out = [];
  out.push('hexmap: Mac BaseCamp 4.8 layouts (docs/FORMAT.md §15). Tags: V verified on the real Mac 4.8 sample, C constant there, G guess.');
  if (!show) out.push('Private mode: strings, positions, times, values and UUIDs are not printed (--show-text prints them; made-up data only).');
  for (const f of [map.gdb, map.gfi]) {
    if (!f) continue;
    const h = /** @type {any} */ (f.header);
    out.push('');
    out.push(
      `== ${f.file}: signature ${h.signature ?? '?'}, primary format 0x${(h.primaryFormat ?? 0).toString(16)}, file format ${h.formatVersion}, program version ${h.programVersion}, application ${h.application ?? '?'}` +
        `${f.file === 'AllData.gdb' ? `, end record ${h.endRecord ? 'yes' : 'no'}` : ''}${f.stopped ? `, STOPPED: ${f.stopped}` : ''}`,
    );
    for (const [type, t] of Object.entries(f.byType)) {
      out.push(`   ${type}: ${t.count} records, ${t.exact} mapped exactly, ${t.left} with bytes left over, ${t.stopped} could not be mapped, ${t.noLayout} without a layout`);
    }
    if (!options.summary) for (const r of f.records) out.push('', formatRecord(r, f.file, show));
  }
  if (map.trackSegments.length > 0 || map.pairing.length > 0) {
    out.push('', `== TrackSegments: ${map.trackSegments.length} files`);
    const fileLabel = (/** @type {number} */ i) => (show ? `TrackSegments/${map.trackSegments[i].name}` : `TrackSegments file #${i + 1}`);
    for (const p of map.pairing) {
      const ts = p.file !== null ? map.trackSegments[p.file].map : null;
      out.push(
        `   T #${p.track}: ${p.file === null ? 'NO FILE for its UUID' : fileLabel(p.file)}; track points ${p.points}, total field ${p.total}, file points ${p.count}, file ${ts ? (ts.status === 'exact' ? 'mapped exactly' : ts.status === 'left' ? `${ts.left} bytes left over` : `could not be mapped: ${ts.stop?.code} (${ts.stop?.field})`) : '-'}: ${p.ok ? 'PAIRED' : 'NOT PAIRED'}`,
      );
    }
    if (map.unpairedFiles > 0) out.push(`   ${map.unpairedFiles} TrackSegments files are named by no track`);
    if (!options.summary) {
      map.trackSegments.forEach((f, i) => {
        const h = /** @type {any} */ (f.map.header);
        out.push('', `${fileLabel(i)}: signature ${h.signature ?? '?'}, file format ${h.formatVersion}, program version ${h.programVersion}; point count ${f.map.count ?? '?'}; ${f.map.status === 'exact' ? 'mapped exactly' : f.map.status === 'left' ? `${f.map.left} bytes LEFT OVER` : `COULD NOT MAP: ${f.map.stop?.code} at +${f.map.stop?.off} (${f.map.stop?.field})`}`);
        for (const run of f.map.runs) {
          out.push(`   points ${run.from + 1}-${run.to + 1}: ${run.size} bytes each, present: ${run.present}`);
        }
        if (show) {
          f.map.points.forEach((pt, k) => {
            const parts = Object.entries(pt).map(([slot, v]) => {
              const spec = /** @type {Record<string, [string, number, Kind]>} */ (TS_FIELDS)[slot];
              return `${spec[0]} ${spec[2] === 'time' ? new Date(v * 1000).toISOString().replace('.000Z', 'Z') : v}`;
            });
            out.push(`     ${k + 1}: ${parts.join('; ') || '-'}`);
          });
        }
      });
    }
  }
  out.push('', map.allExact ? 'RESULT: every record and TrackSegments file mapped exactly, every track paired.' : 'RESULT: something did not map exactly or did not pair (see above).');
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// CLI

/**
 * Reads a library folder from disk.
 * @param {string} dir
 */
export function readLibraryFolder(dir) {
  /** @param {string} p @param {number} max */
  const readIf = (p, max) => {
    if (!existsSync(p)) return null;
    const st = statSync(p);
    if (!st.isFile() || st.size > max) return null;
    return new Uint8Array(readFileSync(p));
  };
  const gdb = readIf(join(dir, 'AllData.gdb'), MAX_FILE_BYTES);
  const gfi = readIf(join(dir, 'FolderData.gfi'), MAX_FILE_BYTES);
  const trackSegments = [];
  const tsDir = join(dir, 'TrackSegments');
  if (existsSync(tsDir) && statSync(tsDir).isDirectory()) {
    for (const name of readdirSync(tsDir).sort()) {
      if (name.startsWith('.')) continue;
      const bytes = readIf(join(tsDir, name), MAX_TRACKSEGMENTS_BYTES);
      if (bytes) trackSegments.push({ name, bytes });
    }
  }
  return { gdb, gfi, trackSegments };
}

function main() {
  const args = process.argv.slice(2);
  const showText = args.includes('--show-text');
  const summary = args.includes('--summary');
  const dirs = args.filter((a) => !a.startsWith('--'));
  if (args.includes('--help') || dirs.length !== 1 || args.some((a) => a.startsWith('--') && !['--show-text', '--summary'].includes(a))) {
    process.stderr.write('Usage: node tools/hexmap.js <library folder> [--show-text] [--summary]\n');
    process.exit(2);
  }
  const lib = readLibraryFolder(dirs[0]);
  if (!lib.gdb && !lib.gfi && lib.trackSegments.length === 0) {
    process.stderr.write('hexmap: no AllData.gdb, FolderData.gfi or TrackSegments/ in that folder.\n');
    process.exit(2);
  }
  const map = mapLibrary(lib);
  process.stdout.write(formatMap(map, { showText, summary }) + '\n');
  process.exit(map.allExact ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
