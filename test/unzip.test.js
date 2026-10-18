// Tests for src/format/unzip.js.
// The reader is checked on archives made by an independent writer (the system `zip`, Info-ZIP 3.0 on
// macOS), on our own writer's output, and on hand-crafted hostile archives. All data is synthetic.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { crc32 } from '../src/export/crc32.js';
import { zipBytes, internals } from '../src/export/zip.js';
import { openZip, ZipReadError, DEFAULT_LIMITS } from '../src/format/unzip.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const HAS_ZIP = spawnSync('/usr/bin/which', ['zip']).status === 0;
const HAS_ICONV = spawnSync('/usr/bin/which', ['iconv']).status === 0;

/** @type {string} */
let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bcr-unzip-'));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBytes(length, seed) {
  const next = mulberry32(seed);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.floor(next() * 256);
  return out;
}

function syntheticGpx(points, seed) {
  const next = mulberry32(seed);
  let text = '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="synthetic"><trk><trkseg>\n';
  for (let i = 0; i < points; i++) {
    text += `  <trkpt lat="${(10 + next()).toFixed(6)}" lon="${(20 + next()).toFixed(6)}"><ele>${i % 50}</ele></trkpt>\n`;
  }
  return text + '</trkseg></trk></gpx>\n';
}

const concat = (...parts) => new Uint8Array(Buffer.concat(parts.flat()));
const viewOf = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const isReadError = (code) => (error) => {
  assert.ok(error instanceof ZipReadError, `expected ZipReadError, got ${error}`);
  if (code) assert.equal(error.code, code, error.message);
  return true;
};

/** Everything an archive holds, read through the public API. */
async function readAll(archive) {
  const out = new Map();
  for (const entry of archive.entries) out.set(entry.name, entry.isDirectory ? null : await entry.read());
  return out;
}

// ---------------------------------------------------------------------------------------------
// Hand-crafted archives (built with the writer's encoders, then patched)

/**
 * @typedef {object} Spec
 * @property {string|Uint8Array} name
 * @property {string|Uint8Array} [data]
 * @property {boolean} [deflate]
 * @property {boolean} [centralOnly]        no local header/data; pair with `offset`
 * @property {number} [offset]              local-header offset written in the central record
 * @property {(view: DataView) => void} [patchCentral]
 * @property {(view: DataView) => void} [patchLocal]
 * @property {Uint8Array} [centralExtra]    raw extra-field bytes appended to the central record
 */

/**
 * @param {Spec[]} specs
 * @param {{ patchEnd?: (view: DataView) => void, comment?: Uint8Array }} [options]
 */
function craft(specs, options = {}) {
  const parts = [];
  const centrals = [];
  let offset = 0;
  for (const spec of specs) {
    const raw = typeof spec.data === 'string' ? enc.encode(spec.data) : spec.data ?? new Uint8Array(0);
    const stored = spec.deflate ? new Uint8Array(zlib.deflateRawSync(raw)) : raw;
    const plan = {
      name: typeof spec.name === 'string' ? enc.encode(spec.name) : spec.name,
      directory: false,
      method: spec.deflate ? 8 : 0,
      crc: crc32(raw),
      compressedSize: stored.length,
      uncompressedSize: raw.length,
      offset: spec.offset ?? offset,
      dosTime: 0,
      dosDate: (1 << 5) | 1,
      unixTime: null,
      sizesZip64: false,
      offsetZip64: false,
    };
    if (!spec.centralOnly) {
      const local = internals.encodeLocalHeader(plan);
      spec.patchLocal?.(viewOf(local));
      parts.push(local, stored);
      offset += local.length + stored.length;
    }
    let central = internals.encodeCentralHeader(plan);
    if (spec.centralExtra) {
      central = concat(central, spec.centralExtra);
      viewOf(central).setUint16(30, viewOf(central).getUint16(30, true) + spec.centralExtra.length, true);
    }
    spec.patchCentral?.(viewOf(central));
    centrals.push(central);
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  let end = internals.encodeEnd(centrals.length, centralSize, offset, false);
  if (options.comment) {
    end = concat(end, options.comment);
    viewOf(end).setUint16(end.length - options.comment.length - 2, options.comment.length, true);
  }
  options.patchEnd?.(viewOf(end));
  return concat(parts, centrals, end);
}

const setFlags = (flags) => (view) => view.setUint16(8, flags, true); // central record

// ---------------------------------------------------------------------------------------------
// Round trip with our writer

test('round trip: what the writer stores, the reader returns (bytes, ArrayBuffer and Blob)', async () => {
  const input = [
    { path: 'Library/' },
    { path: 'Library/Tracks/Morning run.gpx', bytes: syntheticGpx(3000, 1), mtime: Date.UTC(2024, 5, 15, 12, 30, 45) },
    { path: 'Library/Tracks/Ünïcödé 日本 😀.gpx', bytes: syntheticGpx(10, 2) },
    { path: 'Library/Waypoints/empty.gpx', bytes: '' },
    { path: 'Library/Empty Folder/' },
    { path: 'random.bin', bytes: randomBytes(300_000, 3) },
  ];
  const bytes = await zipBytes(input);
  const inputs = [bytes, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), new Blob([bytes])];
  for (const source of inputs) {
    const archive = await openZip(source);
    assert.deepEqual(archive.problems, []);
    assert.equal(archive.zip64, false);
    assert.equal(archive.comment, '');
    assert.deepEqual(archive.entries.map((e) => e.name), input.map((e) => e.path));
    for (const [i, entry] of archive.entries.entries()) {
      const expected = typeof input[i].bytes === 'string' ? enc.encode(input[i].bytes) : input[i].bytes ?? new Uint8Array(0);
      assert.equal(entry.isDirectory, input[i].path.endsWith('/'));
      assert.equal(entry.uncompressedSize, expected.length);
      assert.equal(entry.issue, null);
      assert.equal(entry.unsafeName, false);
      assert.equal(entry.duplicate, false);
      assert.equal(entry.encrypted, false);
      assert.equal(entry.isSymlink, false);
      assert.deepEqual(await entry.read(), expected, entry.name);
    }
    assert.equal(archive.entries[1].method, 8);
    assert.equal(archive.entries[1].modified, Date.UTC(2024, 5, 15, 12, 30, 45), 'UT field wins over DOS fields');
    assert.equal(archive.entries[2].modified, Date.UTC(1980, 0, 1), 'DOS fields read as UTC');
    assert.equal(archive.entries[5].method, 0, 'random data was stored');
  }
});

test('read() can be called again and returns fresh copies', async () => {
  const archive = await openZip(await zipBytes([{ path: 'a.txt', bytes: 'same' }], { compression: 'store' }));
  const first = await archive.entries[0].read();
  first[0] = 0;
  assert.equal(dec.decode(await archive.entries[0].read()), 'same');
});

test('entries are frozen, so a caller cannot clear an issue', async () => {
  const archive = await openZip(craft([{ name: '../x.txt', data: 'x' }]));
  const entry = archive.entries[0];
  assert.throws(() => {
    /** @type {any} */ (entry).issue = null;
  }, TypeError);
  await assert.rejects(entry.read(), isReadError('unsafe_name'));
});

// ---------------------------------------------------------------------------------------------
// Archives made by the system `zip` (an independent writer)

/** Builds a synthetic folder tree and returns what a reader should find in an archive of it. */
function makeTree(root) {
  const files = {
    'Library/Tracks/Run 1.gpx': enc.encode(syntheticGpx(1500, 4)),
    'Library/Tracks/Ünïcödé 日本 😀.gpx': enc.encode(syntheticGpx(5, 5)),
    'Library/Waypoints/empty.gpx': new Uint8Array(0),
    'random.bin': randomBytes(32_768, 6),
  };
  const dirs = ['Library/', 'Library/Tracks/', 'Library/Waypoints/', 'Library/Empty Folder/'];
  for (const dir of dirs) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(root, name), bytes);
  return { files, dirs };
}

/** Flags of every central-directory record (a plain scan; fine for these small synthetic archives). */
function centralFlags(bytes) {
  const buf = Buffer.from(bytes);
  const flags = [];
  for (let at = buf.indexOf('PK\x01\x02', 0, 'latin1'); at >= 0; at = buf.indexOf('PK\x01\x02', at + 4, 'latin1')) {
    flags.push(buf.readUInt16LE(at + 8));
  }
  return flags;
}

const systemZipCases = [
  ['stored (-0)', ['-0']],
  ['deflated (-9)', ['-9']],
  ['forced ZIP64 (-fz)', ['-fz']],
  ['no extra fields (-X)', ['-X']],
  // Written to a pipe, zip cannot seek back, so it uses data descriptors (flag bit 3, zero local sizes).
  ['streamed to a pipe, with data descriptors', ['-']],
];

for (const [label, flags] of systemZipCases) {
  test(`reads a system zip archive: ${label}`, { skip: !HAS_ZIP && 'needs zip' }, async () => {
    const root = fs.mkdtempSync(path.join(tmp, 'tree-'));
    const { files, dirs } = makeTree(root);
    /** @type {Uint8Array} */
    let bytes;
    if (flags[0] === '-') {
      bytes = new Uint8Array(execFileSync('zip', ['-q', '-r', '-', '.'], { cwd: root, maxBuffer: 64 << 20 }));
      assert.ok(centralFlags(bytes).some((f) => f & 0x08), 'the archive really uses data descriptors');
    } else {
      const file = path.join(tmp, `${path.basename(root)}.zip`);
      execFileSync('zip', ['-q', '-r', ...flags, file, '.'], { cwd: root });
      bytes = new Uint8Array(fs.readFileSync(file));
    }

    const archive = await openZip(bytes);
    assert.deepEqual(archive.problems, []);
    assert.equal(archive.zip64, flags.includes('-fz'));
    const contents = await readAll(archive);
    assert.deepEqual(
      [...contents.keys()].sort(),
      [...Object.keys(files), ...dirs].sort(),
      'every file and folder, with UTF-8 names decoded (macOS zip does not set the UTF-8 flag)',
    );
    for (const [name, bytes] of Object.entries(files)) assert.deepEqual(contents.get(name), bytes, name);
    for (const dir of dirs) assert.equal(archive.entries.find((e) => e.name === dir)?.isDirectory, true);
    const methods = new Set(archive.entries.filter((e) => e.uncompressedSize > 0).map((e) => e.method));
    if (flags.includes('-0')) assert.deepEqual([...methods], [0]);
    else assert.ok(methods.has(8), 'some entries are deflated');
    if (!flags.includes('-X')) {
      const run1 = archive.entries.find((e) => e.name === 'Library/Tracks/Run 1.gpx');
      const stat = fs.statSync(path.join(root, 'Library/Tracks/Run 1.gpx'));
      assert.equal(run1.modified, Math.floor(stat.mtimeMs / 1000) * 1000, 'UT time from the system zip');
    }
  });
}

test('reads the comment and a symlink written by the system zip', { skip: !HAS_ZIP && 'needs zip' }, async () => {
  const root = fs.mkdtempSync(path.join(tmp, 'link-'));
  fs.writeFileSync(path.join(root, 'target.txt'), 'target text');
  fs.symlinkSync('target.txt', path.join(root, 'link.txt'));
  const file = path.join(tmp, 'link.zip');
  execFileSync('zip', ['-q', '-r', '-y', file, '.'], { cwd: root });
  execFileSync('zip', ['-q', '-z', file], { input: 'Synthetic test backup\n' });
  const archive = await openZip(fs.readFileSync(file));
  assert.equal(archive.comment, 'Synthetic test backup');
  const link = archive.entries.find((e) => e.name === 'link.txt');
  assert.equal(link.isSymlink, true);
  assert.equal(dec.decode(await link.read()), 'target.txt', 'a symlink entry holds its target, nothing is followed');
  assert.equal(archive.entries.find((e) => e.name === 'target.txt').isSymlink, false);
});

test('archives with data before or after them still open, and say so', { skip: !HAS_ZIP && 'needs zip' }, async () => {
  const root = fs.mkdtempSync(path.join(tmp, 'shift-'));
  const { files } = makeTree(root);
  for (const flags of [['-9'], ['-fz']]) {
    const file = path.join(tmp, `shift${flags[0]}.zip`);
    execFileSync('zip', ['-q', '-r', ...flags, file, '.'], { cwd: root });
    const original = fs.readFileSync(file);

    const prefixed = await openZip(concat(randomBytes(1000, 7), original));
    assert.deepEqual(prefixed.problems.map((p) => p.code), ['prefixed_data'], flags.join());
    assert.deepEqual((await readAll(prefixed)).get('random.bin'), files['random.bin']);

    const trailing = await openZip(concat(original, randomBytes(100, 8)));
    assert.deepEqual(trailing.problems.map((p) => p.code), ['trailing_data'], flags.join());
    assert.deepEqual((await readAll(trailing)).get('Library/Tracks/Run 1.gpx'), files['Library/Tracks/Run 1.gpx']);
  }
});

// ---------------------------------------------------------------------------------------------
// Files that are not (whole) archives

test('a 0-byte file, garbage and plain text are rejected with a clear code', async () => {
  await assert.rejects(openZip(new Uint8Array(0)), isReadError('empty_file'));
  await assert.rejects(openZip(randomBytes(10_000, 9)), isReadError('not_zip'));
  await assert.rejects(openZip(enc.encode('<gpx>not a zip</gpx>')), isReadError('not_zip'));
  await assert.rejects(openZip(new Uint8Array([0x50, 0x4b])), isReadError('not_zip'));
  const planted = randomBytes(5000, 10);
  planted.set([0x50, 0x4b, 0x05, 0x06], 4000); // an end-record signature in noise
  await assert.rejects(openZip(planted), isReadError('corrupt'));
  await assert.rejects(openZip(/** @type {any} */ ('archive.zip')), isReadError('bad_input'));
  await assert.rejects(openZip(/** @type {any} */ (null)), isReadError('bad_input'));
});

test('an empty archive opens with no entries', async () => {
  const archive = await openZip(await zipBytes([]));
  assert.deepEqual(archive.entries, []);
  assert.deepEqual(archive.problems, []);
});

test('truncated archives are reported as truncated, at every cut point', { skip: !HAS_ZIP && 'needs zip' }, async () => {
  const root = fs.mkdtempSync(path.join(tmp, 'cut-'));
  makeTree(root);
  const file = path.join(tmp, 'cut.zip');
  execFileSync('zip', ['-q', '-r', file, '.'], { cwd: root });
  const whole = new Uint8Array(fs.readFileSync(file));
  for (const keep of [4, 30, 100, Math.floor(whole.length / 2), whole.length - 30, whole.length - 1]) {
    await assert.rejects(openZip(whole.subarray(0, keep)), isReadError('truncated'), `kept ${keep} of ${whole.length}`);
  }
});

test('damaged entry data fails that entry only', async () => {
  const bytes = await zipBytes([
    { path: 'good.gpx', bytes: syntheticGpx(200, 11) },
    { path: 'bad.gpx', bytes: syntheticGpx(200, 12) },
    { path: 'stored.txt', bytes: 'stored text, will be damaged' },
  ]);
  const archive = await openZip(bytes);
  const [good, bad, stored] = archive.entries;
  const damaged = new Uint8Array(bytes);
  const badDataStart = (await locateData(bytes, 1)) + 10;
  damaged[badDataStart] ^= 0x55;
  damaged[(await locateData(bytes, 2)) + 3] ^= 0x01;
  const hurt = await openZip(damaged);
  assert.deepEqual(await hurt.entries[0].read(), await good.read());
  await assert.rejects(hurt.entries[1].read(), (e) => isReadError()(e) && ['crc_mismatch', 'corrupt_data', 'size_mismatch'].includes(e.code));
  await assert.rejects(hurt.entries[2].read(), isReadError('crc_mismatch'));
  assert.equal(bad.method, 8);
  assert.equal(stored.method, 0);
});

/** Where entry `index`'s data starts (via the local header), for damaging it on purpose. */
async function locateData(bytes, index) {
  const view = viewOf(bytes);
  let at = 0;
  for (let i = 0; ; i++) {
    assert.equal(view.getUint32(at, true), 0x04034b50);
    const dataStart = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
    if (i === index) return dataStart;
    at = dataStart + view.getUint32(at + 18, true);
  }
}

// ---------------------------------------------------------------------------------------------
// Hostile archives

test('path-traversal and absolute names are listed but never read', async () => {
  const unsafe = ['../evil.txt', '/etc/evil.txt', 'a/../../evil.txt', 'C:\\evil.txt', '..\\evil.txt', '', 'nul\u0000.txt'];
  const archive = await openZip(craft([...unsafe.map((name) => ({ name, data: 'evil' })), { name: 'fine/ok.txt', data: 'ok' }]));
  assert.deepEqual(archive.entries.map((e) => e.name), [...unsafe, 'fine/ok.txt']);
  for (const entry of archive.entries.slice(0, unsafe.length)) {
    assert.equal(entry.unsafeName, true, JSON.stringify(entry.name));
    assert.equal(entry.issue, 'unsafe_name');
    await assert.rejects(entry.read(), isReadError('unsafe_name'));
  }
  assert.equal(dec.decode(await archive.entries.at(-1).read()), 'ok');
  assert.deepEqual(archive.problems, [{ code: 'unsafe_name', message: archive.problems[0].message, count: unsafe.length }]);
  assert.match(archive.problems[0].message, /not read/);
});

test('duplicate names are flagged, counted and each still readable', async () => {
  const archive = await openZip(craft([
    { name: 'same.gpx', data: 'first' },
    { name: 'other.gpx', data: 'other' },
    { name: 'same.gpx', data: 'second' },
    { name: 'same.gpx', data: 'third' },
  ]));
  assert.deepEqual(archive.entries.map((e) => e.duplicate), [false, false, true, true]);
  assert.deepEqual(await Promise.all(archive.entries.map(async (e) => dec.decode(await e.read()))), ['first', 'other', 'second', 'third']);
  assert.deepEqual(archive.problems.map((p) => [p.code, p.count]), [['duplicate_name', 2]]);
});

test('encrypted entries and unknown methods are reported as unsupported', async () => {
  const archive = await openZip(craft([
    { name: 'locked.txt', data: 'secret', patchCentral: setFlags(0x0801) },
    { name: 'strong.txt', data: 'secret', patchCentral: setFlags(0x0841) },
    { name: 'aes.txt', data: 'secret', patchCentral: (v) => v.setUint16(10, 99, true) },
    { name: 'bzip2.txt', data: 'data', patchCentral: (v) => v.setUint16(10, 12, true) },
    { name: 'plain.txt', data: 'plain' },
  ]));
  assert.deepEqual(archive.entries.map((e) => e.issue), ['encrypted', 'encrypted', 'encrypted', 'unsupported_method', null]);
  assert.deepEqual(archive.entries.map((e) => e.encrypted), [true, true, true, false, false]);
  await assert.rejects(archive.entries[0].read(), isReadError('encrypted'));
  await assert.rejects(archive.entries[3].read(), isReadError('unsupported_method'));
  assert.equal(dec.decode(await archive.entries[4].read()), 'plain');
  assert.deepEqual(archive.problems.map((p) => [p.code, p.count]), [['encrypted', 3], ['unsupported_method', 1]]);
});

test('lying sizes and checksums are caught without trusting them', async () => {
  const text = syntheticGpx(300, 13);
  const archive = await openZip(craft([
    // declares fewer bytes than the deflate stream produces: inflation stops at the declared size
    { name: 'bomb.gpx', data: text, deflate: true, patchCentral: (v) => v.setUint32(24, 100, true) },
    { name: 'short.gpx', data: text, deflate: true, patchCentral: (v) => v.setUint32(24, text.length + 1, true) },
    { name: 'crc.gpx', data: text, deflate: true, patchCentral: (v) => v.setUint32(16, 0x12345678, true) },
    // 1 GiB from 20 bytes is impossible for deflate (max 1032:1): refused before allocating anything
    { name: 'ratio.bin', data: new Uint8Array(20_000), deflate: true, patchCentral: (v) => v.setUint32(24, 2 ** 30, true) },
    { name: 'stored-sizes.txt', data: 'abc', patchCentral: (v) => v.setUint32(24, 4, true) },
  ]));
  const [bomb, short, crc, ratio, stored] = archive.entries;
  await assert.rejects(bomb.read(), isReadError('size_mismatch'));
  await assert.rejects(short.read(), isReadError('size_mismatch'));
  await assert.rejects(crc.read(), isReadError('crc_mismatch'));
  assert.equal(ratio.issue, 'bad_size');
  assert.equal(stored.issue, 'bad_size');
  await assert.rejects(ratio.read(), isReadError('bad_size'));
});

test('offsets outside the archive and overlapping entries are refused', async () => {
  // Local headers: a.txt at 0, b.txt at 39, c.txt at 78 (30-byte header + 5-byte name + 4 bytes of data each).
  const archive = await openZip(craft([
    { name: 'a.txt', data: 'aaaa' },
    { name: 'b.txt', data: 'bbbb' },
    { name: 'c.txt', data: 'cccc' },
    { name: 'twin-of-a.txt', centralOnly: true, offset: 0, data: 'aaaa' }, // shares a.txt's local header
    { name: 'inside-b.txt', centralOnly: true, offset: 40, data: 'xxxxxxxxxxxx' }, // starts inside b.txt, runs into c.txt
    { name: 'far.txt', centralOnly: true, offset: 1_000_000, data: 'far' },
  ]));
  assert.deepEqual(archive.entries.map((e) => e.issue), [
    'overlapping', // a.txt: another entry claims the same header
    'overlapping', // b.txt: another entry starts inside its data (the "quoted overlap" bomb shape)
    null, // c.txt is not involved
    'overlapping',
    'overlapping',
    'bad_offset',
  ]);
  assert.equal(dec.decode(await archive.entries[2].read()), 'cccc');
  for (const i of [0, 1, 3, 4]) await assert.rejects(archive.entries[i].read(), isReadError('overlapping'));
  await assert.rejects(archive.entries[5].read(), isReadError('bad_offset'));
  assert.deepEqual(archive.problems.map((p) => [p.code, p.count]), [['overlapping', 4], ['bad_offset', 1]]);
});

test('a damaged local header or one whose extra field runs into the next entry is refused at read time', async () => {
  const archive = await openZip(craft([
    { name: 'sig.txt', data: 'one', patchLocal: (v) => v.setUint32(0, 0x12345678, true) },
    { name: 'extra.txt', data: 'two', patchLocal: (v) => v.setUint16(28, 500, true) },
    { name: 'fine.txt', data: 'three' },
  ]));
  assert.deepEqual(archive.entries.map((e) => e.issue), [null, null, null]);
  await assert.rejects(archive.entries[0].read(), isReadError('bad_local_header'));
  await assert.rejects(archive.entries[1].read(), isReadError('bad_offset'));
  assert.equal(dec.decode(await archive.entries[2].read()), 'three');
});

test('ZIP64 markers without a ZIP64 field make the entry unreadable, not the archive', async () => {
  const archive = await openZip(craft([
    { name: 'marker.txt', data: 'data', patchCentral: (v) => v.setUint32(20, 0xffffffff, true) },
    {
      name: 'short-field.txt',
      data: 'data',
      patchCentral: (v) => v.setUint32(24, 0xffffffff, true),
      centralExtra: new Uint8Array([0x01, 0x00, 0x04, 0x00, 1, 2, 3, 4]), // 4 bytes where 8 are needed
    },
    { name: 'ok.txt', data: 'ok' },
  ]));
  assert.deepEqual(archive.entries.map((e) => e.issue), ['bad_zip64_extra', 'bad_zip64_extra', null]);
  assert.deepEqual(archive.entries.map((e) => e.compressedSize), [-1, 4, 2]);
});

test('end records that lie are rejected or worked around', async () => {
  const entries = [{ name: 'a.txt', data: 'a' }];
  await assert.rejects(openZip(craft(entries, { patchEnd: (v) => v.setUint16(4, 1, true) })), isReadError('multi_disk'));
  await assert.rejects(openZip(craft(entries, { patchEnd: (v) => v.setUint32(16, 999_999, true) })), isReadError('corrupt'));
  await assert.rejects(openZip(craft(entries, { patchEnd: (v) => v.setUint32(12, 999_999, true) })), isReadError('corrupt'));
  const claimThree = (v) => {
    v.setUint16(8, 3, true);
    v.setUint16(10, 3, true);
  };
  const miscounted = await openZip(craft([...entries, { name: 'b.txt', data: 'b' }], { patchEnd: claimThree }));
  assert.deepEqual(miscounted.entries.map((e) => e.name), ['a.txt', 'b.txt']);
  assert.deepEqual(miscounted.problems.map((p) => p.code), ['entry_count_mismatch']);
});

test('a comment that contains a fake end record does not hide the real one', async () => {
  const fake = new Uint8Array(40);
  fake.set([0x50, 0x4b, 0x05, 0x06], 5); // a fake, empty end record inside the comment
  const archive = await openZip(craft([{ name: 'real.txt', data: 'real' }], { comment: concat(enc.encode('note: '), fake, enc.encode(' end')) }));
  assert.deepEqual(archive.entries.map((e) => e.name), ['real.txt']);
  assert.deepEqual(archive.problems, []);
  assert.ok(archive.comment.startsWith('note: '));

  const noisy = new Uint8Array(65_535);
  for (let i = 0; i + 4 <= noisy.length; i += 4) noisy.set([0x50, 0x4b, 0x05, 0x06], i);
  const started = Date.now();
  const crowded = await openZip(craft([{ name: 'real.txt', data: 'real' }], { comment: noisy }));
  assert.equal(dec.decode(await crowded.entries[0].read()), 'real');
  assert.ok(Date.now() - started < 5000, 'a comment full of signatures does not stall the search');
});

test('names: UTF-8 flag, CP437 fallback (checked against iconv), Unicode path field', async () => {
  const high = Uint8Array.from({ length: 128 }, (_, i) => 0x80 + i);
  const plain = (name) => ({ name, data: 'x', patchCentral: setFlags(0) }); // no UTF-8 flag
  const unicodeField = (utf8, crcOfPlain) => {
    const name = enc.encode(utf8);
    const field = new Uint8Array(4 + 5 + name.length);
    const v = viewOf(field);
    v.setUint16(0, 0x7075, true);
    v.setUint16(2, 5 + name.length, true);
    v.setUint8(4, 1);
    v.setUint32(5, crcOfPlain, true);
    field.set(name, 9);
    return field;
  };
  const archive = await openZip(craft([
    plain(new Uint8Array([0x82, 0x9a, 0xe1, 0x2e, 0x74])), // CP437 "éÜß.t"
    plain(high),
    plain(enc.encode('café.gpx')), // valid UTF-8 without the flag, as macOS zip writes it
    { name: new Uint8Array([0x66, 0xff, 0x2e, 0x74]), data: 'x' }, // flagged UTF-8 but invalid
    { ...plain(enc.encode('old.txt')), centralExtra: unicodeField('renamed-é.txt', crc32(enc.encode('old.txt'))) },
    { ...plain(enc.encode('kept.txt')), centralExtra: unicodeField('stale.txt', 0xdeadbeef) },
  ]));
  const names = archive.entries.map((e) => e.name);
  assert.equal(names[0], 'éÜß.t');
  assert.equal(names[2], 'café.gpx');
  assert.equal(names[3], 'f\ufffd.t');
  assert.equal(names[4], 'renamed-é.txt');
  assert.equal(names[5], 'kept.txt', 'a Unicode path whose CRC no longer matches is ignored');
  assert.deepEqual(archive.problems.map((p) => [p.code, p.count]), [['bad_name_encoding', 1]]);
  if (HAS_ICONV) {
    const expected = execFileSync('iconv', ['-f', 'CP437', '-t', 'UTF-8'], { input: high }).toString('utf8');
    assert.equal(names[1], expected, 'all 128 high CP437 characters match iconv');
  }
});

// ---------------------------------------------------------------------------------------------
// Limits and sources

test('limits: entry count, entry size, total read budget and directory size', async () => {
  const bytes = await zipBytes(
    [{ path: 'a.bin', bytes: new Uint8Array(100) }, { path: 'b.bin', bytes: new Uint8Array(100) }, { path: 'c.txt', bytes: 'c' }],
    { compression: 'store' },
  );
  await assert.rejects(openZip(bytes, { maxEntries: 2 }), isReadError('too_many_entries'));
  await assert.rejects(openZip(bytes, { maxCentralDirectoryBytes: 50 }), isReadError('too_large'));
  await assert.rejects(openZip(bytes, { maxEntries: -1 }), isReadError('bad_input'));

  const small = await openZip(bytes, { maxEntryBytes: 50 });
  assert.deepEqual(small.entries.map((e) => e.issue), ['too_large', 'too_large', null]);
  assert.deepEqual(small.problems.map((p) => [p.code, p.count]), [['too_large', 2]]);

  const budget = await openZip(bytes, { maxTotalBytes: 150 });
  assert.equal((await budget.entries[0].read()).length, 100);
  await assert.rejects(budget.entries[1].read(), isReadError('limit_exceeded'));
  assert.equal(dec.decode(await budget.entries[2].read()), 'c', 'smaller reads still fit the remaining budget');

  // A failed read gives its share of the budget back.
  const damaged = new Uint8Array(bytes);
  damaged[await locateData(bytes, 0)] ^= 1;
  const refund = await openZip(damaged, { maxTotalBytes: 100 });
  await assert.rejects(refund.entries[0].read(), isReadError('crc_mismatch'));
  assert.equal((await refund.entries[1].read()).length, 100);

  assert.ok(DEFAULT_LIMITS.maxEntries >= 65_536 && DEFAULT_LIMITS.maxEntryBytes >= 2 ** 30);
});

test('a random-access source that fails or returns short reads gives read_failed', async () => {
  const bytes = await zipBytes([{ path: 'a.txt', bytes: 'hello' }]);
  const failing = { size: bytes.length, read: async () => { throw new Error('disk gone'); } };
  await assert.rejects(openZip(failing), isReadError('read_failed'));
  const short = { size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + Math.max(0, length - 1)) };
  await assert.rejects(openZip(short), isReadError('read_failed'));
  // The file fails after opening, while compressed data is being fed through DecompressionStream:
  // the error must still arrive as a ZipReadError, not as whatever the stream wraps it in.
  const deflated = await zipBytes([{ path: 'a.txt', bytes: 'hello '.repeat(200) }]);
  let armed = false;
  const flaky = {
    size: deflated.length,
    read: async (offset, length) => {
      if (armed && offset >= 30) throw new Error('file changed'); // past the local header at 0: the data
      return deflated.subarray(offset, offset + length);
    },
  };
  const archive = await openZip(flaky);
  assert.equal(archive.entries[0].method, 8);
  armed = true;
  await assert.rejects(archive.entries[0].read(), isReadError('read_failed'));
});

// ---------------------------------------------------------------------------------------------
// Fuzzing

test('fuzzed archives only ever fail with ZipReadError, and finish quickly', async () => {
  const seeds = [
    await zipBytes([
      { path: 'Library/' },
      { path: 'Library/a.gpx', bytes: syntheticGpx(60, 14), mtime: Date.UTC(2020, 1, 2) },
      { path: 'Library/b.bin', bytes: randomBytes(300, 15) },
      { path: 'empty.txt', bytes: '' },
    ]),
    await zipBytes([{ path: 'x.txt', bytes: syntheticGpx(40, 16) }, { path: 'y/z.txt', bytes: 'zzz' }], { zip64: 'always' }),
  ];
  const next = mulberry32(2026);
  const pick = (n) => Math.floor(next() * n);
  const limits = { maxEntryBytes: 1 << 20, maxTotalBytes: 8 << 20 };
  const started = Date.now();
  let opened = 0;
  let rejected = 0;
  let readsOk = 0;
  let readsRejected = 0;
  for (let round = 0; round < 1500; round++) {
    const seed = seeds[round % seeds.length];
    let bytes = new Uint8Array(seed);
    const kind = pick(4);
    if (kind === 0) {
      for (let k = 1 + pick(4); k > 0; k--) bytes[pick(bytes.length)] = pick(256);
    } else if (kind === 1) {
      // focus on the central directory and end records, where offsets and sizes live
      const tailStart = Math.floor(bytes.length * 0.55);
      for (let k = 1 + pick(3); k > 0; k--) bytes[tailStart + pick(bytes.length - tailStart)] = pick(256);
    } else if (kind === 2) {
      const at = Math.max(0, bytes.length - 120 + pick(120) - 4);
      viewOf(bytes).setUint32(at, [0xffffffff, 0, 0x7fffffff, pick(2 ** 32)][pick(4)] >>> 0, true);
    } else {
      bytes = bytes.subarray(pick(bytes.length), bytes.length - pick(40));
    }
    try {
      const archive = await openZip(bytes, limits);
      opened++;
      for (const entry of archive.entries) {
        try {
          await entry.read();
          readsOk++;
        } catch (error) {
          assert.ok(error instanceof ZipReadError, `round ${round}: read() threw ${error?.stack ?? error}`);
          readsRejected++;
        }
      }
    } catch (error) {
      assert.ok(error instanceof ZipReadError, `round ${round}: openZip threw ${error?.stack ?? error}`);
      rejected++;
    }
  }
  assert.ok(opened > 100 && rejected > 100, `opened ${opened}, rejected ${rejected}`);
  assert.ok(readsOk > 100 && readsRejected > 10, `reads ok ${readsOk}, rejected ${readsRejected}`);
  assert.ok(Date.now() - started < 30_000, 'fuzzing finished in time');
});

// ---------------------------------------------------------------------------------------------
// Adversarial review: each test below failed on the first version of the reader, except where noted

const HAS_UNZIP = spawnSync('/usr/bin/which', ['unzip']).status === 0;
const HAS_DITTO = process.platform === 'darwin' && spawnSync('/usr/bin/which', ['ditto']).status === 0;

/** A random-access source that reads zeros everywhere except where `segments` place bytes. */
function sparseSource(segments, size) {
  return {
    size,
    async read(offset, length) {
      const out = new Uint8Array(length);
      for (const s of segments) {
        const from = Math.max(offset, s.at);
        const to = Math.min(offset + length, s.at + s.bytes.length);
        if (from < to) out.set(s.bytes.subarray(from - s.at, to - s.at), from - offset);
      }
      return out;
    },
  };
}

/** A UT (0x5455) or UX (0x5855) extra field holding `seconds` as the modification time. */
function timeField(id, seconds) {
  const field = new Uint8Array(id === 0x5455 ? 9 : 12);
  const v = viewOf(field);
  v.setUint16(0, id, true);
  v.setUint16(2, field.length - 4, true);
  if (id === 0x5455) {
    v.setUint8(4, 1);
    v.setInt32(5, seconds, true);
  } else {
    v.setUint32(4, seconds + 3600, true); // access time, which must not be taken for the modification time
    v.setUint32(8, seconds, true);
  }
  return field;
}

test('an entry too large to allocate fails with out_of_memory, not a RangeError', async () => {
  const { encodeLocalHeader, encodeCentralHeader, encodeEnd, entryZip64 } = internals;
  const size = 2 ** 52; // a stored entry of 4 PiB in a sparse virtual archive
  const plan = {
    name: enc.encode('huge.bin'), directory: false, method: 0, crc: 0, compressedSize: size, uncompressedSize: size,
    offset: 0, dosTime: 0, dosDate: (1 << 5) | 1, unixTime: null, ...entryZip64(size, size, 0, false),
  };
  const local = encodeLocalHeader(plan);
  const central = encodeCentralHeader(plan);
  const centralOffset = local.length + size;
  const end = encodeEnd(1, central.length, centralOffset, false);
  const source = sparseSource(
    [{ at: 0, bytes: local }, { at: centralOffset, bytes: central }, { at: centralOffset + central.length, bytes: end }],
    centralOffset + central.length + end.length,
  );
  const archive = await openZip(source, { maxEntryBytes: Number.MAX_SAFE_INTEGER, maxTotalBytes: Number.MAX_SAFE_INTEGER });
  assert.equal(archive.entries[0].issue, null);
  await assert.rejects(archive.entries[0].read(), isReadError('out_of_memory'));
});

test('a runtime whose DecompressionStream lacks "deflate-raw" gives unsupported_runtime', async () => {
  const text = 'hello '.repeat(100);
  const archive = await openZip(await zipBytes([{ path: 'a.txt', bytes: text }]));
  assert.equal(archive.entries[0].method, 8);
  const Real = globalThis.DecompressionStream;
  globalThis.DecompressionStream = class {
    constructor(format) {
      if (format === 'deflate-raw') throw new TypeError('Unsupported compression format');
      return new Real(format);
    }
  };
  try {
    await assert.rejects(archive.entries[0].read(), isReadError('unsupported_runtime'));
  } finally {
    globalThis.DecompressionStream = Real;
  }
  assert.equal(dec.decode(await archive.entries[0].read()), text);
});

test('bytes before the end record that only look like a ZIP64 locator do not reject a valid archive', async () => {
  // The last central record ends with the locator signature and 16 more bytes, so the 20 bytes before
  // the end record look like a locator: in its name (read as naming other disks), or in an unknown extra
  // field (all zeros: a locator pointing at no ZIP64 record). Info-ZIP's unzip and bsdtar accept both.
  const lookalike = (filler) => concat(new Uint8Array([0x50, 0x4b, 0x06, 0x07]), new Uint8Array(16).fill(filler));
  const variants = [
    { name: concat(enc.encode('n'), lookalike(0x41)), data: 'payload' },
    { name: 'n.txt', data: 'payload', centralExtra: concat(new Uint8Array([0xfe, 0xca, 20, 0]), lookalike(0)) },
  ];
  for (const [k, spec] of variants.entries()) {
    const bytes = craft([spec]);
    assert.equal(viewOf(bytes).getUint32(bytes.length - 22 - 20, true), 0x07064b50);
    const archive = await openZip(bytes);
    assert.equal(archive.zip64, false);
    assert.deepEqual(archive.problems, []);
    assert.equal(dec.decode(await archive.entries[0].read()), 'payload');
    if (HAS_UNZIP) {
      const file = path.join(tmp, `fake-locator-${k}.zip`);
      fs.writeFileSync(file, bytes);
      const check = spawnSync('unzip', ['-t', file], { encoding: 'utf8' });
      assert.equal(check.status, 0, check.stdout + check.stderr);
    }
  }
  // Still true (these passed before the fix too): ZIP64 markers in the 32-bit fields need the ZIP64
  // records, and a locator that names several disks still means a split archive.
  const forced = await zipBytes([{ path: 'a.txt', bytes: 'a' }], { zip64: 'always' });
  const noRecord = new Uint8Array(forced);
  viewOf(noRecord).setUint32(forced.length - 22 - 20 - 56, 0, true);
  await assert.rejects(openZip(noRecord), isReadError('corrupt'));
  const split = new Uint8Array(forced);
  viewOf(split).setUint32(forced.length - 22 - 20 + 16, 2, true);
  await assert.rejects(openZip(split), isReadError('multi_disk'));
});

test('an empty end record planted in the comment does not hide the real archive', async () => {
  const after = enc.encode(' trailing words');
  const fake = new Uint8Array(22);
  viewOf(fake).setUint32(0, 0x06054b50, true);
  viewOf(fake).setUint16(20, after.length, true); // its own "comment" ends exactly at the end of the file
  const bytes = craft([{ name: 'real.txt', data: 'real data' }], { comment: concat(enc.encode('note: '), fake, after) });
  const archive = await openZip(bytes);
  assert.deepEqual(archive.entries.map((e) => e.name), ['real.txt']);
  assert.deepEqual(archive.problems, []);
  assert.ok(archive.comment.startsWith('note: '));
  if (HAS_DITTO) {
    // Finder's Archive Utility (ditto) also finds the file; Info-ZIP's unzip and bsdtar list nothing.
    const file = path.join(tmp, 'planted-empty.zip');
    fs.writeFileSync(file, bytes);
    const out = fs.mkdtempSync(path.join(tmp, 'planted-'));
    assert.equal(spawnSync('ditto', ['-x', '-k', file, out]).status, 0);
    assert.equal(fs.readFileSync(path.join(out, 'real.txt'), 'utf8'), 'real data');
  }

  // Empty archives still open on their own, and say so when other bytes surround them.
  const empty = await zipBytes([]);
  const plain = await openZip(empty);
  assert.deepEqual([plain.entries.length, plain.problems], [0, []]);
  const trailing = await openZip(concat(empty, enc.encode('extra bytes after the archive')));
  assert.deepEqual([trailing.entries.length, trailing.problems.map((p) => p.code)], [0, ['trailing_data']]);
  const prefixed = await openZip(concat(enc.encode('a stub before the archive'), empty));
  assert.deepEqual([prefixed.entries.length, prefixed.problems.map((p) => p.code)], [0, ['prefixed_data']]);
});

test('modified: the UT field, else the UX field that macOS Finder writes, else the DOS fields', async () => {
  const t1 = Date.UTC(2022, 0, 2, 3, 4, 5) / 1000;
  const t2 = Date.UTC(2023, 6, 8, 9, 10, 11) / 1000;
  const shortUx = new Uint8Array([0x55, 0x58, 0x04, 0x00, 1, 2, 3, 4]); // too short to hold a modification time
  const archive = await openZip(craft([
    { name: 'ux.txt', data: 'a', centralExtra: timeField(0x5855, t1) },
    { name: 'ut-and-ux.txt', data: 'b', centralExtra: concat(timeField(0x5855, t1), timeField(0x5455, t2)) },
    { name: 'short-ux.txt', data: 'c', centralExtra: shortUx },
  ]));
  assert.deepEqual(archive.entries.map((e) => e.modified), [t1 * 1000, t2 * 1000, Date.UTC(1980, 0, 1)]);
  assert.deepEqual(archive.problems, []);
});

test('a Finder (ditto) archive made in another time zone reads its exact time', { skip: !HAS_DITTO && 'needs macOS ditto' }, async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'finder-'));
  const when = Date.UTC(2023, 3, 4, 5, 6, 7);
  fs.writeFileSync(path.join(dir, 'track.gpx'), syntheticGpx(10, 30));
  fs.utimesSync(path.join(dir, 'track.gpx'), when / 1000, when / 1000);
  const file = path.join(tmp, 'finder.zip');
  // ditto writes the DOS fields in local time, here 9 hours off UTC, plus the UX field.
  execFileSync('ditto', ['-c', '-k', 'track.gpx', file], { cwd: dir, env: { ...process.env, TZ: 'Asia/Tokyo' } });
  const archive = await openZip(fs.readFileSync(file));
  const entry = archive.entries.find((e) => e.name === 'track.gpx');
  assert.equal(entry.modified, when);
  assert.equal(dec.decode(await entry.read()), syntheticGpx(10, 30));
});

test('compressed data reaches the inflater in pieces of at most 64 KiB', async () => {
  // Defence in depth, not a failure seen in Node: an engine that inflates a whole input chunk before
  // yielding could build up 1032 times that chunk in memory before read() can stop it.
  const text = Buffer.from(randomBytes(1_500_000, 31)).toString('hex'); // hex text deflates to about half
  const archive = await openZip(await zipBytes([{ path: 'big.txt', bytes: text }]));
  const entry = archive.entries[0];
  assert.equal(entry.method, 8);
  assert.ok(entry.compressedSize > 1 << 20, 'spans more than one 1 MiB read');
  const Real = globalThis.DecompressionStream;
  let largest = 0;
  let pieces = 0;
  globalThis.DecompressionStream = class {
    constructor(format) {
      const spy = new TransformStream({
        transform(chunk, controller) {
          largest = Math.max(largest, chunk.length);
          pieces++;
          controller.enqueue(chunk);
        },
      });
      this.writable = spy.writable;
      this.readable = spy.readable.pipeThrough(new Real(format));
    }
  };
  try {
    assert.deepEqual(await entry.read(), enc.encode(text));
  } finally {
    globalThis.DecompressionStream = Real;
  }
  assert.ok(largest > 0 && largest <= 1 << 16, `largest piece ${largest}`);
  assert.ok(pieces >= Math.ceil(entry.compressedSize / (1 << 16)), `${pieces} pieces`);
});
