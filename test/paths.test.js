// Tests for src/export/paths.js: the repaired folder tree and the ZIP path plan. Synthetic data only.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_FOLDER_DEPTH,
  MAX_NAME_BYTES,
  PATH_MESSAGES,
  UNTITLED,
  buildFolderTree,
  fitName,
  isWindowsReserved,
  planExportPaths,
  safeStem,
  truncateUtf8,
  utf8Length,
} from '../src/export/paths.js';

// Special characters are built from code points so the source stays plain ASCII and unambiguous.
const ch = (/** @type {number[]} */ ...cps) => String.fromCharCode(...cps);
const cp = (/** @type {number[]} */ ...cps) => String.fromCodePoint(...cps);
const FAMILY = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467); // one grapheme, five code points
const CJK = cp(0x5c71, 0x9053); // two CJK characters, 3 bytes each
const E_ACUTE_NFC = ch(0xe9);
const E_ACUTE_NFD = 'e' + ch(0x301);

/** @typedef {import('../src/model.js').Library} Library */
/** @typedef {import('../src/model.js').Folder} Folder */
/** @typedef {import('../src/model.js').Item} Item */

/** @param {string} id @returns {Item} */
function wpt(id, name = id) {
  return { kind: 'waypoint', id, name, comment: '', symbol: '', lat: 1, lon: 1, ele: null, time: null };
}

/** @param {string} id @param {string} name @param {string|null} parentId @param {string[]} [itemIds] @returns {Folder} */
function folder(id, name, parentId = null, itemIds = []) {
  return { id, name, type: 'folder', parentId, itemIds };
}

/** @param {string} id @param {string} name @param {string|null} parentId @param {string[]} [itemIds] @returns {Folder} */
function list(id, name, parentId = null, itemIds = []) {
  return { id, name, type: 'list', parentId, itemIds };
}

/** @param {Item[]} items @param {Folder[]} folders @returns {Library} */
function library(items, folders) {
  return { items, folders, problems: [], meta: { source: 'synthetic', version: null } };
}

/** @param {{ code: string, count: number }[]} problems */
function counts(problems) {
  return Object.fromEntries(problems.map((p) => [p.code, p.count]));
}

/** @param {import('../src/export/paths.js').PathPlan} plan */
function paths(plan) {
  return plan.files.map((f) => f.path);
}

const ILLEGAL_IN_NAME = /[/\\:*?"<>|\x00-\x1F\x7F]/;

/**
 * Invariants every plan must satisfy, whatever the input: safe components within the byte cap,
 * no Windows device names, no trailing dot or space, names unique per directory ignoring case
 * and normalization, and every file inside a planned directory.
 * @param {import('../src/export/paths.js').PathPlan} plan
 */
function assertSafePlan(plan) {
  const dirs = new Set(plan.directories);
  /** @type {Map<string, Set<string>>} */
  const seen = new Map();
  const entries = [...plan.directories.map((d) => d.slice(0, -1)), ...paths(plan)];
  for (const path of entries) {
    const parts = path.split('/');
    for (const part of parts) {
      assert.ok(part.length > 0, `empty component in ${JSON.stringify(path)}`);
      assert.ok(utf8Length(part) <= MAX_NAME_BYTES, `component over ${MAX_NAME_BYTES} bytes: ${part}`);
      assert.doesNotMatch(part, ILLEGAL_IN_NAME);
      assert.doesNotMatch(part, /[. ]$/);
      assert.doesNotMatch(part, /^[. ]/);
      assert.equal(isWindowsReserved(part), false, `reserved: ${part}`);
      assert.equal(part, part.normalize('NFC'));
      assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(part)), part);
    }
    const parent = parts.slice(0, -1).join('/');
    if (parent !== '') assert.ok(dirs.has(parent + '/'), `no directory for ${path}`);
    const key = parts[parts.length - 1].normalize('NFC').toUpperCase().toLowerCase();
    if (!seen.has(parent)) seen.set(parent, new Set());
    const names = /** @type {Set<string>} */ (seen.get(parent));
    assert.ok(!names.has(key), `duplicate name in "${parent}": ${path}`);
    names.add(key);
  }
}

describe('safe names', () => {
  test('characters forbidden on Windows become "_" and controls disappear', () => {
    assert.equal(safeStem('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
    assert.equal(safeStem(`tab${ch(9)}new${ch(10)}line${ch(13)}x`), 'tab new line x');
    assert.equal(safeStem(`bell${ch(7)}null${ch(0)}del${ch(0x7f)}c1${ch(0x9b)}`), 'bellnulldelc1');
    assert.equal(safeStem(`evil${ch(0x202e)}xpg.exe`), 'evilxpg.exe', 'bidi override removed');
    assert.equal(safeStem(`a${ch(0xd800)}b`), 'a_b', 'lone surrogate cannot be encoded');
  });

  test('leading and trailing dots and spaces are trimmed; empty names become Untitled', () => {
    assert.equal(safeStem('  Trip. . '), 'Trip');
    assert.equal(safeStem('.hidden'), 'hidden');
    assert.equal(safeStem('...'), UNTITLED);
    assert.equal(safeStem(''), UNTITLED);
    assert.equal(safeStem('   '), UNTITLED);
    assert.equal(safeStem(null), UNTITLED);
    assert.equal(safeStem(ch(1, 2, 3)), UNTITLED);
    assert.equal(safeStem('a.b'), 'a.b', 'inner dots stay');
  });

  test('names are NFC-normalised, also after a control character between letter and accent is removed', () => {
    assert.equal(safeStem(`Caf${E_ACUTE_NFD}`), `Caf${E_ACUTE_NFC}`);
    assert.equal(safeStem(`Cafe${ch(7)}${ch(0x301)}`), `Caf${E_ACUTE_NFC}`);
  });

  test('Windows device names are recognised case-insensitively, with or without extension', () => {
    for (const name of ['CON', 'con', 'Prn', 'AUX', 'nul', 'COM1', 'com9', 'COM0', 'LPT1', 'lpt9', `COM${ch(0xb9)}`,
      'CONIN$', 'con.gpx', 'NUL.tar.gz', 'aux .gpx']) {
      assert.equal(isWindowsReserved(name), true, name);
    }
    for (const name of ['CONSOLE', 'COM10', 'LPT', 'CON (2).gpx', 'xcon', 'nul_.gpx', '.con']) {
      assert.equal(isWindowsReserved(name), false, name);
    }
  });

  test('fitName defuses reserved names, also when truncation exposes one', () => {
    assert.equal(fitName('CON', '', '.gpx'), 'CON_.gpx');
    assert.equal(fitName('con', '', ''), 'con_');
    assert.equal(fitName('nul.backup', '', '.gpx'), 'nul_.backup.gpx');
    assert.equal(fitName('CON', ' (2)', '.gpx'), 'CON (2).gpx');
    // 115 bytes are left for the stem; the cut falls inside the spaces, which are then trimmed.
    const exposed = 'nul' + ' '.repeat(112) + 'x'.repeat(10);
    assert.equal(fitName(exposed, '', '.gpx'), 'nul_.gpx');
  });

  test('UTF-8 length matches TextEncoder, lone surrogates count as U+FFFD', () => {
    for (const s of ['', 'abc', E_ACUTE_NFC, CJK, FAMILY, `x${ch(0xd800)}y`, `${ch(0xdc00)}`, cp(0x10ffff)]) {
      assert.equal(utf8Length(s), new TextEncoder().encode(s).length, JSON.stringify(s));
    }
  });

  test('long names are cut at the byte cap without splitting a code point or an emoji sequence', () => {
    const emoji = FAMILY.repeat(40); // 18 bytes each
    const cjk = CJK.repeat(60); // 6 bytes per pair
    const mixed = ('a' + E_ACUTE_NFC + CJK + cp(0x1f600)).repeat(20);
    for (const stem of [emoji, cjk, mixed, 'x'.repeat(500)]) {
      for (const [suffix, ext] of [['', '.gpx'], [' (12)', '.gpx'], ['', '']]) {
        const name = fitName(stem, suffix, ext);
        const bytes = new TextEncoder().encode(name);
        assert.ok(bytes.length <= MAX_NAME_BYTES, `${bytes.length} bytes`);
        assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(bytes), name);
        assert.ok(name.endsWith(suffix + ext));
        assert.ok(stem.startsWith(name.slice(0, name.length - suffix.length - ext.length)));
      }
    }
    if (typeof Intl.Segmenter === 'function') {
      const cut = truncateUtf8(FAMILY.repeat(10), 40);
      assert.equal(cut, FAMILY.repeat(2), 'whole family emoji only');
    }
    assert.equal(truncateUtf8(CJK, 5), CJK.slice(0, 1));
    assert.equal(truncateUtf8('abc', 0), '');
  });
});

describe('folder tree', () => {
  test('nests folders and lists and resolves items in list order', () => {
    const lib = library([wpt('a'), wpt('b'), wpt('c')], [
      folder('f1', 'Hiking'),
      folder('f2', 'Alps', 'f1'),
      list('l1', 'Day 1', 'f2', ['b', 'a']),
    ]);
    const tree = buildFolderTree(lib);
    assert.deepEqual(tree.nodes.map((n) => [n.name, n.depth, n.parent?.name ?? null]), [
      ['Hiking', 1, ''],
      ['Alps', 2, 'Hiking'],
      ['Day 1', 3, 'Alps'],
    ]);
    assert.deepEqual(tree.nodes[2].items.map((i) => i.id), ['b', 'a']);
    assert.deepEqual(tree.unfiled.map((i) => i.id), ['c']);
    assert.deepEqual(tree.problems, []);
  });

  test('a missing parent puts the entry at the top level and is counted', () => {
    const tree = buildFolderTree(library([], [list('l1', 'Orphan', 'gone'), list('l2', 'Weird', /** @type {any} */ (42))]));
    assert.deepEqual(tree.root.children.map((n) => n.name), ['Orphan', 'Weird']);
    assert.deepEqual(counts(tree.problems), { folder_parent_missing: 2 });
  });

  test('cycles are broken deterministically and every entry is still placed', () => {
    const two = buildFolderTree(library([], [folder('a', 'A', 'b'), folder('b', 'B', 'a')]));
    assert.deepEqual(two.nodes.map((n) => `${n.parent?.name || '/'}>${n.name}`), ['/>B', 'B>A']);
    assert.deepEqual(counts(two.problems), { folder_cycle: 1 });

    const self = buildFolderTree(library([], [folder('a', 'A', 'a')]));
    assert.deepEqual(self.nodes.map((n) => n.depth), [1]);
    assert.deepEqual(counts(self.problems), { folder_cycle: 1 });

    // A tail hanging off a loop: d -> c -> b -> a -> c.
    const tail = buildFolderTree(library([], [
      folder('d', 'D', 'c'), folder('c', 'C', 'b'), folder('b', 'B', 'a'), folder('a', 'A', 'c'),
    ]));
    // The walk from D meets C again after A, so the link A -> C is cut and A becomes top level.
    assert.deepEqual(tail.nodes.map((n) => `${n.parent?.name || '/'}>${n.name}`), ['/>A', 'A>B', 'B>C', 'C>D']);
    assert.deepEqual(counts(tail.problems), { folder_cycle: 1 });
  });

  test('a 10 000-entry loop finishes quickly and is broken once', () => {
    const n = 10_000;
    const folders = Array.from({ length: n }, (_, i) => folder(`f${i}`, `F${i}`, `f${(i + 1) % n}`));
    const started = performance.now();
    const tree = buildFolderTree(library([], folders));
    const ms = performance.now() - started;
    assert.equal(tree.nodes.length, n);
    assert.equal(counts(tree.problems).folder_cycle, 1);
    assert.ok(ms < 1000, `${ms} ms`);
  });

  test('entries inside a list are moved beside the list', () => {
    const tree = buildFolderTree(library([], [
      folder('f', 'Top'),
      list('l1', 'List', 'f'),
      list('l2', 'Nested list', 'l1'),
      folder('f2', 'Folder in list', 'l2'),
    ]));
    assert.deepEqual(tree.nodes.map((n) => `${n.parent?.name}>${n.name}`), ['>Top', 'Top>List', 'Top>Nested list', 'Top>Folder in list']);
    assert.deepEqual(counts(tree.problems), { list_inside_list: 2 });
  });

  test(`folders deeper than ${MAX_FOLDER_DEPTH} levels are moved up to that level; lists stay in their folder`, () => {
    const n = 10_000;
    const folders = Array.from({ length: n }, (_, i) => folder(`f${i}`, `F${i}`, i === 0 ? null : `f${i - 1}`));
    folders.push(list('deep', 'Deepest list', `f${n - 1}`, ['x']));
    const started = performance.now();
    const tree = buildFolderTree(library([wpt('x')], folders));
    const ms = performance.now() - started;
    assert.ok(tree.nodes.every((node) => node.depth <= MAX_FOLDER_DEPTH + (node.isList ? 1 : 0)));
    assert.equal(tree.nodes.length, n + 1);
    assert.equal(counts(tree.problems).folder_depth_flattened, n - MAX_FOLDER_DEPTH);
    const deepest = tree.nodes.find((node) => node.name === 'Deepest list');
    assert.equal(deepest?.depth, MAX_FOLDER_DEPTH + 1);
    assert.equal(deepest?.parent?.name, `F${n - 1}`, 'the list is still inside its own folder');
    assert.deepEqual(deepest?.items.map((i) => i.id), ['x']);
    assert.ok(ms < 1000, `${ms} ms`);
  });

  test('missing, repeated and duplicate items are counted; malformed entries skipped', () => {
    const lib = library(
      /** @type {any[]} */ ([wpt('a'), wpt('a', 'second a'), { kind: 'waypoint' }, null]),
      /** @type {any[]} */ ([list('l', 'L', null, ['a', 'a', 'zzz', /** @type {any} */ (5)]), null, 'junk']),
    );
    const tree = buildFolderTree(lib);
    assert.deepEqual(counts(tree.problems), {
      folder_malformed: 2,
      item_unidentified: 2,
      item_duplicate_id: 1,
      item_missing: 2,
      item_repeated_in_list: 1,
    });
    assert.deepEqual(tree.nodes[0].items.map((i) => i.name), ['a']);
    assert.equal(tree.unfiled.length, 3, 'the second "a" and the two malformed items');
  });

  test('duplicate folder ids keep every entry; children go under the first', () => {
    const tree = buildFolderTree(library([], [folder('f', 'One'), folder('f', 'Two'), list('l', 'L', 'f')]));
    assert.deepEqual(tree.nodes.map((n) => `${n.parent?.name}>${n.name}`), ['>One', '>Two', 'One>L']);
    assert.deepEqual(counts(tree.problems), { folder_duplicate_id: 1 });
  });

  test('an empty or missing library gives an empty tree', () => {
    assert.deepEqual(buildFolderTree(library([], [])).nodes, []);
    assert.deepEqual(buildFolderTree(/** @type {any} */ ({})).nodes, []);
    assert.throws(() => buildFolderTree(library([], []), { maxDepth: 0 }), RangeError);
  });

  test('problem messages are plain words without numbers that could be data', () => {
    for (const [code, message] of Object.entries(PATH_MESSAGES)) {
      assert.ok(message.length > 20, code);
      assert.doesNotMatch(message.replace(/\b(32|200)\b/g, ''), /\d/, code);
    }
  });
});

describe('ZIP path plan', () => {
  test('one directory per folder, one GPX per list, Unfiled and All items at the top', () => {
    const lib = library([wpt('a'), wpt('b'), wpt('c'), wpt('d')], [
      folder('f1', 'Hiking'),
      folder('f2', 'Alps', 'f1'),
      list('l1', 'Day 1', 'f2', ['a', 'b']),
      list('l2', 'Favourites', null, ['b']),
      folder('f3', 'Empty folder'),
    ]);
    const plan = planExportPaths(lib);
    assert.deepEqual(plan.directories, ['Hiking/', 'Empty folder/', 'Hiking/Alps/']);
    assert.deepEqual(paths(plan), ['Favourites.gpx', 'Hiking/Alps/Day 1.gpx', 'Unfiled.gpx', 'All items.gpx']);
    const byPath = Object.fromEntries(plan.files.map((f) => [f.path, f]));
    assert.deepEqual(byPath['Hiking/Alps/Day 1.gpx'].items.map((i) => i.id), ['a', 'b']);
    assert.equal(byPath['Hiking/Alps/Day 1.gpx'].role, 'list');
    assert.equal(byPath['Hiking/Alps/Day 1.gpx'].folderId, 'l1');
    assert.equal(byPath['Hiking/Alps/Day 1.gpx'].title, 'Day 1');
    assert.deepEqual(byPath['Unfiled.gpx'].items.map((i) => i.id), ['c', 'd']);
    assert.deepEqual(byPath['All items.gpx'].items.map((i) => i.id), ['a', 'b', 'c', 'd']);
    assert.deepEqual(plan.problems, []);
    assertSafePlan(plan);
  });

  test('an item in several lists is in each list file (BaseCamp semantics), and not in Unfiled', () => {
    const lib = library([wpt('a')], [list('l1', 'One', null, ['a']), list('l2', 'Two', null, ['a'])]);
    const plan = planExportPaths(lib);
    assert.deepEqual(paths(plan), ['One.gpx', 'Two.gpx', 'All items.gpx']);
    assert.equal(plan.files[0].items[0], plan.files[1].items[0]);
  });

  test('items listed directly in a folder get a file named after the folder, inside it', () => {
    const lib = library([wpt('a')], [folder('f', 'Trips', null, ['a']), list('l', 'Trips', 'f')]);
    const plan = planExportPaths(lib);
    assert.deepEqual(paths(plan), ['Trips/Trips.gpx', 'Trips/Trips (2).gpx', 'All items.gpx']);
    assert.equal(plan.files[0].role, 'folder');
    assertSafePlan(plan);
  });

  test('collisions are resolved case-insensitively and across normalization forms', () => {
    const lib = library([], [
      list('1', 'Trip'), list('2', 'trip'), list('3', 'TRIP'), list('4', 'Trip (2)'),
      list('5', `Caf${E_ACUTE_NFC}`), list('6', `Caf${E_ACUTE_NFD}`),
      list('7', 'a/b'), list('8', 'a_b'), list('9', 'Trip.'),
    ]);
    const plan = planExportPaths(lib);
    assert.deepEqual(paths(plan), [
      'Trip.gpx', 'trip (2).gpx', 'TRIP (3).gpx', 'Trip (2) (2).gpx',
      `Caf${E_ACUTE_NFC}.gpx`, `Caf${E_ACUTE_NFC} (2).gpx`,
      'a_b.gpx', 'a_b (2).gpx', 'Trip (4).gpx', 'All items.gpx',
    ]);
    assertSafePlan(plan);
  });

  test('folders and files share one namespace per directory', () => {
    const plan = planExportPaths(library([], [folder('f', 'Trip.gpx'), list('l', 'Trip')]));
    assert.deepEqual(plan.directories, ['Trip.gpx/']);
    assert.deepEqual(paths(plan), ['Trip (2).gpx', 'All items.gpx']);
    assertSafePlan(plan);
  });

  test('the fixed top-level names and caller-reserved names win over user names', () => {
    const lib = library([wpt('a')], [
      list('1', 'All items'), list('2', 'unfiled'), folder('3', 'All items.kml'), list('4', 'Report'),
    ]);
    const plan = planExportPaths(lib, { reserveRootNames: ['All items.kml', 'Report.gpx'] });
    assert.deepEqual(plan.directories, ['All items.kml (2)/']);
    assert.deepEqual(paths(plan), ['All items (2).gpx', 'unfiled (2).gpx', 'Report (2).gpx', 'Unfiled.gpx', 'All items.gpx']);
    assertSafePlan(plan);
  });

  test('Unfiled.gpx is only planned when something is unfiled', () => {
    const plan = planExportPaths(library([wpt('a')], [list('l', 'Unfiled', null, ['a'])]));
    assert.deepEqual(paths(plan), ['Unfiled.gpx', 'All items.gpx']);
    assert.equal(plan.files[0].role, 'list');
  });

  test('reserved device names, empty names and hostile characters give safe paths', () => {
    const lib = library([], [
      folder('f1', 'CON'), list('l1', 'aux', 'f1'), list('l2', 'nul.backup', 'f1'), list('l3', '', 'f1'),
      list('l4', '...', 'f1'), list('l5', `${ch(0)}${ch(0x1f)}`, 'f1'), list('l6', '../../etc/passwd', 'f1'),
      folder('f2', ' .. '), list('l7', 'COM1', 'f2'),
    ]);
    const plan = planExportPaths(lib);
    assert.deepEqual(plan.directories, ['CON_/', 'Untitled/']);
    assert.deepEqual(paths(plan), [
      'CON_/aux_.gpx', 'CON_/nul_.backup.gpx', 'CON_/Untitled.gpx', 'CON_/Untitled (2).gpx',
      'CON_/Untitled (3).gpx', 'CON_/_.._etc_passwd.gpx', 'Untitled/COM1_.gpx', 'All items.gpx',
    ]);
    const titles = plan.files.map((f) => f.title);
    assert.equal(titles[2], UNTITLED);
    assertSafePlan(plan);
  });

  test('long names with emoji and CJK stay within the byte cap and stay unique', () => {
    const base = (FAMILY + CJK + 'trail ').repeat(20);
    const lib = library([], [
      folder('f', base), list('l1', base + 'one', 'f'), list('l2', base + 'two', 'f'), list('l3', base + 'three', 'f'),
    ]);
    const plan = planExportPaths(lib);
    assertSafePlan(plan);
    const names = paths(plan).slice(0, 3).map((p) => p.split('/')[1]);
    assert.ok(names[1].endsWith(' (2).gpx') && names[2].endsWith(' (3).gpx'), names.join(' | '));
  });

  test('a deep tree keeps at most 32 directory levels and warns about long paths', () => {
    const folders = Array.from({ length: 500 }, (_, i) => folder(`f${i}`, `Level ${i}`, i === 0 ? null : `f${i - 1}`));
    folders.push(list('l', 'Bottom', 'f499'));
    const plan = planExportPaths(library([], folders));
    assertSafePlan(plan);
    const bottom = plan.files.find((f) => f.folderId === 'l');
    assert.equal(bottom?.path.split('/').length, MAX_FOLDER_DEPTH + 1);
    const c = counts(plan.problems);
    assert.equal(c.folder_depth_flattened, 500 - MAX_FOLDER_DEPTH);
    assert.ok(bottom?.path.endsWith('/Level 499/Bottom.gpx'));
    assert.ok(c.path_long > 0);
  });

  test('cycles and missing parents never loop and still give a safe plan', () => {
    const lib = library([wpt('a')], [
      folder('a', 'A', 'c'), folder('b', 'B', 'a'), folder('c', 'C', 'b'), list('l', 'L', 'c', ['a']),
      folder('x', 'X', 'x'), list('o', 'Orphan', 'nowhere'),
    ]);
    const plan = planExportPaths(lib);
    assertSafePlan(plan);
    assert.equal(plan.directories.length, 4);
    assert.deepEqual(counts(plan.problems), { folder_parent_missing: 1, folder_cycle: 2 });
  });

  test('10 000 items in 1 000 lists across 100 folders plan in well under a second', () => {
    const items = Array.from({ length: 10_000 }, (_, i) => wpt(`i${i}`));
    /** @type {Folder[]} */
    const folders = [];
    for (let f = 0; f < 100; f++) folders.push(folder(`f${f}`, `Folder ${f % 10}`, f < 10 ? null : `f${f % 10}`));
    for (let l = 0; l < 1000; l++) {
      // Every item is in one list, every third item also in a second list.
      const ids = [];
      for (let i = l * 10; i < l * 10 + 10; i++) ids.push(`i${i}`);
      for (let i = l * 10; i < l * 10 + 10; i += 3) ids.push(`i${(i + 5000) % 10_000}`);
      folders.push(list(`l${l}`, `List ${l % 7}`, `f${l % 100}`, ids));
    }
    const started = performance.now();
    const plan = planExportPaths(library(items, folders));
    const ms = performance.now() - started;
    assert.ok(ms < 1000, `${ms} ms`);
    assert.equal(plan.files.length, 1000 + 1);
    assertSafePlan(plan);
    assert.equal(plan.tree.unfiled.length, 0);
    assert.deepEqual(plan.problems, []);
  });

  test('10 000 identically named lists in one folder get unique names in linear time', () => {
    const folders = [folder('f', 'Same')];
    for (let i = 0; i < 10_000; i++) folders.push(list(`l${i}`, 'Track', 'f'));
    const started = performance.now();
    const plan = planExportPaths(library([], folders));
    const ms = performance.now() - started;
    assert.ok(ms < 1000, `${ms} ms`);
    assert.equal(new Set(paths(plan)).size, 10_001);
    assert.equal(plan.files[9_999].path, 'Same/Track (10000).gpx');
    assertSafePlan(plan);
  });
});

// ---------------------------------------------------------------------------------------------
// Adversarial cases (added by an independent tester). Synthetic data only.

// More seeds for a one-off deep run: BCR_FUZZ_SEEDS=5000 node --test test/paths.test.js
const FUZZ_SEEDS = Number(process.env.BCR_FUZZ_SEEDS) || 60;

/** Deterministic PRNG (mulberry32) so a failing fuzz case can be replayed from its seed. */
function mulberry32(/** @type {number} */ seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SHARP_S = ch(0xdf);
const CAPITAL_SHARP_S = ch(0x1e9e);

// Pieces that stress case folding, normalization, reserved names, forbidden characters and
// truncation. Joined at random into folder and list names.
const NAME_PIECES = [
  'Trip', 'trip', 'TRIP', ' ', '.', '..', ' . ', 'CON', 'nul', 'Com1', 'LPT9', 'conin$', 'aux.txt',
  '/', '\\', ':', '*', '?', '"', '<', '>', '|', ch(0), ch(9), ch(10), ch(13), ch(0x1f), ch(0x7f), ch(0x85),
  ch(0x9b), ch(0x202e), ch(0x2066), ch(0xd800), ch(0xdc00), ch(0xfeff), ch(0xa0), ch(0x3000), ch(0x2028),
  `Stra${SHARP_S}e`, `STRA${CAPITAL_SHARP_S}E`, 'strasse', `Caf${E_ACUTE_NFC}`, `Caf${E_ACUTE_NFD}`,
  ch(0x2126), ch(0x3a9), ch(0x212a), 'k', ch(0x130), 'i', ch(0x3c2), ch(0x3c3), ch(0x3a3), ch(0xfb00), 'ff',
  ch(0x1c4), ch(0x1c5), ch(0x1c6), FAMILY, CJK, cp(0x1f600), 'e' + ch(0x301).repeat(5), '(2)', ' (2)', '.gpx',
  'All items', 'Unfiled', 'x'.repeat(40), CJK.repeat(15),
  ch(0xfdd0), ch(0xfffe), ch(0xffff), cp(0x10ffff), cp(0x1fffe), ch(0x378), ch(0xe000),
];

/** @param {() => number} rand @param {number} n */
const pick = (rand, n) => Math.floor(rand() * n);

/** @param {() => number} rand */
function randomName(rand) {
  let name = '';
  const parts = pick(rand, 7);
  for (let i = 0; i < parts; i++) {
    const piece = NAME_PIECES[pick(rand, NAME_PIECES.length)];
    name += rand() < 0.05 ? piece.repeat(30) : piece;
  }
  return name;
}

/**
 * A hostile library: duplicate and missing ids, self-parents and loops, lists inside lists,
 * malformed entries, items mentioned many times.
 * @param {() => number} rand
 * @returns {Library}
 */
function randomLibrary(rand) {
  const itemCount = pick(rand, 30);
  /** @type {any[]} */
  const items = [];
  for (let i = 0; i < itemCount; i++) {
    const r = rand();
    if (r < 0.04) items.push(null);
    else if (r < 0.08) items.push({ kind: 'waypoint', name: 'no id', lat: 1, lon: 1 });
    else items.push(wpt(`i${pick(rand, itemCount + 3)}`, randomName(rand)));
  }
  const folderCount = pick(rand, 40);
  /** @type {any[]} */
  const folders = [];
  const idOf = () => (rand() < 0.05 ? pick(rand, 5) : `f${pick(rand, Math.ceil(folderCount * 1.2) + 1)}`);
  for (let i = 0; i < folderCount; i++) {
    if (rand() < 0.03) {
      folders.push(rand() < 0.5 ? null : 'junk');
      continue;
    }
    const r = rand();
    const parentId = r < 0.3 ? null : r < 0.95 ? idOf() : { bad: true };
    const itemIds = Array.from({ length: pick(rand, 6) }, () => (rand() < 0.1 ? `missing${pick(rand, 3)}` : `i${pick(rand, itemCount + 1)}`));
    folders.push({ id: rand() < 0.9 ? `f${i}` : idOf(), name: randomName(rand), type: rand() < 0.5 ? 'folder' : 'list', parentId, itemIds });
  }
  return library(items, folders);
}

/**
 * Structural invariants of a plan beyond assertSafePlan: one directory per folder node, one file
 * per list node, a folder file only for folders that mention items, Unfiled only when needed.
 * @param {import('../src/export/paths.js').PathPlan} plan
 * @param {string} label
 */
function assertPlanMatchesTree(plan, label) {
  const { tree } = plan;
  const folderNodes = tree.nodes.filter((n) => !n.isList);
  const listNodes = tree.nodes.filter((n) => n.isList);
  assert.equal(plan.directories.length, folderNodes.length, label);
  const byRole = (/** @type {string} */ role) => plan.files.filter((f) => f.role === role).length;
  assert.equal(byRole('list'), listNodes.length, label);
  assert.equal(byRole('folder'), folderNodes.filter((n) => n.items.length > 0).length, label);
  assert.equal(byRole('unfiled'), tree.unfiled.length > 0 ? 1 : 0, label);
  assert.equal(byRole('all'), 1, label);
  for (const node of tree.nodes) {
    assert.ok(node.depth <= MAX_FOLDER_DEPTH + (node.isList ? 1 : 0), label);
    assert.ok(node.parent && !node.parent.isList, `${label}: a list holds an entry`);
    assert.equal(node.depth, /** @type {any} */ (node.parent).depth + 1, label);
  }
}

const fsDir = mkdtempSync(join(tmpdir(), 'bcr-paths-test-'));
after(() => rmSync(fsDir, { recursive: true, force: true }));
let fsCounter = 0;

/** True when this machine's temp volume ignores case (default APFS and NTFS do). */
const caseInsensitiveVolume = (() => {
  const probe = mkdtempSync(join(fsDir, 'probe-'));
  closeSync(openSync(join(probe, 'Aa'), 'wx'));
  try {
    closeSync(openSync(join(probe, 'aA'), 'wx'));
    return false;
  } catch {
    return true;
  }
})();
const NEEDS_CASE_INSENSITIVE = caseInsensitiveVolume ? false : 'the temp volume is case-sensitive';

/**
 * Create every planned directory and file on the real file system; a name the volume considers
 * equal to an earlier one fails with EEXIST. This checks what the disk really does, not our model of it.
 * @param {import('../src/export/paths.js').PathPlan} plan
 */
function materialize(plan) {
  const root = join(fsDir, `plan-${++fsCounter}`);
  mkdirSync(root);
  for (const d of plan.directories) mkdirSync(join(root, d));
  for (const f of plan.files) closeSync(openSync(join(root, f.path), 'wx'));
}

describe('adversarial: names and plans', () => {
  test('a name with a long run of inner spaces or dots is cleaned in linear time', () => {
    for (const filler of [' ', '.', ' .', ch(0x3000)]) {
      const name = 'x' + filler.repeat(100_000) + 'y';
      const started = performance.now();
      const stem = safeStem(name);
      const ms = performance.now() - started;
      assert.ok(ms < 200, `${ms} ms for a run of ${JSON.stringify(filler)}`);
      assert.equal(stem, name.normalize('NFC'));
    }
    const started = performance.now();
    assert.equal(isWindowsReserved('a' + ' '.repeat(100_000) + 'b'), false);
    assert.ok(performance.now() - started < 200);
  });

  test('noncharacters and unassigned code points become "_" (APFS refuses names holding them)', () => {
    assert.equal(safeStem(`a${ch(0xfdd0)}b${ch(0xfffe)}c${cp(0x10ffff)}d${ch(0x378)}e${cp(0x1fffe)}f`), 'a_b_c_d_e_f');
    const kept = `${ch(0xe000)}${cp(0xe0001)}${ch(0x200d)}${ch(0xad)}${cp(0x1f600)}`; // private use, tags, joiners: accepted
    assert.equal(safeStem(`x${kept}y`), `x${kept}y`);
  });

  test('edge trimming still removes every kind of leading and trailing space and dot', () => {
    assert.equal(safeStem(`${ch(0xa0)}${ch(0xfeff)} .Trip.${ch(0x3000)} ${ch(0x2028)}`), 'Trip');
    assert.equal(safeStem(` ${ch(0x2000)}.`), UNTITLED);
  });

  test('names that only collide after truncation are still made unique in linear time', () => {
    // 1 000 pairs of 115-byte names that share their first 111 bytes: each second copy needs a
    // " (2)", and every " (2)" candidate truncates to the same 111-byte prefix.
    const folders = [folder('f', 'F')];
    const prefix = 'x'.repeat(111);
    for (let i = 0; i < 1000; i++) {
      const name = prefix + String(i).padStart(4, '0');
      folders.push(list(`a${i}`, name, 'f'), list(`b${i}`, name, 'f'));
    }
    const started = performance.now();
    const plan = planExportPaths(library([], folders));
    const ms = performance.now() - started;
    assert.ok(ms < 1000, `${ms} ms`);
    assert.equal(new Set(paths(plan).map((p) => p.toLowerCase())).size, 2001);
    assertSafePlan(plan);
  });

  test('suffix numbers keep counting across a digit boundary without reusing a name', () => {
    const folders = [];
    for (let i = 0; i < 12; i++) folders.push(list(`l${i}`, 'x'.repeat(200)));
    const plan = planExportPaths(library([], folders));
    assertSafePlan(plan);
    const names = paths(plan).slice(0, 12);
    assert.ok(names[8].endsWith(' (9).gpx') && names[9].endsWith(' (10).gpx') && names[11].endsWith(' (12).gpx'), names.join('\n'));
  });

  test('capital sharp s, sharp s and "ss" are one name on a case-insensitive Mac volume', () => {
    const plan = planExportPaths(library([], [
      list('1', `Stra${SHARP_S}e`), list('2', `STRA${CAPITAL_SHARP_S}E`), list('3', 'strasse'), list('4', `stra${CAPITAL_SHARP_S}e`),
    ]));
    assert.deepEqual(paths(plan), [
      `Stra${SHARP_S}e.gpx`, `STRA${CAPITAL_SHARP_S}E (2).gpx`, 'strasse (3).gpx', `stra${CAPITAL_SHARP_S}e (4).gpx`, 'All items.gpx',
    ]);
    assertSafePlan(plan);
  });

  test('planned names never collide on the real (case-insensitive) file system', { skip: NEEDS_CASE_INSENSITIVE }, () => {
    const tricky = [
      `Stra${SHARP_S}e`, `STRA${CAPITAL_SHARP_S}E`, 'strasse', `Caf${E_ACUTE_NFC}`, `Caf${E_ACUTE_NFD}`, `CAF${ch(0xc9)}`,
      ch(0x2126), ch(0x3a9), ch(0x3c9), ch(0x212a), 'k', 'K', ch(0x212b), ch(0xc5), ch(0xe5),
      ch(0x3c2), ch(0x3c3), ch(0x3a3), ch(0xfb00), 'ff', 'FF', ch(0x1c4), ch(0x1c5), ch(0x1c6),
      ch(0xac00), ch(0x1100, 0x1161), 'Trip', 'TRIP.', ' trip', 'Trip (2)',
    ];
    const folders = [folder('f', 'Box')];
    tricky.forEach((name, i) => {
      folders.push(list(`l${i}`, name, 'f'), folder(`d${i}`, name, 'f'));
    });
    materialize(planExportPaths(library([], folders)));
  });

  test('a shortened name is counted, never silent', () => {
    const plan = planExportPaths(library([], [
      folder('f', 'y'.repeat(300)), list('l', 'z'.repeat(300), 'f'), list('m', 'short', 'f'),
      list('g', 'e' + ch(0x301).repeat(200)), // one grapheme longer than the cap
    ]));
    assertSafePlan(plan);
    assert.equal(counts(plan.problems).name_shortened, 3);
    assert.equal(plan.files.find((f) => f.folderId === 'l')?.title, 'z'.repeat(300), 'the full name stays as the title');
    assert.deepEqual(counts(planExportPaths(library([], [list('l', 'Fine')])).problems), {});
    // 118 bytes fit as a directory name but not with ".gpx" added: counted once for the folder.
    const edge = planExportPaths(library([wpt('a')], [folder('f', 'w'.repeat(118), null, ['a']), list('l', 'v'.repeat(300), 'f')]));
    assert.equal(edge.directories[0], 'w'.repeat(118) + '/');
    assert.equal(counts(edge.problems).name_shortened, 2);
  });

  test('a caller-reserved root name also wins over the Unfiled and All items files', () => {
    const plan = planExportPaths(library([wpt('a')], []), { reserveRootNames: ['Unfiled.gpx', 'ALL ITEMS.GPX'] });
    assert.deepEqual(paths(plan), ['Unfiled (2).gpx', 'All items (2).gpx']);
  });

  test('fuzz: random hostile trees always give a safe plan that matches the tree', () => {
    for (let seed = 1; seed <= FUZZ_SEEDS; seed++) {
      const lib = randomLibrary(mulberry32(seed));
      const plan = planExportPaths(lib);
      const label = `seed ${seed}`;
      try {
        assertSafePlan(plan);
      } catch (error) {
        throw new Error(`${label}: ${/** @type {Error} */ (error).message}`);
      }
      assertPlanMatchesTree(plan, label);
      if (caseInsensitiveVolume) {
        try {
          materialize(plan);
        } catch (error) {
          throw new Error(`${label}: ${/** @type {Error} */ (error).message}`);
        }
      }
    }
  });
});
