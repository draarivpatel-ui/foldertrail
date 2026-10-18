// Browser compatibility guards (docs/research/compat.md has the full table and its sources).
//
// Targets: Safari 15.0 and later on macOS (decision B21), Chrome 116 and Firefox ESR 115 (the last versions for macOS
// 10.13 and 10.14), and current Chrome, Firefox and Safari. Version numbers below are from MDN browser-compat-data,
// read on 2026-10-06, unless a comment says otherwise.
//
// What is checked:
// - JavaScript syntax in the shipped modules (every src/**/*.js except app/probe.js, which tools/build.js leaves out),
//   parsed with the copy of acorn that ships inside Node (reached with --expose-internals in a child process; the
//   syntax tests are skipped, saying so, if a future Node drops it):
//   - nothing newer than the targets: no class static blocks (Safari 16.4), no public class fields (partial in
//     Safari 14.1-15.6), no regular-expression lookbehind (Safari 16.4) or v flag (Firefox 116), no import attributes;
//   - no parenthesised expression inside a class field initializer: Safari 15 throws a ReferenceError on that
//     (WebKit bug 236843, fixed in March 2022; BCD: "Parentheses in field initializers can lead to ReferenceErrors");
//   - no spread arguments of unbounded length: JavaScriptCore throws a RangeError for a call with more than 65,536
//     arguments (maxArguments = 0x10000 in Safari 15's Interpreter.h; V8 fails at about 124,000 in Node 26);
//   - no API newer than the targets, and the two used only behind feature detection (String.prototype.isWellFormed,
//     Intl.Segmenter) really are behind it;
//   - src/app/main.js, which must run in an old browser to say it is too old: no syntax newer than import() itself
//     (Safari 11.1, Chrome 63, Firefox 67) and no static import.
// - The planner really survives a list of more than 65,536 items in "one GPX per item" mode.
// - With the built-ins Safari 15.0 and Firefox 115 lack deleted (Compression Streams, isWellFormed, Intl.Segmenter,
//   Array.prototype.at and more), every fixture scenario reads, previews and exports to the same files and report as
//   with them, and a deflated .Backup is explained instead of opened.
// - CSS: what Safari needs a -webkit- prefix for has one, values Safari 15.0 lacks come after a fallback, and nothing
//   drops a whole rule in a target browser.
// - The Content-Security-Policy lets Safari before 15.5 start the worker (child-src 'self', decision B38).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { planFiles } from '../src/app/pipeline.js';
import { buildScenario } from '../tools/fixtures/scenarios.js';
import { buildBackup } from '../tools/fixtures/backup.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const SITE = join(ROOT, 'site');

/** Files under src/ that tools/build.js does not ship (its SRC_EXCLUDE). */
const NOT_SHIPPED = new Set(['app/probe.js']);

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)],
  );
}

const shipped = walk(SRC)
  .filter((f) => f.endsWith('.js'))
  .map((f) => relative(SRC, f).split(sep).join('/'))
  .filter((f) => !NOT_SHIPPED.has(f))
  .sort();

// ---------------------------------------------------------------------------------------------
// The syntax scan, run in a child process that can reach Node's bundled acorn.

const SCAN = String.raw`
const fs = require('fs');
const path = require('path');
let acorn, walk;
try {
  acorn = require('internal/deps/acorn/acorn/dist/acorn');
  walk = require('internal/deps/acorn/acorn-walk/dist/walk');
} catch (error) {
  process.stdout.write(JSON.stringify({ unavailable: String(error && error.message) }));
  process.exit(0);
}
const [root, configJson, ...files] = process.argv.slice(1);
const config = JSON.parse(configJson);
const names = new Set(config.names);
const members = new Set(config.members);
const statics = new Set(config.statics);
const out = {};
for (const rel of files) {
  const src = fs.readFileSync(path.join(root, rel), 'utf8');
  const findings = [];
  const text = (node) => src.slice(node.start, Math.min(node.end, node.start + 100)).replace(/\s+/g, ' ');
  let ast;
  try {
    ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true, preserveParens: true });
  } catch (error) {
    findings.push({ rule: 'parse', where: rel, text: String(error.message) });
    out[rel] = findings;
    continue;
  }
  walk.fullAncestor(ast, (node, _state, ancestors) => {
    const extra = describe(node, ancestors);
    if (extra) findings.push({ rule: 'node', type: node.type, where: rel + ':' + node.loc.start.line, text: text(node), extra });
  });
  out[rel] = findings;
}
process.stdout.write(JSON.stringify({ files: out }));

/** What the test needs to know about a node, or null to leave it out. */
function describe(node, ancestors) {
  const parent = ancestors[ancestors.length - 2];
  switch (node.type) {
    case 'StaticBlock': case 'ChainExpression': case 'PrivateIdentifier': case 'AwaitExpression':
    case 'ExportNamedDeclaration': case 'ExportDefaultDeclaration': case 'ExportAllDeclaration':
      return {};
    case 'Literal':
      if (node.regex) return { pattern: node.regex.pattern, flags: node.regex.flags };
      if (node.bigint) return { bigint: true };
      if (typeof node.raw === 'string' && /^[0-9.]/.test(node.raw) && node.raw.includes('_')) return { separator: true };
      return null;
    case 'PropertyDefinition':
      return { private: node.key.type === 'PrivateIdentifier' };
    case 'ParenthesizedExpression':
      return ancestors.some((a) => a.type === 'PropertyDefinition') ? { inFieldInitializer: true } : null;
    case 'CallExpression': case 'NewExpression': {
      const callee = node.callee;
      const member = callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier'
        ? callee.property.name : null;
      const spreads = node.arguments.filter((a) => a.type === 'SpreadElement').map((a) => {
        let arg = a.argument;
        while (arg.type === 'ParenthesizedExpression') arg = arg.expression;
        const literal = arg.type === 'ArrayExpression';
        const mapOfLiteral = arg.type === 'CallExpression' && arg.callee.type === 'MemberExpression' &&
          !arg.callee.computed && arg.callee.property.name === 'map' && arg.callee.object.type === 'ArrayExpression';
        return { bounded: literal || mapOfLiteral };
      });
      const calleeName = callee.type === 'Identifier' ? callee.name : null;
      if (spreads.length === 0 && !members.has(member) && member !== 'apply' && calleeName !== 'RegExp') return null;
      return { member, callee: calleeName, spreads };
    }
    case 'MemberExpression': {
      const object = node.object.type === 'Identifier' ? node.object.name : null;
      const property = !node.computed && node.property.type === 'Identifier' ? node.property.name : null;
      const key = object + '.' + property;
      if (statics.has(key)) return { object, property };
      if (config.detected.includes(property)) return { object, property, guarded: guardedByTypeof(ancestors) };
      return null;
    }
    case 'Identifier':
      return names.has(node.name) ? { name: node.name } : null;
    case 'LogicalExpression':
      return node.operator === '??' ? { operator: node.operator } : null;
    case 'AssignmentExpression':
      return ['??=', '||=', '&&='].includes(node.operator) ? { operator: node.operator } : null;
    case 'ImportDeclaration':
      return { attributes: (node.attributes || []).length };
    case 'ImportExpression':
      return { options: Boolean(node.options) };
    case 'VariableDeclaration':
      return /using/.test(node.kind) ? { kind: node.kind } : null;
    default:
      return null;
  }
}

/** Whether the function around the last node (or, at the top level, its statement) tests something with typeof. */
function guardedByTypeof(ancestors) {
  let scope = ancestors[1] || ancestors[0];
  for (let i = ancestors.length - 2; i > 0; i--) {
    if (/Function/.test(ancestors[i].type)) {
      scope = ancestors[i];
      break;
    }
  }
  let found = false;
  walk.full(scope, (n) => {
    if (n.type === 'UnaryExpression' && n.operator === 'typeof') found = true;
  });
  return found;
}
`;

/**
 * @typedef {{rule: string, type?: string, where: string, text: string, extra?: any}} Finding
 * @param {string} [root]
 * @param {string[]} [files]  relative to root
 * @returns {{unavailable?: string, files?: Record<string, Finding[]>}}
 */
function scan(root = SRC, files = shipped) {
  const config = {
    names: [...NEW_GLOBALS, ...MAIN_TOO_NEW],
    members: [...NEW_METHODS],
    statics: [...NEW_STATICS],
    detected: [...DETECTED_ONLY.keys()],
  };
  const json = execFileSync(process.execPath, ['--expose-internals', '-e', SCAN, root, JSON.stringify(config), ...files], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(json);
}

/** @type {ReturnType<typeof scan>|undefined} */
let scanned;
function nodes() {
  scanned ??= scan();
  return scanned;
}

/**
 * Runs `check` over every shipped file's nodes, or skips the test when Node's parser is not reachable.
 * @param {import('node:test').TestContext} t
 * @param {(file: string, nodes: Finding[]) => string[]} check  returns the problems found
 */
function eachFile(t, check) {
  const result = nodes();
  if (result.unavailable) {
    t.skip(`Node's bundled acorn is not reachable (${result.unavailable}); the syntax guards did not run`);
    return;
  }
  const problems = [];
  for (const [file, list] of Object.entries(/** @type {Record<string, Finding[]>} */ (result.files))) {
    problems.push(...check(file, list));
  }
  assert.deepEqual(problems, []);
}

// ---------------------------------------------------------------------------------------------
// JavaScript

test('the shipped modules all parse, and the scan saw every one of them', (t) => {
  assert.ok(shipped.includes('app/main.js') && shipped.includes('app/worker.js') && shipped.length > 20);
  eachFile(t, (file, list) => list.filter((f) => f.rule === 'parse').map((f) => `${file}: ${f.text}`));
});

/** Syntax newer than a target. @param {string} _file @param {Finding[]} list */
function syntaxProblems(_file, list) {
  const problems = [];
  for (const f of list) {
    if (f.type === 'StaticBlock') problems.push(`${f.where}: class static block (Safari 16.4)`);
    if (f.type === 'PropertyDefinition' && !f.extra.private) {
      problems.push(`${f.where}: public class field (partial in Safari 14.1-15.6): ${f.text}`);
    }
    if (f.type === 'Literal' && f.extra.pattern !== undefined) {
      if (/\(\?<[=!]/.test(f.extra.pattern)) problems.push(`${f.where}: regular-expression lookbehind (Safari 16.4)`);
      if (f.extra.flags.includes('v')) problems.push(`${f.where}: regular-expression v flag (Firefox 116, Safari 17)`);
    }
    if (f.type === 'ImportDeclaration' && f.extra.attributes > 0) problems.push(`${f.where}: import attributes`);
    if (f.type === 'ImportExpression' && f.extra.options) problems.push(`${f.where}: import() with options`);
    if (f.type === 'VariableDeclaration') problems.push(`${f.where}: using declaration`);
    if (f.type === 'NewExpression' && f.extra.callee === 'RegExp') {
      problems.push(`${f.where}: new RegExp (its pattern cannot be checked here; use a literal): ${f.text}`);
    }
  }
  return problems;
}

/** Parentheses inside class field initializers. @param {string} _file @param {Finding[]} list */
function fieldParenProblems(_file, list) {
  return list.filter((f) => f.type === 'ParenthesizedExpression').map((f) => `${f.where}: ${f.text}`);
}

/** Calls whose argument count has no bound. @param {string} file @param {Finding[]} list */
function spreadProblems(file, list) {
  const problems = [];
  for (const f of list) {
    if ((f.type === 'CallExpression' || f.type === 'NewExpression') && f.extra.spreads.some((/** @type {any} */ s) => !s.bounded)) {
      problems.push(`${f.where}: ${f.text}`);
    }
    // Function.prototype.apply has the same limit. The only uses are format/gdb.js, in slices of CHUNK values.
    if (f.type === 'CallExpression' && f.extra.member === 'apply' && file !== 'format/gdb.js') {
      problems.push(`${f.where}: .apply() (65,536-argument limit in Safari 15): ${f.text}`);
    }
  }
  return problems;
}

// APIs that at least one target lacks. Versions are given where they were read from BCD for docs/research/compat.md;
// the others are names to look up in BCD (and feature-detect) before anyone uses them.
/** Method calls (any object): `x.name(...)`. */
const NEW_METHODS = new Set([
  'at', // Array, String, TypedArray: Safari 15.4
  'findLast', // Safari 15.4
  'findLastIndex',
  'toSorted', // Safari 16, Chrome 110, Firefox 115
  'toReversed',
  'toSpliced',
  'toWellFormed', // Safari 16.4, Chrome 111, Firefox 119
  'throwIfAborted',
  'randomUUID',
  'showPopover',
  'showModal',
  'checkVisibility',
]);
/** Static members: `Name.member`. */
const NEW_STATICS = new Set([
  'Object.hasOwn',
  'Object.groupBy',
  'Map.groupBy',
  'Array.fromAsync', // Safari 16.4, Chrome 121, Firefox 115
  'Promise.withResolvers', // Safari 17.4, Chrome 119, Firefox 121
  'Promise.try',
  'ReadableStream.from', // Safari 27, Firefox 117, not in Chrome
  'AbortSignal.timeout',
  'AbortSignal.any',
  'URL.canParse',
  'URL.parse',
  'RegExp.escape',
  'Error.captureStackTrace',
  'Uint8Array.fromBase64',
  'Math.sumPrecise',
  'Iterator.from',
]);
/** Globals. */
const NEW_GLOBALS = new Set([
  'structuredClone',
  'requestIdleCallback',
  'showDirectoryPicker',
  'showOpenFilePicker',
  'showSaveFilePicker',
  'Float16Array',
  'scheduler',
]);
/** Members a target lacks, allowed only where the same function tests something with typeof. */
const DETECTED_ONLY = new Map([
  ['isWellFormed', 'String.prototype.isWellFormed: Safari 16.4, Firefox 119'],
  ['Segmenter', 'Intl.Segmenter: Firefox 125'],
]);
/** Names main.js must not use: newer than import() (Safari 11.1, Chrome 63, Firefox 67). */
const MAIN_TOO_NEW = new Set(['globalThis', 'allSettled', 'any', 'flat', 'flatMap', 'fromEntries', 'matchAll', 'replaceAll']);

/** APIs newer than a target, or used without feature detection. @param {string} _file @param {Finding[]} list */
function apiProblems(_file, list) {
  const problems = [];
  for (const f of list) {
    if (f.type === 'CallExpression' && f.extra.member && NEW_METHODS.has(f.extra.member)) {
      problems.push(`${f.where}: .${f.extra.member}() is newer than a target: ${f.text}`);
    }
    if (f.type === 'MemberExpression' && NEW_STATICS.has(`${f.extra.object}.${f.extra.property}`)) {
      problems.push(`${f.where}: ${f.extra.object}.${f.extra.property} is newer than a target`);
    }
    if (f.type === 'MemberExpression' && DETECTED_ONLY.has(f.extra.property) && !f.extra.guarded) {
      problems.push(`${f.where}: ${f.extra.property} without a typeof test in the same function (${DETECTED_ONLY.get(f.extra.property)})`);
    }
    if (f.type === 'Identifier' && NEW_GLOBALS.has(f.extra.name)) {
      problems.push(`${f.where}: ${f.extra.name} is newer than a target`);
    }
  }
  return problems;
}

test('no syntax newer than Safari 15.0, Chrome 116 and Firefox 115', (t) => eachFile(t, syntaxProblems));

test('no parenthesised expression inside a class field initializer (ReferenceError in Safari 15)', (t) =>
  eachFile(t, fieldParenProblems));

test('no call spreads an array of unbounded length into its arguments (Safari 15 stops at 65,536)', (t) => {
  eachFile(t, spreadProblems);
  const gdb = readFileSync(join(SRC, 'format', 'gdb.js'), 'utf8');
  const chunk = /^const CHUNK = (\d+);$/m.exec(gdb);
  assert.ok(chunk && Number(chunk[1]) <= 65536, 'format/gdb.js passes at most CHUNK (<= 65,536) values to apply()');
});

test('no API newer than the targets; the two that some targets lack are feature-detected', (t) => eachFile(t, apiProblems));

test('the syntax and API guards find what they look for (synthetic modules full of it)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bcr-compat-'));
  try {
    const bad = [
      'export class A {',
      '  static { this.x = 1; }',
      '  shown = 1;',
      '  #hidden = f((1));',
      '}',
      'const lookbehind = /(?<=a)b/;',
      'const unicodeSets = /[a&&b]/v;',
      'const made = new RegExp("x");',
      'list.push(...items);',
      'list.push(...[1, 2], ...(["a"].map((x) => x)));',
      'Math.max.apply(null, items);',
      'items.at(-1);',
      'Object.hasOwn(o, "k");',
      'structuredClone(o);',
      '"x".isWellFormed();',
      'function detected(s) { return typeof s.isWellFormed === "function" && s.isWellFormed(); }',
    ].join('\n');
    writeFileSync(join(dir, 'bad.js'), bad);
    const oldMain = ['import x from "./x.js";', 'a?.b;', 'a ?? b;', 'c ||= 1;', 'const n = 1_000;', 'globalThis.y = [].flat();'];
    writeFileSync(join(dir, 'main.js'), oldMain.join('\n'));
    const result = scan(dir, ['bad.js', 'main.js']);
    if (result.unavailable) {
      t.skip(`Node's bundled acorn is not reachable (${result.unavailable})`);
      return;
    }
    const list = /** @type {Record<string, Finding[]>} */ (result.files)['bad.js'];
    const lines = (/** @type {string[]} */ found) => found.map((p) => Number(/^bad\.js:(\d+)/.exec(p)?.[1])).sort((x, y) => x - y);
    assert.deepEqual(lines(syntaxProblems('bad.js', list)), [2, 3, 6, 7, 8]);
    assert.deepEqual(lines(fieldParenProblems('bad.js', list)), [4]);
    assert.deepEqual(lines(spreadProblems('bad.js', list)), [9, 11]);
    assert.deepEqual(lines(apiProblems('bad.js', list)), [12, 13, 14, 15]);
    const main = /** @type {Record<string, Finding[]>} */ (result.files)['main.js'];
    const mainLines = mainProblems('main.js', main).map((p) => Number(/^main\.js:(\d+)/.exec(p)?.[1]));
    assert.deepEqual([...new Set(mainLines)], [1, 2, 3, 4, 5, 6]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** What main.js must not use. @param {string} _file @param {Finding[]} list */
function mainProblems(_file, list) {
  const problems = [];
  // Newer than import(): ?. and ?? (Safari 13.1), ??= and friends (Safari 14), numeric separators (Safari 13),
  // class fields, BigInt, await, and the names in MAIN_TOO_NEW.
  for (const f of list) {
    if (f.type === 'ChainExpression') problems.push(`${f.where}: ?.`);
    if (f.type === 'LogicalExpression') problems.push(`${f.where}: ??`);
    if (f.type === 'AssignmentExpression') problems.push(`${f.where}: ${f.extra.operator}`);
    if (f.type === 'Literal' && (f.extra.bigint || f.extra.separator)) problems.push(`${f.where}: ${f.text}`);
    if (f.type === 'PropertyDefinition' || f.type === 'StaticBlock') problems.push(`${f.where}: class field`);
    if (f.type === 'AwaitExpression') problems.push(`${f.where}: await`);
    if (f.type === 'ImportDeclaration' || /^Export/.test(String(f.type))) {
      problems.push(`${f.where}: static import/export (a module that fails to load would stop main.js before it can say why)`);
    }
    if (f.type === 'Identifier' && MAIN_TOO_NEW.has(f.extra.name)) problems.push(`${f.where}: ${f.extra.name}`);
  }
  return problems;
}

test('main.js uses nothing newer than import() itself, so an old browser runs it far enough to say so', (t) => {
  const result = nodes();
  if (result.unavailable) {
    t.skip(`Node's bundled acorn is not reachable (${result.unavailable})`);
    return;
  }
  const list = /** @type {Record<string, Finding[]>} */ (result.files)['app/main.js'];
  assert.ok(Array.isArray(list), 'main.js was scanned');
  assert.deepEqual(mainProblems('app/main.js', list), []);
});

test('one GPX per item: a list or type of more than 65,536 items does not overflow the argument limit', () => {
  // 130,000 also passes V8's own limit (about 124,000 arguments in Node 26), so this fails in Node, not only Safari.
  const n = 130_000;
  const items = Array.from({ length: n }, (_, i) => ({
    kind: /** @type {const} */ ('waypoint'), id: `w${i}`, name: `Point ${i}`, comment: '', symbol: '', icon: null,
    lat: 0, lon: 0, ele: null, time: null,
  }));
  for (const treeMissing of [true, false]) {
    const folders = treeMissing
      ? []
      : [
          { id: 'root', name: 'Library', type: /** @type {const} */ ('folder'), parentId: null, itemIds: [] },
          { id: 'big', name: 'Big list', type: /** @type {const} */ ('list'), parentId: 'root', itemIds: items.map((i) => i.id) },
        ];
    const plan = planFiles({ items, folders, problems: [], treeMissing }, new Set(), true);
    const perItem = plan.files.filter((f) => !f.all);
    assert.equal(perItem.length, n, `one file per item (treeMissing: ${treeMissing})`);
    assert.equal(new Set(perItem.map((f) => f.path)).size, n, 'every path is different');
  }
});

/**
 * Built-ins Safari 15.0 or Firefox 115 lacks (BCD, read 2026-10-06; Object.hasOwn and structuredClone: Safari 15.4,
 * as the task brief and MDN state). The run below deletes them, then reads and exports every fixture scenario.
 */
const STRIP = String.raw`
const gone = [];
const drop = (owner, key, label) => {
  if (owner && key in owner) {
    delete owner[key];
    gone.push(label);
  }
};
drop(globalThis, 'CompressionStream', 'CompressionStream'); // Safari 16.4
drop(globalThis, 'DecompressionStream', 'DecompressionStream'); // Safari 16.4
drop(String.prototype, 'isWellFormed', 'String.prototype.isWellFormed'); // Safari 16.4, Firefox 119
drop(String.prototype, 'toWellFormed', 'String.prototype.toWellFormed');
drop(Intl, 'Segmenter', 'Intl.Segmenter'); // Firefox 125
for (const name of ['at', 'findLast', 'findLastIndex', 'toSorted', 'toReversed', 'toSpliced', 'with']) {
  drop(Array.prototype, name, 'Array.prototype.' + name); // at, findLast: Safari 15.4; toSorted: Safari 16
  drop(Object.getPrototypeOf(Uint8Array.prototype), name, '%TypedArray%.prototype.' + name);
}
drop(String.prototype, 'at', 'String.prototype.at'); // Safari 15.4
drop(Object, 'hasOwn', 'Object.hasOwn'); // Safari 15.4
drop(globalThis, 'structuredClone', 'structuredClone'); // Safari 15.4
drop(Array, 'fromAsync', 'Array.fromAsync'); // Safari 16.4
drop(Promise, 'withResolvers', 'Promise.withResolvers'); // Safari 17.4, Firefox 121
drop(Object, 'groupBy', 'Object.groupBy');
drop(Map, 'groupBy', 'Map.groupBy');
drop(ReadableStream, 'from', 'ReadableStream.from'); // Safari 27, not in Chrome
drop(ReadableStream.prototype, Symbol.asyncIterator, 'ReadableStream async iteration'); // Safari 27
drop(ReadableStream.prototype, 'values', 'ReadableStream.prototype.values');
drop(Blob.prototype, 'bytes', 'Blob.prototype.bytes'); // Safari 18
`;

const RUN_SCENARIOS = String.raw`
// The fixture writer is a Node tool that may use anything: every scenario is built before anything is removed and
// before the app's modules are loaded.
const { buildScenario, scenarioNames } = await import(process.env.BCR_SCENARIOS_URL);
const built = new Map(scenarioNames().map((name) => [name, buildScenario(name).built.files]));
let stripped = [];
if (process.env.BCR_COMPAT_STRIP === '1') {
  ${STRIP}
  stripped = gone;
}
const { Pipeline } = await import(process.env.BCR_PIPELINE_URL);

function workerSource(files) {
  const ref = (name, bytes) => ({ name, path: name, size: bytes.length, lastModified: null, blob: new Blob([bytes]), index: null, entryName: null });
  const get = (name) => (files.has(name) ? ref(name, files.get(name)) : null);
  return {
    kind: 'files', archive: null, allData: get('AllData.gdb'), folderData: get('FolderData.gfi'),
    trackSegments: [...files].filter(([p]) => p.startsWith('TrackSegments/')).map(([p, b]) => [p.slice(14), ref(p.slice(14), b)]),
    versionFolder: 'Database/4.8', version: '4.8',
  };
}

/** The central directory: [name, method, crc, uncompressed size] per entry (ZIP64 not needed for fixtures). */
function central(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return 'no end of central directory';
  const out = [];
  let at = v.getUint32(eocd + 16, true);
  for (let k = v.getUint16(eocd + 10, true); k > 0; k--) {
    const n = v.getUint16(at + 28, true);
    out.push([new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + n)), v.getUint16(at + 10, true), v.getUint32(at + 16, true), v.getUint32(at + 24, true)]);
    at += 46 + n + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
  }
  return out;
}

const result = {};
for (const [name, files] of built) {
  const posted = [];
  const pipeline = new Pipeline({ brand: 'Foldertrail', version: '0.1.0', now: () => Date.UTC(2026, 9, 6, 12), post: (m) => posted.push(m) });
  await pipeline.handle({ type: 'parse', id: 1, source: workerSource(files) });
  const parsed = posted.find((m) => m.type === 'parsed' || m.type === 'error');
  const entry = { parsed: parsed ? parsed.type + (parsed.code ? ':' + parsed.code : '') : 'nothing', preview: parsed?.preview ?? null, exports: [] };
  if (parsed?.type === 'parsed') {
    for (const options of [{ kml: true }, { perItem: true, kml: false }]) {
      const before = posted.length;
      await pipeline.handle({ type: 'export', id: 1, options });
      const done = posted.slice(before).find((m) => m.type === 'exported' || m.type === 'error');
      if (done?.type === 'exported') {
        entry.exports.push({ entries: central(new Uint8Array(await done.zip.arrayBuffer())), report: done.report?.text ?? done.report });
      } else entry.exports.push({ error: done ? done.code + ': ' + done.message : 'no answer' });
    }
  }
  result[name] = entry;
}
// A .Backup, deflated and stored (built by the parent test, so no app module was loaded before the removal).
const { intake } = await import(process.env.BCR_INTAKE_URL);
const backups = {};
for (const kind of ['deflated', 'stored']) {
  const bytes = (await import('node:fs')).readFileSync(process.env.BCR_BACKUP_DIR + '/' + kind + '.Backup');
  const found = await intake(new File([bytes], kind + '.Backup'));
  backups[kind] = { ok: found.ok, problems: found.problems.map((p) => p.code) };
}
process.stdout.write(JSON.stringify({ stripped, result, backups }));
`;

/** @param {boolean} strip @param {string} backupDir */
function runScenarios(strip, backupDir) {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', RUN_SCENARIOS], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: {
      ...process.env,
      BCR_COMPAT_STRIP: strip ? '1' : '0',
      BCR_PIPELINE_URL: pathToFileURL(join(SRC, 'app', 'pipeline.js')).href,
      BCR_SCENARIOS_URL: pathToFileURL(join(ROOT, 'tools', 'fixtures', 'scenarios.js')).href,
      BCR_INTAKE_URL: pathToFileURL(join(SRC, 'app', 'intake.js')).href,
      BCR_BACKUP_DIR: backupDir,
    },
  });
  return JSON.parse(out);
}

test('without what Safari 15.0 and Firefox 115 lack, every fixture reads and exports to the same files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bcr-compat-'));
  /** @type {{stripped: string[], result: Record<string, any>, backups: Record<string, {ok: boolean, problems: string[]}>}} */
  let run;
  /** @type {typeof run} */
  let nativeRun;
  try {
    const built = buildScenario('nested-tree').built;
    writeFileSync(join(dir, 'deflated.Backup'), await buildBackup(built, { compression: 'auto' }));
    writeFileSync(join(dir, 'stored.Backup'), await buildBackup(built, { compression: 'store' }));
    nativeRun = runScenarios(false, dir);
    run = runScenarios(true, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // A backup: opened directly where DecompressionStream exists; explained (unzip it in Finder) where it does not.
  assert.deepEqual(nativeRun.backups.deflated, { ok: true, problems: [] });
  assert.deepEqual(run.backups.deflated, { ok: false, problems: ['cannot_unzip_here'] });
  assert.deepEqual(run.backups.stored, nativeRun.backups.stored);
  assert.equal(run.backups.stored.ok, true);
  const native = nativeRun.result;
  const old = run.result;
  for (const name of ['CompressionStream', 'DecompressionStream', 'String.prototype.isWellFormed', 'Intl.Segmenter', 'Array.prototype.at']) {
    assert.ok(run.stripped.includes(name), `${name} was removed for the run`);
  }
  assert.ok(Object.keys(native).length >= 30, 'every fixture scenario ran');
  let exported = 0;
  for (const [name, want] of Object.entries(native)) {
    const got = old[name];
    assert.equal(got.parsed, want.parsed, `${name}: parse outcome`);
    assert.deepEqual(got.preview, want.preview, `${name}: preview`);
    assert.equal(got.exports.length, want.exports.length, `${name}: exports`);
    for (let i = 0; i < want.exports.length; i++) {
      const [w, g] = [want.exports[i], got.exports[i]];
      assert.equal(g.error, w.error, `${name}: export ${i} error`);
      if (w.error) continue;
      exported++;
      // Same names, CRC-32 and sizes of the uncompressed content; only the method may differ (stored, not deflated).
      assert.deepEqual(g.entries.map((/** @type {any[]} */ e) => [e[0], e[2], e[3]]), w.entries.map((/** @type {any[]} */ e) => [e[0], e[2], e[3]]), `${name}: export ${i} files`);
      assert.ok(g.entries.every((/** @type {any[]} */ e) => e[1] === 0), `${name}: without CompressionStream everything is stored`);
      assert.equal(g.report, w.report, `${name}: export ${i} report`);
    }
  }
  assert.ok(exported >= 40, `exports compared: ${exported}`);
});

// ---------------------------------------------------------------------------------------------
// CSS and HTML

const cssFiles = walk(join(SITE, 'assets')).filter((f) => f.endsWith('.css'));

/** @param {string} css @returns {{selector: string, body: string}[]} the innermost rule blocks, comments removed */
function rules(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...clean.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
}

/**
 * Declarations Safari needs a -webkit- form for, written without it.
 * user-select: Safari has only -webkit-user-select (BCD: unprefixed in Safari Technology Preview only).
 * mask, mask-image: unprefixed from Safari 15.4; in 15.0-15.3 the unprefixed property has no effect.
 * @param {string} name @param {string} css
 */
function cssPrefixProblems(name, css) {
  const problems = [];
  for (const rule of rules(css)) {
    for (const prop of ['user-select', 'mask', 'mask-image']) {
      const plain = new RegExp(`(^|[;\\s])${prop}\\s*:`).test(rule.body);
      const prefixed = new RegExp(`-webkit-${prop}\\s*:`).test(rule.body);
      if (plain && !prefixed) problems.push(`${name}: "${rule.selector}" sets ${prop} without -webkit-${prop}`);
    }
  }
  return problems;
}

/**
 * CSS that makes a target browser drop a whole rule or block (BCD versions).
 * @param {string} name @param {string} source
 */
function cssDropProblems(name, source) {
  const problems = [];
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  /** @type {[RegExp, string][]} */
  const checks = [
    [/@layer\b/, '@layer (Safari 15.4: an older Safari drops the whole block)'],
    [/@container\b/, '@container (Safari 16, Firefox 110)'],
    [/@scope\b/, '@scope (Firefox 146, Safari 26.4)'],
    [/@starting-style\b/, '@starting-style'],
    [/:has\(/, ':has() (Firefox 121)'],
    [/\((?:min-|max-)?(?:width|height)\s*[<>]|[<>]=?\s*(?:width|height)\s*\)/, 'media range syntax (Safari 16.4)'],
    [/&/, 'nesting with & (Chrome 120, Firefox 117, Safari 17.2)'],
  ];
  for (const [pattern, why] of checks) if (pattern.test(css)) problems.push(`${name}: ${why}`);
  // Nesting without &: a rule block inside a rule block that is not an at-rule.
  for (const m of css.matchAll(/([^{};]*)\{([^{}]*)\{/g)) {
    if (!m[1].trim().startsWith('@')) problems.push(`${name}: nested rule inside "${m[1].trim()}"`);
  }
  return problems;
}

/**
 * Values a target lacks, used without a fallback declaration of the same property earlier in the same rule.
 * overflow-wrap: anywhere is Safari 15.4 (BCD); before that the declaration is dropped and a long name without
 * spaces runs out of its box, so overflow-wrap: break-word (Safari 1) must come first.
 * @param {string} name @param {string} css
 */
function cssFallbackProblems(name, css) {
  const needs = [{ prop: 'overflow-wrap', value: 'anywhere', fallback: /(^|[;\s])(overflow-wrap|word-wrap)\s*:\s*break-word/ }];
  const problems = [];
  for (const rule of rules(css)) {
    for (const need of needs) {
      const at = rule.body.search(new RegExp(`(^|[;\\s])${need.prop}\\s*:\\s*${need.value}\\b`));
      if (at >= 0 && !need.fallback.test(rule.body.slice(0, at + 1))) {
        problems.push(`${name}: "${rule.selector}" sets ${need.prop}: ${need.value} with no fallback before it`);
      }
    }
  }
  return problems;
}

test('CSS: values Safari 15.0 lacks come after a fallback it understands', () => {
  assert.deepEqual(cssFiles.flatMap((f) => cssFallbackProblems(relative(ROOT, f), readFileSync(f, 'utf8'))), []);
  const sample = '.a { overflow-wrap: anywhere; }\n.b { overflow-wrap: break-word; overflow-wrap: anywhere; }\n.c { overflow-wrap: anywhere; word-wrap: break-word; }';
  assert.deepEqual(cssFallbackProblems('x.css', sample).map((p) => p.split('"')[1]), ['.a', '.c'], 'the guard itself');
});

test('CSS: properties Safari supports only with -webkit- have the prefixed form too', () => {
  assert.deepEqual(cssFiles.flatMap((f) => cssPrefixProblems(relative(ROOT, f), readFileSync(f, 'utf8'))), []);
});

test('CSS: nothing that makes a target browser drop a whole rule or block', () => {
  assert.deepEqual(cssFiles.flatMap((f) => cssDropProblems(relative(ROOT, f), readFileSync(f, 'utf8'))), []);
});

test('the CSS guards find what they look for', () => {
  const prefix = '.a { user-select: none; }\n.b { -webkit-user-select: none; user-select: none; }\n.c { mask: url(x.svg); }';
  assert.equal(cssPrefixProblems('x.css', prefix).length, 2);
  const drop = [
    '@layer base { .a { color: red; } }',
    '.a:has(.b) { color: red; }',
    '@media (width >= 600px) { .a { color: red; } }',
    '.a { color: red; .b { color: blue; } }',
    '.a { & .b { color: blue; } }',
  ];
  for (const css of drop) assert.ok(cssDropProblems('x.css', css).length > 0, css);
  assert.deepEqual(cssDropProblems('x.css', '@media (max-width: 560px) { .a > .b { color: red; } }'), []);
});

test(
  'CSP: Safari before 15.5 can start the worker (it ignores worker-src and checks child-src, then default-src)',
  () => {
    const headers = readFileSync(join(SITE, '_headers'), 'utf8');
    const csp = /Content-Security-Policy:\s*(.+)/.exec(headers)?.[1] ?? '';
    /** @type {Map<string, string[]>} */
    const directives = new Map(
      csp.split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([k, ...v]) => [k, v]),
    );
    assert.deepEqual(directives.get('default-src'), ["'none'"]);
    // WebKit before worker-src (safari-612-branch, ContentSecurityPolicyDirectiveList.cpp):
    // violatedDirectiveForChildContext checks operativeDirective(m_childSrc), which falls back to default-src.
    assert.deepEqual(directives.get('child-src'), ["'self'"], 'child-src lets the module worker start in Safari 15.0-15.4');
    // In browsers that know frame-src, a missing frame-src falls back to child-src: keep frames refused.
    assert.deepEqual(directives.get('frame-src'), ["'none'"], 'frame-src stays closed');
    assert.deepEqual(directives.get('worker-src'), ["'self'"]);
  },
);
