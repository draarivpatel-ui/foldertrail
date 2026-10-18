#!/usr/bin/env node
// Development only: screenshots of every step of the app page, in light and dark, at 1280 px and 390 px.
//
// It builds the site into <out>/dist, serves it with tools/serve.js (under the real Content-Security-Policy),
// and drives the installed Google Chrome, headless, over the DevTools protocol with Node's own WebSocket (no
// packages). Input is a synthetic .Backup made by tools/fixtures (made-up content only). The worker is the
// development fake unless --real-worker is given and src/app/worker.js exists. Console messages, including
// any Content-Security-Policy violation, are printed at the end.
//
// Run it through the heavy-job wrapper (one headless Chrome at a time):
//   node tools/ui-dev/shoot.js --out <dir> [--real-worker]

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../build.js';
import { startServer } from '../serve.js';
import { buildScenario } from '../fixtures/scenarios.js';
import { buildBackup } from '../fixtures/backup.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
if (outIndex < 0 || !args[outIndex + 1]) {
  console.error('Usage: node tools/ui-dev/shoot.js --out <dir> [--real-worker] [--only light-1280,...]');
  process.exit(2);
}
const OUT = resolve(args[outIndex + 1]);
const REAL_WORKER = args.includes('--real-worker');
const onlyIndex = args.indexOf('--only');
const ONLY = onlyIndex >= 0 ? new Set(String(args[onlyIndex + 1] ?? '').split(',')) : null;

/** @type {string[]} */
const consoleLines = [];
/** @type {string[]} */
const shots = [];

// ---------------------------------------------------------------------------------------------
// A minimal DevTools-protocol client

class Cdp {
  /** @param {WebSocket} ws */
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    /** @type {Map<number, {resolve: (v: any) => void, reject: (e: Error) => void}>} */
    this.pending = new Map();
    /** @type {((msg: any) => void)[]} */
    this.listeners = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(`${msg.error.message}`));
        else p?.resolve(msg.result);
      } else {
        for (const listener of this.listeners) listener(msg);
      }
    });
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {string} [sessionId]
   */
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, 30_000);
    });
  }
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launchChrome() {
  const profile = join(OUT, 'chrome-profile');
  await rm(profile, { recursive: true, force: true });
  await mkdir(profile, { recursive: true });
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication',
      '--mute-audio',
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  const [port, path] = (await readFile(portFile, 'utf8')).trim().split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  return { child, cdp: new Cdp(ws), profile };
}

// ---------------------------------------------------------------------------------------------
// Page helpers

/**
 * @param {Cdp} cdp
 * @param {string} sessionId
 */
function page(cdp, sessionId) {
  /** @param {string} method @param {object} [params] */
  const send = (method, params) => cdp.send(method, params, sessionId);
  /** @param {string} expression */
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`evaluate failed: ${expression}\n${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
    return r.result.value;
  };
  /** @param {string} expression @param {number} [timeout] */
  const waitFor = async (expression, timeout = 20_000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await evaluate(expression)) return;
      await sleep(80);
    }
    throw new Error(`timed out waiting for: ${expression}`);
  };
  return { send, evaluate, waitFor };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const distDir = join(OUT, 'dist');
  await build({ outDir: distDir });

  // A synthetic backup (made-up content), and a file that is not a library.
  const { built } = buildScenario('nested-tree');
  const backupPath = join(OUT, 'Synthetic.Backup');
  await writeFile(backupPath, await buildBackup(built, { compression: 'store', name: 'BaseCamp_synthetic' }));
  const bogusPath = join(OUT, 'notes.txt');
  await writeFile(bogusPath, 'This is not a BaseCamp library.\n');

  const useRealWorker = REAL_WORKER && existsSync(join(ROOT, 'src/app/worker.js'));
  if (REAL_WORKER && !useRealWorker) console.log('src/app/worker.js does not exist yet: using the fake worker.');
  const workerOverride = useRealWorker ? {} : { '/js/app/worker.js': join(HERE, 'fake-worker.js') };
  const onSaleServer = await startServer({
    root: distDir,
    overrides: {
      ...workerOverride,
      '/js/config.js': join(HERE, 'fake-config.js'),
      '/js/app/license.js': join(HERE, 'fake-license.js'),
    },
  });
  const plainServer = await startServer({ root: distDir, overrides: { ...workerOverride } });
  console.log(`CSP from ${onSaleServer.usingFallbackCsp ? 'the built-in B22 fallback (no site/_headers yet)' : 'site/_headers'}`);
  console.log(`worker: ${useRealWorker ? 'src/app/worker.js' : 'tools/ui-dev/fake-worker.js'}`);

  const { child, cdp, profile } = await launchChrome();
  try {
    for (const theme of ['light', 'dark']) {
      for (const width of [1280, 390]) {
        const tag = `${theme}-${width}`;
        if (ONLY && !ONLY.has(tag)) continue;
        await runFlows(cdp, { theme, width, tag, onSale: onSaleServer.url, plain: plainServer.url, backupPath, bogusPath });
      }
    }
  } finally {
    try {
      await cdp.send('Browser.close');
    } catch {
      child.kill();
    }
    await onSaleServer.close();
    await plainServer.close();
    await sleep(300);
    await rm(profile, { recursive: true, force: true });
  }

  console.log('\nScreenshots:');
  for (const shot of shots) console.log(`  ${shot}`);
  console.log(`\nConsole (${consoleLines.length}):`);
  for (const line of [...new Set(consoleLines)]) console.log(`  ${line}`);
}

/**
 * @param {Cdp} cdp
 * @param {{theme: string, width: number, tag: string, onSale: string, plain: string, backupPath: string, bogusPath: string}} o
 */
async function runFlows(cdp, o) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const p = page(cdp, sessionId);
  cdp.listeners.push((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.consoleAPICalled') {
      consoleLines.push(`[${o.tag}] console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      consoleLines.push(`[${o.tag}] exception: ${msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text}`);
    } else if (msg.method === 'Log.entryAdded') {
      consoleLines.push(`[${o.tag}] log ${msg.params.entry.level} (${msg.params.entry.source}): ${msg.params.entry.text}`);
    }
  });
  await p.send('Runtime.enable');
  await p.send('Log.enable');
  await p.send('Page.enable');
  await p.send('DOM.enable');
  await p.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
  const mobile = o.width < 600;
  await p.send('Emulation.setDeviceMetricsOverride', {
    width: o.width,
    height: mobile ? 844 : 900,
    deviceScaleFactor: mobile ? 2 : 1,
    mobile,
  });
  await p.send('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'prefers-color-scheme', value: o.theme }] });

  /** @param {string} url */
  const go = async (url) => {
    await p.send('Page.navigate', { url });
    await p.waitFor("document.readyState === 'complete' && !document.getElementById('view-open').hidden");
    await sleep(350);
  };
  /** @param {string} selector @param {string} file */
  const pick = async (selector, file) => {
    const { root } = await p.send('DOM.getDocument', { depth: 1 });
    const { nodeId } = await p.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    await p.send('DOM.setFileInputFiles', { nodeId, files: [file] });
  };
  /** @param {string} name @param {string} [selector] clip to one element */
  const shot = async (name, selector) => {
    await sleep(320); // let the 260 ms view entrance settle
    let clip;
    if (selector) {
      const box = await p.evaluate(
        `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
          return { x: Math.max(0, r.left + scrollX - 12), y: Math.max(0, r.top + scrollY - 12), width: r.width + 24, height: r.height + 24 }; })()`,
      );
      clip = { ...box, scale: 1 };
    } else {
      await p.evaluate('window.scrollTo(0, 0)');
      const height = await p.evaluate('Math.ceil(document.documentElement.scrollHeight)');
      clip = { x: 0, y: 0, width: o.width, height, scale: 1 };
    }
    const { data } = await p.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
    const file = join(OUT, `${o.tag}-${name}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    shots.push(file);
  };

  // Flow A: on sale (fake config and licence)
  await go(`${o.onSale}app/`);
  const bg = await p.evaluate('getComputedStyle(document.body).backgroundColor');
  consoleLines.push(`[${o.tag}] body background ${bg}`);
  await shot('1-open');

  await pick('#file-input', o.bogusPath);
  await p.waitFor("!document.getElementById('open-errors').hidden || !document.getElementById('view-error').hidden");
  await shot('1b-open-error');

  await pick('#file-input', o.backupPath);
  // The real reader can finish a tiny library before the first poll; the read step is captured when it is seen.
  await p.waitFor("!document.getElementById('view-read').hidden || !document.getElementById('view-preview').hidden");
  if (await p.evaluate("!document.getElementById('view-read').hidden")) {
    await sleep(1300);
    if (await p.evaluate("!document.getElementById('view-read').hidden")) await shot('2-read');
  }

  await p.waitFor("!document.getElementById('view-preview').hidden", 30_000);
  await shot('3-preview');

  // a wrong key, then the synthetic test key
  await p.evaluate(`(() => { const i = document.getElementById('licence-key'); i.value = 'NOT-A-KEY';
    document.getElementById('key-form').requestSubmit(); })()`);
  await p.waitFor("document.getElementById('licence-message').classList.contains('is-bad')");
  await shot('4a-licence-refused', '#unlock');
  await p.evaluate(`(() => { const i = document.getElementById('licence-key'); i.value = 'FT-TEST-0000';
    document.getElementById('key-form').requestSubmit(); })()`);
  await p.waitFor("document.getElementById('licence-message').classList.contains('is-good')");
  await shot('4b-licence-accepted', '#unlock');

  await p.evaluate("document.getElementById('download-btn').click()");
  // A small library exports faster than a frame or two: capture the progress only if it was there to see.
  await p.waitFor(
    "!document.getElementById('export-progress').hidden || !document.getElementById('view-done').hidden || !document.getElementById('export-error').hidden",
  );
  if (await p.evaluate("!document.getElementById('export-progress').hidden")) {
    await sleep(500);
    if (await p.evaluate("!document.getElementById('export-progress').hidden")) await shot('4c-exporting', '#unlock');
  }
  await p.waitFor("!document.getElementById('view-done').hidden || !document.getElementById('export-error').hidden", 30_000);
  if (await p.evaluate("!document.getElementById('export-error').hidden")) {
    consoleLines.push(`[${o.tag}] export error: ${await p.evaluate("document.getElementById('export-error-text').textContent")}`);
    await shot('4d-export-error', '#unlock');
  }
  await p.waitFor("!document.getElementById('view-done').hidden", 30_000);
  await shot('5-done');

  // Flow B: not on sale (the real config and licence modules, or none yet)
  await go(`${o.plain}app/`);
  await pick('#file-input', o.backupPath);
  await p.waitFor("!document.getElementById('view-preview').hidden", 30_000);
  await shot('3b-preview-not-on-sale', '#unlock');

  // Keyboard: Tab into the tree and use the arrow keys (checked, not captured)
  const treeOk = await p.evaluate(`(() => {
    const rows = [...document.querySelectorAll('#tree [role=treeitem]')];
    return rows.length > 0 && rows.filter((r) => r.tabIndex === 0).length === 1;
  })()`);
  consoleLines.push(`[${o.tag}] tree has one tab stop: ${treeOk}`);

  await cdp.send('Target.closeTarget', { targetId });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
