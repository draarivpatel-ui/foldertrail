// Tests for src/format/dump.js. Every library here is synthetic, built byte by byte from FORMAT.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { readContainer, PROBLEM_CODES } from '../src/format/container.js';
import { buildDump, classifyLibraryPath, DEFAULT_LAYOUTS, DUMP_FORMAT, DUMP_VERSION } from '../src/format/dump.js';

// ---------------------------------------------------------------------------------------------
// Byte builders (test-only, written from FORMAT.md)

class Bytes {
  constructor() {
    /** @type {number[]} */
    this.out = [];
  }
  u8(v) {
    this.out.push(v & 0xff);
    return this;
  }
  u16(v) {
    this.out.push(v & 0xff, (v >>> 8) & 0xff);
    return this;
  }
  u32(v) {
    this.out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  i32(v) {
    return this.u32(v >>> 0);
  }
  f64(v) {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, v, true);
    for (let i = 0; i < 8; i++) this.out.push(dv.getUint8(i));
    return this;
  }
  ascii(s) {
    for (const ch of s) this.out.push(ch.charCodeAt(0));
    return this;
  }
  cstr(s) {
    for (const b of new TextEncoder().encode(s)) this.out.push(b);
    this.out.push(0);
    return this;
  }
  raw(bytes) {
    for (const b of bytes) this.out.push(b);
    return this;
  }
  /** fdouble: flag, then an f64 if present */
  fdouble(v) {
    return v === undefined || v === null ? this.u8(0) : this.u8(1).f64(v);
  }
  /** fint: flag, then an i32 if present */
  fint(v) {
    return v === undefined || v === null ? this.u8(0) : this.u8(1).i32(v);
  }
  strings(list = []) {
    this.u32(list.length);
    for (const s of list) this.cstr(s);
    return this;
  }
  build() {
    return Uint8Array.from(this.out);
  }
}

const semi = (deg) => Math.round((deg * 2 ** 31) / 180);

function header(o = {}) {
  const { sig = 'MsRc', primary = 0x66, version = 188, program = 407, builder = 'bcr-fixture', date = 'Jan 01 2026', time = '00:00:00', app = 'BaseCamp' } = o;
  const authorBody = new Bytes().u16(program).cstr(builder).cstr(date).cstr(time).build();
  return new Bytes().ascii(sig).u16(primary).u32(2).ascii('D').u16(version).u32(authorBody.length).ascii('A').raw(authorBody).cstr(app).build();
}

function rec(type, body) {
  return new Bytes().u32(body.length).ascii(type).raw(body).build();
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The agreed waypoint prefix, FORMAT.md §5.1. */
function waypointPrefix(b, o) {
  return b
    .cstr(o.name ?? 'wpt')
    .u32(o.cls ?? 0)
    .i32(semi(o.lat ?? 10))
    .i32(semi(o.lon ?? 20))
    .cstr(o.comment ?? '')
    .fdouble(o.proximity)
    .u32(o.display ?? 1)
    .u32(o.icon ?? 0);
}

/** H-KBM waypoint (FORMAT.md §5.2), the supported path. */
function waypointKbm(o = {}) {
  const b = waypointPrefix(new Bytes(), o);
  const a = o.address ?? ['', '', '', '', ''];
  for (const s of a) b.cstr(s);
  if (o.subclass) b.u8(1).raw(o.subclass);
  else b.u8(0).u8(o.k13second ?? 0);
  b.fdouble(o.altitude).fdouble(o.depth).strings(o.links).fdouble(o.temperature).fint(o.timeA).raw(o.k19 ?? [0, 0, 0, 0, 0, 0]);
  if (o.phone !== undefined) b.u32(1).cstr(o.phone).u8(0);
  else b.u32(o.phoneCount ?? 0);
  b.fint(o.timeB).raw(o.k23 ?? [0, 0, 0]).strings(o.categories);
  return b.build();
}

/** H-OP waypoint (FORMAT.md §5.2): documented hypothesis, not supported-path coverage. */
function waypointOp(o = {}) {
  const b = waypointPrefix(new Bytes(), o);
  b.u32(o.colour ?? 0).u8(0).u8(0).u8(0).fdouble(o.altitude).u8(0).strings(o.links).fdouble(o.temperature).fint(o.time).u8(0);
  if (o.thumbnail) b.u8(1).cstr(o.thumbnail.origin).ascii(o.thumbnail.uuid).u8(0).raw(new Uint8Array(8));
  else b.u8(0);
  return b.build();
}

/**
 * GDB 'T' (FORMAT.md §6). segments: arrays of [lat, lon] in degrees.
 * @param {object} o
 * @param {boolean} kbm
 */
function track(o = {}, kbm = true) {
  const segments = o.segments ?? [[[10, 20], [10.001, 20.001]]];
  const all = segments.flat();
  const box = (pts) => {
    const lats = pts.map((p) => semi(p[0]));
    const lons = pts.map((p) => semi(p[1]));
    return { maxLat: Math.max(...lats), maxLon: Math.max(...lons), minLat: Math.min(...lats), minLon: Math.min(...lons) };
  };
  const tb = o.trackBox ?? (all.length ? box(all) : { maxLat: 0, maxLon: 0, minLat: 0, minLon: 0 });
  const b = new Bytes().cstr(o.name ?? 'trk').u8(o.display ?? 1);
  if (kbm) b.raw(o.g1 ?? [0, 0, 0, 0]);
  b.u32(o.colour ?? 0).strings(o.links).cstr(o.notes ?? '').f64(o.area ?? 0).fdouble(o.unknown2).u8(0);
  b.i32(tb.maxLat).i32(tb.maxLon).i32(tb.minLat).i32(tb.minLon).fdouble(o.duration).f64(o.length ?? 0).fint(o.start);
  if (kbm) b.raw(o.g2 ?? [0, 0, 0, 0]);
  b.u32(segments.length);
  segments.forEach((seg, i) => {
    const sb = o.segmentBoxes?.[i] ?? (seg.length ? box(seg) : { maxLat: 0, maxLon: 0, minLat: 0, minLon: 0 });
    b.u8(0).i32(sb.maxLat).i32(sb.maxLon).i32(sb.minLat).i32(sb.minLon).u32(seg.length);
    for (const [lat, lon] of seg) b.i32(semi(lat)).i32(semi(lon));
  });
  b.u32(o.total ?? all.length).ascii(o.uuid ?? '00000000-0000-4000-8000-000000000000').u8(0);
  return b.build();
}

/** GDB 'R' under OP's ≥ 1.46 layout (FORMAT.md §7), with the plain trailer of §12. */
function route(o = {}) {
  const points = o.points ?? [{ name: 'a', links: [[10, 20]] }, { name: 'b', links: [[10.1, 20.1]] }];
  const b = new Bytes().cstr(o.name ?? 'rte').u8(0).u32(points.length);
  for (const p of points) {
    b.cstr(p.name).u32(p.cls ?? 0).u8(0).u32(0).u32(0).u32(0).u16(0).u32(0).u32(p.links.length);
    for (const [lat, lon] of p.links) b.i32(semi(lat)).i32(semi(lon));
    b.u8(1); // omit the point's bounding box
    b.raw(p.unknown7 ?? new Uint8Array(8).fill(0xff));
    b.u8(0).u8(0); // Unknown11 and end time absent (so no duration)
    b.u32(p.auto ?? 0);
    if (p.auto) b.raw(p.junk ?? [1, 2, 3]);
  }
  b.raw([0, 0, 0]).u8(0).i32(semi(10.1)).i32(semi(20.1)).i32(semi(10)).i32(semi(20));
  b.strings([]).u32(0).u8(o.autorouteSettings ? 1 : 0);
  if (o.autorouteSettings) b.raw([0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
  b.cstr(o.notes ?? '').u8(0).u32(0).u8(1).u8(0).u32(0);
  return b.build();
}

const V_BODY = Uint8Array.from([0x00, 0x01]);
const E_BODY = Uint8Array.from([0, 0, 0, 0]);
const X_BODY = new Bytes().cstr('EndOfFile').build();

function folderRec(id, name, parent, children = []) {
  const b = new Bytes().u32(id).cstr(name).u32(parent).u32(children.length);
  for (const [type, cid] of children) b.u32(type).u32(cid);
  return rec('F', b.u8(1).build());
}
function listRec(id, name, createdBy, parent) {
  const b = new Bytes().u32(id).cstr(name).u32(createdBy).u32(parent);
  if (createdBy !== 0) b.u8(1).u32(1).u32(9);
  return rec('I', b.build());
}
const tRef = (parent, name) => rec('T', new Bytes().u32(parent).cstr(name).u32(0).build());
const wRef = (parent, name, cls = 0) => rec('W', new Bytes().u32(parent).cstr(name).u32(cls).build());
const rRef = (parent, name) => rec('R', new Bytes().u32(parent).cstr(name).u8(1).build());
const kRef = (parent, name) => rec('K', new Bytes().u32(parent).cstr(name).build());

/** TrackSegments file (FORMAT.md §9): header, bare u32 M, M points of fdouble, fint, width - 2 extra bytes. */
function trackSegments(points, width = 17, o = {}) {
  const b = new Bytes().raw(header({ sig: o.sig ?? 'MsRc', program: o.program ?? 407, builder: o.builder, date: o.date, time: o.time, app: o.app })).u32(o.m ?? points.length);
  for (const p of points) {
    b.fdouble(p.ele).fint(p.time);
    const extra = new Uint8Array(width - 2);
    if (p.extra) extra.set(p.extra);
    b.raw(extra);
  }
  if (o.trailing) b.raw(o.trailing);
  return b.build();
}

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A small synthetic library on the supported path (H-KBM), with a tree and TrackSegments. */
function library(o = {}) {
  const gdb = concat(
    header(o.gdbHeader),
    rec('W', waypointKbm({ name: 'w1', altitude: 12.5, timeA: 1000, timeB: 2000, links: ['l'], categories: ['c'], phone: '1', address: ['s', 'c', 'st', 'co', 'p'] })),
    rec('W', waypointKbm({ name: 'w2' })),
    rec('W', waypointKbm({ name: 'w3', cls: 1, subclass: new Uint8Array(24).fill(5), k19: [1, 0, 0, 0, 0, 0] })),
    rec('R', route()),
    rec('T', track({ name: 't1', segments: [[[10, 20], [10.01, 20.01]], [[10.01, 20.01], [10.02, 20.0]]], total: 3, uuid: 'aaaaaaaa-0000-4000-8000-000000000001' })),
    rec('T', track({ name: 't2', segments: [[[11, 21], [11.5, 21.5], [11.2, 21.9]]], uuid: 'aaaaaaaa-0000-4000-8000-000000000002' })),
    rec('V', V_BODY),
    rec('E', E_BODY),
    rec('X', X_BODY),
  );
  const gfi = concat(
    header({ sig: 'DifG' }),
    folderRec(0xffffffff, 'My Collection', 0xffffffff, [[1, 0], [0, 0]]),
    folderRec(0, 'f0', 0xffffffff, [[1, 1]]),
    folderRec(1, 'f1', 0, [[0, 1]]),
    listRec(0, 'list0', 0, 0xffffffff),
    listRec(1, 'list1', 8, 1),
    rRef(0, 'rte'),
    tRef(1, 't1'),
    tRef(1, 't2'),
    wRef(0, 'w1'),
    wRef(1, 'w1'),
    wRef(1, 'w3', 1),
    kRef(77, 'bird'),
  );
  const ts = [
    trackSegments([{ ele: 100, time: 5000 }, { ele: 101 }, { time: 5002 }]),
    trackSegments([{ ele: 1 }, { ele: 2 }, { ele: 3 }]),
    trackSegments([{ ele: 1, time: 1 }, {}], 11),
  ];
  return { gdb, gfi, ts };
}

function dumpOf(lib, extra = {}) {
  return buildDump({
    toolVersion: '0.1.0',
    engine: 'Node',
    engineMajor: 22,
    inputKind: 'folder',
    allData: lib.gdb ? readContainer(lib.gdb, { role: 'gdb' }) : null,
    folderData: lib.gfi ? readContainer(lib.gfi, { role: 'gfi' }) : null,
    trackSegments: lib.ts ?? null,
    otherFiles: { count: 2, bytes: 300 },
    ...extra,
  });
}

/** One GDB holding only the given records (plus the usual V, E, X). */
function gdbWith(...records) {
  return { gdb: concat(header(), ...records, rec('V', V_BODY), rec('E', E_BODY), rec('X', X_BODY)) };
}

// ---------------------------------------------------------------------------------------------
// Shape and correctness on the supported path

test('a supported-path library: every record fits exactly one layout', () => {
  const { data } = dumpOf(library());
  assert.equal(data.format, DUMP_FORMAT);
  assert.equal(data.version, DUMP_VERSION);
  assert.deepEqual(data.environment, { engine: 'Node', engineMajor: 22 });
  assert.deepEqual(data.input, { kind: 'folder', otherFiles: 2, otherFileBytes: 300 });

  const gdb = data.files['AllData.gdb'];
  assert.equal(gdb.present, true);
  assert.equal(gdb.signature, 'MsRc');
  assert.equal(gdb.containerFormat, 0x66);
  assert.equal(gdb.fileFormat, 188);
  assert.equal(gdb.fileFormatClass, 'supported');
  assert.equal(gdb.programVersion, 407);
  assert.equal(gdb.application, 'BaseCamp');
  assert.equal(gdb.readToEnd, true);
  assert.deepEqual(gdb.endRecord, { present: true, bytesAfter: 0 });
  assert.equal(gdb.orderViolations, 0);
  assert.deepEqual(gdb.problems, []);
  assert.deepEqual(Object.keys(gdb.recordTypes), ['E', 'R', 'T', 'V', 'W', 'X']);

  const w = gdb.recordTypes.W;
  assert.equal(w.count, 3);
  assert.equal(w.layouts['H-KBM'].accepted, 3);
  assert.equal(w.layouts['H-OP'].accepted, 0);
  assert.equal(w.layouts['H-MAC48'].accepted, 0);
  assert.deepEqual(w.verdict, { matchedOnlyOne: { 'H-KBM': 3, 'H-OP': 0, 'H-MAC48': 0 }, matchedNone: 0, matchedMoreThanOne: 0 });
  assert.deepEqual(w.waypointClass, { 0: 2, 1: 1 });
  assert.deepEqual(w.layouts['H-KBM'].amongAccepted, {
    address: 1, altitude: 1, categories: 1, links: 1, nonzero_K13: 1, nonzero_K19: 1, phone: 1, subclass_block: 1, time_K18: 1, time_K22: 1,
  });

  const t = gdb.recordTypes.T;
  assert.equal(t.layouts['H-KBM'].accepted, 2);
  assert.equal(t.layouts['H-OP'].accepted, 0);
  assert.equal(t.layouts['H-MAC48'].accepted, 0);
  assert.deepEqual(t.verdict.matchedOnlyOne, { 'H-KBM': 2, 'H-OP': 0, 'H-MAC48': 0 });
  assert.deepEqual(t.layouts['H-KBM'].amongAccepted, {
    segment_ends_shared: 1, total_equals_points: 1, total_equals_points_minus_joins: 1, track_bounds_tight: 2,
  });

  for (const type of ['V', 'E', 'X']) {
    const layouts = Object.values(gdb.recordTypes[type].layouts);
    assert.equal(layouts.length, 1);
    assert.equal(layouts[0].accepted, gdb.recordTypes[type].count, type);
    assert.equal(gdb.recordTypes[type].verdict, undefined);
  }
  // R: OP's layout and Mac 4.8's; this library is written in OP's.
  const r = gdb.recordTypes.R;
  assert.deepEqual(Object.keys(r.layouts), ['H-OP', 'H-MAC48']);
  assert.equal(r.layouts['H-OP'].accepted, r.count);
  assert.deepEqual(r.verdict, { matchedOnlyOne: { 'H-OP': r.count, 'H-MAC48': 0 }, matchedNone: 0, matchedMoreThanOne: 0 });

  const gfi = data.files['FolderData.gfi'];
  assert.equal(gfi.signature, 'DifG');
  assert.equal(gfi.endRecord.present, false);
  assert.equal(gfi.readToEnd, true);
  for (const [type, s] of Object.entries(gfi.recordTypes)) {
    assert.equal(Object.values(s.layouts)[0].accepted, s.count, type);
  }
  assert.deepEqual(gfi.recordTypes.I.layouts['FORMAT.md §8.2'].amongAccepted, { created_by_0: 1, created_by_8: 1 });
  assert.deepEqual(gfi.recordTypes.W.layouts['FORMAT.md §8.3'].amongAccepted, { class_0: 2, class_1: 1 });
  assert.deepEqual(gfi.tree, {
    folders: 3,
    lists: 2,
    duplicateFolderIds: 0,
    duplicateListIds: 0,
    root: 'standard',
    childReferences: { list: 2, folder: 2, other: 0 },
    childReferencesNotFound: 0,
    foldersReachedFromRoot: 3,
    foldersNotReached: 0,
    foldersListedTwice: 0,
    listsListedTwice: 0,
    deepestFolder: 2,
    depthLimitReached: false,
    listsNotInAnyFolder: 0,
    listsWhoseParentDisagrees: 0,
    references: { K: 1, R: 1, T: 2, W: 3 },
    referencesToUnknownList: 1,
    itemsPerList: { '2-3': 1, '4-7': 1 }, // list0: a route and a waypoint; list1: two tracks and two waypoints
  });

  const ts = data.files.TrackSegments;
  assert.equal(ts.files, 3);
  assert.equal(ts.filesRead, 3);
  assert.deepEqual(ts.signatures, { MsRc: 3 });
  assert.deepEqual(ts.fileFormats, { 188: 3 });
  assert.deepEqual(ts.verdict, { only17: 2, only11: 1, both: 0, neither: 0 });
  assert.deepEqual(ts.decidedFiles, { points: 8, withElevation: 6, withTime: 3 });
  assert.deepEqual(ts.pointsPerFile, { min: 2, median: 3, max: 3 });
});

test('the JSON is the data object, and the output is deterministic', () => {
  const a = dumpOf(library());
  const b = dumpOf(library());
  assert.equal(a.json, b.json);
  assert.equal(a.text, b.text);
  assert.deepEqual(JSON.parse(a.json), a.data);
});

test('the text report is plain words with the key facts', () => {
  const { text } = dumpOf(library());
  assert.match(text, /^BCR library structure report/);
  assert.match(text, /It contains no names, notes, places, coordinates, times, IDs or file paths\./);
  assert.match(text, /- AllData\.gdb: [\d,]+ bytes/);
  assert.match(text, /- TrackSegments folder: 3 files/);
  assert.match(text, /- Other files: 2, 300 bytes \(not read\)/);
  assert.match(text, /Signature: MsRc \(as expected\)/);
  assert.match(text, /File format: 188 \(the supported version\)\. Program version: 407\. Made by: BaseCamp\./);
  assert.match(text, /Record type W \(waypoint\): 3 records/);
  assert.match(text, /Layout H-KBM: 3 fit exactly and passed every check\./);
  assert.match(text, /Layout H-OP: 0 fit exactly and passed every check; 1 with bytes left over; 2 stopped early\.\n    Bytes left over: 16 bytes in 1 record\n/);
  assert.match(text, /Among accepted records: .*point total equals the points stored minus one per segment join: 1/);
  assert.match(text, /Result: 3 only H-KBM, 0 only H-OP, 0 only H-MAC48, 0 matched none, 0 matched more than one\./);
  assert.match(text, /Top folder: found \(the usual one\)\. Deepest folder level: 2\./);
  assert.match(text, /Result: 2 only 17, 1 only 11, 0 both, 0 neither\./);
  assert.match(text, /End of report\.\n$/);
});

test('H-OP waypoints and tracks are told apart from H-KBM (documented hypothesis, not coverage)', () => {
  const lib = gdbWith(
    rec('W', waypointOp({ name: 'o1' })),
    rec('W', waypointOp({ name: 'o2', colour: 3, altitude: 5, time: 77, links: ['x'] })),
    rec('W', waypointOp({ name: 'o3', thumbnail: { origin: 'cam', uuid: '12345678-abcd-4abc-8abc-1234567890ab' } })),
    rec('T', track({ name: 'ot' }, false)),
    rec('T', track({ name: 'ot2', segments: [[[1, 2]], [[1, 2], [1.5, 2.5]]], total: 2 }, false)),
  );
  const { data } = dumpOf(lib);
  const w = data.files['AllData.gdb'].recordTypes.W;
  assert.deepEqual(w.verdict.matchedOnlyOne, { 'H-KBM': 0, 'H-OP': 3, 'H-MAC48': 0 });
  assert.deepEqual(w.layouts['H-OP'].amongAccepted, { altitude: 1, colour: 1, links: 1, thumbnail: 1, time_O16: 1 });
  const t = data.files['AllData.gdb'].recordTypes.T;
  assert.deepEqual(t.verdict.matchedOnlyOne, { 'H-KBM': 0, 'H-OP': 2, 'H-MAC48': 0 });
  assert.equal(t.layouts['H-OP'].amongAccepted.total_equals_points_minus_joins, 1);
  assert.equal(t.layouts['H-OP'].amongAccepted.segment_ends_shared, 1);
});

test('a record one byte short or one byte long is reported as exactly that', () => {
  const full = waypointKbm({ name: 'x' });
  const { data } = dumpOf(gdbWith(rec('W', full.subarray(0, full.length - 1)), rec('W', concat(full, Uint8Array.of(0)))));
  const kbm = data.files['AllData.gdb'].recordTypes.W.layouts['H-KBM'];
  assert.equal(kbm.accepted, 0);
  assert.deepEqual(kbm.bytesLeftOver, { 1: 1 });
  assert.deepEqual(kbm.bytesMissing, { 1: 1 });
  // The last field is K24's u32 count: one byte short of it.
  assert.deepEqual(kbm.ranOutAt, { 'needs_more_bytes at K24': 1 });
});

test('H-KBM negative cases from FORMAT.md §12: phone count 2, a flag byte of 2', () => {
  const phone2 = waypointKbm({ name: 'p', phoneCount: 2 });
  const flag2 = waypointKbm({ name: 'f' });
  // The K14 altitude flag sits right after the 2-byte K13 block: prefix + 5 empty strings + 2.
  const prefixLength = waypointPrefix(new Bytes(), { name: 'f' }).build().length;
  flag2[prefixLength + 5 + 2] = 2;
  const { data } = dumpOf(gdbWith(rec('W', phone2), rec('W', flag2)));
  const kbm = data.files['AllData.gdb'].recordTypes.W.layouts['H-KBM'];
  assert.equal(kbm.accepted, 0);
  assert.deepEqual(kbm.stopped, { 'flag_not_0_or_1 at K14': 1, 'phone_count_above_1 at K20': 1 });
});

test('track bounds checks are mandatory: points and segments outside their bounds are not accepted', () => {
  const tight = { maxLat: semi(10.5), maxLon: semi(20.5), minLat: semi(10), minLon: semi(20) };
  const outside = track({ segments: [[[10, 20], [10.6, 20.1]]], segmentBoxes: [tight], trackBox: tight });
  const segOut = track({ segments: [[[10, 20], [10.1, 20.1]]], trackBox: { maxLat: semi(10.05), maxLon: semi(20.5), minLat: semi(10), minLon: semi(20) } });
  const upside = track({
    segments: [[[10, 20]]],
    segmentBoxes: [{ maxLat: semi(9), maxLon: semi(20), minLat: semi(11), minLon: semi(20) }],
    trackBox: { maxLat: semi(12), maxLon: semi(21), minLat: semi(8), minLon: semi(19) },
  });
  const badUuid = track({ uuid: 'not-a-uuid-at-all-but-36-characters!' });
  const loose = track({ segments: [[[10, 20]]], trackBox: { maxLat: semi(11), maxLon: semi(21), minLat: semi(9), minLon: semi(19) } });
  const neither = track({ total: 99 });
  const empty = track({ segments: [[], [[10, 20]]], total: 1 });
  const none = track({ segments: [], total: 0 });
  const { data } = dumpOf(gdbWith(...[outside, segOut, upside, badUuid, loose, neither, empty, none].map((b) => rec('T', b))));
  const kbm = data.files['AllData.gdb'].recordTypes.T.layouts['H-KBM'];
  assert.deepEqual(kbm.checksFailed, {
    'point_outside_segment at 15': 2,
    'segment_min_above_max at 15': 1,
    'segment_outside_track at 15': 1,
    'uuid_shape at 17': 1,
  });
  assert.equal(kbm.fitExactlyButFailedACheck, 4);
  assert.equal(kbm.accepted, 4);
  assert.deepEqual(kbm.amongAccepted, {
    empty_segment: 1, no_segments: 1, total_equals_points: 3, total_matches_neither: 1, track_bounds_loose: 1, track_bounds_tight: 2,
  });
});

test('a latitude beyond 90 degrees fails the check', () => {
  const bad = waypointKbm({ name: 'n', lat: 0 });
  const prefix = new Bytes().cstr('n').u32(0).build().length;
  new DataView(bad.buffer).setInt32(prefix, 2 ** 30 + 1, true);
  const { data } = dumpOf(gdbWith(rec('W', bad)));
  assert.deepEqual(data.files['AllData.gdb'].recordTypes.W.layouts['H-KBM'].checksFailed, { 'latitude_out_of_range at 3': 1 });
});

test('routes: autoroute points and autoroute settings stop the walk; a bad Unknown7 fails a check', () => {
  const { data } = dumpOf(
    gdbWith(
      rec('R', route({ points: [{ name: 'a', links: [[1, 2]], auto: 2 }] })),
      rec('R', route({ autorouteSettings: true })),
      rec('R', route({ points: [{ name: 'a', links: [], unknown7: new Uint8Array(8) }] })),
      rec('R', route({ points: [] })),
    ),
  );
  const r = data.files['AllData.gdb'].recordTypes.R.layouts['H-OP'];
  assert.deepEqual(r.stopped, { 'autoroute_points at P17': 1, 'autoroute_settings at 8.3': 1 });
  assert.deepEqual(r.checksFailed, { 'not_ff at P13': 1 });
  assert.equal(r.accepted, 1);
  assert.deepEqual(r.amongAccepted, { no_route_points: 1 });
});

test('counts that cannot fit are reported where they ran out, without a byte figure', () => {
  const huge = new Bytes().cstr('t').u8(1).raw([0, 0, 0, 0]).u32(0).u32(0xfffffff0).build();
  const { data } = dumpOf(gdbWith(rec('T', huge)));
  const kbm = data.files['AllData.gdb'].recordTypes.T.layouts['H-KBM'];
  assert.deepEqual(kbm.ranOutAt, { 'count_too_large at 4': 1 });
  assert.deepEqual(kbm.bytesMissing, {});
});

test('order violations, unknown types and empty lengths are counted', () => {
  const lib = { gdb: concat(header(), rec('W', waypointKbm()), rec('V', V_BODY), rec('W', waypointKbm()), rec('Q', [1]), new Bytes().u32(1).u8(0xc3).u8(9).build()) };
  const { data } = dumpOf(lib);
  const gdb = data.files['AllData.gdb'];
  assert.equal(gdb.orderViolations, 1);
  assert.deepEqual(Object.keys(gdb.recordTypes), ['Q', 'V', 'W', 'non-letter']);
  assert.equal(gdb.recordTypes.Q.name, 'not known');
  assert.equal(gdb.recordTypes.Q.layouts, null);
  assert.equal(gdb.recordTypes['non-letter'].count, 1);
  assert.deepEqual(gdb.problems, [{ code: 'unknown_record_type', count: 2 }]);
  assert.match(dumpOf(lib).text, /No layout is known for this record type; it is only counted\./);
});

test('length summaries: min, lower median, max and power-of-two buckets', () => {
  const lib = gdbWith(rec('W', waypointKbm({ name: 'a' })), rec('W', waypointKbm({ name: 'abcdefghij' })), rec('W', waypointKbm({ name: 'abcdefghijklmnopqrstuvwxyz0123456789' })));
  const { data } = dumpOf(lib);
  const len = data.files['AllData.gdb'].recordTypes.W.length;
  assert.equal(len.min, 57);
  assert.equal(len.median, 66);
  assert.equal(len.max, 92);
  assert.deepEqual(len.histogram, { '32-63': 1, '64-127': 2 });
});

test('a damaged header: signature shown as hex, the rest reported as unknown', () => {
  const bad = concat(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]), header().subarray(4));
  const { data, text } = dumpOf({ gdb: bad });
  const gdb = data.files['AllData.gdb'];
  assert.equal(gdb.readable, false);
  assert.equal(gdb.signature, 'hex 504B0304');
  assert.deepEqual(gdb.problems, [{ code: 'not_library_file', count: 1 }]);
  assert.match(text, /Signature: hex 504B0304 \(expected MsRc\)/);
});

test('missing files and size-only TrackSegments listings', () => {
  const { data, text } = buildDump({ trackSegments: [{ size: 10 }, { size: 30 }, { size: 20 }] });
  assert.deepEqual(data.files['AllData.gdb'], { present: false });
  assert.deepEqual(data.files['FolderData.gfi'], { present: false });
  assert.equal(data.files.TrackSegments.files, 3);
  assert.equal(data.files.TrackSegments.filesNotRead, 3);
  assert.equal(data.files.TrackSegments.bytes, 60);
  assert.deepEqual(data.files.TrackSegments.size, { min: 10, median: 20, max: 30 });
  assert.match(text, /- AllData\.gdb: not found/);
  assert.equal(buildDump({}).data.files.TrackSegments.present, false);
  assert.match(buildDump({}).text, /TrackSegments folder: not found/);
});

test('TrackSegments: extra bytes set, M = 0, counts too large, trailing bytes, odd signatures', () => {
  const files = [
    trackSegments([{ ele: 1 }, { ele: 2, extra: [0, 0, 1] }, { ele: 3 }]),
    trackSegments([]),
    trackSegments([{ ele: 1 }], 17, { m: 1000 }),
    trackSegments([{ ele: 1 }], 17, { trailing: [0, 0, 0] }),
    trackSegments([{ ele: 1, extra: [7] }], 17, { sig: 'Zz9!' }),
    Uint8Array.of(1, 2, 3),
  ];
  const { data } = dumpOf({ ts: files });
  const ts = data.files.TrackSegments;
  assert.deepEqual(ts.signatures, { MsRc: 4, 'hex 5A7A3921': 1, 'too short': 1 });
  assert.deepEqual(ts.headerProblems, { not_library_file: 1 });
  assert.deepEqual(ts.pointCountProblems, { count_too_large: 1 });
  assert.deepEqual(ts.verdict, { only17: 0, only11: 0, both: 1, neither: 3 });
  const l17 = ts.layouts['17 bytes per point'];
  assert.deepEqual(l17.extraBytePatterns, { '001000000000000': 1, '200000000000000': 1 });
  assert.deepEqual(l17.stopped, { 'extra_byte_not_0 at extra': 2 });
  assert.deepEqual(l17.bytesLeftOver, { 3: 1 });
});

test('TrackSegments: a bad elevation or time flag is reported with its field; ArrayBuffer entries are read', () => {
  const badElevation = trackSegments([{ ele: 1 }, { ele: 2 }]);
  const badTime = trackSegments([{ time: 1 }]);
  const body = header().length + 4;
  badElevation[body + 9 + 1 + 15] = 2; // second point's elevation flag
  badTime[body + 1] = 7; // first point's time flag
  const { data } = dumpOf({ ts: [badElevation, badTime.buffer] });
  const l17 = data.files.TrackSegments.layouts['17 bytes per point'];
  assert.deepEqual(l17.stopped, { 'flag_not_0_or_1 at elevation': 1, 'flag_not_0_or_1 at time': 1 });
  assert.equal(data.files.TrackSegments.filesRead, 2);
});

test('the hex of an unknown signature passes the words-from-source check', () => {
  const out = dumpOf({ gdb: concat(Uint8Array.from([0xde, 0xad, 0xbe, 0xef]), header().subarray(4)) });
  assert.equal(out.data.files['AllData.gdb'].signature, 'hex DEADBEEF');
  assertWordsFromSource(out.text, 'text');
  assertWordsFromSource(out.json, 'json');
});

test('classifyLibraryPath knows only Garmin\'s fixed names', () => {
  assert.equal(classifyLibraryPath('Database/4.8/AllData.gdb'), 'AllData.gdb');
  assert.equal(classifyLibraryPath('C:\\x\\Database\\4.7\\FolderData.gfi'), 'FolderData.gfi');
  assert.equal(classifyLibraryPath('Database/4.8/TrackSegments/0f8fad5b-d9cb-469f-a165-70867728950e'), 'TrackSegments');
  assert.equal(classifyLibraryPath('Database/4.8/TrackSegments/.DS_Store'), 'other');
  assert.equal(classifyLibraryPath('alldata.GDB'), 'AllData.gdb');
  assert.equal(classifyLibraryPath('AllData.gdb.bak'), 'other');
  assert.equal(classifyLibraryPath('TrackSegments'), 'other');
  assert.equal(classifyLibraryPath(/** @type {any} */ (42)), 'other');
});

test('environment fields outside the allow-list are not passed through', () => {
  const { data } = buildDump({ toolVersion: 'Zq8 my laptop', engine: 'Mozilla/5.0 (Macintosh)', engineMajor: 1e9, inputKind: '/Users/someone' });
  assert.deepEqual(data.tool, { version: 'other' });
  assert.deepEqual(data.environment, { engine: 'other', engineMajor: null });
  assert.equal(data.input.kind, 'other');
  assert.deepEqual(buildDump({ toolVersion: '1.2.3-beta1' }).data.tool, { version: '1.2.3-beta1' });
});

test('replacement layouts: unsafe labels are dropped, unsafe codes and fields become "other"', () => {
  const layouts = {
    gdb: {
      W: [
        { label: 'Probe', walk: () => ({ outcome: 'stopped', by: 0, code: 'Zq7 leaked name', field: 'K/../x', checks: ['Zq7 also@1'], notes: [] }) },
        { label: 'name: Zq7 secret!', walk: () => ({ outcome: 'exact', by: 0, code: null, field: null, checks: [], notes: [] }) },
        { label: 'Thrower', walk: () => { throw new Error('Zq7 from walker'); } },
        { label: 'Junk', walk: () => 'Zq7' },
      ],
    },
    gfi: {},
  };
  const out = buildDump({ allData: readContainer(gdbWith(rec('W', waypointKbm())).gdb) }, { layouts });
  const w = out.data.files['AllData.gdb'].recordTypes.W;
  assert.deepEqual(Object.keys(w.layouts), ['Probe', 'Thrower', 'Junk']);
  assert.deepEqual(w.layouts.Probe.stopped, { other: 1 });
  assert.deepEqual(w.layouts.Probe.checksFailed, { 'other at 1': 1 });
  assert.deepEqual(w.layouts.Thrower.stopped, { walker_failed: 1 });
  assert.deepEqual(w.layouts.Junk.stopped, { walker_failed: 1 });
  assert.ok(!out.json.includes('Zq7') && !out.text.includes('Zq7'));
});

test('hostile container results never throw and never leak', () => {
  const weird = [
    null,
    'text',
    42,
    { ok: true, size: -5, signature: '<script>', signatureHex: 'Zq7Zq7Zq', primaryFormat: 'x', records: 'nope', problems: [{ code: 'Zq7', count: 'x' }] },
    {
      ok: true,
      records: [
        null,
        { typeCode: 0x57, length: 3, get body() { throw new Error('Zq7'); } },
        { typeCode: 0x57, length: 3, body: 'Zq7' },
        { typeCode: 999, length: 3, body: new Uint8Array(3) },
        { typeCode: 0x54, length: 2, body: new Uint8Array(5) },
      ],
    },
  ];
  for (const c of weird) {
    const out = buildDump({ allData: /** @type {any} */ (c), folderData: /** @type {any} */ (c), trackSegments: /** @type {any} */ ([c, null, 'Zq7']) });
    assert.ok(!out.json.includes('Zq7') && !out.text.includes('Zq7') && !out.json.includes('script'));
  }
  assert.doesNotThrow(() => buildDump(/** @type {any} */ (null)));
});

test('odd options never throw: null options, malformed layout tables', () => {
  const allData = readContainer(gdbWith(rec('W', waypointKbm())).gdb);
  for (const options of [null, 5, 'x', {}, { layouts: null }, { layouts: { gdb: 7 } }, { layouts: { gdb: { W: 'nope' } } }, { layouts: { gdb: { W: [null, 3] } } }]) {
    const out = buildDump({ allData }, /** @type {any} */ (options));
    assert.equal(out.data.files['AllData.gdb'].recordTypes.W.count, 1);
  }
  const custom = buildDump({ allData }, /** @type {any} */ ({ layouts: { gdb: { W: 'nope' } } }));
  assert.equal(custom.data.files['AllData.gdb'].recordTypes.W.layouts, null);
});

test('fuzz: truncated and bit-flipped libraries always produce a dump', () => {
  const lib = library();
  const rand = prng(7);
  for (let i = 0; i < 300; i++) {
    const gdb = lib.gdb.slice(0, Math.floor(rand() * (lib.gdb.length + 1)));
    const gfi = lib.gfi.slice();
    const ts = lib.ts.map((f) => f.slice());
    for (let k = 0; k < 4; k++) {
      gdb[Math.floor(rand() * gdb.length)] ^= 1 << Math.floor(rand() * 8);
      gfi[Math.floor(rand() * gfi.length)] = Math.floor(rand() * 256);
      const f = ts[Math.floor(rand() * ts.length)];
      f[Math.floor(rand() * f.length)] = Math.floor(rand() * 256);
    }
    const out = dumpOf({ gdb, gfi, ts });
    assert.equal(typeof out.text, 'string');
    assert.equal(out.data.files['AllData.gdb'].present, true);
  }
});

test('a GFI tree with a cycle, a missing root, dangling children and a disagreeing parent', () => {
  const gfi = concat(
    header({ sig: 'DifG' }),
    folderRec(5, 'a', 6, [[1, 6], [0, 1], [0, 9], [3, 3]]),
    folderRec(6, 'b', 5, [[1, 5], [0, 1]]),
    folderRec(6, 'dup', 5, []),
    listRec(1, 'l', 0, 6),
    listRec(2, 'orphan', 1, 5),
    wRef(2, 'w'),
  );
  const { data } = dumpOf({ gfi });
  const t = data.files['FolderData.gfi'].tree;
  assert.equal(t.root, 'none');
  assert.equal(t.foldersReachedFromRoot, 0);
  assert.equal(t.foldersNotReached, 2);
  assert.equal(t.duplicateFolderIds, 1);
  assert.equal(t.childReferencesNotFound, 1);
  assert.deepEqual(t.childReferences, { list: 3, folder: 2, other: 1 });
  assert.equal(t.listsListedTwice, 1);
  assert.equal(t.listsNotInAnyFolder, 1);
  assert.equal(t.listsWhoseParentDisagrees, 1);
  assert.deepEqual(t.itemsPerList, { 0: 1, 1: 1 });
  assert.match(dumpOf({ gfi }).text, /Top folder: not found\./);
});

test('a deep folder chain stops at the depth cap', () => {
  const parts = [header({ sig: 'DifG' }), folderRec(0xffffffff, 'root', 0xffffffff, [[1, 0]])];
  for (let i = 0; i < 80; i++) parts.push(folderRec(i, 'f', i === 0 ? 0xffffffff : i - 1, [[1, i + 1]]));
  const { data } = dumpOf({ gfi: concat(...parts) });
  const t = data.files['FolderData.gfi'].tree;
  assert.equal(t.deepestFolder, 64);
  assert.equal(t.depthLimitReached, true);
});

test('the built-in layouts cover the record types FORMAT.md describes', () => {
  assert.deepEqual(Object.keys(DEFAULT_LAYOUTS.gdb).sort(), ['E', 'R', 'T', 'V', 'W', 'X']);
  assert.deepEqual(Object.keys(DEFAULT_LAYOUTS.gfi).sort(), ['F', 'I', 'J', 'K', 'R', 'T', 'W']);
  assert.deepEqual(DEFAULT_LAYOUTS.gdb.W.map((l) => l.label), ['H-KBM', 'H-OP', 'H-MAC48']);
  assert.deepEqual(DEFAULT_LAYOUTS.gdb.T.map((l) => l.label), ['H-KBM', 'H-OP', 'H-MAC48']);
  assert.deepEqual(DEFAULT_LAYOUTS.gdb.R.map((l) => l.label), ['H-OP', 'H-MAC48']);
});

// ---------------------------------------------------------------------------------------------
// Privacy: sentinels (ARCHITECTURE.md §11, decision B23)

const CANARY_TEXT = [
  'Qv7WaypointNameAlpha', 'Qv7WaypointComment', 'Qv7StreetLine', 'Qv7CityName', 'Qv7StateName', 'Qv7CountryName',
  'Qv7PostalCode', 'Qv7PhoneNumber', 'Qv7LinkAddress', 'Qv7CategoryLabel', 'Qv7TrackNameBravo', 'Qv7TrackNotes',
  'Qv7RouteNameCharlie', 'Qv7RoutePointName', 'Qv7RouteNotes', 'Qv7FolderNameDelta', 'Qv7ListNameEcho',
  'Qv7BirdsEyeName', 'Qv7BuilderString', 'Qv7BuildDate', 'Qv7BuildTime', 'Qv7ThumbOrigin', 'Qv7ApplicationName',
  'Qv7MapSetName', 'Grüße-Qv7-Ünïcødé', '/Users/qv7person/Library/Application Support/Garmin',
];
const CANARY_UUIDS = ['c0ffee77-1234-4abc-8def-0123456789ab', 'deadbe77-9876-4fed-8cba-fedcba987654'];
const CANARY_DEGREES = [[47.6205063, -122.3492774], [-33.8567844, 151.2152967]];
const CANARY_TIMES = [1199999977, 1300000033, 1555555577];
const CANARY_DOUBLES = [1234.5678, 9876.54321];

function sentinelLibrary() {
  const [[lat1, lon1], [lat2, lon2]] = CANARY_DEGREES;
  const [t1, t2, t3] = CANARY_TIMES;
  const n = CANARY_TEXT;
  const gdb = concat(
    header({ builder: 'Qv7BuilderString', date: 'Qv7BuildDate', time: 'Qv7BuildTime' }),
    rec('W', waypointKbm({
      name: n[0], comment: n[1], lat: lat1, lon: lon1, proximity: CANARY_DOUBLES[0], address: [n[2], n[3], n[4], n[5], n[6]],
      altitude: CANARY_DOUBLES[1], timeA: t1, timeB: t2, phone: n[7], links: [n[8]], categories: [n[9]],
    })),
    rec('W', waypointOp({ name: n[24], comment: n[25], lat: lat2, lon: lon2, time: t3, thumbnail: { origin: n[21], uuid: CANARY_UUIDS[1] } })),
    rec('T', track({ name: n[10], notes: n[11], links: [n[8]], start: t1, area: CANARY_DOUBLES[0], length: CANARY_DOUBLES[1], segments: [[[lat1, lon1], [lat1 + 0.001, lon1 + 0.001]]], uuid: CANARY_UUIDS[0] })),
    rec('T', track({ name: n[10], segments: [[[lat2, lon2]]], uuid: CANARY_UUIDS[1] }, false)),
    rec('R', route({ name: n[12], notes: n[14], points: [{ name: n[13], links: [[lat1, lon1]] }, { name: n[13], links: [[lat2, lon2]], auto: 1, junk: new TextEncoder().encode(n[0]) }] })),
    rec('V', new Bytes().cstr(n[23]).u8(0).build()),
    rec('E', E_BODY),
    rec('X', X_BODY),
  );
  const gfi = concat(
    header({ sig: 'DifG', builder: 'Qv7BuilderString', date: 'Qv7BuildDate', time: 'Qv7BuildTime' }),
    folderRec(0xffffffff, n[15], 0xffffffff, [[0, 4242]]),
    listRec(4242, n[16], 0, 0xffffffff),
    wRef(4242, n[0]),
    tRef(4242, n[10]),
    rRef(4242, n[12]),
    kRef(4242, n[17]),
  );
  const ts = [
    trackSegments([{ ele: CANARY_DOUBLES[0], time: t1 }, { ele: CANARY_DOUBLES[1], time: t2 }], 17, { builder: 'Qv7BuilderString', date: 'Qv7BuildDate', time: 'Qv7BuildTime', app: 'Qv7ApplicationName' }),
    trackSegments([{ ele: CANARY_DOUBLES[0], time: t3, extra: [1] }]),
  ];
  return { gdb, gfi, ts };
}

/** Every encoding of a byte string the dump could conceivably leak it in. */
function encodings(bytes) {
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
  const out = [hex.join(''), hex.join(' '), hex.join('').toUpperCase(), hex.join(' ').toUpperCase(), Buffer.from(bytes).toString('base64').replace(/=+$/, '')];
  return out.filter((s) => s.length >= 6);
}

function le32(v) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, v, true);
  return b;
}
function be32(v) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, v, false);
  return b;
}
function f64le(v) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v, true);
  return b;
}

function needles() {
  /** @type {string[]} */
  const list = [];
  for (const s of CANARY_TEXT) {
    list.push(s, s.toLowerCase(), s.toUpperCase(), s.slice(3), s.normalize('NFD'));
    list.push(...encodings(new TextEncoder().encode(s)));
  }
  for (const u of CANARY_UUIDS) {
    list.push(u, u.toUpperCase(), u.replace(/-/g, ''), u.slice(0, 8), u.slice(-12));
    list.push(...encodings(new TextEncoder().encode(u)));
  }
  for (const [lat, lon] of CANARY_DEGREES) {
    for (const deg of [lat, lon]) {
      const s = semi(deg);
      list.push(String(s), String(s >>> 0), deg.toFixed(4), deg.toFixed(7), String(deg));
      list.push(...encodings(le32(s)), ...encodings(be32(s)));
    }
  }
  for (const t of CANARY_TIMES) {
    const iso = new Date(t * 1000).toISOString();
    list.push(String(t), String(t * 1000), iso, iso.slice(0, 10), ...encodings(le32(t)), ...encodings(be32(t)));
  }
  for (const d of CANARY_DOUBLES) list.push(String(d), ...encodings(f64le(d)));
  return list;
}

/** @param {string} output */
function assertNoLeak(output, label) {
  for (const needle of needles()) assert.ok(!output.includes(needle), `${label} leaks ${JSON.stringify(needle)}`);
  assert.ok(!/Qv7/i.test(output), `${label} contains the canary marker`);
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(output), `${label} contains a date`);
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(output), `${label} contains something shaped like a UUID`);
}

/** Every word of four or more letters in the output must appear in our own source code: nothing comes from data. */
function assertWordsFromSource(output, label) {
  const source = ['../src/format/dump.js', '../src/format/container.js'].map((p) => readFileSync(new URL(p, import.meta.url), 'utf8')).join('\n');
  // A signature shown as hex ("hex DEADBEEF") is digits from the file's first 4 bytes, allowed by ARCHITECTURE §11.
  const withoutHex = output.replace(/\bhex [0-9A-F]{8}\b/g, 'hex');
  for (const word of new Set(withoutHex.match(/[A-Za-z]{4,}/g) ?? [])) {
    assert.ok(source.includes(word), `${label}: the word ${JSON.stringify(word)} is not from the code`);
  }
}

/** Every string in the JSON (keys and values) is short and from a narrow character set. */
function assertJsonStringsSafe(data) {
  const walk = (value, path) => {
    if (typeof value === 'string') {
      assert.match(value, /^[A-Za-z0-9 _.,:§@'()/-]{0,140}$/, `${path} = ${JSON.stringify(value)}`);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        assert.match(k, /^[A-Za-z0-9 _.:§@-]{1,60}$/, `key ${JSON.stringify(k)} at ${path}`);
        assert.notEqual(k, 'body');
        walk(v, `${path}.${k}`);
      }
    } else {
      assert.ok(value === null || typeof value === 'number' || typeof value === 'boolean', `${path} has type ${typeof value}`);
      if (typeof value === 'number') assert.ok(Number.isFinite(value));
    }
  };
  walk(data, '$');
}

test('sentinel: no planted name, coordinate, time, UUID or path reaches the dump in any encoding', () => {
  const lib = sentinelLibrary();
  // The canaries really are in the input, in the encodings the test looks for.
  const haystack = Buffer.concat([lib.gdb, lib.gfi, ...lib.ts]);
  assert.ok(haystack.includes(Buffer.from('Qv7WaypointNameAlpha')));
  assert.ok(haystack.includes(Buffer.from(le32(semi(CANARY_DEGREES[0][0])))));
  assert.ok(haystack.includes(Buffer.from(le32(CANARY_TIMES[0]))));
  assert.ok(haystack.includes(Buffer.from(CANARY_UUIDS[0])));
  assert.ok(haystack.includes(Buffer.from(f64le(CANARY_DOUBLES[0]))));

  const out = dumpOf(lib);
  // The dump did analyse the records (so the test is not vacuous).
  assert.equal(out.data.files['AllData.gdb'].recordTypes.W.count, 2);
  assert.equal(out.data.files['AllData.gdb'].recordTypes.W.verdict.matchedOnlyOne['H-KBM'], 1);
  assert.equal(out.data.files['AllData.gdb'].recordTypes.W.verdict.matchedOnlyOne['H-OP'], 1);
  assert.equal(out.data.files['FolderData.gfi'].tree.lists, 1);
  assert.equal(out.data.files.TrackSegments.applications.other, 1);

  assertNoLeak(out.text, 'text');
  assertNoLeak(out.json, 'json');
  assertWordsFromSource(out.text, 'text');
  assertWordsFromSource(out.json, 'json');
  assertJsonStringsSafe(out.data);
});

test('sentinel: no leak from damaged copies either (misread fields, shifted framing)', () => {
  const lib = sentinelLibrary();
  const rand = prng(2026);
  for (let i = 0; i < 150; i++) {
    const mutate = (bytes) => {
      const b = bytes.slice();
      const n = 1 + Math.floor(rand() * 6);
      for (let k = 0; k < n; k++) b[Math.floor(rand() * b.length)] = Math.floor(rand() * 256);
      return rand() < 0.3 ? b.subarray(0, Math.floor(rand() * b.length)) : b;
    };
    const out = dumpOf({ gdb: mutate(lib.gdb), gfi: mutate(lib.gfi), ts: lib.ts.map(mutate) });
    assertNoLeak(out.text, `text #${i}`);
    assertNoLeak(out.json, `json #${i}`);
    assertWordsFromSource(out.json, `json #${i}`);
    assertWordsFromSource(out.text, `text #${i}`);
    assertJsonStringsSafe(out.data);
  }
});

// ---------------------------------------------------------------------------------------------
// Adversarial review (2026-10-06). The first five tests below each failed on the code as it was before the review:
// replacement-layout strings passed through on their character set alone, the text printed problem codes, a misread
// length was printed as an exact number, TrackSegments header tallies grew a key per file, and a folder record's
// children were copied into JavaScript arrays (about 90 bytes of heap per 8-byte child).

/** A snake_case token: a code, not a plain word. */
const SNAKE = /\b[a-z0-9]+_[a-z0-9_]+\b/;

/** Digits grouped the way the text report groups them. */
const grouped = (n) => String(n).replace(/\B(?=(\d{3})+$)/g, ',');

test('replacement layouts: only codes, fields and notes from the fixed vocabulary reach the output', () => {
  const layouts = {
    gdb: {
      W: [
        {
          label: 'Parser A',
          walk: () => ({ outcome: 'stopped', by: 0, code: 'qvseven_alice_smith', field: 'AliceSmith', checks: ['bob_jones@Bob', 'not_0@Carol9', 'toString@1', 'value_too_high@47.62'], notes: [] }),
        },
        {
          label: 'Parser B',
          walk: () => ({ outcome: 'exact', by: 0, code: null, field: null, checks: [], notes: ['AliceSmithHome', 'nonzero_Dave', 'nonzero_K13', 'altitude', 'constructor', 'toString', '__proto__'] }),
        },
        { label: 'Parser C', walk: () => ({ outcome: 'stopped', by: 0, code: '__proto__', field: '1', checks: [], notes: [] }) },
        { label: 'Parser D', walk: () => ({ outcome: 'missing', by: 3, code: 'constructor', field: 'Erin', checks: [], notes: [] }) },
      ],
    },
    gfi: {},
  };
  const out = buildDump({ allData: readContainer(gdbWith(rec('W', waypointKbm())).gdb) }, { layouts });
  for (const [label, s] of [['json', out.json], ['text', out.text]]) {
    assert.ok(!/alice|bob|carol|dave|erin|qvseven/i.test(s), `${label} passes a parser's own string through`);
    assert.ok(!/native code|\[object/.test(s), `${label} prints a JavaScript built-in`);
    assert.ok(!s.includes('47.62') && !s.includes('47,62'), `${label} passes a number shaped like a latitude as a field label`);
  }
  const w = out.data.files['AllData.gdb'].recordTypes.W.layouts;
  // The fixed vocabulary still passes: a known check code with a bad field keeps the code and drops the field.
  assert.deepEqual(w['Parser A'].stopped, { other: 1 });
  assert.deepEqual(w['Parser A'].checksFailed, { not_0: 1, other: 1, 'other at 1': 1, value_too_high: 1 });
  assert.equal(w['Parser B'].amongAccepted.altitude, 1);
  assert.equal(w['Parser B'].amongAccepted.nonzero_K13, 1);
  for (const key of Object.keys(w['Parser B'].amongAccepted)) assert.ok(['altitude', 'nonzero_K13', 'other'].includes(key), key);
  // Nothing is lost on the way: a stop with a code shaped like "__proto__" is still counted.
  assert.equal(Object.values(w['Parser C'].stopped).reduce((a, b) => a + b, 0), 1);
  assert.deepEqual(w['Parser D'].ranOutAt, { other: 1 });
  assert.deepEqual(w['Parser D'].bytesMissing, { 3: 1 });
  assertJsonStringsSafe(out.data);
});

test('the text report is plain words: no problem or reason code is printed as a code', () => {
  // Every container problem code, as a container result carries it, plus one this version does not know.
  for (const code of [...PROBLEM_CODES, 'something_new']) {
    const { text } = buildDump({ allData: { ok: false, size: 30, problems: [{ code, message: 'x', count: 2 }] } });
    const line = text.split('\n').find((l) => l.startsWith('- Problems:'));
    assert.ok(line !== undefined && !SNAKE.test(line), `${code}: ${line}`);
    assert.match(line, /\(2\)/);
  }
  // A damaged AllData.gdb, a FolderData.gfi that is really a GDB, and TrackSegments files with every kind of problem.
  const damaged = concat(header(), rec('Q', [1]), new Uint8Array(7), Uint8Array.from([0xff, 0xff, 0xff, 0x0f, 0x57]));
  const ts = [
    Uint8Array.of(1, 2, 3),
    concat(header(), Uint8Array.of(0xff, 0xff, 0, 0)),
    header(),
    concat(Uint8Array.of(1, 2, 3, 4), header().subarray(4)),
    trackSegments([{ ele: 1 }, { ele: 2, extra: [3] }]),
  ];
  const out = buildDump({ allData: readContainer(damaged, { role: 'gdb' }), folderData: readContainer(header(), { role: 'gfi' }), trackSegments: ts });
  assert.match(out.text, /- Problems: /);
  assert.match(out.text, /Header problems: /);
  assert.match(out.text, /Point count problems: /);
  for (const text of [out.text, dumpOf(library()).text, dumpOf(sentinelLibrary()).text]) {
    for (const line of text.split('\n')) assert.ok(!SNAKE.test(line), `a code in the text: ${line}`);
  }
  assertWordsFromSource(out.text, 'text');
});

/** A GDB whose first record frame is misread from a track point: its "length" is a latitude in semicircles. */
function misframedGdb(lat, lon) {
  const h = header();
  const file = new Uint8Array(h.length + 8 + lat + 64);
  file.set(h);
  new DataView(file.buffer).setInt32(h.length, lat, true);
  new DataView(file.buffer).setInt32(h.length + 4, lon, true);
  return file;
}

test('a length misread from the bytes of a record type this tool does not know is not printed as an exact number', () => {
  const lat = semi(0.25); // 2,982,616 semicircles: a plausible length in a 3 MB file
  for (const lon of [semi(32.58), semi(32.58) - (semi(32.58) & 0xff) + 0x71]) {
    // The low byte of the longitude becomes the type byte: 0x0C ("non-letter"), then 0x71 ("q").
    const out = dumpOf({ gdb: misframedGdb(lat, lon) });
    const types = out.data.files['AllData.gdb'].recordTypes;
    const key = (lon & 0xff) === 0x71 ? 'q' : 'non-letter';
    const t = types[key];
    assert.equal(t.count, 1, 'the misread record was framed and counted (not vacuous)');
    assert.equal(t.name, 'not known');
    assert.deepEqual([t.length.min, t.length.median, t.length.max], [null, null, null]);
    assert.deepEqual(t.length.histogram, { '2097152-4194303': 1 });
    assert.ok(!out.text.includes(String(lat)) && !out.text.includes(grouped(lat)), 'the text prints the latitude');
    assertWordsFromSource(out.text, 'text');
  }
  // Known record types keep their exact lengths (Gate 1 needs them).
  const known = dumpOf(gdbWith(rec('W', waypointKbm({ name: 'a' })))).data.files['AllData.gdb'].recordTypes.W.length;
  assert.equal(known.min, 57);
});

test('TrackSegments header tallies are capped: a folder of junk files cannot stream its first bytes into the dump', () => {
  const files = [];
  for (let i = 0; i < 200; i++) {
    const sig = String.fromCharCode(0x41 + (i % 26), 0x41 + Math.floor(i / 26), 0x30 + (i % 10), 0x5a);
    files.push(concat(header({ sig, primary: 0x1000 + i, version: 0x2000 + i, program: 0x3000 + i }), Uint8Array.of(0, 0, 0, 0)));
  }
  const ts = dumpOf({ ts: files }).data.files.TrackSegments;
  for (const tally of ['signatures', 'containerFormats', 'fileFormats', 'programVersions']) {
    const keys = Object.keys(ts[tally]);
    assert.ok(keys.length <= 17, `${tally} has ${keys.length} keys`);
    assert.equal(Object.values(ts[tally]).reduce((a, b) => a + b, 0), 200, `${tally} still counts every file`);
  }
  assert.ok(ts.signatures.other > 0);
  // Real libraries are untouched: a handful of distinct values stays exact.
  assert.deepEqual(dumpOf(library()).data.files.TrackSegments.signatures, { MsRc: 3 });
});

test('a folder record that claims millions of children does not multiply memory', () => {
  const dumpUrl = new URL('../src/format/dump.js', import.meta.url).href;
  const containerUrl = new URL('../src/format/container.js', import.meta.url).href;
  // Run in a fresh process so the heap measurement sees nothing but this dump.
  const script = `
    import { getHeapStatistics } from 'node:v8';
    const { readContainer } = await import(${JSON.stringify(containerUrl)});
    const { buildDump } = await import(${JSON.stringify(dumpUrl)});
    const N = 2000000;
    const head = Uint8Array.from([0x44,0x69,0x66,0x47,0x66,0,2,0,0,0,0x44,188,0,2,0,0,0,0x41,0x97,0x01,0x42,0]);
    const bodyLength = 4 + 1 + 4 + 4 + N * 8 + 1;
    const file = new Uint8Array(head.length + 5 + bodyLength);
    file.set(head);
    const dv = new DataView(file.buffer);
    let p = head.length;
    dv.setUint32(p, bodyLength, true); file[p + 4] = 0x46; p += 5;
    dv.setUint32(p, 0xffffffff, true); p += 5;
    dv.setUint32(p, 0xffffffff, true); dv.setUint32(p + 4, N, true); p += 8;
    for (let i = 0; i < N; i++) { dv.setUint32(p, 1, true); dv.setUint32(p + 4, i, true); p += 8; }
    file[p] = 1;
    const container = readContainer(file, { role: 'gfi' });
    globalThis.gc(); globalThis.gc();
    const before = getHeapStatistics();
    const out = buildDump({ folderData: container });
    const after = getHeapStatistics();
    const tree = out.data.files['FolderData.gfi'].tree;
    console.log(JSON.stringify({
      usedMB: (after.used_heap_size - before.used_heap_size) / 2 ** 20,
      totalMB: (after.total_heap_size - before.total_heap_size) / 2 ** 20,
      folderRefs: tree.childReferences.folder, notFound: tree.childReferencesNotFound, reached: tree.foldersReachedFromRoot,
    }));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], { encoding: 'utf8' }));
  // The 16 MB file is the caller's; the tree's own bookkeeping must not be a multiple of it.
  assert.equal(result.folderRefs, 2_000_000, 'the children were all counted (not vacuous)');
  assert.equal(result.notFound, 2_000_000);
  assert.equal(result.reached, 1);
  assert.ok(result.totalMB < 48, `heap grew by ${result.totalMB.toFixed(0)} MB`);
  assert.ok(result.usedMB < 48, `heap in use grew by ${result.usedMB.toFixed(0)} MB`);
});

// The rest of this section passed on the code before the review, except this first fuzz test, which failed on it for
// the same reason as the plain-words test above (codes printed in the text). It is all kept as evidence and as a guard.

test('fuzz: thousands of seeded damages to the sentinel library never throw, leak or print a code', () => {
  const lib = sentinelLibrary();
  const rand = prng(20261006);
  const pick = (n) => Math.floor(rand() * n);
  /** @param {Uint8Array} bytes */
  const damage = (bytes) => {
    let b = bytes.slice();
    const kind = pick(5);
    if (kind === 0) {
      for (let k = 1 + pick(8); k > 0; k--) b[pick(b.length)] = pick(256);
    } else if (kind === 1) {
      // An absurd or boundary u32 written where a frame length could be.
      const at = pick(Math.max(1, b.length - 4));
      const values = [0, 1, 0x7fffffff, 0x80000000, 0xffffffff, b.length - at, b.length - at - 5, b.length - at - 4, pick(2 ** 32)];
      new DataView(b.buffer).setUint32(at, values[pick(values.length)] >>> 0, true);
    } else if (kind === 2) {
      b = b.subarray(0, pick(b.length + 1));
    } else if (kind === 3) {
      // A record type byte replaced: 'V' and 'X' mid-file, a letter, a non-letter.
      const at = pick(b.length);
      b[at] = [0x56, 0x58, 0x71, 0x00, 0xc3][pick(5)];
    } else {
      // Bytes inserted mid-file (shifts every later frame).
      const at = pick(b.length);
      const extra = Uint8Array.from({ length: 1 + pick(9) }, () => pick(256));
      b = concat(b.subarray(0, at), extra, b.subarray(at));
    }
    return b;
  };
  const started = performance.now();
  for (let i = 0; i < 5000; i++) {
    const out = dumpOf({ gdb: damage(lib.gdb), gfi: damage(lib.gfi), ts: lib.ts.map(damage) });
    assert.ok(!/Qv7/i.test(out.json) && !/Qv7/i.test(out.text), `round ${i} leaks the canary marker`);
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(out.json), `round ${i}: something shaped like a UUID`);
    for (const line of out.text.split('\n')) assert.ok(!SNAKE.test(line), `round ${i}: a code in the text: ${line}`);
    assertJsonStringsSafe(out.data);
    if (i % 50 === 0) {
      assertNoLeak(out.json, `json #${i}`);
      assertNoLeak(out.text, `text #${i}`);
      assertWordsFromSource(out.text, `text #${i}`);
    }
  }
  assert.ok(performance.now() - started < 60_000, 'the fuzz run took too long');
});

test('half a million tiny records: the dump stays fast and its output stays small', () => {
  const h = header();
  const n = 500_000;
  const file = new Uint8Array(h.length + n * 6);
  file.set(h);
  for (let i = 0; i < n; i++) {
    file[h.length + i * 6] = 1;
    file[h.length + i * 6 + 4] = [0x57, 0x54, 0x52, 0x71, 0x00][i % 5];
  }
  const started = performance.now();
  const out = buildDump({ allData: readContainer(file, { role: 'gdb' }) });
  const elapsed = performance.now() - started;
  assert.equal(out.data.files['AllData.gdb'].recordCount, n);
  assert.equal(out.data.files['AllData.gdb'].recordTypes.W.count, n / 5);
  assert.ok(out.json.length < 20_000, `json is ${out.json.length} characters`);
  assert.ok(elapsed < 15_000, `took ${elapsed} ms`);
});

test('a GFI with a GDB signature, and a GDB with a GFI signature, are reported in plain words', () => {
  const out = dumpOf({ gdb: concat(header({ sig: 'DifG' }), rec('F', [1])), gfi: concat(header(), rec('W', [1])) });
  const gdb = out.data.files['AllData.gdb'];
  const gfi = out.data.files['FolderData.gfi'];
  assert.equal(gdb.readable, false);
  assert.equal(gfi.readable, false);
  assert.deepEqual(gdb.problems, [{ code: 'wrong_file_kind', count: 1 }]);
  assert.deepEqual(gfi.recordTypes, {});
  assert.match(out.text, /Signature: DifG \(expected MsRc\)/);
  assert.match(out.text, /Signature: MsRc \(expected DifG\)/);
});

test('file format versions 0 and 65535 are shown raw, with their class in words', () => {
  for (const [version, words] of [[0, 'not a known version'], [65535, 'experimental support']]) {
    const out = dumpOf({ gdb: header({ version, program: version }) });
    assert.equal(out.data.files['AllData.gdb'].fileFormat, version);
    assert.equal(out.data.files['AllData.gdb'].programVersion, version);
    assert.match(out.text, new RegExp(`File format: ${version} \\(${words}\\)\\. Program version: ${version}\\.`));
  }
});

// ---------------------------------------------------------------------------------------------
// Decision B43: AllData.gdb's program version breaks layout ties, and the dump says how it decided

/** Layout walkers that accept every body (labels as the real ones), for exercising the tie-break. */
const fits = (/** @type {string[]} */ labels) =>
  labels.map((label) => ({ label, walk: () => ({ outcome: 'exact', by: 0, code: null, field: null, checks: [], notes: [] }) }));

test('B43: the program version decides ties among W, T and R layouts, and the dump reports the decision in plain words', () => {
  const layouts = { gdb: { W: fits(['H-KBM', 'H-OP', 'H-MAC48']), T: fits(['H-OP', 'H-MAC48']), R: fits(['H-OP', 'H-MAC48']) }, gfi: {} };
  const body = Uint8Array.of(1, 2, 3);
  /** @param {number} program */
  const dump = (program) =>
    buildDump({ allData: readContainer(concat(header({ program }), rec('W', body), rec('W', body), rec('R', body), rec('T', body)), { role: 'gdb' }) }, { layouts });
  const mac = dump(408);
  const types = mac.data.files['AllData.gdb'].recordTypes;
  assert.deepEqual(types.W.verdict, { matchedOnlyOne: { 'H-KBM': 0, 'H-OP': 0, 'H-MAC48': 0 }, matchedNone: 0, matchedMoreThanOne: 2 }, 'the raw verdict is unchanged');
  assert.deepEqual(types.W.tieBreak, { programVersion: 'mac48', decidedByProgramVersion: { 'H-KBM': 0, 'H-OP': 0, 'H-MAC48': 2 }, stillMoreThanOne: 0, refusedForProgramVersion: 0 });
  assert.deepEqual(types.R.tieBreak.decidedByProgramVersion, { 'H-OP': 0, 'H-MAC48': 1 });
  assert.deepEqual(types.T.tieBreak.decidedByProgramVersion, { 'H-OP': 0, 'H-MAC48': 1 });
  assert.match(mac.text, /Decided by the program version \(BaseCamp 4\.8 for Mac, so H-MAC48 is preferred\): 2 read as H-MAC48, 0 still matched more than one and were not read\./);
  assertJsonStringsSafe(mac.data);
  assert.ok(!SNAKE.test(mac.text.split('\n').filter((l) => l.includes('Decided by')).join('\n')));

  const older = dump(407).data.files['AllData.gdb'].recordTypes;
  // W: H-KBM and H-OP both fit, so an older version cannot choose; T and R: H-OP is the only older layout that fits.
  assert.deepEqual([older.W.tieBreak.programVersion, older.W.tieBreak.stillMoreThanOne], ['older', 2]);
  assert.deepEqual(older.T.tieBreak.decidedByProgramVersion, { 'H-OP': 1, 'H-MAC48': 0 });
  assert.deepEqual(older.R.tieBreak.decidedByProgramVersion, { 'H-OP': 1, 'H-MAC48': 0 });

  for (const program of [0, 409, 480, 4813]) {
    const t = dump(program).data.files['AllData.gdb'].recordTypes;
    assert.deepEqual([t.W.tieBreak.programVersion, t.W.tieBreak.stillMoreThanOne, t.R.tieBreak.stillMoreThanOne], ['unknown', 2, 1], `program ${program}`);
  }
  // FolderData.gfi's records never take part, and a type with one layout has no tie-break.
  assert.equal(mac.data.files['AllData.gdb'].recordTypes.E, undefined);
});

test('B43: in a Mac 4.8 file, a route that fits only H-OP is counted as refused for the program version', () => {
  const layouts = { gdb: { R: [...fits(['H-OP']), { label: 'H-MAC48', walk: () => ({ outcome: 'left_over', by: 3, code: null, field: null, checks: [], notes: [] }) }] }, gfi: {} };
  const file = concat(header({ program: 408 }), rec('R', Uint8Array.of(1, 2, 3)));
  const out = buildDump({ allData: readContainer(file, { role: 'gdb' }) }, { layouts });
  const r = out.data.files['AllData.gdb'].recordTypes.R;
  assert.deepEqual(r.verdict.matchedOnlyOne, { 'H-OP': 1, 'H-MAC48': 0 });
  assert.deepEqual(r.tieBreak, { programVersion: 'mac48', decidedByProgramVersion: { 'H-OP': 0, 'H-MAC48': 0 }, stillMoreThanOne: 0, refusedForProgramVersion: 1 });
  assert.match(out.text, /1 matched only H-OP and were not read, because H-OP is not used for routes in a file from BaseCamp 4\.8 for Mac/);
  // In an older file the same route is H-OP's, and nothing is said.
  const older = buildDump({ allData: readContainer(concat(header({ program: 407 }), rec('R', Uint8Array.of(1, 2, 3))), { role: 'gdb' }) }, { layouts });
  assert.equal(older.data.files['AllData.gdb'].recordTypes.R.tieBreak.refusedForProgramVersion, 0);
  assert.ok(!/Decided by the program version/.test(older.text));
});
