// A minimal Chrome DevTools-protocol client over Node's own WebSocket (no packages), and a headless Chrome
// launcher for the end-to-end run. Development only: nothing here is copied into dist/.
//
// The launcher hard-contains the network: every host name except 127.0.0.1 resolves to "not found"
// (--host-resolver-rules), so even a request the run forgets to intercept can never reach a real payment
// provider or any other site. The licence check is answered by Fetch interception instead (see run.js).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const CHROME = process.env.BCR_E2E_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** @param {number} ms */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Cdp {
  /** @param {WebSocket} ws */
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    /** @type {Map<number, {resolve: (v: any) => void, reject: (e: Error) => void, method: string}>} */
    this.pending = new Map();
    /** @type {Set<(msg: any) => void>} */
    this.listeners = new Set();
    this.closed = false;
    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p?.resolve(msg.result);
      } else {
        for (const listener of [...this.listeners]) {
          try {
            listener(msg);
          } catch {
            // a listener's own bug must not stop the others
          }
        }
      }
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error(`${p.method}: connection closed`));
      this.pending.clear();
    });
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {string} [sessionId]
   * @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  send(method, params = {}, sessionId, timeoutMs = 60_000) {
    if (this.closed) return Promise.reject(new Error(`${method}: connection closed`));
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject, method });
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, timeoutMs);
      timer.unref?.();
    });
  }

  /** @param {(msg: any) => void} fn @returns {() => void} unsubscribe */
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/**
 * Launches headless Chrome with a throw-away profile under `dir`.
 * @param {string} dir  a scratch folder (the profile is made inside it and removed by close())
 * @returns {Promise<{cdp: Cdp, close: () => Promise<void>, version: string}>}
 */
export async function launchChrome(dir) {
  if (!existsSync(CHROME)) throw new Error(`Google Chrome not found at ${CHROME} (set BCR_E2E_CHROME)`);
  const profile = join(dir, 'chrome-profile');
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
      '--disable-default-apps',
      '--disable-domain-reliability',
      '--disable-client-side-phishing-detection',
      '--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication,InterestFeedContentSuggestions',
      '--metrics-recording-only',
      '--no-pings',
      '--mute-audio',
      '--hide-scrollbars',
      // Hard containment: nothing but the local test server can be reached, whatever the page or the run does.
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 300 && !existsSync(portFile) && !exited; i++) await sleep(100);
  if (!existsSync(portFile)) {
    child.kill();
    throw new Error('Chrome did not start (no DevToolsActivePort)');
  }
  let text = '';
  for (let i = 0; i < 50 && !text.includes('\n'); i++) {
    text = await readFile(portFile, 'utf8');
    if (!text.includes('\n')) await sleep(50);
  }
  const [port, path] = text.trim().split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  const cdp = new Cdp(ws);
  const { product } = await cdp.send('Browser.getVersion');
  return {
    cdp,
    version: String(product ?? ''),
    close: async () => {
      try {
        await cdp.send('Browser.close', {}, undefined, 5_000);
      } catch {
        // already gone
      }
      for (let i = 0; i < 50 && !exited; i++) await sleep(100);
      if (!exited) child.kill('SIGKILL');
      await sleep(200);
      await rm(profile, { recursive: true, force: true });
    },
  };
}
