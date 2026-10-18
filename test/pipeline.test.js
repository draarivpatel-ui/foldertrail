// Tests for src/app/pipeline.js: the worker protocol end to end in Node (parse → preview and dump; export → ZIP
// Blob and report), the export layout, errors, privacy of the dump, and an opt-in performance run.
//
// The ZIP is read back with a small test-only reader on node:zlib, independent of src/format/unzip.js.
// Export speed and memory, on a large synthetic library: test/perf.test.js (BCR_PERF=1 for the full size).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { Pipeline, buildPreview, exportLibrary, encodeChunks, planFiles, ERRORS } from '../src/app/pipeline.js';
import { readLibrary } from '../src/format/library.js';
import { buildScenario } from '../tools/fixtures/scenarios.js';

// ---------------------------------------------------------------------------------------------
// Helpers

/**
 * A WorkerSource (intake.js toWorkerSource shape) over in-memory files.
 * @param {Map<string, Uint8Array>} files  paths relative to Database/<version>
 */
function workerSource(files) {
  const ref = (/** @type {string} */ name, /** @type {Uint8Array} */ bytes) => ({
    name,
    path: name,
    size: bytes.length,
    lastModified: null,
    blob: new Blob([bytes]),
    index: null,
    entryName: null,
  });
  const get = (/** @type {string} */ name) => (files.has(name) ? ref(name, /** @type {Uint8Array} */ (files.get(name))) : null);
  return {
    kind: 'files',
    archive: null,
    allData: get('AllData.gdb'),
    folderData: get('FolderData.gfi'),
    trackSegments: [...files].filter(([p]) => p.startsWith('TrackSegments/')).map(([p, b]) => [p.slice(14), ref(p.slice(14), b)]),
    versionFolder: 'Database/4.8',
    version: '4.8',
  };
}

/**
 * Runs messages through a Pipeline and collects what it posts.
 * @param {Array<object>} messages
 * @param {object} [options]
 */
async function run(messages, options = {}) {
  /** @type {any[]} */
  const out = [];
  const pipeline = new Pipeline({ brand: 'Foldertrail', version: '0.1.0', now: () => Date.UTC(2026, 9, 6, 12), post: (m) => out.push(m), ...options });
  for (const m of messages) await pipeline.handle(m);
  return out;
}

/**
 * Reads a ZIP (no ZIP64) with node:zlib: entry name → bytes.
 * @param {Uint8Array} bytes
 * @returns {Map<string, Uint8Array>}
 */
function readZip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.ok(eocd >= 0, 'end of central directory');
  const count = v.getUint16(eocd + 10, true);
  let at = v.getUint32(eocd + 16, true);
  /** @type {Map<string, Uint8Array>} */
  const out = new Map();
  for (let k = 0; k < count; k++) {
    assert.equal(v.getUint32(at, true), 0x02014b50);
    const method = v.getUint16(at + 10, true);
    const size = v.getUint32(at + 20, true);
    const nameLength = v.getUint16(at + 28, true);
    const extra = v.getUint16(at + 30, true);
    const comment = v.getUint16(at + 32, true);
    const offset = v.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const start = offset + 30 + v.getUint16(offset + 26, true) + v.getUint16(offset + 28, true);
    const data = bytes.subarray(start, start + size);
    out.set(name, method === 8 ? new Uint8Array(inflateRawSync(data)) : data);
    at += 46 + nameLength + extra + comment;
  }
  return out;
}

/** @param {any} exported */
async function zipOf(exported) {
  return readZip(new Uint8Array(await exported.zip.arrayBuffer()));
}

const text = (/** @type {Uint8Array|undefined} */ b) => new TextDecoder().decode(b);

// ---------------------------------------------------------------------------------------------

test('parse: progress, then a preview with the tree and counts and a structure-only dump', async () => {
  const { built } = buildScenario('nested-tree');
  const out = await run([{ type: 'parse', id: 7, source: workerSource(built.files) }]);
  const progress = out.filter((m) => m.type === 'progress');
  assert.ok(progress.length > 0);
  assert.ok(progress.every((m) => m.id === 7 && ['reading', 'parsing', 'linking'].includes(m.phase) && m.done <= m.total));
  const parsed = out.find((m) => m.type === 'parsed');
  assert.equal(parsed.id, 7);
  const p = parsed.preview;
  assert.deepEqual(Object.keys(p).sort(), [
    'ambiguousCount', 'duplicates', 'fatal', 'meta', 'multiListItems', 'notConverted', 'problems', 'totals', 'tree', 'treeMissing', 'unlisted',
  ]);
  assert.deepEqual(p.meta, { source: 'BaseCamp library', version: '188', experimental: false, libraryVersion: '4.8' });
  assert.equal(p.treeMissing, false);
  assert.equal(p.fatal, null);
  assert.equal(p.tree[0].parentId, null);
  assert.equal(p.tree.filter((/** @type {any} */ n) => n.type === 'list').length, p.totals.lists);
  const sum = p.tree.reduce((/** @type {number} */ n, /** @type {any} */ e) => n + e.counts.waypoints + e.counts.tracks + e.counts.routes, 0);
  assert.ok(sum >= p.totals.waypoints + p.totals.tracks + p.totals.routes - (p.unlisted.waypoints + p.unlisted.tracks + p.unlisted.routes));
  assert.doesNotMatch(JSON.stringify(p), /"lat"|"lon"|"segments"/, 'the preview carries no geometry');
  assert.ok(p.problems.every((/** @type {any} */ x) => x.level === 'report'));
  assert.equal(typeof parsed.dump.text, 'string');
  assert.equal(typeof parsed.dump.json, 'string');
  assert.equal(JSON.parse(parsed.dump.json).format, 'bcr-structure-dump');
  // The message must survive structured cloning (postMessage).
  structuredClone(parsed);
});

test('the dump never carries a name, a coordinate, a time or a UUID (sentinels)', async () => {
  const { built, scenario } = buildScenario('privacy-sentinels');
  const sentinels = /** @type {any} */ (scenario).sentinels;
  const out = await run([{ type: 'parse', id: 1, source: workerSource(built.files) }, { type: 'export', id: 1, options: {} }]);
  const parsed = out.find((m) => m.type === 'parsed');
  const dump = parsed.dump.text + parsed.dump.json;
  for (const s of sentinels.strings) assert.ok(!dump.includes(s), `dump leaks ${s}`);
  for (const n of sentinels.numbers) assert.ok(!dump.includes(String(n)), `dump leaks ${n}`);
  // The user's own report does name their items (it is theirs, and local).
  const exported = out.find((m) => m.type === 'exported');
  const all = text((await zipOf(exported)).get('GPX/All items.gpx'));
  assert.ok(sentinels.strings.some((/** @type {string} */ s) => all.includes(s)));
});

test('export: GPX per list in the folder tree, All items, KML, report and read-me in one ZIP', async () => {
  const { built } = buildScenario('nested-tree');
  const out = await run([
    { type: 'parse', id: 'a', source: workerSource(built.files) },
    { type: 'export', id: 'a', options: { kml: true, perItem: false } },
  ]);
  const exported = out.find((m) => m.type === 'exported');
  assert.ok(exported, JSON.stringify(out.filter((m) => m.type === 'error')));
  assert.equal(exported.filename, 'Foldertrail export 2026-10-06.zip');
  assert.ok(exported.zip instanceof Blob);
  assert.equal(exported.zip.type, 'application/zip');
  assert.ok(out.filter((m) => m.type === 'progress' && m.phase === 'exporting').length > 0);
  const zip = await zipOf(exported);
  const names = [...zip.keys()];
  for (const want of ['GPX/', 'GPX/My Collection/', 'GPX/All items.gpx', 'KML/My Collection.kml', 'report.txt', 'report.html', 'READ-ME-FIRST.txt']) {
    assert.ok(names.includes(want), `${want} in ${names.join(', ')}`);
  }
  assert.ok(names.some((n) => /^GPX\/My Collection\/.+\/.+\.gpx$/.test(n)), 'nested list files');
  assert.ok(names.includes('GPX/My Collection/Region A/Empty folder/') || names.some((n) => n.endsWith('Empty folder/')), 'empty folders kept');
  for (const [name, bytes] of zip) {
    if (!name.endsWith('.gpx')) continue;
    const xml = text(bytes);
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<gpx version="1\.1" creator="Foldertrail"/);
    assert.match(xml, /<\/gpx>\n$/);
  }
  assert.match(text(zip.get('KML/My Collection.kml')), /<Folder>/);
  assert.equal(text(zip.get('report.txt')), exported.report.text);
  assert.equal(text(zip.get('report.html')), exported.report.html);
  assert.match(exported.report.text, /Download: \d+ files; one GPX file per list, plus one KML file/);
});

test('export: duplicates get their own folder, never a list; unlisted items get "Not in any list"', async () => {
  const dup = await run([{ type: 'parse', id: 1, source: workerSource(buildScenario('duplicate-names').built.files) }, { type: 'export', id: 1, options: { kml: true } }]);
  const zip = await zipOf(dup.find((m) => m.type === 'exported'));
  const names = [...zip.keys()];
  assert.deepEqual(names.filter((n) => n.startsWith('GPX/_Duplicate names/') && n.endsWith('.gpx')).sort(), [
    'GPX/_Duplicate names/Track - Loop (2).gpx',
    'GPX/_Duplicate names/Track - Loop.gpx',
    'GPX/_Duplicate names/Waypoint - Spring (2).gpx',
    'GPX/_Duplicate names/Waypoint - Spring.gpx',
  ]);
  assert.ok(!names.includes('GPX/Not in any list.gpx'), 'duplicates are not "not in any list"');
  assert.match(text(zip.get('KML/My Collection.kml')), /<name>_Duplicate names<\/name>/);
  for (const name of names.filter((n) => n.startsWith('GPX/My Collection/'))) assert.doesNotMatch(text(zip.get(name)), /<name>Loop<\/name>/);

  const orphans = await run([{ type: 'parse', id: 1, source: workerSource(buildScenario('orphans-and-classes').built.files) }, { type: 'export', id: 1, options: { kml: false } }]);
  const zip2 = await zipOf(orphans.find((m) => m.type === 'exported'));
  assert.ok(zip2.has('GPX/Not in any list.gpx'));
  assert.ok(![...zip2.keys()].some((n) => n.startsWith('KML/')), 'no KML when not asked for');
  const preview = orphans.find((m) => m.type === 'parsed').preview;
  assert.equal(preview.unlisted.waypoints + preview.unlisted.tracks + preview.unlisted.routes, 3);
});

test('export: without FolderData.gfi the items are grouped by type, never in an invented tree', async () => {
  const out = await run([{ type: 'parse', id: 1, source: workerSource(buildScenario('no-folder-data').built.files) }, { type: 'export', id: 1, options: { kml: true } }]);
  const parsed = out.find((m) => m.type === 'parsed');
  assert.equal(parsed.preview.treeMissing, true);
  assert.deepEqual(parsed.preview.tree, []);
  // The preview must match the download: grouped by type, so nothing is "not in any list" (no such file is written).
  assert.deepEqual(parsed.preview.unlisted, { waypoints: 0, tracks: 0, routes: 0 });
  const zip = await zipOf(out.find((m) => m.type === 'exported'));
  assert.deepEqual([...zip.keys()].filter((n) => n.startsWith('GPX/')).sort(), [
    'GPX/',
    'GPX/All items.gpx',
    'GPX/Routes.gpx',
    'GPX/Tracks.gpx',
    'GPX/Waypoints.gpx',
  ]);
  assert.match(text(zip.get('READ-ME-FIRST.txt')), /grouped by type/);
});

test('export: one file per item keeps the tree and makes each list a folder', async () => {
  const out = await run([{ type: 'parse', id: 1, source: workerSource(buildScenario('item-in-two-lists').built.files) }, { type: 'export', id: 1, options: { perItem: true, kml: false } }]);
  const exported = out.find((m) => m.type === 'exported');
  const zip = await zipOf(exported);
  const gpx = [...zip.keys()].filter((n) => n.endsWith('.gpx'));
  assert.ok(gpx.includes('GPX/All items.gpx'));
  const perList = gpx.filter((n) => n.startsWith('GPX/My Collection/'));
  assert.ok(perList.length >= 4);
  for (const name of perList) {
    assert.match(name, /^GPX\/My Collection\/(?:[^/]+\/)*[^/]+\/[^/]+\.gpx$/);
    assert.equal((text(zip.get(name)).match(/<(wpt|trk|rte)>|<wpt /g) ?? []).length, 1, `${name} holds one item`);
  }
  assert.match(exported.report.text, /one GPX file per item/);
});

test('errors: bad messages, export before parse, a source without a library, a fatal library', async () => {
  const out = await run([null, { type: 'nope', id: 3 }, { type: 'export', id: 4, options: {} }, { type: 'parse', id: 5, source: { kind: 'files' } }]);
  assert.deepEqual(out.map((m) => [m.type, m.id, m.code]), [
    ['error', undefined, 'bad_message'],
    ['error', 3, 'bad_message'],
    ['error', 4, 'not_parsed'],
    ['error', 5, 'no_library'],
  ]);
  for (const m of out) assert.ok(typeof m.message === 'string' && m.message.length > 10);
  assert.equal(out[0].message, ERRORS.bad_message);

  const fatal = await run([
    { type: 'parse', id: 6, source: workerSource(buildScenario('corrupt-bad-signature').built.files) },
    { type: 'export', id: 6, options: {} },
  ]);
  const parsed = fatal.find((m) => m.type === 'parsed');
  assert.equal(parsed.preview.fatal.code, 'not_a_library_file');
  assert.ok(parsed.dump.text.length > 0, 'the dump is still offered');
  assert.equal(fatal.at(-1).code, 'not_parsed', 'nothing to export');

  // An export for an older parse id is refused.
  const stale = await run([
    { type: 'parse', id: 1, source: workerSource(buildScenario('minimal').built.files) },
    { type: 'parse', id: 2, source: workerSource(buildScenario('minimal').built.files) },
    { type: 'export', id: 1, options: {} },
  ]);
  assert.equal(stale.at(-1).code, 'not_parsed');
});

test('a file that cannot be read becomes a plain-words result, never an exception', async () => {
  const source = workerSource(buildScenario('minimal').built.files);
  source.allData = { ...source.allData, blob: { size: 999, slice: () => ({ arrayBuffer: async () => { throw new Error('gone'); } }) } };
  const out = await run([{ type: 'parse', id: 1, source }]);
  const parsed = out.find((m) => m.type === 'parsed');
  assert.equal(parsed.preview.fatal.code, 'read_failed');
});

test('worker.js wires the pipeline to the worker global: messages in, postMessage out', async () => {
  /** @type {any[]} */
  const posted = [];
  /** @type {((event: {data: unknown}) => void)|null} */
  let listener = null;
  const fake = {
    postMessage: (/** @type {unknown} */ m) => posted.push(m),
    addEventListener: (/** @type {string} */ type, /** @type {any} */ fn) => {
      if (type === 'message') listener = fn;
    },
  };
  const before = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { value: fake, configurable: true, writable: true });
  try {
    await import('../src/app/worker.js');
    assert.equal(typeof listener, 'function');
    /** @type {any} */ (listener)({ data: { type: 'parse', id: 'w', source: workerSource(buildScenario('minimal').built.files) } });
    for (let i = 0; i < 300 && !posted.some((m) => m.type === 'parsed'); i++) await new Promise((r) => setTimeout(r, 10));
    const parsed = posted.find((m) => m.type === 'parsed');
    assert.equal(parsed?.id, 'w');
    assert.equal(parsed.preview.totals.waypoints, 1);
  } finally {
    if (before) Object.defineProperty(globalThis, 'self', before);
    else delete (/** @type {any} */ (globalThis)).self;
  }
});

test('encodeChunks writes UTF-8 without one giant string', () => {
  assert.deepEqual([...encodeChunks(['a', 'é', '山', '😀'])], [...new TextEncoder().encode('aé山😀')]);
  const big = encodeChunks(Array.from({ length: 3000 }, () => 'x'.repeat(100)));
  assert.equal(big.length, 300000);
});

test('exportLibrary and buildPreview work on a read result directly (no worker)', async () => {
  const { built } = buildScenario('routes');
  const files = workerSource(built.files);
  const { fromWorkerSource } = await import('../src/app/intake.js');
  const revived = await fromWorkerSource(files);
  const read = await readLibrary(revived.found);
  const preview = buildPreview(read);
  assert.equal(preview.notConverted.length, 3);
  const result = await exportLibrary(read, { kml: false, compression: 'store', now: () => Date.UTC(2026, 0, 2, 12) });
  assert.equal(result.filename, 'Foldertrail export 2026-01-02.zip');
  assert.match(result.report.text, /Route "Autorouted": it follows roads/);
  const zip = readZip(new Uint8Array(await result.zip.arrayBuffer()));
  assert.match(text(zip.get('GPX/All items.gpx')), /<rte>/);
});

/**
 * Entry names in central-directory order (the order in the archive).
 * @param {Uint8Array} bytes
 */
function zipNames(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  assert.equal(v.getUint32(eocd, true), 0x06054b50);
  let at = v.getUint32(eocd + 16, true);
  const names = [];
  for (let k = v.getUint16(eocd + 10, true); k > 0; k--) {
    const nameLength = v.getUint16(at + 28, true);
    names.push(new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength)));
    at += 46 + nameLength + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
  }
  return names;
}

/** @param {string} name */
async function readScenario(name) {
  const { fromWorkerSource } = await import('../src/app/intake.js');
  const revived = await fromWorkerSource(workerSource(buildScenario(name).built.files));
  return readLibrary(revived.found);
}

test('export: files are written two at a time, yet the archive keeps the planned order and progress counts every file', async () => {
  const read = await readScenario('nested-tree');
  const plan = planFiles(read.library, new Set(read.library.ambiguous ?? []), false);
  /** @type {number[]} */
  const done = [];
  const result = await exportLibrary(read, { kml: true, now: () => Date.UTC(2026, 9, 6, 12), onProgress: (p) => done.push(p.done) });
  const names = zipNames(new Uint8Array(await result.zip.arrayBuffer()));
  assert.deepEqual(names, [
    ...plan.directories,
    ...plan.files.map((f) => f.path),
    'KML/My Collection.kml',
    'READ-ME-FIRST.txt',
    'report.txt',
    'report.html',
  ]);
  const total = plan.files.length + 2;
  assert.deepEqual(done, Array.from({ length: total }, (_, i) => i + 1));
});

test('export: a file that fails while being written becomes export_failed, and nothing is left unhandled', async () => {
  /** @type {unknown[]} */
  const unhandled = [];
  const onUnhandled = (/** @type {unknown} */ reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const read = await readScenario('nested-tree');
    const track = read.library.items.find((i) => i.kind === 'track');
    assert.ok(track);
    Object.defineProperty(track, 'segments', {
      get() {
        throw new Error('synthetic failure while reading points');
      },
    });
    await assert.rejects(exportLibrary(read, { kml: true }), /synthetic failure/);

    const { built } = buildScenario('nested-tree');
    /** @type {any[]} */
    const out = [];
    const pipeline = new Pipeline({ brand: 'Foldertrail', version: '0.1.0', post: (m) => out.push(m) });
    await pipeline.handle({ type: 'parse', id: 1, source: workerSource(built.files) });
    const current = /** @type {any} */ (pipeline).current;
    for (const item of current.read.library.items) {
      if (item.kind === 'track') Object.defineProperty(item, 'segments', { get: () => { throw new Error('synthetic'); } });
    }
    await pipeline.handle({ type: 'export', id: 1, options: { kml: true } });
    assert.deepEqual(out.filter((m) => m.type === 'error').map((m) => m.code), ['export_failed']);
    assert.ok(!out.some((m) => m.type === 'exported'));
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});
