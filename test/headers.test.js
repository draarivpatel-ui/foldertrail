// Tests for site/_headers: the exact Content-Security-Policy of decision B22 on every path (the module worker
// included), the other security headers, and the rules that keep Cloudflare's and Netlify's comma-joining of
// duplicate headers from corrupting the policy. Then, when tools/serve.js exists, that the local server really
// sends the policy on the worker's URL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { request } from 'node:http';
import { LICENSE_ORIGINS, POLAR_VALIDATE_URL, GUMROAD_VERIFY_URL } from '../src/app/license.js';
import { ALLOWED_ORIGINS } from '../tools/check-no-network.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEADERS_FILE = join(ROOT, 'site', '_headers');

/**
 * Decision B22 as amended by B38 / ARCHITECTURE §10. Change it only together with those decisions.
 * child-src 'self' lets Safari 15.0-15.4 (which does not know worker-src) start the module worker; frame-src 'none'
 * keeps frames refused in browsers that would otherwise fall back to child-src for them. connect-src names the two
 * licence endpoints exactly (a path without a trailing slash matches only that path), not their whole hosts.
 */
const B22_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; " +
  "child-src 'self'; frame-src 'none'; worker-src 'self'; " +
  'connect-src https://api.polar.sh/v1/customer-portal/license-keys/validate https://api.gumroad.com/v2/licenses/verify; ' +
  "form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

const WORKER_PATH = '/js/app/worker.js';

/**
 * Parse the _headers format the way the hosts document it: a path line at column 0, then indented "Name: value"
 * lines; lines starting with # are comments. Problems are collected, not ignored.
 * @param {string} text
 */
function parse(text) {
  /** @type {{pattern: string, line: number, headers: {name: string, value: string, line: number}[]}[]} */
  const rules = [];
  /** @type {string[]} */
  const problems = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    if (raw.length > 2000) problems.push(`line ${lineNo} is longer than 2,000 characters (Cloudflare's limit)`);
    if (raw.trim() === '' || /^#/.test(raw)) return;
    if (/^\s*#/.test(raw)) {
      problems.push(`line ${lineNo}: indented comment (keep comments at column 0)`);
      return;
    }
    if (!/^\s/.test(raw)) {
      if (!raw.startsWith('/')) problems.push(`line ${lineNo}: a rule must start with "/"`);
      rules.push({ pattern: raw.trim(), line: lineNo, headers: [] });
      return;
    }
    const current = rules[rules.length - 1];
    if (!current) {
      problems.push(`line ${lineNo}: header before any path`);
      return;
    }
    const m = /^\s+([A-Za-z0-9-]+):\s*(.*)$/.exec(raw);
    if (!m) {
      problems.push(`line ${lineNo}: not a "Name: value" line`);
      return;
    }
    current.headers.push({ name: m[1], value: m[2].trim(), line: lineNo });
  });
  return { rules, problems };
}

/** Splat and placeholder matching as Cloudflare and Netlify describe it. */
function matches(pattern, path) {
  let src = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') src += '.*';
    else if (ch === ':' && /[A-Za-z]/.test(pattern[i + 1] ?? '')) {
      while (/\w/.test(pattern[i + 1] ?? '')) i++;
      src += '[^/]+';
    } else src += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${src}$`).test(path);
}

/** Every header that applies to a path, joined the way the hosts join duplicates. */
function effective(rules, path) {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  for (const r of rules) {
    if (!matches(r.pattern, path)) continue;
    for (const h of r.headers) {
      const k = h.name.toLowerCase();
      out.set(k, [...(out.get(k) ?? []), h.value]);
    }
  }
  return new Map([...out].map(([k, v]) => [k, v.join(', ')]));
}

const text = readFileSync(HEADERS_FILE, 'utf8');
const { rules, problems } = parse(text);

test('_headers parses cleanly and stays inside the hosts\' limits', () => {
  assert.deepEqual(problems, []);
  assert.ok(rules.length >= 1 && rules.length <= 100, 'between 1 and 100 rules');
  for (const r of rules) assert.ok(r.headers.length > 0, `rule ${r.pattern} (line ${r.line}) sets no headers`);
});

test('the CSP is exactly the B22 policy, set once, on /*', () => {
  const csp = rules.flatMap((r) => r.headers.filter((h) => h.name.toLowerCase() === 'content-security-policy').map((h) => ({ ...h, rule: r.pattern })));
  assert.equal(csp.length, 1, 'exactly one Content-Security-Policy line (two would be comma-joined by the host)');
  assert.equal(csp[0].rule, '/*');
  assert.equal(csp[0].value, B22_CSP);
  assert.equal(rules.filter((r) => r.pattern === '/*').length, 1, 'one /* rule');
  assert.ok(!/content-security-policy-report-only/i.test(text), 'no report-only policy');
});

test('no header name is set by two rules (Cloudflare and Netlify would comma-join them)', () => {
  /** @type {Map<string, string>} */
  const owner = new Map();
  for (const r of rules) {
    const seenHere = new Set();
    for (const h of r.headers) {
      const k = h.name.toLowerCase();
      assert.ok(!seenHere.has(k), `${h.name} appears twice in rule ${r.pattern}`);
      seenHere.add(k);
      assert.ok(!owner.has(k), `${h.name} is set by both ${owner.get(k)} and ${r.pattern}`);
      owner.set(k, r.pattern);
    }
  }
});

test('every path the site serves gets the exact policy and the security headers, the worker included', () => {
  const paths = ['/', '/index.html', '/app/', '/app/index.html', WORKER_PATH, '/js/app/main.js', '/js/format/unzip.js',
    '/assets/site.css', '/privacy/', '/does-not-exist', '/a%20b/c.svg'];
  for (const p of paths) {
    const h = effective(rules, p);
    assert.equal(h.get('content-security-policy'), B22_CSP, `CSP on ${p}`);
    assert.equal(h.get('x-content-type-options'), 'nosniff', `nosniff on ${p}`);
    assert.equal(h.get('referrer-policy'), 'no-referrer', `Referrer-Policy on ${p}`);
    assert.equal(h.get('cross-origin-opener-policy'), 'same-origin', `COOP on ${p}`);
    assert.ok(h.has('cache-control'), `Cache-Control on ${p}`);
    assert.ok(h.has('permissions-policy'), `Permissions-Policy on ${p}`);
  }
});

test('the CSP has no loophole: no unsafe-*, no wildcard, no bare scheme, no http:, nothing beyond B22', () => {
  const value = effective(rules, WORKER_PATH).get('content-security-policy') ?? '';
  const directives = new Map(value.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
    const [name, ...values] = d.split(/\s+/);
    return [name, values];
  }));
  assert.deepEqual([...directives.keys()], ['default-src', 'script-src', 'style-src', 'img-src', 'font-src', 'child-src',
    'frame-src', 'worker-src', 'connect-src', 'form-action', 'base-uri', 'frame-ancestors']);
  for (const [name, values] of directives) {
    for (const v of values) {
      if (name === 'img-src' && v === 'data:') continue; // B22 allows inline data: images, nothing else
      assert.doesNotMatch(v, /unsafe-|^\*$|^[a-z-]+:$|^http:|^ws:|\*/, `${name} ${v}`);
    }
  }
  assert.deepEqual(directives.get('default-src'), ["'none'"]);
  assert.deepEqual(directives.get('script-src'), ["'self'"]);
  assert.deepEqual(directives.get('worker-src'), ["'self'"]);
  assert.deepEqual(directives.get('child-src'), ["'self'"], 'Safari 15.0-15.4 checks workers against child-src');
  assert.deepEqual(directives.get('frame-src'), ["'none'"], 'frames stay refused although child-src allows self');
});

test('connect-src names exactly the two licence endpoints, on the origins the licence module and the network checker name', () => {
  const connect = /connect-src ([^;]+)/.exec(B22_CSP)?.[1].trim().split(/\s+/) ?? [];
  // Exact URLs, not whole hosts: an injected script could otherwise write data to other endpoints on those hosts
  // (Polar's activate endpoint stores free-form label and meta fields).
  assert.deepEqual([...connect].sort(), [POLAR_VALIDATE_URL, GUMROAD_VERIFY_URL].sort());
  for (const token of connect) {
    const url = new URL(token);
    assert.equal(url.search, '', `${token}: no query`);
    assert.ok(!url.pathname.endsWith('/'), `${token}: a trailing slash would allow every path below it`);
  }
  assert.deepEqual(connect.map((t) => new URL(t).origin).sort(), [...LICENSE_ORIGINS].sort());
  assert.deepEqual([...ALLOWED_ORIGINS].sort(), [...LICENSE_ORIGINS].sort());
});

test('Permissions-Policy denies camera, microphone, geolocation and other device access, and leaves the clipboard', () => {
  const pp = effective(rules, '/').get('permissions-policy') ?? '';
  for (const f of ['camera', 'microphone', 'geolocation', 'usb', 'serial', 'bluetooth', 'hid', 'midi', 'payment']) {
    assert.match(pp, new RegExp(`(^|, )${f}=\\(\\)(,|$)`), `${f}=()`);
  }
  assert.ok(!/clipboard/.test(pp), 'the Copy-path button needs clipboard-write');
  assert.match(pp, /^[a-z-]+=\(\)(, [a-z-]+=\(\))*$/, 'every entry is name=() (deny)');
});

test('caching never pins an unhashed file: no long max-age, no immutable', () => {
  for (const r of rules) {
    for (const h of r.headers.filter((x) => x.name.toLowerCase() === 'cache-control')) {
      assert.ok(!/immutable/.test(h.value), `${r.pattern}: immutable`);
      const age = /max-age=(\d+)/.exec(h.value);
      assert.ok(age && Number(age[1]) <= 3600, `${r.pattern}: max-age must be at most an hour, got "${h.value}"`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The local server (tools/serve.js, written by the UI work) must send the same policy on the worker URL.

/** @returns {Promise<{status: number, headers: import('node:http').IncomingHttpHeaders}>} */
function head(url) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

const SERVE = join(ROOT, 'tools', 'serve.js');

test('tools/serve.js sends the exact B22 policy on the worker URL, the page and a stylesheet', async (t) => {
  if (!existsSync(SERVE)) {
    t.skip('tools/serve.js does not exist yet (it belongs to the UI work); nothing to check');
    return;
  }
  const mod = await import(pathToFileURL(SERVE).href);
  if (typeof mod.startServer !== 'function') {
    t.skip('tools/serve.js does not export startServer({root, headersFile, port}); cannot start it from a test');
    return;
  }
  // Serve a throwaway folder shaped like dist/, so the test needs no build and never touches the real dist/.
  const root = mkdtempSync(join(tmpdir(), 'ft-headers-'));
  try {
    mkdirSync(join(root, 'js', 'app'), { recursive: true });
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>t</title>');
    writeFileSync(join(root, 'js', 'app', 'worker.js'), 'export {};\n');
    writeFileSync(join(root, 'assets', 'site.css'), 'body{}\n');
    const server = await mod.startServer({ root, headersFile: HEADERS_FILE, port: 0 });
    try {
      assert.equal(server.usingFallbackCsp, false, 'the server read site/_headers instead of its fallback policy');
      for (const p of [WORKER_PATH, '/', '/assets/site.css', '/missing.js']) {
        const res = await head(new URL(p.slice(1), server.url).href);
        if (p !== '/missing.js') assert.equal(res.status, 200, `status for ${p}`);
        assert.equal(res.headers['content-security-policy'], B22_CSP, `CSP on ${p}`);
        assert.equal(res.headers['x-content-type-options'], 'nosniff', `nosniff on ${p}`);
      }
      const worker = await head(new URL(WORKER_PATH.slice(1), server.url).href);
      assert.match(String(worker.headers['content-type']), /^text\/javascript\b/, 'a module worker needs a JavaScript MIME type');
    } finally {
      await server.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
