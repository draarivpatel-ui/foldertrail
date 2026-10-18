#!/usr/bin/env node
// Assembles the static site into dist/: site/ is copied as it is, and the JavaScript modules in src/ are
// copied to dist/js/ with their paths kept (src/app/main.js -> dist/js/app/main.js). Zero dependencies.
//
// It refuses to produce a build that would break the Content-Security-Policy (decision B22, ARCHITECTURE §10)
// or reach another origin. Every HTML file must have
//   - no inline <script> (every script needs src=) and no <style> element,
//   - no style="" attribute and no on...="" event-handler attribute,
//   - no javascript: URL, no <base>, <iframe>, <object> or <embed>,
//   - no remote URL (http:, https: or //host) in any attribute (xmlns namespace names excepted: they are
//     identifiers, never fetched), with ONE exception: <a href="https://..."> is allowed when the same tag has
//     rel="noopener noreferrer". A link the user clicks is their own navigation, not a resource the page loads,
//     so it neither sends data nor pulls in code. Only <a>, only href, only https; http:, //host, <area>, ping=""
//     and every other attribute stay refused. The rel is required, not added: the build copies files as they are,
//     and a link without it fails with a message that says what to add,
// every CSS file no remote url(), image-set() or @import (CSS escapes decoded first), and every local script,
// stylesheet, icon or image an HTML or CSS file points at must exist in the build. The site's _headers file must be
// in the build (without it the host sends no Content-Security-Policy at all), and when this repository's own site/ is
// built, its rule for every path ("/*") must set a CSP that starts from default-src 'none' (checkHeadersFile).
//
// The build is made in a staging folder next to the output and only moved into place when every check
// passes, so a failed build never leaves a half-made or unchecked dist/ behind.
//
// Usage: node tools/build.js [--out <dir>]

import { mkdir, readdir, readFile, rename, rm, stat, copyFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');

/** Marks a folder this script made, so it is the only kind of folder it will ever delete. */
const MARKER = '.foldertrail-build';

/** Files under src/ that are development tools, not part of the app. */
const SRC_EXCLUDE = new Set(['app/probe.js']);

export class BuildError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(`Build failed:\n  - ${problems.join('\n  - ')}`);
    this.name = 'BuildError';
    this.problems = problems;
  }
}

/**
 * @typedef {object} BuildOptions
 * @property {string} [root]    repository root (default: this repository)
 * @property {string} [siteDir] default <root>/site
 * @property {string} [srcDir]  default <root>/src
 * @property {string} [outDir]  default <root>/dist
 * @property {boolean} [requireCsp]  the _headers rule for every path ("/*") must set a strict Content-Security-Policy;
 *   default: true when building this repository's own site/, false for another folder (test fixtures)
 */

/**
 * Builds the site. Throws BuildError listing every problem when a check fails; the output is then untouched.
 * @param {BuildOptions} [options]
 * @returns {Promise<{outDir: string, files: string[], warnings: string[]}>}  files: output paths relative to outDir,
 *   "/"-separated; warnings: links (<a href>) to local pages that are not in the build (not fatal: the page may
 *   come later), so they are reported instead of silently shipping a dead link
 */
export async function build(options = {}) {
  const root = resolve(options.root ?? REPO_ROOT);
  const siteDir = resolve(options.siteDir ?? join(root, 'site'));
  const srcDir = resolve(options.srcDir ?? join(root, 'src'));
  const outDir = resolve(options.outDir ?? join(root, 'dist'));

  for (const [label, dir] of [['site', siteDir], ['src', srcDir]]) {
    if (!(await isDir(dir))) throw new BuildError([`The ${label} folder does not exist: ${dir}`]);
    if (isInside(outDir, dir) || isInside(dir, outDir)) {
      throw new BuildError([`The output folder must be separate from the ${label} folder.`]);
    }
  }
  if (outDir === dirname(outDir)) throw new BuildError(['The output folder cannot be a filesystem root.']);
  if (isInside(outDir, root)) throw new BuildError(['The output folder cannot be or contain the repository.']);
  await assertRemovable(outDir);

  const staging = `${outDir}.staging-${process.pid}-${Date.now()}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    /** @type {string[]} */
    const files = [];
    for (const rel of await listFiles(siteDir)) {
      await copyInto(join(siteDir, rel), join(staging, rel));
      files.push(toPosix(rel));
    }
    for (const rel of await listFiles(srcDir)) {
      const posixRel = toPosix(rel);
      if (!posixRel.endsWith('.js') || SRC_EXCLUDE.has(posixRel)) continue;
      const target = join(staging, 'js', rel);
      await copyInto(join(srcDir, rel), target);
      files.push(`js/${posixRel}`);
    }

    const { problems, warnings } = await checkOutput(staging, files);
    const requireCsp = options.requireCsp ?? siteDir === resolve(REPO_ROOT, 'site');
    problems.push(...checkHeadersFile(files.includes('_headers') ? await readFile(join(staging, '_headers'), 'utf8') : null, requireCsp));
    if (problems.length > 0) throw new BuildError(problems);

    await writeFile(join(staging, MARKER), 'Made by tools/build.js. This whole folder is replaced on every build.\n');
    await rm(outDir, { recursive: true, force: true });
    await rename(staging, outDir);
    return { outDir, files: files.sort(), warnings };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Runs every check over a built tree.
 * @param {string} dir
 * @param {string[]} files  "/"-separated paths relative to dir
 * @returns {Promise<{problems: string[], warnings: string[]}>}
 */
async function checkOutput(dir, files) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const warnings = [];
  const present = new Set(files);
  for (const file of files) {
    const lower = file.toLowerCase();
    if (lower.endsWith('.html') || lower.endsWith('.htm')) {
      const text = await readFile(join(dir, file), 'utf8');
      const result = checkHtml(text, file);
      problems.push(...result.problems);
      for (const ref of result.localRefs) {
        const target = resolveLocal(file, ref);
        if (target === null) problems.push(`${file}: the reference "${ref}" points outside the site`);
        else if (!exists(present, target)) problems.push(`${file}: "${ref}" does not exist in the build`);
      }
      for (const ref of result.linkRefs) {
        const target = resolveLocal(file, ref);
        if (target !== null && !exists(present, target)) warnings.push(`${file}: the link "${ref}" goes to a page that is not in the build yet`);
      }
    } else if (lower.endsWith('.css')) {
      const text = await readFile(join(dir, file), 'utf8');
      const result = checkCss(text, file);
      problems.push(...result.problems);
      for (const ref of result.localRefs) {
        const target = resolveLocal(file, ref);
        if (target === null) problems.push(`${file}: the reference "${ref}" points outside the site`);
        else if (!exists(present, target)) problems.push(`${file}: "${ref}" does not exist in the build`);
      }
    }
  }
  return { problems, warnings };
}

/**
 * @param {Set<string>} present
 * @param {string} target
 */
function exists(present, target) {
  if (present.has(target)) return true;
  // A folder reference ("app/") is served as its index.html.
  const asDir = target === '' || target.endsWith('/') ? `${target}index.html` : `${target}/index.html`;
  return present.has(asDir);
}

// ---------------------------------------------------------------------------------------------
// _headers: without it the host serves no Content-Security-Policy at all (decision B22, ARCHITECTURE §10)

/**
 * Checks the _headers file that goes out with the build. It must exist (a deploy without it has no CSP, no
 * X-Frame-Options, nothing); with `requireCsp`, the rule for every path ("/*") must set a Content-Security-Policy
 * that starts from default-src 'none' and allows no unsafe-* source. The exact policy is pinned by
 * test/headers.test.js; this only stops a build that would ship without one.
 * @param {string|null} text  the file's contents, null when it is missing
 * @param {boolean} requireCsp
 * @returns {string[]} problems
 */
export function checkHeadersFile(text, requireCsp) {
  if (text === null) {
    return ['_headers is missing: without it the host sends no Content-Security-Policy (site/_headers, decision B22)'];
  }
  if (!requireCsp) return [];
  /** @type {string[]} */
  const csp = [];
  let everyPath = false;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      everyPath = raw.trim() === '/*';
      continue;
    }
    const m = /^\s+content-security-policy\s*:\s*(.*)$/i.exec(raw);
    if (m && everyPath) csp.push(m[1].trim());
  }
  if (csp.length !== 1) {
    return [`_headers: the rule for every path ("/*") must set exactly one Content-Security-Policy (found ${csp.length})`];
  }
  const policy = csp[0];
  /** @type {string[]} */
  const problems = [];
  if (!/(?:^|;)\s*default-src 'none'\s*(?:;|$)/.test(policy)) problems.push(`_headers: the Content-Security-Policy must start from default-src 'none'`);
  if (/'unsafe-|'wasm-unsafe-eval'|(?:^|\s)\*(?:\s|;|$)/.test(policy)) problems.push('_headers: the Content-Security-Policy allows an unsafe source or a wildcard');
  if (!/(?:^|;)\s*script-src 'self'\s*(?:;|$)/.test(policy)) problems.push(`_headers: the Content-Security-Policy must set script-src 'self'`);
  return problems;
}

// ---------------------------------------------------------------------------------------------
// HTML and CSS checks (exported for tests)

/** Another origin: an http(s)/ws(s)/ftp scheme with any number of slashes (browsers repair "https:/host"), or a
 *  scheme-relative "//host" (browsers also read a backslash as a slash here). */
const REMOTE_RE = /^\s*(?:(?:https?|wss?|ftp):|(?:[a-z][a-z0-9+.-]*:)?[\\/][\\/])/i;
const JS_URL_RE = /^\s*javascript:/i;
/** Attributes that load something; their local targets must exist. */
const LOADING = new Map([
  ['script', ['src']],
  ['img', ['src', 'srcset']],
  ['source', ['src', 'srcset']],
  ['video', ['src', 'poster']],
  ['audio', ['src']],
  ['track', ['src']],
]);
const LINK_LOADING_RELS = new Set(['stylesheet', 'icon', 'apple-touch-icon', 'mask-icon', 'manifest', 'modulepreload', 'preload']);
const FORBIDDEN_ELEMENTS = new Set(['style', 'base', 'iframe', 'frame', 'object', 'embed', 'applet']);

/**
 * True when `value` is an absolute https URL that parses cleanly (no spaces, a host, no user name or password).
 * @param {string} value
 */
function isHttpsLink(value) {
  const v = value.trim();
  if (!/^https:\/\/[^/\\\s]/i.test(v) || /[\s\\]/.test(v)) return false;
  try {
    const url = new URL(v);
    return url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

/**
 * Checks one HTML document against the rules at the top of this file.
 * @param {string} text
 * @param {string} [label]
 * @returns {{problems: string[], localRefs: string[], linkRefs: string[], externalLinks: string[]}}  localRefs:
 *   resources the page loads; linkRefs: local pages it links to; externalLinks: the https pages on other sites it
 *   links to (allowed <a href> links, for the record)
 */
export function checkHtml(text, label = 'page') {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const localRefs = [];
  /** @type {string[]} */
  const linkRefs = [];
  /** @type {string[]} */
  const externalLinks = [];
  const tags = scanTags(String(text));
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    if (tag.closing) continue;
    const where = `${label}:${tag.line} <${tag.name}>`;
    if (FORBIDDEN_ELEMENTS.has(tag.name)) problems.push(`${where}: <${tag.name}> is not allowed`);
    if (tag.name === 'script') {
      const src = tag.attrs.get('src');
      if (src === undefined || src.trim() === '') problems.push(`${where}: inline script (every <script> needs src=)`);
      else if (tag.body.trim() !== '') problems.push(`${where}: a <script src> must have no inline body`);
    }
    for (const [name, value] of tag.attrs) {
      if (name === 'style') problems.push(`${where}: style="" attribute`);
      if (/^on[a-z]/.test(name)) problems.push(`${where}: inline event handler ${name}=""`);
      if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
      if (tag.name === 'a' && name === 'href' && isHttpsLink(value)) {
        // The one remote URL allowed: a link the user clicks (see the top of this file).
        const rels = (tag.attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
        if (rels.includes('noopener') && rels.includes('noreferrer')) externalLinks.push(value.trim());
        else problems.push(`${where}: a link to another site needs rel="noopener noreferrer" (href="${value.trim()}")`);
        continue;
      }
      const urls = name === 'srcset' ? srcsetUrls(value) : [value];
      for (const url of urls) {
        if (JS_URL_RE.test(url)) problems.push(`${where}: javascript: URL in ${name}=""`);
        else if (REMOTE_RE.test(url)) problems.push(`${where}: remote URL in ${name}="${url.trim()}"`);
      }
    }
    const loading = LOADING.get(tag.name) ?? [];
    for (const attr of loading) {
      const value = tag.attrs.get(attr);
      if (value === undefined) continue;
      for (const url of attr === 'srcset' ? srcsetUrls(value) : [value]) {
        if (isLocalRef(url)) localRefs.push(url.trim());
      }
    }
    if ((tag.name === 'a' || tag.name === 'area') && tag.attrs.has('href')) {
      const href = /** @type {string} */ (tag.attrs.get('href'));
      if (isLocalRef(href)) linkRefs.push(href.trim());
    }
    if (tag.name === 'link') {
      const rels = (tag.attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
      const href = tag.attrs.get('href');
      if (href !== undefined && rels.some((rel) => LINK_LOADING_RELS.has(rel)) && isLocalRef(href)) {
        localRefs.push(href.trim());
      }
    }
  }
  return { problems, localRefs, linkRefs, externalLinks };
}

/**
 * @param {string} text
 * @param {string} [label]
 * @returns {{problems: string[], localRefs: string[]}}
 */
export function checkCss(text, label = 'stylesheet') {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const localRefs = [];
  // Escapes are decoded first, as the browser reads them: url(h\74tps://host/x) is a remote URL.
  const css = decodeCssEscapes(String(text).replace(/\/\*[\s\S]*?\*\//g, ''));
  const urlRe = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;
  for (const match of css.matchAll(urlRe)) {
    const url = match[1] ?? match[2] ?? match[3] ?? '';
    if (REMOTE_RE.test(url)) problems.push(`${label}: remote url(${url})`);
    else if (JS_URL_RE.test(url)) problems.push(`${label}: javascript: url()`);
    else if (isLocalRef(url)) localRefs.push(url);
  }
  // No space is needed after @import: @import"https://host/a.css" is valid CSS.
  const importRe = /@import(?![\w-])\s*(?:url\(\s*)?["']?([^"')\s;]+)/gi;
  for (const match of css.matchAll(importRe)) {
    if (REMOTE_RE.test(match[1])) problems.push(`${label}: remote @import ${match[1]}`);
  }
  // image-set() takes plain strings as URLs too: image-set("https://host/a.png" 1x).
  for (const match of css.matchAll(/image-set\(([^;{}]*)/gi)) {
    for (const str of match[1].matchAll(/(["'])(.*?)\1/g)) {
      if (REMOTE_RE.test(str[2])) problems.push(`${label}: remote image-set(${str[2]})`);
      else if (isLocalRef(str[2])) localRefs.push(str[2]);
    }
  }
  return { problems, localRefs };
}

/**
 * Decodes CSS escapes ("\74" or "\t" for "t").
 * @param {string} css
 */
function decodeCssEscapes(css) {
  return css.replace(/\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|([^\n\r\f0-9a-fA-F]))/g, (_, hex, ch) => {
    if (ch !== undefined) return ch;
    const cp = parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '\ufffd';
  });
}

/**
 * @typedef {{name: string, attrs: Map<string, string>, closing: boolean, line: number, body: string}} Tag
 */

/**
 * A small, forgiving tag scanner: enough to find elements and their attributes, quotes included. Comments
 * are skipped; the text inside <script> and <textarea> is kept as the tag's body and not scanned for tags.
 * @param {string} html
 * @returns {Tag[]}
 */
export function scanTags(html) {
  /** @type {Tag[]} */
  const tags = [];
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const closing = html[lt + 1] === '/';
    let j = lt + (closing ? 2 : 1);
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(html.slice(j, j + 64));
    if (!nameMatch) {
      i = lt + 1;
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    j += nameMatch[0].length;
    /** @type {Map<string, string>} */
    const attrs = new Map();
    // Attributes, until a '>' that is not inside quotes.
    while (j < n && html[j] !== '>') {
      const ch = html[j];
      if (/\s|\//.test(ch)) {
        j++;
        continue;
      }
      const attrMatch = /^[^\s"'>/=]+/.exec(html.slice(j, j + 256));
      if (!attrMatch) {
        j++;
        continue;
      }
      const attrName = attrMatch[0].toLowerCase();
      j += attrMatch[0].length;
      while (j < n && /\s/.test(html[j])) j++;
      let value = '';
      if (html[j] === '=') {
        j++;
        while (j < n && /\s/.test(html[j])) j++;
        const quote = html[j];
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, j + 1);
          value = html.slice(j + 1, end < 0 ? n : end);
          j = end < 0 ? n : end + 1;
        } else {
          const m = /^[^\s>]*/.exec(html.slice(j));
          value = m ? m[0] : '';
          j += value.length;
        }
      }
      if (!attrs.has(attrName)) attrs.set(attrName, decodeEntities(value));
    }
    const line = html.slice(0, lt).split('\n').length;
    let body = '';
    i = j + 1;
    if (!closing && (name === 'script' || name === 'textarea' || name === 'style')) {
      const endRe = new RegExp(`</${name}\\s*>`, 'i');
      const rest = html.slice(i);
      const m = endRe.exec(rest);
      body = m ? rest.slice(0, m.index) : rest;
      i += m ? m.index : rest.length;
    }
    tags.push({ name, attrs, closing, line, body });
  }
  return tags;
}

/** @param {string} value */
function decodeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec) => safeChar(parseInt(dec, 10)))
    .replace(/&colon;/gi, ':')
    .replace(/&sol;/gi, '/')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

/** @param {number} code */
function safeChar(code) {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

/** @param {string} value */
function srcsetUrls(value) {
  return value
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0] ?? '')
    .filter((url) => url.length > 0);
}

/** @param {string} url */
function isLocalRef(url) {
  const u = url.trim();
  if (u === '' || u.startsWith('#') || u.startsWith('data:') || u.startsWith('mailto:')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return false;
  return !REMOTE_RE.test(u);
}

/**
 * Resolves a local reference made from `fromFile` to a path relative to the build root, or null when it
 * climbs out of it.
 * @param {string} fromFile  "/"-separated, relative to the build root
 * @param {string} ref
 * @returns {string|null}
 */
export function resolveLocal(fromFile, ref) {
  const clean = ref.split('#')[0].split('?')[0];
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    decoded = clean;
  }
  const joined = decoded.startsWith('/') ? decoded : posix.join(posix.dirname(`/${fromFile}`), decoded);
  const normal = posix.normalize(joined);
  if (!normal.startsWith('/') || normal.split('/').includes('..')) return null;
  const rel = normal.slice(1);
  return decoded.endsWith('/') && !rel.endsWith('/') && rel !== '' ? `${rel}/` : rel;
}

// ---------------------------------------------------------------------------------------------
// Files

/**
 * Every regular file under dir, relative to it; dotfiles and dot-folders are left out.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listFiles(dir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} rel */
  const walk = async (rel) => {
    const entries = await readdir(join(dir, rel), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const child = rel === '' ? entry.name : join(rel, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) out.push(child);
    }
  };
  await walk('');
  return out.sort();
}

/** @param {string} from @param {string} to */
async function copyInto(from, to) {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
}

/** @param {string} dir */
async function isDir(dir) {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The output folder is replaced on every build, so it may only be a folder this script made (it holds the
 * marker file), an empty folder, or nothing yet.
 * @param {string} outDir
 */
async function assertRemovable(outDir) {
  let entries;
  try {
    entries = await readdir(outDir);
  } catch {
    return;
  }
  if (entries.length === 0 || entries.includes(MARKER)) return;
  throw new BuildError([
    `${outDir} exists and was not made by this script (no ${MARKER} file in it). Move it away or choose another --out.`,
  ]);
}

/** @param {string} parent @param {string} child */
function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel));
}

/** @param {string} p */
function toPosix(p) {
  return p.split(sep).join('/');
}

// ---------------------------------------------------------------------------------------------
// CLI

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const outDir = outIndex >= 0 ? args[outIndex + 1] : undefined;
  if (outIndex >= 0 && !outDir) {
    console.error('Usage: node tools/build.js [--out <dir>]');
    process.exit(2);
  }
  try {
    const result = await build({ outDir: outDir ? resolve(outDir) : undefined });
    console.log(`Built ${result.files.length} files into ${relative(process.cwd(), result.outDir) || '.'}`);
    for (const warning of result.warnings) console.log(`warning: ${warning}`);
  } catch (error) {
    console.error(error instanceof BuildError ? error.message : error);
    process.exit(1);
  }
}
