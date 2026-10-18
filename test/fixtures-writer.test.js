// Tests for the independent fixture writer in tools/fixtures/ (FORMAT.md §12).
// They check the writer against FORMAT.md's literal byte examples, check that every scenario's bytes mean what the
// scenario says (framing adds up; each W/T record validates under exactly the intended layout; each TrackSegments file
// under exactly the intended point size), check the expected results' shape and a set of hand-worked expectations, and
// open every .Backup with src/format/unzip.js. Everything is synthetic and generated here; no binary is checked in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ByteSink, encodeText, headerBytes, frameRecord, V_BODY, E_BODY, X_BODY, latToSemicircles, lonToSemicircles,
  semicirclesToDegrees, msToSeconds, waypointBody, trackBody, routeBody, buildLibrary, prng, makeUuid, TWO31,
  E_BODY_MAC48, FOLDER_TAIL_MAC48, SMART_LIST_TAIL,
} from '../tools/fixtures/writer.js';
import {
  readHeader, walkRecords, acceptedWaypointLayouts, acceptedTrackLayouts, acceptedTrackSegmentSizes, readGfi,
} from '../tools/fixtures/inspect.js';
import { PROBLEMS, decodeText } from '../tools/fixtures/expect.js';
import { SCENARIOS, scenarioNames, getScenario, buildScenario } from '../tools/fixtures/scenarios.js';
import { buildBackup, backupEntries } from '../tools/fixtures/backup.js';
import { openZip } from '../src/format/unzip.js';

const hex = (/** @type {Uint8Array} */ b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
const fromHex = (/** @type {string} */ s) => Uint8Array.from(s.trim().split(/\s+/), (h) => parseInt(h, 16));
const T0 = Date.UTC(2026, 0, 10, 8, 0, 0);

// Built once; every scenario is small, so this costs well under a second.
const BUILT = new Map(SCENARIOS.map((s) => [s.name, buildScenario(s)]));

// ---------------------------------------------------------------------------------------------------------------------
// FORMAT.md literal examples and primitive sizes

test('header bytes match the worked example in FORMAT.md §12', () => {
  const expected = fromHex(`
    4D 73 52 63  66 00  02 00 00 00 44 BC 00  23 00 00 00 41 97 01
    62 63 72 2D 66 69 78 74 75 72 65 00  4A 61 6E 20 30 31 20 32 30 32 36 00  30 30 3A 30 30 3A 30 30 00
    42 61 73 65 43 61 6D 70 00`);
  assert.equal(hex(headerBytes('gdb', { programVersion: 407 })), hex(expected));
  const gfi = headerBytes('gfi');
  assert.equal(hex(gfi.subarray(0, 4)), hex(encodeText('DifG')));
  assert.equal(hex(gfi.subarray(4)), hex(expected.subarray(4)));
  const h = readHeader(expected);
  assert.ok(h.ok);
  assert.deepEqual(
    h.ok && [h.signature, h.primary, h.version, h.programVersion, h.application, h.authorExact, h.end],
    ['MsRc', 0x66, 188, 407, 'BaseCamp', true, expected.length],
  );
});

test("'V', 'E' and 'X' records match FORMAT.md §3.2", () => {
  assert.equal(hex(frameRecord('V', V_BODY)), '02 00 00 00 56 00 01');
  assert.equal(hex(frameRecord('E', E_BODY)), '04 00 00 00 45 00 00 00 00');
  assert.equal(hex(frameRecord('X', X_BODY)), '0a 00 00 00 58 45 6e 64 4f 66 46 69 6c 65 00');
  assert.throws(() => frameRecord('XY', new Uint8Array(0)), RangeError);
});

test('semicircles follow FORMAT.md §2 exactly, including the +180° wrap', () => {
  assert.equal(latToSemicircles(90), 2 ** 30);
  assert.equal(latToSemicircles(-90), -(2 ** 30));
  assert.equal(lonToSemicircles(180), -TWO31, '+180° is not representable; it wraps to -180°');
  assert.equal(lonToSemicircles(-180), -TWO31);
  assert.ok(Object.is(latToSemicircles(-1e-12), 0), 'no negative zero');
  assert.equal(semicirclesToDegrees(2 ** 30), 90);
  assert.equal(semicirclesToDegrees(-TWO31), -180);
  for (const v of [1, -1, 123456789, -987654321, 2 ** 30 - 1]) {
    assert.equal(semicirclesToDegrees(v), (v * 360) / 2 ** 32, 'v·180/2^31 and v·360/2^32 are the same double');
  }
  assert.ok(Math.abs(semicirclesToDegrees(latToSemicircles(47.1)) - 47.1) < 1e-7);
  assert.throws(() => latToSemicircles(90.000001), RangeError);
  assert.throws(() => lonToSemicircles(Number.NaN), RangeError);
});

test('times and text are encoded as described, and impossible values are refused', () => {
  assert.equal(msToSeconds(T0), T0 / 1000);
  assert.throws(() => msToSeconds(1500), RangeError);
  assert.throws(() => msToSeconds(2 ** 31 * 1000), RangeError);
  assert.equal(hex(encodeText('Café', 'latin1')), '43 61 66 e9');
  assert.equal(hex(encodeText('€', 'cp1252')), '80');
  assert.equal(hex(encodeText('œ', 'cp1252')), '9c');
  assert.throws(() => encodeText('œ', 'latin1'), RangeError);
  assert.throws(() => encodeText('a\u0000b'), RangeError);
  assert.throws(() => encodeText('\uD800'), RangeError);
  assert.equal(hex(encodeText({ text: 'é', encoding: 'latin1' })), 'e9');
  assert.equal(decodeText(encodeText('Café', 'latin1')).text, 'Café');
  assert.equal(decodeText(encodeText('€', 'cp1252')).text, '€', 'windows-1252, not ISO-8859-1');
  assert.equal(decodeText(encodeText('Café')).fallback, false);
});

test('primitive and minimum record sizes match FORMAT.md §2, §5.1-§5.2, §6.1 and §7.2', () => {
  assert.equal(new ByteSink().uuid(makeUuid(prng(1))).length, 37);
  assert.equal(new ByteSink().fdouble(null).length, 1);
  assert.equal(new ByteSink().fdouble(1.5).length, 9);
  assert.equal(new ByteSink().fint(7).length, 5);
  assert.equal(new ByteSink().fstring('ab').length, 4);
  const wp = { kind: /** @type {const} */ ('waypoint'), id: 'w', name: '', comment: '', lat: 0, lon: 0 };
  const kbm = waypointBody(wp).body;
  assert.equal(kbm.length, 23 + 33, 'prefix 23 + H-KBM tail 33');
  assert.ok(kbm.subarray(23).every((b) => b === 0), 'the absent H-KBM tail is 33 zero bytes');
  const op = waypointBody({ ...wp, gdb: { layout: 'op' } }).body;
  assert.equal(op.length, 23 + 17, 'prefix 23 + H-OP tail 17');
  assert.ok(op.subarray(23).every((b) => b === 0));
  const uuid = makeUuid(prng(2));
  const tr = { kind: /** @type {const} */ ('track'), id: 't', name: '', segments: [] };
  assert.equal(trackBody(tr, uuid).body.length, 100, 'H-KBM track minimum');
  assert.equal(trackBody({ ...tr, gdb: { layout: 'op' } }, uuid).body.length, 92, 'H-OP track minimum');
  const route = routeBody({ kind: 'route', id: 'r', name: '', points: [{ name: '', lat: 0, lon: 0 }], gdb: { via: [{ byName: true }], noBounds: true } }, prng(3)).body;
  assert.equal(route.length, 1 + 1 + 4 + 43 + 3 + 1 + 21, 'name, auto-name, P, one 43-byte point, Unknown1, no-bounds flag, trailer');
});

test('H-MAC48 sizes match FORMAT.md §15.3-§15.8 and §15.11', () => {
  const wp = { kind: /** @type {const} */ ('waypoint'), id: 'w', name: '', comment: '', lat: 0, lon: 0 };
  const mac48 = waypointBody({ ...wp, gdb: { layout: 'mac48' } }).body;
  assert.equal(mac48.length, 23 + 41, 'prefix 23 + H-KBM tail 33 + 8');
  assert.equal(waypointBody({ ...wp, time: T0, gdb: { layout: 'mac48', otherTime: T0 } }).body.length, 72, 'with both times: 72 (§15.3)');
  const uuid = makeUuid(prng(2));
  const tr = { kind: /** @type {const} */ ('track'), id: 't', name: '', segments: [] };
  assert.equal(trackBody({ ...tr, gdb: { layout: 'mac48' } }, uuid).body.length, 124, 'H-MAC48 track minimum (§15.4)');
  const withEle = { ...tr, segments: [[{ lat: 1, lon: 1, ele: 5, time: null }]] };
  assert.equal(trackBody({ ...withEle, gdb: { layout: 'mac48' } }, uuid).body.length - trackBody(withEle, uuid).body.length, 40, 'the 40-byte tail');
  // One via point by name, no bounds: name, auto-name, P, a 56-byte point, no-bounds flag, 31-byte trailer (§15.5).
  const route = routeBody({ kind: 'route', id: 'r', name: '', points: [{ name: '', lat: 0, lon: 0 }], gdb: { layout: 'mac48' } }, prng(3)).body;
  assert.equal(route.length, 1 + 1 + 4 + 56 + 1 + 4 + 4 + 1 + 1 + 1 + 4 + 1 + 1 + 4 + 10);
  assert.deepEqual([...E_BODY_MAC48], [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(FOLDER_TAIL_MAC48.length, 10);
  assert.deepEqual([...SMART_LIST_TAIL], [1, 0, 0, 0, 0]);
});

test('the acceptance walker can say no: it rejects each hypothesis on the other\'s bytes', () => {
  const wp = { kind: /** @type {const} */ ('waypoint'), id: 'w', name: 'x', comment: '', lat: 1, lon: 2, ele: 5, time: T0 };
  assert.deepEqual(acceptedWaypointLayouts(waypointBody(wp).body), ['kbm']);
  assert.deepEqual(acceptedWaypointLayouts(waypointBody({ ...wp, gdb: { layout: 'op' } }).body), ['op']);
  assert.deepEqual(acceptedWaypointLayouts(waypointBody({ ...wp, gdb: { badFlag: 'altitude' } }).body), []);
  const body = waypointBody(wp).body;
  assert.deepEqual(acceptedWaypointLayouts(body.subarray(0, body.length - 1)), []);
  const tr = { kind: /** @type {const} */ ('track'), id: 't', name: 'y', segments: [[{ lat: 1, lon: 2, ele: null, time: null }, { lat: 1.1, lon: 2.1, ele: null, time: null }]] };
  const tb = trackBody(tr, makeUuid(prng(4))).body;
  assert.deepEqual(acceptedTrackLayouts(tb), ['kbm']);
  assert.deepEqual(acceptedTrackLayouts(tb.subarray(0, tb.length - 1)), []);
  assert.deepEqual(acceptedTrackLayouts(trackBody({ ...tr, gdb: { layout: 'op' } }, makeUuid(prng(4))).body), ['op']);
  assert.deepEqual(acceptedTrackLayouts(trackBody({ ...tr, gdb: { pointOutsideSegment: true } }, makeUuid(prng(4))).body), []);
  // H-MAC48 is H-KBM plus 8 (W) or 24-40 (T) bytes: each walker accepts only its own.
  const wm = waypointBody({ ...wp, gdb: { layout: 'mac48' } }).body;
  assert.deepEqual(acceptedWaypointLayouts(wm), ['mac48']);
  assert.deepEqual(acceptedWaypointLayouts(wm.subarray(0, wm.length - 1)), []);
  const tm = trackBody({ ...tr, gdb: { layout: 'mac48' } }, makeUuid(prng(4))).body;
  assert.deepEqual(acceptedTrackLayouts(tm), ['mac48']);
  assert.deepEqual(acceptedTrackLayouts(trackBody({ ...tr, gdb: { layout: 'mac48', badTailFlag: 2 } }, makeUuid(prng(4))).body), []);
});

test('the writer refuses descriptions that are wrong rather than writing something unintended', () => {
  const w = (/** @type {string} */ id, extra = {}) => ({ kind: /** @type {const} */ ('waypoint'), id, name: id, comment: '', lat: 1, lon: 1, ...extra });
  const bad = [
    { items: [w('a'), w('a')] },
    { items: [w('a')], folders: [{ id: 'l', name: 'L', type: /** @type {const} */ ('list'), parentId: null, itemIds: ['zz'] }] },
    { items: [w('a')], folders: [{ id: 'f', name: 'F', type: /** @type {const} */ ('folder'), parentId: null, itemIds: ['a'] }] },
    { items: [w('a')], folders: [{ id: 'l', name: 'L', type: /** @type {const} */ ('list'), parentId: null, itemIds: [] },
      { id: 'm', name: 'M', type: /** @type {const} */ ('list'), parentId: 'l', itemIds: [] }] },
    { items: [w('a', { name: 'nul\u0000' })] },
    { items: [w('a', { lat: 91 })] },
    { items: [w('a', { time: 1500 })] },
    { items: [w('a', { gdb: { subclass: [1, 2, 3] } })] },
    // H-MAC48 (FORMAT.md §15.11): hooks only where they mean something.
    { items: [w('a', { gdb: { opaque48: [1, 2, 3, 4, 5, 6, 7, 8] } })] },
    { items: [{ kind: /** @type {const} */ ('track'), id: 't', name: 't', segments: [[{ lat: 1, lon: 1, ele: 1, time: T0, hr: 90 }]], ts: { n: /** @type {const} */ (11) } }] },
    { items: [{ kind: /** @type {const} */ ('track'), id: 't', name: 't', segments: [[{ lat: 1, lon: 1, ele: 1, time: T0 }]], ts: { extraByte: { point: 0, byte: 3 } } }] },
    { items: [{ kind: /** @type {const} */ ('track'), id: 't', name: 't', segments: [], gdb: { tail8: [1] } }] },
    { items: [{ kind: /** @type {const} */ ('route'), id: 'r', name: 'r', points: [{ name: 'a', lat: 1, lon: 1 }], gdb: { layout: /** @type {const} */ ('mac48'), via: [{ nonZeroRun: 2 }] } }] },
  ];
  for (const lib of bad) assert.throws(() => buildLibrary(lib), (e) => e instanceof RangeError || e instanceof TypeError, JSON.stringify(lib));
});

// ---------------------------------------------------------------------------------------------------------------------
// Scenario set

test('the scenario set covers everything the task and FORMAT.md §12 ask for', () => {
  const names = scenarioNames();
  assert.equal(new Set(names).size, names.length, 'names are unique');
  for (const required of ['minimal', 'nested-tree', 'item-in-two-lists', 'duplicate-names', 'no-folder-data',
    'tracks-elevation-time', 'multi-segment-tracks', 'routes', 'text-encodings', 'waypoint-details',
    'corrupt-truncated-record', 'corrupt-absurd-length', 'corrupt-bad-signature', 'corrupt-wrong-version', 'corrupt-garbage',
    'hop-layouts', 'tracksegments-variants', 'privacy-sentinels']) {
    assert.ok(names.includes(required), required);
  }
  for (const s of SCENARIOS) {
    assert.ok(s.title && s.covers.length > 0, `${s.name} says what it covers`);
    assert.equal(typeof s.supportedPath, 'boolean');
  }
  assert.throws(() => getScenario('no such scenario'), RangeError);
  const programVersions = new Set(SCENARIOS.map((s) => s.library.header?.programVersion));
  for (const v of [402, 407, 408, 480, 4813]) assert.ok(programVersions.has(v), `program version ${v} is used`);
});

test('every scenario serialises, deterministically, into small files', () => {
  let total = 0;
  for (const s of SCENARIOS) {
    const a = /** @type {ReturnType<typeof buildScenario>} */ (BUILT.get(s.name));
    const b = buildScenario(s.name);
    assert.ok(a.built.files.has('AllData.gdb'), s.name);
    assert.deepEqual([...a.built.files.keys()], [...b.built.files.keys()], s.name);
    for (const [path, bytes] of a.built.files) {
      assert.ok(bytes.length > 0, `${s.name} ${path}`);
      assert.ok(bytes.length < 64 * 1024, `${s.name} ${path} stays small`);
      assert.deepEqual(bytes, b.built.files.get(path), `${s.name} ${path} is deterministic`);
      total += bytes.length;
    }
    assert.deepEqual(a.expected, b.expected, `${s.name} expected result is deterministic`);
    assert.equal(a.built.files.has('FolderData.gfi'), s.library.gfi !== null, s.name);
  }
  assert.ok(total < 200 * 1024, `all fixtures together are ${total} bytes`);
});

test('container framing is self-consistent: header plus framed records add up to the file length', () => {
  for (const s of SCENARIOS) {
    const { built } = /** @type {ReturnType<typeof buildScenario>} */ (BUILT.get(s.name));
    for (const [path, m] of built.manifest) {
      if (m.role === 'trackSegments' || s.library.gdb?.replace && path === 'AllData.gdb') continue;
      const bytes = /** @type {Uint8Array} */ (built.files.get(path));
      const where = `${s.name} ${path}`;
      const h = readHeader(bytes);
      const headerSpec = { ...s.library.header, ...(path === 'AllData.gdb' ? s.library.gdb?.header : s.library.gfi?.header) };
      if ((headerSpec.dLength ?? 2) !== 2) {
        assert.equal(h.ok, false, where);
        continue;
      }
      assert.ok(h.ok, where);
      if (!h.ok) continue;
      assert.equal(h.end, m.headerEnd, `${where} header end`);
      assert.equal(h.version, headerSpec.version ?? 188, where);
      assert.equal(h.programVersion, headerSpec.programVersion ?? 407, where);
      assert.equal(h.application, headerSpec.application ?? 'BaseCamp', where);
      assert.equal(h.authorExact, (headerSpec.aExtra ?? 0) === 0, where);
      assert.equal(m.length, bytes.length, where);

      const walk = walkRecords(bytes, h.end);
      const cut = m.records.findIndex((r) => r.lenField !== r.len || r.bodyStart + r.len > bytes.length);
      const intact = cut < 0 ? m.records : m.records.slice(0, cut);
      assert.deepEqual(
        walk.records.map((r) => [r.type, r.offset, r.len]),
        intact.map((r) => [r.type, r.offset, r.len]),
        `${where} records`,
      );
      if (cut >= 0) {
        assert.equal(walk.stop, 'truncated', where);
        assert.equal(walk.truncatedAt, m.records[cut].offset, where);
        continue;
      }
      const framed = h.end + m.records.reduce((sum, r) => sum + 5 + r.len, 0);
      const junk = path === 'AllData.gdb' && s.library.gdb?.end === 'VEX+junk' ? (s.library.gdb.junkAfterEnd ?? 7) : 0;
      assert.equal(framed + junk, bytes.length, `${where}: lengths add up`);
      if (path === 'AllData.gdb') {
        const end = s.library.gdb?.end ?? 'VEX';
        assert.equal(walk.stop, end === 'VE' ? 'eof' : 'x', where);
        assert.equal(walk.afterX, junk, where);
        const types = m.records.map((r) => r.type);
        assert.equal(types.at(-1), end === 'VE' ? 'E' : 'X', `${where}: last record`);
        assert.equal(types.filter((t) => t === 'V').length, 1, `${where}: one 'V' record`);
      } else {
        assert.equal(walk.stop, 'eof', `${where}: GFI has no end record`);
      }
    }
  }
});

test('every W and T record validates under exactly its intended layout hypothesis, and no other', () => {
  let checked = 0;
  for (const s of SCENARIOS) {
    const { built } = /** @type {ReturnType<typeof buildScenario>} */ (BUILT.get(s.name));
    const m = built.manifest.get('AllData.gdb');
    const bytes = /** @type {Uint8Array} */ (built.files.get('AllData.gdb'));
    for (const r of m?.records ?? []) {
      if ((r.type !== 'W' && r.type !== 'T') || r.lenField !== r.len || r.bodyStart + r.len > bytes.length) continue;
      const body = bytes.subarray(r.bodyStart, r.bodyStart + r.len);
      const accepted = r.type === 'W' ? acceptedWaypointLayouts(body) : acceptedTrackLayouts(body);
      assert.deepEqual(accepted, r.intended === 'none' ? [] : [r.intended], `${s.name} ${r.type} ${r.item}`);
      checked++;
    }
  }
  assert.ok(checked >= 80, `checked ${checked} records`);
});

test('every TrackSegments file is accepted at exactly its intended point size and decodes to the written values', () => {
  let checked = 0;
  for (const s of SCENARIOS) {
    const { built } = /** @type {ReturnType<typeof buildScenario>} */ (BUILT.get(s.name));
    for (const [path, m] of built.manifest) {
      if (m.role !== 'trackSegments') continue;
      const res = acceptedTrackSegmentSizes(/** @type {Uint8Array} */ (built.files.get(path)));
      assert.deepEqual(res.accepted, m.intendedN, `${s.name} ${path}`);
      if (res.accepted.length === 1) {
        const written = /** @type {Array<{ele: number|null, time: number|null}>} */ (m.points);
        assert.equal(res.count, written.length);
        res.values?.forEach((v, i) => {
          assert.ok(Object.is(v.ele, written[i].ele), `${s.name} ${path} point ${i} elevation`);
          assert.equal(v.time, written[i].time === null ? null : written[i].time / 1000, `${s.name} ${path} point ${i} time`);
        });
      }
      checked++;
    }
  }
  assert.ok(checked >= 40, `checked ${checked} files`);
});

test('FolderData.gfi holds the root first, the F/I tails asked for, and one reference per list entry', () => {
  for (const s of SCENARIOS) {
    const { built } = /** @type {ReturnType<typeof buildScenario>} */ (BUILT.get(s.name));
    const bytes = built.files.get('FolderData.gfi');
    if (!bytes) continue;
    const g = readGfi(bytes);
    assert.ok(g, s.name);
    if (!g) continue;
    assert.equal(g.walk.stop, 'eof');
    assert.equal(g.folders[0].id, 0xffffffff, `${s.name}: root first`);
    assert.equal(g.folders[0].parent, 0xffffffff, `${s.name}: root is its own parent`);
    const types = g.walk.records.map((r) => r.type).join('');
    assert.match(types, /^F+I*R*T*W*K*J*$/, `${s.name}: record order F* I* R* T* W* K* J*`);
    const folders = (s.library.folders ?? []).filter((f) => f.type === 'folder');
    const lists = (s.library.folders ?? []).filter((f) => f.type === 'list');
    // FORMAT.md §8.1: one byte, 1; §15.8: Mac 4.8 writes ten (u8 1, u32 0, i32 time, u8 0).
    const defaultFolderTail = s.library.gfi?.folderTail === 'mac48' ? [1, 0, 0, 0, 0, 0x80, 0xb8, 0x55, 0x69, 0] : [1];
    assert.equal(g.lists.length, lists.length, s.name);
    lists.forEach((l, i) => {
      const createdBy = l.createdBy ?? 0;
      // FORMAT.md §8.2 and §15.11: no tail for 0, 1 0 0 0 0 for a smart list (3), OP's nine bytes otherwise.
      const want = l.tail ? Array.from(l.tail) : createdBy === 0 ? [] : createdBy === 3 ? [1, 0, 0, 0, 0] : [1, 1, 0, 0, 0, 9, 0, 0, 0];
      assert.deepEqual(g.lists[i].tail, want, `${s.name} list ${l.id} tail`);
      assert.equal(g.lists[i].createdBy, l.createdBy ?? 0);
    });
    assert.equal(g.folders.length, 1 + folders.length + (s.library.gfi?.duplicateFolder ? 1 : 0), `${s.name}: root, folders, duplicate`);
    folders.forEach((f, i) => {
      const tail = g.folders[1 + i + (s.library.gfi?.duplicateFolder && folders.findIndex((x) => x.id === s.library.gfi?.duplicateFolder) < i ? 1 : 0)].tail;
      assert.deepEqual(tail, f.tail ? Array.from(f.tail) : defaultFolderTail, `${s.name} folder ${f.id} tail`);
    });
    assert.deepEqual(g.folders[0].tail, defaultFolderTail, `${s.name}: root tail`);
    const listRefs = lists.reduce((n, l) => n + (l.itemIds ?? []).length, 0) + (s.library.gfi?.extraRefs ?? []).length;
    assert.equal(g.refs.length, listRefs, `${s.name}: one reference per list entry`);
    const listIds = new Set(g.lists.map((l) => l.id));
    for (const r of g.refs) assert.ok(listIds.has(r.list), `${s.name}: reference to an existing list`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Expected results

test('expected results are well formed and use only the documented problem vocabulary', () => {
  for (const s of SCENARIOS) {
    const { expected: e } = /** @type {ReturnType<typeof buildScenario>} */ (BUILT.get(s.name));
    for (const p of e.problems) assert.equal(PROBLEMS[p.code]?.level, 'report', `${s.name} ${p.code}`);
    for (const p of e.counted) assert.equal(PROBLEMS[p.code]?.level, 'count', `${s.name} ${p.code}`);
    for (const code of e.tolerated) assert.ok(code in PROBLEMS, `${s.name} tolerated ${code}`);
    for (const p of [...e.problems, ...e.counted]) assert.ok(p.count === null || (Number.isInteger(p.count) && p.count > 0));
    if (e.fatal) {
      assert.deepEqual(e.items, [], s.name);
      assert.equal(e.tree, null, s.name);
      assert.ok(e.problems.some((p) => p.code === e.fatal?.code), s.name);
      continue;
    }
    const paths = new Set((e.tree ?? []).map((t) => JSON.stringify(t.path)));
    const listPaths = new Set((e.tree ?? []).filter((t) => t.type === 'list').map((t) => JSON.stringify(t.path)));
    for (const t of e.tree ?? []) if (t.path.length > 1) assert.ok(paths.has(JSON.stringify(t.path.slice(0, -1))), `${s.name} parent of ${t.path}`);
    for (const it of e.items) {
      assert.ok(['lists', 'not-in-any-list', 'duplicate-names', 'flat'].includes(it.placement), s.name);
      assert.equal(it.placement === 'flat', s.library.gfi === null, `${s.name}: flat only without a GFI`);
      assert.equal(it.placement === 'lists', it.lists.length > 0, `${s.name} ${it.name}`);
      for (const l of it.lists) assert.ok(listPaths.has(JSON.stringify(l)), `${s.name} ${it.name} list exists`);
      const coords = it.kind === 'waypoint' ? [it] : it.kind === 'route' ? it.points : it.segments.flat();
      for (const c of coords) {
        assert.ok(Number.isFinite(c.lat) && c.lat >= -90 && c.lat <= 90, s.name);
        assert.ok(Number.isFinite(c.lon) && c.lon >= -180 && c.lon < 180, s.name);
        assert.equal(c.lat, semicirclesToDegrees(latToSemicircles(c.lat)), `${s.name}: coordinates are exactly what semicircles decode to`);
      }
      const values = it.kind === 'waypoint' ? [it] : it.kind === 'track' ? it.segments.flat() : [];
      for (const v of values) {
        assert.ok(v.ele === null || (Number.isFinite(v.ele) && v.ele < 1e24), s.name);
        assert.ok(v.time === null || (Number.isInteger(v.time) && v.time > 0 && v.time % 1000 === 0), s.name);
      }
    }
    for (const d of e.duplicates) {
      assert.equal(e.items.filter((i) => i.kind === d.kind && i.name === d.name && i.placement === 'duplicate-names').length, d.copies, s.name);
    }
    if (s.library.gfi === null) assert.ok(e.problems.some((p) => p.code === 'no_folder_data'));
  }
  for (const [code, p] of Object.entries(PROBLEMS)) {
    assert.match(p.message, /^[A-Z][^]*\.$/, `${code} message is a plain sentence`);
    assert.ok(p.ref.startsWith('FORMAT.md'), code);
  }
});

test('problem messages never carry a scenario name, comment or list name', () => {
  const texts = new Set();
  for (const s of SCENARIOS) {
    for (const it of s.library.items) if (it.name.length > 3) texts.add(it.name);
    for (const f of s.library.folders ?? []) if (typeof f.name === 'string' && f.name.length > 3) texts.add(f.name);
  }
  for (const p of Object.values(PROBLEMS)) for (const t of texts) assert.ok(!p.message.includes(t), `"${p.message}" contains "${t}"`);
});

test('hand-worked expectation: minimal', () => {
  const lat = semicirclesToDegrees(latToSemicircles(47.1));
  const lon = semicirclesToDegrees(lonToSemicircles(8.2));
  assert.deepEqual(BUILT.get('minimal')?.expected, {
    fatal: null,
    versions: { gdb: 188, gfi: 188 },
    experimental: false,
    tree: [{ path: ['My Collection'], type: 'folder' }, { path: ['My Collection', 'Day hikes'], type: 'list' }],
    items: [{
      kind: 'waypoint', name: 'Trailhead', comment: '', icon: 0, class: 0, lat, lon, ele: null, time: null,
      placement: 'lists', lists: [['My Collection', 'Day hikes']], specId: 'w1',
    }],
    notDecoded: [],
    routesNotConverted: [],
    duplicates: [],
    problems: [],
    counted: [],
    tolerated: [],
  });
});

test('hand-worked expectation: duplicate names and look-alikes', () => {
  const e = /** @type {ReturnType<typeof buildScenario>} */ (BUILT.get('duplicate-names')).expected;
  const A = ['My Collection', 'List A'];
  const B = ['My Collection', 'List B'];
  assert.deepEqual(e.duplicates, [
    { kind: 'waypoint', name: 'Spring', class: 0, copies: 2, referencedBy: [A, B] },
    { kind: 'track', name: 'Loop', class: null, copies: 2, referencedBy: [A, B] },
  ]);
  const placed = (/** @type {string} */ kind, /** @type {string} */ name) =>
    e.items.filter((i) => i.kind === kind && i.name === name).map((i) => [i.placement, i.lists]);
  assert.deepEqual(placed('waypoint', 'Spring'), [['duplicate-names', []], ['duplicate-names', []], ['lists', [A]]]);
  assert.deepEqual(placed('track', 'Pass'), [['lists', [A]]]);
  assert.deepEqual(placed('waypoint', 'Pass'), [['lists', [A]]]);
  assert.deepEqual(e.routesNotConverted, [{ name: 'To the spring', reason: 'via_unresolved', lists: [B] }]);
  assert.deepEqual(placed('route', 'To the pass'), [['lists', [A]]]);
  assert.deepEqual(e.problems, [{ code: 'duplicate_names', count: 2 }, { code: 'route_not_converted', count: 1 }]);
});

test('hand-worked expectation: shared segment endpoints take their twin\'s elevation and time', () => {
  const e = /** @type {ReturnType<typeof buildScenario>} */ (BUILT.get('multi-segment-tracks')).expected;
  const joined = e.items.find((i) => i.name === 'Joined parts');
  assert.ok(joined && joined.kind === 'track');
  if (!joined || joined.kind !== 'track') return;
  const v = joined.segments.map((s) => s.map((p) => [p.ele, p.time === null ? null : (p.time - T0) / 1000]));
  assert.deepEqual(v, [
    [[900, 0], [903, 15], [906, 30], [909, 45]],
    [[909, 45], [912, 60], [915, 75]],
    [[915, 75], [918, 90], [921, 105], [924, 120], [927, 135]],
  ]);
  const ts = /** @type {ReturnType<typeof buildScenario>} */ (BUILT.get('multi-segment-tracks')).built.manifest;
  const file = [...ts.values()].find((m) => m.track === 't2');
  assert.equal(file?.pointCount, 12 - 2, 'M = Σn − (S − 1)');
  const separate = e.items.find((i) => i.name === 'Separate parts, short file');
  assert.ok(separate?.kind === 'track' && separate.segments.flat().every((p) => p.ele === null && p.time === null));
  assert.deepEqual(e.problems, [{ code: 'track_segments_mismatch', count: 1 }, { code: 'track_total_count_unexpected', count: 1 }]);
  assert.deepEqual(e.counted, [{ code: 'empty_segment', count: 1 }]);
  assert.deepEqual(e.tolerated, ['track_segments_not_decoded']);
});

test('hand-worked expectation: folder cycle, dangling child, duplicate ID and parent disagreement', () => {
  const e = /** @type {ReturnType<typeof buildScenario>} */ (BUILT.get('gfi-tree-quirks')).expected;
  const R = 'My Collection';
  assert.deepEqual(e.tree, [
    { path: [R], type: 'folder' },
    { path: [R, 'Alpha'], type: 'folder' },
    { path: [R, 'Alpha', 'Beta'], type: 'folder' },
    { path: [R, 'Alpha', 'Beta', 'Beta list'], type: 'list' },
    { path: [R, 'Alpha', 'Alpha list'], type: 'list' },
    { path: [R, 'Top list'], type: 'list' },
  ]);
  assert.deepEqual(e.items.map((i) => [i.name, i.lists]), [
    ['One', [[R, 'Top list']]], ['Two', [[R, 'Alpha', 'Alpha list']]], ['Three', [[R, 'Alpha', 'Beta', 'Beta list']]],
  ]);
  assert.deepEqual(e.problems, [{ code: 'folder_in_two_places', count: 1 }, { code: 'list_folder_disagreement', count: 1 }]);
  assert.deepEqual(e.counted, [{ code: 'dangling_child', count: 1 }, { code: 'duplicate_id', count: 1 }]);
});

test('hand-worked expectation: mac48-library (smart lists, via points, sensors)', () => {
  const { expected: e, exercises } = /** @type {ReturnType<typeof buildScenario>} */ (BUILT.get('mac48-library'));
  assert.deepEqual(exercises, { W: ['mac48'], T: ['mac48'], TS: [17] });
  assert.deepEqual(e.tree.map((t) => `${t.type}: ${t.path.join(' / ')}`), [
    'folder: My Collection',
    'folder: My Collection / Trips',
    'list: My Collection / Trips / import-list',
    'list: My Collection / Trips / Favourites',
    'list: My Collection / Unlisted Data',
  ]);
  const d = (/** @type {number} */ lat, /** @type {number} */ lon) => [semicirclesToDegrees(latToSemicircles(lat)), semicirclesToDegrees(lonToSemicircles(lon))];
  const routes = Object.fromEntries(e.items.filter((i) => i.kind === 'route').map((r) => [r.name, r.kind === 'route' ? r.points.map((p) => [p.name, ...d(p.lat, p.lon)]) : []]));
  const via = [['Mill start', ...d(-41.2601, 172.4501)], ['Mill bend', ...d(-41.2611, 172.4521)], ['Mill end', ...d(-41.2621, 172.4541)]];
  // 'Single stop' has one via point, so it fits OP's layout too; program version 408 picks H-MAC48 (B43).
  assert.deepEqual(routes, { 'Mill loop': via, 'Bend by name': via, 'Single stop': [['Lone gate', ...d(-41.2631, 172.4561)]] });
  const w = (/** @type {string} */ name) => /** @type {any} */ (e.items.find((i) => i.name === name));
  assert.deepEqual([w('Lakeside camp').ele, w('Lakeside camp').time, w('Lakeside camp').placement, w('Lakeside camp').lists.length], [412.5, T0, 'lists', 2]);
  assert.equal(w('Edited spot').time, T0 + 2 * 60_000, 'time B (creation) wins over time A (modification)');
  assert.deepEqual([w('Only recent').placement, w('Only recent').time], ['not-in-any-list', null], 'only a smart list named it');
  assert.equal(e.items.filter((i) => i.kind === 'waypoint').length, 4, 'class-8 via points are not waypoints');
  assert.deepEqual(w('Ridge run').segments[0].map((/** @type {any} */ p) => p.ele), [300, 303, 306, 309, 312, 315]);
  // B44: heart rate and temperature are kept on the points that hold them, and only there.
  assert.deepEqual(w('Ridge run').segments[0].map((/** @type {any} */ p) => [p.hr, p.atemp]), [[120, 18.5], [121, 19], [122, 19.5], [123, 20], [124, 20.5], [125, 21]]);
  assert.deepEqual(w('Some heart rate').segments[0].map((/** @type {any} */ p) => ['hr' in p ? p.hr : '-', 'atemp' in p]), [['-', false], [95, false], ['-', false], [95, false]]);
  assert.ok(w('Valley walk').segments[0].every((/** @type {any} */ p) => !('hr' in p) && !('atemp' in p)));
  assert.deepEqual(e.problems, [
    { code: 'item_in_several_lists', count: 2 }, { code: 'smart_lists_left_out', count: 2 }, { code: 'track_sensor_data_kept', count: 2 },
  ]);
  assert.deepEqual(e.counted, [{ code: 'not_in_any_list', count: 1 }, { code: 'route_via_point_record', count: 4 }]);
});

test('hand-worked expectation: mac48-negatives routes (an OP-layout route in a 408 file is not decoded, B43)', () => {
  const e = /** @type {ReturnType<typeof buildScenario>} */ (BUILT.get('mac48-negatives')).expected;
  assert.deepEqual(e.items.filter((i) => i.kind === 'route'), []);
  assert.deepEqual(e.routesNotConverted.map((r) => [r.name, r.reason]), [
    ['Noisy run', 'not_decoded'], ['Has settings', 'not_decoded'], ['Old layout', 'not_decoded'],
  ]);
});

test('hand-worked expectation: routes', () => {
  const e = /** @type {ReturnType<typeof buildScenario>} */ (BUILT.get('routes')).expected;
  const d = (/** @type {number} */ lat, /** @type {number} */ lon) => [semicirclesToDegrees(latToSemicircles(lat)), semicirclesToDegrees(lonToSemicircles(lon))];
  const routes = Object.fromEntries(e.items.filter((i) => i.kind === 'route').map((r) => [r.name, r.kind === 'route' ? r.points.map((p) => [p.name, ...d(p.lat, p.lon)]) : []]));
  assert.deepEqual(routes, {
    Direct: [['Start', ...d(46.40, 9.60)], ['Bend', ...d(46.42, 9.62)], ['End', ...d(46.44, 9.64)]],
    'By name': [['Start', ...d(46.40, 9.60)], ['Hut', ...d(46.45, 9.65)], ['Lake', ...d(46.47, 9.68)]],
    'Two points': [['Here', ...d(46.46, 9.66)], ['There', ...d(46.461, 9.667)]],
  });
  assert.deepEqual(e.routesNotConverted.map((r) => [r.name, r.reason]), [
    ['Autorouted', 'autoroute'], ['Bad marker', 'not_decoded'], ['Missing via', 'via_unresolved'],
  ]);
});

test('hand-worked expectation: waypoint details, time fields and classes', () => {
  const e = /** @type {ReturnType<typeof buildScenario>} */ (BUILT.get('waypoint-details')).expected;
  const by = Object.fromEntries(e.items.map((i) => [i.name, i]));
  const min = (/** @type {number|null} */ t) => (t === null ? null : (t - T0) / 60_000);
  const w = (/** @type {string} */ n) => /** @type {import('../tools/fixtures/expect.js').ExpectedWaypoint} */ (by[n]);
  assert.deepEqual([w('Bakery').ele, min(w('Bakery').time), w('Bakery').icon, w('Bakery').comment], [432.5, 0, 18, 'Opens early']);
  assert.deepEqual([w('Viewpoint').ele, min(w('Viewpoint').time), w('Viewpoint').icon], [610, 10, 6]);
  assert.equal(min(w('Probe').time), 20, 'K18 only');
  assert.equal(min(w('Both times').time), 120, 'K22 wins over K18');
  assert.equal(min(w('Older time only').time), 45);
  assert.equal(w('Class one').class, 1);
  assert.equal(by['Class eight'], undefined, 'class 8 is counted, not exported');
  assert.equal(w('Too high').ele, null);
  assert.equal(w('Stop byte').ele, -12.25);
  assert.deepEqual(e.counted, [{ code: 'value_treated_as_absent', count: 1 }, { code: 'waypoint_class_not_exported', count: 1 }]);
  assert.deepEqual(e.problems, []);
});

test('hand-worked expectation: broken waypoints keep name, position, comment and symbol only', () => {
  const e = /** @type {ReturnType<typeof buildScenario>} */ (BUILT.get('waypoint-negatives')).expected;
  for (const i of e.items) {
    if (i.kind !== 'waypoint') continue;
    if (i.name === 'Good one') assert.deepEqual([i.ele, i.time], [100, T0]);
    else assert.deepEqual([i.ele, i.time], [null, null], i.name);
  }
  assert.deepEqual(e.items.filter((i) => i.name === 'Two phones').map((i) => i.kind === 'waypoint' && [i.comment, i.icon]), [['kept', 4]]);
  assert.deepEqual(e.counted, [{ code: 'waypoint_details_not_decoded', count: 6 }]);
});

test('hand-worked expectation: corrupt files', () => {
  const get = (/** @type {string} */ n) => /** @type {ReturnType<typeof buildScenario>} */ (BUILT.get(n)).expected;
  assert.deepEqual(get('corrupt-truncated-record').items.map((i) => i.name), ['Before the cut', 'Also before']);
  assert.deepEqual(get('corrupt-truncated-record').problems, [{ code: 'listed_but_not_found', count: 1 }, { code: 'record_truncated', count: 1 }]);
  assert.deepEqual(get('corrupt-absurd-length').items.map((i) => i.name), ['Survivor']);
  assert.deepEqual(get('corrupt-bad-signature').fatal, { file: 'AllData.gdb', code: 'not_a_library_file' });
  assert.deepEqual(get('corrupt-garbage').fatal, { file: 'AllData.gdb', code: 'not_a_library_file' });
  assert.deepEqual(get('corrupt-wrong-version').fatal, { file: 'AllData.gdb', code: 'unsupported_version' });
  assert.deepEqual(get('corrupt-bad-d-record').fatal, { file: 'AllData.gdb', code: 'unreadable_file_header' });
  assert.deepEqual(get('version-exported').fatal, { file: 'AllData.gdb', code: 'exported_file_not_library' });
  assert.deepEqual(get('version-exported').versions, { gdb: 109, gfi: null }, 'a readable header still names its version');
  assert.deepEqual(get('corrupt-wrong-version').versions, { gdb: 135, gfi: 135 });
  assert.deepEqual(get('corrupt-bad-signature').versions, { gdb: null, gfi: 188 });
  assert.equal(get('version-experimental').experimental, true);
  const counts = get('corrupt-absurd-counts');
  assert.deepEqual(counts.notDecoded.map((t) => t.name), ['Huge segments']);
  assert.deepEqual(counts.problems, [{ code: 'track_not_decoded', count: 1 }, { code: 'track_segments_not_decoded', count: 1 }]);
  assert.deepEqual(counts.counted, [{ code: 'waypoint_details_not_decoded', count: 1 }]);
  const garbage = /** @type {Uint8Array} */ (BUILT.get('corrupt-garbage')?.built.files.get('AllData.gdb'));
  assert.equal(readHeader(garbage).ok, false);
});

test('scenario labels: H-OP fixtures never count as supported-path coverage', () => {
  for (const s of SCENARIOS) {
    const { exercises } = /** @type {ReturnType<typeof buildScenario>} */ (BUILT.get(s.name));
    const usesOp = exercises.W.includes('op') || exercises.T.includes('op');
    if (usesOp) assert.equal(s.supportedPath, false, `${s.name} uses H-OP`);
  }
  const op = /** @type {ReturnType<typeof buildScenario>} */ (BUILT.get('hop-layouts')).exercises;
  assert.deepEqual(op, { W: ['op'], T: ['op'], TS: [17] });
  const ts = /** @type {ReturnType<typeof buildScenario>} */ (BUILT.get('tracks-elevation-time')).exercises;
  assert.deepEqual(ts.TS, [17, 11]);
});

test('privacy sentinels are present in the bytes they are meant to test', () => {
  const s = getScenario('privacy-sentinels');
  const { built } = /** @type {ReturnType<typeof buildScenario>} */ (BUILT.get('privacy-sentinels'));
  const all = [...built.files.values()].map((b) => Buffer.from(b).toString('latin1')).join('\n');
  for (const str of s.sentinels?.strings ?? []) assert.ok(all.includes(str), str);
  assert.ok([...built.files.keys()].some((p) => p.includes('7a7b7c7d-1234-4abc-9def-0123456789ab')), 'the sentinel UUID names a TrackSegments file');
});

// ---------------------------------------------------------------------------------------------------------------------
// .Backup

test('every scenario\'s .Backup opens with src/format/unzip.js and holds exactly the library files', async () => {
  for (const s of SCENARIOS) {
    const { built } = /** @type {ReturnType<typeof buildScenario>} */ (BUILT.get(s.name));
    const bytes = await buildBackup(built);
    const again = await buildBackup(built);
    assert.deepEqual(bytes, again, `${s.name}: stored archives are byte-identical`);
    const archive = await openZip(bytes);
    assert.deepEqual(archive.problems, [], s.name);
    const want = backupEntries(built);
    assert.deepEqual(archive.entries.map((e) => e.name), want.map((e) => e.path), s.name);
    for (const [i, entry] of archive.entries.entries()) {
      assert.equal(entry.isDirectory, want[i].path.endsWith('/'));
      if (!entry.isDirectory) assert.deepEqual(await entry.read(), want[i].bytes, `${s.name} ${entry.name}`);
    }
    const base = `BaseCamp_x/Database/${built.databaseVersion}/`;
    assert.ok(archive.entries.some((e) => e.name === `${base}AllData.gdb`), s.name);
    assert.equal(archive.entries.some((e) => e.name === `${base}FolderData.gfi`), s.library.gfi !== null, s.name);
  }
});

test('.Backup variants: deflated, ZIP64 and without folder entries', async () => {
  const { built } = /** @type {ReturnType<typeof buildScenario>} */ (BUILT.get('nested-tree'));
  const files = [...built.files.entries()];
  for (const opts of [
    { compression: /** @type {const} */ ('auto') },
    { zip64: /** @type {const} */ ('always') },
    { directories: false, name: 'Another backup' },
  ]) {
    const archive = await openZip(await buildBackup(built, opts));
    assert.deepEqual(archive.problems, [], JSON.stringify(opts));
    const fileEntries = archive.entries.filter((e) => !e.isDirectory);
    assert.equal(fileEntries.length, files.length);
    for (const [i, [path, bytes]] of files.entries()) {
      assert.ok(fileEntries[i].name.endsWith(`/Database/4.8/${path}`));
      assert.deepEqual(await fileEntries[i].read(), bytes);
    }
    if (opts.compression === 'auto') assert.ok(fileEntries.some((e) => e.method === 8), 'something was deflated');
    if (opts.zip64 === 'always') assert.equal(archive.zip64, true);
    if (opts.directories === false) assert.equal(archive.entries.length, files.length);
  }
  assert.throws(() => backupEntries(built, { name: '../escape' }), RangeError);
});
