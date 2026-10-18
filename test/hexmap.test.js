// Tests for tools/hexmap.js against the real Mac BaseCamp 4.8.13 library in testdata/basecamp-real/run1-gate1/4.8
// (written by BaseCamp, holding only the made-up Gate 1 content from tools/gate1). They pin the H-MAC48 layouts of
// docs/FORMAT.md §15 to that sample: every record must be consumed exactly, and the decoded values must equal what was
// imported (tools/gate1/expected.json). They also check that the default output holds no content and that hostile
// (truncated or mutated) input never throws.
//
// Run: node --test test/hexmap.test.js

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { formatMap, mapLibrary, readLibraryFolder, TS_FIELDS } from '../tools/hexmap.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SAMPLE = path.join(ROOT, 'testdata', 'basecamp-real', 'run1-gate1', '4.8');
const EXPECTED = JSON.parse(readFileSync(path.join(ROOT, 'tools', 'gate1', 'expected.json'), 'utf8'));
/** Semicircles of slack for GPX text rounding (1 unit is about 8.4e-8 degree), as tools/gate1/compare.js. */
const TOLERANCE = 3;

assert.ok(existsSync(SAMPLE), `the real sample library is missing: ${SAMPLE}`);
const LIB = readLibraryFolder(SAMPLE);
const MAP = mapLibrary(LIB);

const semi = (/** @type {number} */ deg) => Math.round((deg * 2 ** 31) / 180);
const unix = (/** @type {string} */ iso) => Date.parse(iso) / 1000;
/** @param {{lines: Array<{name: string, value: unknown}>}} r @param {string} name */
const field = (r, name) => {
  const l = r.lines.find((x) => x.name === name);
  assert.ok(l, `no field "${name}"`);
  return l.value;
};
/** @param {unknown} pos @param {number} lat @param {number} lon */
const near = (pos, lat, lon) => {
  const [a, b] = /** @type {number[]} */ (pos);
  return Math.abs(a - semi(lat)) <= TOLERANCE && Math.abs(b - semi(lon)) <= TOLERANCE;
};

describe('hexmap on the real Mac 4.8.13 sample', () => {
  test('every record and TrackSegments file is consumed exactly, and every track pairs with its file', () => {
    assert.equal(MAP.allExact, true);
    const counts = (/** @type {any} */ f) => Object.fromEntries(Object.entries(f.byType).map(([t, c]) => [t, [/** @type {any} */ (c).count, /** @type {any} */ (c).exact]]));
    assert.deepEqual(counts(MAP.gdb), { W: [10, 10], R: [1, 1], T: [7, 7], V: [1, 1], E: [1, 1], X: [1, 1] });
    assert.deepEqual(counts(MAP.gfi), { F: [2, 2], I: [4, 4], R: [3, 3], T: [21, 21], W: [18, 18] });
    assert.equal(MAP.trackSegments.length, 7);
    assert.equal(MAP.pairing.length, 7);
    assert.ok(MAP.pairing.every((p) => p.ok));
    assert.equal(MAP.unpairedFiles, 0);
  });

  test('headers: file format 188, program version 408, TrackSegments signature MsRc', () => {
    for (const f of [MAP.gdb, MAP.gfi]) {
      const h = /** @type {any} */ (f?.header);
      assert.equal(h.formatVersion, 188);
      assert.equal(h.programVersion, 408);
      assert.equal(h.application, 'BaseCamp');
    }
    assert.equal(/** @type {any} */ (MAP.gdb?.header).signature, 'MsRc');
    assert.equal(/** @type {any} */ (MAP.gfi?.header).signature, 'DifG');
    for (const f of MAP.trackSegments) {
      const h = /** @type {any} */ (f.map.header);
      assert.deepEqual([h.signature, h.formatVersion, h.programVersion], ['MsRc', 188, 408]);
    }
  });

  test('waypoints: position, comment, altitude, time B (= GPX <time>), address and phone match what was imported', () => {
    const records = (MAP.gdb?.records ?? []).filter((r) => r.type === 'W');
    for (const w of EXPECTED.waypoints) {
      const r = records.find((x) => field(x, 'name') === w.name);
      assert.ok(r, w.label);
      assert.equal(field(r, 'class'), 0, w.label);
      assert.ok(near(field(r, 'position'), w.lat, w.lon), `${w.label} position`);
      assert.equal(field(r, 'comment'), w.comment ?? '', `${w.label} comment`);
      assert.equal(field(r, 'altitude (m)'), w.ele ?? null, `${w.label} altitude`);
      const timeA = /** @type {number} */ (field(r, 'time A (set on import)'));
      const timeB = /** @type {number} */ (field(r, 'time B (creation; GPX <time>)'));
      if (w.time) assert.equal(timeB, unix(w.time), `${w.label} time B`);
      else assert.equal(timeB, timeA, `${w.label}: without a GPX time, time B is the import time`);
      assert.ok(timeA >= unix('2026-10-07T00:00:00Z') && timeA < unix('2026-10-08T00:00:00Z'), `${w.label}: time A is the run's import time`);
      const address = ['street', 'city', 'state', 'country', 'postal code'].map((n) => field(r, n));
      if (w.address) {
        assert.deepEqual(address, [w.address.street, w.address.city, w.address.state, w.address.country, w.address.postalCode]);
        assert.equal(field(r, 'phone count'), 1);
        assert.equal(field(r, 'phone 1'), w.phone);
      } else {
        assert.deepEqual(address, ['', '', '', '', '']);
        assert.equal(field(r, 'phone count'), 0);
      }
    }
    // The route's via points are stored as class-8 waypoints.
    for (const v of EXPECTED.routes[0].via) {
      const r = records.find((x) => field(x, 'name') === v.name);
      assert.ok(r, v.label);
      assert.equal(field(r, 'class'), 8);
      assert.ok(near(field(r, 'position'), v.lat, v.lon), `${v.label} position`);
    }
  });

  test('route: 4 via points, each with links [itself, next] and a box; the last has none; bounds; colour 14; profile 6', () => {
    const r = (MAP.gdb?.records ?? []).find((x) => x.type === 'R');
    assert.ok(r);
    const via = EXPECTED.routes[0].via;
    assert.equal(field(r, 'name'), EXPECTED.routes[0].name);
    assert.equal(field(r, 'route point count'), via.length);
    via.forEach((v, i) => {
      const p = `point ${i + 1}`;
      assert.equal(field(r, `${p}: name`), v.name);
      assert.equal(field(r, `${p}: class`), 8);
      if (i < via.length - 1) {
        assert.equal(field(r, `${p}: link point count`), 2);
        assert.ok(near(field(r, `${p}: link point 1`), v.lat, v.lon));
        assert.ok(near(field(r, `${p}: link point 2`), via[i + 1].lat, via[i + 1].lon));
        assert.equal(field(r, `${p}: no bounding box`), 0);
      } else {
        assert.equal(field(r, `${p}: link point count`), 0);
        assert.equal(field(r, `${p}: no bounding box`), 1);
      }
    });
    const lats = via.map((v) => v.lat);
    const lons = via.map((v) => v.lon);
    assert.ok(near(field(r, 'route max'), Math.max(...lats), Math.max(...lons)));
    assert.ok(near(field(r, 'route min'), Math.min(...lats), Math.min(...lons)));
    assert.equal(field(r, 'colour'), 14);
    assert.equal(field(r, 'activity profile'), 6);
  });

  test('tracks: positions, start time, duration, speed = length / duration, and the TrackSegments values for all 7', () => {
    const tracks = (MAP.gdb?.records ?? []).filter((x) => x.type === 'T');
    const seen = new Set();
    for (const r of tracks) {
      const positions = /** @type {number[][]} */ (r.facts.positions);
      // Identify the made-up track by its first position (BaseCamp renamed one twin, so names are not enough).
      const e = EXPECTED.tracks.find((t) => near(positions[0], t.segments[0][0].lat, t.segments[0][0].lon));
      assert.ok(e, `track #${r.index} matches no expected track`);
      seen.add(e.label);
      const pts = e.segments.flat();
      assert.equal(positions.length, pts.length, e.label);
      pts.forEach((p, i) => assert.ok(near(positions[i], p.lat, p.lon), `${e.label} point ${i + 1}`));
      assert.equal(field(r, 'segment count'), 1, `${e.label}: BaseCamp stored one segment`);
      assert.equal(field(r, 'total point count'), pts.length);
      const times = pts.map((p) => (p.time ? unix(p.time) : null));
      assert.equal(field(r, 'start time'), times[0], `${e.label} start time`);
      const duration = field(r, 'duration (s)');
      assert.equal(duration, times[0] === null ? null : /** @type {number} */ (times.at(-1)) - times[0], `${e.label} duration`);
      // Area (FORMAT.md §15.4 #6): planar closed-polygon sum over the raw i32 values, at the middle latitude.
      const c = 3.14159265358979 / 2 ** 31;
      const lats = positions.map((p) => p[0]);
      const mid = Math.trunc((Math.min(...lats) + Math.max(...lats)) / 2);
      let sum = 0;
      for (let i = 0; i < positions.length; i++) {
        const j = (i + 1) % positions.length;
        sum += positions[i][0] * positions[j][1] - positions[j][0] * positions[i][1];
      }
      const area = (Math.abs(sum) / 2) * 6378137 ** 2 * c * c * Math.cos(mid * c);
      const stored = /** @type {number} */ (field(r, 'area (m²)'));
      assert.ok(Math.abs(area - stored) <= 1e-15 * Math.max(1, stored), `${e.label} area ${stored} vs ${area}`);
      const speed = field(r, 'average speed (m/s)');
      if (duration === null) assert.equal(speed, null);
      else assert.equal(speed, /** @type {number} */ (field(r, 'length (m)')) / /** @type {number} */ (duration));
      // TrackSegments: the file the UUID names holds this track's elevation, time, temperature and heart rate.
      const pair = MAP.pairing.find((p) => p.track === r.index);
      assert.ok(pair?.ok && pair.file !== null, `${e.label} paired`);
      const ts = MAP.trackSegments[/** @type {number} */ (pair.file)].map;
      assert.equal(ts.count, pts.length);
      pts.forEach((p, i) => {
        const v = ts.points[i];
        assert.equal(v[0] ?? null, p.ele ?? null, `${e.label} point ${i + 1} elevation`);
        assert.equal(v[1] ?? null, p.time ? unix(p.time) : null, `${e.label} point ${i + 1} time`);
        assert.equal(v[5] ?? null, p.atemp ?? null, `${e.label} point ${i + 1} temperature`);
        assert.equal(v[6] ?? null, p.hr ?? null, `${e.label} point ${i + 1} heart rate`);
      });
      // Per-track flags: 1st = has elevation, 2nd = has time (observed); the sensor track also sets the 3rd and 4th.
      const flags = /** @type {number[]} */ (r.facts.flags);
      const hasEle = pts.some((p) => p.ele != null);
      const hasTime = pts.some((p) => p.time != null);
      const hasSensors = pts.some((p) => p.hr != null);
      assert.deepEqual(flags, [+hasEle, +hasTime, +hasSensors, +hasSensors, 0, 0, 0, 0, 0, 0, 0], `${e.label} flags`);
    }
    assert.equal(seen.size, 7);
    assert.deepEqual(Object.keys(TS_FIELDS).map(Number), [0, 1, 5, 6]);
  });

  test('folder data: the root holds the two smart lists, Unlisted Data and Gate1 Trips; gate1-ocean sits in Gate1 Trips', () => {
    const recs = MAP.gfi?.records ?? [];
    const folders = recs.filter((r) => r.type === 'F');
    const lists = recs.filter((r) => r.type === 'I');
    const root = folders.find((r) => field(r, 'folder id') === 0xffffffff);
    assert.ok(root);
    assert.equal(field(root, 'child count'), 4);
    const children = [1, 2, 3, 4].map((i) => [field(root, `child ${i}: type`), field(root, `child ${i}: id`)]);
    assert.deepEqual(children, [[0, 1], [0, 2], [1, 0], [0, 0]]);
    const byId = new Map(lists.map((r) => [field(r, 'list id'), r]));
    assert.deepEqual([0, 1, 2, 3].map((id) => field(/** @type {any} */ (byId.get(id)), 'created by')), [8, 3, 3, 0]);
    assert.equal(field(/** @type {any} */ (byId.get(3)), 'parent folder id'), 0);
    for (const f of folders) {
      const t = /** @type {number} */ (field(f, 'time'));
      assert.ok(t >= unix('2026-10-07T00:00:00Z') && t < unix('2026-10-08T00:00:00Z'), 'folder time is a time on the run day');
    }
    // Every item is referenced from the import list and from both smart lists; the via points are not referenced.
    const refs = recs.filter((r) => r.type === 'W').map((r) => field(r, 'item name'));
    assert.equal(refs.length, 18);
    assert.ok(!refs.some((n) => String(n).includes('Via')));
  });
});

describe('hexmap on run2 (run1 plus lists, folders, two-list items and a typed address)', () => {
  const RUN2 = path.join(ROOT, 'testdata', 'basecamp-real', 'run2-structured', '4.8');
  const MAP2 = mapLibrary(readLibraryFolder(RUN2));
  const w2 = (/** @type {string} */ name) => (MAP2.gdb?.records ?? []).find((r) => r.type === 'W' && field(r, 'name') === name);
  const w1 = (/** @type {string} */ name) => (MAP.gdb?.records ?? []).find((r) => r.type === 'W' && field(r, 'name') === name);

  test('the same tables consume every run2 record exactly and pair every track', () => {
    assert.equal(MAP2.allExact, true);
    assert.equal(MAP2.pairing.length, 7);
  });

  test('the typed address and phone sit in the same slots; time A (modified) changed, time B (created) did not', () => {
    const delta = EXPECTED.waypoints.find((/** @type {any} */ w) => w.label === 'Waypoint Delta');
    const r2 = w2(delta.name);
    const r1 = w1(delta.name);
    assert.ok(r1 && r2);
    const typed = delta.typedByHand;
    assert.deepEqual(
      ['street', 'city', 'state', 'country', 'postal code', 'phone 1'].map((n) => field(r2, n)),
      [typed.street, typed.city, typed.state, typed.country, typed.postalCode, typed.phone],
    );
    assert.equal(field(r2, 'phone count'), 1);
    assert.equal(field(r2, 'time B (creation; GPX <time>)'), field(r1, 'time B (creation; GPX <time>)'));
    assert.ok(/** @type {number} */ (field(r2, 'time A (set on import)')) > /** @type {number} */ (field(r1, 'time A (set on import)')));
  });

  test('hand-made lists are created-by 0 without a tail; a second list is one more reference', () => {
    const lists = (MAP2.gfi?.records ?? []).filter((r) => r.type === 'I');
    for (const name of ['Gate1 Desert', 'Gate1 Deep']) {
      const r = lists.find((x) => field(x, 'name') === name);
      assert.ok(r, name);
      assert.equal(field(r, 'created by'), 0);
      assert.equal(r.lines.length, 4, `${name} has no tail`);
    }
    const desertId = field(/** @type {any} */ (lists.find((x) => field(x, 'name') === 'Gate1 Desert')), 'list id');
    const inDesert = (MAP2.gfi?.records ?? []).filter((r) => r.type !== 'F' && r.type !== 'I' && field(r, 'list id') === desertId);
    assert.deepEqual(inDesert.map((r) => `${r.type} ${field(r, 'item name')}`).sort(), ['T Gate1 Track Timed', 'W Gate1 Waypoint Alpha']);
  });
});

describe('hexmap output and hostile input', () => {
  test('the default output holds no string, UUID, time or coordinate from the library; --show-text does', () => {
    const text = formatMap(MAP);
    // ("My Collection" and "Unlisted Data" are BaseCamp's built-in names; the layout notes use them, so they are not here.)
    const forbidden = ['Gate1', 'gate1', 'Imported', '555-0101', 'G1-0001', 'Last Week', 'Last Month', 'EndOfFile', 'buildy', 'Mar 29', '"'];
    for (const s of forbidden) assert.ok(!text.includes(s), `default output contains "${s}"`);
    for (const f of LIB.trackSegments) assert.ok(!text.includes(f.name) && !text.includes(f.name.slice(0, 8)), 'a UUID leaked');
    assert.ok(!/\d{4}-\d\d-\d\dT/.test(text), 'a time leaked');
    assert.ok(!/-?\d{1,3}\.\d{5,}/.test(text), 'a coordinate or measured value leaked');
    const shown = formatMap(MAP, { showText: true });
    assert.ok(shown.includes('"Gate1 Waypoint Bravo"'));
    assert.ok(shown.includes('2001-02-03T04:05:06Z'));
  });

  test('every truncation of every file maps without throwing', () => {
    const files = [
      ['gdb', LIB.gdb],
      ['gfi', LIB.gfi],
    ];
    for (const [kind, bytes] of files) {
      const b = /** @type {Uint8Array} */ (bytes);
      for (let n = 0; n < b.length; n++) {
        const cut = b.subarray(0, n);
        // A cut on a record boundary may still map exactly (framing ends cleanly); the point is that nothing throws.
        const map = mapLibrary(kind === 'gdb' ? { gdb: cut } : { gfi: cut });
        formatMap(map);
        formatMap(map, { showText: true });
      }
    }
    for (const f of LIB.trackSegments) {
      for (let n = 0; n < f.bytes.length; n++) {
        const map = mapLibrary({ trackSegments: [{ name: f.name, bytes: f.bytes.subarray(0, n) }] });
        assert.notEqual(map.trackSegments[0].map.status, 'exact', `a TrackSegments file cut to ${n} bytes mapped exactly`);
        formatMap(map);
      }
    }
  });

  test('seeded byte mutations never throw', () => {
    let seed = 0x5eed1234;
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const inputs = [LIB.gdb, LIB.gfi, ...LIB.trackSegments.map((f) => f.bytes)];
    for (let round = 0; round < 400; round++) {
      const src = /** @type {Uint8Array} */ (inputs[round % inputs.length]);
      const b = Uint8Array.from(src);
      const flips = 1 + Math.floor(rand() * 6);
      for (let k = 0; k < flips; k++) b[Math.floor(rand() * b.length)] = Math.floor(rand() * 256);
      const which = round % inputs.length;
      const map =
        which === 0 ? mapLibrary({ gdb: b }) : which === 1 ? mapLibrary({ gfi: b }) : mapLibrary({ trackSegments: [{ name: 'x', bytes: b }] });
      formatMap(map);
      formatMap(map, { showText: true });
    }
  });

  test('the command line maps the sample (exit 0) and refuses bad arguments (exit 2)', () => {
    const tool = path.join(ROOT, 'tools', 'hexmap.js');
    const ok = spawnSync(process.execPath, [tool, SAMPLE, '--summary'], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /RESULT: every record and TrackSegments file mapped exactly, every track paired\./);
    assert.ok(!ok.stdout.includes('Gate1'));
    const bad = spawnSync(process.execPath, [tool, SAMPLE, '--bogus'], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
  });
});
