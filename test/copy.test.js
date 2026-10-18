// User-visible text is in US English (decision B36): the strings in src/ (messages, labels, the report and the
// structure-only dump), the text of every page in site/, and the help articles in docs/help/. Code-shaped strings
// (problem codes such as 'cancelled', DOM ids such as 'forget-licence') are not text and are left alone, and so are
// comments.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** British spellings that have crept in before, plus their common relatives. */
const BRITISH =
  /\b(colour\w*|cancell(ed|ing|ation)?\b|normalis\w*|organis\w*|recognis\w*|behaviour\w*|favourite\w*|analys(e|ed|es|ing)\b|licence\w*|centre\w*|metres?\b|catalogue\w*|grey\w*|travell\w*|modell\w*|labell\w*|practis\w*|judgement|whilst|programme\w*|honour\w*|neighbour\w*)/i;

/** @param {string} dir @param {string} ext @returns {string[]} */
function files(dir, ext) {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path, ext));
    else if (extname(name) === ext) out.push(path);
  }
  return out;
}

/**
 * The string literals of a JavaScript file, comments skipped. A small scanner: quotes, template literals (without
 * their ${…} parts), line and block comments. Regex literals are rare in src/ and contain no British words.
 * @param {string} src
 * @returns {string[]}
 */
export function stringLiterals(src) {
  /** @type {string[]} */
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      i = end < 0 ? src.length : end;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      let text = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') {
          text += src[j + 1] ?? '';
          j += 2;
        } else if (c === '`' && src[j] === '$' && src[j + 1] === '{') {
          let depth = 1;
          j += 2;
          while (j < src.length && depth > 0) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') depth--;
            j++;
          }
          text += ' ';
        } else if (c !== '`' && src[j] === '\n') break; // not a string after all (a regex with a quote, say)
        else text += src[j++];
      }
      out.push(text);
      i = j + 1;
    } else i++;
  }
  return out;
}

/** A code, an id, a key or a path: no spaces and no capital letters. */
const codeShaped = (/** @type {string} */ s) => /^[a-z0-9_.#:\-/]*$/.test(s);

/** @param {string} where @param {string} text @param {string[]} found */
function check(where, text, found) {
  const m = BRITISH.exec(text);
  if (m) found.push(`${where}: "${m[0]}" in "${text.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ')}"`);
}

test('the scanner finds string literals and skips comments and code-shaped strings', () => {
  const lits = stringLiterals("// a colour\nconst a = 'Some colours'; /* colour */ const b = `x ${'y'} cancelled`; f('cancelled');");
  assert.deepEqual(lits, ['Some colours', 'x   cancelled', 'cancelled']);
  assert.ok(codeShaped('cancelled') && codeShaped('forget-licence') && !codeShaped('Reading was cancelled.'));
  /** @type {string[]} */
  const found = [];
  for (const s of ['Reading was cancelled.', 'track colours', 'a licence key', 'records analysed', 'recognise it']) check('t', s, found);
  for (const s of ['Reading was canceled.', 'track colors', 'a license key', 'licenses', 'an analysis', 'recognize it']) check('t', s, found);
  assert.equal(found.length, 5, found.join('\n'));
});

test('strings in src/ are US English (B36)', () => {
  /** @type {string[]} */
  const found = [];
  for (const file of files(join(ROOT, 'src'), '.js')) {
    for (const lit of stringLiterals(readFileSync(file, 'utf8'))) {
      if (!codeShaped(lit)) check(relative(ROOT, file), lit, found);
    }
  }
  assert.deepEqual(found, []);
});

test('the pages in site/ are US English (B36)', () => {
  /** @type {string[]} */
  const found = [];
  for (const file of files(join(ROOT, 'site'), '.html')) {
    const html = readFileSync(file, 'utf8');
    // Visible text, then the attributes people read or hear.
    check(relative(ROOT, file), html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, ' '), found);
    for (const m of html.matchAll(/\s(?:alt|title|aria-label|placeholder|content)="([^"]*)"/g)) check(relative(ROOT, file), m[1], found);
  }
  assert.deepEqual(found, []);
});

test('the help articles in docs/help/ are US English (B36)', () => {
  /** @type {string[]} */
  const found = [];
  for (const file of files(join(ROOT, 'docs', 'help'), '.md')) {
    // Inline code is a quoted file or identifier, not prose.
    readFileSync(file, 'utf8').split('\n').forEach((line, n) => check(`${relative(ROOT, file)}:${n + 1}`, line.replace(/`[^`]*`/g, ' '), found));
  }
  assert.deepEqual(found, []);
});

test('menu paths in src/ strings are written "File › Backup", as the pages write them', () => {
  /** @type {string[]} */
  const found = [];
  for (const file of files(join(ROOT, 'src'), '.js')) {
    for (const lit of stringLiterals(readFileSync(file, 'utf8'))) {
      const m = /\b(File|Edit|View|Go|BaseCamp|Preferences) > [A-Z]/.exec(lit);
      if (m) found.push(`${relative(ROOT, file)}: "${lit.slice(Math.max(0, m.index - 30), m.index + 30)}"`);
    }
  }
  assert.deepEqual(found, []);
});
