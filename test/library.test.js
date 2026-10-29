// Unit tests for src/format/library.js: assembling the Library from located files (FORMAT.md §3-§11), reading
// through SourceFile handles, failures, linking, and a seeded fuzz over fixture libraries. All data is synthetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLibrary, trackShape, LIBRARY_PROBLEMS } from '../src/format/library.js';
import { toDegrees } from '../src/format/gdb.js';
import { buildScenario } from '../tools/fixtures/scenarios.js';

// ---------------------------------------------------------------------------------------------
// Builders (test-only, from FORMAT.md §3)

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
  /** @param {string|Uint8Array} s */
  cstr(s) {
    return this.u8(...(typeof s === 'string' ? new TextEncoder().encode(s) : s), 0);
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
  /** @param {number} lat @param {number} lon */
  pos(lat, lon) {
    return this.i32(semi(lat)).i32(semi(lon));
  }
  bytes() {
    return Uint8Array.from(this.a);
  }
}

/** @param {number} deg */
const semi = (deg) => Math.round((deg * 2 ** 31) / 180);

/**
 * A container file: header (§3.1) then framed records (§3.2).
 * @param {string} signature
 * @param {number} version
 * @param {Array<[string, Uint8Array]>} records
 */
function container(signature, version, records) {
  const b = new B().raw(Array.from(signature, (c) => c.charCodeAt(0))).u16(0x66).u32(2).u8(0x44).u16(version);
  const author = ['test', 'Jan 01 2026', '00:00:00'];
  b.u32(2 + author.reduce((n, s) => n + s.length + 1, 0)).u8(0x41).u16(407);
  for (const s of author) b.cstr(s);
  b.cstr('BaseCamp');
  for (const [type, body] of records) b.u32(body.length).u8(type.charCodeAt(0)).raw(body);
  return b.bytes();
}

/**
 * A waypoint record body under H-KBM (§5).
 * @param {string|Uint8Array} name
 * @param {{cls?: number, lat?: number, lon?: number, alt?: number|null, time?: number|null}} [o]
 */
function waypoint(name, o = {}) {
  const b = new B().cstr(name).u32(o.cls ?? 0).pos(o.lat ?? 46, o.lon ?? 7).cstr('').fdouble(null).u32(0).u32(0);
  b.u8(0, 0, 0, 0, 0, 0, 0).fdouble(o.alt ?? null).fdouble(null).u32(0).fdouble(null).fint(null);
  b.raw([0, 0, 0, 0, 0, 0]).u32(0).fint(o.time ?? null).raw([0, 0, 0]).u32(0);
  return b.bytes();
}

/**
 * A track record body under H-KBM (§6), one segment with tight bounds.
 * @param {string} name
 * @param {Array<[number, number]>} points
 * @param {string} uuid
 */
function track(name, points, uuid) {
  const lats = points.map((p) => semi(p[0]));
  const lons = points.map((p) => semi(p[1]));
  const maxLat = Math.max(...lats);
  const maxLon = Math.max(...lons);
  const minLat = Math.min(...lats);
  const minLon = Math.min(...lons);
  const b = new B().cstr(name).u8(1).u32(0).u32(3).u32(0).cstr('').f64(0).fdouble(null).u8(0);
  b.i32(maxLat).i32(maxLon).i32(minLat).i32(minLon).fdouble(null).f64(0).fint(null).u32(0).u32(1);
  b.u8(0).i32(maxLat).i32(maxLon).i32(minLat).i32(minLon).u32(points.length);
  for (let i = 0; i < points.length; i++) b.i32(lats[i]).i32(lons[i]);
  return b.u32(points.length).cstr(uuid).bytes();
}

/**
 * A route record body (§7) whose via points are by name (L = 0) or by link point.
 * @param {string} name
 * @param {Array<{name: string, at?: [number, number]}>} points
 */
function route(name, points) {
  const b = new B().cstr(name).u8(0).u32(points.length);
  for (const p of points) {
    b.cstr(p.name).u32(0).u8(0).u32(0).u32(0).u32(0).u16(0).u32(0);
    if (p.at) b.u32(1).pos(p.at[0], p.at[1]).u8(0).pos(p.at[0], p.at[1]).pos(p.at[0], p.at[1]);
    else b.u32(0).u8(1);
    b.raw(new Array(8).fill(0xff)).fint(null).fint(null).u32(0);
  }
  return b.u8(0, 0, 0).u8(1).bytes();
}

/**
 * A TrackSegments file (§9) with 17-byte points.
 * @param {Array<{ele: number|null, time: number|null}>} points
 */
function trackSegments(points) {
  const b = new B().raw(Array.from('MsRc', (c) => c.charCodeAt(0))).u16(0x66).u32(2).u8(0x44).u16(188);
  b.u32(2 + 1 + 1 + 1).u8(0x41).u16(407).u8(0, 0, 0).cstr('BaseCamp').u32(points.length);
  for (const p of points) b.fdouble(p.ele).fint(p.time).raw(new Array(15).fill(0));
  return b.bytes();
}

const ROOT = 0xffffffff;
/** @param {number} id @param {string} name @param {number} parent @param {Array<[number, number]>} children */
const F = (id, name, parent, children) => {
  const b = new B().u32(id).cstr(name).u32(parent).u32(children.length);
  for (const [t, c] of children) b.u32(t).u32(c);
  return /** @type {[string, Uint8Array]} */ (['F', b.u8(1).bytes()]);
};
/** @param {number} id @param {string} name @param {number} parent */
const I = (id, name, parent) => /** @type {[string, Uint8Array]} */ (['I', new B().u32(id).cstr(name).u32(0).u32(parent).bytes()]);
/** @param {"T"|"W"|"R"} type @param {number} list @param {string|Uint8Array} name @param {number} [cls] */
const REF = (type, list, name, cls = 0) => {
  const b = new B().u32(list).cstr(name);
  if (type === 'W') b.u32(cls);
  else if (type === 'T') b.u32(0);
  else b.u8(0);
  return /** @type {[string, Uint8Array]} */ ([type, b.bytes()]);
};
const END = /** @type {[string, Uint8Array]} */ (['X', new B().cstr('EndOfFile').bytes()]);

/**
 * A SourceFile (intake.js) over bytes, counting reads.
 * @param {string} name
 * @param {Uint8Array} bytes
 * @param {{origin?: "file"|"zip", fail?: boolean}} [o]
 */
function sourceFile(name, bytes, o = {}) {
  const file = {
    name,
    path: name,
    size: bytes.length,
    lastModified: null,
    origin: o.origin ?? 'file',
    blob: null,
    zip: null,
    reads: 0,
    released: 0,
    /** @param {number} [start] @param {number} [end] */
    async bytes(start = 0, end = bytes.length) {
      file.reads++;
      if (o.fail) throw Object.assign(new Error('read failed'), { code: 'read_failed' });
      return bytes.slice(start, Math.min(end, bytes.length));
    },
    release() {
      file.released++;
    },
  };
  return file;
}

const UUID = '6f1c2d3e-4a5b-4c6d-8e7f-0123456789ab';

function sampleLibrary() {
  const gdb = container('MsRc', 188, [
    ['W', waypoint('Spring', { alt: 1500, time: 1700000000 })],
    ['W', waypoint('Hut', { lat: 46.5, lon: 7.5 })],
    ['W', waypoint('Map point', { cls: 8 })],
    ['R', route('Up', [{ name: 'Spring' }, { name: 'Pass', at: [46.2, 7.2] }])],
    ['T', track('Ridge', [[46.1, 7.1], [46.2, 7.2]], UUID)],
    ['V', Uint8Array.of(0, 1)],
    END,
  ]);
  const gfi = container('DifG', 188, [
    F(ROOT, 'My Collection', ROOT, [[1, 0], [0, 1]]),
    F(0, 'Alps', ROOT, [[0, 0]]),
    I(0, 'Day 1', 0),
    I(1, 'Favourites', ROOT),
    REF('R', 0, 'Up'),
    REF('T', 0, 'Ridge'),
    REF('W', 0, 'Spring'),
    REF('W', 1, 'Spring'),
    REF('W', 1, 'Map point', 8),
  ]);
  const ts = trackSegments([
    { ele: 1000, time: 1700000000 },
    { ele: null, time: 1700000060 },
  ]);
  return { gdb, gfi, ts };
}

// ---------------------------------------------------------------------------------------------

test('a small library: items, tree, links, track elevation and time, route via points', async () => {
  const { gdb, gfi, ts } = sampleLibrary();
  /** @type {Array<{phase: string, done: number, total: number}>} */
  const progress = [];
  const tsFile = sourceFile(UUID.toUpperCase(), ts);
  const { library, details } = await readLibrary(
    { allData: sourceFile('AllData.gdb', gdb), folderData: sourceFile('FolderData.gfi', gfi), trackSegments: new Map([[UUID.toUpperCase(), tsFile]]) },
    { onProgress: (p) => progress.push(p) },
  );
  assert.equal(details.fatal, null);
  assert.equal(library.treeMissing, false);
  assert.deepEqual(library.meta, { source: 'BaseCamp library', version: '188' });
  assert.deepEqual(
    library.items.map((i) => `${i.kind}:${i.id}:${i.name}`),
    ['waypoint:w0:Spring', 'waypoint:w1:Hut', 'route:r0:Up', 'track:t0:Ridge'],
  );
  const spring = /** @type {import('../src/model.js').Waypoint} */ (library.items[0]);
  assert.deepEqual([spring.ele, spring.time, spring.lat], [1500, 1700000000000, toDegrees(semi(46))]);
  const route0 = /** @type {import('../src/model.js').Route} */ (library.items[2]);
  assert.deepEqual(route0.points.map((p) => [p.name, p.lat, p.lon]), [
    ['Spring', toDegrees(semi(46)), toDegrees(semi(7))],
    ['Pass', toDegrees(semi(46.2)), toDegrees(semi(7.2))],
  ]);
  const ridge = /** @type {import('../src/model.js').Track} */ (library.items[3]);
  assert.equal(ridge.color, 'DarkGreen');
  assert.equal(ridge.colorIndex, 3);
  assert.deepEqual(ridge.segments, [
    [
      { lat: toDegrees(semi(46.1)), lon: toDegrees(semi(7.1)), ele: 1000, time: 1700000000000 },
      { lat: toDegrees(semi(46.2)), lon: toDegrees(semi(7.2)), ele: null, time: 1700000060000 },
    ],
  ]);
  assert.deepEqual(trackShape(ridge), { points: 2, segments: 1, withElevation: true, withTime: true, withHeartRate: false, withTemperature: false });
  assert.equal(ridge.sensorData, false, 'no heart rate or temperature in this file (B44)');
  assert.equal(details.elevationTime.get('t0'), 'attached');
  assert.equal(tsFile.released, 1);
  // Segments are rebuilt on each read: changing one copy changes nothing, and JSON carries them.
  ridge.segments[0][0].lat = 0;
  assert.notEqual(ridge.segments[0][0].lat, 0);
  assert.equal(JSON.parse(JSON.stringify(ridge)).segments[0].length, 2);

  assert.deepEqual(
    library.folders.map((f) => [f.id, f.name, f.type, f.parentId, f.itemIds]),
    [
      ['f4294967295', 'My Collection', 'folder', null, []],
      ['f0', 'Alps', 'folder', 'f4294967295', []],
      ['l0', 'Day 1', 'list', 'f0', ['r0', 't0', 'w0']],
      ['l1', 'Favourites', 'list', 'f4294967295', ['w0']],
    ],
  );
  assert.equal(details.multiListItems, 1);
  const codes = Object.fromEntries(library.problems.map((p) => [p.code, p.count]));
  assert.deepEqual(codes, { waypoint_class_not_exported: 1, item_in_several_lists: 1, not_in_any_list: 1 });
  assert.ok(library.problems.every((p) => p.message === LIBRARY_PROBLEMS[p.code].message));
  assert.deepEqual([...new Set(progress.map((p) => p.phase))], ['reading', 'parsing', 'linking']);
  assert.ok(progress.every((p) => p.done <= p.total));
});

test('no FolderData.gfi, or an unreadable one: flat, with a plain-words problem', async () => {
  const { gdb, gfi } = sampleLibrary();
  const none = await readLibrary({ allData: sourceFile('AllData.gdb', gdb), folderData: null });
  assert.equal(none.library.treeMissing, true);
  assert.deepEqual(none.library.folders, []);
  assert.equal(none.library.items.length, 4);
  assert.ok(none.library.problems.some((p) => p.code === 'no_folder_data' && p.level === 'report'));
  assert.ok(none.library.problems.some((p) => p.code === 'track_segments_missing'));

  const broken = gfi.slice();
  broken[0] = 0x58;
  const bad = await readLibrary({ allData: sourceFile('AllData.gdb', gdb), folderData: sourceFile('FolderData.gfi', broken) });
  assert.equal(bad.library.treeMissing, true);
  assert.ok(bad.library.problems.some((p) => p.code === 'folder_data_unreadable'));
});

test('a missing, unreadable or too large AllData.gdb is fatal, in plain words, without throwing', async () => {
  const { gdb, gfi } = sampleLibrary();
  const missing = await readLibrary({ allData: null, folderData: sourceFile('FolderData.gfi', gfi) });
  assert.equal(missing.details.fatal?.code, 'read_failed');
  assert.deepEqual(missing.library.items, []);
  assert.ok(missing.library.problems.some((p) => p.code === 'read_failed'));
  assert.equal(missing.library.folders.length, 4, 'the tree is still shown');

  const failing = await readLibrary({ allData: sourceFile('AllData.gdb', gdb, { fail: true }), folderData: null });
  assert.equal(failing.details.fatal?.code, 'read_failed');

  const big = await readLibrary({ allData: sourceFile('AllData.gdb', gdb), folderData: null }, { limits: { maxAllDataBytes: 100 } });
  assert.equal(big.details.fatal?.code, 'all_data_too_large');

  const garbage = await readLibrary({ allData: sourceFile('AllData.gdb', new Uint8Array(4096).fill(7)), folderData: null });
  assert.equal(garbage.details.fatal?.code, 'not_a_library_file');
  // @ts-expect-error hostile input
  const nonsense = await readLibrary(null);
  assert.equal(nonsense.details.fatal?.code, 'read_failed');
});

test('versions: exported 1.7-1.9 and old 1.15-1.38 are refused; others outside 188 are experimental', async () => {
  const records = /** @type {Array<[string, Uint8Array]>} */ ([['W', waypoint('A')], END]);
  for (const [version, fatal, experimental] of /** @type {Array<[number, string|null, boolean]>} */ ([
    [109, 'exported_file_not_library', false],
    [135, 'unsupported_version', false],
    [100, 'unsupported_version', false],
    [170, null, true],
    [200, null, true],
    [188, null, false],
  ])) {
    const { library, details } = await readLibrary({ allData: sourceFile('AllData.gdb', container('MsRc', version, records)), folderData: null });
    assert.equal(details.fatal?.code ?? null, fatal, `${version}`);
    assert.equal(details.experimental, experimental, `${version}`);
    assert.equal(library.problems.some((p) => p.code === 'experimental_version'), experimental, `${version}`);
  }
});

test('a route point with link coordinates keeps its waypoint\'s elevation only at the same position', async () => {
  const gdb = container('MsRc', 188, [
    ['W', waypoint('Spring', { alt: 1500, time: 1700000000 })],
    ['R', route('Up', [{ name: 'Spring', at: [46, 7] }, { name: 'Spring', at: [46.2, 7.2] }])],
    END,
  ]);
  const { library } = await readLibrary({ allData: sourceFile('AllData.gdb', gdb), folderData: null, trackSegments: new Map() });
  const up = /** @type {import('../src/model.js').Route} */ (library.items.find((i) => i.kind === 'route'));
  assert.deepEqual(up.points.map((p) => p.ele), [1500, null]);
});

test('reading: folder files go in 16 MiB windows; backup entries in one call; handles are released', async () => {
  const { gdb } = sampleLibrary();
  const big = new Uint8Array(gdb.length - 15 + 17 * 2 ** 20); // the sample without its 'X' record, then zeros
  big.set(gdb.subarray(0, gdb.length - 15));
  const file = sourceFile('AllData.gdb', big);
  const r = await readLibrary({ allData: file, folderData: null });
  assert.equal(file.reads, 2);
  assert.equal(file.released, 1);
  assert.equal(r.library.items.length, 4);
  assert.ok(r.library.problems.some((p) => p.code === 'zero_padding' && p.level === 'dump'));

  const zipped = sourceFile('AllData.gdb', gdb, { origin: 'zip' });
  await readLibrary({ allData: zipped, folderData: null });
  assert.equal(zipped.reads, 1);
});

test('TrackSegments problems leave the positions in place', async () => {
  const { gdb, gfi } = sampleLibrary();
  const failing = await readLibrary({
    allData: sourceFile('AllData.gdb', gdb),
    folderData: sourceFile('FolderData.gfi', gfi),
    trackSegments: new Map([[UUID, sourceFile(UUID, new Uint8Array(1), { fail: true })]]),
  });
  assert.equal(failing.details.elevationTime.get('t0'), 'unreadable');
  assert.ok(failing.library.problems.some((p) => p.code === 'track_segments_unreadable'));
  const wrongCount = await readLibrary({
    allData: sourceFile('AllData.gdb', gdb),
    folderData: null,
    trackSegments: new Map([[UUID, sourceFile(UUID, trackSegments([{ ele: 1, time: 1 }]))], ['other', sourceFile('other', new Uint8Array(3))]]),
  });
  assert.equal(wrongCount.details.elevationTime.get('t0'), 'mismatch');
  assert.ok(wrongCount.library.problems.some((p) => p.code === 'track_segments_unused' && p.level === 'dump'));
  const ridge = wrongCount.library.items.find((i) => i.kind === 'track');
  assert.equal(/** @type {any} */ (ridge).segments[0][0].ele, null);
  assert.equal(wrongCount.diagnostics.trackSegments?.length, 2);
});

test('linking: unknown lists, repeated entries, NFC-only matches, duplicates and classes', async () => {
  const composed = 'Café';
  const decomposed = 'Café';
  const gdb = container('MsRc', 188, [
    ['W', waypoint(composed)],
    ['W', waypoint('Twin')],
    ['W', waypoint('Twin', { lat: 47 })],
    ['W', waypoint('Twin', { cls: 1 })],
    ['W', waypoint('Lonely')],
    ['W', waypoint('Ghost', { cls: 8 })],
    ['T', track('Twin', [[1, 1]], UUID)],
    END,
  ]);
  const gfi = container('DifG', 188, [
    F(ROOT, 'My Collection', ROOT, [[0, 0], [0, 1]]),
    I(0, 'A', ROOT),
    I(1, 'B', ROOT),
    REF('W', 0, decomposed),
    REF('W', 0, 'Twin'),
    REF('W', 1, 'Twin'),
    REF('W', 1, 'Twin', 1),
    REF('W', 1, 'Twin', 1),
    REF('W', 7, 'Lonely'),
    REF('W', 0, 'Nobody'),
    REF('W', 0, 'Ghost', 8),
    REF('T', 1, 'Twin'),
  ]);
  const { library, details } = await readLibrary({ allData: sourceFile('AllData.gdb', gdb), folderData: sourceFile('FolderData.gfi', gfi) });
  const codes = Object.fromEntries(library.problems.map((p) => [p.code, p.count]));
  assert.equal(codes.name_matched_after_normalising, 1);
  assert.equal(codes.reference_to_unknown_list, 1);
  assert.equal(codes.listed_but_not_found, 1);
  assert.equal(codes.item_repeated_in_list, 1);
  assert.equal(codes.duplicate_names, 1);
  assert.equal(codes.not_in_any_list, 1, 'Lonely: its only list does not exist');
  assert.deepEqual(library.ambiguous, ['w1', 'w2']);
  assert.deepEqual(details.duplicates.map((d) => [d.kind, d.name, d.copies, d.itemIds, d.listIds]), [['waypoint', 'Twin', 2, ['w1', 'w2'], ['l0', 'l1']]]);
  const lists = Object.fromEntries(library.folders.map((f) => [f.name, f.itemIds]));
  assert.deepEqual(lists.A, ['w0']);
  assert.deepEqual(lists.B, ['w3', 't0'], 'class 1 is a different key; the track is a different kind');
});

test('a waypoint whose position cannot be read is listed by name with the lists that named it', async () => {
  const broken = waypoint('Lost');
  new DataView(broken.buffer).setInt32(5 + 4, 2 ** 30 + 1, true); // latitude beyond 90 degrees
  const gdb = container('MsRc', 188, [['W', broken], ['W', waypoint('Fine')], END]);
  const gfi = container('DifG', 188, [F(ROOT, 'Root', ROOT, [[0, 0]]), I(0, 'L', ROOT), REF('W', 0, 'Lost'), REF('W', 0, 'Fine')]);
  const { library } = await readLibrary({ allData: sourceFile('AllData.gdb', gdb), folderData: sourceFile('FolderData.gfi', gfi) });
  assert.deepEqual(library.items.map((i) => i.name), ['Fine']);
  assert.deepEqual(library.notConverted, [{ kind: 'waypoint', name: 'Lost', reason: 'waypoint_not_decoded', listIds: ['l0'] }]);
  const codes = library.problems.map((p) => p.code);
  assert.ok(codes.includes('waypoint_not_decoded'));
  assert.ok(!codes.includes('listed_but_not_found'));
});

test('raw-byte names: Latin-1 names link by their bytes and are decoded as windows-1252', async () => {
  const latin = Uint8Array.of(0x5a, 0xfc, 0x72, 0x69, 0x63, 0x68, 0x80);
  const gdb = container('MsRc', 188, [['W', waypoint(latin)], END]);
  const gfi = container('DifG', 188, [F(ROOT, 'Root', ROOT, [[0, 0]]), I(0, 'L', ROOT), REF('W', 0, latin)]);
  const { library } = await readLibrary({ allData: sourceFile('AllData.gdb', gdb), folderData: sourceFile('FolderData.gfi', gfi) });
  assert.equal(library.items[0].name, 'Zürich€');
  assert.deepEqual(library.folders[1].itemIds, ['w0']);
  assert.ok(library.problems.some((p) => p.code === 'text_not_utf8'));
});

test('fuzz: truncations and byte flips of fixture libraries never throw and always finish', async () => {
  let seed = 0x5eed1234;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 2 ** 32;
  };
  const started = performance.now();
  let cases = 0;
  for (const name of ['waypoint-details', 'multi-segment-tracks', 'routes', 'nested-tree', 'tracks-elevation-time']) {
    const { built } = buildScenario(name);
    for (let k = 0; k < 40; k++) {
      /** @type {Map<string, Uint8Array>} */
      const files = new Map();
      for (const [path, bytes] of built.files) {
        let b = bytes.slice();
        if (rand() < 0.5) {
          const flips = 1 + Math.floor(rand() * 8);
          for (let f = 0; f < flips; f++) b[Math.floor(rand() * b.length)] ^= 1 << Math.floor(rand() * 8);
        }
        if (rand() < 0.3) b = b.subarray(0, Math.floor(rand() * b.length));
        files.set(path, b);
      }
      const ts = new Map();
      for (const [path, b] of files) if (path.startsWith('TrackSegments/')) ts.set(path.slice(14), sourceFile(path, b));
      const all = files.get('AllData.gdb');
      const folder = files.get('FolderData.gfi');
      const result = await readLibrary({
        allData: all ? sourceFile('AllData.gdb', all) : null,
        folderData: folder ? sourceFile('FolderData.gfi', folder) : null,
        trackSegments: ts,
      });
      assert.ok(Array.isArray(result.library.items));
      for (const p of result.library.problems) assert.ok(LIBRARY_PROBLEMS[p.code], p.code);
      for (const item of result.library.items) if (item.kind === 'track') assert.ok(Array.isArray(item.segments));
      cases++;
    }
  }
  assert.equal(cases, 200);
  assert.ok(performance.now() - started < 60000, 'a generous bound: a loaded machine is slower');
});

// ---------------------------------------------------------------------------------------------
// Scale (found by test/fuzz-pipeline.test.js): linking work and memory stay proportional to the input

/**
 * A container file built without spreading bodies into arguments (bodies here can be hundreds of KB).
 * @param {string} signature
 * @param {Array<[string, Uint8Array]>} records
 */
function bigContainer(signature, records) {
  const head = container(signature, 188, []);
  let length = head.length;
  for (const [, body] of records) length += 5 + body.length;
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  out.set(head, 0);
  let at = head.length;
  for (const [type, body] of records) {
    view.setUint32(at, body.length, true);
    out[at + 4] = type.charCodeAt(0);
    out.set(body, at + 5);
    at += 5 + body.length;
  }
  return out;
}

/**
 * A root folder holding `n` lists, and one reference per list built by `refOf`.
 * @param {number} n
 * @param {(list: number) => [string, Uint8Array]} refOf
 */
function manyLists(n, refOf) {
  const root = new Uint8Array(4 + 2 + 4 + 4 + 8 * n + 1);
  const view = new DataView(root.buffer);
  view.setUint32(0, ROOT, true);
  root.set([0x52, 0], 4); // "R"
  view.setUint32(6, ROOT, true);
  view.setUint32(10, n, true);
  for (let i = 0; i < n; i++) view.setUint32(14 + 8 * i + 4, i, true); // [0 = list, id]
  root[root.length - 1] = 1;
  /** @type {Array<[string, Uint8Array]>} */
  const records = [['F', root]];
  for (let i = 0; i < n; i++) records.push(I(i, `L${i}`, ROOT));
  for (let i = 0; i < n; i++) records.push(refOf(i));
  return bigContainer('DifG', records);
}

test('linking stays linear when one not-converted item or one duplicated name is named by many lists', async () => {
  const n = 30000;
  const gdb = container('MsRc', 188, [
    ['W', waypoint('Solo')],
    ['W', waypoint('Twin')],
    ['W', waypoint('Twin', { lat: 47 })],
    ['T', new B().cstr('Broken').u8(7).bytes()], // a name and nothing a layout accepts
    END,
  ]);
  /** @param {(list: number) => [string, Uint8Array]} refOf */
  const timed = async (refOf) => {
    const gfi = manyLists(n, refOf);
    const started = performance.now();
    const read = await readLibrary({ allData: sourceFile('AllData.gdb', gdb), folderData: sourceFile('FolderData.gfi', gfi) });
    return { ms: performance.now() - started, read };
  };
  // Control: the same number of lists and references, each naming the one converted, unique waypoint.
  const solo = await timed((i) => REF('W', i, 'Solo'));
  assert.equal(solo.read.library.folders.filter((f) => f.itemIds.length === 1).length, n);
  const broken = await timed((i) => REF('T', i, 'Broken'));
  assert.equal(broken.read.library.notConverted.length, 1);
  assert.equal(broken.read.library.notConverted[0].listIds.length, n);
  const twin = await timed((i) => REF('W', i, 'Twin'));
  assert.equal(twin.read.details.duplicates.length, 1);
  assert.equal(twin.read.details.duplicates[0].listIds.length, n);
  const budget = 6 * solo.ms + 500;
  assert.ok(broken.ms < budget, `not-converted item in ${n} lists: ${Math.round(broken.ms)} ms, control ${Math.round(solo.ms)} ms`);
  assert.ok(twin.ms < budget, `duplicated name in ${n} lists: ${Math.round(twin.ms)} ms, control ${Math.round(solo.ms)} ms`);
});

test('copies of a duplicated name that were not converted do not each carry every list', async () => {
  // The lists cannot say which copy they meant (FORMAT.md §10), so they are named once, on the duplicate group; each
  // not-converted copy carrying them all made memory grow with copies × lists (here 4 million list ids from 120 KB).
  const n = 2000;
  /** @type {Array<[string, Uint8Array]>} */
  const tracks = Array.from({ length: n }, () => /** @type {[string, Uint8Array]} */ (['T', new B().cstr('Same').u8(7).bytes()]));
  const gdb = bigContainer('MsRc', [...tracks, END]);
  const gfi = manyLists(n, (i) => REF('T', i, 'Same'));
  const { library, details } = await readLibrary({ allData: sourceFile('AllData.gdb', gdb), folderData: sourceFile('FolderData.gfi', gfi) });
  assert.equal(library.notConverted.length, n);
  const listIds = library.notConverted.reduce((sum, nc) => sum + nc.listIds.length, 0);
  assert.ok(listIds <= n, `${listIds} list ids on ${n} not-converted copies named by ${n} lists`);
  assert.equal(details.duplicates.length, 1);
  assert.equal(details.duplicates[0].copies, n);
  assert.equal(details.duplicates[0].listIds.length, n, 'the group names every list');

  // The small case, exactly: a converted and a not-converted copy, named by two lists.
  const small = await readLibrary({
    allData: sourceFile('AllData.gdb', container('MsRc', 188, [['T', track('Pair', [[46.1, 7.1]], UUID)], ['T', new B().cstr('Pair').u8(7).bytes()], END])),
    folderData: sourceFile('FolderData.gfi', container('DifG', 188, [F(ROOT, 'Root', ROOT, [[0, 0], [0, 1]]), I(0, 'A', ROOT), I(1, 'B', ROOT), REF('T', 0, 'Pair'), REF('T', 1, 'Pair')])),
  });
  assert.deepEqual(small.library.notConverted, [{ kind: 'track', name: 'Pair', reason: 'track_not_decoded', listIds: [] }]);
  assert.deepEqual(small.details.duplicates.map((d) => [d.name, d.copies, d.itemIds, d.listIds]), [['Pair', 2, ['t0'], ['l0', 'l1']]]);
  assert.deepEqual(small.library.ambiguous, ['t0']);
});

test('problem messages are US English and do not say the export already happened (the preview shows them first)', () => {
  const british = /\b(?:licences?|cancell(?:ed|ing)|colours?|metres?|organis\w*|normalis\w*|recognis\w*|favourit\w*|behaviour\w*|centres?|catalogues?|analys(?:e|ed|ing)|whilst|amongst|grey)\b/i;
  for (const [code, { message }] of Object.entries(LIBRARY_PROBLEMS)) {
    assert.doesNotMatch(message, british, code);
    assert.doesNotMatch(message, /\bwere (?:exported|written into)\b/, code);
  }
});
