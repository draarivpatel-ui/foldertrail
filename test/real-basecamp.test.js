// Real BaseCamp output: libraries written by Garmin BaseCamp for Mac 4.8.13 holding ONLY made-up content
// (testdata/basecamp-real/README.md). run1 is the founder's Gate 1 run: tools/gate1/gpx/*.gpx imported into BaseCamp;
// tools/gate1/expected.json is what those GPX files hold. run2 is run1 plus user lists, nested folders, items in two
// lists and a typed address.
//
// The library goes through the real path the app uses: a webkitdirectory-style file list → intake → worker source
// (structured-cloned) → readLibrary → exportLibrary → the ZIP read back with src/format/unzip.js. The assertions are
// what this sample really contains, which differs from expected.json's *intended* tree in known ways (FORMAT.md §15):
// - run1 has one import list, "gate1-ocean", holding all 14 items, under the folder "Gate1 Trips"; BaseCamp's smart
//   lists "Last Week" and "Last Month" (created-by 3) and "Unlisted Data" (created-by 8) hang under My Collection.
//   Smart lists are not exported (decision B40).
// - BaseCamp renamed the second "Gate1 Twin Track" (Twin Track A, from gate1-desert.gpx) to "Gate1 Twin Track 001";
//   tracks are told apart by their positions, not by expected.json's names.
// - The two-segment GPX track was stored as ONE segment of 11 points (§15.4).
// - A waypoint whose GPX had no <time> carries BaseCamp's import time as its creation time, which BCR exports as
//   BaseCamp does (B42). Those import times are pinned below from the bytes (tools/hexmap.js --show-text).
// - The route's 4 via points are class-8 waypoint records: part of the route, not exported as waypoints (B42).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { intake, toWorkerSource, fromWorkerSource } from '../src/app/intake.js';
import { readLibrary, LIBRARY_PROBLEMS } from '../src/format/library.js';
import { exportLibrary } from '../src/app/pipeline.js';
import { openZip } from '../src/format/unzip.js';
import { readContainer } from '../src/format/container.js';
import { parseWaypoint, parseTrack, parseRoute, Counts } from '../src/format/gdb.js';
import { parseFolderData, buildTree } from '../src/format/gfi.js';
import { parseTrackSegments } from '../src/format/tracksegments.js';
import { buildDump } from '../src/format/dump.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const RUN1 = join(HERE, '..', 'testdata', 'basecamp-real', 'run1-gate1', '4.8');
const RUN2 = join(HERE, '..', 'testdata', 'basecamp-real', 'run2-structured', '4.8');
const EXPECTED = JSON.parse(readFileSync(join(HERE, '..', 'tools', 'gate1', 'expected.json'), 'utf8'));

/** Import times BaseCamp stored as the creation time (time B) of waypoints whose GPX had no <time> (run1 bytes). */
const IMPORTED_OCEAN = Date.parse('2026-10-07T11:40:16Z');
const IMPORTED_DESERT = Date.parse('2026-10-07T11:40:26Z');
const NO_GPX_TIME = Object.freeze({
  'Gate1 Waypoint Bravo': IMPORTED_OCEAN,
  'Gate1 Waypoint Charlie': IMPORTED_OCEAN,
  'Gate1 Waypoint Delta': IMPORTED_DESERT,
});

/** GDB track name → expected.json track label (identified by positions, FORMAT.md §15.7). */
const TRACK_LABEL = Object.freeze({
  'Gate1 Track Timed': 'Track Timed',
  'Gate1 Track No Time': 'Track No Time',
  'Gate1 Track Bare': 'Track Bare',
  'Gate1 Track Two Segments': 'Track Two Segments',
  'Gate1 Twin Track': 'Twin Track B',
  'Gate1 Twin Track 001': 'Twin Track A',
  'Gate1 Track Sensors': 'Track Sensors',
});

/**
 * Every file under a version folder, as an <input webkitdirectory> FileList delivers it ("4.8/…" relative paths).
 * @param {string} root
 * @returns {File[]}
 */
function folderFiles(root) {
  /** @type {File[]} */
  const out = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else {
        const file = new File([readFileSync(path)], name, { lastModified: 1000 });
        Object.defineProperty(file, 'webkitRelativePath', { value: `4.8/${relative(root, path).split('\\').join('/')}` });
        out.push(file);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * The app's own path: intake → worker source (structured-cloned, as postMessage does) → readLibrary.
 * @param {string} root
 */
async function readThroughIntake(root) {
  const found = await intake(folderFiles(root));
  assert.equal(found.ok, true, 'intake found the library');
  assert.deepEqual(found.problems, [], 'intake had nothing to report');
  const revived = await fromWorkerSource(structuredClone(toWorkerSource(found.found)));
  assert.deepEqual(revived.problems, []);
  return readLibrary(revived.found);
}

/**
 * Name paths ("My Collection / Gate1 Trips / gate1-ocean") of every folder and list, with the item names of each list.
 * @param {import('../src/model.js').Library} library
 */
function treeOf(library) {
  const byId = new Map(library.folders.map((f) => [f.id, f]));
  const items = new Map(library.items.map((i) => [i.id, i]));
  return library.folders.map((folder) => {
    /** @type {string[]} */
    const path = [];
    /** @type {any} */
    let at = folder;
    for (let guard = 0; at && guard < 100; guard++) {
      path.unshift(at.name);
      at = at.parentId === null ? null : byId.get(at.parentId);
    }
    const names = folder.itemIds.map((id) => /** @type {any} */ (items.get(id)).name).sort();
    return { path: path.join(' / '), type: folder.type, items: names };
  });
}

/** @param {string} iso */
const ms = (iso) => Date.parse(iso);

/** Problem code → count. @param {import('../src/model.js').Library} library */
const problemCounts = (library) => Object.fromEntries(library.problems.map((p) => [p.code, p.count]));

/**
 * The points of a track as expected.json holds them, all segments in order (BaseCamp joined the two segments).
 * @param {string} label
 */
function expectedPoints(label) {
  const t = EXPECTED.tracks.find((/** @type {any} */ x) => x.label === label);
  assert.ok(t, label);
  return t.segments.flat();
}

// ---------------------------------------------------------------------------------------------
// run1: every record is read with the measured Mac 4.8 layout

test('run1: every W, T and R record is accepted by exactly one layout, H-MAC48; every TrackSegments file decodes', () => {
  const gdb = readContainer(new Uint8Array(readFileSync(join(RUN1, 'AllData.gdb'))), { role: 'gdb' });
  assert.equal(gdb.ok, true);
  assert.equal(gdb.formatVersion, 188);
  assert.equal(gdb.programVersion, 408);
  const counts = new Counts();
  /** @type {Record<string, number>} */
  const types = {};
  for (const r of gdb.records) {
    types[r.type] = (types[r.type] ?? 0) + 1;
    const parsed = r.type === 'W' ? parseWaypoint(r.body, counts) : r.type === 'T' ? parseTrack(r.body, counts) : r.type === 'R' ? parseRoute(r.body, counts) : null;
    if (!parsed) continue;
    assert.equal(parsed.accepted, 1, `${r.type} ${parsed.name}: one layout`);
    assert.equal(parsed.layout, 'H-MAC48', `${r.type} ${parsed.name}`);
  }
  assert.deepEqual(types, { W: 10, R: 1, T: 7, V: 1, E: 1, X: 1 });
  assert.equal(counts.map.size, 0, 'nothing counted while parsing');

  const files = readdirSync(join(RUN1, 'TrackSegments'));
  assert.equal(files.length, 7);
  for (const name of files) {
    const ts = parseTrackSegments(new Uint8Array(readFileSync(join(RUN1, 'TrackSegments', name))));
    assert.deepEqual([ts.status, ts.pointSize, ts.fitting], ['decoded', 17, 1], name);
  }
});

test('run1: FolderData.gfi as BaseCamp wrote it (import list, folder, smart lists, Unlisted Data)', () => {
  const gfi = readContainer(new Uint8Array(readFileSync(join(RUN1, 'FolderData.gfi'))), { role: 'gfi' });
  assert.equal(gfi.ok, true);
  const counts = new Counts();
  const content = parseFolderData(gfi.records, counts);
  assert.equal(counts.map.size, 0, 'every F and I tail as expected; nothing else counted');
  assert.deepEqual(content.folders.map((f) => [f.id, f.name, f.parent]), [
    [0xffffffff, 'My Collection', 0xffffffff],
    [0, 'Gate1 Trips', 0xffffffff],
  ]);
  assert.deepEqual(
    content.lists.map((l) => [l.name, l.createdBy, l.parent]).sort(),
    [
      ['Last Month', 3, 0xffffffff],
      ['Last Week', 3, 0xffffffff],
      ['Unlisted Data', 8, 0xffffffff],
      ['gate1-ocean', 0, 0],
    ],
  );
  const tree = buildTree(content, counts);
  assert.deepEqual(tree.nodes.map((n) => `${n.type}:${n.name}`).sort(), [
    'folder:Gate1 Trips',
    'folder:My Collection',
    'list:Last Month',
    'list:Last Week',
    'list:Unlisted Data',
    'list:gate1-ocean',
  ]);
  // Every item is referenced from its list and from both smart lists; the class-8 via points from none.
  const byList = new Map(content.lists.map((l) => [l.id, l.name]));
  /** @type {Record<string, number>} */
  const refs = {};
  for (const r of content.references) refs[/** @type {string} */ (byList.get(r.listId))] = (refs[/** @type {string} */ (byList.get(r.listId))] ?? 0) + 1;
  assert.deepEqual(refs, { 'gate1-ocean': 14, 'Last Week': 14, 'Last Month': 14 });
});

// ---------------------------------------------------------------------------------------------
// run1: through the app's own intake → readLibrary → export path

test('run1: the app reads every waypoint, track and route, with elevation and time, into the tree BaseCamp wrote', async () => {
  const { library, details } = await readThroughIntake(RUN1);
  assert.equal(details.fatal, null);
  assert.equal(details.experimental, false);
  assert.deepEqual(details.versions, { gdb: 188, gfi: 188, program: 408 });
  assert.equal(details.application, 'BaseCamp');
  assert.deepEqual(library.notConverted, [], 'nothing "not converted"');
  assert.deepEqual(library.ambiguous, []);
  assert.deepEqual(details.duplicates, []);
  assert.equal(library.treeMissing, false);

  // Waypoints: the 6 GPX waypoints; the 4 class-8 route via points are not waypoints (B42).
  const waypoints = library.items.filter((i) => i.kind === 'waypoint');
  assert.deepEqual(waypoints.map((w) => w.name).sort(), EXPECTED.waypoints.map((/** @type {any} */ w) => w.name).sort());
  for (const want of EXPECTED.waypoints) {
    const w = /** @type {import('../src/model.js').Waypoint} */ (waypoints.find((x) => x.name === want.name));
    assert.ok(Math.abs(w.lat - want.lat) <= 1e-7, `${want.name} latitude`);
    assert.ok(Math.abs(w.lon - want.lon) <= 1e-7, `${want.name} longitude`);
    assert.equal(w.comment, want.comment, `${want.name} comment`);
    assert.equal(w.ele, want.ele, `${want.name} elevation`);
    const time = want.time === null ? /** @type {Record<string, number>} */ (NO_GPX_TIME)[want.name] : ms(want.time);
    assert.equal(w.time, time, `${want.name} time`);
    assert.equal(w.icon, 141);
    assert.equal(w.symbol, 'Flag, Blue');
  }

  // The route: 4 via points in order, each at its GPX position (the last one through its class-8 waypoint record).
  const routes = /** @type {import('../src/model.js').Route[]} */ (library.items.filter((i) => i.kind === 'route'));
  assert.equal(routes.length, 1);
  assert.equal(routes[0].name, EXPECTED.routes[0].name);
  assert.deepEqual(routes[0].points.map((p) => p.name), EXPECTED.routes[0].via.map((/** @type {any} */ v) => v.name));
  routes[0].points.forEach((p, i) => {
    const want = EXPECTED.routes[0].via[i];
    assert.ok(Math.abs(p.lat - want.lat) <= 1e-7 && Math.abs(p.lon - want.lon) <= 1e-7, `${want.name} position`);
  });

  // Tracks: 7, each one segment whose points, elevations and times come from the right TrackSegments file.
  const tracks = /** @type {import('../src/model.js').Track[]} */ (library.items.filter((i) => i.kind === 'track'));
  assert.deepEqual(tracks.map((t) => t.name).sort(), Object.keys(TRACK_LABEL).sort());
  assert.ok(tracks.some((t) => t.name === 'Gate1 Twin Track 001'), 'BaseCamp renamed the second twin');
  for (const track of tracks) {
    const label = /** @type {Record<string, string>} */ (TRACK_LABEL)[track.name];
    const want = expectedPoints(label);
    const segments = track.segments;
    assert.equal(segments.length, 1, `${track.name}: one segment`);
    assert.equal(segments[0].length, want.length, `${track.name}: points`);
    segments[0].forEach((p, i) => {
      const q = want[i];
      assert.ok(Math.abs(p.lat - q.lat) <= 1e-7 && Math.abs(p.lon - q.lon) <= 1e-7, `${track.name} point ${i + 1} position`);
      assert.equal(p.ele, q.ele, `${track.name} point ${i + 1} elevation`);
      assert.equal(p.time, q.time === null ? null : ms(q.time), `${track.name} point ${i + 1} time`);
      // B44: heart rate and air temperature, only where the GPX had them (Track Sensors), exactly.
      assert.equal(p.hr, q.hr, `${track.name} point ${i + 1} heart rate`);
      assert.equal(p.atemp, q.atemp, `${track.name} point ${i + 1} temperature`);
    });
    assert.equal(details.elevationTime.get(track.id), 'attached', track.name);
    assert.equal(track.color, 'DarkGray');
    assert.equal(track.sensorData, track.name === 'Gate1 Track Sensors', `${track.name}: sensorData`);
  }

  // The tree: smart lists left out (B40), Unlisted Data kept (empty), every item in gate1-ocean once.
  assert.deepEqual(treeOf(library), [
    { path: 'My Collection', type: 'folder', items: [] },
    { path: 'My Collection / Gate1 Trips', type: 'folder', items: [] },
    {
      path: 'My Collection / Gate1 Trips / gate1-ocean',
      type: 'list',
      items: [...EXPECTED.waypoints.map((/** @type {any} */ w) => w.name), EXPECTED.routes[0].name, ...Object.keys(TRACK_LABEL)].sort(),
    },
    { path: 'My Collection / Unlisted Data', type: 'list', items: [] },
  ]);
  assert.equal(details.multiListItems, 0);

  // What the user is told: smart lists left out, sensor data kept (B44); the via-point records in the dump only.
  assert.deepEqual(problemCounts(library), { smart_lists_left_out: 2, track_sensor_data_kept: 1, route_via_point_record: 4 });
  for (const p of library.problems) assert.equal(p.level, LIBRARY_PROBLEMS[p.code].level, p.code);
});

test('run1: the download holds the tree, every item once per list, and the report says what was left out', async () => {
  const read = await readThroughIntake(RUN1);
  const exported = await exportLibrary(read, { now: () => Date.UTC(2026, 9, 7, 12), compression: 'store' });
  const zip = await openZip(exported.zip);
  assert.deepEqual(zip.problems, []);
  const names = zip.entries.map((e) => e.name).sort();
  assert.deepEqual(names, [
    'GPX/',
    'GPX/All items.gpx',
    'GPX/My Collection/',
    'GPX/My Collection/Gate1 Trips/',
    'GPX/My Collection/Gate1 Trips/gate1-ocean.gpx',
    'GPX/My Collection/Unlisted Data.gpx',
    'KML/My Collection.kml',
    'READ-ME-FIRST.txt',
    'report.html',
    'report.txt',
  ]);
  /** @param {string} name */
  const text = async (name) => new TextDecoder().decode(await /** @type {any} */ (zip.entries.find((e) => e.name === name)).read());
  const gpx = await text('GPX/My Collection/Gate1 Trips/gate1-ocean.gpx');

  /** @param {string} tag */
  const blocks = (tag) => [...gpx.matchAll(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'g'))].map((m) => m[0]);
  /** @param {string} block @param {string} tag */
  const field = (block, tag) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(block)?.[1] ?? null;
  /** @param {string} block */
  const position = (block) => {
    const m = /lat="([^"]+)" lon="([^"]+)"/.exec(block);
    return m ? [Number(m[1]), Number(m[2])] : null;
  };

  const wpts = blocks('wpt');
  assert.equal(wpts.length, 6);
  for (const want of EXPECTED.waypoints) {
    const w = wpts.find((b) => field(b, 'name') === want.name);
    assert.ok(w, want.name);
    assert.deepEqual(position(w), [want.lat, want.lon], `${want.name} position in the GPX`);
    assert.equal(field(w, 'ele') === null ? null : Number(field(w, 'ele')), want.ele, `${want.name} <ele>`);
    const time = want.time ?? new Date(/** @type {Record<string, number>} */ (NO_GPX_TIME)[want.name]).toISOString().replace('.000Z', 'Z');
    assert.equal(field(w, 'time'), time, `${want.name} <time>`);
    assert.equal(field(w, 'cmt'), want.comment === '' ? null : want.comment, `${want.name} <cmt>`);
  }

  const rtes = blocks('rte');
  assert.equal(rtes.length, 1);
  const rtepts = [...rtes[0].matchAll(/<rtept\b[^>]*>[\s\S]*?<\/rtept>/g)].map((m) => m[0]);
  assert.deepEqual(rtepts.map((b) => field(b, 'name')), EXPECTED.routes[0].via.map((/** @type {any} */ v) => v.name));
  assert.deepEqual(rtepts.map(position), EXPECTED.routes[0].via.map((/** @type {any} */ v) => [v.lat, v.lon]));

  const trks = blocks('trk');
  assert.equal(trks.length, 7);
  for (const [name, label] of Object.entries(TRACK_LABEL)) {
    const trk = trks.find((b) => field(b, 'name') === name);
    assert.ok(trk, name);
    assert.equal((trk.match(/<trkseg>/g) ?? []).length, 1, `${name}: one <trkseg>`);
    const pts = [...trk.matchAll(/<trkpt\b[^>]*>[\s\S]*?<\/trkpt>|<trkpt\b[^>]*\/>/g)].map((m) => m[0]);
    const want = expectedPoints(label);
    assert.equal(pts.length, want.length, `${name}: <trkpt> count`);
    pts.forEach((b, i) => {
      assert.deepEqual(position(b), [want[i].lat, want[i].lon], `${name} point ${i + 1} position`);
      assert.equal(field(b, 'ele') === null ? null : Number(field(b, 'ele')), want[i].ele, `${name} point ${i + 1} <ele>`);
      assert.equal(field(b, 'time'), want[i].time, `${name} point ${i + 1} <time>`);
    });
  }

  // Smart lists are not in the download; the empty "Unlisted Data" list is, with no items.
  assert.ok(!names.some((n) => /Last (Week|Month)/.test(n)));
  assert.doesNotMatch(await text('GPX/My Collection/Unlisted Data.gpx'), /<(wpt|rte|trk)\b/);
  const report = await text('report.txt');
  assert.equal(report, exported.report.text);
  assert.ok(report.includes(LIBRARY_PROBLEMS.smart_lists_left_out.message));
  assert.ok(report.includes(LIBRARY_PROBLEMS.track_sensor_data_kept.message));
  assert.ok(report.includes('  - Tracks: 7 (6 with elevation or time, 1 with heart rate or temperature)'));
  assert.ok(!report.includes(LIBRARY_PROBLEMS.route_via_point_record.message), 'dump-level only');
  for (const section of ['Not converted', 'Duplicate names', 'Tracks without elevation and time']) {
    assert.ok(!report.includes(`\n${section}\n`), `no "${section}" section`);
  }
  assert.ok(report.includes('\nNotes and problems\n'));
});

// ---------------------------------------------------------------------------------------------
// run2: the same layouts on a library built on top of run1

test('run2: every record is H-MAC48; user lists, nested folders and items in two lists come out as built', async () => {
  const gdb = readContainer(new Uint8Array(readFileSync(join(RUN2, 'AllData.gdb'))), { role: 'gdb' });
  const counts = new Counts();
  for (const r of gdb.records) {
    const parsed = r.type === 'W' ? parseWaypoint(r.body, counts) : r.type === 'T' ? parseTrack(r.body, counts) : r.type === 'R' ? parseRoute(r.body, counts) : null;
    if (parsed) assert.deepEqual([parsed.accepted, parsed.layout], [1, 'H-MAC48'], `${r.type} ${parsed.name}`);
  }

  const { library, details } = await readThroughIntake(RUN2);
  assert.equal(details.fatal, null);
  assert.deepEqual(library.notConverted, []);
  const tree = treeOf(library);
  assert.deepEqual(
    tree.map((t) => `${t.type}: ${t.path}`),
    [
      'folder: My Collection',
      'folder: My Collection / Gate1 Trips',
      'list: My Collection / Gate1 Trips / gate1-ocean',
      'list: My Collection / Gate1 Trips / Gate1 Desert',
      'folder: My Collection / Gate1 Trips / Gate1 Inner',
      'list: My Collection / Gate1 Trips / Gate1 Inner / Gate1 Deep',
      'list: My Collection / Unlisted Data',
    ],
  );
  const items = Object.fromEntries(tree.map((t) => [t.path, t.items]));
  assert.equal(items['My Collection / Gate1 Trips / gate1-ocean'].length, 14);
  assert.deepEqual(items['My Collection / Gate1 Trips / Gate1 Desert'], ['Gate1 Track Timed', 'Gate1 Waypoint Alpha']);
  assert.deepEqual(items['My Collection / Gate1 Trips / Gate1 Inner / Gate1 Deep'], ['Gate1 Route Four', 'Gate1 Track Two Segments']);
  assert.equal(details.multiListItems, 4);
  assert.deepEqual(problemCounts(library), {
    smart_lists_left_out: 2,
    track_sensor_data_kept: 1,
    item_in_several_lists: 4,
    route_via_point_record: 4,
  });
  // Delta was edited in run2 (contact info typed): its creation time is unchanged, so its exported time is too.
  const delta = /** @type {import('../src/model.js').Waypoint} */ (library.items.find((i) => i.name === 'Gate1 Waypoint Delta'));
  assert.equal(delta.time, IMPORTED_DESERT);
  // The .bak files BaseCamp left next to the live ones are not read.
  assert.equal(library.items.filter((i) => i.kind === 'waypoint').length, 6);
});

// ---------------------------------------------------------------------------------------------
// The structure-only dump on real files: H-MAC48 is the one layout, and nothing personal leaks

/** @param {string} root */
function dumpOf(root) {
  const trackSegments = readdirSync(join(root, 'TrackSegments')).sort();
  const out = buildDump({
    toolVersion: '0.1.0',
    engine: 'Node',
    engineMajor: 22,
    inputKind: 'folder',
    allData: readContainer(new Uint8Array(readFileSync(join(root, 'AllData.gdb'))), { role: 'gdb' }),
    folderData: readContainer(new Uint8Array(readFileSync(join(root, 'FolderData.gfi'))), { role: 'gfi' }),
    trackSegments: trackSegments.map((name) => new Uint8Array(readFileSync(join(root, 'TrackSegments', name)))),
  });
  return { ...out, trackSegments };
}

for (const [run, root] of [['run1', RUN1], ['run2', RUN2]]) {
  test(`${run}: the structure dump reports every W, T and R as H-MAC48 only, and E, F, I and TrackSegments as expected`, () => {
    const { data } = dumpOf(root);
    const gdb = /** @type {any} */ (data).files['AllData.gdb'];
    for (const type of ['W', 'T', 'R']) {
      const t = gdb.recordTypes[type];
      assert.equal(t.layouts['H-MAC48'].accepted, t.count, `${type} H-MAC48`);
      assert.equal(t.verdict.matchedOnlyOne['H-MAC48'], t.count, `${type} only H-MAC48`);
      assert.equal(t.verdict.matchedNone + t.verdict.matchedMoreThanOne, 0, type);
      // B43: the header names Mac BaseCamp 4.8; with no tie, nothing was decided by it.
      assert.equal(t.tieBreak.programVersion, 'mac48', type);
      assert.equal(t.tieBreak.stillMoreThanOne + t.tieBreak.refusedForProgramVersion, 0, type);
      assert.deepEqual(Object.values(t.tieBreak.decidedByProgramVersion).filter((n) => n > 0), [], type);
    }
    assert.equal(gdb.recordTypes.E.layouts['FORMAT.md §3.2'].accepted, 1);
    assert.deepEqual(gdb.recordTypes.E.layouts['FORMAT.md §3.2'].amongAccepted, { mac48_length: 1 });
    const gfi = /** @type {any} */ (data).files['FolderData.gfi'];
    for (const [type, s] of Object.entries(gfi.recordTypes)) {
      assert.equal(/** @type {any} */ (Object.values(/** @type {any} */ (s).layouts)[0]).accepted, /** @type {any} */ (s).count, type);
    }
    assert.equal(gfi.recordTypes.F.layouts['FORMAT.md §8.1'].amongAccepted.mac48_tail, gfi.recordTypes.F.count);
    assert.equal(gfi.recordTypes.I.layouts['FORMAT.md §8.2'].amongAccepted.created_by_3, 2);
    const ts = /** @type {any} */ (data).files.TrackSegments;
    assert.deepEqual(ts.verdict, { only17: 7, only11: 0, both: 0, neither: 0 });
    assert.deepEqual(ts.layouts['17 bytes per point'].amongAccepted, { heart_rate: 1, temperature: 1 });
  });
}

test('run1: the structure dump holds no name, comment, address, coordinate, time or UUID from the library', () => {
  const { json, text, trackSegments } = dumpOf(RUN1);
  // (BaseCamp's own names "My Collection" and "Unlisted Data" are not sentinels: the dump's fixed words name them.)
  /** @type {string[]} */
  const sentinels = ['Gate1', 'gate1', 'ocean', 'Last Week', 'Last Month', 'Imported Street', '555-01', 'G1-0001', 'buildy'];
  for (const w of EXPECTED.waypoints) sentinels.push(String(w.lat), String(w.lon), String(Math.abs(w.lat)).slice(0, 7));
  for (const t of EXPECTED.tracks) for (const p of t.segments.flat()) sentinels.push(String(p.lat), String(p.lon));
  for (const name of trackSegments) sentinels.push(name, name.toLowerCase(), name.slice(0, 8));
  // Times: the GPX times and BaseCamp's import time, as ISO text and as Unix seconds.
  for (const iso of ['2001-02-03T04:05:06Z', '2002-03-04T05:06:07Z', '2026-10-07T11:40:16Z']) {
    sentinels.push(iso.slice(0, 10), String(Date.parse(iso) / 1000));
  }
  for (const out of [json, text]) {
    for (const s of sentinels) assert.ok(!out.includes(s), `the dump must not contain ${JSON.stringify(s)}`);
  }
});

// ---------------------------------------------------------------------------------------------
// B44: heart rate and air temperature, from the real sample to the GPX, against the GPX BaseCamp imported

const TPX_NS = 'http://www.garmin.com/xmlschemas/TrackPointExtension/v2';
const TMP = mkdtempSync(join(tmpdir(), 'bcr-real-gpx-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
let tmpFiles = 0;

/** Runs xmllint on a document (no network) and returns its standard output. @param {string} xml @param {string[]} args */
function xmllint(xml, args) {
  const path = join(TMP, `f${++tmpFiles}.gpx`);
  writeFileSync(path, xml, 'utf8');
  return execFileSync('xmllint', ['--nonet', ...args, path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * The track points of one <trk> of a GPX file, by its <name>: [lat, lon, atemp, hr] with null where absent. A plain
 * scan of the made-up source file, written for its shape (tools/gate1/make-gpx.js), not a GPX parser.
 * @param {string} gpx
 * @param {string} name
 */
function sensorPoints(gpx, name) {
  const trk = [...gpx.matchAll(/<trk>[\s\S]*?<\/trk>/g)].map((m) => m[0]).find((b) => b.includes(`<name>${name}</name>`));
  assert.ok(trk, name);
  return [...trk.matchAll(/<trkpt\b[^>]*?(?:\/>|>[\s\S]*?<\/trkpt>)/g)].map((m) => {
    const b = m[0];
    const pos = /lat="([^"]+)" lon="([^"]+)"/.exec(b);
    const atemp = /<(?:gpxtpx:)?atemp>([^<]*)</.exec(b);
    const hr = /<(?:gpxtpx:)?hr>([^<]*)</.exec(b);
    return [Number(pos?.[1]), Number(pos?.[2]), atemp ? Number(atemp[1]) : null, hr ? Number(hr[1]) : null];
  });
}

test('run1 (B44): Gate1 Track Sensors comes out with the heart rates and temperatures of the GPX BaseCamp imported, in Garmin\'s TrackPointExtension v2, well-formed', async () => {
  const source = readFileSync(join(HERE, '..', 'tools', 'gate1', 'gpx', 'gate1-deep.gpx'), 'utf8');
  const want = sensorPoints(source, 'Gate1 Track Sensors');
  assert.equal(want.length, 9);
  assert.ok(want.every((p) => p[2] !== null && p[3] !== null), 'every source point has both');

  const read = await readThroughIntake(RUN1);
  const exported = await exportLibrary(read, { now: () => Date.UTC(2026, 9, 7, 12), compression: 'store' });
  const zip = await openZip(exported.zip);
  /** @param {string} name */
  const text = async (name) => new TextDecoder().decode(await /** @type {any} */ (zip.entries.find((e) => e.name === name)).read());
  for (const file of ['GPX/My Collection/Gate1 Trips/gate1-ocean.gpx', 'GPX/All items.gpx']) {
    const gpx = await text(file);
    const got = sensorPoints(gpx, 'Gate1 Track Sensors');
    assert.equal(got.length, want.length, file);
    got.forEach((p, i) => {
      assert.ok(Math.abs(p[0] - want[i][0]) <= 1e-7 && Math.abs(p[1] - want[i][1]) <= 1e-7, `${file} point ${i + 1} position`);
      assert.deepEqual([p[2], p[3]], [want[i][2], want[i][3]], `${file} point ${i + 1} atemp and hr`);
    });
    // No other track gains sensor values.
    assert.equal((gpx.match(/<gpxtpx:TrackPointExtension>/g) ?? []).length, 9, `${file}: only the sensor track's 9 points`);
    // Well-formed with namespaces, the prefix declared once at the root, and every value in the v2 namespace.
    xmllint(gpx, ['--noout']);
    assert.match(gpx.split('\n')[1], new RegExp(`xmlns:gpxtpx="${TPX_NS.replace(/[/.]/g, '\\$&')}"`));
    assert.match(gpx.split('\n')[1], /http:\/\/www8\.garmin\.com\/xmlschemas\/TrackPointExtensionv2\.xsd/);
    const count = (/** @type {string} */ local) =>
      Number(xmllint(gpx, ['--xpath', `count(//*[local-name()="${local}" and namespace-uri()="${TPX_NS}"])`]).trim());
    assert.deepEqual([count('TrackPointExtension'), count('atemp'), count('hr')], [9, 9, 9], file);
    // The extension is the last child of its trkpt, after ele and time (GPX 1.1's wptType), with atemp before hr.
    const order = xmllint(gpx, ['--xpath', `//*[local-name()="trkpt"][*[local-name()="extensions"]]/*`]).match(/<[a-z:A-Z]+/g)?.map((t) => t.slice(1));
    assert.deepEqual(order?.slice(0, 3), ['ele', 'time', 'extensions']);
    assert.ok(/<gpxtpx:atemp>[^<]*<\/gpxtpx:atemp>\s*<gpxtpx:hr>/.test(gpx), 'atemp before hr');
  }
  // The KML stays as it was (B44): no sensor values.
  const kml = await text('KML/My Collection.kml');
  assert.ok(!/atemp|heart|TrackPointExtension/i.test(kml));
  // The report says they were kept, and where.
  assert.ok(exported.report.text.includes(LIBRARY_PROBLEMS.track_sensor_data_kept.message));
});
