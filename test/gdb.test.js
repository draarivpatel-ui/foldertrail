// Unit tests for src/format/gdb.js: primitives, text decoding, and the W/T/R record parsers (FORMAT.md §2, §5-§7,
// §11). Every record here is built by hand from FORMAT.md's tables; nothing is copied from a real library.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import {
  Cursor,
  ParseStop,
  Counts,
  decodeText,
  rawKey,
  toDegrees,
  parseWaypoint,
  parseTrack,
  parseRoute,
  colorName,
  materialiseSegments,
  altitudeValue,
  timeValue,
} from '../src/format/gdb.js';

// ---------------------------------------------------------------------------------------------
// A little-endian byte builder (test-only)

class B {
  constructor() {
    /** @type {number[]} */
    this.a = [];
  }
  /** @param {...number} v */
  u8(...v) {
    for (const x of v) this.a.push(x & 0xff);
    return this;
  }
  /** @param {number} v */
  u16(v) {
    return this.u8(v, v >>> 8);
  }
  /** @param {number} v */
  u32(v) {
    return this.u8(v, v >>> 8, v >>> 16, v >>> 24);
  }
  /** @param {number} v */
  i32(v) {
    return this.u32(v >>> 0);
  }
  /** @param {number} v */
  f64(v) {
    const d = new DataView(new ArrayBuffer(8));
    d.setFloat64(0, v, true);
    return this.u8(...new Uint8Array(d.buffer));
  }
  /** @param {string} s */
  cstr(s) {
    return this.u8(...new TextEncoder().encode(s), 0);
  }
  /** @param {ArrayLike<number>} bytes */
  raw(bytes) {
    return this.u8(...Array.from(bytes));
  }
  /** @param {number|null} v */
  fdouble(v) {
    return v === null ? this.u8(0) : this.u8(1).f64(v);
  }
  /** @param {number|null} v */
  fint(v) {
    return v === null ? this.u8(0) : this.u8(1).i32(v);
  }
  /** @param {string[]} list */
  strings(list) {
    this.u32(list.length);
    for (const s of list) this.cstr(s);
    return this;
  }
  /** @param {number} lat @param {number} lon degrees */
  pos(lat, lon) {
    return this.i32(semi(lat)).i32(semi(lon));
  }
  bytes() {
    return Uint8Array.from(this.a);
  }
}

/** @param {number} deg */
const semi = (deg) => Math.round((deg * 2 ** 31) / 180);
const UUID = '0123abcd-4567-89ef-ABCD-0123456789ef';

/**
 * Waypoint prefix, fields 1-7 (§5.1).
 * @param {B} b
 * @param {{name?: string, cls?: number, lat?: number, lon?: number, comment?: string, icon?: number, display?: number}} [o]
 */
function prefix(b, o = {}) {
  return b
    .cstr(o.name ?? 'Spring')
    .u32(o.cls ?? 0)
    .pos(o.lat ?? 46.5, o.lon ?? 7.25)
    .cstr(o.comment ?? 'by the path')
    .fdouble(null)
    .u32(o.display ?? 1)
    .u32(o.icon ?? 0);
}

/**
 * H-KBM tail K8-K24 (§5.2).
 * @param {B} b
 * @param {any} [o]
 */
function kbmTail(b, o = {}) {
  for (const s of o.address ?? ['', '', '', '', '']) b.cstr(s);
  if (o.subclass) b.u8(1).raw(o.subclass);
  else b.u8(0, o.stop ?? 0);
  b.fdouble(o.alt ?? null).fdouble(o.depth ?? null).strings(o.links ?? []).fdouble(o.temp ?? null).fint(o.timeA ?? null);
  b.raw(o.opaque6 ?? [0, 0, 0, 0, 0, 0]);
  const phones = o.phones ?? [];
  b.u32(o.phoneCount ?? phones.length);
  for (const p of phones) b.cstr(p).u8(0);
  b.fint(o.timeB ?? null).raw(o.opaque3 ?? [0, 0, 0]).strings(o.categories ?? []);
  return b;
}

/**
 * H-OP tail O8-O18 (§5.2).
 * @param {B} b
 * @param {any} [o]
 */
function opTail(b, o = {}) {
  b.u32(o.colour ?? 0).u8(0, 0, 0).fdouble(o.alt ?? null).u8(0).strings(o.links ?? []).fdouble(null).fint(o.time ?? null).u8(0);
  if (o.thumb) b.u8(1).cstr('x').cstr(UUID).raw([0, 0, 0, 0, 0, 0, 0, 0]);
  else b.u8(0);
  return b;
}

// ---------------------------------------------------------------------------------------------
// Primitives

test('Cursor reads little-endian values and fails with a code, an offset and a field', () => {
  const bytes = new B().u8(7).u16(0x1234).u32(0xdeadbeef).i32(-5).f64(1.5).cstr('ab').bytes();
  const c = new Cursor(bytes);
  assert.equal(c.u8('a'), 7);
  assert.equal(c.u16('b'), 0x1234);
  assert.equal(c.u32('c'), 0xdeadbeef);
  assert.equal(c.i32('d'), -5);
  assert.equal(c.f64('e'), 1.5);
  assert.deepEqual(c.cstr('f'), [19, 21]);
  assert.equal(c.remaining, 0);
  assert.throws(() => c.u8('g'), (e) => e instanceof ParseStop && e.code === 'needs_more_bytes' && e.offset === 22 && e.field === 'g');
});

test('Cursor rules: flags, cstr end, counts, latitude, uuid', () => {
  assert.throws(() => new Cursor(Uint8Array.of(2)).flag('x'), (e) => e instanceof ParseStop && e.code === 'flag_not_0_or_1');
  assert.throws(() => new Cursor(Uint8Array.of(65, 66)).cstr('x'), (e) => e instanceof ParseStop && e.code === 'text_runs_past_end');
  // count × min size must fit before use: 3 strings need at least 3 bytes after the count
  assert.throws(() => new Cursor(new B().u32(3).u8(0, 0).bytes()).stringList('x'), (e) => e.code === 'count_too_large');
  assert.equal(new Cursor(new B().u32(2).u8(0, 0).bytes()).stringList('x'), 2);
  assert.throws(() => new Cursor(new B().i32(2 ** 30 + 1).bytes()).lat('x'), (e) => e.code === 'latitude_out_of_range');
  assert.equal(new Cursor(new B().i32(-(2 ** 30)).bytes()).lat('x'), -(2 ** 30));
  assert.equal(new Cursor(new B().cstr(UUID).bytes()).uuid('x'), UUID.toLowerCase());
  assert.throws(() => new Cursor(new B().cstr(UUID.replace('-', 'x')).bytes()).uuid('x'), (e) => e.code === 'uuid_shape');
  assert.throws(() => new Cursor(new B().cstr(UUID.replace('a', 'g')).bytes()).uuid('x'), (e) => e.code === 'uuid_shape');
  assert.throws(() => new Cursor(new B().cstr(UUID + 'a').bytes()).uuid('x'), (e) => e.code === 'uuid_shape');
  assert.deepEqual([new Cursor(Uint8Array.of(0)).fdouble('x'), new Cursor(Uint8Array.of(0)).fint('x')], [null, null]);
});

test('coordinates are v × 180 / 2^31 exactly', () => {
  for (const v of [0, 1, -1, 2 ** 30, -(2 ** 31), 2 ** 31 - 1, 123456789]) assert.equal(toDegrees(v), (v * 180) / 2 ** 31);
  assert.equal(toDegrees(-(2 ** 31)), -180);
});

test('absence rules: NaN, infinity, ≥ 1e24 and times ≤ 0 become null and are counted', () => {
  const counts = new Counts();
  assert.equal(altitudeValue(NaN, counts), null);
  assert.equal(altitudeValue(Infinity, counts), null);
  assert.equal(altitudeValue(1e24, counts), null);
  assert.equal(altitudeValue(-12.5, counts), -12.5);
  assert.equal(altitudeValue(null, counts), null);
  assert.equal(timeValue(0, counts), null);
  assert.equal(timeValue(-1, counts), null);
  assert.equal(timeValue(1, counts), 1000);
  assert.equal(counts.get('value_treated_as_absent'), 5);
});

test('text: strict UTF-8 first, then windows-1252, counted; raw keys keep the bytes', () => {
  const counts = new Counts();
  const utf8 = new TextEncoder().encode('Zürich Ålesund 山');
  assert.equal(decodeText(utf8, [0, utf8.length], counts), 'Zürich Ålesund 山');
  assert.equal(counts.get('text_not_utf8'), 0);
  const latin = Uint8Array.of(0x5a, 0xfc, 0x72, 0x80, 0x20, 0x96, 0x81);
  assert.equal(decodeText(latin, [0, latin.length], counts), 'Zür€ –\u0081');
  assert.equal(counts.get('text_not_utf8'), 1);
  const bom = Uint8Array.of(0xef, 0xbb, 0xbf, 0x41);
  assert.equal(decodeText(bom, [0, 4], counts), '﻿A');
  const surrogate = Uint8Array.of(0xed, 0xa0, 0x80); // an encoded surrogate is not UTF-8
  assert.equal(decodeText(surrogate, [0, 3], counts), 'í €');
  assert.equal(rawKey(latin, [0, 3]), 'Zür');
  const long = new Uint8Array(10000).fill(0x41);
  assert.equal(decodeText(long, [0, long.length], counts).length, 10000);
});

test('text: a long name that is not UTF-8 costs about its own size in memory (no rope of one-character strings)', () => {
  // Found by test/fuzz-pipeline.test.js: 168 list entries with 64 KB windows-1252 names (11 MB of FolderData.gfi) held
  // 380 MB of heap, because the fallback built each name one character at a time.
  setFlagsFromString('--expose-gc');
  const gc = /** @type {() => void} */ (runInNewContext('gc'));
  const bytes = new Uint8Array(65536).fill(0xe9); // é
  bytes[0] = 0x80; // €: windows-1252, and not UTF-8
  bytes[1] = 0x81; // unassigned in windows-1252: the C1 control
  gc();
  const before = process.memoryUsage().heapUsed;
  const counts = new Counts();
  /** @type {string[]} */
  const kept = [];
  for (let i = 0; i < 100; i++) kept.push(decodeText(bytes, [0, bytes.length], counts));
  gc();
  const grown = process.memoryUsage().heapUsed - before;
  const flat = 100 * bytes.length * 2; // two bytes per UTF-16 unit
  assert.ok(grown < 2 * flat + 8 * 2 ** 20, `${Math.round(grown / 2 ** 20)} MB of heap for ${Math.round(flat / 2 ** 20)} MB of text`);
  assert.equal(counts.get('text_not_utf8'), 100);
  assert.equal(kept[99].length, 65536);
  assert.equal(kept[99].slice(0, 4), '€\u0081éé');
  assert.equal(kept[99].at(-1), 'é');
});

// ---------------------------------------------------------------------------------------------
// Waypoints (§5)

test('waypoint: H-KBM with every optional field absent (the 33-byte zero tail)', () => {
  const body = kbmTail(prefix(new B(), { icon: 8 })).bytes();
  const w = parseWaypoint(body, new Counts());
  assert.equal(w.ok, true);
  assert.equal(w.layout, 'H-KBM');
  assert.equal(w.accepted, 1);
  assert.equal(w.name, 'Spring');
  assert.equal(w.comment, 'by the path');
  assert.equal(w.cls, 0);
  assert.equal(w.icon, 8);
  assert.equal(w.lat, toDegrees(semi(46.5)));
  assert.equal(w.lon, toDegrees(semi(7.25)));
  assert.equal(w.ele, null);
  assert.equal(w.time, null);
});

test('waypoint: H-KBM time is K22 when present, otherwise K18; altitude from K14', () => {
  const both = parseWaypoint(kbmTail(prefix(new B()), { alt: 1234.5, timeA: 1000, timeB: 2000 }).bytes(), new Counts());
  assert.deepEqual([both.layout, both.ele, both.time], ['H-KBM', 1234.5, 2000000]);
  const onlyA = parseWaypoint(kbmTail(prefix(new B()), { timeA: 1000 }).bytes(), new Counts());
  assert.equal(onlyA.time, 1000000);
  const onlyB = parseWaypoint(kbmTail(prefix(new B()), { timeB: 3000 }).bytes(), new Counts());
  assert.equal(onlyB.time, 3000000);
});

test('waypoint: H-KBM with address, subclass, links, phone, categories and non-zero opaque bytes', () => {
  const body = kbmTail(prefix(new B()), {
    address: ['1 Main St', 'Town', 'ST', 'Land', '12345'],
    subclass: new Uint8Array(24).fill(0xaa),
    depth: 3,
    links: ['http://a', 'b'],
    temp: 21,
    opaque6: [1, 2, 3, 4, 5, 6],
    phones: ['555-0100'],
    opaque3: [9, 9, 9],
    categories: ['one', 'two'],
    alt: 10,
  }).bytes();
  const w = parseWaypoint(body, new Counts());
  assert.equal(w.layout, 'H-KBM');
  assert.equal(w.ele, 10);
});

test('waypoint: H-KBM rejects a phone count of 2, a flag of 2, a bad K13 stop byte, and one byte short or long', () => {
  const cases = {
    phones2: kbmTail(prefix(new B()), { phoneCount: 2, phones: ['a', 'b'] }).bytes(),
    flag2: (() => {
      const at = prefix(new B()).bytes().length + 5 + 2; // K14 flag: after five empty cstrs and the two K13 bytes
      const body = kbmTail(prefix(new B()), { alt: 5 }).bytes();
      assert.equal(body[at], 1);
      body[at] = 2;
      return body;
    })(),
    stop2: kbmTail(prefix(new B()), { stop: 2 }).bytes(),
    short: kbmTail(prefix(new B())).bytes().subarray(0, -1),
    long: kbmTail(prefix(new B())).u8(0).bytes(),
  };
  for (const [name, body] of Object.entries(cases)) {
    const w = parseWaypoint(body, new Counts());
    assert.equal(w.ok, true, name);
    assert.equal(w.accepted, 0, name);
    assert.equal(w.layout, null, name);
    assert.equal(w.ele, null, name);
    assert.equal(w.name, 'Spring', `${name}: the agreed prefix is kept`);
  }
});

test('waypoint: H-OP is accepted on its own layout, with links and a thumbnail', () => {
  const plain = parseWaypoint(opTail(prefix(new B()), { alt: 99, time: 5 }).bytes(), new Counts());
  assert.deepEqual([plain.layout, plain.ele, plain.time], ['H-OP', 99, 5000]);
  const rich = parseWaypoint(opTail(prefix(new B()), { colour: 3, links: ['x'], thumb: true }).bytes(), new Counts());
  assert.equal(rich.layout, 'H-OP');
  // A non-zero Unknown byte fails H-OP.
  const bad = opTail(prefix(new B())).bytes();
  bad[bad.length - 17 + 4] = 1; // O9
  assert.equal(parseWaypoint(bad, new Counts()).accepted, 0);
});

test('waypoint: a broken prefix keeps the name when it can, never throws', () => {
  const lat = prefix(new B(), { lat: 0 }).bytes();
  new DataView(lat.buffer).setInt32(7 + 4, 2 ** 30 + 5, true); // latitude out of range
  const w = parseWaypoint(lat, new Counts());
  assert.equal(w.ok, false);
  assert.equal(w.name, 'Spring');
  assert.equal(w.prefixFailure?.code, 'latitude_out_of_range');
  const noName = parseWaypoint(Uint8Array.of(65, 66), new Counts());
  assert.deepEqual([noName.ok, noName.name], [false, null]);
  assert.equal(parseWaypoint(new Uint8Array(0), new Counts()).ok, false);
});

test('waypoint: impossible altitude and time are absent and counted; display above 4 is counted', () => {
  const counts = new Counts();
  const w = parseWaypoint(kbmTail(prefix(new B(), { display: 9 }), { alt: 1e25, timeB: -4 }).bytes(), counts);
  assert.deepEqual([w.layout, w.ele, w.time], ['H-KBM', null, null]);
  assert.equal(counts.get('value_treated_as_absent'), 2);
  assert.equal(counts.get('display_mode_unknown'), 1);
});

// ---------------------------------------------------------------------------------------------
// Tracks (§6)

/**
 * @typedef {{max?: [number, number], min?: [number, number], points: Array<[number, number]>, unknown?: number}} Seg
 * @param {{gaps?: boolean, name?: string, colour?: number, segments?: Seg[], max?: [number, number], min?: [number, number],
 *   total?: number, uuid?: string, gapBytes?: number[], display?: number, links?: string[]}} o
 */
function track(o) {
  const segs = o.segments ?? [];
  const all = segs.flatMap((s) => s.points);
  const bound = (/** @type {Array<[number, number]>} */ pts, /** @type {(a: number[]) => number} */ f) =>
    pts.length ? /** @type {[number, number]} */ ([f(pts.map((p) => p[0])), f(pts.map((p) => p[1]))]) : /** @type {[number, number]} */ ([0, 0]);
  const b = new B().cstr(o.name ?? 'Ridge').u8(o.display ?? 1);
  if (o.gaps !== false) b.raw(o.gapBytes ?? [0, 0, 0, 0]);
  b.u32(o.colour ?? 0).strings(o.links ?? []).cstr('notes').f64(0).fdouble(null).u8(0);
  const max = o.max ?? bound(all, (a) => Math.max(...a));
  const min = o.min ?? bound(all, (a) => Math.min(...a));
  b.pos(max[0], max[1]).pos(min[0], min[1]).fdouble(60).f64(1000).fint(1700000000);
  if (o.gaps !== false) b.raw(o.gapBytes ?? [0, 0, 0, 0]);
  b.u32(segs.length);
  for (const s of segs) {
    const smax = s.max ?? bound(s.points, (a) => Math.max(...a));
    const smin = s.min ?? bound(s.points, (a) => Math.min(...a));
    b.u8(s.unknown ?? 0).pos(smax[0], smax[1]).pos(smin[0], smin[1]).u32(s.points.length);
    for (const p of s.points) b.pos(p[0], p[1]);
  }
  b.u32(o.total ?? all.length).cstr(o.uuid ?? UUID);
  return b.bytes();
}

const P1 = /** @type {Array<[number, number]>} */ ([
  [46.1, 7.1],
  [46.2, 7.3],
  [46.15, 7.2],
]);

test('track: H-KBM decodes positions, colour, uuid and the total-count relation', () => {
  const t = parseTrack(track({ colour: 10, segments: [{ points: P1 }], gapBytes: [1, 2, 3, 4] }), new Counts());
  assert.equal(t.layout, 'H-KBM');
  assert.equal(t.accepted, 1);
  assert.equal(t.name, 'Ridge');
  assert.equal(t.colorIndex, 10);
  assert.equal(t.uuid, UUID.toLowerCase());
  assert.equal(t.totalCount, 'sum');
  assert.deepEqual([...(t.segmentStarts ?? [])], [0, 3]);
  const segs = materialiseSegments(/** @type {Int32Array} */ (t.positions), /** @type {Uint32Array} */ (t.segmentStarts), null, null);
  assert.deepEqual(segs[0][1], { lat: toDegrees(semi(46.2)), lon: toDegrees(semi(7.3)), ele: null, time: null });
});

test('track: H-OP (no gaps) is told apart from H-KBM', () => {
  const t = parseTrack(track({ gaps: false, segments: [{ points: P1 }] }), new Counts());
  assert.equal(t.layout, 'H-OP');
});

test('track: several segments, an empty segment, S = 0, loose bounds and a total that matches neither rule', () => {
  const t = parseTrack(
    track({
      segments: [{ points: P1 }, { points: [] }, { points: [[46.15, 7.2], [46.3, 7.4]] }],
      max: [47, 8],
      min: [45, 6],
      total: 99,
    }),
    new Counts(),
  );
  assert.equal(t.layout, 'H-KBM');
  assert.equal(t.emptySegments, 1);
  assert.equal(t.totalCount, 'neither');
  assert.deepEqual([...(t.segmentStarts ?? [])], [0, 3, 3, 5]);
  const overlap = parseTrack(track({ segments: [{ points: P1 }, { points: [[46.15, 7.2], [46.3, 7.4]] }], total: 4 }), new Counts());
  assert.equal(overlap.totalCount, 'sum_minus_overlaps');
  const none = parseTrack(track({ segments: [] }), new Counts());
  assert.deepEqual([none.layout, none.positions?.length, none.totalCount], ['H-KBM', 0, 'sum']);
});

test('track: the mandatory bounds checks reject a point outside its segment, a segment outside the track, min > max', () => {
  const cases = {
    pointOutside: track({ segments: [{ points: P1, max: [46.18, 7.3] }] }),
    segmentOutside: track({ segments: [{ points: P1 }], max: [46.2, 7.25] }),
    segmentMinAboveMax: track({ segments: [{ points: [[46.1, 7.1]], max: [46.0, 7.1], min: [46.1, 7.1] }], max: [47, 8], min: [45, 6] }),
    trackMinAboveMax: track({ segments: [], max: [1, 1], min: [2, 2] }),
    badUuid: track({ segments: [{ points: P1 }], uuid: 'not-a-uuid' }),
    badDisplay: track({ segments: [{ points: P1 }], display: 2 }),
    badSegmentByte: track({ segments: [{ points: P1, unknown: 2 }] }),
    latitudeOutOfRange: track({ segments: [{ points: [[91, 7]] }] }),
  };
  for (const [name, body] of Object.entries(cases)) {
    const t = parseTrack(body, new Counts());
    assert.equal(t.accepted, 0, name);
    assert.equal(t.positions, null, name);
    assert.equal(t.name, 'Ridge', `${name}: the name is kept`);
  }
});

test('track: an absurd segment or point count fails fast without allocating', () => {
  const body = track({ segments: [{ points: P1 }] });
  // Segment count S sits right after G2: overwrite it with 0x7fffffff.
  const sAt = body.length - (3 * 8 + 21) - 4 - 37 - 4;
  new DataView(body.buffer).setUint32(sAt, 0x7fffffff, true);
  const started = performance.now();
  const t = parseTrack(body, new Counts());
  assert.equal(t.accepted, 0);
  assert.ok(performance.now() - started < 2000, 'a generous bound: a loaded machine is slower');
});

test('track: a record one byte long or short is not decoded; a missing name keeps nothing', () => {
  const body = track({ segments: [{ points: P1 }] });
  assert.equal(parseTrack(body.subarray(0, -1), new Counts()).accepted, 0);
  const longer = new Uint8Array(body.length + 1);
  longer.set(body);
  assert.equal(parseTrack(longer, new Counts()).accepted, 0);
  assert.equal(parseTrack(Uint8Array.of(1, 2, 3), new Counts()).name, null);
});

test('colour names follow FORMAT.md §6.3; 0 and > 17 give none', () => {
  assert.equal(colorName(0), null);
  assert.equal(colorName(1), 'Black');
  assert.equal(colorName(8), 'LightGray');
  assert.equal(colorName(17), 'Transparent');
  assert.equal(colorName(18), null);
  assert.equal(colorName(null), null);
});

test('materialised segments carry elevation and time where present (NaN means absent)', () => {
  const positions = Int32Array.of(semi(1), semi(2), semi(3), semi(4));
  const segs = materialiseSegments(positions, Uint32Array.of(0, 1, 2), Float64Array.of(5, NaN), Float64Array.of(NaN, 7000));
  assert.deepEqual(segs, [
    [{ lat: toDegrees(semi(1)), lon: toDegrees(semi(2)), ele: 5, time: null }],
    [{ lat: toDegrees(semi(3)), lon: toDegrees(semi(4)), ele: null, time: 7000 }],
  ]);
});

// ---------------------------------------------------------------------------------------------
// Routes (§7)

/**
 * @param {B} b
 * @param {{name: string, cls?: number, links?: Array<[number, number]>, autoroute?: number, marker?: number[],
 *   unknown1?: string|null, endTime?: number|null}} p
 */
function routePoint(b, p) {
  b.cstr(p.name).u32(p.cls ?? 0);
  if (p.unknown1) b.u8(1).cstr(p.unknown1);
  else b.u8(0);
  b.u32(0).u32(0).u32(0).u16(0).u32(p.autoroute ? 1 : 0);
  const links = p.links ?? [];
  b.u32(links.length);
  for (const l of links) b.pos(l[0], l[1]);
  if (links.length) b.u8(0).pos(links[0][0], links[0][1]).pos(links[0][0], links[0][1]);
  else b.u8(1);
  b.raw(p.marker ?? [255, 255, 255, 255, 255, 255, 255, 255]).fint(null);
  if (p.endTime !== undefined && p.endTime !== null) b.fint(p.endTime).fdouble(30);
  else b.fint(null);
  b.u32(p.autoroute ?? 0);
  return b;
}

/**
 * @param {Array<Parameters<typeof routePoint>[1]>} points
 * @param {{junk?: boolean}} [o]
 */
function route(points, o = {}) {
  const b = new B().cstr('Up and back').u8(0).u32(points.length);
  for (const p of points) {
    routePoint(b, p);
    if (p.autoroute && o.junk) {
      b.raw([1, 2, 3, 4, 5, 6, 7]);
      return b.bytes();
    }
  }
  b.u8(0, 0, 0).u8(1); // Unknown1, no bounds
  b.u32(0).u32(0).u8(0).cstr('').u8(0).u32(0).u8(1).u8(0).u32(0); // trailer (§7.3), not parsed
  return b.bytes();
}

test('route: via points from link points and by name, unknown fstring and end time with duration', () => {
  const r = parseRoute(
    route([
      { name: 'Start', links: [[46.4, 9.6], [46.41, 9.61]], unknown1: 'u', endTime: 1700000000 },
      { name: 'Hut', cls: 1 },
    ]),
    new Counts(),
  );
  assert.equal(r.status, 'ok');
  assert.equal(r.name, 'Up and back');
  assert.equal(r.points.length, 2);
  assert.deepEqual([r.points[0].lat, r.points[0].lon], [toDegrees(semi(46.4)), toDegrees(semi(9.6))]);
  assert.deepEqual([r.points[1].name, r.points[1].cls, r.points[1].lat], ['Hut', 1, null]);
});

test('route: autoroute stops cleanly; a bad marker or a truncation is not decoded', () => {
  assert.equal(parseRoute(route([{ name: 'A', links: [[1, 1]] }, { name: 'B', links: [[2, 2]], autoroute: 3 }], { junk: true }), new Counts()).status, 'autoroute');
  assert.equal(parseRoute(route([{ name: 'A', links: [[1, 1]], marker: [255, 255, 255, 0, 255, 255, 255, 255] }]), new Counts()).status, 'not_decoded');
  const body = route([{ name: 'A', links: [[1, 1]] }]);
  assert.equal(parseRoute(body.subarray(0, 30), new Counts()).status, 'not_decoded');
  // An absurd point count is refused before the loop.
  const absurd = new B().cstr('R').u8(0).u32(0x7fffffff).bytes();
  assert.equal(parseRoute(absurd, new Counts()).status, 'not_decoded');
  assert.equal(parseRoute(new Uint8Array(0), new Counts()).name, null);
});

// ---------------------------------------------------------------------------------------------
// H-MAC48 (FORMAT.md §15.11): Mac BaseCamp 4.8.13's layouts

test('waypoint: H-MAC48 is the H-KBM tail plus 8 opaque bytes; time B wins; one byte short or long is prefix only', () => {
  const tail = { alt: 12.5, timeA: 1791373216, timeB: 981173106, phones: ['555-0199'], address: ['1 St', 'Town', 'ST', 'Land', 'X1'] };
  const body = kbmTail(prefix(new B(), { cls: 0, icon: 141 }), tail).raw([0, 0, 0, 0, 0, 0, 0, 0]).bytes();
  const w = parseWaypoint(body, new Counts());
  assert.deepEqual([w.ok, w.layout, w.accepted, w.ele, w.time, w.icon], [true, 'H-MAC48', 1, 12.5, 981173106000, 141]);
  const opaque = kbmTail(prefix(new B()), tail).raw([1, 2, 3, 4, 5, 6, 7, 8]).bytes();
  assert.equal(parseWaypoint(opaque, new Counts()).layout, 'H-MAC48', 'the 8 bytes are never checked');
  assert.equal(parseWaypoint(kbmTail(prefix(new B()), tail).bytes(), new Counts()).layout, 'H-KBM', 'without them: H-KBM');
  for (const cut of [body.subarray(0, body.length - 1), Uint8Array.of(...body, 0)]) {
    const r = parseWaypoint(cut, new Counts());
    assert.deepEqual([r.ok, r.layout, r.accepted, r.ele, r.time], [true, null, 0, null, null]);
  }
  const twoPhones = kbmTail(prefix(new B()), { phones: ['1', '2'] }).raw([0, 0, 0, 0, 0, 0, 0, 0]).bytes();
  assert.equal(parseWaypoint(twoPhones, new Counts()).accepted, 0, 'phone count above 1 fails H-MAC48 as it fails H-KBM');
});

/**
 * The Mac 4.8 track tail (§15.4 rows 19-23).
 * @param {{flags?: number[], a?: number|null, b?: number|null, opaque?: number[]}} [o]
 */
function mac48Tail(o = {}) {
  const b = new B().raw(o.opaque ?? [0, 0, 0]).raw(o.flags ?? [1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  return b.fdouble(o.a === undefined ? 4.25 : o.a).fdouble(o.b === undefined ? 0 : o.b).raw([0, 0, 0, 0, 0, 0, 0, 0]).bytes();
}

test('track: H-MAC48 is H-KBM through the uuid plus the 40- or 24-byte tail; a flag above 1 fails it', () => {
  const kbm = track({ segments: [{ points: P1 }], gapBytes: [0, 0, 0, 1] });
  const with40 = Uint8Array.of(...kbm, ...mac48Tail());
  assert.equal(with40.length - kbm.length, 40);
  const t = parseTrack(with40, new Counts());
  assert.deepEqual([t.layout, t.accepted, t.uuid, t.totalCount], ['H-MAC48', 1, UUID.toLowerCase(), 'sum']);
  assert.equal(t.positions?.length, 6);
  const with24 = Uint8Array.of(...kbm, ...mac48Tail({ flags: new Array(11).fill(0), a: null, b: null, opaque: [9, 9, 9] }));
  assert.equal(with24.length - kbm.length, 24);
  assert.equal(parseTrack(with24, new Counts()).layout, 'H-MAC48');
  const badFlag = Uint8Array.of(...kbm, ...mac48Tail({ flags: [1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0] }));
  assert.deepEqual([parseTrack(badFlag, new Counts()).layout, parseTrack(badFlag, new Counts()).accepted], [null, 0]);
  assert.equal(parseTrack(with40.subarray(0, with40.length - 1), new Counts()).accepted, 0);
});

/**
 * A Mac 4.8 route (§15.5): link points [this, next] on every via point but the last.
 * @param {Array<[string, number, number]>} via  name, lat, lon
 * @param {{run?: number[], settings?: number, links?: boolean}} [o]
 */
function mac48Route(via, o = {}) {
  const b = new B().cstr('Loop').u8(0).u32(via.length);
  via.forEach(([name, lat, lon], i) => {
    b.cstr(name).u32(8).u8(0).u32(3).u32(0xffffffff).u32(0).u16(0).u32(0);
    const next = via[i + 1];
    if (next && o.links !== false) {
      b.u32(2).pos(lat, lon).pos(next[1], next[2]).u8(0).pos(Math.max(lat, next[1]), Math.max(lon, next[2])).pos(Math.min(lat, next[1]), Math.min(lon, next[2]));
    } else b.u32(0).u8(1);
    b.raw([255, 255, 255, 255, 255, 255, 255, 255]).raw(i === 0 && o.run ? o.run : new Array(19).fill(0));
  });
  b.u8(0).pos(via.at(-1)?.[1] ?? 0, via.at(-1)?.[2] ?? 0).pos(via[0][1], via[0][2]);
  b.u32(0).u32(14).u8(o.settings ?? 0).cstr('').u8(0).u32(0).u8(1).u8(0).u32(6).raw([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  return b.bytes();
}

test('route: H-MAC48 reads to the end; the last via point has no position of its own; H-OP fails on it', () => {
  const body = mac48Route([['One', 20.1, 50.4], ['Two', 20.11, 50.42], ['Three', 20.12, 50.44]]);
  const r = parseRoute(body, new Counts());
  assert.deepEqual([r.status, r.layout, r.accepted], ['ok', 'H-MAC48', 1]);
  assert.deepEqual(r.points.map((p) => [p.name, p.cls, p.lat, p.lon]), [
    ['One', 8, toDegrees(semi(20.1)), toDegrees(semi(50.4))],
    ['Two', 8, toDegrees(semi(20.11)), toDegrees(semi(50.42))],
    ['Three', 8, null, null],
  ]);
  // The trailer is consumed exactly: one byte more or less is not decoded.
  assert.equal(parseRoute(Uint8Array.of(...body, 0), new Counts()).status, 'not_decoded');
  assert.equal(parseRoute(body.subarray(0, body.length - 1), new Counts()).status, 'not_decoded');
});

test('route: H-MAC48 fails on a non-zero byte in the 19-byte run or an autoroute-settings flag of 1', () => {
  const via = /** @type {Array<[string, number, number]>} */ ([['One', 20.1, 50.4], ['Two', 20.11, 50.42]]);
  const run = new Array(19).fill(0);
  run[12] = 1;
  for (const body of [mac48Route(via, { run }), mac48Route(via, { settings: 1 })]) {
    const r = parseRoute(body, new Counts());
    assert.deepEqual([r.status, r.layout, r.points.length], ['not_decoded', null, 0]);
  }
});

test('route: a Mac 4.8 route of one via point also decodes under H-OP, so it matches both and is not converted (FORMAT.md §15.11)', () => {
  const counts = new Counts();
  const r = parseRoute(mac48Route([['Only', 20.1, 50.4]]), counts);
  assert.deepEqual([r.status, r.layout, r.accepted], ['not_decoded', null, 2]);
  assert.equal(counts.get('route_several_layouts'), 1);
  // Two via points: H-OP falls out of step on the second, and only H-MAC48 decodes.
  assert.equal(parseRoute(mac48Route([['One', 20.1, 50.4], ['Two', 20.11, 50.42]]), new Counts()).layout, 'H-MAC48');
});

test('route: the program version breaks the one-via-point tie (B43): 408 takes H-MAC48, 407 H-OP, and both read the same point', () => {
  const body = mac48Route([['Only', 20.1, 50.4]]);
  const counts = new Counts();
  const mac = parseRoute(body, counts, 408);
  assert.deepEqual([mac.status, mac.layout, mac.accepted, mac.decision], ['ok', 'H-MAC48', 2, 'program_version']);
  assert.equal(counts.get('route_layout_by_program_version'), 1);
  assert.equal(counts.get('route_several_layouts'), 0);
  const older = parseRoute(body, new Counts(), 407);
  assert.deepEqual([older.status, older.layout, older.decision], ['ok', 'H-OP', 'program_version']);
  assert.deepEqual(older.points, mac.points);
  assert.deepEqual(mac.points.map((p) => [p.name, p.cls, p.lat]), [['Only', 8, null]]);
  for (const v of [null, 480]) assert.deepEqual([parseRoute(body, new Counts(), v).status, parseRoute(body, new Counts(), v).decision], ['not_decoded', 'several']);
  // An OP route that H-MAC48 does not fit: read in an older file, refused in a Mac 4.8 file.
  const op = route([{ name: 'Start', links: [[46.4, 9.6], [46.41, 9.61]] }, { name: 'Hut', cls: 1 }]);
  assert.deepEqual([parseRoute(op, new Counts(), 407).status, parseRoute(op, new Counts(), 407).layout], ['ok', 'H-OP']);
  const refusedCounts = new Counts();
  const refused = parseRoute(op, refusedCounts, 408);
  assert.deepEqual([refused.status, refused.layout, refused.accepted, refused.decision, refused.points], ['not_decoded', null, 1, 'not_for_version', []]);
  assert.equal(refusedCounts.get('route_op_only_in_mac48_file'), 1);
  // An autorouted OP route is still "road-following" in a Mac 4.8 file: H-OP stopped at A > 0, it did not decode it.
  const auto = route([{ name: 'A', links: [[1, 1]] }, { name: 'B', links: [[2, 2]], autoroute: 3 }], { junk: true });
  assert.equal(parseRoute(auto, new Counts(), 408).status, 'autoroute');
});

test('waypoint and track: decision and layout are reported; without a tie the program version changes nothing (B43)', () => {
  const tail = { alt: 12.5, timeA: 1791373216, timeB: 981173106 };
  const body = kbmTail(prefix(new B()), tail).raw([0, 0, 0, 0, 0, 0, 0, 0]).bytes();
  for (const v of [null, 407, 408, 480]) {
    const w = parseWaypoint(body, new Counts(), v);
    assert.deepEqual([w.layout, w.accepted, w.decision, w.ele], ['H-MAC48', 1, 'only_fit', 12.5], `version ${v}`);
  }
  assert.equal(parseWaypoint(body.subarray(0, body.length - 1), new Counts(), 408).decision, 'none');
  const kbm = track({ segments: [{ points: P1 }], gapBytes: [0, 0, 0, 1] });
  const t = parseTrack(Uint8Array.of(...kbm, ...mac48Tail()), new Counts(), 408);
  assert.deepEqual([t.layout, t.accepted, t.decision], ['H-MAC48', 1, 'only_fit']);
  assert.deepEqual([parseTrack(kbm, new Counts(), 408).layout, parseTrack(kbm, new Counts(), 408).decision], ['H-KBM', 'only_fit']);
});
