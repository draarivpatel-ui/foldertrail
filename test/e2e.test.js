// End-to-end tests of the real app page in headless Chrome (tools/e2e/run.js), over every fixture scenario, both as
// a folder and as a .Backup file: preview totals and tree, unlock (licence check answered by Fetch interception,
// never the real provider), the downloaded ZIP (paths, GPX items and positions, KML and GPX well-formed, report),
// console errors, Content-Security-Policy violations, requests to other origins, and the page heap.
//
// The browser part is OPT-IN, so the normal suite stays fast. Run it through the heavy-job wrapper:
//   env BCR_E2E=1 node --test test/e2e.test.js
// BCR_E2E_OUT=<dir> keeps the build, fixtures, downloads and summary.md there (default: a temporary folder, removed).
// BCR_E2E_ONLY=name,name limits the scenarios (the per-scenario tests of the others are then skipped).
//
// The first tests below always run (no browser, milliseconds): they check the harness's own GPX reader and
// comparisons, so a broken comparison cannot make the browser run pass without looking.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { SCENARIOS, buildScenario } from '../tools/fixtures/scenarios.js';
import { writeGpx } from '../src/export/gpx.js';
import { writeKml } from '../src/export/kml.js';
import { compareItems, expectedLayout, itemMismatch, parseGpx, checkSafeSegment, isPlainName, kmlPoints, DEGREES } from '../tools/e2e/expect.js';
import { checkPreview, checkZip } from '../tools/e2e/run.js';
import { REAL_SAMPLES, realExpected, realSample, checkRealZip, kmlFolders } from '../tools/e2e/real.js';
import { intake, toWorkerSource, fromWorkerSource } from '../src/app/intake.js';
import { readLibrary } from '../src/format/library.js';
import { exportLibrary } from '../src/app/pipeline.js';
import { openZip } from '../src/format/unzip.js';
import { summarySentence } from '../src/app/ui.js';

// ---------------------------------------------------------------------------------------------
// The harness itself (always on)

/** A fixture item as the app's model item, for the real GPX writer. */
function toModel(/** @type {any} */ item, /** @type {number} */ i) {
  if (item.kind === 'waypoint') return { ...item, id: `x${i}`, symbol: '' };
  if (item.kind === 'track') return { ...item, id: `x${i}`, comment: '', color: null };
  return { ...item, id: `x${i}`, comment: '', points: item.points.map((/** @type {any} */ p) => ({ ...p, ele: null, symbol: '' })) };
}

test('e2e harness: parseGpx reads back what src/export/gpx.js writes, for every kind', () => {
  for (const name of ['nested-tree', 'tracks-elevation-time', 'multi-segment-tracks', 'routes', 'text-encodings', 'waypoint-details']) {
    const { expected } = buildScenario(name);
    const { xml } = writeGpx(expected.items.map(toModel), { creator: 'Foldertrail', name: 'Day <1> & "2"', desc: 'My Collection / A' });
    const gpx = parseGpx(xml);
    assert.equal(gpx.name, 'Day <1> & "2"', `${name}: metadata name`);
    assert.equal(gpx.desc, 'My Collection / A', `${name}: metadata desc`);
    assert.deepEqual(compareItems(expected.items, gpx.items), [], `${name}: every item read back`);
  }
});

test('e2e harness: kmlPoints reads the waypoint positions src/export/kml.js writes', () => {
  const { expected } = buildScenario('nested-tree');
  const items = expected.items.map(toModel);
  const library = {
    folders: [
      { id: 'r', name: 'My Collection', type: 'folder', parentId: null, itemIds: [] },
      { id: 'l', name: 'A list', type: 'list', parentId: 'r', itemIds: items.map((/** @type {any} */ i) => i.id) },
    ],
    items,
  };
  const points = kmlPoints(writeKml(/** @type {any} */ (library), { name: 'My Collection' }).xml);
  const waypoints = expected.items.filter((/** @type {any} */ i) => i.kind === 'waypoint');
  assert.equal(points.length, waypoints.length);
  for (const w of waypoints) {
    assert.ok(points.some((p) => p.name === w.name && Math.abs(p.lat - w.lat) <= DEGREES && Math.abs(p.lon - w.lon) <= DEGREES), w.name);
  }
});

test('e2e harness: compareItems catches a moved point, a changed time, a missing item and an extra item', () => {
  const { expected } = buildScenario('nested-tree');
  const items = expected.items;
  const gpx = parseGpx(writeGpx(items.map(toModel), { creator: 'x' }).xml);
  const wp = gpx.items.find((i) => i.kind === 'waypoint' && i.name === 'Lower bridge');
  const moved = { .../** @type {any} */ (wp), lat: /** @type {any} */ (wp).lat + 2e-7 };
  assert.match(itemMismatch(items.find((/** @type {any} */ i) => i.name === 'Lower bridge'), moved), /position/);
  const trk = /** @type {any} */ (gpx.items.find((i) => i.kind === 'track'));
  const shifted = { ...trk, segments: [trk.segments[0].map((/** @type {any} */ p, /** @type {number} */ k) => (k === 3 ? { ...p, time: p.time + 1000 } : p))] };
  assert.match(itemMismatch(items.find((/** @type {any} */ i) => i.kind === 'track'), shifted), /point 3 time/);
  const fewer = gpx.items.filter((i) => i.name !== 'Picnic spot');
  assert.deepEqual(compareItems(items, fewer), ['waypoint "Picnic spot" is missing']);
  assert.deepEqual(compareItems(items.filter((/** @type {any} */ i) => i.kind !== 'route'), gpx.items), ['unexpected route "Bridge to bridge"']);
  const rte = /** @type {any} */ (gpx.items.find((i) => i.kind === 'route'));
  assert.match(itemMismatch(items.find((/** @type {any} */ i) => i.kind === 'route'), { ...rte, points: rte.points.slice(1) }), /route points/);
});

test('e2e harness: expectedLayout counts per list and places every file', () => {
  const nested = expectedLayout(buildScenario('nested-tree').expected);
  assert.deepEqual(nested.totals, { waypoints: 5, tracks: 1, routes: 1, lists: 5, folders: 4 });
  const walks = nested.rows.find((r) => r.path.at(-1) === 'Valley C walks');
  assert.deepEqual(walks?.counts, { waypoints: 2, tracks: 1, routes: 0 });
  assert.ok(nested.files.some((f) => f.zipPath === 'GPX/My Collection/Region A/Valley B/2026/Valley C walks.gpx'));
  assert.ok(nested.files.some((f) => f.role === 'all' && f.items.length === 7));
  assert.equal(nested.unlisted, 0);

  const flat = expectedLayout(buildScenario('no-folder-data').expected);
  assert.equal(flat.treeMissing, true);
  assert.deepEqual(flat.files.map((f) => f.zipPath).sort(), ['GPX/All items.gpx', 'GPX/Routes.gpx', 'GPX/Tracks.gpx', 'GPX/Waypoints.gpx']);
  assert.equal(flat.unlisted, 0, 'without a tree nothing is "not in any list": everything is grouped by type');

  const dups = expectedLayout(buildScenario('duplicate-names').expected);
  assert.equal(dups.ambiguous, 4);
  assert.equal(dups.duplicateItems.length, 4);

  const fatal = expectedLayout(buildScenario('corrupt-bad-signature').expected);
  assert.equal(fatal.fatal, true);
  assert.deepEqual(fatal.files, []);

  assert.equal(isPlainName('Valley C walks'), true);
  assert.equal(isPlainName('Été 🌞'), false);
  assert.deepEqual(checkSafeSegment('Été 🌞'), []);
  assert.ok(checkSafeSegment('a:b').length > 0 && checkSafeSegment('.hidden').length > 0 && checkSafeSegment('é').length > 0);
});

test('e2e harness: checkPreview reads a library where nothing converts (the page names what it holds, not "No waypoints")', () => {
  // The page's own sentence for two road-following routes and nothing else (ui.js summarySentence).
  const preview = {
    totals: { folders: 0, lists: 0, waypoints: 0, tracks: 0, routes: 0 },
    treeMissing: true,
    notConverted: [
      { kind: 'route', name: 'Coast road', reason: 'route_autoroute', listIds: [] },
      { kind: 'route', name: 'Inland road', reason: 'route_autoroute', listIds: [] },
    ],
  };
  const summary = summarySentence(/** @type {any} */ (preview));
  assert.match(summary, /^Your library holds 2 routes, but none of them can/);
  const layout = /** @type {any} */ ({
    fatal: false, treeMissing: true, totals: { waypoints: 0, tracks: 0, routes: 0, lists: 0, folders: 0 }, rows: [],
    unlisted: 0, ambiguous: 0, files: [], duplicateItems: [], notConvertedNames: ['Coast road', 'Inland road'],
  });
  const page = {
    summary, notices: 'No folders or lists were found in this library.', also: '', alsoRows: [],
    notConverted: '2 routes that follow roads Coast road Inland road', rows: [],
  };
  /** @type {string[]} */
  const ok = [];
  checkPreview(page, layout, { experimental: false }, ok);
  assert.deepEqual(ok, []);
  /** @type {string[]} */
  const wrong = [];
  checkPreview({ ...page, summary: 'No waypoints, tracks or routes were found in this library.' }, layout, { experimental: false }, wrong);
  assert.ok(wrong.some((p) => /nothing converts/.test(p)), wrong.join('\n'));
  // A truly empty library still wants "No waypoints, tracks or routes".
  /** @type {string[]} */
  const empty = [];
  checkPreview({ ...page, summary: 'No waypoints, tracks or routes were found in this library.', notConverted: '' }, { ...layout, notConvertedNames: [] }, { experimental: false }, empty);
  assert.deepEqual(empty, []);
});

test('e2e harness: checkPreview flags a wrong count, a missing row and an unexpected "Not in any list"', () => {
  const { expected } = buildScenario('nested-tree');
  const layout = expectedLayout(expected);
  // What the page drew for nested-tree in a passing run (rows in tree order).
  const rows = [
    [1, 'folder', 'My Collection', ['', '', '']],
    [2, 'folder', 'Region A', ['', '', '']],
    [3, 'folder', 'Valley B', ['', '', '']],
    [4, 'folder', '2026', ['', '', '']],
    [5, 'list', 'Valley C walks', ['2', '1', '–']],
    [4, 'list', 'Empty list', ['–', '–', '–']],
    [3, 'list', 'Imported', ['1', '–', '–']],
    [2, 'list', 'Favourites', ['1', '–', '1']],
    [2, 'list', 'Unlisted Data', ['1', '–', '–']],
    [2, 'folder', 'Empty folder', ['', '', '']],
  ].map(([level, type, title, nums]) => ({ level, type, title, untitled: false, nums }));
  const good = {
    summary: 'Your library holds 5 waypoints, 1 track and 1 route, in 5 lists and 4 folders.',
    notices: '', also: '', alsoRows: [], notConverted: '', rows,
  };
  /** @type {string[]} */
  const ok = [];
  checkPreview(good, layout, expected, ok);
  assert.deepEqual(ok, []);

  /** @type {string[]} */
  const bad = [];
  checkPreview(
    {
      ...good,
      summary: good.summary.replace('5 waypoints', '4 waypoints'),
      rows: rows.filter((r) => r.title !== 'Imported').map((r) => (r.title === 'Favourites' ? { ...r, nums: ['1', '–', '–'] } : r)),
      alsoRows: [{ title: 'Not in any list', count: '1 waypoint' }],
    },
    layout,
    expected,
    bad,
  );
  assert.ok(bad.some((p) => /summary says 4 waypoints/.test(p)), bad.join('\n'));
  assert.ok(bad.some((p) => /tree is missing list: My Collection \/ Region A \/ Imported/.test(p)), bad.join('\n'));
  assert.ok(bad.some((p) => /Favourites shows 1\/0\/0/.test(p)), bad.join('\n'));
  assert.ok(bad.some((p) => /"Not in any list" shows 1 items, want 0/.test(p)), bad.join('\n'));
});

// ---------------------------------------------------------------------------------------------
// The real BaseCamp samples' expectation (tools/e2e/real.js), checked without a browser: the app's own path in Node
// (intake, worker source, readLibrary, exportLibrary) must pass the very ZIP checks the browser run applies (the page
// preview is checked in the browser only), so a wrong
// expectation cannot hide behind a browser failure, and a broken check cannot pass a broken download.

/**
 * A real sample as the browser hands it to the app: the 4.8 folder's files (webkitdirectory), or the .Backup file.
 * @param {string} name
 * @param {'folder'|'backup'} how
 * @returns {File[]}
 */
function realFiles(name, how) {
  const s = realSample(name);
  if (how === 'backup') return [new File([readFileSync(/** @type {string} */ (s.backup))], `${name}.Backup`, { lastModified: 1000 })];
  /** @type {File[]} */
  const out = [];
  const walk = (/** @type {string} */ dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else {
        const file = new File([readFileSync(path)], entry, { lastModified: 1000 });
        Object.defineProperty(file, 'webkitRelativePath', { value: `4.8/${relative(s.source, path).split('\\').join('/')}` });
        out.push(file);
      }
    }
  };
  walk(s.source);
  return out;
}

/**
 * @param {string} name
 * @param {'folder'|'backup'} how
 */
async function realDownload(name, how) {
  const found = await intake(realFiles(name, how));
  assert.equal(found.ok, true, `${name} (${how}): intake`);
  const revived = await fromWorkerSource(structuredClone(toWorkerSource(found.found)));
  const read = await readLibrary(revived.found);
  return exportLibrary(read, { now: () => Date.UTC(2026, 9, 7, 12), compression: 'store' });
}

for (const sample of REAL_SAMPLES) {
  for (const how of /** @type {const} */ (['folder', 'backup'])) {
    if (how === 'backup' && !sample.backup) continue;
    test(`e2e harness: ${sample.name} (${how}) through the app in Node passes every ZIP check the browser run applies`, async () => {
      const exported = await realDownload(sample.name, how);
      const expected = realExpected(sample.name);
      const layout = expectedLayout(expected);
      const result = /** @type {any} */ ({ problems: [], checked: { rows: 0, gpxFiles: 0, items: 0 }, zipEntries: null });
      const scratch = await mkdtemp(join(tmpdir(), 'foldertrail-real-'));
      try {
        const files = await checkZip(exported.zip, layout, expected, exported.report.text, join(scratch, 'x'), result);
        assert.ok(files, 'the ZIP opened');
        checkRealZip(sample.name, files, result.problems);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
      assert.deepEqual(result.problems, []);
      // Every list's GPX, the All items file, and each of the 14 items in it was compared.
      const lists = expected.tree.filter((/** @type {any} */ e) => e.type === 'list').length;
      assert.equal(result.checked.gpxFiles, lists + 1);
      assert.ok(result.checked.items >= 28, `items compared: ${result.checked.items}`);
      assert.equal(layout.totals.waypoints + layout.totals.tracks + layout.totals.routes, 14);
    });
  }
}

test('e2e harness: checkRealZip catches a smart list written, a placemark in the wrong folder and a report that hides the left-out lists', async () => {
  const exported = await realDownload('real-run1', 'folder');
  const zip = await openZip(exported.zip);
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  for (const e of zip.entries) if (!e.name.endsWith('/')) files.set(e.name, await e.read());
  /** @type {string[]} */
  const clean = [];
  checkRealZip('real-run1', files, clean);
  assert.deepEqual(clean, []);

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const kml = dec.decode(files.get('KML/My Collection.kml'));
  const folders = kmlFolders(kml);
  assert.deepEqual([...folders.keys()], ['My Collection', 'My Collection / Gate1 Trips', 'My Collection / Gate1 Trips / gate1-ocean', 'My Collection / Unlisted Data']);
  assert.equal(folders.get('My Collection / Gate1 Trips / gate1-ocean')?.length, 14);

  /** @param {(m: Map<string, Uint8Array>) => void} change */
  const problemsAfter = (change) => {
    const copy = new Map(files);
    change(copy);
    /** @type {string[]} */
    const out = [];
    checkRealZip('real-run1', copy, out);
    return out.join('\n');
  };
  assert.match(problemsAfter((m) => m.set('GPX/My Collection/Last Week.gpx', enc.encode('<gpx/>'))), /smart list was written/);
  // One placemark moved out of gate1-ocean into Unlisted Data.
  const moved = kml.replace(/(<Folder>\s*<name>Unlisted Data<\/name>)/, '$1<Placemark><name>Gate1 Waypoint Alpha</name></Placemark>');
  assert.notEqual(moved, kml, 'the KML has an Unlisted Data folder to plant into');
  assert.match(problemsAfter((m) => m.set('KML/My Collection.kml', enc.encode(moved))), /KML folder My Collection \/ Unlisted Data holds 1 placemarks/);
  const report = dec.decode(files.get('report.txt'));
  assert.match(problemsAfter((m) => m.set('report.txt', enc.encode(report.replace(/BaseCamp's smart lists/, 'Some lists')))), /2 smart lists were left out/);
  assert.match(problemsAfter((m) => m.set('report.txt', enc.encode(report.replace('  - Routes: 1', '  - Routes: 0')))), /no line "- Routes: 1"/);
});

// ---------------------------------------------------------------------------------------------
// The real browser (opt-in)

const E2E = process.env.BCR_E2E === '1';
const ONLY = process.env.BCR_E2E_ONLY ? new Set(process.env.BCR_E2E_ONLY.split(',').map((s) => s.trim()).filter(Boolean)) : null;
const NAMES = SCENARIOS.map((s) => s.name).filter((n) => !ONLY || ONLY.has(n));
const INTAKES = /** @type {const} */ (['folder', 'backup']);
const REAL = REAL_SAMPLES.map((s) => s.name).filter((n) => !ONLY || ONLY.has(n));

describe('real browser (BCR_E2E=1)', { skip: E2E ? false : 'opt-in: set BCR_E2E=1' }, () => {
  /** @type {import('../tools/e2e/run.js').RunResult[]} */
  let results = [];
  /** @type {Map<string, number>} */
  let sizes = new Map();
  let outDir = '';
  let keep = false;
  /** @type {Error|null} */
  let setupError = null;

  before(async () => {
    keep = Boolean(process.env.BCR_E2E_OUT);
    outDir = process.env.BCR_E2E_OUT || (await mkdtemp(join(tmpdir(), 'foldertrail-e2e-')));
    const { runE2E, summaryTable } = await import('../tools/e2e/run.js');
    try {
      const run = await runE2E({ outDir, scenarios: NAMES, bulk: !ONLY || ONLY.has('e2e-bulk'), real: REAL });
      results = run.results;
      sizes = run.sizes;
      const table = summaryTable(results, sizes, run.chrome);
      await writeFile(join(outDir, 'summary.md'), `${table}\n`);
      await writeFile(join(outDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
      console.log(`\n${table}\n`);
    } catch (error) {
      setupError = /** @type {Error} */ (error);
    }
  });

  after(async () => {
    if (!keep && outDir) await rm(outDir, { recursive: true, force: true });
  });

  /**
   * @param {string} scenario
   * @param {string} intake
   */
  const check = (scenario, intake) => {
    if (setupError) throw setupError;
    const r = results.find((x) => x.scenario === scenario && x.intake === intake);
    assert.ok(r, `no run for ${scenario} (${intake})`);
    const detail = [
      `ended on: ${r.outcome}`,
      ...r.problems,
      ...r.consoleErrors.map((e) => `console: ${e}`),
      ...r.csp.map((e) => `csp: ${e}`),
      ...r.foreign.map((e) => `other origin: ${e}`),
    ].join('\n  ');
    assert.equal(r.status, 'pass', `${scenario} (${intake}):\n  ${detail}`);
  };

  for (const name of SCENARIOS.map((s) => s.name)) {
    for (const intake of INTAKES) {
      test(`${name} as a ${intake === 'folder' ? 'folder' : '.Backup file'}`, { skip: NAMES.includes(name) ? false : 'not in BCR_E2E_ONLY' }, () => check(name, intake));
    }
  }

  for (const intake of INTAKES) {
    test(`e2e-bulk (a bigger made-up library, for memory) as a ${intake === 'folder' ? 'folder' : '.Backup file'}`, { skip: !ONLY || ONLY.has('e2e-bulk') ? false : 'not in BCR_E2E_ONLY' }, () => {
      check('e2e-bulk', intake);
      const r = /** @type {any} */ (results.find((x) => x.scenario === 'e2e-bulk' && x.intake === intake));
      // A loose ceiling, far above what was measured (about 1.4 MB on 2026-10-06, Chrome 154): the parsing happens in the
      // worker, so this catches the page starting to hold the library itself, not small changes.
      assert.ok(r.heapAfterExport !== null && r.heapAfterExport < 64 * 1048576, `page heap after export: ${r.heapAfterExport} bytes`);
    });
  }

  for (const name of ['nested-tree', 'tracks-elevation-time']) {
    test(`${name} as the version folder itself (4.8)`, { skip: NAMES.includes(name) ? false : 'not in BCR_E2E_ONLY' }, () => check(name, 'version-folder'));
  }

  // Real BaseCamp 4.8.13 output with made-up content (tools/e2e/real.js): the preview tree and counts, every list's GPX,
  // the KML nesting, the report, and no smart list anywhere. real-run2 is also BaseCamp's own File > Backup.
  for (const sample of REAL_SAMPLES) {
    for (const intake of sample.intakes) {
      const how = intake === 'folder' ? 'a folder' : intake === 'backup' ? "BaseCamp's own .Backup file" : 'the version folder itself (4.8)';
      test(`${sample.name} (real BaseCamp 4.8.13 output) as ${how}`, { skip: REAL.includes(sample.name) ? false : 'not in BCR_E2E_ONLY' }, () => {
        check(sample.name, intake);
        const r = /** @type {any} */ (results.find((x) => x.scenario === sample.name && x.intake === intake));
        assert.equal(r.outcome, 'preview+zip');
        assert.ok(r.checked.rows >= 4 && r.checked.gpxFiles >= 3 && r.checked.items >= 28, JSON.stringify(r.checked));
      });
    }
  }

  test('a refused key never unlocks the download', { skip: NAMES.includes('minimal') ? false : 'not in BCR_E2E_ONLY' }, () => check('minimal (key refused)', 'backup'));

  test('self-check: the run fails when the build writes waypoints 2e-7° off', async () => {
    const { runE2E } = await import('../tools/e2e/run.js');
    const { readFile: read, writeFile: write } = await import('node:fs/promises');
    const sub = join(outDir, 'self-check');
    /**
     * Wraps the TEST build's GPX writer so every waypoint is written 2e-7° north of where it is. The wrapper sits
     * in front of the real module (export * plus one shadowing export), so it does not depend on how gpx.js formats
     * numbers inside.
     * @param {string} dist
     */
    const patchDist = async (dist) => {
      const dir = join(dist, 'js', 'export');
      const original = await read(join(dir, 'gpx.js'), 'utf8');
      assert.match(original, /export function\* gpxChunks\(/, 'gpx.js no longer exports gpxChunks: update this self-check');
      await write(join(dir, 'gpx-original.js'), original);
      await write(
        join(dir, 'gpx.js'),
        [
          "export * from './gpx-original.js';",
          "import { gpxChunks as realChunks } from './gpx-original.js';",
          'const shift = (item) => (item && item.kind === "waypoint" ? { ...item, lat: item.lat + 2e-7 } : item);',
          'export function* gpxChunks(items, options, tally) { yield* realChunks(Array.from(items, shift), options, tally); }',
          '',
        ].join('\n'),
      );
    };
    const run = await runE2E({ outDir: sub, scenarios: ['nested-tree'], intakes: ['backup'], bulk: false, refusedKeyRun: false, versionFolderScenarios: [], patchDist });
    const r = run.results[0];
    assert.equal(r.status, 'fail', 'a build with shifted positions must fail');
    assert.ok(r.problems.some((p) => /position/.test(p)), r.problems.join('\n'));
  });

  test('self-check: a planted inline script and console error are caught', async () => {
    const { runE2E } = await import('../tools/e2e/run.js');
    const { readFile: read, writeFile: write } = await import('node:fs/promises');
    /** The CSP must block an inline script (a violation), and a console.error must be seen. @param {string} dist */
    const patchDist = async (dist) => {
      const page = join(dist, 'app', 'index.html');
      const html = await read(page, 'utf8');
      assert.match(html, /<\/head>/);
      await write(page, html.replace('</head>', "<script>document.title = 'e2e-inline';</script></head>"));
      const main = join(dist, 'js', 'app', 'main.js');
      await write(main, `${await read(main, 'utf8')}\nconsole.error('e2e-planted');\n`);
    };
    const run = await runE2E({ outDir: join(outDir, 'self-check-csp'), scenarios: ['minimal'], intakes: ['backup'], bulk: false, refusedKeyRun: false, versionFolderScenarios: [], patchDist });
    const r = run.results[0];
    assert.equal(r.status, 'fail');
    assert.ok(r.csp.length >= 1, `no CSP violation recorded: ${JSON.stringify(r)}`);
    assert.ok(r.consoleErrors.some((e) => /e2e-planted/.test(e)), r.consoleErrors.join('\n'));
  });

  test('no run produced a console error, a CSP violation or a request to another origin', () => {
    if (setupError) throw setupError;
    const bad = results.filter((r) => r.consoleErrors.length + r.csp.length + r.foreign.length > 0);
    assert.deepEqual(bad.map((r) => `${r.scenario} (${r.intake}): ${[...r.consoleErrors, ...r.csp, ...r.foreign].join(' | ')}`), []);
  });
});
