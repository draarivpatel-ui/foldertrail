#!/usr/bin/env node
// check-no-network: proves by reading the source that the shipped site makes no network request except the licence
// check (decision B22, docs/ARCHITECTURE.md §10). It scans src/ and site/ (JS, HTML, CSS, SVG) and reports:
//
//   network     a network API (fetch, fetchLater, XMLHttpRequest, WebSocket, WebSocketStream, EventSource, sendBeacon,
//               RTCPeerConnection and its prefixed names, WebTransport) anywhere except src/app/license.js, by name,
//               by a string or a joined string ('fe' + 'tch'), or by a computed lookup on a global object
//               (navigator[name]); in license.js, any URL that is not one of the two payment-provider API origins;
//               importScripts / new Worker / new Audio / dynamic import() / static import of a remote or computed
//               URL; a computed URL put into a resource property or attribute (img.src = base + data,
//               setAttribute('src', url)); a navigation to a computed URL (location.href = ..., location.assign(u),
//               window.open(u)), because no CSP directive stops a page from navigating away with data in the URL;
//               document.createElement('script' | 'iframe' | 'link' | ...); HTML or CSS inside a JS string that
//               loads from another host; <script>/<link>/<img>/<iframe>/<form action>/srcset/ping and similar
//               resource attributes pointing at another host; url(), image-set() and @import in CSS pointing at
//               another host (CSS escapes such as url(h\74tps://...) are decoded first).
//   csp-inline  things the Content-Security-Policy would block anyway (inline <script>, <style> elements, style=""
//               and on*="" attributes, javascript: URLs, eval, new Function, setTimeout with a string), so they
//               fail here instead of silently in a browser.
//   dom-sink    writing HTML from a string (innerHTML/outerHTML assignment, insertAdjacentHTML, document.write,
//               srcdoc, createContextualFragment, setHTMLUnsafe). Library names are hostile input; text goes in
//               as text (src/app/view-dom.js), never as markup.
//
// Deliberately NOT flagged: plain URL strings such as XML namespaces ("http://www.topografix.com/GPX/1/1"), links
// the user clicks (<a href="https://...">, a checkout link in src/config.js, link.href = x), and a navigation to a
// fixed literal URL (location.assign('https://checkout...')). Those carry no data by themselves. (ARCHITECTURE §10
// says "any http(s) literal"; the namespaces in src/export/ make that unworkable.)
//
// This is a guard against accidents, not against a determined author: a name decoded at run time
// (globalThis[atob('ZmV0Y2g=')]), an <a href> set to a computed URL and clicked from code, or code that builds a
// URL far from where it is used defeats any static check. The CSP header (site/_headers) is the second layer.
//
// Usage: node tools/check-no-network.js [--root <repo>] [--json]      exit 0 = clean, 1 = violations, 2 = error

import { readFileSync, readdirSync, lstatSync, statSync, realpathSync, existsSync } from 'node:fs';
import { join, relative, extname, sep, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The only file allowed to make network requests, relative to the repository root. */
export const ALLOWED_NETWORK_FILES = Object.freeze(['src/app/license.js']);
/** The only origins that file may name: the origins of the two connect-src endpoints in site/_headers (test/headers.test.js). */
export const ALLOWED_ORIGINS = Object.freeze(['https://api.polar.sh', 'https://api.gumroad.com']);
export const SCAN_DIRS = Object.freeze(['src', 'site']);
/**
 * Files exempt from the csp-inline rules only (never from the network rules), each with its reason. Keep this short.
 * @type {Readonly<Record<string, string>>}
 */
export const CSP_INLINE_EXCEPTIONS = Object.freeze({
  'src/app/probe.html':
    'M0 drop-probe page: a local developer tool with its own meta CSP that allows its inline <style>; not part of the site.',
});

const JS_EXT = new Set(['.js', '.mjs', '.cjs']);
const HTML_EXT = new Set(['.html', '.htm', '.xhtml', '.svg']);
const CSS_EXT = new Set(['.css']);
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const NETWORK_APIS = [
  'fetch', 'fetchLater', 'XMLHttpRequest', 'XDomainRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'sendBeacon',
  'RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection', 'WebTransport',
];
/** Global objects a network API can be looked up on by a computed name. */
const GLOBAL_OBJECTS = 'globalThis|self|window|navigator';
/** Properties and attributes that make the browser load (or, for ping, post to) a URL as soon as they are set. */
const RESOURCE_PROPS = 'src|srcset|poster|ping|formAction';
const RESOURCE_ATTR_NAMES = new Set(['src', 'srcset', 'poster', 'data', 'action', 'formaction', 'ping', 'background']);
/** A tag in a JS string with a resource attribute on another host: '<img src="https://...">'. */
const REMOTE_ATTR_IN_HTML =
  /<[a-z][^>]*?(?<![\w:-])(?:src|srcset|poster|data|action|formaction|ping|background)\s*=\s*\\?['"]?\s*(?:https?:|\/\/)/i;
/** ... or an href that loads: '<link href="https://...">', '<script>', '<base>', SVG '<use>' and '<image>'. */
const REMOTE_HREF_IN_HTML = /<(?:link|script|base|use|image)\b[^>]*?(?<![\w-])(?:xlink:)?href\s*=\s*\\?['"]?\s*(?:https?:|\/\/)/i;
/** Elements that load something by themselves once they are in the page. */
const LOADING_ELEMENTS = new Set(['script', 'iframe', 'frame', 'link', 'object', 'embed', 'base', 'meta', 'portal', 'fencedframe']);

/**
 * @typedef {object} Violation
 * @property {string} file      path relative to the scan root, with forward slashes
 * @property {number} line      1-based
 * @property {"network"|"csp-inline"|"dom-sink"|"scan"} kind
 * @property {string} rule      short machine name
 * @property {string} message   plain words
 */

// ---------------------------------------------------------------------------------------------------------------
// JavaScript lexer: blanks comments, string contents and regex bodies (keeping every newline so line numbers hold),
// and records each string literal. Good enough for hand-written ES modules; not a full parser.

/**
 * @typedef {object} JsLiteral
 * @property {number} start     index of the opening quote in the source
 * @property {number} end       index just past the closing quote
 * @property {string} value     the raw text between the quotes (template: the static parts only)
 * @property {boolean} template
 * @property {boolean} hasSubst template literal with ${...}
 */

const KEYWORDS_BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);

/**
 * @param {string} src
 * @returns {{code: string, literals: JsLiteral[]}}
 */
export function lexJs(src) {
  const out = src.split('');
  /** @type {JsLiteral[]} */
  const literals = [];
  const n = src.length;
  const blank = (/** @type {number} */ a, /** @type {number} */ b) => {
    for (let k = a; k < b && k < n; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  /** Stack of open template literals: each entry is the brace depth inside its current ${ }. */
  /** @type {{depth: number, lit: JsLiteral}[]} */
  const templates = [];
  let i = 0;
  if (src.startsWith('#!')) {
    const nl = src.indexOf('\n');
    blank(0, nl < 0 ? n : nl);
    i = nl < 0 ? n : nl;
  }
  /** The last significant character/word, to tell a regex from a division. */
  let prevSig = '';
  let prevWord = '';

  /**
   * Scan template text from index j (just inside the backtick or after a closing `}`) to the next `${` or closing
   * backtick. Returns the index after the stop token and whether it was `${`.
   * @param {number} j
   * @param {JsLiteral} lit
   */
  const scanTemplate = (j, lit) => {
    let k = j;
    while (k < n) {
      const c = src[k];
      if (c === '\\') { lit.value += src.slice(k, k + 2); k += 2; continue; }
      if (c === '`') { blank(j, k); return { next: k + 1, subst: false }; }
      if (c === '$' && src[k + 1] === '{') { blank(j, k); lit.hasSubst = true; return { next: k + 2, subst: true }; }
      lit.value += c;
      k++;
    }
    blank(j, n);
    return { next: n, subst: false };
  };

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let value = '';
      while (j < n && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') { value += src.slice(j, j + 2); j += 2; continue; }
        value += src[j];
        j++;
      }
      const end = Math.min(j + 1, n);
      literals.push({ start: i, end, value, template: false, hasSubst: false });
      blank(i + 1, j);
      prevSig = c;
      prevWord = '';
      i = end;
      continue;
    }
    if (c === '`') {
      /** @type {JsLiteral} */
      const lit = { start: i, end: i, value: '', template: true, hasSubst: false };
      literals.push(lit);
      const r = scanTemplate(i + 1, lit);
      if (r.subst) templates.push({ depth: 0, lit });
      else { lit.end = r.next; prevSig = '`'; prevWord = ''; }
      i = r.next;
      continue;
    }
    if (templates.length > 0 && (c === '{' || c === '}')) {
      const top = templates[templates.length - 1];
      if (c === '{') { top.depth++; i++; prevSig = '{'; prevWord = ''; continue; }
      if (top.depth > 0) { top.depth--; i++; prevSig = '}'; prevWord = ''; continue; }
      // closes the ${ }: back into template text
      const r = scanTemplate(i + 1, top.lit);
      if (!r.subst) { templates.pop(); top.lit.end = r.next; prevSig = '`'; prevWord = ''; }
      i = r.next;
      continue;
    }
    if (c === '/') {
      const regexAllowed =
        prevSig === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prevSig) || KEYWORDS_BEFORE_REGEX.has(prevWord);
      if (regexAllowed) {
        let j = i + 1;
        let inClass = false;
        while (j < n && src[j] !== '\n') {
          const ch = src[j];
          if (ch === '\\') { j += 2; continue; }
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) break;
          j++;
        }
        blank(i + 1, j);
        j++;
        while (j < n && /[a-z]/i.test(src[j])) j++;
        prevSig = ')'; // a regex literal is a value
        prevWord = '';
        i = j;
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(src[j])) j++;
      prevWord = src.slice(i, j);
      prevSig = 'a';
      i = j;
      continue;
    }
    if (/\d/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) j++;
      prevSig = '0';
      prevWord = '';
      i = j;
      continue;
    }
    if (!/\s/.test(c)) { prevSig = c; prevWord = ''; }
    i++;
  }
  return { code: out.join(''), literals };
}

// ---------------------------------------------------------------------------------------------------------------
// URL helpers

/**
 * True when a URL reference loads from somewhere other than this site.
 * @param {string} raw
 */
export function isRemoteRef(raw) {
  const v = decodeEntities(String(raw)).replace(/^[\s\u0000-\u001f]+/, '').toLowerCase();
  return /^(?:https?:|wss?:|ftp:|\/\/|\\\\)/.test(v) || /^\/\\|^\\\//.test(v);
}

/** @param {string} s */
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, dd) => safeChar(parseInt(dd, 10)))
    .replace(/&colon;/gi, ':')
    .replace(/&sol;/gi, '/')
    .replace(/&bsol;/gi, '\\')
    .replace(/&amp;/gi, '&');
}

/** @param {number} cp */
function safeChar(cp) {
  return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
}

/**
 * The origin a URL literal names, or null when it is not an absolute http(s)/ws(s) URL.
 * @param {string} value
 */
function originOf(value) {
  const m = /^(https?|wss?):\/\/([^/?#\s'"`]*)/i.exec(value.trim());
  return m ? `${m[1].toLowerCase()}://${m[2].toLowerCase()}` : null;
}

/** @param {string} text @param {number} index */
function lineAt(text, index) {
  let line = 1;
  for (let k = 0; k < index && k < text.length; k++) if (text.charCodeAt(k) === 10) line++;
  return line;
}

// ---------------------------------------------------------------------------------------------------------------
// JavaScript checks

/**
 * Find the argument text of a call whose "(" is at `open`: returns the first argument's [start, end) in `code`.
 * @param {string} code
 * @param {number} open
 */
function firstArgSpan(code, open) {
  let depth = 0;
  let k = open;
  for (; k < code.length; k++) {
    const ch = code[k];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) break;
    } else if (ch === ',' && depth === 1) break;
  }
  return [open + 1, k];
}

/** True when a browser could actually request this URL (a URL that does not parse, such as "http://[", cannot be). */
function parsable(/** @type {string} */ value) {
  try {
    new URL(value, 'https://this-site.invalid/');
    return true;
  } catch {
    return false;
  }
}

/**
 * Classify a call argument: a local literal URL is fine, a remote one is not, anything computed is suspect.
 * Accepts 'x', `x` (no ${}), new URL('x', import.meta.url), an identifier bound by `const NAME = 'x';`, and the
 * parameter of a one-argument helper (function NAME(p) { ... import(p) ... }) when every use of NAME in the file
 * is a call whose first argument is itself local.
 * @param {string} code    lexed code (comments and string contents blanked)
 * @param {JsLiteral[]} literals
 * @param {[number, number]} span
 * @param {number} [depth] helper-resolution depth (one level only)
 * @returns {{kind: "local"|"remote"|"computed"}}
 */
function classifyArg(code, literals, span, depth = 0) {
  const [a, b] = span;
  const litsIn = literals.filter((l) => l.start >= a && l.end <= b);
  /** @param {JsLiteral} l @returns {{kind: "local"|"remote"|"computed"}} */
  const judge = (l) => {
    if (l.hasSubst) return { kind: 'computed' };
    const v = l.value.trim();
    if (/^(?:blob|data|javascript):/i.test(v)) return { kind: 'remote' };
    if (isRemoteRef(v)) return parsable(v) ? { kind: 'remote' } : { kind: 'local' };
    return { kind: 'local' };
  };
  if (litsIn.length === 1) {
    const l = litsIn[0];
    // the code around the literal, with whitespace removed and the literal itself marked by \0
    const shape = `${code.slice(a, l.start)}\0${code.slice(l.end, b)}`.replace(/\s+/g, '');
    if (shape === '\0' || shape === 'newURL(\0,import.meta.url)') return judge(l);
  }
  const ident = /^[A-Za-z_$][\w$]*$/.exec(code.slice(a, b).trim());
  if (ident) {
    const name = ident[0].replace(/\$/g, '\\$');
    const bound = new RegExp(`(?<![\\w$.])const\\s+${name}\\s*=\\s*$`);
    for (const l of literals) {
      if (!bound.test(code.slice(Math.max(0, l.start - 200), l.start))) continue;
      const next = /^[ \t]*([\s\S]?)/.exec(code.slice(l.end))?.[1] ?? '';
      if (next === '' || next === ';' || next === ',' || next === '\n' || next === '\r') return judge(l);
    }
    if (depth === 0) {
      const viaHelper = classifyHelperParam(code, literals, ident[0], a);
      if (viaHelper) return viaHelper;
    }
  }
  if (litsIn.some((l) => !l.hasSubst && isRemoteRef(l.value) && parsable(l.value.trim()))) return { kind: 'remote' };
  return { kind: 'computed' };
}

/**
 * `param` is the only parameter of the nearest function declared before `at` (function NAME(param) or
 * const NAME = (param) =>). If NAME is used in this file only as NAME(<local literal>, ...), the argument is local.
 * Returns null when the pattern does not apply.
 * @param {string} code
 * @param {JsLiteral[]} literals
 * @param {string} param
 * @param {number} at
 * @returns {{kind: "local"|"remote"|"computed"}|null}
 */
function classifyHelperParam(code, literals, param, at) {
  const p = param.replace(/\$/g, '\\$');
  const decl = new RegExp(
    `(?:(?<![\\w$.])function\\s+([A-Za-z_$][\\w$]*)\\s*\\(\\s*${p}\\s*\\)|(?<![\\w$.])(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:async\\s*)?(?:function\\s*)?\\(?\\s*${p}\\s*\\)?\\s*(?:=>|\\{))`,
    'g',
  );
  /** @type {RegExpExecArray|null} */
  let last = null;
  for (const m of code.matchAll(decl)) if ((m.index ?? 0) < at) last = /** @type {RegExpExecArray} */ (m);
  if (!last) return null;
  const helper = last[1] ?? last[2];
  const declAt = last.index ?? 0;
  const uses = [...code.matchAll(new RegExp(`(?<![\\w$.])${helper.replace(/\$/g, '\\$')}(?![\\w$])`, 'g'))]
    .map((m) => m.index ?? 0)
    .filter((i) => i < declAt || i > declAt + last[0].length);
  if (uses.length === 0) return null;
  for (const i of uses) {
    const open = code.indexOf('(', i);
    if (open < 0 || code.slice(i + helper.length, open).trim() !== '') return { kind: 'computed' }; // used as a value
    const verdict = classifyArg(code, literals, firstArgSpan(code, open), 1);
    if (verdict.kind !== 'local') return verdict;
  }
  return { kind: 'local' };
}

/**
 * Every argument span of a call whose "(" is at `open`, as [start, end) pairs in `code` (empty for "()").
 * @param {string} code
 * @param {number} open
 * @returns {[number, number][]}
 */
function argSpans(code, open) {
  /** @type {[number, number][]} */
  const spans = [];
  let depth = 0;
  let start = open + 1;
  for (let k = open; k < code.length; k++) {
    const ch = code[k];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) {
        if (code.slice(start, k).trim() !== '' || spans.length > 0) spans.push([start, k]);
        return spans;
      }
    } else if (ch === ',' && depth === 1) {
      spans.push([start, k]);
      start = k + 1;
    }
  }
  spans.push([start, code.length]);
  return spans;
}

/**
 * The span of the bracketed expression whose "[" is at `open`, without the brackets.
 * @param {string} code
 * @param {number} open
 * @returns {[number, number]}
 */
function bracketSpan(code, open) {
  let depth = 0;
  for (let k = open; k < code.length; k++) {
    const ch = code[k];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return [open + 1, k];
    }
  }
  return [open + 1, code.length];
}

/**
 * The right-hand side of an assignment that starts at `from` (just after "="): up to a ";" or "," at depth 0, an
 * unmatched closing bracket, or a line break that does not continue the expression.
 * @param {string} code
 * @param {number} from
 * @returns {[number, number]}
 */
function rhsSpan(code, from) {
  let k = from;
  while (k < code.length && /\s/.test(code[k])) k++;
  const start = k;
  let depth = 0;
  for (; k < code.length; k++) {
    const ch = code[k];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (ch === ';' || ch === ',')) break;
    else if (depth === 0 && ch === '\n') {
      const before = code.slice(start, k).trimEnd();
      const after = code.slice(k + 1).trimStart();
      if (!/[+\-*/?:.|&=(]$/.test(before) && !/^[+\-*/?:.|&]/.test(after)) break;
    }
  }
  return [start, k];
}

/**
 * The static text of a template literal up to its first ${...}.
 * @param {string} src
 * @param {JsLiteral} lit
 */
function templateHead(src, lit) {
  const raw = src.slice(lit.start + 1, lit.end);
  let k = 0;
  while (k < raw.length) {
    if (raw[k] === '\\') { k += 2; continue; }
    if (raw[k] === '$' && raw[k + 1] === '{') break;
    if (raw[k] === '`') break;
    k++;
  }
  return raw.slice(0, k);
}

/** A URL that starts like this stays on this site whatever is appended: "./x", "../x", "/x" (not "//"), "#", "?". */
const LOCAL_PREFIX = /^(?:\.{1,2}\/|\/(?![/\\])[^\s/\\]|#|\?|(?:data|blob):)/i;

/**
 * Classify the value put into a resource property, a resource attribute or a navigation: a local or remote fixed
 * URL, a computed URL that cannot leave this site (it starts with a fixed local prefix), or a computed one.
 * @param {string} src
 * @param {string} code
 * @param {JsLiteral[]} literals
 * @param {[number, number]} span
 * @returns {{kind: "none"|"local"|"remote"|"computed"}}
 */
function classifyUrlValue(src, code, literals, span) {
  const [a, b] = span;
  const text = code.slice(a, b).trim();
  if (text === '') return { kind: 'none' };
  if (/^URL\s*\.\s*createObjectURL\s*\(/.test(text)) return { kind: 'local' };
  const lits = literals.filter((l) => l.start >= a && l.end <= b).sort((x, y) => x.start - y.start);
  /** @param {string} v @returns {{kind: "local"|"remote"}} */
  const judge = (v) => (isRemoteRef(v.trim()) && parsable(v.trim()) ? { kind: 'remote' } : { kind: 'local' });
  if (lits.length > 0 && lits.every((l) => !l.hasSubst)) {
    let between = '';
    let prev = a;
    for (const l of lits) {
      between += code.slice(prev, l.start);
      prev = l.end;
    }
    between += code.slice(prev, b);
    if (/^[\s+()]*$/.test(between)) return judge(lits.map((l) => l.value).join(''));
  }
  const first = lits[0];
  if (first && code.slice(a, first.start).replace(/[\s(]/g, '') === '') {
    const head = first.template ? templateHead(src, first) : first.value;
    if (LOCAL_PREFIX.test(head.trim())) return { kind: 'local' };
  }
  const verdict = classifyArg(code, literals, span);
  // A remote URL that is not one fixed literal (or a const bound to one) has something appended: computed.
  if (verdict.kind === 'remote' && !/^[A-Za-z_$][\w$]*$/.test(text)) return { kind: 'computed' };
  return verdict;
}

/**
 * Chains of plain string literals joined by "+" ('fe' + 'tch'), with their joined value.
 * @param {string} code
 * @param {JsLiteral[]} literals
 * @returns {{start: number, end: number, value: string}[]}
 */
function literalChains(code, literals) {
  const sorted = [...literals].filter((l) => !l.hasSubst).sort((x, y) => x.start - y.start);
  const chains = [];
  let k = 0;
  while (k < sorted.length) {
    let j = k;
    let value = sorted[k].value;
    while (j + 1 < sorted.length && /^\s*\+\s*$/.test(code.slice(sorted[j].end, sorted[j + 1].start))) {
      j++;
      value += sorted[j].value;
    }
    if (j > k) chains.push({ start: sorted[k].start, end: sorted[j].end, value });
    k = j + 1;
  }
  return chains;
}

/**
 * True when the span holds only plain string literals (joined by "+") or a number: a fixed name, not a computed one.
 * @param {string} code
 * @param {JsLiteral[]} literals
 * @param {[number, number]} span
 */
function isFixedKey(code, literals, span) {
  const [a, b] = span;
  let rest = '';
  let prev = a;
  for (const l of literals.filter((x) => x.start >= a && x.end <= b).sort((x, y) => x.start - y.start)) {
    if (l.hasSubst) return false;
    rest += code.slice(prev, l.start);
    prev = l.end;
  }
  rest += code.slice(prev, b);
  return /^[\s+]*$/.test(rest) || /^\s*\d+\s*$/.test(rest);
}

/**
 * Scan one JavaScript source.
 * @param {string} src
 * @param {{file: string, allowNetwork?: boolean, lineOffset?: number, allowedOrigins?: readonly string[]}} ctx
 * @returns {Violation[]}
 */
export function scanJs(src, ctx) {
  /** @type {Violation[]} */
  const found = [];
  const { code, literals } = lexJs(src);
  const off = ctx.lineOffset ?? 0;
  const origins = (ctx.allowedOrigins ?? ALLOWED_ORIGINS).map((o) => o.toLowerCase());
  const add = (/** @type {number} */ index, /** @type {Violation['kind']} */ kind, /** @type {string} */ rule, /** @type {string} */ message) =>
    found.push({ file: ctx.file, line: lineAt(src, index) + off, kind, rule, message });

  // 1. network APIs by name (comments and strings already blanked)
  for (const api of NETWORK_APIS) {
    if (api === 'fetch' && ctx.allowNetwork) continue;
    const re = new RegExp(`(?<![\\w$])${api}(?![\\w$])`, 'g');
    for (const m of code.matchAll(re)) {
      add(m.index ?? 0, 'network', `api:${api}`, `${api} is a network API; only ${ALLOWED_NETWORK_FILES[0]} may make a request.`);
    }
  }
  // ... and by string, e.g. self['fetch'], self[`fetch`], or a string joined from pieces, self['fe' + 'tch']
  const named = (/** @type {string} */ v) => NETWORK_APIS.includes(v) && !(v === 'fetch' && ctx.allowNetwork);
  for (const l of literals) {
    if (!l.hasSubst && named(l.value)) {
      add(l.start, 'network', `api-string:${l.value}`, `"${l.value}" names a network API (bracket access or a lookup by name).`);
    }
  }
  for (const chain of literalChains(code, literals)) {
    if (named(chain.value)) {
      add(chain.start, 'network', `api-string:${chain.value}`, `A string joined from pieces names the network API ${chain.value}.`);
    }
  }
  // ... and by a computed name on a global object: navigator[name], globalThis[a + b], Reflect.get(self, name)
  for (const m of code.matchAll(new RegExp(`(?<![\\w$.])(?:${GLOBAL_OBJECTS})\\s*\\??\\.?\\s*\\[`, 'g'))) {
    const open = (m.index ?? 0) + m[0].length - 1;
    if (!isFixedKey(code, literals, bracketSpan(code, open))) {
      add(m.index ?? 0, 'network', 'api-computed', 'A property of a global object is looked up by a computed name; it could be a network API.');
    }
  }
  for (const m of code.matchAll(/(?<![\w$.])Reflect\s*\.\s*get\s*\(/g)) {
    const spans = argSpans(code, (m.index ?? 0) + m[0].length - 1);
    if (spans.length < 2) continue;
    const target = code.slice(spans[0][0], spans[0][1]).trim();
    if (new RegExp(`^(?:${GLOBAL_OBJECTS})$`).test(target) && !isFixedKey(code, literals, spans[1])) {
      add(m.index ?? 0, 'network', 'api-computed', 'Reflect.get on a global object with a computed name; it could be a network API.');
    }
  }

  // 2. importScripts / new Worker / new SharedWorker / new Audio / dynamic import(): only local literal URLs
  const callRe = /(?<![\w$.])(importScripts|import|new\s+Worker|new\s+SharedWorker|new\s+Audio)\s*\(/g;
  for (const m of code.matchAll(callRe)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const name = m[1].replace(/\s+/g, ' ');
    if (name === 'new Audio' && code.slice(...firstArgSpan(code, open)).trim() === '') continue; // new Audio(): no URL
    const verdict = classifyArg(code, literals, /** @type {[number, number]} */ (firstArgSpan(code, open)));
    if (verdict.kind === 'remote') {
      add(m.index ?? 0, 'network', `load:${name}`, `${name}() loads code from outside this site.`);
    } else if (verdict.kind === 'computed') {
      add(m.index ?? 0, 'network', `load-computed:${name}`, `${name}() with a computed URL: use a literal path on this site.`);
    }
  }

  // 3. static import/export ... from 'https://...' and bare import 'https://...'
  for (const l of literals) {
    if (l.template) continue;
    const before = code.slice(Math.max(0, l.start - 12), l.start);
    if (/(?<![\w$.])(?:from|import)\s*$/.test(before) && isRemoteRef(l.value)) {
      add(l.start, 'network', 'import-remote', 'Module imported from another host.');
    }
  }

  // 4. remote resource URLs assigned in code: x.src = 'https://...', setAttribute('src', 'https://...'), url(https://)
  for (const l of literals) {
    if (l.hasSubst) continue;
    const v = l.value;
    const before = code.slice(Math.max(0, l.start - 40), l.start);
    if (isRemoteRef(v) && /\.(?:src|srcset|poster|data|action|formAction|ping|background)\s*=\s*$/.test(before)) {
      add(l.start, 'network', 'assign-remote', 'A resource URL on another host is assigned in code.');
    }
    if (isRemoteRef(v) && /setAttribute\s*\(\s*(['"])(?:src|srcset|poster|data|action|formaction|ping|background)\1\s*,\s*$/i
      .test(src.slice(Math.max(0, l.start - 60), l.start))) {
      add(l.start, 'network', 'attr-remote', 'A resource attribute on another host is set in code.');
    }
    if (
      /url\(\s*\\?['"]?\s*(?:https?:|\/\/)/i.test(v) ||
      /@import\s*(?:url\()?\s*\\?['"]?\s*(?:https?:|\/\/)/i.test(v) ||
      /image-set\([^)]*?\\?['"]\s*(?:https?:|\/\/)/i.test(v)
    ) {
      add(l.start, 'network', 'css-remote-in-js', 'CSS in a string loads from another host.');
    }
    if (v.includes('<') && (REMOTE_ATTR_IN_HTML.test(v) || REMOTE_HREF_IN_HTML.test(v))) {
      add(l.start, 'network', 'html-remote-in-js', 'HTML in a string loads from another host.');
    }
  }

  // 4b. a computed URL in a resource property or attribute: img.src = base + data, setAttribute('src', url)
  for (const m of code.matchAll(new RegExp(`\\.\\s*(?:${RESOURCE_PROPS})\\s*=(?![=>])`, 'g'))) {
    const verdict = classifyUrlValue(src, code, literals, rhsSpan(code, (m.index ?? 0) + m[0].length));
    if (verdict.kind === 'computed') {
      add(m.index ?? 0, 'network', 'assign-computed', 'A computed URL is put into a property that loads it; use a fixed local path.');
    }
  }
  for (const m of code.matchAll(/(?<![\w$])setAttribute(?:NS)?\s*\(/g)) {
    const spans = argSpans(code, (m.index ?? 0) + m[0].length - 1);
    const ns = /NS\s*\($/.test(m[0]) ? 1 : 0;
    if (spans.length < 2 + ns) continue;
    const nameLits = literals.filter((l) => l.start >= spans[ns][0] && l.end <= spans[ns][1] && !l.hasSubst);
    if (nameLits.length !== 1) continue; // a computed attribute name (view-dom.js setAttr) is checked where it is called
    const attr = nameLits[0].value.trim().toLowerCase().replace(/^xlink:/, '');
    if (attr === 'srcdoc') {
      add(m.index ?? 0, 'dom-sink', 'dom-sink:srcdoc', 'srcdoc writes HTML from a string; library text must go in as text.');
      continue;
    }
    if (!RESOURCE_ATTR_NAMES.has(attr)) continue;
    if (classifyUrlValue(src, code, literals, spans[1 + ns]).kind === 'computed') {
      add(m.index ?? 0, 'network', 'attr-computed', `setAttribute('${attr}', ...) with a computed URL; use a fixed local path.`);
    }
  }
  // ... and elements that load something by themselves
  for (const l of literals) {
    if (l.hasSubst || !LOADING_ELEMENTS.has(l.value.trim().toLowerCase())) continue;
    if (/(?<![\w$])createElement(?:NS)?\s*\(\s*(?:[^,()]*,\s*)?$/.test(code.slice(Math.max(0, l.start - 200), l.start))) {
      add(l.start, 'network', 'load-element', `document.createElement('${l.value.trim().toLowerCase()}') makes an element that loads from a URL.`);
    }
  }

  // 4c. navigation to a computed URL: no CSP directive stops it, and the URL can carry data to another site
  const NAV_ASSIGN = new RegExp(
    `(?<![\\w$.])(?:(?:${GLOBAL_OBJECTS}|document|top|parent|opener|frames)\\s*\\.\\s*)?location` +
      '(?:\\s*\\.\\s*(?:href|host|hostname|protocol|port|pathname|search|origin))?\\s*=(?![=>])',
    'g',
  );
  for (const m of code.matchAll(NAV_ASSIGN)) {
    if (/(?:const|let|var)\s+$/.test(code.slice(Math.max(0, (m.index ?? 0) - 12), m.index))) continue; // a local variable
    const verdict = classifyUrlValue(src, code, literals, rhsSpan(code, (m.index ?? 0) + m[0].length));
    if (verdict.kind === 'computed') {
      add(m.index ?? 0, 'network', 'nav-computed', 'The page navigates to a computed URL, which can carry data to another site.');
    }
  }
  const NAV_CALL = new RegExp(
    `(?<![\\w$])(?:location\\s*\\.\\s*(?:assign|replace)|(?<![\\w$.])(?:${GLOBAL_OBJECTS}|top|parent|opener)\\s*\\.\\s*open)\\s*\\(`,
    'g',
  );
  for (const m of code.matchAll(NAV_CALL)) {
    const verdict = classifyUrlValue(src, code, literals, firstArgSpan(code, (m.index ?? 0) + m[0].length - 1));
    if (verdict.kind === 'computed') {
      add(m.index ?? 0, 'network', 'nav-computed', 'The page navigates to a computed URL, which can carry data to another site.');
    }
  }

  // 4d. code from strings (the CSP blocks these anyway: no 'unsafe-eval') and HTML from strings
  for (const m of code.matchAll(/(?<![\w$])eval\s*\(|(?<![\w$.])(?:new\s+)?Function\s*\(/g)) {
    add(m.index ?? 0, 'csp-inline', 'eval', 'eval and new Function run code from a string; the CSP blocks them.');
  }
  for (const m of code.matchAll(/(?<![\w$.])(?:setTimeout|setInterval)\s*\(/g)) {
    const span = firstArgSpan(code, (m.index ?? 0) + m[0].length - 1);
    const lits = literals.filter((l) => l.start >= span[0] && l.end <= span[1]);
    if (lits.length > 0 && code.slice(span[0], lits[0].start).trim() === '') {
      add(m.index ?? 0, 'csp-inline', 'string-timer', 'A timer given a string runs it as code; the CSP blocks it. Pass a function.');
    }
  }
  const SINKS = [
    [/\.\s*innerHTML\s*\+?=(?![=>])/g, 'innerHTML'],
    [/\.\s*outerHTML\s*\+?=(?![=>])/g, 'outerHTML'],
    [/\.\s*insertAdjacentHTML\s*\(/g, 'insertAdjacentHTML'],
    [/(?<![\w$])document\s*\.\s*write(?:ln)?\s*\(/g, 'document.write'],
    [/\.\s*srcdoc\s*=(?![=>])/g, 'srcdoc'],
    [/(?<![\w$])createContextualFragment\s*\(/g, 'createContextualFragment'],
    [/(?<![\w$])(?:setHTMLUnsafe|parseHTMLUnsafe)\s*\(/g, 'setHTMLUnsafe'],
  ];
  for (const [re, name] of /** @type {[RegExp, string][]} */ (SINKS)) {
    for (const m of code.matchAll(re)) {
      add(m.index ?? 0, 'dom-sink', `dom-sink:${name}`, `${name} writes HTML from a string; library text must go in as text (view-dom.js h()).`);
    }
  }

  // 5. in the allowed file, every absolute URL must be one of the payment-provider API origins
  if (ctx.allowNetwork) {
    for (const l of literals) {
      const v = l.value;
      if (!/:\/\/|^\s*\/\//.test(v)) continue;
      if (l.hasSubst) {
        add(l.start, 'network', 'license-url-template', 'A URL in the licence module is assembled at run time.');
        continue;
      }
      const origin = originOf(v);
      if (!origin || !origins.includes(origin) || !/^(?:https?|wss?):\/\/[^/?#]*(?:[/?#]|$)/i.test(v.trim())) {
        add(l.start, 'network', 'license-url', `The licence module may only name ${origins.join(' and ')}.`);
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------------------------------------------
// CSS checks

/**
 * @param {string} src
 * @param {{file: string, lineOffset?: number}} ctx
 * @returns {Violation[]}
 */
export function scanCss(src, ctx) {
  /** @type {Violation[]} */
  const found = [];
  const off = ctx.lineOffset ?? 0;
  const text = decodeCssEscapes(src.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, (m) => m.replace(/[^\n]/g, ' ')));
  /** @type {[number, number][]} @import statements, so their url() is reported once, as an import */
  const imports = [];
  // "@import" needs no space before its string: @import"https://x/a.css" is valid CSS.
  for (const m of text.matchAll(/@import(?![\w-])\s*(?:url\(\s*)?(['"]?)([^'");\s]*)[^;]*;?/gi)) {
    const at = m.index ?? 0;
    imports.push([at, at + m[0].length]);
    if (isRemoteRef(m[2])) {
      found.push({ file: ctx.file, line: lineAt(text, at) + off, kind: 'network', rule: 'css-import', message: 'CSS @import loads from another host.' });
    }
  }
  for (const m of text.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    const at = m.index ?? 0;
    if (imports.some(([a, b]) => at >= a && at < b)) continue;
    if (isRemoteRef(m[2])) {
      found.push({ file: ctx.file, line: lineAt(text, at) + off, kind: 'network', rule: 'css-url', message: 'CSS url() loads from another host.' });
    }
  }
  // image-set() and -webkit-image-set() also take plain strings as URLs: image-set("https://x/a.png" 1x)
  for (const m of text.matchAll(/image-set\(([^;{}]*)/gi)) {
    for (const s of m[1].matchAll(/(['"])(.*?)\1/g)) {
      if (isRemoteRef(s[2])) {
        found.push({ file: ctx.file, line: lineAt(text, m.index ?? 0) + off, kind: 'network', rule: 'css-url', message: 'CSS image-set() loads from another host.' });
        break;
      }
    }
  }
  return found.sort((x, y) => x.line - y.line);
}

/**
 * Decode CSS escapes (\74 or \t for "t"), so url(h\74tps://x) and @\69mport are seen as what the browser reads.
 * A line break consumed by a hex escape is kept, so line numbers hold.
 * @param {string} css
 */
export function decodeCssEscapes(css) {
  return css.replace(/\\(?:([0-9a-fA-F]{1,6})(\r\n|[ \t\n\r\f])?|([^\n\r\f0-9a-fA-F]))/g, (_, hex, ws, ch) => {
    if (ch !== undefined) return ch;
    const cp = parseInt(hex, 16);
    const decoded = cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '�';
    return ws && /[\n\r\f]/.test(ws) ? `${decoded}\n` : decoded;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// HTML / SVG checks

/** Attributes that make the browser load something, on any element. */
const RESOURCE_ATTRS = new Set(['src', 'srcset', 'imagesrcset', 'poster', 'data', 'action', 'formaction', 'background', 'manifest', 'codebase', 'archive', 'longdesc', 'lowsrc', 'dynsrc']);
/** Elements whose href loads something (an <a href> is only a link the user may click). */
const HREF_LOADS = new Set(['link', 'base', 'use', 'image', 'feimage', 'script', 'tref', 'pattern', 'filter', 'cursor', 'font-face-uri']);
/** <link rel> values that never fetch the target. */
const LINK_REL_NO_FETCH = new Set(['canonical', 'alternate', 'author', 'license', 'me', 'help', 'privacy-policy', 'terms-of-service', 'bookmark', 'external', 'nofollow', 'noopener', 'noreferrer', 'next', 'prev']);
const JS_SCRIPT_TYPES = new Set(['', 'module', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript', 'text/jscript', 'text/livescript', 'application/x-javascript', 'text/x-javascript']);

/**
 * @param {string} attrText
 * @returns {{name: string, value: string|null, index: number}[]}
 */
function parseAttrs(attrText) {
  const attrs = [];
  const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const m of attrText.matchAll(re)) {
    const value = m[2] ?? m[3] ?? m[4] ?? null;
    attrs.push({ name: m[1].toLowerCase(), value, index: m.index ?? 0 });
  }
  return attrs;
}

/**
 * Scan one HTML or SVG document.
 * @param {string} src
 * @param {{file: string}} ctx
 * @returns {Violation[]}
 */
export function scanHtml(src, ctx) {
  /** @type {Violation[]} */
  const found = [];
  const text = src.replace(/<!--[\s\S]*?(?:-->|$)/g, (m) => m.replace(/[^\n]/g, ' '));
  const add = (/** @type {number} */ index, /** @type {Violation['kind']} */ kind, /** @type {string} */ rule, /** @type {string} */ message) =>
    found.push({ file: ctx.file, line: lineAt(text, index), kind, rule, message });
  const tagRe = /<([a-zA-Z][\w:.-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
  let m;
  while ((m = tagRe.exec(text))) {
    const tag = m[1].toLowerCase().replace(/^svg:/, '');
    const local = tag.includes(':') ? tag.slice(tag.indexOf(':') + 1) : tag;
    const attrs = parseAttrs(m[2] ?? '');
    const at = m.index;
    const get = (/** @type {string} */ name) => attrs.find((a) => a.name === name)?.value ?? null;
    for (const a of attrs) {
      const v = a.value ?? '';
      if (a.name === 'style') add(at, 'csp-inline', 'style-attr', `style="" on <${tag}> is blocked by the CSP; use a class.`);
      if (/^on[a-z]+$/.test(a.name)) add(at, 'csp-inline', 'event-attr', `${a.name}="" on <${tag}> is blocked by the CSP; add the listener in a script file.`);
      if (/^\s*javascript:/i.test(decodeEntities(v))) add(at, 'csp-inline', 'javascript-url', `A javascript: URL on <${tag}> is blocked by the CSP.`);
      if (a.name === 'ping' && v.trim() !== '') add(at, 'network', 'ping', `ping="" on <${tag}> sends a request when the link is clicked.`);
      if (RESOURCE_ATTRS.has(a.name) && v !== '') {
        const remote = a.name.endsWith('srcset')
          ? v.split(',').some((part) => isRemoteRef(part.trim().split(/\s+/)[0] ?? ''))
          : isRemoteRef(v);
        if (remote) add(at, 'network', `attr:${a.name}`, `<${tag} ${a.name}> loads from another host.`);
      }
      if ((a.name === 'href' || a.name === 'xlink:href') && HREF_LOADS.has(local) && v !== '' && isRemoteRef(v)) {
        if (local === 'link') {
          const rels = String(get('rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
          if (rels.length > 0 && rels.every((r) => LINK_REL_NO_FETCH.has(r))) continue;
        }
        add(at, 'network', `href:${local}`, `<${tag} href> loads from another host.`);
      }
    }
    if (local === 'meta' && String(get('http-equiv') ?? '').toLowerCase() === 'refresh') {
      const content = String(get('content') ?? '');
      const um = /url\s*=\s*['"]?([^'";]+)/i.exec(content);
      if (um && isRemoteRef(um[1])) add(at, 'network', 'meta-refresh', 'A meta refresh sends the visitor to another host.');
    }
    if (local === 'script' && !/\/>$/.test(m[0])) {
      const close = text.toLowerCase().indexOf('</script', tagRe.lastIndex);
      const end = close < 0 ? text.length : close;
      const body = text.slice(tagRe.lastIndex, end);
      const type = String(get('type') ?? '').trim().toLowerCase();
      const hasSrc = attrs.some((a) => a.name === 'src');
      if (!hasSrc && body.trim() !== '') {
        if (JS_SCRIPT_TYPES.has(type) || type === 'importmap' || type === 'speculationrules') {
          add(at, 'csp-inline', 'inline-script', 'An inline <script> is blocked by the CSP; move it into a .js file.');
          if (JS_SCRIPT_TYPES.has(type)) {
            for (const v of scanJs(body, { file: ctx.file, lineOffset: lineAt(text, tagRe.lastIndex) - 1 })) found.push(v);
          }
        }
      }
      tagRe.lastIndex = end;
    } else if (local === 'style' && !/\/>$/.test(m[0])) {
      const close = text.toLowerCase().indexOf('</style', tagRe.lastIndex);
      const end = close < 0 ? text.length : close;
      add(at, 'csp-inline', 'style-element', 'A <style> element is blocked by the CSP; move it into a .css file.');
      for (const v of scanCss(text.slice(tagRe.lastIndex, end), { file: ctx.file, lineOffset: lineAt(text, tagRe.lastIndex) - 1 })) found.push(v);
      tagRe.lastIndex = end;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------------------------------------------
// Tree scan

/**
 * @param {string} root
 * @param {{dirs?: readonly string[], allowedFiles?: readonly string[], allowedOrigins?: readonly string[]}} [options]
 * @returns {{violations: Violation[], files: string[]}}
 */
export function scanTree(root, options = {}) {
  const dirs = options.dirs ?? SCAN_DIRS;
  const allowed = options.allowedFiles ?? ALLOWED_NETWORK_FILES;
  const absRoot = resolvePath(root);
  /** @type {Violation[]} */
  const violations = [];
  /** @type {string[]} */
  const files = [];
  const seen = new Set();
  const allowedReal = new Set();
  /** Allowed files' contents: a byte-identical copy elsewhere (e.g. site/js/app/license.js) is allowed too. */
  const allowedContent = new Set();
  for (const rel of allowed) {
    const p = join(absRoot, rel);
    try {
      allowedReal.add(realpathSync(p));
      allowedContent.add(readFileSync(p, 'utf8'));
    } catch {
      // the allowed file does not exist in this tree
    }
  }
  const relOf = (/** @type {string} */ p) => relative(absRoot, p).split(sep).join('/');

  /** @param {string} dir @param {number} depth */
  const walk = (dir, depth) => {
    if (depth > 40) return;
    let entries;
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === 'node_modules' || name === '.git') continue;
      const p = join(dir, name);
      let st;
      try {
        st = lstatSync(p);
        if (st.isSymbolicLink()) st = statSync(p);
      } catch {
        continue;
      }
      let real;
      try {
        real = realpathSync(p);
      } catch {
        continue;
      }
      if (seen.has(real)) continue;
      seen.add(real);
      if (st.isDirectory()) {
        walk(p, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      const ext = extname(name).toLowerCase();
      const kind = JS_EXT.has(ext) ? 'js' : HTML_EXT.has(ext) ? 'html' : CSS_EXT.has(ext) ? 'css' : null;
      if (!kind) continue;
      const rel = relOf(p);
      files.push(rel);
      if (st.size > MAX_FILE_BYTES) {
        violations.push({ file: rel, line: 1, kind: 'scan', rule: 'too-large', message: 'File too large to scan; split it or check it by hand.' });
        continue;
      }
      let text;
      try {
        text = readFileSync(p, 'utf8');
      } catch {
        violations.push({ file: rel, line: 1, kind: 'scan', rule: 'unreadable', message: 'File could not be read.' });
        continue;
      }
      const allowNetwork = kind === 'js' && (allowedReal.has(real) || allowedContent.has(text));
      try {
        if (kind === 'js') violations.push(...scanJs(text, { file: rel, allowNetwork, allowedOrigins: options.allowedOrigins }));
        else if (kind === 'css') violations.push(...scanCss(text, { file: rel }));
        else {
          const found = scanHtml(text, { file: rel });
          violations.push(...(Object.hasOwn(CSP_INLINE_EXCEPTIONS, rel) ? found.filter((v) => v.kind !== 'csp-inline') : found));
        }
      } catch (err) {
        violations.push({ file: rel, line: 1, kind: 'scan', rule: 'scanner-error', message: `The scanner failed on this file (${String(/** @type {Error} */ (err)?.message ?? err).slice(0, 120)}).` });
      }
    }
  };
  for (const d of dirs) {
    const p = join(absRoot, d);
    if (existsSync(p)) walk(p, 0);
  }
  return { violations, files };
}

// ---------------------------------------------------------------------------------------------------------------
// CLI

function main() {
  const args = process.argv.slice(2);
  let root = resolvePath(fileURLToPath(new URL('..', import.meta.url)));
  let json = false;
  for (let k = 0; k < args.length; k++) {
    if (args[k] === '--root' && args[k + 1]) root = resolvePath(args[++k]);
    else if (args[k] === '--json') json = true;
    else {
      process.stderr.write(`check-no-network: unknown argument ${args[k]}\nUsage: node tools/check-no-network.js [--root <repo>] [--json]\n`);
      process.exit(2);
    }
  }
  const { violations, files } = scanTree(root);
  if (json) {
    process.stdout.write(`${JSON.stringify({ files: files.length, violations }, null, 2)}\n`);
  } else if (violations.length === 0) {
    process.stdout.write(`check-no-network: OK. ${files.length} files in ${SCAN_DIRS.join('/ and ')}/ make no network request outside ${ALLOWED_NETWORK_FILES[0]}.\n`);
  } else {
    for (const v of violations) process.stdout.write(`${v.file}:${v.line}  [${v.kind}] ${v.message}  (${v.rule})\n`);
    process.stdout.write(`check-no-network: ${violations.length} problem(s) in ${files.length} files.\n`);
  }
  process.exit(violations.length === 0 ? 0 : 1);
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) main();
