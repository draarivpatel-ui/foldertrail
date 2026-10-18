// Security and privacy checks across modules (audit of 2026-10-06). Synthetic data only.
//
//   1. A library whose names are hostile (markup, "..", absolute and Windows paths, device names, bidi controls,
//      line breaks, very long names) goes through the real worker pipeline in Node: the export must not fail, every
//      ZIP path must stay inside the archive and be a safe name, report.html must hold only its own tags, the KML
//      balloon text (<description>) must hold no markup but <br>, and every GPX and KML must be well-formed XML.
//   2. tools/build.js: CSS that loads from another host in ways the old check missed, and a build without _headers.
//   3. tools/serve.js: a redirect must never point at another host.
//   4. Opt-in (BCR_SECURITY_BROWSER=1): headless Chrome loads every page of a fresh build
//      under the real _headers policy and collects CSP violations, console errors and requests to other origins;
//      hands the hostile library to the converter; checks the preview drew names as text; unlocks (licence answered
//      by interception), downloads, and opens report.html from disk to prove its own CSP holds there.
//        env BCR_SECURITY_BROWSER=1 node --test test/security.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { buildScenario } from '../tools/fixtures/scenarios.js';
import { Pipeline } from '../src/app/pipeline.js';
import { build, checkCss, checkHeadersFile, BuildError } from '../tools/build.js';
import { startServer } from '../tools/serve.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const T0 = Date.UTC(2026, 0, 10, 8, 0, 0);
const XMLLINT = '/usr/bin/xmllint';

// ---------------------------------------------------------------------------------------------
// The hostile library (made up; every name is an attack string, never anyone's data)

/** Waypoint names. */
const HOSTILE_ITEMS = [
  '../../../../tmp/evil', '<script>alert(1)</script>', '"><svg/onload=alert(1)>', ']]><x>', '&amp;', 'R\u202egpx.exe',
  'Tab\there', 'C:\\x', '/etc/passwd', '..', '.', '<img src=x onerror=alert(1)>', 'javascript:alert(1)', 'CON',
];
/** Folder and list names. */
const HOSTILE_LISTS = [
  '..', '.', '../../etc', '..\\..\\Windows', 'C:\\Windows', '/abs', '~', '%2e%2e%2f', 'CON', 'a/b', ' .hidden ',
  '<img src=x onerror=alert(1)>', 'R\u202eTL', 'Line\nBreak', 'x'.repeat(300), '\u00e9'.repeat(100), 'NUL.gpx', 'COM1',
  'Folder:Stream', '</li><script>alert(1)</script>', '"><svg/onload=alert(1)>',
];
const HOSTILE_COMMENT = '<b>bold</b><script>alert(1)</script><img src=x onerror=alert(1)>\nline 2 & "quoted" \'single\'';

export function hostileScenario() {
  const wpt = (/** @type {string} */ id, /** @type {string} */ name, /** @type {number} */ i, extra = {}) => ({
    kind: 'waypoint', id, name, comment: '', lat: 46 + i / 100, lon: 8 + i / 100, ele: null, time: null, ...extra,
  });
  /** @type {any[]} */
  const items = HOSTILE_ITEMS.map((name, i) => wpt(`w${i}`, name, i, i < 3 ? { comment: HOSTILE_COMMENT } : {}));
  items.push(wpt('d1', '../dup', 30), wpt('d2', '../dup', 31));
  items.push({
    kind: 'track', id: 't1', name: '</trk><trk><name>x',
    segments: [[{ lat: 46, lon: 8, ele: 500, time: T0 }, { lat: 46.01, lon: 8.01, ele: 510, time: T0 + 60_000 }]],
  });
  // Routes: one whose via point cannot be found (so the report names it and its list), one converted with hostile
  // via-point names (they go into <rtept><name> and the KML).
  items.push({
    kind: 'route', id: 'r1', name: '<script>alert(1)</script>', gdb: { via: [{}, { byName: true }] },
    points: [{ name: '<img src=x onerror=alert(1)>', lat: 46.4, lon: 9.6 }, { name: 'Nowhere</li><li>', lat: 0, lon: 0 }],
  });
  items.push({
    kind: 'route', id: 'r2', name: 'R\u202eroute',
    points: [{ name: '"><svg/onload=alert(1)>', lat: 46.46, lon: 9.66 }, { name: ']]>&lt;', lat: 46.461, lon: 9.667 }],
  });
  /** @type {any[]} */
  const folders = [
    { id: 'f1', name: '..', type: 'folder', parentId: null, itemIds: [] },
    { id: 'f2', name: '../../etc', type: 'folder', parentId: 'f1', itemIds: [] },
  ];
  HOSTILE_LISTS.forEach((name, i) => {
    const parentId = i % 3 === 0 ? 'f2' : i % 3 === 1 ? 'f1' : null;
    const itemIds = [`w${i % HOSTILE_ITEMS.length}`, ...(i === 1 ? ['d1', 'd2', 't1'] : []), ...(i === 11 ? ['r1', 'r2'] : [])];
    folders.push({ id: `l${i}`, name, type: 'list', parentId, itemIds });
  });
  return { name: 'security-hostile-names', title: 'Hostile names', covers: [], supportedPath: true, library: { seed: 77, items, folders } };
}

/** A WorkerSource (intake.js toWorkerSource shape) over in-memory files. */
function workerSource(/** @type {Map<string, Uint8Array>} */ files) {
  const ref = (/** @type {string} */ name, /** @type {Uint8Array} */ bytes) => ({
    name, path: name, size: bytes.length, lastModified: null, blob: new Blob([bytes]), index: null, entryName: null,
  });
  const get = (/** @type {string} */ name) => (files.has(name) ? ref(name, /** @type {Uint8Array} */ (files.get(name))) : null);
  return {
    kind: 'files', archive: null, allData: get('AllData.gdb'), folderData: get('FolderData.gfi'),
    trackSegments: [...files].filter(([p]) => p.startsWith('TrackSegments/')).map(([p, b]) => [p.slice(14), ref(p.slice(14), b)]),
    versionFolder: 'Database/4.8', version: '4.8',
  };
}

/**
 * Reads every entry of a ZIP (no ZIP64), independent of src/: central and local names, flags and bytes.
 * @param {Uint8Array} bytes
 */
function readZip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.length - 22;
  while (eocd >= 0 && v.getUint32(eocd, true) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, 'end of central directory');
  const count = v.getUint16(eocd + 10, true);
  let at = v.getUint32(eocd + 16, true);
  const raw = new TextDecoder('utf-8', { fatal: true });
  /** @type {{name: string, localName: string, flags: number, data: Uint8Array}[]} */
  const out = [];
  for (let k = 0; k < count; k++) {
    assert.equal(v.getUint32(at, true), 0x02014b50);
    const flags = v.getUint16(at + 8, true);
    const method = v.getUint16(at + 10, true);
    const csize = v.getUint32(at + 20, true);
    const nameLength = v.getUint16(at + 28, true);
    const extra = v.getUint16(at + 30, true);
    const comment = v.getUint16(at + 32, true);
    const local = v.getUint32(at + 42, true);
    const name = raw.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    assert.equal(v.getUint32(local, true), 0x04034b50);
    const ln = v.getUint16(local + 26, true);
    const le = v.getUint16(local + 28, true);
    const localName = raw.decode(bytes.subarray(local + 30, local + 30 + ln));
    const start = local + 30 + ln + le;
    const packed = bytes.subarray(start, start + csize);
    const data = method === 8 ? new Uint8Array(inflateRawSync(packed)) : packed;
    out.push({ name, localName, flags, data });
    at += 46 + nameLength + extra + comment;
  }
  return out;
}

/** Runs parse and export through the real worker pipeline. */
async function exportHostile(/** @type {{kml?: boolean, perItem?: boolean}} */ options) {
  const { built } = buildScenario(hostileScenario());
  /** @type {any[]} */
  const out = [];
  const pipeline = new Pipeline({ brand: 'Foldertrail', version: '0.1.0', now: () => T0, post: (m) => out.push(m) });
  await pipeline.handle({ type: 'parse', id: 1, source: workerSource(built.files) });
  const parsed = out.find((m) => m.type === 'parsed');
  assert.ok(parsed, `parsed: ${JSON.stringify(out.filter((m) => m.type === 'error'))}`);
  await pipeline.handle({ type: 'export', id: 1, options });
  const exported = out.find((m) => m.type === 'exported');
  assert.ok(exported, `the export must not fail on hostile names: ${JSON.stringify(out.filter((m) => m.type === 'error'))}`);
  return { parsed, exported, entries: readZip(new Uint8Array(await exported.zip.arrayBuffer())) };
}

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i;

/** Every way a ZIP path could escape the folder it is unpacked into, or fail to unpack on macOS or Windows. */
function pathProblems(/** @type {string} */ path) {
  const problems = [];
  if (path.startsWith('/') || path.startsWith('\\')) problems.push('absolute');
  if (/^[a-zA-Z]:/.test(path)) problems.push('drive letter');
  if (path.includes('\\')) problems.push('backslash');
  if (/[\u0000-\u001f\u007f-\u009f]/.test(path)) problems.push('control character');
  if (/[\u202a-\u202e\u2066-\u2069]/.test(path)) problems.push('bidi control');
  if (path.normalize('NFC') !== path) problems.push('not NFC');
  const body = path.endsWith('/') ? path.slice(0, -1) : path;
  for (const segment of body.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') problems.push(`segment "${segment}"`);
    if (/[:*?"<>|]/.test(segment)) problems.push(`Windows-forbidden character in "${segment}"`);
    if (/^[\s.]|[\s.]$/.test(segment)) problems.push(`leading or trailing dot or space in "${segment}"`);
    if (WINDOWS_DEVICE.test(segment.split('.')[0].trimEnd())) problems.push(`Windows device name "${segment}"`);
    if (Buffer.byteLength(segment, 'utf8') > 255) problems.push('segment longer than 255 bytes');
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// 1. Hostile names through the real pipeline

for (const perItem of [false, true]) {
  test(`hostile names (${perItem ? 'one GPX per item' : 'one GPX per list'}): every ZIP path is a safe name inside the archive`, async () => {
    const { entries } = await exportHostile({ kml: true, perItem });
    assert.ok(entries.length > 20, `a real export (${entries.length} entries)`);
    for (const e of entries) {
      assert.deepEqual(pathProblems(e.name), [], JSON.stringify(e.name));
      assert.equal(e.localName, e.name, 'the local header names the same path as the central directory');
      if (/[^\x20-\x7e]/.test(e.name)) assert.ok(e.flags & 0x800, `UTF-8 flag on ${JSON.stringify(e.name)}`);
    }
    const tops = new Set(entries.map((e) => e.name.split('/')[0]));
    for (const top of tops) assert.ok(['GPX', 'KML', 'READ-ME-FIRST.txt', 'report.txt', 'report.html'].includes(top), top);
    const names = new Set(entries.map((e) => e.name.normalize('NFC').toLowerCase()));
    assert.equal(names.size, entries.length, 'no two entries that a case-insensitive Mac would merge');
  });
}

test('hostile names: report.html is only its own markup, with its CSP; every GPX and KML is well-formed', async (t) => {
  const { entries, exported } = await exportHostile({ kml: true, perItem: false });
  const file = (/** @type {string} */ n) => new TextDecoder().decode(entries.find((e) => e.name === n)?.data);
  const html = file('report.html');
  assert.equal(html, exported.report.html, 'the report in the ZIP is the one the page shows');
  const tags = new Set([...html.matchAll(/<\/?([a-zA-Z][\w-]*)/g)].map((m) => m[1].toLowerCase()));
  assert.deepEqual([...tags].sort(), ['body', 'h1', 'h2', 'head', 'html', 'li', 'meta', 'p', 'section', 'style', 'title', 'ul']);
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'sha256-/);
  assert.ok(html.includes('Route &quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot;: one or more of its via points'), 'the hostile route name is shown, as text');
  assert.ok(html.includes('In: My Collection / &lt;img src=x onerror=alert(1)&gt;.'), 'and its hostile list name');
  const text = file('report.txt');
  assert.doesNotMatch(text, /[\u202a-\u202e\u2066-\u2069\t]/);

  // KML: Google Earth renders <description> as HTML, so after XML decoding it may hold no markup but <br>.
  const kml = file(entries.find((e) => e.name.startsWith('KML/'))?.name ?? '');
  const descriptions = [...kml.matchAll(/<description>([\s\S]*?)<\/description>/g)].map((m) => xmlDecode(m[1]));
  assert.ok(descriptions.length >= 3, 'the hostile comments are in the KML');
  for (const d of descriptions) assert.deepEqual(d.match(/<[^>]*>/g)?.filter((tag) => tag !== '<br>') ?? [], [], d);
  assert.ok(descriptions.some((d) => d.includes('&lt;script&gt;alert(1)&lt;/script&gt;')), 'shown as text in the balloon');

  if (!existsSync(XMLLINT)) {
    t.diagnostic('xmllint not found: well-formedness not checked');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'ft-sec-xml-'));
  try {
    let n = 0;
    for (const e of entries) {
      if (!/\.(gpx|kml)$/.test(e.name)) continue;
      const p = join(dir, `${n++}.xml`);
      await writeFile(p, e.data);
      execFileSync(XMLLINT, ['--noout', '--nonet', p], { stdio: 'pipe' });
    }
    assert.ok(n > 10, `${n} XML files checked`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('hostile names: the structure dump names nothing, and the preview carries names as data only', async () => {
  const { parsed } = await exportHostile({ kml: false, perItem: false });
  const dump = parsed.dump.text + parsed.dump.json;
  for (const name of [...HOSTILE_ITEMS, ...HOSTILE_LISTS, 'alert(1)', 'onerror', 'evil', 'Windows', 'passwd']) {
    if (name.length < 3) continue; // ".", "..", "~": too short to be meaningful in free text
    assert.ok(!dump.includes(name), `the dump leaks ${JSON.stringify(name)}`);
  }
  // The preview is plain data (the page draws it with textContent): no field is pre-rendered HTML.
  const json = JSON.stringify(parsed.preview);
  assert.ok(json.includes('<script>alert(1)</script>'), 'names arrive unchanged, to be drawn as text');
  assert.doesNotMatch(json, /&lt;|&amp;lt;/, 'nothing is HTML-escaped in advance (that would show "&lt;" on the page)');
});

/** @param {string} s */
function xmlDecode(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------------------------
// 2. tools/build.js

test('build: CSS that loads from another host without a space after @import, through image-set() or escapes is refused', () => {
  const cases = [
    '@import"https://fonts.example.test/a.css";',
    "@import'//fonts.example.test/b.css';",
    '.a { background: image-set("https://cdn.example.test/a.png" 1x) }',
    ".b { background: -webkit-image-set('//cdn.example.test/b.png' 1x) }",
    '.c { background: url(h\\74tps://cdn.example.test/c.png) }',
    '.d { background: url("\\68 ttps://cdn.example.test/d.png") }',
    '@\\69mport url(https://fonts.example.test/e.css);',
  ];
  for (const css of cases) assert.ok(checkCss(css).problems.length > 0, css);
  const ok = checkCss('.e { content: "see https://example.test"; background: image-set("/assets/f.png" 1x) } .f { content: "\\2014" }');
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.localRefs, ['/assets/f.png'], 'a local image-set() file must exist in the build');
});

/** A throwaway repository to build. */
async function buildFixture(/** @type {string|null} */ headers) {
  const root = await mkdtemp(join(tmpdir(), 'ft-sec-build-'));
  await mkdir(join(root, 'site/app'), { recursive: true });
  await mkdir(join(root, 'src/app'), { recursive: true });
  await writeFile(join(root, 'site/app/index.html'), '<!doctype html><title>x</title><script type="module" src="../js/app/main.js"></script>');
  await writeFile(join(root, 'src/app/main.js'), 'export {};\n');
  if (headers !== null) await writeFile(join(root, 'site/_headers'), headers);
  return root;
}

test('build: a site without _headers is refused (the host would send no CSP at all)', async () => {
  const root = await buildFixture(null);
  try {
    await assert.rejects(build({ root }), (error) => error instanceof BuildError && /_headers is missing/.test(error.message));
    assert.ok(!existsSync(join(root, 'dist')), 'nothing is left behind');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('build: with requireCsp, the rule for every path must set a strict CSP; this repository requires it by default', async () => {
  assert.deepEqual(checkHeadersFile(await readFile(join(ROOT, 'site/_headers'), 'utf8'), true), [], 'the real site/_headers passes');
  const weak = [
    '/*\n  X-Frame-Options: DENY\n',
    "/app/*\n  Content-Security-Policy: default-src 'none'; script-src 'self'\n",
    "/*\n  Content-Security-Policy: default-src 'self'; script-src 'self'\n",
    "/*\n  Content-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-inline'\n",
    "/*\n  Content-Security-Policy: default-src 'none'; script-src *\n",
    "/*\n  Content-Security-Policy: default-src 'none'; script-src 'self'\n  Content-Security-Policy: img-src *\n",
  ];
  for (const text of weak) assert.ok(checkHeadersFile(text, true).length > 0, text);
  const root = await buildFixture('/*\n  X-Test: yes\n');
  try {
    await assert.rejects(build({ root, requireCsp: true }), /Content-Security-Policy/);
    const built = await build({ root }); // another folder (a test fixture): presence is enough
    assert.ok(built.files.includes('_headers'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const out = await mkdtemp(join(tmpdir(), 'ft-sec-dist-'));
  try {
    const real = await build({ outDir: join(out, 'dist') });
    assert.ok(real.files.includes('_headers'), "this repository's site builds with its strict policy");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// 3. tools/serve.js

test('serve: a folder redirect never points at another host ("/%2Fapp" must not become "//app/")', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ft-sec-serve-'));
  await mkdir(join(root, 'app'), { recursive: true });
  await writeFile(join(root, 'app/index.html'), '<!doctype html><title>x</title>');
  const server = await startServer({ root, headersFile: null });
  try {
    for (const path of ['/app', '/%2Fapp', '/%2F%2Fapp', '/%5Capp', '/%2F%5Capp']) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { redirect: 'manual' });
      await res.arrayBuffer();
      if (res.status !== 301) continue;
      const location = res.headers.get('location') ?? '';
      assert.match(location, /^\/(?![/\\])/, `${path} -> ${location}`);
      assert.equal(new URL(location, 'http://127.0.0.1/').host, '127.0.0.1', `${path} -> ${location}`);
    }
    const plain = await fetch(`http://127.0.0.1:${server.port}/app`, { redirect: 'manual' });
    assert.equal(plain.headers.get('location'), '/app/');
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// 4. Real browser (opt-in)

const BROWSER = process.env.BCR_SECURITY_BROWSER === '1';

test('browser: every page under the real CSP, the hostile library in the converter, report.html from disk', { skip: !BROWSER && 'set BCR_SECURITY_BROWSER=1 ', timeout: 600_000 }, async (t) => {
  const result = await browserAudit({ scenario: hostileScenario(), log: (/** @type {string} */ s) => t.diagnostic(s) });
  assert.deepEqual(result.problems, [], result.problems.join('\n'));
});

/**
 * The browser audit itself. Development only; uses the e2e harness's Chrome launcher and test build.
 * @param {{scenario: any, log: (line: string) => void}} args
 */
async function browserAudit({ scenario, log }) {
  const { launchChrome, sleep } = await import('../tools/e2e/cdp.js');
  const { buildTestSite, POLAR_URL, TEST_ORG, TEST_KEY } = await import('../tools/e2e/run.js');
  const { buildBackup } = await import('../tools/fixtures/backup.js');
  /** @type {string[]} */
  const problems = [];
  const work = await mkdtemp(join(tmpdir(), 'ft-sec-browser-'));
  const dist = await buildTestSite(work);
  const { built } = buildScenario(scenario);
  const libDir = join(work, 'library', 'Database', built.databaseVersion);
  for (const [rel, bytes] of built.files) {
    await mkdir(dirname(join(libDir, rel)), { recursive: true });
    await writeFile(join(libDir, rel), bytes);
  }
  await writeFile(join(work, 'hostile.Backup'), await buildBackup(built));
  const server = await startServer({ root: dist });
  const origin = `http://127.0.0.1:${server.port}`;
  const chrome = await launchChrome(work);
  const { cdp } = chrome;
  try {
    // ---- one page context per check, with every listener the e2e harness uses
    const open = async (/** @type {string} */ label) => {
      const downloadDir = join(work, 'downloads', label.replace(/\W+/g, '_'));
      await mkdir(downloadDir, { recursive: true });
      const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloadDir, eventsEnabled: true, browserContextId });
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      const sessions = new Set([sessionId]);
      const seen = {
        csp: /** @type {string[]} */ ([]), errors: /** @type {string[]} */ ([]), foreign: /** @type {string[]} */ ([]),
        blocked: /** @type {string[]} */ ([]), licence: /** @type {string[]} */ ([]),
      };
      /** @type {Map<string, string>} requests to another origin, by session and request id */
      const pending = new Map();
      /** @type {{guid: string, state: string, filePath?: string}|null} */
      let download = null;
      const off = cdp.on(async (/** @type {any} */ msg) => {
        if (msg.method === 'Browser.downloadWillBegin' && !msg.sessionId) download = { guid: msg.params.guid, state: 'started' };
        if (msg.method === 'Browser.downloadProgress' && !msg.sessionId && download && msg.params.guid === download.guid) {
          download.state = msg.params.state;
          if (msg.params.filePath) download.filePath = msg.params.filePath;
        }
        if (!msg.sessionId || !sessions.has(msg.sessionId)) return;
        const where = msg.sessionId === sessionId ? 'page' : 'worker';
        const p = msg.params ?? {};
        switch (msg.method) {
          case 'Target.attachedToTarget': {
            sessions.add(p.sessionId);
            const s = (/** @type {string} */ m) => cdp.send(m, {}, p.sessionId).catch(() => {});
            await Promise.all([s('Runtime.enable'), s('Log.enable'), s('Network.enable'), s('Audits.enable')]);
            await s('Runtime.runIfWaitingForDebugger');
            break;
          }
          case 'Runtime.exceptionThrown':
            seen.errors.push(`${label} ${where} exception: ${String(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text).slice(0, 300)}`);
            break;
          case 'Runtime.consoleAPICalled':
            if (p.type === 'error') seen.errors.push(`${label} ${where} console.error: ${(p.args ?? []).map((/** @type {any} */ a) => a.value ?? a.description).join(' ').slice(0, 300)}`);
            break;
          case 'Log.entryAdded': {
            const e = p.entry ?? {};
            if (e.source === 'security' || /Content Security Policy/i.test(String(e.text))) seen.csp.push(`${label} ${where} log: ${String(e.text).slice(0, 300)}`);
            else if (e.level === 'error') seen.errors.push(`${label} ${where} log: ${String(e.text).slice(0, 300)}`);
            break;
          }
          case 'Audits.issueAdded':
            if (p.issue?.code === 'ContentSecurityPolicyIssue') {
              const d = p.issue.details?.contentSecurityPolicyIssueDetails ?? {};
              seen.csp.push(`${label} ${where} issue: ${d.violatedDirective} blocked ${d.blockedURL ?? d.contentSecurityPolicyViolationType}`);
            }
            break;
          case 'Runtime.bindingCalled':
            if (p.name === '__secCsp') seen.csp.push(`${label} ${where} event: ${String(p.payload).slice(0, 300)}`);
            break;
          case 'Network.requestWillBeSent': {
            const url = String(p.request?.url ?? '');
            if (url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('file:') || url.startsWith(origin) || url === POLAR_URL) break;
            pending.set(`${msg.sessionId}:${p.requestId}`, `${label} ${where} ${p.request?.method} ${url.slice(0, 200)}`);
            seen.foreign.push(/** @type {string} */ (pending.get(`${msg.sessionId}:${p.requestId}`)));
            break;
          }
          case 'Network.loadingFailed': {
            // Chrome announces a request the CSP then refuses; it never reaches the network. Count it as blocked.
            const key = `${msg.sessionId}:${p.requestId}`;
            const line = pending.get(key);
            if (line && p.blockedReason === 'csp') {
              seen.foreign.splice(seen.foreign.indexOf(line), 1);
              seen.blocked.push(line);
            }
            break;
          }
          case 'Fetch.requestPaused': {
            const req = p.request ?? {};
            const send = (/** @type {string} */ m, /** @type {object} */ q) => cdp.send(m, q, msg.sessionId).catch(() => {});
            const cors = [
              { name: 'Access-Control-Allow-Origin', value: '*' },
              { name: 'Access-Control-Allow-Methods', value: 'POST' },
              { name: 'Access-Control-Allow-Headers', value: 'content-type, accept' },
            ];
            if (req.url !== POLAR_URL) {
              seen.foreign.push(`${label} ${where} intercepted ${req.method} ${String(req.url).slice(0, 200)}`);
              await send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' });
              break;
            }
            if (req.method === 'OPTIONS') {
              await send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 204, responseHeaders: cors });
              break;
            }
            let body = req.postData;
            if (body === undefined && req.hasPostData) body = (await cdp.send('Fetch.getRequestPostData', { requestId: p.requestId }, msg.sessionId).catch(() => ({}))).postData;
            seen.licence.push(JSON.stringify({ body: body ?? null, referer: req.headers?.Referer ?? req.headers?.referer ?? null, cookie: req.headers?.Cookie ?? null }));
            const json = { id: 'sec', status: 'granted', organization_id: TEST_ORG, expires_at: null, key: '(made up)' };
            await send('Fetch.fulfillRequest', {
              requestId: p.requestId, responseCode: 200,
              responseHeaders: [...cors, { name: 'Content-Type', value: 'application/json' }],
              body: Buffer.from(JSON.stringify(json)).toString('base64'),
            });
            break;
          }
          default:
        }
      });
      const send = (/** @type {string} */ method, params = {}) => cdp.send(method, params, sessionId);
      await Promise.all(['Runtime.enable', 'Log.enable', 'Page.enable', 'DOM.enable', 'Network.enable', 'Audits.enable'].map((m) => send(m)));
      // Every https request is paused: the licence check gets a canned answer, anything else is failed and recorded.
      // (Chrome also cannot resolve any host but 127.0.0.1: tools/e2e/cdp.js.)
      await send('Fetch.enable', { patterns: [{ urlPattern: 'https://*', requestStage: 'Request' }] });
      await send('Runtime.addBinding', { name: '__secCsp' });
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: "document.addEventListener('securitypolicyviolation', (e) => { try { __secCsp(JSON.stringify({ d: e.violatedDirective, b: e.blockedURI, s: e.sourceFile, l: e.lineNumber })); } catch {} }, true);",
      });
      await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      const evaluate = async (/** @type {string} */ expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(`evaluate failed: ${expression.slice(0, 80)} ${JSON.stringify(r.exceptionDetails).slice(0, 200)}`);
        return r.result.value;
      };
      const waitFor = async (/** @type {string} */ expression, timeout = 90_000) => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
          if (await evaluate(expression).catch(() => false)) return true;
          await sleep(150);
        }
        return false;
      };
      const close = async () => {
        off();
        await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
        await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
      };
      return { send, evaluate, waitFor, seen, close, downloadDir, getDownload: () => download };
    };
    const settle = async (/** @type {any} */ page, ms = 800) => {
      await page.waitFor("document.readyState === 'complete'", 30_000);
      await sleep(ms);
    };

    // ---- (a) every page of the site under the real _headers policy
    const pages = ['/', '/app/', '/guide/', '/faq/', '/privacy/', '/404.html'];
    for (const path of pages) {
      const page = await open(`page ${path}`);
      await page.send('Page.navigate', { url: `${origin}${path}` });
      await settle(page, path === '/app/' ? 2000 : 800);
      const facts = await page.evaluate(`({
        scripts: [...document.scripts].map((s) => s.src ? new URL(s.src).origin : 'inline'),
        sheets: [...document.styleSheets].map((s) => s.href ? new URL(s.href).origin : 'inline'),
        styled: getComputedStyle(document.body).fontFamily !== '' && document.styleSheets.length > 0,
      })`);
      for (const o of [...facts.scripts, ...facts.sheets]) if (o !== origin) problems.push(`${path}: a script or stylesheet from ${o}`);
      if (!facts.styled) problems.push(`${path}: no stylesheet applied (blocked?)`);
      problems.push(...page.seen.csp, ...page.seen.errors, ...page.seen.foreign);
      log(`${path}: ${facts.scripts.length} scripts, ${facts.sheets.length} sheets, ${page.seen.csp.length} CSP, ${page.seen.errors.length} errors`);
      await page.close();
    }

    // ---- (b) the converter with the hostile library, unlock, download
    const app = await open('converter');
    await app.send('Page.navigate', { url: `${origin}/app/` });
    if (!(await app.waitFor("document.readyState === 'complete' && !document.getElementById('view-open').hidden"))) problems.push('converter: the open view never appeared');
    const { root } = await app.send('DOM.getDocument', { depth: 1 });
    const { nodeId } = await app.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#folder-input' });
    await app.send('DOM.setFileInputFiles', { nodeId, files: [join(work, 'library')] });
    if (!(await app.waitFor("!document.getElementById('view-preview').hidden || !document.getElementById('view-error').hidden"))) {
      problems.push('converter: no preview for the hostile library');
    } else {
      await sleep(500);
      const dom = await app.evaluate(`(() => {
        const view = document.getElementById('view-preview');
        const injected = view.querySelectorAll('script, img, iframe, object, embed, svg, a[href^="javascript" i], [onerror], [onload], [onclick], style, link, meta, base');
        const text = view.textContent;
        const rows = [...document.querySelectorAll('#tree [role=treeitem] .row-title')].map((e) => e.textContent);
        return { injected: [...injected].map((e) => e.outerHTML.slice(0, 120)), text, rows, xss: typeof window.__xss };
      })()`);
      if (dom.injected.length > 0) problems.push(`converter: elements came from names: ${dom.injected.join(' | ')}`);
      for (const name of ['<img src=x onerror=alert(1)>', '</li><script>alert(1)</script>', '"><svg/onload=alert(1)>']) {
        if (!dom.rows.includes(name)) problems.push(`converter: the list ${JSON.stringify(name)} is not drawn as its own text`);
      }
      log(`converter: ${dom.rows.length} tree rows, ${dom.injected.length} injected elements`);

      // unlock and download
      await app.evaluate(`(() => { const i = document.getElementById('licence-key'); i.value = ${JSON.stringify(TEST_KEY)};
        document.getElementById('key-form').requestSubmit(); })()`);
      const unlocked = await app.waitFor("document.getElementById('licence-message').classList.contains('is-good')", 30_000);
      if (!unlocked) problems.push('converter: the canned licence answer did not unlock');
      for (const raw of app.seen.licence) {
        const r = JSON.parse(raw);
        if (JSON.stringify(Object.keys(JSON.parse(r.body ?? '{}')).sort()) !== JSON.stringify(['key', 'organization_id'])) problems.push(`licence request body: ${r.body}`);
        if (r.referer) problems.push(`licence request sent a Referer: ${r.referer}`);
        if (r.cookie) problems.push('licence request sent a cookie');
      }
      if (app.seen.licence.length !== 1) problems.push(`licence requests: ${app.seen.licence.length}, want 1`);
      await app.evaluate("document.getElementById('download-btn').click()");
      const t0 = Date.now();
      while (Date.now() - t0 < 120_000 && !['completed', 'canceled'].includes(app.getDownload()?.state ?? '')) await sleep(200);
      const download = app.getDownload();
      if (download?.state !== 'completed') problems.push(`converter: the ZIP was not saved (${download?.state ?? 'no download'})`);
      else {
        const zip = readZip(new Uint8Array(await readFile(download.filePath ?? join(app.downloadDir, download.guid))));
        for (const e of zip) for (const p of pathProblems(e.name)) problems.push(`ZIP from the page: ${JSON.stringify(e.name)}: ${p}`);
        const report = zip.find((e) => e.name === 'report.html');
        if (!report) problems.push('ZIP from the page: no report.html');
        else {
          const reportPath = join(work, 'report.html');
          await writeFile(reportPath, report.data);
          // A second copy with planted markup, as if escaping had failed: the report's own CSP must stop all of it.
          const planted = new TextDecoder().decode(report.data).replace(
            '</h1>',
            '</h1><script>window.__ran = 1</script><img id="probe" src="https://probe.example.invalid/p.gif" alt=""><style>body{display:none}</style><p id="mark">mark</p>',
          );
          const plantedPath = join(work, 'report-planted.html');
          await writeFile(plantedPath, planted);
          for (const [label, file] of [['report.html', reportPath], ['report-planted.html', plantedPath]]) {
            const page = await open(label);
            await page.send('Page.navigate', { url: pathToFileURL(file).href });
            await settle(page, 600);
            const facts = await page.evaluate(`({
              scripts: document.scripts.length, images: document.images.length, ran: typeof window.__ran,
              display: getComputedStyle(document.body).display, maxWidth: getComputedStyle(document.body).maxWidth,
              loaded: document.getElementById('probe') ? document.getElementById('probe').complete && document.getElementById('probe').naturalWidth > 0 : null,
            })`);
            if (label === 'report.html') {
              if (facts.scripts !== 0 || facts.images !== 0) problems.push(`report.html: ${facts.scripts} scripts, ${facts.images} images`);
              if (facts.maxWidth !== '736px') problems.push(`report.html: its own style is not applied (max-width ${facts.maxWidth}); the CSP hash may be wrong`);
              problems.push(...page.seen.csp, ...page.seen.errors);
            } else {
              if (facts.ran !== 'undefined') problems.push('report-planted.html: a planted script ran');
              if (facts.display === 'none') problems.push('report-planted.html: a planted <style> applied');
              if (facts.maxWidth !== '736px') problems.push('report-planted.html: the report style stopped working');
              if (facts.loaded) problems.push('report-planted.html: a planted remote image loaded');
              if (page.seen.csp.length < 3) problems.push(`report-planted.html: expected the meta CSP to block the planted script, style and image, saw ${page.seen.csp.length} report(s)`);
              if (page.seen.blocked.length !== 1) problems.push(`report-planted.html: the planted remote image was not refused by the CSP (${page.seen.blocked.length})`);
            }
            problems.push(...page.seen.foreign);
            log(`${label}: ${JSON.stringify(facts)}, ${page.seen.csp.length} CSP reports, ${page.seen.blocked.length} request(s) refused by the CSP`);
            await page.close();
          }
        }
      }
    }
    problems.push(...app.seen.csp, ...app.seen.errors, ...app.seen.foreign);
    await app.close();
  } finally {
    await chrome.close();
    await server.close();
    await rm(work, { recursive: true, force: true });
  }
  return { problems };
}
