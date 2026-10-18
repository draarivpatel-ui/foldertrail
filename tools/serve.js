#!/usr/bin/env node
// A tiny local static server for the built site (dist/), for development and the headless-browser checks.
// Zero dependencies (node:http). It listens on 127.0.0.1 only.
//
// Every response carries the headers that site/_headers (Netlify's format, decision B22, ARCHITECTURE §10)
// gives its path, so the page AND the module worker are tested under the real Content-Security-Policy. That
// file belongs to the licence work; this server only reads it. When it is missing, the policy from decision
// B22 is applied instead, and the server says so when it starts.
//
// Usage: node tools/serve.js [--port 8787] [--root dist] [--headers site/_headers]

import { createServer } from 'node:http';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

/** The policy of decision B22 (amended by B38), used only when there is no _headers file to read. */
export const FALLBACK_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; " +
  "child-src 'self'; frame-src 'none'; worker-src 'self'; " +
  'connect-src https://api.polar.sh/v1/customer-portal/license-keys/validate https://api.gumroad.com/v2/licenses/verify; ' +
  "form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

/** @type {Record<string, string>} */
export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.pdf': 'application/pdf',
};

/**
 * @typedef {object} HeaderRule
 * @property {string} pattern
 * @property {RegExp} re
 * @property {[string, string][]} headers
 */

/**
 * Parses a Netlify-style _headers file: a path line (no leading space), then indented "Name: value" lines.
 * "#" starts a comment line. "*" matches anything (a "splat"), ":name" one path segment.
 * @param {string} text
 * @returns {HeaderRule[]}
 */
export function parseHeaders(text) {
  /** @type {HeaderRule[]} */
  const rules = [];
  /** @type {HeaderRule|null} */
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      const pattern = raw.trim();
      current = { pattern, re: patternToRegExp(pattern), headers: [] };
      rules.push(current);
      continue;
    }
    if (!current) continue;
    const line = raw.trim();
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!/^[A-Za-z0-9-]+$/.test(name) || /[\r\n]/.test(value)) continue;
    // A long value may be split over several indented lines that repeat the name: join them as Netlify does.
    const existing = current.headers.find(([n]) => n.toLowerCase() === name.toLowerCase());
    if (existing) existing[1] = `${existing[1]}, ${value}`;
    else current.headers.push([name, value]);
  }
  return rules;
}

/** @param {string} pattern */
function patternToRegExp(pattern) {
  let source = '';
  const path = pattern.split(/[?#]/)[0];
  for (let i = 0; i < path.length; i++) {
    const ch = path[i];
    if (ch === '*') source += '.*';
    else if (ch === ':' && /[A-Za-z]/.test(path[i + 1] ?? '')) {
      while (/[A-Za-z0-9_]/.test(path[i + 1] ?? '')) i++;
      source += '[^/]+';
    } else source += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/**
 * The headers for a path: every matching rule applies, in file order; a later rule's value wins for a name.
 * @param {HeaderRule[]} rules
 * @param {string} pathname
 * @returns {Map<string, [string, string]>}  keyed by lower-case name
 */
export function headersFor(rules, pathname) {
  /** @type {Map<string, [string, string]>} */
  const out = new Map();
  for (const rule of rules) {
    if (!rule.re.test(pathname)) continue;
    for (const [name, value] of rule.headers) out.set(name.toLowerCase(), [name, value]);
  }
  return out;
}

/**
 * @typedef {object} ServeOptions
 * @property {string} [root]         folder to serve (default <repo>/dist)
 * @property {string|null} [headersFile]  default <repo>/site/_headers; null to use only the fallback policy
 * @property {number} [port]         0 picks a free port (default)
 * @property {string} [host]         default 127.0.0.1
 * @property {Record<string, string>} [overrides]  URL path -> local file served instead (development only)
 * @property {Record<string, string>} [mounts]     URL prefix ("/dev/") -> local folder (development only)
 * @property {(line: string) => void} [log]
 */

/**
 * Starts the server.
 * @param {ServeOptions} [options]
 * @returns {Promise<{port: number, url: string, close: () => Promise<void>, usingFallbackCsp: boolean}>}
 */
export async function startServer(options = {}) {
  const root = await realpath(resolve(options.root ?? join(REPO_ROOT, 'dist')));
  const headersFile = options.headersFile === undefined ? join(REPO_ROOT, 'site', '_headers') : options.headersFile;
  const host = options.host ?? '127.0.0.1';
  const log = options.log ?? (() => {});
  const overrides = new Map(Object.entries(options.overrides ?? {}).map(([k, v]) => [k, resolve(v)]));
  /** @type {[string, string][]} */
  const mounts = [];
  for (const [prefix, dir] of Object.entries(options.mounts ?? {})) mounts.push([prefix, await realpath(resolve(dir))]);

  /** Read per request, so an edit to _headers shows up without a restart. */
  const loadRules = async () => {
    if (headersFile === null) return { rules: [], fallback: true };
    try {
      const rules = parseHeaders(await readFile(headersFile, 'utf8'));
      return { rules, fallback: false };
    } catch {
      return { rules: [], fallback: true };
    }
  };
  const initial = await loadRules();

  const server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch {
      if (!res.headersSent) send(res, 500, 'Internal error', { 'content-type': 'text/plain; charset=utf-8' });
      else res.destroy();
    }
  });

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handle(req, res) {
    const { rules, fallback } = await loadRules();
    let pathname;
    /** The path as it came in, still percent-encoded: the only form that is safe to echo in a Location header. */
    let rawPath;
    try {
      rawPath = new URL(req.url ?? '/', 'http://localhost').pathname;
      pathname = decodeURIComponent(rawPath);
    } catch {
      return send(res, 400, 'Bad request', baseHeaders(rules, fallback, '/'));
    }
    const headers = baseHeaders(rules, fallback, pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'Method not allowed', { ...headers, allow: 'GET, HEAD' });
    }
    if (pathname.includes('\0') || pathname.split('/').some((part) => part === '..')) {
      return send(res, 400, 'Bad request', headers);
    }

    /** @type {string|null} */
    let file = overrides.get(pathname) ?? null;
    if (file === null) {
      let base = root;
      let rel = pathname;
      for (const [prefix, dir] of mounts) {
        if (pathname.startsWith(prefix)) {
          base = dir;
          rel = pathname.slice(prefix.length - 1);
          break;
        }
      }
      const parts = rel.split('/').filter(Boolean);
      // Netlify does not serve its own config files, and dotfiles are never served.
      if (parts.some((part) => part.startsWith('.')) || ['_headers', '_redirects'].includes(parts[parts.length - 1] ?? '')) {
        return notFound(res, headers, req.method);
      }
      const candidate = join(base, ...parts);
      let info;
      try {
        info = await stat(candidate);
      } catch {
        return notFound(res, headers, req.method);
      }
      if (info.isDirectory()) {
        if (!pathname.endsWith('/')) {
          // From the encoded path, with one leading slash: "/%2Fapp" must not become "//app/", which a browser
          // reads as a link to another host.
          return send(res, 301, '', { ...headers, location: `/${rawPath.replace(/^[/\\]+/, '')}/` });
        }
        file = join(candidate, 'index.html');
      } else file = candidate;
      // Symbolic links must not lead out of the served folder.
      let real;
      try {
        real = await realpath(file);
      } catch {
        return notFound(res, headers, req.method);
      }
      if (real !== base && !real.startsWith(base + sep)) return notFound(res, headers, req.method);
      file = real;
    }

    let handle;
    try {
      handle = await open(file, 'r');
    } catch {
      return notFound(res, headers, req.method);
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) return notFound(res, headers, req.method);
      const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
      res.writeHead(200, { ...headers, 'content-type': type, 'content-length': String(info.size) });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const body = await handle.readFile();
      res.end(body);
      log(`200 ${pathname}`);
    } finally {
      await handle.close();
    }
  }

  /**
   * A 404 with the site's own 404.html when the served folder has one (Netlify and Cloudflare do the same), so a local
   * preview shows the real page; plain text otherwise.
   * @param {import('node:http').ServerResponse} res
   * @param {Record<string, string>} headers
   * @param {string|undefined} method
   */
  async function notFound(res, headers, method) {
    /** @type {Buffer|null} */
    let page = null;
    try {
      const file = await realpath(join(root, '404.html'));
      if (file.startsWith(root + sep) && (await stat(file)).isFile()) page = await readFile(file);
    } catch {
      page = null;
    }
    if (page === null) return send(res, 404, 'Not found', headers);
    res.writeHead(404, { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-length': String(page.length) });
    res.end(method === 'HEAD' ? undefined : page);
    log('404 (404.html)');
  }

  /**
   * @param {HeaderRule[]} rules
   * @param {boolean} fallback
   * @param {string} pathname
   * @returns {Record<string, string>}
   */
  function baseHeaders(rules, fallback, pathname) {
    /** @type {Record<string, string>} */
    const out = { 'cache-control': 'no-store' };
    if (fallback) out['content-security-policy'] = FALLBACK_CSP;
    for (const [, [name, value]] of headersFor(rules, pathname)) out[name.toLowerCase()] = value;
    return out;
  }

  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => resolveListen(undefined));
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    url: `http://${host}:${port}/`,
    usingFallbackCsp: initial.fallback,
    close: () =>
      new Promise((resolveClose) => {
        server.closeAllConnections?.();
        server.close(() => resolveClose(undefined));
      }),
  };
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} body
 * @param {Record<string, string>} headers
 */
function send(res, status, body, headers) {
  res.writeHead(status, { ...headers, 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

// ---------------------------------------------------------------------------------------------
// CLI

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  /** @param {string} flag */
  const value = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const port = Number(value('--port') ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('Usage: node tools/serve.js [--port 8787] [--root dist] [--headers site/_headers]');
    process.exit(2);
  }
  const server = await startServer({
    port,
    root: value('--root'),
    headersFile: value('--headers'),
    log: (line) => console.log(line),
  });
  console.log(`Serving ${value('--root') ?? 'dist'} at ${server.url}  (the app is at ${server.url}app/)`);
  if (server.usingFallbackCsp) console.log('No site/_headers found: every response gets the decision B22 policy instead.');
}
