// Tests for the public pages in site/: every page (the converter's page included) must keep the
// Content-Security-Policy rules, carry the non-affiliation line, keep its headings in order and its links working;
// the pages written for the site (landing, guide, FAQ, privacy, 404) also need Open Graph tags, a link to the
// privacy page, and price and sale wording that matches src/config.js. Reads files only; never builds or serves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkHtml, resolveLocal, scanTags } from '../tools/build.js';
import { CONFIG, isConfigured } from '../src/config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const SRC = join(ROOT, 'src');

/** The pages written for the public site; app/index.html belongs to the converter. */
const SITE_PAGES = ['index.html', 'guide/index.html', 'faq/index.html', 'privacy/index.html', '404.html'];

const NON_AFFILIATION = [
  `${CONFIG.brand} is an independent tool, not affiliated with, endorsed by, or sponsored by Garmin Ltd. or its subsidiaries.`,
  'Garmin and BaseCamp are trademarks of Garmin Ltd. or its subsidiaries.',
];

/**
 * Every file under dir, "/"-separated and relative to it; dotfiles are skipped, as tools/build.js does.
 * @param {string} dir
 * @returns {string[]}
 */
function listFiles(dir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} rel */
  const walk = (rel) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) out.push(child);
    }
  };
  walk('');
  return out.sort();
}

/** What tools/build.js puts in dist/: site/ as it is, and src/**.js under js/. */
const BUILT = new Set([
  ...listFiles(SITE),
  ...listFiles(SRC)
    .filter((f) => f.endsWith('.js'))
    .map((f) => `js/${f}`),
]);
const PAGES = listFiles(SITE).filter((f) => f.endsWith('.html'));

/** @type {Map<string, string>} */
const cache = new Map();
/** @param {string} rel */
function read(rel) {
  if (!cache.has(rel)) cache.set(rel, readFileSync(join(SITE, rel), 'utf8'));
  return /** @type {string} */ (cache.get(rel));
}

/**
 * A built path for a reference, folders served as their index.html, or null when it is not in the build.
 * @param {string} target  from resolveLocal
 */
function builtFile(target) {
  if (BUILT.has(target)) return target;
  const asDir = target === '' || target.endsWith('/') ? `${target}index.html` : `${target}/index.html`;
  return BUILT.has(asDir) ? asDir : null;
}

/** @param {string} html */
function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Visible text, roughly: no comments, scripts or tags; a few entities decoded; whitespace collapsed.
 * @param {string} html
 */
function textOf(html) {
  return stripComments(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** @param {string} html @param {string} element */
function section(html, element) {
  const m = new RegExp(`<${element}\\b[\\s\\S]*?</${element}>`, 'i').exec(stripComments(html));
  return m ? m[0] : '';
}

/** @param {string} html @param {string} key  "name=description" or "property=og:title" */
function meta(html, key) {
  const [attr, value] = key.split('=');
  const tag = scanTags(html).find((t) => t.name === 'meta' && t.attrs.get(attr) === value);
  return tag ? tag.attrs.get('content') : undefined;
}

/** @param {string} html */
function ids(html) {
  return new Set(scanTags(stripComments(html)).map((t) => t.attrs.get('id')).filter((id) => id !== undefined));
}

/** Every href and src in a page, comments skipped. @param {string} html */
function references(html) {
  /** @type {string[]} */
  const refs = [];
  for (const tag of scanTags(stripComments(html))) {
    if (tag.closing) continue;
    for (const attr of ['href', 'src']) {
      const value = tag.attrs.get(attr);
      if (value !== undefined) refs.push(value.trim());
    }
  }
  return refs;
}

test('the site has the pages this test expects', () => {
  for (const page of SITE_PAGES) assert.ok(PAGES.includes(page), `site/${page} is missing`);
  assert.ok(PAGES.includes('app/index.html'), 'site/app/index.html is missing');
});

test('every page passes the build checks: no inline script or style, no remote URL', () => {
  for (const page of PAGES) {
    const { problems } = checkHtml(read(page), page);
    assert.deepEqual(problems, [], `site/${page}`);
  }
});

test('every page declares its language, charset, viewport and a meta description', () => {
  for (const page of PAGES) {
    const html = read(page);
    const htmlTag = scanTags(html).find((t) => t.name === 'html');
    assert.equal(htmlTag?.attrs.get('lang'), 'en', `site/${page}: <html lang="en">`);
    assert.ok(scanTags(html).some((t) => t.name === 'meta' && t.attrs.get('charset')?.toLowerCase() === 'utf-8'), `site/${page}: charset`);
    assert.ok(meta(html, 'name=viewport'), `site/${page}: viewport`);
    const description = meta(html, 'name=description') ?? '';
    assert.ok(description.length >= 50 && description.length <= 170, `site/${page}: meta description of 50-170 characters (has ${description.length})`);
  }
});

test('every title starts with the brand, and the brand never names Garmin or BaseCamp', () => {
  assert.doesNotMatch(CONFIG.brand, /garmin|base\s*camp/i);
  for (const page of PAGES) {
    const title = textOf(/<title>([\s\S]*?)<\/title>/i.exec(read(page))?.[1] ?? '');
    const prefix = title.split(' · ')[0];
    assert.equal(prefix, CONFIG.brand, `site/${page}: title "${title}" starts with "${CONFIG.brand} · "`);
    assert.ok(title.length > CONFIG.brand.length + 3, `site/${page}: the title says what the page is`);
  }
});

test('every page carries the non-affiliation line in its footer', () => {
  for (const page of PAGES) {
    const footer = textOf(section(read(page), 'footer'));
    for (const sentence of NON_AFFILIATION) assert.ok(footer.includes(sentence), `site/${page}: footer says "${sentence}"`);
  }
});

test('headings start at h1 and never skip a level', () => {
  for (const page of PAGES) {
    const levels = [...stripComments(read(page)).matchAll(/<h([1-6])\b/gi)].map((m) => Number(m[1]));
    assert.ok(levels.length > 0 && levels[0] === 1, `site/${page}: the first heading is an h1`);
    for (let i = 1; i < levels.length; i++) {
      assert.ok(levels[i] <= levels[i - 1] + 1, `site/${page}: h${levels[i - 1]} is followed by h${levels[i]}`);
    }
    if (SITE_PAGES.includes(page)) assert.equal(levels.filter((l) => l === 1).length, 1, `site/${page}: exactly one h1`);
  }
});

/**
 * The links a page makes to other sites: <a href="https://..."> only, which tools/build.js allows with
 * rel="noopener noreferrer". A click is the user's own navigation; nothing is loaded from those sites.
 * @param {string} html
 * @returns {{href: string, rel: string[]}[]}
 */
function outsideLinks(html) {
  return scanTags(stripComments(html))
    .filter((t) => !t.closing && t.name === 'a' && /^\s*https:\/\//i.test(t.attrs.get('href') ?? ''))
    .map((t) => ({ href: (t.attrs.get('href') ?? '').trim(), rel: (t.attrs.get('rel') ?? '').toLowerCase().split(/\s+/) }));
}

test('every local link and resource exists in the build, anchors included', () => {
  for (const page of PAGES) {
    const html = read(page);
    const outside = new Set(outsideLinks(html).map((l) => l.href));
    for (const ref of references(html)) {
      if (ref === '' || ref === '#' || /^(?:mailto:|data:)/i.test(ref)) continue;
      if (outside.has(ref)) continue; // a link to another site, checked in the next test
      assert.doesNotMatch(ref, /^(?:[a-z][a-z0-9+.-]*:)?\/\//i, `site/${page}: remote reference ${ref}`);
      const [path, fragment] = ref.split('#');
      let file = page;
      if (path !== '') {
        const target = resolveLocal(page, path);
        assert.notEqual(target, null, `site/${page}: "${ref}" climbs out of the site`);
        const found = builtFile(/** @type {string} */ (target));
        assert.ok(found, `site/${page}: "${ref}" is not in the build`);
        file = /** @type {string} */ (found);
      }
      if (fragment && file.endsWith('.html')) {
        assert.ok(ids(read(file)).has(decodeURIComponent(fragment)), `site/${page}: "${ref}" points at a missing id in ${file}`);
      }
    }
  }
});

test('links to other sites are https <a> links with rel="noopener noreferrer", and nothing else points off the site', () => {
  for (const page of PAGES) {
    for (const link of outsideLinks(read(page))) {
      const url = new URL(link.href);
      assert.equal(url.protocol, 'https:', `site/${page}: ${link.href}`);
      assert.ok(link.rel.includes('noopener') && link.rel.includes('noreferrer'), `site/${page}: ${link.href} needs rel="noopener noreferrer"`);
    }
  }
});

test('the guide’s sources are real links to each source, and the guide no longer says the site has no links', () => {
  const html = read('guide/index.html');
  const list = /<ol class="sources">([\s\S]*?)<\/ol>/.exec(stripComments(html))?.[1] ?? '';
  const items = [...list.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]);
  assert.ok(items.length >= 10, `the guide lists its sources (found ${items.length})`);
  for (const item of items) {
    const links = outsideLinks(item);
    assert.equal(links.length, 1, `one link per source: ${textOf(item).slice(0, 80)}`);
    const shown = textOf(item);
    const { host } = new URL(links[0].href);
    assert.ok(shown.includes(host), `the address is still written out (${host}), so it can be read and printed`);
  }
  assert.doesNotMatch(textOf(html), /doesn’t link to other sites|does not link to other sites/);
});

test('the converter’s footer links to the privacy page and the other pages, like every site page', () => {
  const page = 'app/index.html';
  const html = read(page);
  const targets = references(section(html, 'footer')).map((ref) => {
    const target = resolveLocal(page, ref.split('#')[0]);
    return target === null ? null : builtFile(target);
  });
  for (const expected of ['privacy/index.html', 'guide/index.html', 'faq/index.html']) {
    assert.ok(targets.includes(expected), `site/${page}: footer links to ${expected}`);
  }
  // The footer links are styled by base.css, the one stylesheet every page loads (the converter skips site.css).
  const base = readFileSync(join(SITE, 'assets/base.css'), 'utf8');
  assert.match(base, /\.footer-nav\s*\{/, 'base.css styles .footer-nav');
});

test('every page says the same about the license check: the key and a product ID, re-checked once per browser session', () => {
  for (const page of ['index.html', 'faq/index.html', 'privacy/index.html']) {
    const text = textOf(read(page));
    assert.match(text, /license key and Foldertrail’s (?:public )?product ID/, `site/${page}: what is sent`);
    assert.match(text, /once per browser session/, `site/${page}: a saved key is checked again when the converter opens`);
  }
});

test('docs/ARCHITECTURE.md quotes the header rule of site/_headers exactly, and names the files that exist', () => {
  const doc = readFileSync(join(ROOT, 'docs/ARCHITECTURE.md'), 'utf8');
  const headers = readFileSync(join(SITE, '_headers'), 'utf8');
  const rule = headers.slice(headers.indexOf('/*\n')).trimEnd();
  const csp = /^\s*Content-Security-Policy: (.+)$/m.exec(rule)?.[1] ?? '';
  assert.ok(csp.length > 0, 'site/_headers sets a Content-Security-Policy');
  const blocks = [...doc.matchAll(/```\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  assert.ok(blocks.includes(rule), 'ARCHITECTURE.md §10 has the /* rule of site/_headers, character for character');
  for (const block of blocks.filter((b) => /Content-Security-Policy:/.test(b))) {
    assert.ok(block.includes(`Content-Security-Policy: ${csp}`), 'no other, different policy is quoted');
  }
  for (const stale of ['licence.js', 'check-no-network.mjs', 'gdb188.js', 'chunked.js', 'bytes.js']) {
    assert.ok(!doc.includes(stale), `ARCHITECTURE.md names ${stale}, which does not exist`);
  }
  for (const real of ['src/app/license.js', 'tools/check-no-network.js']) {
    assert.ok(doc.includes(real), `ARCHITECTURE.md names ${real}`);
    assert.ok(readFileSync(join(ROOT, real)), `${real} exists`);
  }
  assert.match(doc.replace(/\s+/g, ' '), /An `export` must reuse the `id` of the `parse`/, 'the worker protocol rule is written down');
});

test('the pages say road-following routes are not converted (the reader leaves them out), never that they become straight lines', () => {
  for (const page of ['index.html', 'faq/index.html']) {
    const text = textOf(read(page));
    assert.match(text, /straight lines/, `site/${page}: routes are straight lines through their via points`);
    assert.match(text, /calculated along roads aren’t converted/, `site/${page}: says road-following routes are not converted`);
    assert.doesNotMatch(text, /not the road-following line|road-following line BaseCamp showed isn’t converted, so/, `site/${page}`);
  }
});

test('every page is in US English', () => {
  const british = /\b(?:licences?|cancell(?:ed|ing)|colours?|metres?|organis\w*|normalis\w*|recognis\w*|favourit\w*|behaviour\w*|centres?|catalogues?|analys(?:e|ed|ing)|whilst|amongst|grey)\b/i;
  for (const page of PAGES) assert.doesNotMatch(textOf(read(page)), british, `site/${page}`);
});

test('the site pages have Open Graph tags without absolute URLs, and any og:image resolves', () => {
  for (const page of PAGES) {
    const html = read(page);
    const image = meta(html, 'property=og:image');
    if (image !== undefined) {
      assert.doesNotMatch(image, /^(?:[a-z][a-z0-9+.-]*:)?\/\//i, `site/${page}: og:image must be relative`);
      const target = resolveLocal(page, image);
      assert.ok(target !== null && builtFile(target), `site/${page}: og:image ${image} exists`);
    }
    const url = meta(html, 'property=og:url');
    assert.equal(url, undefined, `site/${page}: no og:url until the domain is known (the build forbids absolute URLs)`);
  }
  for (const page of SITE_PAGES.filter((p) => p !== '404.html')) {
    const html = read(page);
    for (const key of ['og:type', 'og:title', 'og:description', 'og:site_name']) {
      assert.ok(meta(html, `property=${key}`), `site/${page}: ${key}`);
    }
    assert.equal(meta(html, 'property=og:site_name'), CONFIG.brand);
  }
});

test('every site page links to the converter and the privacy page, and loads the shared stylesheets in order', () => {
  for (const page of SITE_PAGES) {
    const html = read(page);
    const footerTargets = references(section(html, 'footer')).map((ref) => {
      const target = resolveLocal(page, ref.split('#')[0]);
      return target === null ? null : builtFile(target);
    });
    assert.ok(footerTargets.includes('privacy/index.html'), `site/${page}: footer links to the privacy page`);
    assert.ok(footerTargets.includes('app/index.html'), `site/${page}: footer links to the converter`);
    const sheets = scanTags(html)
      .filter((t) => t.name === 'link' && t.attrs.get('rel') === 'stylesheet')
      .map((t) => resolveLocal(page, t.attrs.get('href') ?? ''));
    assert.deepEqual(sheets, ['assets/base.css', 'assets/app.css', 'assets/site.css'], `site/${page}: stylesheets`);
    assert.ok(ids(html).has('main'), `site/${page}: the skip link's target #main`);
  }
});

test('the 404 page works at any depth (root-relative references only) and is not indexed', () => {
  const html = read('404.html');
  for (const ref of references(html)) {
    if (ref.startsWith('#')) continue;
    assert.ok(ref.startsWith('/') && !ref.startsWith('//'), `404.html: "${ref}" must start at the site root`);
  }
  assert.match(meta(html, 'name=robots') ?? '', /noindex/);
});

test('price, sale state and support address match src/config.js', () => {
  const landing = read('index.html');
  const faq = read('faq/index.html');
  for (const [page, html] of [['index.html', landing], ['faq/index.html', faq]]) {
    const priced = scanTags(html).filter((t) => !t.closing && t.attrs.get('data-config') === 'priceDisplay');
    assert.ok(priced.length > 0, `site/${page}: the price is marked data-config="priceDisplay"`);
    assert.ok(textOf(html).includes(CONFIG.priceDisplay), `site/${page}: shows ${CONFIG.priceDisplay}, the price in src/config.js`);
  }
  if (isConfigured()) {
    // On sale: the static "not on sale yet" wording must go, and the pages need a buy link.
    assert.doesNotMatch(textOf(landing), /not on sale yet/i, 'src/config.js is set up for sale: update the price block in site/index.html');
    assert.doesNotMatch(textOf(faq), /not on sale yet/i, 'src/config.js is set up for sale: update the price answer in site/faq/index.html');
  } else {
    assert.match(textOf(landing), /not on sale yet/i, 'site/index.html says it is not on sale yet');
    assert.match(textOf(faq), /not on sale yet/i, 'site/faq/index.html says it is not on sale yet');
  }
  if (CONFIG.supportEmail) {
    assert.ok(faq.includes(CONFIG.supportEmail), 'site/faq/index.html gives the support address from src/config.js');
  } else {
    assert.match(textOf(faq), /support address will be listed here/i, 'site/faq/index.html says no support address yet');
  }
});

test('the sitemap lists every public page on one placeholder host, and robots.txt points at it', () => {
  const sitemap = readFileSync(join(SITE, 'sitemap.xml'), 'utf8');
  const robots = readFileSync(join(SITE, 'robots.txt'), 'utf8');
  const locs = [...stripComments(sitemap).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => new URL(m[1]));
  assert.ok(locs.length > 0);
  const origin = locs[0].origin;
  assert.ok(locs.every((u) => u.origin === origin && u.protocol === 'https:'), 'every <loc> is on the same https host');
  const listed = locs.map((u) => u.pathname).sort();
  const expected = PAGES.filter((p) => p !== '404.html').map((p) => `/${p.replace(/index\.html$/, '')}`).sort();
  assert.deepEqual(listed, expected, 'the sitemap lists every page except 404.html');
  assert.match(robots, new RegExp(`^Sitemap: ${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/sitemap\\.xml$`, 'm'));
  assert.match(robots, /^User-agent: \*$/m);
});

test('site.css adds no colours of its own and no gradients (only token colours and dashed trail lines)', () => {
  const css = readFileSync(join(SITE, 'assets/site.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'a hex colour: use a token from base.css');
  assert.doesNotMatch(css, /\b(?:rgba?|hsla?|oklch|lab|lch|color)\(/i, 'a colour function: use a token from base.css');
  assert.doesNotMatch(css, /(?<!repeating-)linear-gradient\(|radial-gradient\(|conic-gradient\(/i, 'a gradient');
});

test('the site pages have no emoji', () => {
  for (const page of SITE_PAGES) {
    assert.doesNotMatch(textOf(read(page)), /\p{Extended_Pictographic}/u, `site/${page}`);
  }
});

// Design review, 2026-10-06: claims the pages could not back.

test('no page promises that the preview counts every kind of data Foldertrail leaves behind', () => {
  // The reader counts some record types it skips (BirdsEye and map records); it cannot see geocache logs, Adventures or
  // photos, so "the preview and the report count them" was more than it can do.
  for (const page of PAGES) {
    const text = read(page).replace(/\s+/g, ' ');
    assert.doesNotMatch(text, /(?:preview|report)[^.]{0,40}\bcount them\b/i, page);
  }
});

test('the landing page does not promise the preview will catch every conversion problem', () => {
  const text = read('index.html').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.doesNotMatch(text, /doesn’t convert cleanly, the free preview shows it/, 'a silent misreading would not show in the preview');
  assert.doesNotMatch(text, /synthetic libraries/, 'plain words: "made-up libraries"');
  assert.match(text, /made-up libraries/);
  assert.match(text, /check the free preview against your library/, 'and it says what to do instead');
  assert.match(text, /if it still opens/, 'BaseCamp may no longer open for the people this is for');
});
