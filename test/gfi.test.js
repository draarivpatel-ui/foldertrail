// Unit tests for src/format/gfi.js: FolderData.gfi records and the tree build (FORMAT.md §8). Hand-built, synthetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFolderData, buildTree, ROOT_FOLDER_ID, MAX_TREE_DEPTH, MAX_NAME_CHARS } from '../src/format/gfi.js';
import { Counts } from '../src/format/gdb.js';

class B {
  constructor() {
    /** @type {number[]} */
    this.a = [];
  }
  /** @param {...number} v */
  u8(...v) {
    for (const x of v) this.a.push(x & 0xff);
    return this;
  }
  /** @param {number} v */
  u32(v) {
    return this.u8(v, v >>> 8, v >>> 16, v >>> 24);
  }
  /** @param {string} s */
  cstr(s) {
    return this.u8(...new TextEncoder().encode(s), 0);
  }
  bytes() {
    return Uint8Array.from(this.a);
  }
}

const ROOT = ROOT_FOLDER_ID;

/**
 * @param {number} id
 * @param {string} name
 * @param {number} parent
 * @param {Array<[number, number]>} children  [type, id]: 0 list, 1 folder
 * @param {number[]} [tail]
 */
const F = (id, name, parent, children, tail = [1]) => {
  const b = new B().u32(id).cstr(name).u32(parent).u32(children.length);
  for (const [type, child] of children) b.u32(type).u32(child);
  return { type: 'F', body: b.u8(...tail).bytes() };
};
/**
 * @param {number} id
 * @param {string} name
 * @param {number} parent
 * @param {number} [createdBy]
 * @param {number[]} [tail]
 */
const I = (id, name, parent, createdBy = 0, tail) => {
  const b = new B().u32(id).cstr(name).u32(createdBy).u32(parent);
  if (tail) b.u8(...tail);
  else if (createdBy !== 0) b.u8(1).u32(1).u32(9);
  return { type: 'I', body: b.bytes() };
};
/** @param {"T"|"W"|"R"} type @param {number} list @param {string} name @param {number} [cls] */
const ref = (type, list, name, cls = 0) => {
  const b = new B().u32(list).cstr(name);
  if (type === 'W') b.u32(cls);
  else if (type === 'T') b.u32(0);
  else b.u8(0);
  return { type, body: b.bytes() };
};

/** @param {ReturnType<typeof buildTree>} tree */
const shape = (tree) => tree.nodes.map((n) => `${n.type}:${n.id}<${n.parentId}:${n.name}`);

test('records: folders, lists with and without the created-by tail, references and BirdsEye', () => {
  const counts = new Counts();
  const content = parseFolderData(
    [
      F(ROOT, 'My Collection', ROOT, [[1, 0], [0, 0]]),
      F(0, 'Hikes', ROOT, [[0, 1]]),
      I(0, 'Top list', ROOT, 0),
      I(1, 'Imported', 0, 1),
      I(2, 'Unlisted Data', ROOT, 8),
      ref('T', 1, 'Ridge'),
      ref('W', 0, 'Spring', 1),
      ref('R', 0, 'Loop'),
      { type: 'K', body: new B().u32(0).cstr('Map').bytes() },
      { type: 'J', body: new B().u32(0).cstr('Map').bytes() },
    ],
    counts,
  );
  assert.equal(content.folders.length, 2);
  assert.deepEqual(content.folders[0].children, [{ type: 1, id: 0 }, { type: 0, id: 0 }]);
  assert.deepEqual(content.lists.map((l) => [l.id, l.name, l.createdBy, l.parent]), [
    [0, 'Top list', 0, ROOT],
    [1, 'Imported', 1, 0],
    [2, 'Unlisted Data', 8, ROOT],
  ]);
  assert.deepEqual(content.references.map((r) => [r.kind, r.listId, r.name, r.cls]), [
    ['track', 1, 'Ridge', null],
    ['waypoint', 0, 'Spring', 1],
    ['route', 0, 'Loop', null],
  ]);
  assert.equal(content.birdsEye, 2);
  assert.equal(counts.get('not_converted_kind'), 2);
  assert.equal(counts.get('folder_tail_unexpected'), 0);
  assert.equal(counts.get('list_tail_unexpected'), 0);
});

test('records: unexpected tails, unknown child types, unreadable records and duplicate IDs are counted', () => {
  const counts = new Counts();
  const content = parseFolderData(
    [
      F(ROOT, 'My Collection', ROOT, [[7, 3], [0, 0]], []),
      F(0, 'A', ROOT, [], [1, 2]),
      F(0, 'A again', ROOT, []),
      { type: 'F', body: new B().u32(5).cstr('Cut').u32(ROOT).u32(1000).bytes() },
      I(0, 'L', ROOT, 0, [1]),
      I(1, 'M', ROOT, 1, [1, 1, 0, 0, 0, 2, 0, 0, 0]),
      I(1, 'M again', ROOT, 0),
      { type: 'I', body: new B().u32(9).cstr('x').bytes() },
      { type: 'W', body: new B().u32(0).cstr('no class').bytes() },
      { type: 'Q', body: Uint8Array.of(1) },
    ],
    counts,
  );
  assert.equal(content.folders.length, 2);
  assert.equal(content.lists.length, 2);
  assert.equal(counts.get('folder_tail_unexpected'), 2);
  assert.equal(counts.get('unknown_child_type'), 1);
  assert.equal(counts.get('folder_record_unreadable'), 1);
  assert.equal(counts.get('list_tail_unexpected'), 2);
  assert.equal(counts.get('duplicate_id'), 2);
  assert.equal(counts.get('list_record_unreadable'), 1);
  assert.equal(counts.get('reference_unreadable'), 1);
  assert.equal(counts.get('gfi_record_unexpected'), 1);
});

test('tree: a nested tree keeps parents before children; the root is its own parent on disk but has no parent here', () => {
  const counts = new Counts();
  const content = parseFolderData(
    [
      F(ROOT, 'My Collection', ROOT, [[1, 0], [0, 0]]),
      F(0, 'Region', ROOT, [[1, 1], [0, 1]]),
      F(1, 'Valley', 0, [[0, 2]]),
      I(0, 'Top', ROOT),
      I(1, 'In region', 0),
      I(2, 'Deep', 1),
    ],
    counts,
  );
  const tree = buildTree(content, counts);
  assert.deepEqual(shape(tree), [
    'folder:f4294967295<null:My Collection',
    'folder:f0<f4294967295:Region',
    'folder:f1<f0:Valley',
    'list:l2<f1:Deep',
    'list:l1<f0:In region',
    'list:l0<f4294967295:Top',
  ]);
  assert.deepEqual([...tree.listIds].sort((x, y) => x[0] - y[0]), [[0, 'l0'], [1, 'l1'], [2, 'l2']]);
  assert.equal(counts.map.size, 0);
});

test('tree: folder and list IDs are separate spaces', () => {
  const counts = new Counts();
  const tree = buildTree(parseFolderData([F(ROOT, 'Root', ROOT, [[1, 0], [0, 0]]), F(0, 'Folder zero', ROOT, []), I(0, 'List zero', ROOT)], counts), counts);
  assert.deepEqual(shape(tree), ['folder:f4294967295<null:Root', 'folder:f0<f4294967295:Folder zero', 'list:l0<f4294967295:List zero']);
});

test('tree: the root falls back to a self-parented folder, then to a display-only root holding what no folder claims', () => {
  let counts = new Counts();
  let tree = buildTree(parseFolderData([F(4, 'Mine', 4, [[0, 0]]), I(0, 'L', 4)], counts), counts);
  assert.deepEqual(shape(tree), ['folder:f4<null:Mine', 'list:l0<f4:L']);
  assert.equal(counts.get('root_missing'), 0);

  counts = new Counts();
  tree = buildTree(parseFolderData([F(1, 'Top', 9, [[0, 0]]), I(0, 'Inside', 1), I(1, 'Loose', 9)], counts), counts);
  assert.deepEqual(shape(tree), ['folder:f-root<null:My Collection', 'folder:f1<f-root:Top', 'list:l0<f1:Inside', 'list:l1<f-root:Loose']);
  assert.equal(counts.get('root_missing'), 1);
  assert.equal(counts.get('list_not_in_tree'), 0);
});

test('tree: a folder in two places stays in the first; dangling children and unreached lists are handled', () => {
  const counts = new Counts();
  const tree = buildTree(
    parseFolderData(
      [
        F(ROOT, 'Root', ROOT, [[1, 0], [1, 1], [0, 7]]),
        F(0, 'A', ROOT, [[1, 1]]),
        F(1, 'B', ROOT, [[0, 0]]),
        I(0, 'In B', 1),
        I(1, 'Nobody lists me', ROOT),
      ],
      counts,
    ),
    counts,
  );
  assert.deepEqual(shape(tree), [
    'folder:f4294967295<null:Root',
    'folder:f0<f4294967295:A',
    'folder:f1<f4294967295:B',
    'list:l0<f1:In B',
    'list:l1<f4294967295:Nobody lists me',
  ]);
  assert.equal(counts.get('folder_in_two_places'), 1);
  assert.equal(counts.get('dangling_child'), 1);
  assert.equal(counts.get('list_not_in_tree'), 1);
});

test('tree: a cycle the root cannot reach is left out; its lists go under the root', () => {
  const counts = new Counts();
  const tree = buildTree(
    parseFolderData([F(ROOT, 'Root', ROOT, []), F(0, 'A', 1, [[1, 1]]), F(1, 'B', 0, [[1, 0], [0, 0]]), I(0, 'Stuck', 1)], counts),
    counts,
  );
  assert.deepEqual(shape(tree), ['folder:f4294967295<null:Root', 'list:l0<f4294967295:Stuck']);
  assert.equal(counts.get('folder_not_in_tree'), 2);
  assert.equal(counts.get('list_not_in_tree'), 1);
});

test('tree: a list whose own parent field disagrees keeps the folder that lists it', () => {
  const counts = new Counts();
  const tree = buildTree(parseFolderData([F(ROOT, 'Root', ROOT, [[1, 0]]), F(0, 'A', ROOT, [[0, 0]]), I(0, 'L', ROOT)], counts), counts);
  assert.equal(tree.nodes.find((n) => n.id === 'l0')?.parentId, 'f0');
  assert.equal(counts.get('list_folder_disagreement'), 1);
});

test('tree: depth is capped at 64 and a long chain neither overflows the stack nor hangs', () => {
  const records = [F(ROOT, 'Root', ROOT, [[1, 0]])];
  const depth = 5000;
  for (let i = 0; i < depth; i++) records.push(F(i, `F${i}`, i === 0 ? ROOT : i - 1, i + 1 < depth ? [[1, i + 1]] : [[0, 0]]));
  records.push(I(0, 'At the bottom', depth - 1));
  const counts = new Counts();
  const started = performance.now();
  const tree = buildTree(parseFolderData(records, counts), counts);
  assert.ok(performance.now() - started < 20000, 'a generous bound: a loaded machine is slower');
  assert.equal(tree.nodes.filter((n) => n.type === 'folder').length, MAX_TREE_DEPTH + 1);
  assert.equal(counts.get('tree_too_deep'), 1);
  assert.equal(tree.nodes.find((n) => n.id === 'l0')?.parentId, `f${ROOT}`);
  assert.equal(counts.get('list_not_in_tree'), 1);
});

test('names: a folder or list name longer than MAX_NAME_CHARS is shortened and counted, so folder paths stay bounded', () => {
  // Found by test/fuzz-pipeline.test.js: 64 nested folders with 64 KB names (4 MB of input) put a 4 MB path in the
  // report and in each list's GPX for every list below them (40 lists: a 157 MB report, 1.2 GB peak memory).
  assert.equal(MAX_NAME_CHARS, 255);
  const records = [
    F(ROOT, 'Ä'.repeat(5000), ROOT, [[0, 0], [0, 1], [0, 2], [0, 3]]),
    I(0, '\u{1F3D4}'.repeat(200), ROOT), // 400 UTF-16 units: the cut must not split a surrogate pair
    I(1, 'Short', ROOT),
    I(2, 'x'.repeat(255), ROOT),
    I(3, 'y'.repeat(256), ROOT),
  ];
  const counts = new Counts();
  const content = parseFolderData(records, counts);
  assert.equal(content.folders[0].name, `${'Ä'.repeat(255)}…`);
  const [mountains, short, exact, over] = content.lists.map((l) => l.name);
  assert.ok(mountains.length <= 256 && mountains.endsWith('…'));
  assert.doesNotMatch(mountains, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  assert.equal(short, 'Short');
  assert.equal(exact, 'x'.repeat(255), 'exactly at the cap: kept whole');
  assert.equal(over, `${'y'.repeat(255)}…`);
  assert.equal(counts.get('name_shortened'), 3);
  const tree = buildTree(content, counts);
  assert.ok(tree.nodes.every((n) => n.name.length <= MAX_NAME_CHARS + 1));
});

test('records: Mac 4.8 tails (FORMAT.md §15.8, §15.11): F of 10 bytes, a smart list (created-by 3) of 5 bytes', () => {
  const counts = new Counts();
  const time = [0x7a, 0x0d, 0xe5, 0x68]; // a made-up Unix time
  const content = parseFolderData(
    [
      F(ROOT, 'My Collection', ROOT, [[0, 1], [0, 2], [1, 0], [0, 0]], [1, 0, 0, 0, 0, ...time, 0]),
      F(0, 'Trips', ROOT, [[0, 3]], [1, 0, 0, 0, 0, ...time, 0]),
      I(0, 'Unlisted Data', ROOT, 8),
      I(1, 'Last Week', ROOT, 3, [1, 0, 0, 0, 0]),
      I(2, 'Last Month', ROOT, 3, [1, 0, 0, 0, 0]),
      I(3, 'import list', 0, 0),
    ],
    counts,
  );
  assert.equal(counts.get('folder_tail_unexpected'), 0);
  assert.equal(counts.get('list_tail_unexpected'), 0);
  assert.deepEqual(content.lists.map((l) => [l.name, l.createdBy]), [['Unlisted Data', 8], ['Last Week', 3], ['Last Month', 3], ['import list', 0]]);

  // The 5-byte tail only for created-by 3, and only 1 then 0; 9 or 2 bytes after the children are not a folder tail.
  const odd = new Counts();
  parseFolderData(
    [
      F(ROOT, 'My Collection', ROOT, [], [1, 0, 0, 0, 0, ...time, 0, 0]),
      F(0, 'A', ROOT, [], [1, 0]),
      I(0, 'Not smart', ROOT, 8, [1, 0, 0, 0, 0]),
      I(1, 'Smart', ROOT, 3, [1, 1, 0, 0, 0]),
      I(2, 'Smart, OP tail', ROOT, 3),
    ],
    odd,
  );
  assert.equal(odd.get('folder_tail_unexpected'), 2);
  assert.equal(odd.get('list_tail_unexpected'), 2);
});
