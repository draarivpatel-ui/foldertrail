// The reader (src/format/) against the independent fixture writer (tools/fixtures/). Both were written from
// docs/FORMAT.md without seeing each other; agreement here means agreement on FORMAT.md, not on real BaseCamp files.
//
// For every scenario: build the library bytes, run the reader as the worker does (a located library of SourceFile
// handles → readLibrary), and compare with the writer's own expectation (tools/fixtures/README.md, "Expected
// result"): items by (kind, name) as multisets with every exported field, positions within 1e-7°, tree placement by
// name path, not-converted tracks and routes, duplicate groups, and problem codes (counts where the writer fixed
// them). Two scenarios also go through the real intake path (a .Backup File → intake → worker source → reader).
//
// When the two sides disagree, FORMAT.md decides which is wrong. A fixture that FORMAT.md shows to be wrong is
// skipped here with the reason, never edited. (None is skipped at the time of writing.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, buildScenario } from '../tools/fixtures/scenarios.js';
import { buildBackup } from '../tools/fixtures/backup.js';
import { readLibrary, LIBRARY_PROBLEMS } from '../src/format/library.js';
import { intake, toWorkerSource, fromWorkerSource } from '../src/app/intake.js';

const DEGREES = 1e-7;

/** Reader codes that have a different name in the writer's vocabulary (README "Problem vocabulary"). */
const TO_FIXTURE = Object.freeze({
  track_segments_unreadable: 'track_segments_not_decoded',
  waypoint_several_layouts: 'waypoint_details_not_decoded',
});

/** Writer reasons for routes not converted → reader reasons. */
const ROUTE_REASON = Object.freeze({
  autoroute: 'route_autoroute',
  not_decoded: 'route_not_decoded',
  via_unresolved: 'route_via_unresolved',
});

/** Fixture disagreements with FORMAT.md: scenario name → reason (the case is skipped, the fixture is not edited). */
const SKIPS = Object.freeze({});

/**
 * A SourceFile (intake.js) over bytes in memory.
 * @param {string} name
 * @param {Uint8Array} bytes
 */
function sourceFile(name, bytes) {
  return {
    name,
    path: name,
    size: bytes.length,
    lastModified: null,
    origin: /** @type {const} */ ('file'),
    blob: null,
    zip: null,
    bytes: async (start = 0, end = bytes.length) => bytes.slice(start, Math.min(end, bytes.length)),
    release() {},
  };
}

/** @param {{files: Map<string, Uint8Array>}} built */
function locate(built) {
  /** @type {Map<string, ReturnType<typeof sourceFile>>} */
  const trackSegments = new Map();
  for (const [path, bytes] of built.files) {
    if (path.startsWith('TrackSegments/')) trackSegments.set(path.slice('TrackSegments/'.length), sourceFile(path, bytes));
  }
  const file = (/** @type {string} */ name) => (built.files.has(name) ? sourceFile(name, /** @type {Uint8Array} */ (built.files.get(name))) : null);
  return { allData: file('AllData.gdb'), folderData: file('FolderData.gfi'), trackSegments };
}

/**
 * Name paths from the root for every folder and list.
 * @param {import('../src/model.js').Folder[]} folders
 * @returns {Map<string, string[]>}
 */
function folderPaths(folders) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  /** @type {Map<string, string[]>} */
  const out = new Map();
  for (const folder of folders) {
    /** @type {string[]} */
    const path = [];
    /** @type {any} */
    let at = folder;
    for (let guard = 0; at && guard < 100; guard++) {
      path.unshift(at.name);
      at = at.parentId === null ? null : byId.get(at.parentId);
    }
    out.set(folder.id, path);
  }
  return out;
}

/** @param {string[][]} paths */
const pathSet = (paths) => paths.map((p) => p.join(' / ')).sort();

/**
 * @param {number|null} a
 * @param {number|null} b
 * @param {number} tolerance
 */
function near(a, b, tolerance) {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= tolerance;
}

/**
 * Whether a reader item has every field the writer expects (lists and placement are compared separately).
 * @param {any} mine
 * @param {any} expected
 */
function sameItem(mine, expected) {
  if (mine.kind !== expected.kind || mine.name !== expected.name) return false;
  if (expected.kind === 'waypoint') {
    return (
      mine.comment === expected.comment &&
      mine.icon === expected.icon &&
      near(mine.lat, expected.lat, DEGREES) &&
      near(mine.lon, expected.lon, DEGREES) &&
      mine.ele === expected.ele &&
      mine.time === expected.time
    );
  }
  if (expected.kind === 'track') {
    if (mine.colorIndex !== expected.colorIndex) return false;
    const segs = mine.segments;
    if (segs.length !== expected.segments.length) return false;
    for (let s = 0; s < segs.length; s++) {
      if (segs[s].length !== expected.segments[s].length) return false;
      for (let i = 0; i < segs[s].length; i++) {
        const p = segs[s][i];
        const q = expected.segments[s][i];
        if (!near(p.lat, q.lat, DEGREES) || !near(p.lon, q.lon, DEGREES) || p.ele !== q.ele || p.time !== q.time) return false;
        // B44: heart rate and air temperature, exactly, and only where the writer put them.
        if ((p.hr ?? null) !== (q.hr ?? null) || (p.atemp ?? null) !== (q.atemp ?? null)) return false;
      }
    }
    return true;
  }
  if (mine.points.length !== expected.points.length) return false;
  return expected.points.every(
    (/** @type {any} */ q, /** @type {number} */ i) =>
      mine.points[i].name === q.name && near(mine.points[i].lat, q.lat, DEGREES) && near(mine.points[i].lon, q.lon, DEGREES),
  );
}

/**
 * Compares one scenario's reader result with its expectation.
 * @param {string} name
 * @param {any} expected
 * @param {Awaited<ReturnType<typeof readLibrary>>} result
 */
function compare(name, expected, result) {
  const { library, details } = result;
  const mineCodes = new Map();
  for (const p of library.problems) {
    const code = /** @type {Record<string, string>} */ (TO_FIXTURE)[p.code] ?? p.code;
    const prev = mineCodes.get(code);
    mineCodes.set(code, { count: (prev?.count ?? 0) + p.count, level: prev?.level === 'report' ? 'report' : p.level, own: p.code });
  }

  if (expected.fatal) {
    assert.equal(details.fatal?.code, expected.fatal.code, `${name}: fatal code`);
    assert.equal(library.items.length, 0, `${name}: no items after a fatal problem`);
    assert.ok(mineCodes.has(expected.fatal.code), `${name}: the fatal code is among the problems`);
    return;
  }
  assert.equal(details.fatal, null, `${name}: no fatal problem`);
  assert.equal(details.versions.gdb, expected.versions.gdb, `${name}: AllData.gdb version`);
  assert.equal(details.versions.gfi, expected.versions.gfi, `${name}: FolderData.gfi version`);
  assert.equal(details.experimental, expected.experimental, `${name}: experimental`);

  // Tree, as a set of (path, type).
  const paths = folderPaths(library.folders);
  const tree = library.folders.map((f) => `${f.type}: ${/** @type {string[]} */ (paths.get(f.id)).join(' / ')}`).sort();
  const wantTree = expected.tree.map((/** @type {any} */ t) => `${t.type}: ${t.path.join(' / ')}`).sort();
  assert.deepEqual(tree, wantTree, `${name}: tree`);
  assert.equal(library.treeMissing, expected.tree.length === 0, `${name}: treeMissing`);

  // Items with their placement.
  /** @type {Map<string, string[][]>} */
  const listsOf = new Map();
  for (const folder of library.folders) {
    for (const id of folder.itemIds) {
      const list = listsOf.get(id) ?? [];
      list.push(/** @type {string[]} */ (paths.get(folder.id)));
      listsOf.set(id, list);
    }
  }
  const ambiguous = new Set(library.ambiguous ?? []);
  /** @param {any} item */
  const placement = (item) => {
    if (library.treeMissing) return 'flat';
    if (ambiguous.has(item.id)) return 'duplicate-names';
    return listsOf.has(item.id) ? 'lists' : 'not-in-any-list';
  };
  assert.equal(library.items.length, expected.items.length, `${name}: item count`);
  const unmatched = [...library.items];
  for (const want of expected.items) {
    const at = unmatched.findIndex(
      (item) =>
        sameItem(item, want) &&
        placement(item) === want.placement &&
        JSON.stringify(pathSet(listsOf.get(item.id) ?? [])) === JSON.stringify(pathSet(want.lists)),
    );
    if (at < 0) {
      const candidates = library.items.filter((i) => i.kind === want.kind && i.name === want.name);
      assert.fail(
        `${name}: no reader item matches expected ${want.kind} "${want.name}" (${want.specId}, ${want.placement}); ` +
          `reader has ${candidates.length} with that name: ` +
          JSON.stringify(candidates.map((c) => ({ ...c, placement: placement(c), lists: pathSet(listsOf.get(c.id) ?? []) }))).slice(0, 1500),
      );
    }
    unmatched.splice(at, 1);
  }

  // Not converted: tracks not decoded, routes not converted.
  const nc = library.notConverted ?? [];
  /** @param {string[]} ids */
  const listPaths = (ids) => pathSet(ids.map((id) => /** @type {string[]} */ (paths.get(id))));
  const tracksNc = nc.filter((n) => n.kind === 'track').map((n) => `${n.name} | ${n.reason} | ${listPaths(n.listIds).join(', ')}`).sort();
  const wantTracksNc = expected.notDecoded.map((/** @type {any} */ n) => `${n.name} | track_not_decoded | ${pathSet(n.lists).join(', ')}`).sort();
  assert.deepEqual(tracksNc, wantTracksNc, `${name}: tracks not decoded`);
  const routesNc = nc.filter((n) => n.kind === 'route').map((n) => `${n.name} | ${n.reason} | ${listPaths(n.listIds).join(', ')}`).sort();
  const wantRoutesNc = expected.routesNotConverted
    .map((/** @type {any} */ n) => `${n.name} | ${/** @type {any} */ (ROUTE_REASON)[n.reason]} | ${pathSet(n.lists).join(', ')}`)
    .sort();
  assert.deepEqual(routesNc, wantRoutesNc, `${name}: routes not converted`);
  assert.equal(nc.filter((n) => n.kind === 'waypoint').length, 0, `${name}: every waypoint prefix decoded`);

  // Duplicate link keys.
  const dups = result.details.duplicates.map((d) => `${d.kind} | ${d.name} | ${d.copies} | ${listPaths(d.listIds).join(', ')}`).sort();
  const wantDups = expected.duplicates
    .map((/** @type {any} */ d) => `${d.kind} | ${d.name} | ${d.copies} | ${pathSet(d.referencedBy).join(', ')}`)
    .sort();
  assert.deepEqual(dups, wantDups, `${name}: duplicate names`);

  // Problems: what the writer says is reported must be reported (and shown in the report); what it says is counted
  // must be counted; anything else the reader shows the user must be tolerated by the scenario.
  const tolerated = new Set(expected.tolerated);
  for (const want of expected.problems) {
    const mine = mineCodes.get(want.code);
    assert.ok(mine, `${name}: expected reported problem ${want.code}`);
    assert.equal(mine.level, 'report', `${name}: ${want.code} is shown in the report`);
    if (typeof want.count === 'number') assert.equal(mine.count, want.count, `${name}: count of ${want.code}`);
  }
  for (const want of expected.counted) {
    const mine = mineCodes.get(want.code);
    assert.ok(mine, `${name}: expected counted problem ${want.code}`);
    if (typeof want.count === 'number') assert.equal(mine.count, want.count, `${name}: count of ${want.code}`);
  }
  const expectedCodes = new Set([...expected.problems, ...expected.counted].map((p) => p.code));
  for (const [code, mine] of mineCodes) {
    if (expectedCodes.has(code) || tolerated.has(code)) continue;
    // A reader-only diagnostic with no counterpart in the writer's vocabulary is allowed in the dump only.
    assert.equal(mine.level, 'dump', `${name}: unexpected problem ${mine.own} shown to the user`);
  }
}

for (const scenario of SCENARIOS) {
  const skip = /** @type {Record<string, string>} */ (SKIPS)[scenario.name];
  test(`reader matches fixture: ${scenario.name}`, { skip: skip ?? false }, async () => {
    const { built, expected } = buildScenario(scenario.name);
    const result = await readLibrary(locate(built));
    compare(scenario.name, expected, result);
  });
}

test('every problem code the reader can emit has plain words and a level', () => {
  for (const [code, spec] of Object.entries(LIBRARY_PROBLEMS)) {
    assert.match(code, /^[a-z0-9_]+$/);
    assert.ok(spec.level === 'report' || spec.level === 'dump', code);
    assert.ok(spec.message.length > 10 && !/[{}#]/.test(spec.message), code);
  }
});

for (const name of ['nested-tree', 'tracks-elevation-time']) {
  test(`reader matches fixture through the real intake path (.Backup): ${name}`, async () => {
    const { built, expected } = buildScenario(name);
    const bytes = await buildBackup(built, { compression: 'store' });
    const file = new File([bytes], 'Library.Backup');
    const found = await intake(file);
    assert.equal(found.ok, true, 'intake found the library');
    const source = toWorkerSource(found.found);
    const revived = await fromWorkerSource(structuredClone(source));
    assert.deepEqual(revived.problems, []);
    const result = await readLibrary(revived.found);
    compare(name, expected, result);
  });
}
