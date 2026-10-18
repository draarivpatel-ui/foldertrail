// tools/build.js (assembles dist/, refuses CSP-breaking or remote HTML) and tools/serve.js (local server that applies
// site/_headers). Builds go into temporary folders, never the repository's dist/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { build, BuildError, checkHtml, checkCss, resolveLocal, REPO_ROOT } from '../tools/build.js';
import { startServer, parseHeaders, headersFor, FALLBACK_CSP } from '../tools/serve.js';

const CLEAN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>T</title>
<link rel="stylesheet" href="../assets/s.css"><link rel="icon" href="/assets/i.svg">
<script type="module" src="../js/app/main.js"></script></head>
<body><svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="100%" height="100%"></rect></svg>
<a href="../">Home</a><a href="mailto:someone@example.invalid">Mail</a><p>Text that mentions https://example.com is fine.</p>
</body></html>`;

/** Makes a throwaway repository with site/ and src/ to build. */
async function fixtureRepo(page = CLEAN_PAGE) {
  const root = await mkdtemp(join(tmpdir(), 'ft-build-'));
  await mkdir(join(root, 'site/app'), { recursive: true });
  await mkdir(join(root, 'site/assets'), { recursive: true });
  await mkdir(join(root, 'src/app'), { recursive: true });
  await mkdir(join(root, 'src/format'), { recursive: true });
  await writeFile(join(root, 'site/app/index.html'), page);
  await writeFile(join(root, 'site/assets/s.css'), '.x { mask-image: url(i.svg); background: url("data:image/png;base64,AA=="); }');
  await writeFile(join(root, 'site/assets/i.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(root, 'site/assets/.DS_Store'), 'junk');
  await writeFile(join(root, 'site/_headers'), '/*\n  X-Test: yes\n');
  await writeFile(join(root, 'src/app/main.js'), 'export {};\n');
  await writeFile(join(root, 'src/app/probe.js'), 'export {};\n');
  await writeFile(join(root, 'src/app/probe.html'), '<style>x</style>');
  await writeFile(join(root, 'src/format/a.js'), 'export const a = 1;\n');
  await writeFile(join(root, 'src/notes.md'), '# not copied\n');
  return root;
}

test('build copies site/ as is and src/*.js to js/, keeping paths; skips dotfiles, probes and non-JS', async () => {
  const root = await fixtureRepo();
  try {
    const result = await build({ root });
    assert.equal(result.outDir, join(root, 'dist'));
    assert.deepEqual(result.files, [
      '_headers',
      'app/index.html',
      'assets/i.svg',
      'assets/s.css',
      'js/app/main.js',
      'js/format/a.js',
    ]);
    assert.equal(await readFile(join(root, 'dist/js/format/a.js'), 'utf8'), 'export const a = 1;\n');
    const top = await readdir(join(root, 'dist'));
    assert.ok(top.includes('.foldertrail-build'), 'the marker that allows the next build to replace it');
    // A second build replaces the first.
    await writeFile(join(root, 'src/format/a.js'), 'export const a = 2;\n');
    await build({ root });
    assert.equal(await readFile(join(root, 'dist/js/format/a.js'), 'utf8'), 'export const a = 2;\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed build leaves the previous output untouched and no staging folder behind', async () => {
  const root = await fixtureRepo();
  try {
    await build({ root });
    await writeFile(join(root, 'site/app/index.html'), CLEAN_PAGE.replace('</body>', '<script>alert(1)</script></body>'));
    await assert.rejects(build({ root }), (error) => {
      assert.ok(error instanceof BuildError);
      assert.match(error.message, /inline script/);
      return true;
    });
    assert.match(await readFile(join(root, 'dist/app/index.html'), 'utf8'), /Text that mentions/);
    assert.ok(!(await readFile(join(root, 'dist/app/index.html'), 'utf8')).includes('alert(1)'));
    const siblings = await readdir(root);
    assert.deepEqual(siblings.filter((name) => name.includes('staging')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('build refuses to replace a folder it did not make, or one that overlaps the sources', async () => {
  const root = await fixtureRepo();
  try {
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'dist/precious.txt'), 'keep me');
    await assert.rejects(build({ root }), /was not made by this script/);
    assert.equal(await readFile(join(root, 'dist/precious.txt'), 'utf8'), 'keep me');
    await assert.rejects(build({ root, outDir: join(root, 'site/out') }), /separate from the site folder/);
    await assert.rejects(build({ root, outDir: root }), BuildError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a link to a local page that is not built yet is a warning, not a failure', async () => {
  const root = await fixtureRepo(CLEAN_PAGE.replace('<a href="../">Home</a>', '<a href="../">Home</a><a href="../privacy/">Privacy</a><a href="#main">Skip</a>'));
  try {
    const result = await build({ root });
    assert.deepEqual(result.warnings, [
      'app/index.html: the link "../" goes to a page that is not in the build yet',
      'app/index.html: the link "../privacy/" goes to a page that is not in the build yet',
    ]);
    await mkdir(join(root, 'site/privacy'), { recursive: true });
    await writeFile(join(root, 'site/privacy/index.html'), '<!doctype html><title>P</title>');
    await writeFile(join(root, 'site/index.html'), '<!doctype html><title>H</title>');
    assert.deepEqual((await build({ root })).warnings, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('build fails when a page points at a local file that is not in the build', async () => {
  const root = await fixtureRepo(CLEAN_PAGE.replace('../assets/s.css', '../assets/missing.css'));
  try {
    await assert.rejects(build({ root }), /missing\.css" does not exist/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('checkHtml accepts a clean page and collects its local resource references', () => {
  const result = checkHtml(CLEAN_PAGE, 'page');
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.localRefs.sort(), ['../assets/s.css', '../js/app/main.js', '/assets/i.svg'].sort());
  assert.deepEqual(result.linkRefs, ['../']);
});

test('checkHtml refuses everything the Content-Security-Policy would block, and remote URLs', () => {
  const cases = [
    ['<script>alert(1)</script>', /inline script/],
    ['<script type="application/ld+json">{}</script>', /inline script/],
    ['<SCRIPT\nsrc="a.js">x</SCRIPT>', /no inline body/],
    ['<style>p{}</style>', /<style> is not allowed/],
    ['<p style="color:red">x</p>', /style="" attribute/],
    ['<p STYLE=color:red>x</p>', /style="" attribute/],
    ['<img src="a.png" onerror="x()">', /inline event handler onerror/],
    ['<button onclick=go()>x</button>', /inline event handler onclick/],
    ['<a href="javascript:alert(1)">x</a>', /javascript: URL/],
    ['<a href="&#106;avascript:alert(1)">x</a>', /javascript: URL/],
    ['<a href="https://example.com/">x</a>', /needs rel="noopener noreferrer"/],
    ['<a href="https://example.com/" rel="noopener">x</a>', /needs rel="noopener noreferrer"/],
    ['<a href="https://example.com/" rel="noreferrer">x</a>', /needs rel="noopener noreferrer"/],
    ['<a href="http://example.com/" rel="noopener noreferrer">x</a>', /remote URL in href/],
    ['<a href="//example.com/" rel="noopener noreferrer">x</a>', /remote URL in href/],
    ['<a href="https:/example.com/" rel="noopener noreferrer">x</a>', /remote URL in href|not a valid/],
    ['<a href="https://example.com/" rel="noopener noreferrer" ping="https://t.example.com/">x</a>', /remote URL in ping/],
    ['<area href="https://example.com/" rel="noopener noreferrer">', /remote URL in href/],
    ['<link rel="noopener noreferrer stylesheet" href="https://fonts.example.com/f.css">', /remote URL in href/],
    ['<img src="https://cdn.example.com/a.png" rel="noopener noreferrer">', /remote URL in src/],
    ['<img src="//cdn.example.com/a.png">', /remote URL in src/],
    ['<img src="\\\\cdn.example.com/a.png">', /remote URL in src/],
    ['<a href="/\\example.com/">x</a>', /remote URL in href/],
    ['<script src="https:cdn.example.com/a.js"></script>', /remote URL in src/],
    ['<img srcset="a.png 1x, https://cdn.example.com/b.png 2x">', /remote URL in srcset/],
    ['<link rel="stylesheet" href="http://fonts.example.com/f.css">', /remote URL in href/],
    ['<form action="https://example.com/collect"></form>', /remote URL in action/],
    ['<iframe src="x.html"></iframe>', /<iframe> is not allowed/],
    ['<base href="/">', /<base> is not allowed/],
    ['<object data="x"></object>', /<object> is not allowed/],
  ];
  for (const [html, pattern] of cases) {
    const { problems } = checkHtml(`<!doctype html><html><body>${html}</body></html>`, 't');
    assert.ok(problems.some((p) => pattern.test(p)), `${html} should fail with ${pattern}; got ${JSON.stringify(problems)}`);
  }
});

test('checkHtml allows a link to another site only as <a href="https://..."> with rel="noopener noreferrer"', async () => {
  const link = '<a class="x" href="https://example.com/a?b=1&amp;c=2" rel="external noreferrer noopener">Source</a>';
  const result = checkHtml(`<!doctype html><html><body><p>${link}</p></body></html>`, 't');
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.externalLinks, ['https://example.com/a?b=1&c=2']);
  assert.deepEqual(result.linkRefs, [], 'not a local page');
  assert.deepEqual(result.localRefs, [], 'not a resource the page loads');
  // Upper-case scheme and entity-encoded scheme are the same https link.
  assert.deepEqual(checkHtml('<a href="HTTPS://example.com/" rel="noopener noreferrer">x</a>').problems, []);
  assert.deepEqual(checkHtml('<a href="&#104;ttps://example.com/" rel="noopener noreferrer">x</a>').problems, []);
  // A whole build with such a link succeeds.
  const root = await fixtureRepo(CLEAN_PAGE.replace('<a href="../">Home</a>', `<a href="../">Home</a>${link}`));
  try {
    const built = await build({ root });
    assert.ok(built.files.includes('app/index.html'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('checkHtml ignores markup inside comments and text that only mentions a URL', () => {
  const html = '<!-- <script>alert(1)</script> <p style="x"> --><p>See https://example.com and <code>&lt;style&gt;</code></p>';
  assert.deepEqual(checkHtml(html).problems, []);
});

test('checkCss refuses remote url() and @import, and collects local url()s', () => {
  const bad = checkCss('@import "https://fonts.example.com/a.css"; .a{background:url(https://example.com/x.png)} .b{mask:url(//cdn.example.com/m.svg)}');
  assert.equal(bad.problems.length, 3);
  const good = checkCss('/* url(https://ignored.example.com) */ .a{mask-image:url(icons/a.svg)} .b{background:url("data:image/png;base64,AA==")}');
  assert.deepEqual(good.problems, []);
  assert.deepEqual(good.localRefs, ['icons/a.svg']);
});

test('resolveLocal resolves relative and root paths the way a browser does (".." stops at the site root)', () => {
  assert.equal(resolveLocal('app/index.html', '../assets/a.css'), 'assets/a.css');
  assert.equal(resolveLocal('app/index.html', '/js/app/main.js?v=1#x'), 'js/app/main.js');
  assert.equal(resolveLocal('assets/app.css', 'icons/a%20b.svg'), 'assets/icons/a b.svg');
  assert.equal(resolveLocal('index.html', '../../etc/passwd'), 'etc/passwd');
});

test('the real site passes every build check (HTML, CSS, references)', async () => {
  const out = await mkdtemp(join(tmpdir(), 'ft-dist-'));
  try {
    const result = await build({ outDir: join(out, 'dist') });
    assert.ok(result.files.includes('app/index.html'));
    assert.ok(result.files.includes('js/app/main.js'));
    assert.ok(result.files.includes('js/app/ui.js'));
    assert.ok(result.files.includes('assets/app.css'));
    assert.ok(!result.files.some((f) => f.includes('probe')), 'the drop probe is a development tool');
    assert.ok(!result.files.some((f) => f.startsWith('tools/') || f.includes('fake-')), 'development fakes never ship');
    const page = await readFile(join(REPO_ROOT, 'site/app/index.html'), 'utf8');
    assert.deepEqual(checkHtml(page, 'site/app/index.html').problems, []);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('the app page carries the non-affiliation footer and keeps Garmin and BaseCamp out of the brand and title prefix', async () => {
  const page = await readFile(join(REPO_ROOT, 'site/app/index.html'), 'utf8');
  assert.match(
    page.replace(/\s+/g, ' '),
    /Foldertrail is an independent tool, not affiliated with, endorsed by, or sponsored by Garmin Ltd\. or its subsidiaries\. Garmin and BaseCamp are trademarks of Garmin Ltd\. or its subsidiaries\./,
  );
  const title = /<title>([^<]*)<\/title>/.exec(page)?.[1] ?? '';
  assert.match(title, /^Foldertrail\b/);
  const brand = /<span class="brand-name">([^<]*)<\/span>/.exec(page)?.[1] ?? '';
  assert.equal(brand, 'Foldertrail');
  for (const svg of ['mark-folder.svg', 'mark-trail.svg', 'favicon.svg']) {
    const text = await readFile(join(REPO_ROOT, 'site/assets', svg), 'utf8');
    assert.ok(!/garmin|basecamp/i.test(text), `${svg} has no Garmin or BaseCamp marks`);
    assert.ok(!/<style|style=|<script|href=/i.test(text), `${svg} has no styles, scripts or links`);
  }
});

// ---------------------------------------------------------------------------------------------
// tools/serve.js

test('parseHeaders reads Netlify-style rules; headersFor applies every match, later rules winning', () => {
  const rules = parseHeaders(
    '# comment\n/*\n  Content-Security-Policy: default-src \'none\'\n  X-A: 1\n\n/app/*\n  X-A: 2\n/js/:dir/worker.js\n  X-W: yes\n  X-W: also\nnot-a-header-line\n  bad header: x\n',
  );
  assert.equal(rules.length, 4);
  const all = headersFor(rules, '/app/index.html');
  assert.equal(all.get('content-security-policy')?.[1], "default-src 'none'");
  assert.equal(all.get('x-a')?.[1], '2');
  assert.equal(headersFor(rules, '/js/app/worker.js').get('x-w')?.[1], 'yes, also');
  assert.equal(headersFor(rules, '/js/app/deep/worker.js').get('x-w'), undefined);
});

/**
 * @param {number} port
 * @param {string} path
 * @param {string} [method]
 * @returns {Promise<{status: number, headers: import('node:http').IncomingHttpHeaders, body: string}>}
 */
function get(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('serve applies _headers to every path (the module worker included), with the right types', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ft-serve-'));
  try {
    await mkdir(join(root, 'dist/app'), { recursive: true });
    await mkdir(join(root, 'dist/js/app'), { recursive: true });
    await writeFile(join(root, 'dist/app/index.html'), '<!doctype html><p>app</p>');
    await writeFile(join(root, 'dist/js/app/worker.js'), 'self.onmessage = () => {};');
    await writeFile(join(root, 'dist/a.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(join(root, 'dist/_headers'), 'should not be served');
    await writeFile(join(root, 'secret.txt'), 'outside');
    const headersFile = join(root, '_headers');
    await writeFile(headersFile, "/*\n  Content-Security-Policy: default-src 'none'; worker-src 'self'\n  X-Content-Type-Options: nosniff\n");
    const server = await startServer({ root: join(root, 'dist'), headersFile });
    try {
      assert.equal(server.usingFallbackCsp, false);
      const worker = await get(server.port, '/js/app/worker.js');
      assert.equal(worker.status, 200);
      assert.equal(worker.headers['content-type'], 'text/javascript; charset=utf-8');
      assert.equal(worker.headers['content-security-policy'], "default-src 'none'; worker-src 'self'");
      assert.equal(worker.headers['x-content-type-options'], 'nosniff');
      const page = await get(server.port, '/app/');
      assert.equal(page.status, 200);
      assert.equal(page.body, '<!doctype html><p>app</p>');
      assert.equal(page.headers['content-security-policy'], "default-src 'none'; worker-src 'self'");
      const redirect = await get(server.port, '/app');
      assert.equal(redirect.status, 301);
      assert.equal(redirect.headers.location, '/app/');
      assert.equal((await get(server.port, '/a.svg')).headers['content-type'], 'image/svg+xml');
      assert.equal((await get(server.port, '/_headers')).status, 404);
      assert.equal((await get(server.port, '/../secret.txt')).status, 404);
      const encoded = await get(server.port, '/%2e%2e/secret.txt');
      assert.ok(encoded.status === 404 || encoded.status === 400);
      assert.notEqual(encoded.body, 'outside');
      assert.equal((await get(server.port, '/missing.js')).status, 404);
      const missing = await get(server.port, '/missing.js');
      assert.equal(missing.headers['content-security-policy'], "default-src 'none'; worker-src 'self'", 'errors carry the policy too');
      assert.equal((await get(server.port, '/app/index.html', 'POST')).status, 405);
      const head = await get(server.port, '/js/app/worker.js', 'HEAD');
      assert.equal(head.status, 200);
      assert.equal(head.body, '');
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('serve answers an unknown path with the site\'s own 404.html and status 404, as Netlify and Cloudflare do', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ft-serve404-'));
  try {
    await mkdir(join(root, 'dist/app'), { recursive: true });
    await writeFile(join(root, 'dist/app/index.html'), '<!doctype html><p>app</p>');
    await writeFile(join(root, 'dist/404.html'), '<!doctype html><title>Not found</title><p>lost</p>');
    const headersFile = join(root, '_headers');
    await writeFile(headersFile, "/*\n  Content-Security-Policy: default-src 'none'\n");
    const server = await startServer({ root: join(root, 'dist'), headersFile });
    try {
      for (const path of ['/nope', '/app/nope.html', '/a/b/c/', '/_headers', '/.hidden']) {
        const res = await get(server.port, path);
        assert.equal(res.status, 404, path);
        assert.equal(res.headers['content-type'], 'text/html; charset=utf-8', path);
        assert.equal(res.body, '<!doctype html><title>Not found</title><p>lost</p>', path);
        assert.equal(res.headers['content-security-policy'], "default-src 'none'", `${path}: the page keeps the policy`);
      }
      assert.equal((await get(server.port, '/nope', 'HEAD')).body, '');
      assert.equal((await get(server.port, '/app/')).status, 200);
    } finally {
      await server.close();
    }
    // Without a 404.html the answer stays plain text.
    await rm(join(root, 'dist/404.html'));
    const bare = await startServer({ root: join(root, 'dist'), headersFile });
    try {
      const res = await get(bare.port, '/nope');
      assert.equal(res.status, 404);
      assert.equal(res.body, 'Not found');
    } finally {
      await bare.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('serve uses the B22 policy when there is no _headers file, and never follows a link out of its folder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ft-serve-'));
  try {
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(join(root, 'dist/index.html'), 'home');
    await writeFile(join(root, 'outside.txt'), 'outside');
    let linked = true;
    try {
      await symlink(join(root, 'outside.txt'), join(root, 'dist/link.txt'));
    } catch {
      linked = false;
    }
    const server = await startServer({ root: join(root, 'dist'), headersFile: join(root, 'nope') });
    try {
      assert.equal(server.usingFallbackCsp, true);
      const home = await get(server.port, '/');
      assert.equal(home.body, 'home');
      assert.equal(home.headers['content-security-policy'], FALLBACK_CSP);
      // The fallback is the very policy site/_headers sets (B22, amended by B38), not a looser copy of it.
      const siteCsp = /Content-Security-Policy:\s*(.+)/.exec(await readFile(join(REPO_ROOT, 'site', '_headers'), 'utf8'))?.[1].trim();
      assert.equal(FALLBACK_CSP, siteCsp);
      if (linked) assert.equal((await get(server.port, '/link.txt')).status, 404);
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('serve can swap in a development file for one URL (the fake worker), still under the policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ft-serve-'));
  try {
    await mkdir(join(root, 'dist/js/app'), { recursive: true });
    await writeFile(join(root, 'dist/js/app/worker.js'), 'real');
    await writeFile(join(root, 'fake.js'), 'fake');
    const server = await startServer({
      root: join(root, 'dist'),
      headersFile: null,
      overrides: { '/js/app/worker.js': join(root, 'fake.js') },
    });
    try {
      const res = await get(server.port, '/js/app/worker.js');
      assert.equal(res.body, 'fake');
      assert.equal(res.headers['content-security-policy'], FALLBACK_CSP);
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
