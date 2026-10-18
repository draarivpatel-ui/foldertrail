// The app page's logic (src/app/ui.js) and its views (view-dom.js, view-preview.js), without a browser.
// The controller is driven through the worker protocol with a fake worker and a fake intake; the views run on a
// small fake DOM that throws if anything ever uses innerHTML or a style attribute. All data is made up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildTree,
  countsPhrase,
  createController,
  detectSupport,
  formatBytes,
  formatNumber,
  groupNotConverted,
  joinWords,
  metaLine,
  normalisePreview,
  normaliseProblems,
  plural,
  reasonText,
  safeZipName,
  summarySentence,
  supportMessages,
  walkTree,
  LIMITS,
  PHASE_TEXT,
  TEXT,
} from '../src/app/ui.js';
// Newer exports are read through the namespace, so a missing one fails its own test, not the whole file.
import * as UI from '../src/app/ui.js';
import { SCENARIOS, buildScenario } from '../tools/fixtures/scenarios.js';
import { readLibrary } from '../src/format/library.js';
import { REASONS as REPORT_REASONS } from '../src/export/report.js';

// ---------------------------------------------------------------------------------------------
// Synthetic data

const ROWS = [
  { id: 'root', name: 'My Collection', type: 'folder', parentId: null, counts: { waypoints: 0, tracks: 0, routes: 0 } },
  { id: 'f1', name: 'Hiking', type: 'folder', parentId: 'root', counts: { waypoints: 0, tracks: 0, routes: 0 } },
  { id: 'l1', name: 'Made-up loop', type: 'list', parentId: 'f1', counts: { waypoints: 3, tracks: 1, routes: 0 } },
  { id: 'l2', name: '<img src=x onerror=alert(1)>', type: 'list', parentId: 'f1', counts: { waypoints: 1, tracks: 0, routes: 0 } },
  { id: 'f2', name: 'Empty folder', type: 'folder', parentId: 'root', counts: { waypoints: 0, tracks: 0, routes: 0 } },
  { id: 'l3', name: 'Inbox', type: 'list', parentId: 'root', counts: { waypoints: 2, tracks: 0, routes: 1 } },
];

function samplePreview(extra = {}) {
  return {
    meta: { source: 'synthetic', version: '188', experimental: false, libraryVersion: '4.8' },
    totals: { folders: 2, lists: 3, waypoints: 6, tracks: 1, routes: 1 },
    tree: ROWS,
    unlisted: { waypoints: 1, tracks: 0, routes: 0 },
    ambiguousCount: 0,
    treeMissing: false,
    notConverted: [],
    problems: [{ code: 'x', message: 'A made-up note.', count: 2, level: 'report' }],
    fatal: null,
    duplicates: [],
    ...extra,
  };
}

// ---------------------------------------------------------------------------------------------
// Words

test('plural, numbers and lists of words read naturally', () => {
  assert.equal(plural(0, 'track'), 'no tracks');
  assert.equal(plural(1, 'track'), '1 track');
  assert.equal(plural(1234, 'waypoint'), '1,234 waypoints');
  assert.equal(formatNumber(1234567), '1,234,567');
  assert.equal(formatNumber(Number.NaN), '0');
  assert.equal(joinWords([]), '');
  assert.equal(joinWords(['a']), 'a');
  assert.equal(joinWords(['a', 'b']), 'a and b');
  assert.equal(joinWords(['a', 'b', 'c']), 'a, b and c');
  assert.equal(countsPhrase({ waypoints: 12, tracks: 0, routes: 1 }), '12 waypoints and 1 route');
  assert.equal(countsPhrase({ waypoints: 0, tracks: 0, routes: 0 }), '');
});

test('the summary sentence and the meta line say what was found, and nothing that was not', () => {
  const preview = /** @type {any} */ (normalisePreview(samplePreview()));
  assert.equal(summarySentence(preview), 'Your library holds 6 waypoints, 1 track and 1 route, in 3 lists and 2 folders.');
  assert.equal(metaLine(preview, null), 'From the 4.8 folder · library format 188');
  assert.equal(metaLine(preview, '4.7'), 'From the 4.7 folder · library format 188');
  const flat = /** @type {any} */ (normalisePreview(samplePreview({ treeMissing: true, tree: [] })));
  assert.equal(summarySentence(flat), 'Your library holds 6 waypoints, 1 track and 1 route.');
  const empty = /** @type {any} */ (normalisePreview(samplePreview({ totals: { folders: 0, lists: 0, waypoints: 0, tracks: 0, routes: 0 } })));
  assert.equal(summarySentence(empty), 'No waypoints, tracks or routes were found in this library.');
});

test('formatBytes and safeZipName', () => {
  assert.equal(formatBytes(512), '512 bytes');
  assert.equal(formatBytes(2_400_000), '2.4 MB');
  assert.equal(formatBytes(-1), '');
  const day = new Date(2026, 9, 6);
  assert.equal(safeZipName('foldertrail-export-2026-10-06.zip', day), 'foldertrail-export-2026-10-06.zip');
  for (const bad of ['../evil.zip', 'a/b.zip', 'x.exe', '', null, '.hidden.zip', `${'a'.repeat(200)}.zip`]) {
    assert.equal(safeZipName(bad, day), 'foldertrail-export-2026-10-06.zip', String(bad));
  }
});

/**
 * A SourceFile (intake.js) over bytes in memory, as test/reader-vs-fixtures.test.js makes it.
 * @param {string} name
 * @param {Uint8Array} bytes
 */
function memoryFile(name, bytes) {
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

/** Every NotConverted (kind, reason) the real reader emits over the synthetic scenarios. */
async function emittedReasons() {
  /** @type {Map<string, {kind: string, reason: string}>} */
  const found = new Map();
  for (const scenario of SCENARIOS) {
    const { built } = buildScenario(scenario.name);
    const trackSegments = new Map();
    for (const [path, bytes] of built.files) {
      if (path.startsWith('TrackSegments/')) trackSegments.set(path.slice('TrackSegments/'.length), memoryFile(path, bytes));
    }
    const file = (/** @type {string} */ n) => (built.files.has(n) ? memoryFile(n, /** @type {Uint8Array} */ (built.files.get(n))) : null);
    const read = await readLibrary(/** @type {any} */ ({ allData: file('AllData.gdb'), folderData: file('FolderData.gfi'), trackSegments }));
    for (const n of read.library.notConverted ?? []) found.set(`${n.kind}:${n.reason}`, { kind: n.kind, reason: n.reason });
  }
  return [...found.values()];
}

test('every not-converted reason the reader emits (and the report names) gets its own sentence, never the fallback', async () => {
  const emitted = await emittedReasons();
  assert.ok(emitted.length >= 4, `the scenarios exercise the reasons (found ${emitted.map((e) => e.reason).join(', ')})`);
  /** @type {Map<string, string>} reason -> kind, from the reader's own output and from the report's table */
  const codes = new Map(emitted.map((e) => [e.reason, e.kind]));
  for (const reason of Object.keys(REPORT_REASONS)) codes.set(reason, reason.split('_')[0]);
  assert.deepEqual([...codes.keys()].sort(), ['route_autoroute', 'route_not_decoded', 'route_via_unresolved', 'track_not_decoded', 'waypoint_not_decoded']);
  const seen = new Set();
  for (const [reason, kind] of codes) {
    for (const n of [1, 3]) {
      const words = reasonText(kind, reason, n);
      assert.notEqual(words, reasonText(kind, 'no_such_reason', n), `${reason} (${n}) has its own words`);
      assert.match(words, /^[A-Z].*\.$/, `${reason}: a plain sentence`);
      assert.match(words, n === 1 ? /\b(it|its)\b/i : /\b(they|their|each)\b/i, `${reason}: singular or plural to match ${n}`);
      seen.add(words);
    }
  }
  assert.match(reasonText('route', 'route_autoroute'), /follows roads/);
  assert.match(reasonText('route', 'route_via_unresolved'), /via points/);
  assert.match(reasonText('track', 'track_not_decoded'), /track layout/);
  assert.match(reasonText('track', 'track_not_decoded'), /not in the download/);
  // Unknown codes, inherited property names and a reason that belongs to another kind get the honest fallback.
  assert.match(reasonText('track', 'something_new'), /could not be converted/);
  assert.match(reasonText('alien', 'x'), /could not be converted/);
  assert.equal(reasonText('route', 'toString'), reasonText('route', 'no_such_reason'), 'inherited names are not reasons');
  assert.equal(reasonText('track', 'route_autoroute'), reasonText('track', 'no_such_reason'), 'a route reason never describes a track');
  // The guesses the page used to carry (before the reader existed) are not reasons any more.
  for (const old of ['autoroute', 'via_unresolved', 'route_autoroute_only']) {
    assert.equal(reasonText('route', old), reasonText('route', 'no_such_reason'), old);
  }

  const groups = groupNotConverted([
    { kind: 'route', name: 'R1', reason: 'route_autoroute', listIds: [] },
    { kind: 'track', name: 'T1', reason: 'x', listIds: [] },
    { kind: 'route', name: 'R2', reason: 'route_autoroute', listIds: [] },
    { kind: 'route', name: 'R3', reason: 'route_via_unresolved', listIds: [] },
  ]);
  assert.deepEqual(groups.map((g) => [g.kind, g.names]), [['track', ['T1']], ['route', ['R1', 'R2']], ['route', ['R3']]]);
  assert.equal(groups[1].text, reasonText('route', 'route_autoroute', 2), 'the sentence matches the number of items');
  assert.equal(groups[2].text, reasonText('route', 'route_via_unresolved', 1));
});

test('the preview says plainly that road-following routes are not converted (the reader leaves them out)', async () => {
  const dom = withDom();
  try {
    const { createPreview } = await import('../src/app/view-preview.js');
    const els = /** @type {any} */ (previewEls(dom.doc));
    createPreview(els).update(/** @type {any} */ ({ preview: normalisePreview(samplePreview()), previewId: 1, versionFolder: null, intakeProblems: [], intakeNotes: [] }));
    const facts = els.ncFacts.textContent;
    assert.match(facts, /straight lines between their via points/);
    assert.match(facts, /follow roads[^.]*not converted/i);
    assert.doesNotMatch(facts, /road-following detail isn’t kept/, 'not "converted without the road detail": they are left out');
  } finally {
    dom.restore();
  }
});

// ---------------------------------------------------------------------------------------------
// US English in everything the page says

/** British spellings that must not reach the page (US English everywhere visible). */
const BRITISH = /\b(?:licences?|cancell(?:ed|ing)|colours?|metres?|organis\w*|normalis\w*|recognis\w*|favourit\w*|behaviour\w*|centres?|catalogues?|analys(?:e|ed|ing)|whilst|amongst|grey)\b/i;

test('everything the app page says is in US English', () => {
  assert.doesNotMatch('license, canceled, color, meters', BRITISH, 'the check itself lets US spellings through');
  for (const sample of ['licence', 'Download cancelled.', 'colour', 'normalised', 'organisation']) assert.match(sample, BRITISH, sample);
  /** @type {string[]} */
  const strings = [...Object.values(TEXT), ...Object.values(PHASE_TEXT)];
  const support = supportMessages({ moduleWorker: false, inflateRaw: false, deflateRaw: false, folderDrop: false, folderPicker: true, clipboard: false });
  strings.push(String(support.blocking));
  strings.push(...supportMessages({ moduleWorker: true, inflateRaw: false, deflateRaw: false, folderDrop: false, folderPicker: true, clipboard: false }).notes);
  for (const reason of ['waypoint_not_decoded', 'track_not_decoded', 'route_autoroute', 'route_not_decoded', 'route_via_unresolved', 'x']) {
    const kind = reason.split('_')[0];
    strings.push(reasonText(kind, reason, 1), reasonText(kind, reason, 2));
  }
  if (typeof UI.unlockPrivacyNote === 'function') strings.push(UI.unlockPrivacyNote('Polar'));
  if (typeof UI.supportContact === 'function') strings.push(UI.supportContact('', false).text, UI.supportContact('', true).text);
  for (const s of strings) assert.doesNotMatch(s, BRITISH, s);
});

// ---------------------------------------------------------------------------------------------
// What the page says about the licence check and about getting help

test('the unlock note says what is sent: the license key and a product ID, to the provider', async () => {
  const dom = withDom();
  try {
    const { createUnlock } = await import('../src/app/view-unlock.js');
    const names = ['presale', 'steps', 'price', 'buyLink', 'buyNote', 'privacy', 'keyForm', 'keyInput', 'unlockBtn', 'message', 'saved', 'forget',
      'options', 'optKml', 'optPerItem', 'downloadBtn', 'exportProgress', 'exportPhase', 'exportBar', 'cancelExport', 'exportError', 'exportErrorText'];
    const els = /** @type {any} */ (Object.fromEntries(names.map((n) => [n, dom.doc.createElement(n === 'buyLink' ? 'a' : 'div')])));
    els.exportBar.appendChild(Object.assign(dom.doc.createElement('span'), { className: 'progress-fill' }));
    const noop = () => {};
    createUnlock(els, { onSale: true, price: '$19', checkoutUrl: 'https://checkout.example.invalid/x', provider: 'Polar' },
      { verify: noop, forget: noop, setOptions: noop, download: noop, cancel: noop });
    const note = els.privacy.textContent;
    assert.match(note, /your license key and a product ID/);
    assert.match(note, /Polar/);
    assert.doesNotMatch(note, /only your license key/, 'a product ID goes too, so "only the key" is not true');
    assert.match(note, /once per browser session/, 'a saved key is checked again when the page opens');
    assert.match(note, /library is never sent/);
  } finally {
    dom.restore();
  }
});

test('without a real support address the page says one will be listed, and never shows a placeholder address', () => {
  assert.equal(typeof UI.supportContact, 'function', 'ui.js exports supportContact');
  const notYet = UI.supportContact('', false);
  assert.equal(notYet.email, '');
  assert.match(notYet.text, /^Copy it and keep it; a support address will be listed here when Foldertrail goes on sale\.$/);
  const onSale = UI.supportContact('', true);
  assert.equal(onSale.email, '');
  assert.doesNotMatch(onSale.text, /goes on sale/, 'once on sale, "when it goes on sale" would be false');
  assert.match(onSale.text, /Copy it and keep it/);
  for (const placeholder of ['help@example.invalid', 'help@example.com', 'a@example.org', 'x@shop.example', 'x@foldertrail.test',
    'x@localhost.localhost', 'help@EXAMPLE.INVALID', 'not an address', '<b>@x.com', 'a@b', 42, null]) {
    const result = UI.supportContact(/** @type {any} */ (placeholder), true);
    assert.equal(result.email, '', String(placeholder));
    assert.ok(!result.text.includes('example'), String(placeholder));
  }
  assert.deepEqual(UI.supportContact('help@foldertrail.app', false), { email: 'help@foldertrail.app', text: '' });
});

// ---------------------------------------------------------------------------------------------
// Re-checking a saved licence when the page opens (src/app/license.js restoreLicense)

/** @param {any} [extra] */
function savedKeyLicense(extra = {}) {
  const calls = { restore: 0, verify: /** @type {string[]} */ ([]) };
  const license = {
    verifyLicense: async (/** @type {string} */ key) => (calls.verify.push(key), { ok: true, code: 'valid', message: 'Thank you.', stored: true }),
    getStoredLicense: () => 'SAVED-KEY-0000-0000',
    storeLicense: () => {},
    clearLicense: () => {},
    restoreLicense: async () => (calls.restore++, { ok: true, code: 'valid', message: 'Thank you.', stored: true, rechecked: true }),
    ...extra,
  };
  return { license, calls };
}

test('when the page opens, a saved key is re-checked through restoreLicense, and the download needs no second check', async () => {
  const { license, calls } = savedKeyLicense();
  const { controller, workers } = makeController({ license, onSale: true });
  assert.equal(typeof controller.restoreLicence, 'function', 'the controller can restore a saved licence');
  assert.equal(controller.state.licence.status, 'stored');
  const pending = controller.restoreLicence();
  assert.equal(controller.state.licence.message, TEXT.licenceRestoring, 'the page says it is checking');
  await pending;
  assert.equal(calls.restore, 1);
  assert.equal(controller.state.licence.status, 'valid');
  assert.equal(controller.state.licence.hasStored, true);
  assert.equal(controller.state.licence.message, TEXT.licenceRestored);
  await controller.restoreLicence();
  assert.equal(calls.restore, 1, 'once per page: a valid key is not checked again');

  await controller.open([]);
  const worker = workers.made[0];
  worker.reply({ type: 'parsed', id: worker.posted[0].id, preview: samplePreview(), dump: null });
  await controller.download();
  assert.deepEqual(calls.verify, [], 'restoreLicense already checked it');
  assert.equal(worker.posted[1].type, 'export');
});

test('a saved key the provider now refuses is dropped with a plain message, and nothing unlocks', async () => {
  for (const code of ['invalid', 'refunded']) {
    const { license, calls } = savedKeyLicense({
      restoreLicense: async () => ({ ok: false, code, message: 'That key isn’t valid.', retry: false }),
    });
    const { controller, workers } = makeController({ license, onSale: true });
    await controller.restoreLicence();
    assert.equal(controller.state.licence.status, 'invalid', code);
    assert.equal(controller.state.licence.hasStored, false);
    assert.equal(controller.state.licence.message, TEXT.licenceSavedRejected);
    await controller.open([]);
    const worker = workers.made[0];
    worker.reply({ type: 'parsed', id: worker.posted[0].id, preview: samplePreview(), dump: null });
    await controller.download();
    assert.equal(worker.posted.length, 1, `${code}: no export`);
    assert.deepEqual(calls.verify, [], 'the dropped key is not tried again');
    assert.equal(controller.state.licence.message, TEXT.licenceEmpty);
  }
});

test('restoring a saved key: no module function, not on sale, a hang, or the user acting first all leave the page sane', async () => {
  // A licence module without restoreLicense: the old path (checked at download) stays.
  const plain = savedKeyLicense({ restoreLicense: undefined });
  const a = makeController({ license: plain.license, onSale: true });
  await a.controller.restoreLicence();
  assert.equal(a.controller.state.licence.status, 'stored');
  assert.equal(a.controller.state.licence.message, '');

  // Not on sale: nothing is asked.
  const off = savedKeyLicense();
  const b = makeController({ license: off.license, onSale: false });
  await b.controller.restoreLicence();
  assert.equal(off.calls.restore, 0);
  assert.equal(b.controller.state.licence.status, 'off');

  // The provider hangs: the page stops waiting and checks the key at download instead.
  const hanging = savedKeyLicense({ restoreLicense: () => new Promise(() => {}) });
  const c = makeController({ license: hanging.license, onSale: true, sleep: async () => {} });
  await c.controller.restoreLicence();
  assert.equal(c.controller.state.licence.status, 'stored');
  assert.equal(c.controller.state.licence.message, '');

  // The user checks another key while the saved one is being re-checked: the late answer changes nothing.
  /** @type {(v: any) => void} */
  let answer = () => {};
  const racing = savedKeyLicense({ restoreLicense: () => new Promise((resolve) => (answer = resolve)) });
  const d = makeController({ license: racing.license, onSale: true });
  const restoring = d.controller.restoreLicence();
  assert.equal(await d.controller.verify('OTHER-KEY-0000-0000'), true);
  answer({ ok: false, code: 'invalid', message: 'x', retry: false });
  await restoring;
  assert.equal(d.controller.state.licence.status, 'valid', 'the key the user just checked wins');

  // A restore that throws is treated as "not checked yet".
  const throwing = savedKeyLicense({ restoreLicense: () => { throw new Error('boom with a secret'); } });
  const e = makeController({ license: throwing.license, onSale: true });
  await e.controller.restoreLicence();
  assert.equal(e.controller.state.licence.status, 'stored');
});

// ---------------------------------------------------------------------------------------------
// Feature detection

test('detectSupport finds module workers by trying them, never by reading the user agent', () => {
  class ModuleWorker {
    /** @param {string} url @param {any} options */
    constructor(url, options) {
      void options.type; // a browser with module workers reads the option before it parses the URL
      throw new SyntaxError(`bad url ${url}`);
    }
  }
  class ClassicWorker {
    /** @param {string} url */
    constructor(url) {
      throw new SyntaxError(`bad url ${url}`);
    }
  }
  class Streams {
    /** @param {string} format */
    constructor(format) {
      if (format !== 'deflate-raw') throw new TypeError('unsupported');
    }
  }
  class OldStreams {
    /** @param {string} format */
    constructor(format) {
      if (format === 'deflate-raw') throw new TypeError('unsupported');
    }
  }
  const navigator = new Proxy(
    { clipboard: { writeText: async () => {} } },
    {
      get(target, key) {
        if (key === 'userAgent' || key === 'vendor' || key === 'appVersion' || key === 'platform') {
          throw new Error(`version sniffing: ${String(key)}`);
        }
        return /** @type {any} */ (target)[key];
      },
    },
  );
  function DataTransferItem() {}
  DataTransferItem.prototype.webkitGetAsEntry = () => null;
  const document = { createElement: () => ({ webkitdirectory: false }) };

  const modern = detectSupport({ Worker: ModuleWorker, DecompressionStream: Streams, CompressionStream: Streams, DataTransferItem, document, navigator });
  assert.deepEqual(modern, { moduleWorker: true, inflateRaw: true, deflateRaw: true, folderDrop: true, folderPicker: true, clipboard: true });
  assert.equal(supportMessages(modern).blocking, null);
  assert.deepEqual(supportMessages(modern).notes, []);

  const old = detectSupport({ Worker: ClassicWorker, DecompressionStream: OldStreams, navigator });
  assert.equal(old.moduleWorker, false);
  assert.equal(old.inflateRaw, false);
  assert.equal(old.folderDrop, false);
  const words = supportMessages(old);
  assert.match(/** @type {string} */ (words.blocking), /Chrome or Firefox/);
  assert.match(/** @type {string} */ (words.blocking), /10\.13 or 10\.14/);

  const noBackups = supportMessages({ ...modern, inflateRaw: false });
  assert.match(noBackups.notes[0], /Double-click the backup in Finder/);
  assert.equal(detectSupport({}).moduleWorker, false);
});

// ---------------------------------------------------------------------------------------------
// The tree

test('buildTree nests rows, totals lists and folders below each node, and keeps worker order', () => {
  const { roots, shown, dropped } = buildTree(ROWS);
  assert.equal(shown, 6);
  assert.equal(dropped, 0);
  assert.equal(roots.length, 1);
  const root = roots[0];
  assert.deepEqual(root.children.map((c) => c.id), ['f1', 'f2', 'l3']);
  assert.equal(root.lists, 3);
  assert.equal(root.folders, 2);
  assert.equal(root.children[0].lists, 2);
  assert.equal(root.children[0].children[1].depth, 2);
  const order = [];
  walkTree(roots, (node) => order.push(node.id));
  assert.deepEqual(order, ['root', 'f1', 'l1', 'l2', 'f2', 'l3']);
});

test('buildTree survives hostile rows: missing parents, cycles, self-parents, duplicates, junk', () => {
  const rows = [
    { id: 'a', name: 'A', type: 'folder', parentId: 'b' },
    { id: 'b', name: 'B', type: 'folder', parentId: 'a' },
    { id: 'c', name: 'C', type: 'folder', parentId: 'c' },
    { id: 'd', name: 'D', type: 'list', parentId: 'nowhere', counts: { waypoints: -4, tracks: 'x', routes: 1e300 } },
    { id: 'd', name: 'duplicate id', type: 'list', parentId: null },
    null,
    42,
    { name: 'no id' },
    { id: 7, name: 12345, type: 'weird', parentId: 'a' },
  ];
  const { roots, dropped } = buildTree(/** @type {any} */ (rows));
  const ids = [];
  walkTree(roots, (node) => ids.push(node.id));
  assert.deepEqual(ids.sort(), ['7', 'a', 'b', 'c', 'd']);
  assert.equal(dropped, 4);
  const d = roots.find((n) => n.id === 'd');
  assert.deepEqual(d?.counts, { waypoints: 0, tracks: 0, routes: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(roots.map((n) => n.id).sort(), ['a', 'b', 'c', 'd'], 'the rows of each cycle go to the top level');
  const a = roots.find((n) => n.id === 'a');
  assert.deepEqual(a?.children.map((n) => n.id), ['7'], 'a row that only hangs below a cycle keeps its parent');
  assert.equal(a?.children[0].name, '', 'a name that is not text is dropped (drawn as "Untitled")');
  assert.equal(a?.children[0].type, 'list');
});

test('buildTree is linear: a 100,000-row hostile tree (one long chain plus a ring) is quick', () => {
  const rows = [];
  for (let i = 0; i < 100_000; i++) rows.push({ id: `n${i}`, name: 'x', type: 'folder', parentId: i === 0 ? 'n99999' : `n${i - 1}` });
  const started = performance.now();
  const { roots } = buildTree(rows, { maxRows: 200_000 });
  const ms = performance.now() - started;
  assert.equal(roots.length, 100_000, 'one big ring: every row is on it');
  assert.ok(ms < 1500, `took ${Math.round(ms)} ms`);
});

test('buildTree caps depth and rows without recursion (a 20,000-deep chain does not overflow the stack)', () => {
  const chain = [];
  for (let i = 0; i < 20_000; i++) chain.push({ id: `n${i}`, name: `N${i}`, type: 'folder', parentId: i === 0 ? null : `n${i - 1}` });
  const deep = buildTree(chain, { maxDepth: 64, maxRows: 50_000 });
  let deepest = 0;
  walkTree(deep.roots, (node) => (deepest = Math.max(deepest, node.depth)));
  assert.equal(deepest, 63);
  assert.equal(deep.shown, 64);
  assert.equal(deep.dropped, 20_000 - 64);
  const capped = buildTree(chain, { maxRows: 100 });
  assert.equal(capped.dropped, 20_000 - 64);
});

// ---------------------------------------------------------------------------------------------
// Worker messages are hostile input

test('normalisePreview turns anything into a safe preview; dump-level problems never reach the page', () => {
  assert.equal(normalisePreview(null), null);
  assert.equal(normalisePreview('preview'), null);
  const p = /** @type {any} */ (
    normalisePreview({
      meta: { version: '<b>188</b>', libraryVersion: '../4.8', experimental: 'yes' },
      totals: { waypoints: '12', tracks: -3, routes: 2.7 },
      tree: 'not an array',
      unlisted: null,
      ambiguousCount: Infinity,
      treeMissing: 1,
      notConverted: [{ kind: 'spaceship', name: 'x'.repeat(5000), reason: 7 }, null, 'junk'],
      problems: [
        { code: 'a', message: 'Shown.', count: 0 },
        { code: 'b', message: 'Only for the dump.', count: 3, level: 'dump' },
        { code: 'c', message: '' },
        'junk',
      ],
      fatal: { message: 42 },
      duplicates: [{ kind: 'waypoint', name: 'Dup', copies: '2' }],
    })
  );
  assert.equal(p.meta.version, null);
  assert.equal(p.libraryVersion, null);
  assert.equal(p.experimental, false);
  assert.deepEqual(p.totals, { folders: 0, lists: 0, waypoints: 0, tracks: 0, routes: 2 });
  assert.deepEqual(p.tree, []);
  assert.deepEqual(p.unlisted, { waypoints: 0, tracks: 0, routes: 0 });
  assert.equal(p.ambiguousCount, 0);
  assert.equal(p.treeMissing, false);
  assert.equal(p.notConverted.length, 1);
  assert.equal(p.notConverted[0].kind, 'track');
  assert.equal(p.notConverted[0].name.length, LIMITS.nameLength + 1);
  assert.equal(p.notConverted[0].reason, '');
  assert.deepEqual(p.problems.map((x) => x.message), ['Shown.']);
  assert.equal(p.problems[0].count, 1);
  assert.equal(p.fatal.message, TEXT.nothingConverted);
  // listIds (the lists that name a duplicated item) are kept, as strings only, so the tree can flag those lists.
  assert.deepEqual(p.duplicates, [{ kind: 'waypoint', name: 'Dup', copies: 0, listIds: [] }]);
  assert.deepEqual(normalisePreview({ duplicates: [{ kind: 'track', name: 'D', copies: 2, listIds: ['l1', 7, null, 'l2'] }] })?.duplicates[0].listIds, ['l1', 'l2']);
  assert.deepEqual(normaliseProblems('nope'), []);
});

// ---------------------------------------------------------------------------------------------
// The controller, through the worker protocol

/** A fake worker link: records what the page posts and lets the test answer. */
function fakeWorkerFactory() {
  const made = [];
  /** @type {any} */
  const factory = (onMessage, onFailure) => {
    const link = {
      posted: /** @type {any[]} */ ([]),
      terminated: false,
      post(/** @type {any} */ message) {
        if (link.terminated) throw new Error('posted to a terminated worker');
        link.posted.push(message);
      },
      terminate() {
        link.terminated = true;
      },
      reply: (/** @type {any} */ data) => onMessage(data),
      fail: (/** @type {"error"|"messageerror"} */ kind) => onFailure(kind),
    };
    made.push(link);
    return link;
  };
  factory.made = made;
  return factory;
}

const FOUND = { allData: { name: 'AllData.gdb' }, folderData: { name: 'FolderData.gfi' }, version: '4.8' };
const okIntake = async () => ({ ok: true, found: FOUND, problems: [], notes: [{ code: 'n', message: 'A made-up note.', count: 1 }] });
const never = () => new Promise(() => {});

/** @param {Partial<import('../src/app/ui.js').ControllerDeps>} [overrides] */
function makeController(overrides = {}) {
  const states = [];
  const workers = fakeWorkerFactory();
  const controller = createController({
    intake: okIntake,
    toWorkerSource: (found) => ({ kind: 'files', marker: found.version }),
    createWorker: workers,
    license: null,
    onSale: false,
    onChange: (s) => states.push(s),
    sleep: never,
    ...overrides,
  });
  return { controller, states, workers };
}

test('open -> parse -> progress -> preview, with the worker source and a fresh id', async () => {
  const { controller, workers } = makeController();
  assert.equal(controller.state.view, 'open');
  await controller.open(['a file']);
  assert.equal(controller.state.view, 'read');
  assert.equal(controller.state.busy, 'parse');
  const worker = workers.made[0];
  assert.equal(worker.posted.length, 1);
  const parse = worker.posted[0];
  assert.equal(parse.type, 'parse');
  assert.deepEqual(parse.source, { kind: 'files', marker: '4.8' });
  assert.equal(controller.state.versionFolder, '4.8');
  assert.deepEqual(controller.state.intakeNotes.map((n) => n.message), ['A made-up note.']);

  worker.reply({ type: 'progress', id: parse.id, phase: 'parsing', done: 5, total: 10 });
  assert.equal(controller.state.phase, 'parsing');
  assert.equal(controller.state.done, 5);
  assert.equal(controller.state.total, 10);
  worker.reply({ type: 'progress', id: parse.id, phase: 'evil<script>', done: 99, total: 10 });
  assert.equal(controller.state.phase, 'parsing', 'unknown phases keep the last known one');
  assert.equal(controller.state.done, 10, 'done never exceeds total');
  worker.reply({ type: 'progress', id: parse.id, phase: 'linking', done: 3, total: 0 });
  assert.equal(controller.state.total, null);

  worker.reply({ type: 'parsed', id: parse.id + 1, preview: samplePreview(), dump: { text: 't', json: 'j' } });
  assert.equal(controller.state.view, 'read', 'a reply for another id is ignored');
  worker.reply({ type: 'parsed', id: parse.id, preview: samplePreview(), dump: { text: 'structure', json: '{}' } });
  assert.equal(controller.state.view, 'preview');
  assert.equal(controller.state.busy, null);
  assert.equal(controller.state.preview?.totals.waypoints, 6);
  assert.deepEqual(controller.state.dump, { text: 'structure', json: '{}' });
});

test('not on sale: download never reaches the worker', async () => {
  const { controller, workers } = makeController();
  await controller.open([]);
  const worker = workers.made[0];
  worker.reply({ type: 'parsed', id: worker.posted[0].id, preview: samplePreview(), dump: null });
  assert.equal(controller.state.licence.status, 'off');
  assert.equal(controller.state.onSale, false);
  await controller.download();
  assert.equal(worker.posted.length, 1);
  assert.equal(await controller.verify('ANYTHING-AT-ALL-123'), false);
});

test('on sale: the export is only asked for after the licence check passes, with the chosen options', async () => {
  const checked = [];
  const stored = [];
  const license = {
    verifyLicense: async (/** @type {string} */ key) => {
      checked.push(key);
      return key === 'GOOD-KEY-0000-0000'
        ? { ok: true, code: 'valid', message: 'Thank you. Foldertrail is unlocked in this browser.', stored: true }
        : { ok: false, code: 'invalid', message: 'That key isn’t valid for Foldertrail.' };
    },
    getStoredLicense: () => null,
    storeLicense: (/** @type {string} */ key) => stored.push(key),
    clearLicense: () => {},
  };
  const { controller, workers } = makeController({ license, onSale: true });
  assert.equal(controller.state.licence.status, 'none');
  await controller.open([]);
  const worker = workers.made[0];
  worker.reply({ type: 'parsed', id: worker.posted[0].id, preview: samplePreview(), dump: null });

  await controller.download();
  assert.equal(worker.posted.length, 1, 'no key, no export');
  assert.equal(controller.state.licence.message, TEXT.licenceEmpty);

  assert.equal(await controller.verify('  '), false);
  assert.equal(checked.length, 0, 'an empty key is never sent');
  assert.equal(await controller.verify('x'.repeat(LIMITS.licenceKeyLength + 1)), false);
  assert.equal(checked.length, 0, 'an absurd key is never sent');

  assert.equal(await controller.verify('WRONG-KEY-0000-0000'), false);
  assert.equal(controller.state.licence.status, 'invalid');
  assert.equal(controller.state.licence.message, 'That key isn’t valid for Foldertrail.');
  await controller.download();
  assert.equal(worker.posted.length, 1, 'a refused key does not unlock');

  assert.equal(await controller.verify(' GOOD-KEY-0000-0000 '), true);
  assert.deepEqual(checked, ['WRONG-KEY-0000-0000', 'GOOD-KEY-0000-0000']);
  assert.deepEqual(stored, [], 'the licence module already saved it (stored: true)');
  assert.equal(controller.state.licence.status, 'valid');
  assert.equal(controller.state.licence.message, 'Thank you. Foldertrail is unlocked in this browser.');

  controller.setOptions({ kml: false, perItem: true });
  await controller.download();
  const exportMsg = worker.posted[1];
  assert.deepEqual(exportMsg.options, { kml: false, perItem: true });
  assert.equal(exportMsg.type, 'export');
  assert.equal(exportMsg.id, worker.posted[0].id, 'an export names the library by the id it was parsed with');
  assert.equal(controller.state.busy, 'export');
  await controller.download();
  assert.equal(worker.posted.length, 2, 'one export at a time');

  worker.reply({ type: 'exported', id: exportMsg.id, zip: { size: 'big' }, filename: 'x.zip', report: {} });
  assert.equal(controller.state.view, 'preview', 'a zip that is not a Blob is refused');
  assert.match(String(controller.state.exportError), /could not be made/);

  await controller.download();
  const second = worker.posted[2];
  assert.equal(second.id, exportMsg.id);
  const zip = new Blob(['PK']);
  worker.reply({ type: 'exported', id: second.id, zip, filename: '../../evil.zip', report: { text: 'Report text', html: '<script>x</script>' } });
  assert.equal(controller.state.view, 'done');
  assert.equal(controller.state.result?.blob, zip);
  assert.match(String(controller.state.result?.filename), /^foldertrail-export-\d{4}-\d{2}-\d{2}\.zip$/);
  assert.equal(controller.state.result?.reportText, 'Report text');
});

test('a saved key is checked again before the first download of the session', async () => {
  const checked = [];
  const license = {
    verifyLicense: async (/** @type {string} */ key) => (checked.push(key), { ok: true, message: '' }),
    getStoredLicense: () => 'SAVED-KEY-0000-0000',
    storeLicense: () => {},
    clearLicense: () => {},
  };
  const { controller, workers } = makeController({ license, onSale: true });
  assert.equal(controller.state.licence.status, 'stored');
  assert.equal(controller.state.licence.hasStored, true);
  await controller.open([]);
  const worker = workers.made[0];
  worker.reply({ type: 'parsed', id: worker.posted[0].id, preview: samplePreview(), dump: null });
  await controller.download();
  assert.deepEqual(checked, ['SAVED-KEY-0000-0000']);
  assert.equal(worker.posted[1].type, 'export');
  assert.equal(controller.state.licence.message, TEXT.licenceValid);
  controller.forgetLicence();
  assert.equal(controller.state.licence.status, 'none');
  assert.equal(controller.state.licence.hasStored, false);
});

test('a licence check that hangs times out; one that throws fails plainly', async () => {
  const hanging = { verifyLicense: () => new Promise(() => {}) };
  const a = makeController({ license: hanging, onSale: true, sleep: async () => {} });
  assert.equal(await a.controller.verify('SOME-KEY-0000-0000'), false);
  assert.equal(a.controller.state.licence.message, TEXT.licenceTimeout);

  const throwing = { verifyLicense: () => { throw new Error('boom with a secret'); } };
  const b = makeController({ license: throwing, onSale: true });
  assert.equal(await b.controller.verify('SOME-KEY-0000-0000'), false);
  assert.equal(b.controller.state.licence.message, TEXT.licenceFailed);
});

test('intake problems go back to the first step in plain words; a cancelled intake is not an error', async () => {
  const failing = async () => ({
    ok: false,
    problems: [
      { code: 'no_library', message: 'No BaseCamp library was found in what you gave.', count: 1 },
      { code: 'no_library', message: 'No BaseCamp library was found in what you gave.', count: 1 },
    ],
  });
  const { controller, workers } = makeController({ intake: failing });
  await controller.open([]);
  assert.equal(controller.state.view, 'open');
  assert.deepEqual(controller.state.openErrors, ['No BaseCamp library was found in what you gave.']);
  assert.equal(workers.made.length, 0);

  const throwing = makeController({ intake: async () => { throw new Error('x'); } });
  await throwing.controller.open([]);
  assert.deepEqual(throwing.controller.state.openErrors, [TEXT.internal]);

  const cancelled = makeController({ intake: async () => ({ ok: false, problems: [{ code: 'cancelled', message: 'Reading was canceled.', count: 1 }] }) });
  await cancelled.controller.open([]);
  assert.deepEqual(cancelled.controller.state.openErrors, []);
  assert.equal(cancelled.controller.state.status, TEXT.cancelled);
});

test('cancel while the intake runs aborts it; its late answer is ignored', async () => {
  /** @type {(v: any) => void} */
  let finish = () => {};
  /** @type {AbortSignal|null} */
  let signal = null;
  const slow = (/** @type {any} */ _input, /** @type {any} */ options) =>
    new Promise((resolve) => {
      signal = options.signal;
      finish = resolve;
    });
  const { controller, workers } = makeController({ intake: slow });
  const pending = controller.open([]);
  assert.equal(controller.state.busy, 'intake');
  controller.cancel();
  assert.equal(/** @type {any} */ (signal)?.aborted, true);
  assert.equal(controller.state.view, 'open');
  finish({ ok: true, found: FOUND, problems: [], notes: [] });
  await pending;
  assert.equal(controller.state.view, 'open');
  assert.equal(workers.made.length, 0);
});

test('cancel while parsing stops the worker; a new library gets a new worker', async () => {
  const { controller, workers } = makeController();
  await controller.open([]);
  const first = workers.made[0];
  controller.cancel();
  assert.equal(first.terminated, true);
  assert.equal(controller.state.view, 'open');
  assert.equal(controller.state.status, TEXT.cancelled);
  first.reply({ type: 'parsed', id: first.posted[0].id, preview: samplePreview(), dump: null });
  assert.equal(controller.state.view, 'open', 'the stopped worker cannot bring the preview back');
  await controller.open([]);
  assert.equal(workers.made.length, 2);
});

test('a worker that dies while parsing shows the error view; one that dies while exporting keeps the preview', async () => {
  const { controller, workers } = makeController({ license: { verifyLicense: async () => ({ ok: true }) }, onSale: true });
  await controller.open([]);
  workers.made[0].fail('error');
  assert.equal(controller.state.view, 'error');
  assert.equal(controller.state.error, TEXT.workerFailed);

  controller.dismissError();
  assert.equal(controller.state.view, 'open');
  await controller.open([]);
  const worker = workers.made[1];
  worker.reply({ type: 'parsed', id: worker.posted[0].id, preview: samplePreview(), dump: { text: 'd', json: '{}' } });
  await controller.verify('GOOD-KEY-0000-0000');
  await controller.download();
  worker.fail('error');
  assert.equal(controller.state.view, 'preview');
  assert.equal(controller.state.exportError, TEXT.workerFailed);
  await controller.download();
  assert.match(String(controller.state.exportError), /could not be made/, 'with no worker left, the page says so');
});

test('worker error messages: during parsing they become the error view; during export, a note under the button', async () => {
  const { controller, workers } = makeController({ license: { verifyLicense: async () => ({ ok: true }) }, onSale: true });
  await controller.open([]);
  const worker = workers.made[0];
  worker.reply({ type: 'error', id: worker.posted[0].id, code: 'internal', message: 'Something unexpected went wrong.' });
  assert.equal(controller.state.view, 'error');
  assert.equal(controller.state.error, 'Something unexpected went wrong.');

  controller.reset();
  assert.equal(worker.terminated, true, 'reset lets the old library go');
  await controller.open([]);
  const w2 = workers.made[1];
  w2.reply({ type: 'parsed', id: w2.posted[0].id, preview: samplePreview(), dump: null });
  await controller.verify('GOOD-KEY-0000-0000');
  await controller.download();
  assert.equal(w2.posted[1].id, w2.posted[0].id);
  w2.reply({ type: 'error', id: w2.posted[1].id, code: 'export_failed', message: 'The download could not be made.' });
  assert.equal(controller.state.view, 'preview');
  assert.equal(controller.state.exportError, 'The download could not be made.');
  w2.reply({ type: 'error', id: w2.posted[1].id, code: 'x', message: 'late' });
  assert.equal(controller.state.exportError, 'The download could not be made.', 'nothing is running, so it is ignored');
});

test('cancelling an export ignores its late result and keeps the preview', async () => {
  const { controller, workers } = makeController({ license: { verifyLicense: async () => ({ ok: true }) }, onSale: true });
  await controller.open([]);
  const worker = workers.made[0];
  worker.reply({ type: 'parsed', id: worker.posted[0].id, preview: samplePreview(), dump: null });
  await controller.verify('GOOD-KEY-0000-0000');
  await controller.download();
  controller.cancel();
  assert.equal(worker.terminated, false, 'the worker keeps the library for the next try');
  assert.equal(controller.state.exportError, TEXT.exportCancelled);
  const id = worker.posted[0].id;
  // The user downloads again before the cancelled export has answered.
  await controller.download();
  assert.equal(worker.posted[2].type, 'export');
  assert.equal(worker.posted[2].id, id);
  // Answers come in order: first the cancelled export's, which is dropped, then the new one's.
  worker.reply({ type: 'exported', id, zip: new Blob(['old']), filename: 'old.zip', report: {} });
  assert.equal(controller.state.view, 'preview', 'the cancelled export does not finish the new one');
  assert.equal(controller.state.busy, 'export');
  const zip = new Blob(['new']);
  worker.reply({ type: 'exported', id, zip, filename: 'new.zip', report: {} });
  assert.equal(controller.state.view, 'done');
  assert.equal(controller.state.result?.blob, zip);
});

test('a cancelled export that ends in an error is dropped too, and a later export still works', async () => {
  const { controller, workers } = makeController({ license: { verifyLicense: async () => ({ ok: true }) }, onSale: true });
  await controller.open([]);
  const worker = workers.made[0];
  const id = worker.posted[0].id;
  worker.reply({ type: 'parsed', id, preview: samplePreview(), dump: null });
  await controller.verify('GOOD-KEY-0000-0000');
  await controller.download();
  controller.cancel();
  worker.reply({ type: 'error', id, code: 'export_failed', message: 'The download could not be made.' });
  assert.equal(controller.state.exportError, TEXT.exportCancelled, 'the cancelled export’s error is not shown');
  await controller.download();
  worker.reply({ type: 'exported', id, zip: new Blob(['z']), filename: 'z.zip', report: {} });
  assert.equal(controller.state.view, 'done');
});

test('a preview that says nothing could be converted goes to the error view, keeping the diagnostic report', async () => {
  const { controller, workers } = makeController();
  await controller.open([]);
  const worker = workers.made[0];
  worker.reply({
    type: 'parsed',
    id: worker.posted[0].id,
    preview: samplePreview({ fatal: { code: 'unsupported_version', message: 'This library was made by an older BaseCamp.' } }),
    dump: { text: 'structure only', json: '{}' },
  });
  assert.equal(controller.state.view, 'error');
  assert.equal(controller.state.error, 'This library was made by an older BaseCamp.');
  assert.equal(controller.state.preview, null);
  assert.equal(controller.state.dump?.text, 'structure only');
  controller.dismissError();
  assert.equal(controller.state.view, 'open');
});

test('malformed worker messages are ignored or refused, never thrown', async () => {
  const { controller, workers } = makeController();
  await controller.open([]);
  const worker = workers.made[0];
  for (const junk of [null, 'parsed', 42, { type: 'parsed' }, { id: worker.posted[0].id }, { type: 'nope', id: worker.posted[0].id }]) {
    worker.reply(junk);
  }
  assert.equal(controller.state.view, 'read');
  worker.reply({ type: 'parsed', id: worker.posted[0].id, preview: 'not a preview' });
  assert.equal(controller.state.view, 'error');
  assert.equal(controller.state.error, TEXT.badReply);
});

test('a drawing failure in onChange does not break the flow', async () => {
  const { controller } = makeController({
    onChange: () => {
      throw new Error('draw failed');
    },
  });
  await controller.open([]);
  assert.equal(controller.state.busy, 'parse');
});

// ---------------------------------------------------------------------------------------------
// The views, on a small fake DOM

class FakeNode {
  /** @param {FakeDocument} doc */
  constructor(doc) {
    this.ownerDocument = doc;
    /** @type {FakeNode|null} */
    this.parentNode = null;
    /** @type {FakeNode[]} */
    this.childNodes = [];
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  /** @param {FakeNode} child */
  appendChild(child) {
    if (child instanceof FakeFragment) {
      for (const c of [...child.childNodes]) this.appendChild(c);
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  /** @param {...(FakeNode|string)} nodes */
  append(...nodes) {
    for (const n of nodes) this.appendChild(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n);
  }
  /** @param {FakeNode} child */
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i < 0) throw new Error('not a child');
    this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  /** @returns {string} */
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(value) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (value !== '') this.appendChild(this.ownerDocument.createTextNode(String(value)));
  }
  /** @param {FakeNode|null} node */
  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
}

class FakeText extends FakeNode {
  /** @param {FakeDocument} doc @param {string} data */
  constructor(doc, data) {
    super(doc);
    this.data = data;
  }
  get textContent() {
    return this.data;
  }
  set textContent(value) {
    this.data = String(value);
  }
}

class FakeFragment extends FakeNode {}

class FakeElement extends FakeNode {
  /** @param {FakeDocument} doc @param {string} tag */
  constructor(doc, tag) {
    super(doc);
    this.tagName = tag.toUpperCase();
    /** @type {Map<string, string>} */
    this.attributes = new Map();
    /** @type {Record<string, Function[]>} */
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.style = {};
  }
  set innerHTML(_v) {
    throw new Error('innerHTML must never be used');
  }
  get innerHTML() {
    throw new Error('innerHTML must never be used');
  }
  insertAdjacentHTML() {
    throw new Error('insertAdjacentHTML must never be used');
  }
  get className() {
    return this.attributes.get('class') ?? '';
  }
  set className(value) {
    this.attributes.set('class', String(value));
  }
  get classList() {
    const el = this;
    const list = () => el.className.split(/\s+/).filter(Boolean);
    return {
      contains: (/** @type {string} */ c) => list().includes(c),
      add: (/** @type {string[]} */ ...cs) => (el.className = [...new Set([...list(), ...cs])].join(' ')),
      remove: (/** @type {string[]} */ ...cs) => (el.className = list().filter((x) => !cs.includes(x)).join(' ')),
      toggle: (/** @type {string} */ c, /** @type {boolean|undefined} */ force) => {
        const on = force ?? !list().includes(c);
        el.className = on ? [...new Set([...list(), c])].join(' ') : list().filter((x) => x !== c).join(' ');
        return on;
      },
    };
  }
  /** @param {string} name @param {string} value */
  setAttribute(name, value) {
    const lower = name.toLowerCase();
    if (lower === 'style' || lower.startsWith('on')) throw new Error(`${name} must never be set`);
    this.attributes.set(lower, String(value));
  }
  /** @param {string} name */
  getAttribute(name) {
    return this.attributes.has(name.toLowerCase()) ? /** @type {string} */ (this.attributes.get(name.toLowerCase())) : null;
  }
  /** @param {string} name */
  removeAttribute(name) {
    this.attributes.delete(name.toLowerCase());
  }
  /** @param {string} name */
  hasAttribute(name) {
    return this.attributes.has(name.toLowerCase());
  }
  get dataset() {
    return new Proxy({}, { get: (_t, key) => this.getAttribute(`data-${String(key).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`) ?? undefined });
  }
  get tabIndex() {
    const v = this.getAttribute('tabindex');
    return v === null ? -1 : Number(v);
  }
  set tabIndex(value) {
    this.setAttribute('tabindex', String(value));
  }
  get children() {
    return /** @type {FakeElement[]} */ (this.childNodes.filter((c) => c instanceof FakeElement));
  }
  get childElementCount() {
    return this.children.length;
  }
  /** @param {string} type @param {Function} fn */
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  /** @param {any} event */
  dispatchEvent(event) {
    event.target ??= this;
    for (let n = /** @type {FakeNode|null} */ (this); n; n = n.parentNode) {
      if (n instanceof FakeElement) for (const fn of n.listeners[event.type] ?? []) fn.call(n, event);
    }
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  /** @param {string} selector */
  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector.startsWith('#')) return this.getAttribute('id') === selector.slice(1);
    const attr = /^\[([\w-]+)=([\w-]+)\]$/.exec(selector);
    if (attr) return this.getAttribute(attr[1]) === attr[2];
    return this.tagName === selector.toUpperCase();
  }
  /** @param {string} selector */
  closest(selector) {
    for (let n = /** @type {FakeNode|null} */ (this); n; n = n.parentNode) if (n instanceof FakeElement && n.matches(selector)) return n;
    return null;
  }
  /** @param {string} selector @returns {FakeElement[]} */
  querySelectorAll(selector) {
    const out = [];
    const stack = [...this.children].reverse();
    while (stack.length) {
      const el = /** @type {FakeElement} */ (stack.pop());
      if (el.matches(selector)) out.push(el);
      stack.push(...[...el.children].reverse());
    }
    return out;
  }
  /** @param {string} selector */
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class FakeDocument {
  constructor() {
    /** @type {FakeElement|null} */
    this.activeElement = null;
  }
  /** @param {string} tag */
  createElement(tag) {
    return new FakeElement(this, tag);
  }
  /** @param {string} text */
  createTextNode(text) {
    return new FakeText(this, text);
  }
  createDocumentFragment() {
    return new FakeFragment(this);
  }
}

/** Installs the fake DOM for one test. */
function withDom() {
  const doc = new FakeDocument();
  const saved = { document: globalThis.document, Element: globalThis.Element };
  Object.assign(globalThis, { document: doc, Element: FakeElement });
  return {
    doc,
    restore: () => Object.assign(globalThis, saved),
  };
}

/** @param {FakeDocument} doc */
function previewEls(doc) {
  const names = ['summary', 'meta', 'notices', 'tree', 'treeNote', 'expandAll', 'collapseAll', 'also', 'ncFacts', 'ncItems', 'notesSection', 'notesList'];
  return Object.fromEntries(names.map((n) => [n, doc.createElement(n === 'expandAll' || n === 'collapseAll' ? 'button' : 'div')]));
}

/** @param {FakeElement} el @returns {string[]} */
function allTags(el) {
  return [el.tagName, ...el.children.flatMap((c) => allTags(c))];
}

test('view-dom builds elements with text only, and refuses style, event-handler and javascript: attributes', async () => {
  const dom = withDom();
  try {
    const { h, icon } = await import('../src/app/view-dom.js');
    const el = /** @type {any} */ (h('p', { class: 'x', text: '<b>not bold</b>', attrs: { 'data-id': 'a', hidden: false } }, ' and ', icon('folder')));
    assert.equal(el.textContent, '<b>not bold</b> and ');
    assert.deepEqual(allTags(el), ['P', 'SPAN']);
    assert.equal(el.getAttribute('hidden'), null);
    assert.equal(el.children[0].getAttribute('aria-hidden'), 'true');
    assert.throws(() => h('p', { attrs: { style: 'color:red' } }), /refusing/);
    assert.throws(() => h('img', { attrs: { onerror: 'x()' } }), /refusing/);
    assert.throws(() => h('a', { attrs: { href: ' JavaScript:alert(1)' } }), /javascript/);
  } finally {
    dom.restore();
  }
});

test('the preview draws names as text (a hostile name stays text), with the tree as an ARIA tree', async () => {
  const dom = withDom();
  try {
    const { createPreview } = await import('../src/app/view-preview.js');
    const els = /** @type {any} */ (previewEls(dom.doc));
    const view = createPreview(els);
    const preview = normalisePreview(
      samplePreview({
        notConverted: [{ kind: 'route', name: '<script>alert(1)</script>', reason: 'autoroute', listIds: [] }],
        ambiguousCount: 1,
        duplicates: [{ kind: 'waypoint', name: '<iframe src=x>', copies: 2 }],
        meta: { source: 'synthetic', version: '170', experimental: true, libraryVersion: '4.8' },
      }),
    );
    view.update(/** @type {any} */ ({ preview, previewId: 1, versionFolder: null, intakeProblems: [], intakeNotes: [] }));

    // One route will not convert, so the library holds two: the sentence says what converts and how many more there are.
    assert.equal(els.summary.textContent, 'Foldertrail can convert 6 waypoints, 1 track and 1 route, in 3 lists and 2 folders. 1 more route can’t be converted; it’s listed below.');
    for (const container of [els.tree, els.ncItems, els.also, els.notices]) {
      const tags = allTags(container);
      for (const bad of ['IMG', 'SCRIPT', 'IFRAME']) assert.ok(!tags.includes(bad), `${bad} in ${tags.join(',')}`);
    }
    assert.match(els.ncItems.textContent, /<script>alert\(1\)<\/script>/);
    assert.match(els.also.textContent, /<iframe src=x>/);
    assert.match(els.notices.textContent, /Read experimentally/);

    const rows = els.tree.querySelectorAll('.row');
    assert.equal(rows.length, 6, 'a small library starts fully open');
    assert.equal(els.tree.getAttribute('role'), 'tree');
    const hostile = rows.find((/** @type {any} */ r) => r.dataset.id === 'l2');
    assert.equal(hostile.querySelector('.row-title').textContent, '<img src=x onerror=alert(1)>');
    assert.equal(hostile.getAttribute('aria-level'), '3');
    assert.equal(hostile.getAttribute('aria-posinset'), '2');
    assert.equal(hostile.getAttribute('aria-setsize'), '2');
    assert.equal(hostile.getAttribute('aria-label'), '<img src=x onerror=alert(1)>, list, 1 waypoint');
    const root = rows[0];
    assert.equal(root.getAttribute('aria-expanded'), 'true');
    assert.equal(root.getAttribute('aria-label'), 'My Collection, folder, 3 lists');
    assert.equal(rows.filter((/** @type {any} */ r) => r.tabIndex === 0).length, 1, 'one Tab stop');
    // Guides: the last list in Hiking ends with an elbow, under a folder that has later siblings.
    const guides = hostile.querySelectorAll('.g').map((/** @type {any} */ g) => g.className);
    assert.deepEqual(guides, ['g g-pipe', 'g g-elbow']);
    assert.match(els.treeNote.textContent, /3 lists in 2 folders/);
    assert.equal(els.notesSection.hidden, false);
    assert.match(els.notesList.textContent, /A made-up note\.×2/);
  } finally {
    dom.restore();
  }
});

test('the tree works from the keyboard: arrows move, Left closes and climbs, Right opens and descends', async () => {
  const dom = withDom();
  try {
    const { createPreview } = await import('../src/app/view-preview.js');
    const els = /** @type {any} */ (previewEls(dom.doc));
    createPreview(els).update(/** @type {any} */ ({ preview: normalisePreview(samplePreview()), previewId: 1, versionFolder: null, intakeProblems: [], intakeNotes: [] }));
    const key = (/** @type {string} */ k) => {
      const event = { type: 'keydown', key: k, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      els.tree.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const active = () => els.tree.querySelectorAll('.row').find((/** @type {any} */ r) => r.tabIndex === 0)?.dataset.id;
    const count = () => els.tree.querySelectorAll('.row').length;

    assert.equal(active(), 'root');
    assert.equal(key('ArrowDown'), true);
    assert.equal(active(), 'f1');
    assert.equal(dom.doc.activeElement?.dataset.id, 'f1', 'focus follows');
    key('ArrowLeft');
    assert.equal(count(), 4, 'Hiking closed');
    assert.equal(active(), 'f1');
    key('ArrowLeft');
    assert.equal(active(), 'root', 'Left on a closed folder goes to its parent');
    key('ArrowDown');
    key('ArrowRight');
    assert.equal(count(), 6, 'Right opens');
    key('ArrowRight');
    assert.equal(active(), 'l1', 'Right on an open folder goes to its first child');
    key('End');
    assert.equal(active(), 'l3');
    key('Home');
    assert.equal(active(), 'root');
    key(' ');
    assert.equal(count(), 1, 'Space closes the top folder');
    assert.equal(key('a'), false, 'other keys are left alone');

    const rowRoot = els.tree.querySelectorAll('.row')[0];
    rowRoot.querySelector('.row-title').dispatchEvent({ type: 'click' });
    assert.equal(count(), 6, 'a click on a folder row opens it');
    els.collapseAll.dispatchEvent({ type: 'click' });
    assert.equal(count(), 4, 'Collapse all keeps the top level open');
    els.expandAll.dispatchEvent({ type: 'click' });
    assert.equal(count(), 6);
  } finally {
    dom.restore();
  }
});

test('a library without a folder file says so instead of drawing an empty tree', async () => {
  const dom = withDom();
  try {
    const { createPreview } = await import('../src/app/view-preview.js');
    const els = /** @type {any} */ (previewEls(dom.doc));
    createPreview(els).update(
      /** @type {any} */ ({
        preview: normalisePreview(samplePreview({ tree: [], treeMissing: true })),
        previewId: 1,
        versionFolder: null,
        intakeProblems: [{ code: 'no_folder_data', message: 'FolderData.gfi was not found.', count: 1 }],
        intakeNotes: [],
      }),
    );
    assert.match(els.notices.textContent, /No folders or lists were found/);
    assert.match(els.tree.textContent, /grouped by type/);
    assert.equal(els.tree.getAttribute('role'), null);
    assert.equal(els.expandAll.hidden, true);
    assert.ok(!/FolderData\.gfi was not found/.test(els.notesList.textContent), 'not said twice');
  } finally {
    dom.restore();
  }
});

test('without a folder tree the preview neither promises a "Not in any list" file nor draws an empty tree footer', async () => {
  const dom = withDom();
  try {
    const { createPreview } = await import('../src/app/view-preview.js');
    const els = /** @type {any} */ (previewEls(dom.doc));
    const foot = dom.doc.createElement('div');
    foot.className = 'tree-foot';
    foot.appendChild(els.treeNote);
    const view = createPreview(els);
    // With no FolderData.gfi every item is "unlisted", but the download groups them by type (Waypoints.gpx, …),
    // and the notice above already says so: there is no "Not in any list" file to point at.
    view.update(/** @type {any} */ ({
      preview: normalisePreview(samplePreview({ tree: [], treeMissing: true, unlisted: { waypoints: 6, tracks: 1, routes: 1 } })),
      previewId: 1, versionFolder: null, intakeProblems: [], intakeNotes: [],
    }));
    assert.doesNotMatch(els.also.textContent, /Not in any list/);
    assert.equal(foot.hidden, true, 'nothing to say and no buttons: the footer band is hidden');
    // A normal library brings both back.
    view.update(/** @type {any} */ ({ preview: normalisePreview(samplePreview()), previewId: 2, versionFolder: null, intakeProblems: [], intakeNotes: [] }));
    assert.match(els.also.textContent, /Not in any list/);
    assert.equal(foot.hidden, false);
  } finally {
    dom.restore();
  }
});

test('a folder file that could not be read is said once (the notice), not again in the notes', async () => {
  const dom = withDom();
  try {
    const { createPreview } = await import('../src/app/view-preview.js');
    const els = /** @type {any} */ (previewEls(dom.doc));
    const unreadable = { code: 'folder_data_unreadable', message: 'FolderData.gfi could not be read, so your folders and lists could not be rebuilt.', count: 1, level: 'report' };
    createPreview(els).update(
      /** @type {any} */ ({
        preview: normalisePreview(samplePreview({ tree: [], treeMissing: true, problems: [unreadable] })),
        previewId: 1,
        versionFolder: null,
        intakeProblems: [],
        intakeNotes: [],
      }),
    );
    assert.match(els.notices.textContent, /missing or can’t be read/);
    assert.ok(!/could not be read, so your folders/.test(els.notesList.textContent), 'not said twice');
  } finally {
    dom.restore();
  }
});

// ---------------------------------------------------------------------------------------------
// Design review, 2026-10-06: honesty and clarity of the preview, the download panel and the done view.
// Each test below failed before the fix it names (screenshots: the UI review's before/after sets).

/** A preview with a list whose items do not come along: two road routes, and a duplicated waypoint name. */
function previewWithLeftOut(extra = {}) {
  return samplePreview({
    tree: [
      ...ROWS,
      { id: 'lc', name: 'Coast leg', type: 'list', parentId: 'root', counts: { waypoints: 0, tracks: 0, routes: 0 } },
      { id: 'le', name: 'Truly empty', type: 'list', parentId: 'root', counts: { waypoints: 0, tracks: 0, routes: 0 } },
    ],
    totals: { folders: 2, lists: 5, waypoints: 6, tracks: 1, routes: 1 },
    notConverted: [
      { kind: 'route', name: 'Coast road', reason: 'route_autoroute', listIds: ['lc'] },
      { kind: 'route', name: 'Inland road', reason: 'route_autoroute', listIds: ['lc', 'l3'] },
    ],
    ambiguousCount: 2,
    duplicates: [{ kind: 'waypoint', name: 'Fuel', copies: 2, listIds: ['lc'] }],
    ...extra,
  });
}

/** @param {any} preview @param {any} [state] */
async function drawPreview(preview, state = {}) {
  const dom = withDom();
  const { createPreview } = await import('../src/app/view-preview.js');
  const els = /** @type {any} */ (previewEls(dom.doc));
  els.head = dom.doc.createElement('div');
  createPreview(els).update(/** @type {any} */ ({ preview: normalisePreview(preview), previewId: 1, versionFolder: null, intakeProblems: [], intakeNotes: [], ...state }));
  return { dom, els };
}

test('the summary never says the library holds fewer items than it does: what will not convert is counted and said', () => {
  const preview = /** @type {any} */ (normalisePreview(previewWithLeftOut()));
  const sentence = summarySentence(preview);
  // Before: "Your library holds 6 waypoints, 1 track and 1 route, …" although it holds 3 routes.
  assert.doesNotMatch(sentence, /holds 6 waypoints, 1 track and 1 route/);
  assert.equal(sentence, 'Foldertrail can convert 6 waypoints, 1 track and 1 route, in 5 lists and 2 folders. 2 more routes can’t be converted; they’re listed below.');
  const one = /** @type {any} */ (normalisePreview(previewWithLeftOut({ notConverted: [{ kind: 'track', name: 'T', reason: 'track_not_decoded', listIds: [] }] })));
  assert.equal(summarySentence(one), 'Foldertrail can convert 6 waypoints, 1 track and 1 route, in 5 lists and 2 folders. 1 more track can’t be converted; it’s listed below.');
  const mixed = /** @type {any} */ (normalisePreview(previewWithLeftOut({ notConverted: [
    { kind: 'track', name: 'T', reason: 'track_not_decoded', listIds: [] },
    { kind: 'route', name: 'R', reason: 'route_autoroute', listIds: [] },
    { kind: 'route', name: 'S', reason: 'route_autoroute', listIds: [] },
  ] })));
  assert.match(summarySentence(mixed), /\. 1 more track and 2 more routes can’t be converted; they’re listed below\.$/);
  // Nothing left out: the sentence is unchanged.
  assert.equal(summarySentence(/** @type {any} */ (normalisePreview(samplePreview()))), 'Your library holds 6 waypoints, 1 track and 1 route, in 3 lists and 2 folders.');
});

test('a list whose items will not come along says so instead of "Empty", in its row and its label', async () => {
  const { dom, els } = await drawPreview(previewWithLeftOut());
  try {
    const rows = els.tree.querySelectorAll('.row');
    const coast = rows.find((/** @type {any} */ r) => r.dataset.id === 'lc');
    assert.doesNotMatch(coast.textContent, /empty/i, 'before: "Empty", though BaseCamp shows two routes and a waypoint in it');
    assert.equal(coast.querySelector('.row-sub').textContent, 'nothing that converts');
    assert.match(coast.textContent, /2 routes not converted/);
    assert.match(coast.textContent, /1 waypoint in “_Duplicate names”/);
    assert.equal(coast.getAttribute('aria-label'), 'Coast leg, list, nothing that converts, 2 routes not converted, 1 waypoint in “_Duplicate names”');
    const inbox = rows.find((/** @type {any} */ r) => r.dataset.id === 'l3');
    assert.match(inbox.textContent, /1 route not converted/, 'an item in two lists is flagged in both');
    assert.equal(inbox.getAttribute('aria-label'), 'Inbox, list, 2 waypoints and 1 route, 1 route not converted');
    const empty = rows.find((/** @type {any} */ r) => r.dataset.id === 'le');
    assert.equal(empty.querySelector('.row-sub').textContent, 'empty', 'a list with nothing in it is still called empty');
    assert.equal(empty.querySelectorAll('.row-flag').length, 0);
  } finally {
    dom.restore();
  }
});

test('the number cells of a tree row are hidden from screen readers (the row label already says it)', async () => {
  const { dom, els } = await drawPreview(samplePreview());
  try {
    const cells = els.tree.querySelectorAll('.num');
    assert.ok(cells.length > 0);
    for (const cell of cells) assert.equal(cell.getAttribute('aria-hidden'), 'true');
  } finally {
    dom.restore();
  }
});

test('"every item will be converted" is never said when the reader left something out', async () => {
  const leftOut = { code: 'waypoint_class_not_exported', message: 'Some waypoint records are of a kind this tool does not convert. They were counted and left out.', count: 1, level: 'report' };
  const { dom, els } = await drawPreview(samplePreview({ problems: [leftOut] }));
  try {
    assert.doesNotMatch(els.ncFacts.textContent, /Every waypoint, track and route/);
  } finally {
    dom.restore();
  }
  const clean = await drawPreview(samplePreview({ problems: [] }));
  try {
    assert.match(clean.els.ncFacts.textContent, /Every waypoint, track and route counted above will be converted\./);
  } finally {
    clean.dom.restore();
  }
});

test('notes from reading do not repeat what a section above already shows (with a different count)', async () => {
  const problems = [
    { code: 'route_not_converted', message: 'Some routes were not converted. They are listed by name, with the reason.', count: 2, level: 'report' },
    { code: 'duplicate_names', message: 'Some items share their name with another item of the same kind.', count: 1, level: 'report' },
    { code: 'not_in_any_list', message: 'Some items are not in any list. They are in "Not in any list".', count: 1, level: 'report' },
    { code: 'text_not_utf8', message: 'Some names were read as Western text.', count: 1, level: 'report' },
  ];
  const intakeNotes = [{ code: 'no_track_segments', message: 'No TrackSegments folder was found next to AllData.gdb.', count: 1, level: 'report' }];
  const { dom, els } = await drawPreview(previewWithLeftOut({ problems, totals: { folders: 2, lists: 5, waypoints: 6, tracks: 0, routes: 1 } }), { intakeNotes });
  try {
    const notes = els.notesList.textContent;
    assert.doesNotMatch(notes, /Some routes were not converted/, 'the "What will not convert" panel lists them');
    assert.doesNotMatch(notes, /share their name/, '"Duplicate names" above says it, with the right count');
    assert.doesNotMatch(notes, /not in any list/i, '"Not in any list" above says it');
    assert.doesNotMatch(notes, /TrackSegments/, 'a library with no tracks loses nothing without TrackSegments');
    assert.match(notes, /Western text/, 'other notes stay');
  } finally {
    dom.restore();
  }
  // Without the section above, the note is the only place that says it, so it stays.
  const flat = await drawPreview(samplePreview({ problems: [problems[2]], unlisted: { waypoints: 0, tracks: 0, routes: 0 } }));
  try {
    assert.match(flat.els.notesList.textContent, /not in any list/i);
  } finally {
    flat.dom.restore();
  }
});

test('each group of items that will not convert is headed by its reason, as a heading', async () => {
  const routes = [
    { kind: 'route', name: 'A', reason: 'route_autoroute', listIds: [] },
    { kind: 'route', name: 'B', reason: 'route_not_decoded', listIds: [] },
    { kind: 'route', name: 'C', reason: 'route_via_unresolved', listIds: [] },
  ];
  const titles = groupNotConverted(routes).map((g) => /** @type {any} */ (g).title);
  assert.equal(new Set(titles).size, 3, `three different titles, not "1 route not converted" three times: ${titles.join(' | ')}`);
  assert.deepEqual(titles, ['1 route that follows roads', '1 route that could not be read', '1 route with a via point that is missing']);
  assert.equal(/** @type {any} */ (groupNotConverted([...routes, { ...routes[0], name: 'D' }])[0]).title, '2 routes that follow roads');
  // The sentence under the title says it once, not "they follow roads, and routes that follow roads…".
  assert.equal((reasonText('route', 'route_autoroute', 2).match(/follow/g) ?? []).length, 1, reasonText('route', 'route_autoroute', 2));
  const { dom, els } = await drawPreview(samplePreview({ notConverted: routes }));
  try {
    const heads = els.ncItems.querySelectorAll('.nc-head-title');
    assert.deepEqual(heads.map((/** @type {any} */ h) => h.tagName), ['H3', 'H3', 'H3']);
    assert.match(els.ncItems.textContent, /1 route that follows roads/);
  } finally {
    dom.restore();
  }
});

test('the tree footer says "1 list", never "1 list in no folders", and the column heads hide when there is no tree', async () => {
  const flatTree = [
    { id: 'root', name: 'My Collection', type: 'folder', parentId: null, counts: { waypoints: 0, tracks: 0, routes: 0 } },
    { id: 'l1', name: 'Routes', type: 'list', parentId: 'root', counts: { waypoints: 2, tracks: 0, routes: 3 } },
  ];
  const one = await drawPreview(samplePreview({ tree: flatTree, totals: { folders: 0, lists: 1, waypoints: 2, tracks: 0, routes: 3 } }));
  try {
    assert.equal(one.els.treeNote.textContent, '1 list');
    assert.equal(one.els.head.hidden, false);
  } finally {
    one.dom.restore();
  }
  const none = await drawPreview(samplePreview({ tree: [], treeMissing: true }));
  try {
    assert.equal(none.els.head.hidden, true, 'no Waypoints/Tracks/Routes columns above "There are no folders or lists to show"');
  } finally {
    none.dom.restore();
  }
});

test('long folder and list names wrap in the tree instead of being cut off with "…"', () => {
  const css = readFileSync(new URL('../site/assets/app.css', import.meta.url), 'utf8');
  /** @param {string} selector */
  const rule = (selector) => {
    const re = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g');
    return [...css.matchAll(re)].map((m) => m[1]).join('\n');
  };
  const title = rule('.row-title');
  assert.ok(title !== '', 'app.css styles .row-title');
  assert.doesNotMatch(title, /text-overflow:\s*ellipsis/, '.row-title is not cut off with an ellipsis');
  assert.doesNotMatch(title, /white-space:\s*nowrap/, '.row-title may wrap');
  assert.doesNotMatch(rule('.row'), /(?:^|[\s;])height:\s*\d/, 'rows grow with their name (min-height, not height)');
});

test('library names are bidi-isolated, so a right-to-left override in a name cannot reorder the text after it', async () => {
  // Security review, 2026-10-06: in the "Duplicate names" list the name sits inline before "2 copies"; a name holding
  // U+202E could visually reorder that text. Each element that holds a library name gets unicode-bidi: isolate.
  const css = readFileSync(new URL('../site/assets/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const isolated = new Set();
  for (const m of css.matchAll(/(?:^|\n|\})\s*([^{}@]+)\{([^}]*)\}/g)) {
    if (/unicode-bidi:\s*isolate/.test(m[2])) for (const sel of m[1].split(',')) isolated.add(sel.trim());
  }
  for (const sel of ['.row-title', '.also-name', '.nc-names li']) assert.ok(isolated.has(sel), `app.css isolates ${sel}`);
  const { dom, els } = await drawPreview(previewWithLeftOut({ duplicates: [{ kind: 'waypoint', name: 'Fuel\u202E', copies: 2, listIds: ['lc'] }] }));
  try {
    const names = els.also.querySelectorAll('.also-name');
    assert.equal(names.length, 1, 'the duplicated name has its own isolated element');
    assert.equal(names[0].textContent, 'Fuel\u202E');
  } finally {
    dom.restore();
  }
});

/** The download panel's elements on the fake DOM, the same as view-app.js passes them. */
function unlockEls(doc) {
  const names = ['presale', 'steps', 'price', 'buyLink', 'buyNote', 'privacy', 'keyForm', 'keyInput', 'unlockBtn', 'message', 'saved', 'forget',
    'options', 'optKml', 'optPerItem', 'downloadBtn', 'exportProgress', 'exportPhase', 'exportBar', 'cancelExport', 'exportError', 'exportErrorText',
    'buyStep', 'keyLabel', 'keyRow', 'savedText', 'downloadHint'];
  const els = /** @type {any} */ (Object.fromEntries(names.map((n) => [n, doc.createElement(n === 'buyLink' ? 'a' : n.endsWith('Btn') || n === 'cancelExport' || n === 'forget' ? 'button' : 'div')])));
  els.exportBar.appendChild(Object.assign(doc.createElement('span'), { className: 'progress-fill' }));
  els.keyForm.appendChild(els.keyInput);
  els.keyForm.appendChild(els.unlockBtn);
  return els;
}

/** @param {any} [licence] @param {any} [extra] */
function unlockState(licence = {}, extra = {}) {
  return /** @type {any} */ ({
    view: 'preview', busy: null, phase: 'exporting', done: 0, total: null, exportError: null, options: { kml: true, perItem: false },
    licence: { status: 'none', message: '', hasStored: false, ...licence }, ...extra,
  });
}

const SALE = { onSale: true, price: '$19', checkoutUrl: 'https://checkout.example.invalid/x', provider: 'Polar' };

test('once unlocked, the panel stops asking to buy and to paste a key, and keyboard focus moves on to Download', async () => {
  const dom = withDom();
  try {
    const { createUnlock } = await import('../src/app/view-unlock.js');
    const els = unlockEls(dom.doc);
    const noop = () => {};
    const view = createUnlock(els, SALE, { verify: noop, forget: noop, setOptions: noop, download: noop, cancel: noop });
    view.update(unlockState());
    assert.equal(els.buyStep.hidden, false);
    assert.equal(els.keyRow.hidden, false);
    els.keyInput.focus();
    view.update(unlockState({ status: 'checking' }));
    assert.equal(els.keyInput.disabled, false, 'a disabled field drops keyboard focus to the page; it is made read-only instead');
    assert.equal(els.keyInput.readOnly, true);
    assert.equal(dom.doc.activeElement, els.keyInput, 'focus stays in the field while the key is checked');
    view.update(unlockState({ status: 'valid', message: 'Thank you.', hasStored: true }));
    assert.equal(els.buyStep.hidden, true, 'before: "Buy a license" stayed after the key was accepted');
    assert.equal(els.keyRow.hidden, true, 'before: an empty key field stayed after a saved key unlocked the page');
    assert.equal(els.keyLabel.hidden, true);
    assert.equal(els.message.textContent, 'Thank you.');
    assert.equal(dom.doc.activeElement, els.downloadBtn, 'the field it was in is gone: focus moves to Download');
    assert.doesNotMatch(els.savedText.textContent, /A license key is saved in this browser/, 'not "saved" twice in two lines');
    // Removing the key brings the field back.
    view.update(unlockState({ status: 'none', hasStored: false }));
    assert.equal(els.buyStep.hidden, false);
    assert.equal(els.keyRow.hidden, false);
  } finally {
    dom.restore();
  }
});

test('starting and stopping an export keeps keyboard focus on a visible control, and a locked Download says why', async () => {
  const dom = withDom();
  try {
    const { createUnlock } = await import('../src/app/view-unlock.js');
    const els = unlockEls(dom.doc);
    const noop = () => {};
    const view = createUnlock(els, SALE, { verify: noop, forget: noop, setOptions: noop, download: noop, cancel: noop });
    view.update(unlockState());
    assert.equal(els.downloadBtn.disabled, true);
    assert.equal(els.downloadHint.hidden, false, 'a disabled Download button says what unlocks it');
    assert.match(els.downloadHint.textContent, /license key/);
    const valid = { status: 'valid', message: 'Thank you.', hasStored: true };
    view.update(unlockState(valid));
    assert.equal(els.downloadHint.hidden, true);
    els.downloadBtn.focus();
    view.update(unlockState(valid, { busy: 'export' }));
    assert.equal(els.downloadBtn.hidden, true);
    assert.equal(dom.doc.activeElement, els.cancelExport, 'before: the focused Download button vanished and focus fell to the page');
    view.update(unlockState(valid, { exportError: 'Download canceled.' }));
    assert.equal(dom.doc.activeElement, els.downloadBtn, 'back on Download when the export stops');
  } finally {
    dom.restore();
  }
});

test('the done view says where the files are for the options chosen, not always "one file per list"', () => {
  assert.equal(typeof UI.nextSteps, 'function', 'ui.js exports nextSteps');
  const words = (/** @type {any} */ o, /** @type {boolean} */ flat) => UI.nextSteps(o, flat).join(' ');
  const lists = words({ kml: true, perItem: false }, false);
  assert.match(lists, /one GPX file for each list/);
  assert.match(lists, /All items\.gpx/);
  assert.match(lists, /KML folder/);
  const perItem = words({ kml: true, perItem: true }, false);
  assert.doesNotMatch(perItem, /one GPX file for each list/, 'with "One GPX file per item" there is a folder per list');
  assert.match(perItem, /a folder for each list/);
  const flat = words({ kml: false, perItem: false }, true);
  assert.match(flat, /grouped by type/);
  assert.doesNotMatch(flat, /in your folders|KML/);
  const html = readFileSync(new URL('../site/app/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /holds one file per\s+list, in your folders/, 'the static sentence is gone (it was false for the other options)');
  assert.match(html, /id="next-steps"/);
});

test('the app page: checkbox names are just their titles, focusable reports have names, the error view says what to check', () => {
  const html = readFileSync(new URL('../site/app/index.html', import.meta.url), 'utf8');
  for (const id of ['opt-kml', 'opt-per-item']) {
    const input = new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? '';
    assert.match(input, /aria-describedby="[^"]+"/, `${id} has its description as a description, not as part of its name`);
    const label = new RegExp(`<label[^>]*for="${id}"[^>]*>([\\s\\S]*?)</label>`).exec(html)?.[1] ?? '';
    assert.ok(label !== '', `${id} has a label`);
    assert.doesNotMatch(label, /check-sub/, `${id}: the description is outside the label`);
  }
  for (const id of ['report-text', 'dump-text']) {
    const pre = new RegExp(`<pre[^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? '';
    assert.match(pre, /aria-labelledby="[^"]+"/, `#${id} can take focus, so it needs a name`);
  }
  const errorView = /<section class="view" id="view-error"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
  assert.match(errorView, /version number/, 'the error view says what a library looks like, so the user knows what to check');
});

test('a converter that stops while reading does not point at a diagnostic report that is not on the page', async () => {
  const { controller, workers } = makeController({});
  await controller.open([]);
  workers.made[0].fail('error');
  assert.equal(controller.state.view, 'error');
  assert.equal(controller.state.dump, null, 'nothing was read, so there is no diagnostic report to show');
  // Before: "…the diagnostic report below helps find out why", under which nothing was shown.
  assert.doesNotMatch(String(controller.state.error), /diagnostic report below/);
});

test('the "Saved outside your lists" headings read as words, with a space before the count', async () => {
  const { dom, els } = await drawPreview(samplePreview({ ambiguousCount: 2, duplicates: [{ kind: 'waypoint', name: 'Fuel', copies: 2, listIds: [] }] }));
  try {
    const titles = els.also.querySelectorAll('.also-title').map((/** @type {any} */ t) => t.textContent);
    // Before: "Not in any list1 waypoint" (the gap was only a CSS margin, so a screen reader ran the words together).
    assert.deepEqual(titles, ['Not in any list 1 waypoint', 'Duplicate names 2 items']);
    assert.equal(els.also.querySelectorAll('.also-title')[0].tagName, 'H3');
  } finally {
    dom.restore();
  }
});
