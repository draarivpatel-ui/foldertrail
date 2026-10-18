#!/usr/bin/env node
// End-to-end run of the real app page in headless Chrome, over every fixture scenario. Development only.
//
// What it does, per scenario and per way of handing the library over (a folder, a .Backup file):
//   1. builds the site into <out>/dist with tools/build.js and patches ONLY that copy of js/config.js so the app is
//      "on sale" (a placeholder https checkout link and a made-up Polar organization id); src/config.js is untouched;
//   2. writes the scenario with the fixture CLI (tools/fixtures/build.js: <name>/Database/4.8/… and <name>.Backup);
//   3. serves dist/ with tools/serve.js, which sends the real Content-Security-Policy from site/_headers;
//   4. drives the page over the DevTools protocol: DOM.setFileInputFiles on #folder-input (a directory) or
//      #file-input (the .Backup), waits for the preview, checks the totals and the tree against the fixture's
//      expected result, unlocks with a made-up key whose check is answered by Fetch interception (a canned "granted"
//      answer; nothing ever reaches Polar or Gumroad, and Chrome cannot resolve any host but 127.0.0.1 anyway),
//      downloads the ZIP and opens it with src/format/unzip.js;
//   5. checks the ZIP: list paths, each list's GPX items (names, positions, elevations, times), the files outside the
//      tree, KML and GPX well-formed (xmllint --noout), the report;
//   6. records every console error, uncaught exception, Content-Security-Policy violation and request to any origin
//      other than the local server, and the page's JS heap.
// Corrupt scenarios must end in a plain error or a partial result, never a hang or a console error.
// With `real` (tools/e2e/real.js), it also runs REAL BaseCamp 4.8.13 output that holds only made-up content
// (testdata/basecamp-real/), copied into the scratch folder, and checks the exact ZIP listing, the KML nesting and the
// report on top of the checks above.
//
// All input is synthetic (tools/fixtures). Run it through the heavy-job wrapper (one headless Chrome at a time):
//   node tools/e2e/run.js --out <scratch-dir> [scenario …]
// or as the opt-in test: BCR_E2E=1 node --test test/e2e.test.js.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../build.js';
import { startServer } from '../serve.js';
import { SCENARIOS, buildScenario } from '../fixtures/scenarios.js';
import { buildBackup } from '../fixtures/backup.js';
import { openZip } from '../../src/format/unzip.js';
import { launchChrome, sleep } from './cdp.js';
import { REAL_SAMPLES, checkRealZip, writeRealSamples } from './real.js';
import {
  ALL_ITEMS,
  DUPLICATES_DIR,
  KIND_WORD,
  NOT_IN_ANY_LIST,
  ROOT_NAME,
  DEGREES,
  checkSafeSegment,
  compareItems,
  kmlPoints,
  expectedLayout,
  parseGpx,
  pathKey,
  xmlSafe,
} from './expect.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

export const POLAR_URL = 'https://api.polar.sh/v1/customer-portal/license-keys/validate';
/** Made up for the test build only; never a real organization. */
export const TEST_ORG = '00000000-0000-4000-8000-0000000e2e00';
export const TEST_CHECKOUT = 'https://checkout.example.invalid/foldertrail';
/** Matches license.js's key shape (letters, digits, "_" and "-"; 16-256 characters). Made up. */
export const TEST_KEY = 'FTE2E_00000000-0000-4000-8000-000000000001';

const WAIT_MS = 60_000;
const RUN_DEADLINE_MS = 240_000;
const XMLLINT = '/usr/bin/xmllint';

/**
 * @typedef {object} RunResult
 * @property {string} scenario
 * @property {'folder'|'backup'|'version-folder'} intake  folder: the folder that holds Database/4.8; version-folder: the 4.8 folder itself
 * @property {'pass'|'fail'|'hung'} status
 * @property {string} outcome        what the page ended on: preview+zip, error, open-error, …
 * @property {string[]} problems     every check that failed, in plain words
 * @property {string[]} consoleErrors
 * @property {string[]} consoleWarnings
 * @property {string[]} csp          Content-Security-Policy violations (event, log or issue)
 * @property {string[]} foreign      requests to any origin other than the local server and the intercepted licence URL
 * @property {number} licenceRequests  POSTs to the licence URL (answered by the interceptor)
 * @property {number|null} heapAfterPreview  page JSHeapUsedSize, bytes
 * @property {number|null} heapAfterExport
 * @property {number|null} workerHeap        the worker's used heap after the export, bytes (when it could be read)
 * @property {number|null} peakPageHeap      the highest page JSHeapUsedSize seen while reading and exporting (sampled every 250 ms)
 * @property {number|null} peakWorkerHeap    the highest worker heap seen while reading and exporting (sampled every 250 ms)
 * @property {{rows: number, gpxFiles: number, items: number}} checked  how much was compared (a pass that compared nothing is not a pass)
 * @property {string} [pageText]    the preview's summary and side notes, kept for a failing run
 * @property {{read: number|null, export: number|null}} timings  ms from handing the library over to the preview or
 *   error, and from pressing Download to the saved ZIP (as the browser saw them)
 * @property {number|null} zipBytes
 * @property {number|null} zipEntries
 * @property {number} ms
 * @property {string} [errorText]     the message the page showed, for error outcomes
 */

// ---------------------------------------------------------------------------------------------
// Setup

/**
 * Builds dist/ into `outDir/dist` and patches its config.js so isConfigured() is true. Throws if the patch did not
 * apply (a changed config.js must not silently turn the test into "not on sale").
 * @param {string} outDir
 */
export async function buildTestSite(outDir) {
  const dist = join(outDir, 'dist');
  await build({ outDir: dist });
  const file = join(dist, 'js', 'config.js');
  const before = await readFile(file, 'utf8');
  const after = before
    .replace(/checkoutUrl: '',/, `checkoutUrl: '${TEST_CHECKOUT}',`)
    .replace(/licenseProvider: '[a-z]*',/, "licenseProvider: 'polar',")
    .replace(/polarOrganizationId: '',/, `polarOrganizationId: '${TEST_ORG}',`);
  if (!after.includes(`checkoutUrl: '${TEST_CHECKOUT}'`) || !after.includes(`polarOrganizationId: '${TEST_ORG}'`) || !after.includes("licenseProvider: 'polar'")) {
    throw new Error('tools/e2e: could not patch dist/js/config.js (its placeholders changed); update buildTestSite');
  }
  await writeFile(file, after);
  return dist;
}

/**
 * A bigger synthetic library for the memory measurement, from the fixture writer (made-up names and positions).
 * It is not one of the named scenarios: it exists only so the heap number means something.
 * @param {{waypoints?: number, tracks?: number, points?: number, lists?: number}} [size]
 */
export function bulkScenario(size = {}) {
  const nW = size.waypoints ?? 2000;
  const nT = size.tracks ?? 100;
  const nP = size.points ?? 3000;
  const nL = size.lists ?? 30;
  const T0 = Date.UTC(2026, 0, 10, 8, 0, 0);
  /** @type {any[]} */
  const items = [];
  /** @type {any[]} */
  const folders = [];
  for (let f = 0; f < 6; f++) folders.push({ id: `f${f}`, name: `Region ${f + 1}`, type: 'folder', parentId: null, itemIds: [] });
  for (let f = 0; f < 6; f++) folders.push({ id: `g${f}`, name: `Year ${2020 + f}`, type: 'folder', parentId: `f${f}`, itemIds: [] });
  for (let l = 0; l < nL; l++) folders.push({ id: `l${l}`, name: `Trip ${String(l + 1).padStart(3, '0')}`, type: 'list', parentId: `g${l % 6}`, itemIds: [] });
  const lists = folders.filter((f) => f.type === 'list');
  for (let i = 0; i < nW; i++) {
    const id = `w${i}`;
    items.push({
      kind: 'waypoint', id, name: `Point ${String(i + 1).padStart(5, '0')}`, comment: i % 7 === 0 ? 'A made-up note' : '',
      lat: 45 + (i % 100) * 0.01, lon: 7 + Math.floor(i / 100) * 0.01, ele: 400 + (i % 50) * 10, time: T0 + i * 60_000,
    });
    lists[i % nL].itemIds.push(id);
  }
  for (let t = 0; t < nT; t++) {
    const id = `t${t}`;
    const seg = Array.from({ length: nP }, (_, k) => ({
      lat: 46 + t * 0.01 + k * 0.0001, lon: 8 + k * 0.00013, ele: 500 + (k % 300), time: T0 + t * 86_400_000 + k * 5_000,
    }));
    items.push({ kind: 'track', id, name: `Track ${String(t + 1).padStart(3, '0')}`, segments: [seg] });
    lists[t % nL].itemIds.push(id);
  }
  for (let r = 0; r < 10; r++) {
    const id = `r${r}`;
    const a = items[r * 3];
    const b = items[r * 3 + 1];
    items.push({ kind: 'route', id, name: `Route ${r + 1}`, points: [a, b].map((w) => ({ name: w.name, lat: w.lat, lon: w.lon })) });
    lists[r % nL].itemIds.push(id);
  }
  return {
    name: 'e2e-bulk',
    title: `E2E only: ${nW} waypoints, ${nT} tracks of ${nP} points, 10 routes in ${nL} lists`,
    covers: ['memory measurement'],
    supportedPath: true,
    library: { seed: 9001, header: { programVersion: 480 }, items, folders },
  };
}

/**
 * Writes fixture folders and backups. The named scenarios go through the fixture CLI, as a person would use it;
 * the bulk library (not a CLI scenario) is written the same way in-process.
 * @param {string} dir
 * @param {string[]} names
 * @param {any|null} bulk  bulkScenario() or null
 * @returns {Promise<Map<string, {expected: any, bytes: number}>>}
 */
export async function writeFixtures(dir, names, bulk) {
  await mkdir(dir, { recursive: true });
  /** @type {Map<string, {expected: any, bytes: number}>} */
  const out = new Map();
  if (names.length > 0) {
    execFileSync(process.execPath, [join(ROOT, 'tools/fixtures/build.js'), dir, ...names], { stdio: 'pipe' });
    for (const name of names) {
      const { expected } = JSON.parse(await readFile(join(dir, `${name}.expected.json`), 'utf8'));
      const { built } = buildScenario(name);
      let bytes = 0;
      for (const b of built.files.values()) bytes += b.length;
      out.set(name, { expected, bytes });
    }
  }
  if (bulk) {
    const { built, expected } = buildScenario(bulk);
    const db = join(dir, bulk.name, 'Database', built.databaseVersion);
    await rm(join(dir, bulk.name), { recursive: true, force: true });
    let bytes = 0;
    for (const [rel, data] of built.files) {
      await mkdir(dirname(join(db, rel)), { recursive: true });
      await writeFile(join(db, rel), data);
      bytes += data.length;
    }
    await writeFile(join(dir, `${bulk.name}.Backup`), await buildBackup(built));
    out.set(bulk.name, { expected, bytes });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// One run

/**
 * @param {any} ctx  {cdp, serverUrl, fixtures, outDir}
 * @param {string} scenario
 * @param {'folder'|'backup'|'version-folder'} intake
 * @param {{licence?: 'valid'|'refused'}} [options]
 * @returns {Promise<RunResult>}
 */
export async function runOne(ctx, scenario, intake, options = {}) {
  const started = Date.now();
  /** @type {RunResult} */
  const result = {
    scenario, intake, status: 'pass', outcome: '', problems: [], consoleErrors: [], consoleWarnings: [], csp: [], foreign: [],
    licenceRequests: 0, heapAfterPreview: null, heapAfterExport: null, workerHeap: null, peakPageHeap: null, peakWorkerHeap: null,
    checked: { rows: 0, gpxFiles: 0, items: 0 }, timings: { read: null, export: null }, zipBytes: null, zipEntries: null, ms: 0,
  };
  const state = { cleanup: /** @type {(() => Promise<void>)|null} */ (null) };
  const work = runSteps(ctx, scenario, intake, options, result, state);
  let timer;
  const deadline = new Promise((r) => {
    timer = setTimeout(() => r('hung'), RUN_DEADLINE_MS);
  });
  try {
    const how = await Promise.race([work.then(() => 'done', (error) => error), deadline]);
    if (how === 'hung') {
      result.status = 'hung';
      result.problems.push(`no result within ${RUN_DEADLINE_MS / 1000} s (last step: ${result.outcome || 'start'})`);
    } else if (how !== 'done') {
      result.problems.push(`run stopped: ${how instanceof Error ? how.message : String(how)}`);
    }
  } finally {
    clearTimeout(timer);
    try {
      await state.cleanup?.();
    } catch {
      // the browser context may already be gone
    }
  }
  if (result.consoleErrors.length > 0) result.problems.push(`${result.consoleErrors.length} console error(s)`);
  if (result.csp.length > 0) result.problems.push(`${result.csp.length} Content-Security-Policy violation(s)`);
  if (result.foreign.length > 0) result.problems.push(`${result.foreign.length} request(s) to another origin`);
  if (result.status !== 'hung' && result.problems.length > 0) result.status = 'fail';
  result.ms = Date.now() - started;
  return result;
}

/**
 * @param {any} ctx
 * @param {string} scenario
 * @param {'folder'|'backup'|'version-folder'} intake
 * @param {{licence?: 'valid'|'refused'}} options
 * @param {RunResult} result
 * @param {{cleanup: (() => Promise<void>)|null}} state
 */
async function runSteps(ctx, scenario, intake, options, result, state) {
  const { cdp, serverUrl, fixtures, outDir } = ctx;
  const fx = fixtures.get(scenario);
  if (!fx) throw new Error(`no fixture written for ${scenario}`);
  const layout = expectedLayout(fx.expected);
  const origin = new URL(serverUrl).origin;
  const licenceMode = options.licence ?? 'valid';
  const runTag = `${scenario}-${intake}${licenceMode === 'valid' ? '' : `-${licenceMode}`}`;
  const downloadDir = join(outDir, 'downloads', runTag);
  await rm(downloadDir, { recursive: true, force: true });
  await mkdir(downloadDir, { recursive: true });

  const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloadDir, eventsEnabled: true, browserContextId });
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  /** @type {Set<string>} */
  const sessions = new Set([sessionId]);
  /** @type {string|null} */
  let workerSession = null;
  /** @type {{guid: string, suggested: string, state: string, filePath?: string}|null} */
  let download = null;
  /** @type {any[]} */
  const licenceBodies = [];

  const off = cdp.on(async (/** @type {any} */ msg) => {
    if (msg.method === 'Browser.downloadWillBegin' && !msg.sessionId) {
      if (msg.params.frameId === targetId || download === null) download = { guid: msg.params.guid, suggested: msg.params.suggestedFilename, state: 'started' };
      return;
    }
    if (msg.method === 'Browser.downloadProgress' && !msg.sessionId) {
      if (download && msg.params.guid === download.guid) {
        download.state = msg.params.state;
        if (msg.params.filePath) download.filePath = msg.params.filePath;
      }
      return;
    }
    if (!msg.sessionId || !sessions.has(msg.sessionId)) return;
    const where = msg.sessionId === sessionId ? 'page' : 'worker';
    const p = msg.params ?? {};
    switch (msg.method) {
      case 'Target.attachedToTarget': {
        const child = p.sessionId;
        sessions.add(child);
        if (p.targetInfo?.type === 'worker') workerSession = child;
        const s = (/** @type {string} */ m, /** @type {object} */ q = {}) => cdp.send(m, q, child).catch(() => {});
        await Promise.all([s('Runtime.enable'), s('Log.enable'), s('Network.enable'), s('Audits.enable')]);
        await s('Runtime.runIfWaitingForDebugger');
        break;
      }
      case 'Runtime.consoleAPICalled': {
        const text = `${where} console.${p.type}: ${(p.args ?? []).map((/** @type {any} */ a) => a.value ?? a.description ?? '').join(' ')}`.slice(0, 400);
        if (p.type === 'error' || p.type === 'assert') result.consoleErrors.push(text);
        else if (p.type === 'warning') result.consoleWarnings.push(text);
        break;
      }
      case 'Runtime.exceptionThrown':
        result.consoleErrors.push(`${where} exception: ${String(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text).slice(0, 400)}`);
        break;
      case 'Log.entryAdded': {
        const e = p.entry ?? {};
        const text = `${where} log ${e.level} (${e.source}): ${String(e.text).slice(0, 400)}`;
        // Chrome itself logs the provider's documented "invalid key" answer (404) as a failed resource. The app
        // cannot prevent that line, and it is the expected outcome of the refused-key run, so it is kept as a note.
        const expected404 = licenceMode === 'refused' && e.source === 'network' && e.url === POLAR_URL && /status of 404/.test(String(e.text));
        if (expected404) result.consoleWarnings.push(`expected: ${text}`);
        else if (e.level === 'error') result.consoleErrors.push(text);
        else if (e.level === 'warning') result.consoleWarnings.push(text);
        if (e.source === 'security' || /Content Security Policy/i.test(String(e.text))) result.csp.push(text);
        break;
      }
      case 'Audits.issueAdded':
        if (p.issue?.code === 'ContentSecurityPolicyIssue') {
          const d = p.issue.details?.contentSecurityPolicyIssueDetails ?? {};
          result.csp.push(`${where} issue: ${d.violatedDirective ?? '?'} blocked ${d.blockedURL ?? d.contentSecurityPolicyViolationType ?? '?'}`);
        }
        break;
      case 'Runtime.bindingCalled':
        if (p.name === '__e2eCsp') result.csp.push(`page securitypolicyviolation: ${String(p.payload).slice(0, 300)}`);
        break;
      case 'Network.requestWillBeSent': {
        const url = String(p.request?.url ?? '');
        if (url.startsWith('blob:') || url.startsWith('data:')) break;
        let urlOrigin = '';
        try {
          urlOrigin = new URL(url).origin;
        } catch {
          // not a URL: counted as foreign below
        }
        if (urlOrigin === origin) break;
        if (url === POLAR_URL) break; // answered by the interceptor below, never sent
        result.foreign.push(`${where} ${p.request?.method} ${url.slice(0, 200)}`);
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
          result.foreign.push(`${where} intercepted ${req.method} ${String(req.url).slice(0, 200)}`);
          await send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' });
          break;
        }
        if (req.method === 'OPTIONS') {
          await send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 204, responseHeaders: cors });
          break;
        }
        result.licenceRequests++;
        let body = req.postData;
        if (body === undefined && req.hasPostData) body = (await cdp.send('Fetch.getRequestPostData', { requestId: p.requestId }, msg.sessionId).catch(() => ({}))).postData;
        licenceBodies.push({ body, headers: req.headers ?? {} });
        const answer =
          licenceMode === 'valid'
            ? { code: 200, json: { id: 'e2e', status: 'granted', organization_id: TEST_ORG, expires_at: null, key: '(made up)' } }
            : { code: 404, json: { error: 'ResourceNotFound', detail: 'Not found' } };
        await send('Fetch.fulfillRequest', {
          requestId: p.requestId,
          responseCode: answer.code,
          responseHeaders: [...cors, { name: 'Content-Type', value: 'application/json' }],
          body: Buffer.from(JSON.stringify(answer.json)).toString('base64'),
        });
        break;
      }
      default:
    }
  });

  /** Samples both heaps every 250 ms for the whole run, keeping the highest values. */
  let sampling = false;
  const sampler = setInterval(async () => {
    if (sampling) return;
    sampling = true;
    try {
      const m = await cdp.send('Performance.getMetrics', {}, sessionId, 5_000).catch(() => null);
      const used = m?.metrics?.find((/** @type {any} */ x) => x.name === 'JSHeapUsedSize')?.value;
      if (Number.isFinite(used)) result.peakPageHeap = Math.max(result.peakPageHeap ?? 0, used);
      if (workerSession) {
        const w = await cdp.send('Runtime.getHeapUsage', {}, workerSession, 5_000).catch(() => null);
        if (Number.isFinite(w?.usedSize)) result.peakWorkerHeap = Math.max(result.peakWorkerHeap ?? 0, w.usedSize);
      }
    } finally {
      sampling = false;
    }
  }, 250);

  state.cleanup = async () => {
    clearInterval(sampler);
    off();
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  };

  /** @param {string} method @param {object} [params] */
  const send = (method, params = {}) => cdp.send(method, params, sessionId);
  /** @param {string} expression */
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`evaluate failed: ${expression.slice(0, 120)} ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
    return r.result.value;
  };
  /** @param {string} expression @param {number} [timeout] */
  const waitFor = async (expression, timeout = WAIT_MS) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await evaluate(expression)) return true;
      await sleep(100);
    }
    return false;
  };
  const visible = (/** @type {string} */ id) => `(() => { const e = document.getElementById(${JSON.stringify(id)}); return !!e && !e.hidden; })()`;
  const heap = async () => {
    const { metrics } = await send('Performance.getMetrics');
    return metrics.find((/** @type {any} */ m) => m.name === 'JSHeapUsedSize')?.value ?? null;
  };

  await Promise.all(['Runtime.enable', 'Log.enable', 'Page.enable', 'DOM.enable', 'Network.enable', 'Audits.enable', 'Performance.enable'].map((m) => send(m)));
  await send('Fetch.enable', {
    patterns: [
      { urlPattern: 'https://api.polar.sh/*', requestStage: 'Request' },
      { urlPattern: 'https://api.gumroad.com/*', requestStage: 'Request' },
    ],
  });
  await send('Runtime.addBinding', { name: '__e2eCsp' });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source:
      "document.addEventListener('securitypolicyviolation', (e) => { try { __e2eCsp(JSON.stringify({ directive: e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile, line: e.lineNumber })); } catch {} }, true);",
  });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

  // 1. Open the page.
  result.outcome = 'loading';
  await send('Page.navigate', { url: `${serverUrl}app/` });
  if (!(await waitFor(`document.readyState === 'complete' && ${visible('view-open')}`))) {
    result.problems.push('the open view never appeared');
    return;
  }
  const onSale = await evaluate(`${visible('licence-steps')} && !${visible('presale')}`);
  if (!onSale) result.problems.push('the test build is not "on sale" (the config patch did not take effect)');

  // 2. Hand the library over.
  result.outcome = 'reading';
  const { root } = await send('DOM.getDocument', { depth: 1 });
  const selector = intake === 'backup' ? '#file-input' : '#folder-input';
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector });
  const path =
    intake === 'folder'
      ? join(ctx.fixtureDir, scenario)
      : intake === 'version-folder'
        ? join(ctx.fixtureDir, scenario, 'Database', '4.8')
        : join(ctx.fixtureDir, `${scenario}.Backup`);
  const readStart = Date.now();
  await send('DOM.setFileInputFiles', { nodeId, files: [path] });
  const ended = await waitFor(`${visible('view-preview')} || ${visible('view-error')} || ${visible('open-errors')}`);
  result.timings.read = Date.now() - readStart;
  if (!ended) {
    result.outcome = 'no-result';
    result.problems.push(`neither a preview nor an error within ${WAIT_MS / 1000} s`);
    return;
  }

  // 3a. A library that cannot be used: a plain error, the diagnostic report offered, nothing else.
  if (layout.fatal) {
    const shown = await evaluate(`({
      error: ${visible('view-error')}, preview: ${visible('view-preview')}, openErrors: ${visible('open-errors')},
      message: document.getElementById('error-message').textContent.trim(),
      openText: document.getElementById('open-errors-list').textContent.trim(),
      diagnostic: ${visible('diagnostic')}, retry: ${visible('error-retry')},
    })`);
    result.outcome = shown.error ? 'error' : shown.openErrors ? 'open-error' : 'preview';
    result.errorText = shown.message || shown.openText;
    if (!shown.error && !shown.openErrors) result.problems.push(`a library that cannot be used showed a preview (want an error: ${fx.expected.fatal.code})`);
    if (shown.error && shown.message.length < 20) result.problems.push('the error message is missing or too short');
    if (shown.error && /\b(undefined|null|NaN|\[object|Error:|TypeError|at \w+ \()/.test(shown.message)) result.problems.push(`the error message is not plain words: ${shown.message.slice(0, 120)}`);
    if (shown.error && !shown.diagnostic) result.problems.push('the diagnostic report is not offered with the error');
    result.heapAfterPreview = await heap();
    return;
  }

  // 3b. The preview.
  if (!(await evaluate(visible('view-preview')))) {
    const why = await evaluate(`(document.getElementById('error-message').textContent + ' ' + document.getElementById('open-errors-list').textContent).trim()`);
    result.outcome = 'error';
    result.errorText = why;
    result.problems.push(`no preview for a usable library: ${why.slice(0, 200)}`);
    return;
  }
  result.outcome = 'preview';
  result.heapAfterPreview = await heap();
  const page = await evaluate(`(() => {
    const text = (id) => (document.getElementById(id)?.textContent ?? '').replace(/\\s+/g, ' ').trim();
    const rows = [...document.querySelectorAll('#tree [role=treeitem]')].map((r) => ({
      level: Number(r.getAttribute('aria-level')),
      type: r.classList.contains('row-folder') ? 'folder' : 'list',
      title: r.querySelector('.row-title')?.textContent ?? '',
      untitled: r.querySelector('.row-title')?.classList.contains('is-untitled') ?? false,
      nums: [...r.querySelectorAll('.num')].map((n) => n.textContent),
    }));
    return {
      summary: text('preview-summary'), meta: text('preview-meta'), notices: text('preview-notices'), treeNote: text('tree-note'),
      also: text('also-saved'), notConverted: text('not-converted-items'), notes: text('reading-notes-list'), rows,
      alsoRows: [...document.querySelectorAll('#also-saved .also-row')].map((r) => ({
        title: (r.querySelector('.also-title')?.firstChild?.textContent ?? '').trim(),
        count: (r.querySelector('.also-count')?.textContent ?? '').trim(),
      })),
    };
  })()`);
  const before = result.problems.length;
  checkPreview(page, layout, fx.expected, result.problems);
  result.checked.rows = page.rows.length;
  if (result.problems.length > before) result.pageText = `${page.summary} | ${page.notices} | ${page.also} | ${page.notConverted}`.slice(0, 1500);

  // 4. Unlock with the made-up key; the interceptor answers for Polar.
  result.outcome = 'unlocking';
  await evaluate(`(() => { const i = document.getElementById('licence-key'); i.value = ${JSON.stringify(TEST_KEY)};
    document.getElementById('key-form').requestSubmit(); })()`);
  const judged = await waitFor(`(() => { const m = document.getElementById('licence-message').classList; return m.contains('is-good') || m.contains('is-bad'); })()`);
  const licence = await evaluate(`({ good: document.getElementById('licence-message').classList.contains('is-good'),
    text: document.getElementById('licence-message').textContent.trim(), canDownload: !document.getElementById('download-btn').disabled })`);
  checkLicenceRequests(licenceBodies, result.problems);
  if (licenceMode === 'refused') {
    result.outcome = 'refused';
    if (!judged || licence.good) result.problems.push('a refused key was not shown as refused');
    if (licence.canDownload) result.problems.push('the download button is enabled after a refused key');
    if (licence.text.includes(TEST_KEY)) result.problems.push('the refusal message repeats the key');
    await sleep(300);
    if (download) result.problems.push('a download started after a refused key');
    return;
  }
  if (!judged || !licence.good) {
    result.problems.push(`the canned valid licence was not accepted: ${licence.text.slice(0, 160)}`);
    return;
  }
  if (!licence.canDownload) result.problems.push('the download button is still disabled after the key was accepted');

  // 5. Download.
  result.outcome = 'exporting';
  const exportStart = Date.now();
  await evaluate("document.getElementById('download-btn').click()");
  const done = await waitFor(`${visible('view-done')} || ${visible('export-error')}`);
  if (!done) {
    result.problems.push(`no ZIP within ${WAIT_MS / 1000} s of pressing Download`);
    return;
  }
  if (await evaluate(visible('export-error'))) {
    const text = await evaluate("document.getElementById('export-error-text').textContent.trim()");
    result.outcome = 'export-error';
    result.problems.push(`export failed on the page: ${text.slice(0, 200)}`);
    return;
  }
  const t0 = Date.now();
  while (Date.now() - t0 < WAIT_MS && !(download && (download.state === 'completed' || download.state === 'canceled'))) await sleep(100);
  if (!download || download.state !== 'completed') {
    result.problems.push(`the browser did not save the ZIP (download ${download ? download.state : 'never started'})`);
    return;
  }
  result.timings.export = Date.now() - exportStart;
  result.outcome = 'preview+zip';
  result.heapAfterExport = await heap();
  if (workerSession) {
    try {
      result.workerHeap = (await cdp.send('Runtime.getHeapUsage', {}, workerSession, 5_000)).usedSize ?? null;
    } catch {
      result.workerHeap = null; // the worker may have been closed after the export
    }
  }
  const reportOnPage = await evaluate("document.getElementById('report-text').textContent");
  const doneSummary = await evaluate("document.getElementById('done-summary').textContent");
  if (!/^Foldertrail export \d{4}-\d{2}-\d{2}\.zip$/.test(download.suggested)) result.problems.push(`unexpected ZIP name: ${download.suggested}`);
  if (!doneSummary.includes(download.suggested)) result.problems.push('the done view does not name the file that was saved');
  const zipPath = download.filePath ?? join(downloadDir, download.guid);
  const bytes = new Uint8Array(await readFile(zipPath));
  result.zipBytes = bytes.length;
  const zipFiles = await checkZip(bytes, layout, fx.expected, reportOnPage, join(outDir, 'extract', runTag), result);
  if (result.checked.gpxFiles === 0) result.problems.push('no GPX file was compared (the check itself is broken)');
  // A real BaseCamp sample (tools/e2e/real.js): also the exact listing, the KML nesting and the report's wording.
  if (fx.real && zipFiles) checkRealZip(scenario, zipFiles, result.problems);
}

/**
 * Checks the preview the page drew against the fixture.
 * @param {any} page
 * @param {import('./expect.js').ExpectedLayout} layout
 * @param {any} expected
 * @param {string[]} problems
 */
export function checkPreview(page, layout, expected, problems) {
  const t = layout.totals;
  const items = t.waypoints + t.tracks + t.routes;
  // Totals: the summary sentence.
  /** @param {string} word */
  const count = (word) => {
    const m = new RegExp(`(\\d[\\d,]*) ${word}s?\\b`).exec(page.summary);
    return m ? Number(m[1].replace(/,/g, '')) : 0;
  };
  if (items === 0) {
    // Nothing converts. With items that will not convert, the page names what the library holds and says none of it
    // can be converted (ui.js summarySentence); only a truly empty library says "No waypoints, tracks or routes".
    if (layout.notConvertedNames.length > 0) {
      if (!/\bcan[’']t be converted\b|\bnone of them can be converted\b/.test(page.summary)) {
        problems.push(`summary for a library where nothing converts: "${page.summary}"`);
      }
    } else if (!/No waypoints, tracks or routes/.test(page.summary)) problems.push(`summary for an empty library: "${page.summary}"`);
  } else {
    for (const [word, want] of /** @type {const} */ ([['waypoint', t.waypoints], ['track', t.tracks], ['route', t.routes]])) {
      if (count(word) !== want) problems.push(`summary says ${count(word)} ${word}s, want ${want} ("${page.summary}")`);
    }
    if (!layout.treeMissing) {
      if (t.lists > 0 && count('list') !== t.lists) problems.push(`summary says ${count('list')} lists, want ${t.lists}`);
      if (t.folders > 0 && count('folder') !== t.folders) problems.push(`summary says ${count('folder')} folders, want ${t.folders}`);
    }
  }
  if (expected.experimental && !/experimental/i.test(page.notices)) problems.push('no "read experimentally" notice for an experimental version');
  if (!expected.experimental && /experimental/i.test(page.notices)) problems.push('an "experimental" notice for a supported version');

  // Tree: every folder and list, by name path, with per-list counts.
  if (layout.treeMissing) {
    if (!/No folders or lists were found/.test(page.notices)) problems.push('no "no folders or lists" notice without FolderData.gfi');
    if (page.rows.length > 0) problems.push(`${page.rows.length} tree rows drawn without a tree`);
  } else {
    /** @type {string[]} */
    const stack = [];
    /** @type {Map<string, {type: string, nums: string[]}>} */
    const drawn = new Map();
    for (const row of page.rows) {
      const name = row.untitled ? '' : row.title;
      stack.length = Math.max(0, row.level - 1);
      stack.push(name);
      drawn.set(`${row.type}: ${pathKey(stack)}`, row);
    }
    const want = new Set(layout.rows.map((r) => `${r.type}: ${pathKey(r.path)}`));
    for (const key of want) if (!drawn.has(key)) problems.push(`tree is missing ${key}`);
    for (const key of drawn.keys()) if (!want.has(key)) problems.push(`tree has an unexpected ${key}`);
    for (const r of layout.rows) {
      if (r.type !== 'list' || !r.counts) continue;
      const row = drawn.get(`list: ${pathKey(r.path)}`);
      if (!row) continue;
      const nums = row.nums.map((/** @type {string} */ n) => (n === '–' || n === '' ? 0 : Number(n.replace(/,/g, ''))));
      const wantNums = [r.counts.waypoints, r.counts.tracks, r.counts.routes];
      if (nums.join('|') !== wantNums.join('|')) problems.push(`list ${pathKey(r.path)} shows ${nums.join('/')} (waypoints/tracks/routes), want ${wantNums.join('/')}`);
    }
  }

  // Saved outside the lists, and what will not convert (named, never hidden).
  /** @param {string} title */
  const alsoCount = (title) => {
    const row = (page.alsoRows ?? []).find((/** @type {any} */ r) => r.title === title);
    if (!row) return 0;
    return [...String(row.count).matchAll(/(\d[\d,]*)/g)].reduce((n, m) => n + Number(m[1].replace(/,/g, '')), 0);
  };
  if (alsoCount('Not in any list') !== layout.unlisted) problems.push(`"Not in any list" shows ${alsoCount('Not in any list')} items, want ${layout.unlisted}`);
  if (alsoCount('Duplicate names') !== layout.ambiguous) problems.push(`"Duplicate names" shows ${alsoCount('Duplicate names')} items, want ${layout.ambiguous}`);
  for (const name of layout.notConvertedNames) {
    if (name !== '' && !page.notConverted.includes(name.replace(/\s+/g, ' ').trim())) problems.push(`not-converted item "${name}" is not named on the page`);
  }
}

/**
 * Only the key and the organization id may leave the browser, and no cookie or referrer with them.
 * @param {{body: string|undefined, headers: Record<string, string>}[]} bodies
 * @param {string[]} problems
 */
function checkLicenceRequests(bodies, problems) {
  if (bodies.length === 0) problems.push('no licence request reached the interceptor');
  if (bodies.length > 1) problems.push(`${bodies.length} licence requests for one unlock`);
  for (const { body, headers } of bodies) {
    let data = null;
    try {
      data = JSON.parse(String(body));
    } catch {
      problems.push('the licence request body is not JSON');
      continue;
    }
    const keys = Object.keys(data).sort().join(',');
    if (keys !== 'key,organization_id') problems.push(`the licence request sends fields ${keys} (want key,organization_id only)`);
    if (data.key !== TEST_KEY || data.organization_id !== TEST_ORG) problems.push('the licence request sends a different key or organization id');
    const names = Object.keys(headers).map((h) => h.toLowerCase());
    if (names.includes('cookie')) problems.push('the licence request carries a cookie');
    if (names.includes('referer')) problems.push('the licence request carries a referrer');
  }
}

/**
 * Opens the ZIP with src/format/unzip.js and checks it against the fixture.
 * @param {Uint8Array} bytes
 * @param {import('./expect.js').ExpectedLayout} layout
 * @param {any} expected
 * @param {string} reportOnPage
 * @param {string} extractDir
 * @param {RunResult} result
 * @returns {Promise<Map<string, Uint8Array>|null>}  the ZIP's files (no directories), or null when it did not open
 */
export async function checkZip(bytes, layout, expected, reportOnPage, extractDir, result) {
  const problems = result.problems;
  let archive;
  try {
    archive = await openZip(bytes);
  } catch (error) {
    problems.push(`the ZIP could not be opened: ${error instanceof Error ? error.message : error}`);
    return null;
  }
  result.zipEntries = archive.entries.length;
  if (archive.problems.length > 0) problems.push(`the ZIP reader reported: ${archive.problems.map((p) => p.code).join(', ')}`);
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  for (const entry of archive.entries) {
    if (entry.name.endsWith('/')) continue;
    if (entry.unsafeName) problems.push(`unsafe entry name in the ZIP: ${entry.name}`);
    try {
      files.set(entry.name, await entry.read());
    } catch (error) {
      problems.push(`entry ${entry.name} could not be read: ${error instanceof Error ? error.message : error}`);
    }
  }
  const text = (/** @type {string} */ name) => new TextDecoder().decode(files.get(name));

  // Report, read-me, KML.
  for (const name of ['report.txt', 'report.html', 'READ-ME-FIRST.txt']) {
    if (!files.has(name) || (files.get(name)?.length ?? 0) < 20) problems.push(`${name} is missing or empty`);
  }
  if (files.has('report.html') && !/<html[\s>]/i.test(text('report.html'))) problems.push('report.html is not an HTML document');
  if (files.has('report.txt') && text('report.txt').trim() !== reportOnPage.trim()) problems.push('report.txt differs from the report shown on the page');
  const kmlName = layout.treeMissing ? `KML/${ALL_ITEMS}.kml` : `KML/${ROOT_NAME}.kml`;
  const kmls = [...files.keys()].filter((n) => n.startsWith('KML/'));
  if (!files.has(kmlName)) problems.push(`${kmlName} is missing (KML files: ${kmls.join(', ') || 'none'})`);
  else {
    const kml = text(kmlName);
    for (const item of [...(expected.items ?? [])]) {
      if (item.name && !kml.includes(`<name>${escapeXml(xmlSafe(item.name))}</name>`)) {
        problems.push(`KML has no placemark named "${item.name}"`);
        break;
      }
    }
    // Every waypoint is a point placemark at its position (an item in two lists appears twice; one match is enough).
    const placed = kmlPoints(kml);
    for (const item of (expected.items ?? []).filter((/** @type {any} */ i) => i.kind === 'waypoint')) {
      const at = placed.find((p) => p.name === xmlSafe(item.name) && Math.abs(p.lat - item.lat) <= DEGREES && Math.abs(p.lon - item.lon) <= DEGREES);
      if (!at) {
        problems.push(`KML has no point placemark "${item.name}" at ${item.lat},${item.lon}`);
        break;
      }
    }
  }

  // GPX: parse every file once.
  /** @type {Map<string, import('./expect.js').Gpx>} */
  const gpx = new Map();
  for (const name of files.keys()) if (name.endsWith('.gpx')) gpx.set(name, parseGpx(text(name)));
  /** @type {Set<string>} */
  const accounted = new Set();
  const norm = (/** @type {string|null} */ s) => xmlSafe(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').trim();

  for (const file of layout.files) {
    if (file.role !== 'list') {
      const name = /** @type {string} */ (file.zipPath);
      const got = gpx.get(name);
      if (!got) {
        problems.push(`${name} is missing`);
        continue;
      }
      accounted.add(name);
      result.checked.gpxFiles++;
      result.checked.items += file.items.length;
      for (const p of compareItems(file.items, got.items)) problems.push(`${name}: ${p}`);
      continue;
    }
    // A list's file: found by its title and folder path (the GPX metadata), then its place in the ZIP is checked.
    const listPath = /** @type {string[]} */ (file.listPath);
    const wantName = norm(listPath.at(-1) ?? '') || 'Untitled';
    const wantDesc = listPath.slice(0, -1).map((n) => norm(n) || 'Untitled').join(' / ');
    const candidates = [...gpx].filter(
      ([name, g]) => !accounted.has(name) && name.startsWith('GPX/') && !name.startsWith(`GPX/${DUPLICATES_DIR}/`) && norm(g.name) === wantName && norm(g.desc) === wantDesc,
    );
    const exact = file.zipPath ? candidates.find(([name]) => name === file.zipPath) : undefined;
    const match = exact ?? candidates[0];
    if (!match) {
      problems.push(`no GPX file for list ${pathKey(listPath)}${file.zipPath ? ` (want ${file.zipPath})` : ''}`);
      continue;
    }
    const [name, got] = match;
    accounted.add(name);
    if (file.zipPath && name !== file.zipPath) problems.push(`list ${pathKey(listPath)} is at ${name}, want ${file.zipPath}`);
    const segments = name.replace(/^GPX\//, '').replace(/\.gpx$/, '').split('/');
    if (segments.length !== listPath.length) problems.push(`list ${pathKey(listPath)} is ${segments.length} levels deep in the ZIP, want ${listPath.length}`);
    for (const seg of segments) for (const why of checkSafeSegment(seg)) problems.push(`path ${name} has ${why}`);
    result.checked.gpxFiles++;
    result.checked.items += file.items.length;
    for (const p of compareItems(file.items, got.items)) problems.push(`${name}: ${p}`);
  }

  // Duplicates: one file per copy under _Duplicate names, named "<Kind> - <name>".
  const dupFiles = [...gpx].filter(([name]) => name.startsWith(`GPX/${DUPLICATES_DIR}/`));
  for (const [name, g] of dupFiles) {
    accounted.add(name);
    if (g.items.length !== 1) problems.push(`${name} holds ${g.items.length} items (want 1)`);
    const base = name.slice(`GPX/${DUPLICATES_DIR}/`.length);
    const kind = g.items[0]?.kind;
    if (kind && !base.startsWith(`${KIND_WORD[kind]} - `)) problems.push(`${name} does not start with "${KIND_WORD[kind]} - "`);
    for (const why of checkSafeSegment(base.replace(/\.gpx$/, ''))) problems.push(`path ${name} has ${why}`);
  }
  result.checked.gpxFiles += dupFiles.length;
  result.checked.items += layout.duplicateItems.length;
  for (const p of compareItems(layout.duplicateItems, dupFiles.flatMap(([, g]) => g.items))) problems.push(`${DUPLICATES_DIR}: ${p}`);

  // Nothing else in GPX/.
  for (const name of gpx.keys()) if (!accounted.has(name)) problems.push(`unexpected file ${name}`);
  if (layout.unlisted === 0 && files.has(`GPX/${NOT_IN_ANY_LIST}.gpx`)) problems.push(`GPX/${NOT_IN_ANY_LIST}.gpx written but every item is in a list`);

  // Well-formed XML: every GPX and KML through xmllint.
  const xmlNames = [...files.keys()].filter((n) => n.endsWith('.gpx') || n.endsWith('.kml'));
  if (xmlNames.length > 0 && existsSync(XMLLINT)) {
    await rm(extractDir, { recursive: true, force: true });
    await mkdir(extractDir, { recursive: true });
    const local = xmlNames.map((n, i) => join(extractDir, `${String(i).padStart(4, '0')}${n.endsWith('.kml') ? '.kml' : '.gpx'}`));
    for (let i = 0; i < xmlNames.length; i++) await writeFile(local[i], /** @type {Uint8Array} */ (files.get(xmlNames[i])));
    try {
      execFileSync(XMLLINT, ['--noout', '--nonet', ...local], { stdio: 'pipe' });
    } catch (error) {
      const out = String(/** @type {any} */ (error).stderr ?? '');
      const bad = new Set([...out.matchAll(/(\d{4})\.(gpx|kml):\d+:/g)].map((m) => xmlNames[Number(m[1])]));
      problems.push(`not well-formed XML: ${[...bad].join(', ') || out.slice(0, 200)}`);
    }
    await rm(extractDir, { recursive: true, force: true });
  } else if (!existsSync(XMLLINT)) {
    problems.push('xmllint not found: KML/GPX well-formedness not checked');
  }
  return files;
}

/** @param {string} s */
function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------------------------
// The whole run

/**
 * @typedef {object} E2EOptions
 * @property {string} outDir           scratch folder (dist, fixtures, downloads, summary)
 * @property {string[]} [scenarios]    default: all of them
 * @property {('folder'|'backup')[]} [intakes]
 * @property {string[]} [versionFolderScenarios]  also hand these over as the 4.8 folder itself (default: two)
 * @property {boolean} [bulk]          also run the bigger e2e-only library for memory (default true)
 * @property {string[]} [real]         real BaseCamp samples (tools/e2e/real.js) to run, each with its own intakes
 *   (default none)
 * @property {boolean} [refusedKeyRun] also run the refused-key check on 'minimal' (default true)
 * @property {(dist: string) => Promise<void>} [patchDist]  changes the TEST build after it is made (the harness's own
 *   self-check uses it to break the export on purpose and see the run fail)
 * @property {(line: string) => void} [log]
 * @property {(r: RunResult) => void} [onResult]
 */

/**
 * @param {E2EOptions} options
 * @returns {Promise<{results: RunResult[], chrome: string, sizes: Map<string, number>}>}
 */
export async function runE2E(options) {
  const outDir = resolve(options.outDir);
  const log = options.log ?? (() => {});
  const names = options.scenarios ?? SCENARIOS.map((s) => s.name);
  const intakes = options.intakes ?? ['folder', 'backup'];
  await mkdir(outDir, { recursive: true });
  const dist = await buildTestSite(outDir);
  if (options.patchDist) await options.patchDist(dist);
  const fixtureDir = join(outDir, 'fixtures');
  const bulk = options.bulk === false ? null : bulkScenario();
  const fixtures = await writeFixtures(fixtureDir, names, bulk);
  const real = options.real ?? [];
  for (const [name, fx] of await writeRealSamples(fixtureDir, real)) fixtures.set(name, fx);
  const server = await startServer({ root: dist });
  if (server.usingFallbackCsp) log('warning: site/_headers was not read; the fallback policy is in use');
  const chrome = await launchChrome(outDir);
  /** @type {RunResult[]} */
  const results = [];
  try {
    const ctx = { cdp: chrome.cdp, serverUrl: server.url, fixtures, fixtureDir, outDir };
    const all = [...names, ...(bulk ? [bulk.name] : [])];
    for (const name of all) {
      for (const intake of intakes) {
        const r = await runOne(ctx, name, intake);
        results.push(r);
        options.onResult?.(r);
        log(`${r.status.padEnd(4)} ${name} (${intake}) ${r.outcome} ${r.ms} ms${r.problems.length ? `\n       ${r.problems.slice(0, 8).join('\n       ')}` : ''}`);
      }
    }
    // Real BaseCamp output with made-up content, each handed over as its sample says (folder, 4.8 folder, BaseCamp's
    // own .Backup).
    for (const name of real) {
      for (const intake of /** @type {any} */ (REAL_SAMPLES.find((s) => s.name === name)).intakes) {
        const r = await runOne(ctx, name, intake);
        results.push(r);
        options.onResult?.(r);
        log(`${r.status.padEnd(4)} ${name} (${intake}) ${r.outcome} ${r.ms} ms${r.problems.length ? `\n       ${r.problems.slice(0, 8).join('\n       ')}` : ''}`);
      }
    }
    // The common route B in the guide: drag the version folder ("4.8") itself rather than the folder above it.
    for (const name of (options.versionFolderScenarios ?? ['nested-tree', 'tracks-elevation-time']).filter((n) => names.includes(n))) {
      const r = await runOne(ctx, name, 'version-folder');
      results.push(r);
      options.onResult?.(r);
      log(`${r.status.padEnd(4)} ${name} (version-folder) ${r.outcome} ${r.ms} ms${r.problems.length ? `\n       ${r.problems.slice(0, 8).join('\n       ')}` : ''}`);
    }
    if (names.includes('minimal') && options.refusedKeyRun !== false) {
      const r = await runOne(ctx, 'minimal', 'backup', { licence: 'refused' });
      r.scenario = 'minimal (key refused)';
      results.push(r);
      options.onResult?.(r);
      log(`${r.status.padEnd(4)} ${r.scenario} ${r.outcome} ${r.ms} ms${r.problems.length ? `\n       ${r.problems.join('\n       ')}` : ''}`);
    }
  } finally {
    await chrome.close();
    await server.close();
  }
  const sizes = new Map([...fixtures].map(([k, v]) => [k, v.bytes]));
  return { results, chrome: chrome.version, sizes };
}

/**
 * A Markdown summary table.
 * @param {RunResult[]} results
 * @param {Map<string, number>} sizes
 * @param {string} chrome
 */
export function summaryTable(results, sizes, chrome) {
  const kb = (/** @type {number|null} */ n) => (n === null ? '–' : `${(n / 1024).toFixed(0)}`);
  const mb = (/** @type {number|null} */ n) => (n === null ? '–' : (n / 1048576).toFixed(1));
  const sec = (/** @type {number|null} */ n) => (n === null ? '–' : (n / 1000).toFixed(1));
  const lines = [
    `Chrome: ${chrome}. ${results.filter((r) => r.status === 'pass').length}/${results.length} runs passed.`,
    '',
    '| scenario | intake | library KB | status | page ended on | read / export s | rows / GPX files / items checked | console errors | CSP | other origins | page heap MB after preview / after export / peak | worker heap MB peak | ZIP KB | first problem |',
    '|---|---|---:|---|---|---|---|---:|---:|---:|---|---:|---:|---|',
  ];
  for (const r of results) {
    const size = sizes.get(r.scenario.replace(/ \(.*\)$/, '')) ?? null;
    lines.push(
      `| ${r.scenario} | ${r.intake} | ${size === null ? '–' : (size / 1024).toFixed(1)} | ${r.status} | ${r.outcome} | ${sec(r.timings.read)} / ${sec(r.timings.export)} | ${r.checked.rows} / ${r.checked.gpxFiles} / ${r.checked.items} | ${r.consoleErrors.length} | ${r.csp.length} | ${r.foreign.length} | ${mb(r.heapAfterPreview)} / ${mb(r.heapAfterExport)} / ${mb(r.peakPageHeap)} | ${mb(r.peakWorkerHeap)} | ${kb(r.zipBytes)} | ${(r.problems[0] ?? '').replace(/\|/g, '\\|').slice(0, 140)} |`,
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// CLI

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  if (outIndex < 0 || !args[outIndex + 1]) {
    console.error('Usage: node tools/e2e/run.js --out <scratch-dir> [--no-bulk] [--no-real] [--only-folder|--only-backup] [scenario|real-sample ...]');
    process.exit(2);
  }
  const outDir = resolve(args[outIndex + 1]);
  const rest = args.filter((a, i) => i !== outIndex && i !== outIndex + 1);
  const named = rest.filter((a) => !a.startsWith('--'));
  const realNames = REAL_SAMPLES.map((s) => s.name);
  const scenarios = named.filter((a) => !realNames.includes(a));
  // Real samples: the named ones; with no names at all, every one unless --no-real.
  const real = named.length > 0 ? named.filter((a) => realNames.includes(a)) : rest.includes('--no-real') ? [] : realNames;
  /** @type {('folder'|'backup')[]} */
  const intakes = rest.includes('--only-folder') ? ['folder'] : rest.includes('--only-backup') ? ['backup'] : ['folder', 'backup'];
  const { results, chrome, sizes } = await runE2E({
    outDir,
    scenarios: scenarios.length > 0 ? scenarios : named.length > 0 ? [] : undefined,
    real,
    intakes,
    bulk: !rest.includes('--no-bulk'),
    log: (line) => console.log(line),
  });
  const table = summaryTable(results, sizes, chrome);
  await writeFile(join(outDir, 'summary.md'), `${table}\n`);
  await writeFile(join(outDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\n${table}\n\nWritten: ${join(outDir, 'summary.md')} and results.json`);
  process.exit(results.every((r) => r.status === 'pass') ? 0 : 1);
}
