// Tests for src/export/crc32.js and src/export/zip.js.
// The writer is cross-checked against tools that share no code with it: the system `unzip` and
// `zipinfo` (Info-ZIP, shipped with macOS) and node:zlib. All data is synthetic.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { crc32, Crc32 } from '../src/export/crc32.js';
import { zipChunks, zipBytes, ZipWriter, ZipWriteError, internals } from '../src/export/zip.js';
import { openZip, ZipReadError } from '../src/format/unzip.js';

const enc = new TextEncoder();
const GiB = 2 ** 30;
const hasTool = (name) => spawnSync('/usr/bin/which', [name]).status === 0;
const HAS_INFOZIP = hasTool('unzip') && hasTool('zipinfo');

/** @type {string} */
let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bcr-zip-'));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Deterministic pseudo-random numbers in [0, 1). */
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

/** Synthetic GPX-like text (made-up coordinates), compressible like the real exports. */
function syntheticGpx(points, seed) {
  const next = mulberry32(seed);
  let text = '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="synthetic"><trk><trkseg>\n';
  for (let i = 0; i < points; i++) {
    const lat = (10 + next()).toFixed(6);
    const lon = (20 + next()).toFixed(6);
    text += `  <trkpt lat="${lat}" lon="${lon}"><ele>${(100 + i % 50).toFixed(1)}</ele></trkpt>\n`;
  }
  return text + '</trkseg></trk></gpx>\n';
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, ...options });
}

function writeTemp(name, bytes) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, bytes);
  return file;
}

/**
 * An independent, minimal parser for archives this writer produces (no comment, single disk).
 * Used to check header fields without trusting src/format/unzip.js.
 */
function inspect(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50, 'end record at the very end');
  const end = {
    countOnDisk: buf.readUInt16LE(eocd + 8),
    count: buf.readUInt16LE(eocd + 10),
    centralSize: buf.readUInt32LE(eocd + 12),
    centralOffset: buf.readUInt32LE(eocd + 16),
    commentLength: buf.readUInt16LE(eocd + 20),
  };
  let zip64End = null;
  let { count, centralSize, centralOffset } = end;
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) {
    const at = Number(buf.readBigUInt64LE(eocd - 20 + 8));
    assert.equal(buf.readUInt32LE(at), 0x06064b50, 'ZIP64 end record where the locator says');
    assert.equal(at, eocd - 20 - 56, 'ZIP64 end record right before the locator');
    zip64End = {
      recordSize: Number(buf.readBigUInt64LE(at + 4)),
      versionNeeded: buf.readUInt16LE(at + 14),
      count: Number(buf.readBigUInt64LE(at + 32)),
      centralSize: Number(buf.readBigUInt64LE(at + 40)),
      centralOffset: Number(buf.readBigUInt64LE(at + 48)),
    };
    ({ count, centralSize, centralOffset } = zip64End);
  }
  assert.equal(centralOffset + centralSize, zip64End ? eocd - 76 : eocd, 'central directory ends at the end records');
  const extras = (slice) => {
    const map = new Map();
    for (let p = 0; p + 4 <= slice.length; ) {
      const id = slice.readUInt16LE(p);
      const size = slice.readUInt16LE(p + 2);
      map.set(id, slice.subarray(p + 4, p + 4 + size));
      p += 4 + size;
    }
    return map;
  };
  const entries = [];
  let at = centralOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const centralExtra = extras(buf.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength));
    const e = {
      madeBy: buf.readUInt16LE(at + 4),
      versionNeeded: buf.readUInt16LE(at + 6),
      flags: buf.readUInt16LE(at + 8),
      method: buf.readUInt16LE(at + 10),
      dosTime: buf.readUInt16LE(at + 12),
      dosDate: buf.readUInt16LE(at + 14),
      crc: buf.readUInt32LE(at + 16),
      compressedSize: buf.readUInt32LE(at + 20),
      uncompressedSize: buf.readUInt32LE(at + 24),
      externalAttributes: buf.readUInt32LE(at + 38),
      offset: buf.readUInt32LE(at + 42),
      name: buf.subarray(at + 46, at + 46 + nameLength).toString('utf8'),
      centralExtra,
    };
    const zip64 = centralExtra.get(0x0001);
    let z = 0;
    if (e.uncompressedSize === 0xffffffff) (e.uncompressedSize = Number(zip64.readBigUInt64LE(z))), (z += 8);
    if (e.compressedSize === 0xffffffff) (e.compressedSize = Number(zip64.readBigUInt64LE(z))), (z += 8);
    if (e.offset === 0xffffffff) (e.offset = Number(zip64.readBigUInt64LE(z))), (z += 8);
    assert.equal(buf.readUInt32LE(e.offset), 0x04034b50, 'local header where the central record says');
    const localNameLength = buf.readUInt16LE(e.offset + 26);
    const localExtraLength = buf.readUInt16LE(e.offset + 28);
    e.local = {
      versionNeeded: buf.readUInt16LE(e.offset + 4),
      flags: buf.readUInt16LE(e.offset + 6),
      method: buf.readUInt16LE(e.offset + 8),
      crc: buf.readUInt32LE(e.offset + 14),
      compressedSize: buf.readUInt32LE(e.offset + 18),
      uncompressedSize: buf.readUInt32LE(e.offset + 22),
      name: buf.subarray(e.offset + 30, e.offset + 30 + localNameLength).toString('utf8'),
      extra: extras(buf.subarray(e.offset + 30 + localNameLength, e.offset + 30 + localNameLength + localExtraLength)),
    };
    const dataStart = e.offset + 30 + localNameLength + localExtraLength;
    e.data = buf.subarray(dataStart, dataStart + e.compressedSize);
    entries.push(e);
    at += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(at, centralOffset + centralSize, 'central directory size matches its records');
  return { end, zip64End, entries };
}

/** A mixed set of entries: folders, an empty folder, an empty file, UTF-8 names, compressible and random data. */
function sampleEntries() {
  return [
    { path: 'Library/' },
    { path: 'Library/Tracks/Morning run.gpx', bytes: syntheticGpx(2000, 1), mtime: Date.UTC(2024, 5, 15, 12, 30, 45) },
    { path: 'Library/Tracks/Ünïcödé 日本 😀.gpx', bytes: syntheticGpx(20, 2) },
    { path: 'Library/Waypoints/empty.gpx', bytes: '' },
    { path: 'Library/Empty Folder/' },
    { path: 'random.bin', bytes: randomBytes(4096, 3) },
    { path: 'report.txt', bytes: 'Converted 3 tracks.\n' },
  ];
}

const contentOf = (entry) => (typeof entry.bytes === 'string' ? enc.encode(entry.bytes) : entry.bytes ?? new Uint8Array(0));

// ---------------------------------------------------------------------------------------------
// CRC-32

test('crc32 matches the standard check values', () => {
  assert.equal(crc32(new Uint8Array(0)), 0);
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
  assert.equal(crc32(enc.encode('The quick brown fox jumps over the lazy dog')), 0x414fa339);
  assert.equal(crc32(new Uint8Array([0xff, 0xff, 0xff, 0xff])), 0xffffffff);
});

test('crc32 agrees with node:zlib on pseudo-random data', { skip: typeof zlib.crc32 !== 'function' && 'zlib.crc32 needs Node 22.2+' }, () => {
  for (const [length, seed] of [[1, 1], [255, 2], [65536, 3], [1 << 20, 4]]) {
    const data = randomBytes(length, seed);
    assert.equal(crc32(data), zlib.crc32(data), `length ${length}`);
  }
});

test('crc32 is incremental: chained chunks equal one pass', () => {
  const data = randomBytes(10_000, 5);
  const whole = crc32(data);
  assert.equal(crc32(data.subarray(3000), crc32(data.subarray(0, 3000))), whole);
  const hasher = new Crc32();
  for (let at = 0; at < data.length; at += 777) hasher.update(data.subarray(at, at + 777));
  assert.equal(hasher.digest(), whole);
  assert.equal(new Crc32().digest(), 0);
});

// ---------------------------------------------------------------------------------------------
// Structure

test('every header is well formed and the names are flagged UTF-8', async () => {
  const input = sampleEntries();
  const zip = inspect(await zipBytes(input));
  assert.equal(zip.zip64End, null, 'a small archive needs no ZIP64 records');
  assert.equal(zip.end.count, input.length);
  assert.equal(zip.end.countOnDisk, input.length);
  assert.equal(zip.end.commentLength, 0);
  assert.deepEqual(zip.entries.map((e) => e.name), input.map((e) => e.path));
  zip.entries.forEach((e, i) => {
    const bytes = contentOf(input[i]);
    const directory = input[i].path.endsWith('/');
    assert.equal(e.flags, 0x0800, 'central: UTF-8 flag only');
    assert.equal(e.local.flags, 0x0800, 'local: UTF-8 flag only');
    assert.equal(e.madeBy, 0x033f, 'made by Unix, spec 6.3');
    assert.equal(e.local.name, e.name);
    assert.equal(e.uncompressedSize, bytes.length);
    assert.equal(e.local.uncompressedSize, bytes.length);
    assert.equal(e.local.compressedSize, e.compressedSize);
    assert.equal(e.local.crc, e.crc);
    assert.equal(e.local.method, e.method);
    assert.equal(e.local.versionNeeded, e.versionNeeded);
    assert.equal(e.crc, typeof zlib.crc32 === 'function' ? zlib.crc32(bytes) : crc32(bytes));
    assert.equal(e.externalAttributes >>> 16, directory ? 0o040755 : 0o100644);
    assert.equal(e.versionNeeded, e.method === 8 || directory ? 20 : 10);
    if (e.method === 0) assert.deepEqual(new Uint8Array(e.data), bytes, `${e.name} stored verbatim`);
  });
  const byName = new Map(zip.entries.map((e) => [e.name, e]));
  assert.equal(byName.get('Library/Tracks/Morning run.gpx').method, 8, 'compressible text is deflated');
  assert.equal(byName.get('random.bin').method, 0, 'random data that would grow is stored');
  assert.equal(byName.get('Library/Waypoints/empty.gpx').method, 0, 'an empty file is stored');
  assert.equal(byName.get('Library/Empty Folder/').externalAttributes & 0x10, 0x10, 'MS-DOS directory bit');
});

test('deflated data inflates with node:zlib to the original bytes', async () => {
  const input = sampleEntries();
  const zip = inspect(await zipBytes(input));
  let deflated = 0;
  zip.entries.forEach((e, i) => {
    if (e.method !== 8) return;
    deflated++;
    assert.ok(e.compressedSize < e.uncompressedSize);
    assert.deepEqual(new Uint8Array(zlib.inflateRawSync(e.data)), contentOf(input[i]));
  });
  assert.ok(deflated >= 2);
});

test('compression "store" stores everything', async () => {
  const zip = inspect(await zipBytes(sampleEntries(), { compression: 'store' }));
  assert.ok(zip.entries.every((e) => e.method === 0 && e.compressedSize === e.uncompressedSize));
});

test('chunks join to the zipBytes result and build a Blob', async () => {
  const input = sampleEntries();
  const chunks = await zipChunks(input);
  assert.ok(chunks.every((c) => c instanceof Uint8Array));
  const joined = Buffer.concat(chunks);
  assert.deepEqual(new Uint8Array(joined), await zipBytes(input));
  const blob = new Blob(chunks, { type: 'application/zip' });
  assert.equal(blob.size, joined.length);
});

test('an archive with no entries is a bare end record', async () => {
  const bytes = await zipBytes([]);
  assert.equal(bytes.length, 22);
  const zip = inspect(bytes);
  assert.equal(zip.end.count, 0);
  assert.equal(zip.entries.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Time stamps and determinism

test('DOS date/time: default, rounding and clamping to 1980..2107', () => {
  const { dosDateTime } = internals;
  assert.deepEqual(dosDateTime(Date.UTC(1980, 0, 1)), { dosTime: 0, dosDate: (1 << 5) | 1 });
  assert.deepEqual(dosDateTime(Date.UTC(1969, 6, 20, 20, 17, 40)), { dosTime: 0, dosDate: (1 << 5) | 1 }, 'before 1980 clamps up');
  const max = { dosTime: (23 << 11) | (59 << 5) | 29, dosDate: (127 << 9) | (12 << 5) | 31 };
  assert.deepEqual(dosDateTime(Date.UTC(2200, 0, 1)), max, 'after 2107 clamps down');
  assert.deepEqual(dosDateTime(Date.UTC(2107, 11, 31, 23, 59, 59, 999)), max);
  assert.deepEqual(dosDateTime(Date.UTC(2024, 5, 15, 12, 30, 45, 900)), {
    dosTime: (12 << 11) | (30 << 5) | 22, // seconds are stored in 2-second steps: 45 -> 44
    dosDate: (44 << 9) | (6 << 5) | 15,
  });
});

test('mtime: DOS fields always, a UT extra field only for an explicit time inside 1970..2038', async () => {
  const zip = inspect(
    await zipBytes([
      { path: 'none.txt', bytes: 'a' },
      { path: 'set.txt', bytes: 'b', mtime: new Date(Date.UTC(2024, 5, 15, 12, 30, 45)) },
      { path: 'early.txt', bytes: 'c', mtime: Date.UTC(1975, 0, 1) },
      { path: 'late.txt', bytes: 'd', mtime: Date.UTC(2100, 0, 1) },
    ]),
  );
  const [none, set, early, late] = zip.entries;
  assert.equal(none.dosDate, (1 << 5) | 1);
  assert.equal(none.dosTime, 0);
  assert.equal(none.centralExtra.size, 0);
  assert.equal(set.centralExtra.get(0x5455).readInt32LE(1), Date.UTC(2024, 5, 15, 12, 30, 45) / 1000);
  assert.equal(set.centralExtra.get(0x5455)[0], 1, 'flags: modification time present');
  assert.deepEqual(set.local.extra.get(0x5455), set.centralExtra.get(0x5455));
  assert.equal(early.dosDate, (1 << 5) | 1, '1975 clamps to 1980 in the DOS fields');
  assert.equal(early.centralExtra.get(0x5455).readInt32LE(1), Date.UTC(1975, 0, 1) / 1000, 'UT keeps the exact time');
  assert.equal(late.dosDate >> 9, 2100 - 1980);
  assert.equal(late.centralExtra.has(0x5455), false, 'past 2038 does not fit a signed 32-bit UT field');
});

test('same input, same bytes, in any time zone', async () => {
  const input = sampleEntries();
  const first = await zipBytes(input);
  assert.deepEqual(await zipBytes(input), first);

  const moduleUrl = new URL('../src/export/zip.js', import.meta.url).href;
  const script =
    `import { zipBytes } from ${JSON.stringify(moduleUrl)};` +
    `const b = await zipBytes([{ path: 'a/b.txt', bytes: 'hello hello hello hello', mtime: Date.UTC(2024, 0, 2, 3, 4, 5) }, { path: 'c.txt', bytes: 'x' }]);` +
    `process.stdout.write(Buffer.from(b).toString('base64'));`;
  const outputs = ['UTC', 'Pacific/Kiritimati', 'America/St_Johns'].map((TZ) =>
    execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], {
      env: { ...process.env, TZ },
      encoding: 'utf8',
    }),
  );
  assert.equal(new Set(outputs).size, 1, 'identical bytes in three time zones');
});

// ---------------------------------------------------------------------------------------------
// Cross-checks with Info-ZIP (macOS built-ins)

test('system unzip tests the archive clean and extracts identical files', { skip: !HAS_INFOZIP && 'needs unzip' }, async () => {
  const input = sampleEntries();
  const file = writeTemp('sample.zip', await zipBytes(input));
  const check = run('unzip', ['-t', file]);
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /No errors detected in compressed data/);

  const out = path.join(tmp, 'sample-out');
  const extract = run('unzip', ['-q', file, '-d', out]);
  assert.equal(extract.status, 0, extract.stdout + extract.stderr);
  for (const entry of input) {
    const target = path.join(out, entry.path);
    if (entry.path.endsWith('/')) {
      assert.ok(fs.statSync(target).isDirectory(), `${entry.path} is a folder`);
    } else {
      assert.deepEqual(new Uint8Array(fs.readFileSync(target)), contentOf(entry), entry.path);
    }
  }
  assert.deepEqual(fs.readdirSync(path.join(out, 'Library/Empty Folder')), [], 'the empty folder exists and is empty');
  // unzip applies the UT field, so the extracted file carries the exact time given.
  const stat = fs.statSync(path.join(out, 'Library/Tracks/Morning run.gpx'));
  assert.equal(stat.mtimeMs, Date.UTC(2024, 5, 15, 12, 30, 45));
  assert.equal(stat.mode & 0o777, 0o644);
});

test('zipinfo reads the method, permissions and DOS date/time we wrote', { skip: !HAS_INFOZIP && 'needs zipinfo' }, async () => {
  const file = writeTemp('info.zip', await zipBytes(sampleEntries()));
  const info = run('zipinfo', ['-v', file]);
  assert.equal(info.status, 0, info.stderr);
  const blocks = info.stdout.split(/Central directory entry #\d+:/).slice(1);
  assert.equal(blocks.length, 7);
  const run1 = blocks[1];
  assert.match(run1, /Library\/Tracks\/Morning run\.gpx/);
  assert.match(run1, /compression method:\s+deflated/);
  assert.match(run1, /file last modified on \(DOS date\/time\):\s+2024 Jun 15 12:30:44/);
  assert.match(run1, /Unix file attributes \(100644 octal\)/);
  assert.match(run1, /minimum software version required to extract:\s+2\.0/);
  assert.match(blocks[0], /Unix file attributes \(040755 octal\)/);
  assert.match(blocks[0], /file last modified on \(DOS date\/time\):\s+1980 Jan 1 00:00:00/);
  assert.match(blocks[5], /compression method:\s+none \(stored\)/);
  assert.match(blocks[5], /minimum software version required to extract:\s+1\.0/);
});

// ---------------------------------------------------------------------------------------------
// Input validation

test('rejects paths, contents and times that would not extract honestly', async () => {
  const a = (path, extra = {}) => ({ path, bytes: 'x', ...extra });
  const cases = [
    ['invalid_path', [a('../x.txt')]],
    ['invalid_path', [a('Folder/../x.txt')]],
    ['invalid_path', [a('./x.txt')]],
    ['invalid_path', [a('/abs.txt')]],
    ['invalid_path', [a('a//b.txt')]],
    ['invalid_path', [a('a\\b.txt')]],
    ['invalid_path', [a('')]],
    ['invalid_path', [{ path: '/' }]],
    ['invalid_path', [a('nul\u0000.txt')]],
    ['invalid_path', [a('tab\t.txt')]],
    ['invalid_path', [a('lone \ud800 surrogate.txt')]],
    ['invalid_path', [a('x'.repeat(65536))]],
    ['invalid_path', [a(42)]],
    ['duplicate_path', [a('a.txt'), a('a.txt')]],
    ['duplicate_path', [a('Track.gpx'), a('track.GPX')]],
    ['duplicate_path', [a('café.gpx'), a('café.gpx')]],
    ['duplicate_path', [{ path: 'd/' }, { path: 'D/' }]],
    ['path_conflict', [a('a'), a('a/b.txt')]],
    ['path_conflict', [a('a/b.txt'), a('A')]],
    ['path_conflict', [a('a'), { path: 'a/' }]],
    ['invalid_bytes', [{ path: 'd/', bytes: 'x' }]],
    ['invalid_bytes', [{ path: 'f.txt' }]],
    ['invalid_bytes', [{ path: 'f.txt', bytes: [1, 2] }]],
    ['invalid_bytes', [{ path: 'f.txt', bytes: new Uint16Array(2) }]],
    ['invalid_bytes', [{ path: 'f.txt', bytes: 'lone \udc00' }]],
    ['invalid_mtime', [a('f.txt', { mtime: NaN })]],
    ['invalid_mtime', [a('f.txt', { mtime: new Date('not a date') })]],
    ['invalid_mtime', [a('f.txt', { mtime: '2024-01-01' })]],
    ['invalid_options', null],
    ['invalid_options', [null]],
  ];
  for (const [code, entries] of cases) {
    await assert.rejects(zipBytes(/** @type {any} */ (entries)), (error) => {
      assert.ok(error instanceof ZipWriteError, `${JSON.stringify(entries)?.slice(0, 80)} -> ${error}`);
      assert.equal(error.code, code, `${JSON.stringify(entries)?.slice(0, 80)}: ${error.message}`);
      assert.ok(error.message.length > 10);
      return true;
    });
  }
  await assert.rejects(zipBytes([], /** @type {any} */ ({ compression: 'zstd' })), { code: 'invalid_options' });
  await assert.rejects(zipBytes([], /** @type {any} */ ({ zip64: 'never' })), { code: 'invalid_options' });
});

test('accepts an explicit folder next to its own files, and the longest legal name', async () => {
  const longest = 'n'.repeat(65535);
  const zip = inspect(
    await zipBytes([{ path: 'a/' }, { path: 'a/b.txt', bytes: 'x' }, { path: 'a/c/', bytes: new Uint8Array(0) }, { path: longest, bytes: '' }]),
  );
  assert.deepEqual(zip.entries.map((e) => e.name.length), [2, 7, 4, 65535]);
});

// ---------------------------------------------------------------------------------------------
// ZIP64

test('ZIP64 thresholds sit exactly at the 16- and 32-bit markers', () => {
  const { entryZip64, encodeEnd } = internals;
  assert.deepEqual(entryZip64(0xfffffffe, 0xfffffffe, 0xfffffffe, false), { sizesZip64: false, offsetZip64: false });
  assert.deepEqual(entryZip64(0xffffffff, 10, 0, false), { sizesZip64: true, offsetZip64: false });
  assert.deepEqual(entryZip64(10, 0xffffffff, 0, false), { sizesZip64: true, offsetZip64: false });
  assert.deepEqual(entryZip64(10, 10, 0xffffffff, false), { sizesZip64: false, offsetZip64: true });
  assert.deepEqual(entryZip64(0, 0, 0, true), { sizesZip64: true, offsetZip64: true });
  assert.equal(encodeEnd(0xfffe, 0xfffffffe, 0xfffffffe, false).length, 22);
  assert.equal(encodeEnd(0xffff, 0, 0, false).length, 98);
  assert.equal(encodeEnd(1, 0xffffffff, 0, false).length, 98);
  assert.equal(encodeEnd(1, 0, 0xffffffff, false).length, 98);
  const end = Buffer.from(encodeEnd(3, 100, 5 * GiB, false));
  assert.equal(end.readUInt16LE(76 + 10), 3, 'a count that fits stays literal');
  assert.equal(end.readUInt32LE(76 + 12), 100, 'a size that fits stays literal');
  assert.equal(end.readUInt32LE(76 + 16), 0xffffffff, 'an offset that does not fit is the marker');
  assert.equal(Number(end.readBigUInt64LE(48)), 5 * GiB);
});

test('forced ZIP64 archive passes unzip -t, zipinfo and node:zlib, and reads back', async () => {
  const input = sampleEntries();
  const bytes = await zipBytes(input, { zip64: 'always' });
  const zip = inspect(bytes);
  assert.ok(zip.zip64End);
  assert.equal(zip.zip64End.recordSize, 44);
  assert.equal(zip.zip64End.versionNeeded, 45);
  assert.equal(zip.zip64End.count, input.length);
  assert.deepEqual([zip.end.count, zip.end.centralSize, zip.end.centralOffset], [0xffff, 0xffffffff, 0xffffffff]);
  zip.entries.forEach((e, i) => {
    assert.equal(e.versionNeeded, 45);
    assert.equal(e.centralExtra.get(0x0001).length, 24, 'central: both sizes and the offset');
    assert.equal(e.local.extra.get(0x0001).length, 16, 'local: both sizes');
    assert.deepEqual([e.local.compressedSize, e.local.uncompressedSize], [0xffffffff, 0xffffffff]);
    assert.equal(e.uncompressedSize, contentOf(input[i]).length);
    if (e.method === 8) assert.deepEqual(new Uint8Array(zlib.inflateRawSync(e.data)), contentOf(input[i]));
  });

  const archive = await openZip(bytes);
  assert.equal(archive.zip64, true);
  assert.deepEqual(archive.problems, []);
  for (const [i, entry] of archive.entries.entries()) assert.deepEqual(await entry.read(), contentOf(input[i]));

  if (!HAS_INFOZIP) return;
  const file = writeTemp('forced64.zip', bytes);
  const check = run('unzip', ['-t', file]);
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /No errors detected in compressed data/);
  const info = run('zipinfo', ['-v', file]);
  assert.equal(info.status, 0, info.stderr);
  assert.match(info.stdout, /minimum software version required to extract:\s+4\.5/);
  assert.doesNotMatch(info.stdout, /error|warning/i);
});

test('70,000 entries switch to ZIP64 automatically and unzip accepts them', async () => {
  const count = 70_000;
  const input = Array.from({ length: count }, (_, i) => ({ path: `d${i % 100}/f${i}.txt`, bytes: String(i) }));
  const bytes = await zipBytes(input, { compression: 'store' });
  const zip = inspect(bytes);
  assert.ok(zip.zip64End, 'ZIP64 end record present');
  assert.equal(zip.zip64End.count, count);
  assert.equal(zip.end.count, 0xffff, '16-bit count is the marker');
  assert.ok(zip.end.centralOffset < 0xffffffff, 'offset fits, so it stays literal');
  assert.equal(zip.entries[0].versionNeeded, 10, 'entries themselves need no ZIP64');

  const archive = await openZip(bytes);
  assert.equal(archive.entries.length, count);
  assert.deepEqual(archive.problems, []);
  for (const i of [0, 1, 65534, 65535, 65536, count - 1]) {
    assert.equal(archive.entries[i].name, `d${i % 100}/f${i}.txt`);
    assert.equal(new TextDecoder().decode(await archive.entries[i].read()), String(i));
  }

  if (!HAS_INFOZIP) return;
  const file = writeTemp('many.zip', bytes);
  const check = run('unzip', ['-tq', file]);
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /No errors detected in compressed data/);
});

test('ZIP64 offsets and sizes beyond 4 GiB, through a sparse virtual archive', async () => {
  // Real archives this size cannot be built in a test, so the encoders lay one out at true >4 GiB
  // positions over a source that reads zeros everywhere nothing was placed.
  const { encodeLocalHeader, encodeCentralHeader, encodeEnd, entryZip64 } = internals;
  /** @type {{ at: number, bytes: Uint8Array }[]} */
  const segments = [];
  const plan = (name, data, offset, sizes = data.length) => ({
    name: enc.encode(name),
    directory: false,
    method: 0,
    crc: crc32(data),
    compressedSize: sizes,
    uncompressedSize: sizes,
    offset,
    dosTime: 0,
    dosDate: (1 << 5) | 1,
    unixTime: null,
    ...entryZip64(sizes, sizes, offset, false),
  });
  const place = (at, bytes) => {
    segments.push({ at, bytes });
    return at + bytes.length;
  };

  const nearData = enc.encode('near');
  const near = plan('near.txt', nearData, 0);
  place(place(0, encodeLocalHeader(near)), nearData);

  const farData = enc.encode('far away');
  const far = plan('far.txt', farData, 5 * GiB + 7);
  assert.equal(far.offsetZip64, true);
  const afterFar = place(place(far.offset, encodeLocalHeader(far)), farData);

  const huge = plan('huge.bin', new Uint8Array(0), afterFar, 5 * GiB); // 5 GiB of virtual zeros
  assert.equal(huge.sizesZip64, true);
  const centralOffset = place(huge.offset, encodeLocalHeader(huge)) + 5 * GiB;

  let at = centralOffset;
  for (const p of [near, far, huge]) at = place(at, encodeCentralHeader(p));
  const size = place(at, encodeEnd(3, at - centralOffset, centralOffset, false));

  let largestRead = 0;
  const source = {
    size,
    async read(offset, length) {
      largestRead = Math.max(largestRead, length);
      const out = new Uint8Array(length);
      for (const s of segments) {
        const from = Math.max(offset, s.at);
        const to = Math.min(offset + length, s.at + s.bytes.length);
        if (from < to) out.set(s.bytes.subarray(from - s.at, to - s.at), from - offset);
      }
      return out;
    },
  };

  const archive = await openZip(source);
  assert.equal(archive.zip64, true);
  assert.deepEqual(archive.entries.map((e) => e.name), ['near.txt', 'far.txt', 'huge.bin']);
  assert.equal(new TextDecoder().decode(await archive.entries[0].read()), 'near');
  assert.equal(new TextDecoder().decode(await archive.entries[1].read()), 'far away');
  const big = archive.entries[2];
  assert.equal(big.uncompressedSize, 5 * GiB);
  assert.equal(big.compressedSize, 5 * GiB);
  assert.equal(big.issue, 'too_large', 'over the default 1 GiB per-entry limit');
  await assert.rejects(big.read(), (e) => e instanceof ZipReadError && e.code === 'too_large');
  assert.ok(largestRead < 1 << 20, 'nothing large was read');

  // With a higher per-entry limit the total budget still refuses it before allocating anything.
  const roomy = await openZip(source, { maxEntryBytes: 6 * GiB });
  assert.equal(roomy.entries[2].issue, null);
  await assert.rejects(roomy.entries[2].read(), (e) => e instanceof ZipReadError && e.code === 'limit_exceeded');
});

// ---------------------------------------------------------------------------------------------
// Adversarial review: each test below failed on the first version of the writer

const HAS_DITTO = process.platform === 'darwin' && hasTool('ditto');

/** Whether `tmp` is on a case-insensitive volume (the macOS default), so the file system can referee. */
function tmpIgnoresCase() {
  const dir = fs.mkdtempSync(path.join(tmp, 'case-'));
  fs.writeFileSync(path.join(dir, 'Aa'), '');
  return fs.existsSync(path.join(dir, 'aA'));
}

test('crc32 refuses anything but a Uint8Array instead of returning the CRC of nothing', () => {
  assert.throws(() => crc32(/** @type {any} */ (enc.encode('123456789').buffer)), TypeError);
  assert.throws(() => crc32(/** @type {any} */ ([1, 2, 3])), TypeError);
  assert.throws(() => new Crc32().update(/** @type {any} */ ('text')), TypeError);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926, 'a Buffer is a Uint8Array');
});

test('names macOS treats as one name are duplicates, beyond plain lower-casing', async () => {
  // Each pair is one name on a case-insensitive APFS volume, and lower-casing alone tells them apart:
  // Archive Utility then kept only one file of the pair, silently.
  const same = [
    ['Straße.gpx', 'Strasse.gpx'],
    ['ẞ.gpx', 'ss.gpx'],
    ['µ.gpx', 'μ.gpx'], // micro sign and Greek mu
    ['οδος.gpx', 'ΟΔΟΣ.gpx'], // final sigma
    ['ſ.gpx', 's.gpx'],
    ['ﬂow.gpx', 'flow.gpx'],
  ];
  // Pairs that are two names on APFS too, so the writer must keep accepting them.
  const distinct = [['café.gpx', 'cafe.gpx'], ['Ⅻ.gpx', 'XII.gpx'], ['①.gpx', '1.gpx'], ['ü.gpx', 'u.gpx']];
  for (const [a, b] of same) {
    await assert.rejects(zipBytes([{ path: a, bytes: 'one' }, { path: b, bytes: 'two' }]), { code: 'duplicate_path' }, `${a} / ${b}`);
    await assert.rejects(zipBytes([{ path: `${a}/x.txt`, bytes: 'one' }, { path: `${b}/x.txt`, bytes: 'two' }]), { code: 'duplicate_path' });
    await assert.rejects(zipBytes([{ path: `${a}/x.txt`, bytes: 'one' }, { path: b, bytes: 'two' }]), { code: 'path_conflict' });
  }
  for (const [a, b] of distinct) {
    assert.equal(inspect(await zipBytes([{ path: a, bytes: 'one' }, { path: b, bytes: 'two' }])).entries.length, 2, `${a} / ${b}`);
  }
  if (process.platform !== 'darwin' || !tmpIgnoresCase()) return;
  for (const [pairs, expected] of [[same, true], [distinct, false]]) {
    for (const [a, b] of pairs) {
      const dir = fs.mkdtempSync(path.join(tmp, 'apfs-'));
      fs.writeFileSync(path.join(dir, a), '');
      assert.equal(fs.existsSync(path.join(dir, b)), expected, `the file system agrees about ${a} / ${b}`);
    }
  }
});

test('Archive Utility (ditto) restores the exact time and permissions in any time zone', { skip: !HAS_DITTO && 'needs macOS ditto' }, async () => {
  const when = Date.UTC(2024, 5, 15, 12, 30, 45);
  const file = writeTemp(
    'ditto-time.zip',
    await zipBytes([{ path: 'Tracks/run.gpx', bytes: syntheticGpx(50, 20), mtime: when }, { path: 'note.txt', bytes: 'n', mtime: when }]),
  );
  for (const TZ of ['Asia/Tokyo', 'America/St_Johns', 'UTC']) {
    const out = fs.mkdtempSync(path.join(tmp, 'ditto-'));
    const result = spawnSync('ditto', ['-x', '-k', file, out], { encoding: 'utf8', env: { ...process.env, TZ } });
    assert.equal(result.status, 0, result.stderr);
    for (const name of ['Tracks/run.gpx', 'note.txt']) {
      const stat = fs.statSync(path.join(out, name));
      assert.equal(stat.mtimeMs, when, `${name} in ${TZ}`);
      assert.equal(stat.mode & 0o777, 0o644);
    }
  }
});

test('the UX time field matches UT in the local and central headers, after the ZIP64 field', async () => {
  const when = Date.UTC(2024, 5, 15, 12, 30, 45);
  const zip = inspect(
    await zipBytes(
      [{ path: 'set.txt', bytes: 'b', mtime: when }, { path: 'none.txt', bytes: 'a' }, { path: 'late.txt', bytes: 'c', mtime: Date.UTC(2100, 0, 1) }],
      { zip64: 'always' },
    ),
  );
  const [set, none, late] = zip.entries;
  for (const extra of [set.centralExtra, set.local.extra]) {
    assert.deepEqual([...extra.keys()], [0x0001, 0x5455, 0x5855]);
    const ux = extra.get(0x5855);
    assert.equal(ux.length, 8);
    assert.equal(ux.readUInt32LE(0), when / 1000, 'access time');
    assert.equal(ux.readUInt32LE(4), when / 1000, 'modification time');
  }
  for (const entry of [none, late]) {
    assert.equal(entry.centralExtra.has(0x5855), false);
    assert.equal(entry.local.extra.has(0x5855), false);
  }
});

test('a legal 65,535-byte path 32,768 folders deep is checked in linear time', async () => {
  const deep = 'a/'.repeat(32767) + 'f';
  assert.equal(deep.length, 65535);
  const started = performance.now();
  const zip = inspect(await zipBytes([{ path: deep, bytes: 'x' }], { compression: 'store' }));
  assert.equal(zip.entries[0].name, deep);
  // A file at the deepest level where the other path needs a folder.
  await assert.rejects(zipBytes([{ path: 'a/'.repeat(32766) + 'A', bytes: 'x' }, { path: deep, bytes: 'y' }]), { code: 'path_conflict' });
  // The first version took about 5 s and 1.8 GB for one such path.
  assert.ok(performance.now() - started < 2000, `took ${Math.round(performance.now() - started)} ms`);
});

test('file/folder conflicts and duplicates are found in either order and at any depth', async () => {
  const cases = [
    ['path_conflict', [{ path: 'a/' }, { path: 'a', bytes: 'x' }]],
    ['path_conflict', [{ path: 'x/y/z.txt', bytes: 'z' }, { path: 'X/Y', bytes: 'y' }]],
    ['path_conflict', [{ path: 'x/Y/' }, { path: 'x/y', bytes: 'y' }]],
    ['duplicate_path', [{ path: 'Lib/Tracks/run.gpx', bytes: 'a' }, { path: 'lib/tracks/RUN.gpx', bytes: 'b' }]],
    ['duplicate_path', [{ path: 'x/y/' }, { path: 'X/Y/' }]],
  ];
  for (const [code, entries] of cases) {
    await assert.rejects(zipBytes(entries), { code }, JSON.stringify(entries));
  }
  await assert.rejects(zipBytes([{ path: 'Lib/Tracks/run.gpx', bytes: 'r' }, { path: 'lib/tracks', bytes: 't' }]), (error) => {
    assert.equal(error.code, 'path_conflict');
    assert.match(error.message, /"lib\/tracks" is a file, but "Lib\/Tracks\/" needs a folder/);
    return true;
  });
  // One folder spelled two ways is still one folder: nothing is lost on extraction.
  assert.equal(inspect(await zipBytes([{ path: 'A/x.txt', bytes: 'x' }, { path: 'a/y.txt', bytes: 'y' }, { path: 'a/' }])).entries.length, 3);
});

test('bytes in shared memory are copied, so compression and Blob accept them', async () => {
  const shared = new Uint8Array(new SharedArrayBuffer(4096));
  shared.set(enc.encode('shared '.repeat(600)).subarray(0, 4096));
  const chunks = await zipChunks([{ path: 'shared.txt', bytes: shared }]);
  assert.ok(chunks.every((chunk) => !(chunk.buffer instanceof SharedArrayBuffer)), 'no chunk views shared memory');
  const archive = await openZip(new Uint8Array(Buffer.concat(chunks)));
  assert.equal(archive.entries[0].method, 8);
  assert.deepEqual(await archive.entries[0].read(), new Uint8Array(shared));
});

test('names Archive Utility cannot create, or that display misleadingly, are refused', async () => {
  const refused = [
    'a͸b.gpx', // unassigned code point
    'a﷐b.gpx', // noncharacter
    'a\u0085b.gpx', // C1 control (next line)
    'track‮gpx.exe', // right-to-left override: displays as "trackexe.xpg"
    'x/⁦y.gpx', // bidirectional isolate
  ];
  for (const name of refused) {
    await assert.rejects(zipBytes([{ path: name, bytes: 'x' }]), { code: 'invalid_path' }, JSON.stringify(name));
  }
  // Joiners in emoji sequences and non-Latin scripts are ordinary names.
  const fine = ['family 👨‍👩‍👧.gpx', 'Ελληνικά/日本語.gpx', 'עברית.gpx'];
  assert.equal(inspect(await zipBytes(fine.map((p) => ({ path: p, bytes: 'x' })))).entries.length, fine.length);

  // Evidence for the unassigned case, with an archive built by the encoders directly: ditto fails on
  // the name ("Illegal byte sequence") and leaves that file out.
  if (!HAS_DITTO) return;
  const parts = [];
  const plans = [];
  let offset = 0;
  for (const [name, text] of [['ok.txt', 'ok'], ['a͸b.gpx', 'lost']]) {
    const data = enc.encode(text);
    const plan = {
      name: enc.encode(name), directory: false, method: 0, crc: crc32(data), compressedSize: data.length, uncompressedSize: data.length,
      offset, dosTime: 0, dosDate: (1 << 5) | 1, unixTime: null, sizesZip64: false, offsetZip64: false,
    };
    const local = internals.encodeLocalHeader(plan);
    parts.push(local, data);
    plans.push(plan);
    offset += local.length + data.length;
  }
  const centrals = plans.map((plan) => internals.encodeCentralHeader(plan));
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const file = writeTemp('unassigned.zip', Buffer.concat([...parts, ...centrals, internals.encodeEnd(2, centralSize, offset, false)]));
  const out = fs.mkdtempSync(path.join(tmp, 'unassigned-'));
  const result = spawnSync('ditto', ['-x', '-k', file, out], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Illegal byte sequence/);
  assert.deepEqual(fs.readdirSync(out), ['ok.txt']);
});

test('options that are not an object are refused with invalid_options', async () => {
  for (const options of [null, 'store', 42]) {
    await assert.rejects(zipBytes([], /** @type {any} */ (options)), { code: 'invalid_options' }, String(options));
  }
});

test('fuzzed names: whatever the writer accepts, Archive Utility (ditto) extracts in full', { skip: !HAS_DITTO && 'needs macOS ditto' }, async () => {
  // Families of spellings APFS treats as one name; random paths built from them collide often. On the
  // first writer this found files lost to a same-named file and folders that could not be created.
  const atoms = ['ß', 'ss', 'SS', 'ẞ', 'σ', 'ς', 'Σ', 'µ', 'μ', 'Μ', 'K', 'k', 'K', 'Å', 'Å', 'å', 'Å', 'é', 'é', 'É', 'ﬂ', 'fl', 'FL', 'x'];
  const next = mulberry32(11);
  const pick = (list) => list[Math.floor(next() * list.length)];
  const segment = () => pick(atoms) + (next() < 0.5 ? pick(atoms) : '');
  const refused = new Map();
  let accepted = 0;
  for (let round = 0; round < 120; round++) {
    const entries = [];
    for (let k = 2 + Math.floor(next() * 4); k > 0; k--) {
      const p = next() < 0.5 ? segment() : `${segment()}/${segment()}`;
      entries.push(next() < 0.2 ? { path: `${p}/` } : { path: p, bytes: `content ${round}-${k}` });
    }
    /** @type {Uint8Array} */
    let bytes;
    try {
      bytes = await zipBytes(entries);
    } catch (error) {
      assert.ok(error instanceof ZipWriteError, String(error));
      refused.set(error.code, (refused.get(error.code) ?? 0) + 1);
      continue;
    }
    accepted++;
    const file = writeTemp('fuzz-names.zip', bytes);
    const out = fs.mkdtempSync(path.join(tmp, 'fuzz-'));
    const result = spawnSync('ditto', ['-x', '-k', file, out], { encoding: 'utf8' });
    const label = JSON.stringify(entries.map((e) => e.path));
    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    for (const entry of entries) {
      const target = path.join(out, entry.path);
      if (entry.path.endsWith('/')) assert.ok(fs.statSync(target).isDirectory(), `${label}: ${entry.path}`);
      else assert.equal(fs.readFileSync(target, 'utf8'), entry.bytes, `${label}: ${entry.path}`);
    }
    fs.rmSync(out, { recursive: true });
  }
  assert.ok(accepted > 80 && refused.get('path_conflict') > 3 && refused.get('duplicate_path') > 0, JSON.stringify([accepted, [...refused]]));
});

// ---------------------------------------------------------------------------------------------
// ZipWriter: the streaming writer the export uses

/** The archive a ZipWriter makes from `entries`, with each entry's content from `content(entry)`. */
async function writerBytes(entries, options, content = (e) => e.bytes) {
  const writer = new ZipWriter(options);
  for (const e of entries) await writer.add(e.path, content(e), { mtime: e.mtime });
  return new Uint8Array(await new Blob(await writer.finish()).arrayBuffer());
}

/** `bytes` cut into pieces of 1..`most` bytes (deterministic). */
function cut(bytes, most, seed) {
  const next = mulberry32(seed);
  const pieces = [];
  for (let at = 0; at < bytes.length; ) {
    const n = 1 + Math.floor(next() * most);
    pieces.push(bytes.subarray(at, at + n));
    at += n;
  }
  return pieces;
}

async function* later(pieces, ms = 0) {
  for (const piece of pieces) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    yield piece;
  }
}

test('ZipWriter, content given whole: the same bytes as zipBytes, stored, deflated and with ZIP64 forced', async () => {
  const entries = [
    ...sampleEntries(),
    { path: 'big/text.gpx', bytes: syntheticGpx(30000, 4) }, // more than 1 MiB
    { path: 'big/random.bin', bytes: randomBytes(1.5 * 2 ** 20, 5) }, // incompressible: stored
  ];
  for (const compression of ['auto', 'store']) {
    for (const zip64 of ['auto', 'always']) {
      const want = await zipBytes(entries, { compression, zip64 });
      const got = await writerBytes(entries, { compression, zip64 });
      assert.ok(Buffer.compare(Buffer.from(got), Buffer.from(want)) === 0, `${compression}/${zip64}`);
    }
  }
});

test('ZipWriter, content in pieces: sync and async, text and bytes, split pairs; inflates, reads back, passes unzip -t', async () => {
  const smile = '\u{1F600}';
  const long = syntheticGpx(40000, 6); // about 3 MB: deflated as a stream
  const files = [
    { path: 'Tracks/long.gpx', text: long, pieces: () => long.match(/[^]{1,5000}/g) },
    { path: 'Tracks/mixed.gpx', text: `ab${smile}cd`, pieces: () => ['ab', enc.encode(smile), 'cd'] },
    // A surrogate pair split between two pieces, at a text-batch boundary and in the middle of one.
    { path: 'Ünïcödé/pair.txt', text: 'x'.repeat(65535) + smile + 'y', pieces: () => ['x'.repeat(65535) + smile[0], smile[1] + 'y'] },
    { path: 'pair2.txt', text: `a${smile}b`, pieces: () => [`a${smile[0]}`, `${smile[1]}b`] },
    { path: 'async.gpx', text: syntheticGpx(300, 7), pieces: () => later(syntheticGpx(300, 7).match(/[^]{1,700}/g)) },
    { path: 'empty.gpx', text: '', pieces: () => [] },
    { path: 'empty-pieces.gpx', text: '', pieces: () => ['', new Uint8Array(0), ''] },
    { path: 'bytes.bin', bytes: randomBytes(70000, 8), pieces: () => cut(randomBytes(70000, 8), 9000, 1) },
  ];
  const writer = new ZipWriter();
  assert.equal(writer.deflates, true);
  for (const f of files) await writer.add(f.path, f.pieces(), { mtime: Date.UTC(2026, 9, 6) });
  const bytes = new Uint8Array(await new Blob(await writer.finish()).arrayBuffer());
  const contentOfFile = (f) => f.bytes ?? enc.encode(f.text);

  const { entries } = inspect(bytes);
  assert.deepEqual(entries.map((e) => e.name), files.map((f) => f.path));
  entries.forEach((e, i) => {
    const want = contentOfFile(files[i]);
    assert.equal(e.uncompressedSize, want.length, e.name);
    assert.equal(e.crc, crc32(want), e.name);
    assert.equal(e.local.crc, e.crc, e.name);
    assert.deepEqual(e.method === 8 ? new Uint8Array(zlib.inflateRawSync(e.data)) : new Uint8Array(e.data), want, e.name);
  });
  assert.equal(entries[0].method, 8, 'the long text is deflated');
  assert.equal(entries[5].method, 0, 'an empty file is stored');
  assert.equal(entries[7].method, 0, 'random bytes under 1 MiB are stored, as zipChunks would');

  const archive = await openZip(bytes);
  assert.deepEqual(archive.problems, []);
  for (const [i, entry] of archive.entries.entries()) assert.deepEqual(await entry.read(), contentOfFile(files[i]));

  // Content under 1 MiB in pieces is decided exactly as zipChunks decides for the whole content.
  const small = files.slice(1);
  const whole = await zipBytes(small.map((f) => ({ path: f.path, bytes: contentOfFile(f) })));
  const pieced = await writerBytes(small, {}, (f) => (f.path === 'async.gpx' ? later(f.text.match(/[^]{1,700}/g)) : f.pieces()));
  assert.ok(Buffer.compare(Buffer.from(pieced), Buffer.from(whole)) === 0, 'small pieced entries match zipBytes');

  if (!HAS_INFOZIP) return;
  const file = writeTemp('pieces.zip', bytes);
  const check = run('unzip', ['-t', file]);
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /No errors detected in compressed data/);
});

test('ZipWriter: a stream past 1 MiB is deflated even when that does not help, because its bytes are not kept', async () => {
  const random = randomBytes(3 * 2 ** 20, 9);
  const writer = new ZipWriter();
  await writer.add('random.bin', cut(random, 70000, 2));
  const bytes = new Uint8Array(await new Blob(await writer.finish()).arrayBuffer());
  const [e] = inspect(bytes).entries;
  assert.equal(e.method, 8);
  assert.ok(e.compressedSize < random.length * 1.001 + 64, `${e.compressedSize} for ${random.length}`);
  assert.deepEqual(new Uint8Array(zlib.inflateRawSync(e.data)), random);
  assert.equal(e.crc, crc32(random));
});

test('ZipWriter: entries filled at the same time keep the order of add()', async () => {
  const writer = new ZipWriter();
  const slow = writer.add('a-slow.txt', later(['slow ', 'pieces ', 'arrive ', 'late'], 15));
  const fast = writer.add('b-fast.txt', ['fast']);
  const dir = writer.add('c/');
  let fastFirst = false;
  await fast;
  fastFirst = (await Promise.race([slow.then(() => 'slow'), Promise.resolve('pending')])) === 'pending';
  await Promise.all([slow, dir]);
  const bytes = new Uint8Array(await new Blob(await writer.finish()).arrayBuffer());
  const { entries } = inspect(bytes);
  assert.ok(fastFirst, 'the second entry finished first');
  assert.deepEqual(entries.map((e) => e.name), ['a-slow.txt', 'b-fast.txt', 'c/']);
  assert.equal(new TextDecoder().decode(entries[0].method === 8 ? zlib.inflateRawSync(entries[0].data) : entries[0].data), 'slow pieces arrive late');
  for (let i = 1; i < entries.length; i++) assert.ok(entries[i].offset > entries[i - 1].offset);
});

test('ZipWriter refuses what zipChunks refuses, with the same codes, and stays usable after a refusal', async () => {
  const cases = [
    [[{ path: 'a.txt', bytes: 'x' }, { path: 'a.txt', bytes: 'y' }], 'duplicate_path'],
    [[{ path: 'Straße.txt', bytes: 'x' }, { path: 'STRASSE.txt', bytes: 'y' }], 'duplicate_path'],
    [[{ path: 'dir/' }, { path: 'dir/' }], 'duplicate_path'],
    [[{ path: 'a', bytes: 'x' }, { path: 'a/b.txt', bytes: 'y' }], 'path_conflict'],
    [[{ path: 'a/b.txt', bytes: 'y' }, { path: 'a', bytes: 'x' }], 'path_conflict'],
    [[{ path: 'A/b/c.txt', bytes: 'y' }, { path: 'a/B', bytes: 'x' }], 'path_conflict'],
    [[{ path: 'a/' }, { path: 'a', bytes: 'x' }], 'path_conflict'],
    [[{ path: 'a', bytes: 'x' }, { path: 'a/' }], 'path_conflict'],
    [[{ path: '../evil.txt', bytes: 'x' }], 'invalid_path'],
    [[{ path: '/abs.txt', bytes: 'x' }], 'invalid_path'],
    [[{ path: 'x'.repeat(70000), bytes: 'x' }], 'invalid_path'],
    [[{ path: 'bad\u0001.txt', bytes: 'x' }], 'invalid_path'],
    [[{ path: 'f.txt', bytes: 'x', mtime: NaN }], 'invalid_mtime'],
    [[{ path: 'd/', bytes: 'content' }], 'invalid_bytes'],
    [[{ path: 'f.txt', bytes: 42 }], 'invalid_bytes'],
    [[{ path: 'f.txt' }], 'invalid_bytes'],
    [[{ path: 'f.txt', bytes: '\uD800' }], 'invalid_bytes'],
  ];
  for (const [entries, code] of cases) {
    const label = JSON.stringify(entries.map((e) => e.path.slice(0, 20)));
    await assert.rejects(zipBytes(entries), { code }, `zipChunks ${label}`);
    await assert.rejects(writerBytes(entries), { code, name: 'ZipWriteError' }, `ZipWriter ${label}`);
  }
  // Pieces that are not text or bytes, a lone surrogate at the end of the text, content that is not iterable.
  for (const content of [[1, 2], ['ok', null], ['a\uD83D'], ['\uDE00b'], { length: 3 }, 7]) {
    const writer = new ZipWriter();
    await assert.rejects(writer.add('f.txt', /** @type {any} */ (content)), { code: 'invalid_bytes' }, JSON.stringify(content));
  }
  assert.throws(() => new ZipWriter(/** @type {any} */ ('store')), { code: 'invalid_options' });
  assert.throws(() => new ZipWriter({ compression: /** @type {any} */ ('zstd') }), { code: 'invalid_options' });

  // A refused path takes no place and leaves the tree as it was.
  const writer = new ZipWriter();
  await writer.add('k/file.txt', 'one');
  await assert.rejects(writer.add('k/file.txt/inner.txt', 'no'), { code: 'path_conflict' });
  await assert.rejects(writer.add('K/FILE.TXT', 'no'), { code: 'duplicate_path' });
  await assert.rejects(writer.add('z/', undefined, /** @type {any} */ (null)), { code: 'invalid_options' });
  await writer.add('k/other/', undefined);
  await writer.add('z/zz.txt', 'two');
  const { entries } = inspect(new Uint8Array(await new Blob(await writer.finish()).arrayBuffer()));
  assert.deepEqual(entries.map((e) => e.name), ['k/file.txt', 'k/other/', 'z/zz.txt']);
  await assert.rejects(writer.add('late.txt', 'x'), { code: 'invalid_options' });
  await assert.rejects(writer.finish(), { code: 'invalid_options' });
});

test('ZipWriter: content that fails mid-way rejects add() and finish() with that error, and nothing is left unhandled', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const boom = new Error('the content failed');
    const writer = new ZipWriter();
    const good = writer.add('good.gpx', later([syntheticGpx(5000, 1)], 5));
    const bad = writer.add('bad.gpx', (function* () {
      yield syntheticGpx(30000, 2); // past 1 MiB, so a compressor is running when it fails
      throw boom;
    })());
    await assert.rejects(bad, (error) => error === boom);
    await good;
    await assert.rejects(writer.add('after.txt', 'x'), (error) => error === boom);
    await assert.rejects(writer.finish(), (error) => error === boom);
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

/**
 * Installs a CompressionStream whose 'gzip' output is made by node:zlib, rewritten by `edit`, and delivered in
 * pieces of the given sizes (the rest in one piece); other formats use the real class. Returns a restore function.
 */
function fakeGzip(edit, sizes) {
  const Real = globalThis.CompressionStream;
  globalThis.CompressionStream = class {
    constructor(format) {
      if (format !== 'gzip') return new Real(format);
      const input = [];
      const { readable, writable } = new TransformStream({
        transform(chunk) {
          input.push(Buffer.from(chunk));
        },
        flush(controller) {
          const out = edit(zlib.gzipSync(Buffer.concat(input)));
          let at = 0;
          for (const n of sizes(out.length)) {
            controller.enqueue(new Uint8Array(out.subarray(at, at + n)));
            at += n;
          }
          if (at < out.length) controller.enqueue(new Uint8Array(out.subarray(at)));
        },
      });
      this.readable = readable;
      this.writable = writable;
    }
  };
  return () => {
    globalThis.CompressionStream = Real;
  };
}

/** A gzip member with every optional header field (RFC 1952 FEXTRA, FNAME, FCOMMENT, FHCRC). */
function withAllHeaderFields(gz) {
  const head = Buffer.from(gz.subarray(0, 10));
  head[3] = 0x04 | 0x08 | 0x10 | 0x02;
  const extra = Buffer.from([5, 0, 1, 2, 3, 4, 5]); // XLEN 5, then 5 bytes
  return Buffer.concat([head, extra, Buffer.from('name.gpx\0comment\0'), Buffer.from([0xab, 0xcd]), gz.subarray(10)]);
}

test('ZipWriter: a gzip header with every optional field, a byte at a time, and a trailer split over pieces still give the right ZIP', async () => {
  const entries = [{ path: 'a.gpx', bytes: syntheticGpx(3000, 3) }, { path: 'b.txt', bytes: 'short text, short text, short text' }];
  const want = await zipBytes(entries);
  // 40 one-byte pieces (the whole header, one byte at a time), then 1000 bytes, the rest, and the last 10 bytes as
  // 5+1+4 (2 bytes of data and 3 of the trailer, then the rest of the trailer); a short output goes a byte at a time.
  const sizes = (/** @type {number} */ n) => (n > 2000 ? [...Array(40).fill(1), 1000, n - 40 - 1000 - 10, 5, 1, 4] : Array(n).fill(1));
  const restore = fakeGzip(withAllHeaderFields, sizes);
  try {
    const got = await writerBytes(entries, {}, (e) => cut(enc.encode(e.bytes), 4000, 4));
    assert.ok(Buffer.compare(Buffer.from(got), Buffer.from(want)) === 0);
  } finally {
    restore();
  }
});

test('ZipWriter: a compressor that writes a wrong header, length or too little fails with compression_failed', async () => {
  const text = syntheticGpx(2000, 5);
  const broken = [
    ['not gzip', (gz) => Buffer.concat([Buffer.from([0x1f, 0x8c]), gz.subarray(2)])],
    ['reserved flags', (gz) => Buffer.concat([gz.subarray(0, 3), Buffer.from([0x80]), gz.subarray(4)])],
    ['wrong length', (gz) => Buffer.concat([gz.subarray(0, gz.length - 4), Buffer.from([1, 2, 3, 4])])],
    ['ends early', (gz) => gz.subarray(0, 14)],
    ['header never ends', (gz) => Buffer.concat([gz.subarray(0, 3), Buffer.from([0x08]), gz.subarray(4, 10), Buffer.alloc(70000, 0x41)])],
  ];
  for (const [label, edit] of broken) {
    const restore = fakeGzip(edit, () => []);
    try {
      const writer = new ZipWriter();
      await assert.rejects(writer.add('t.gpx', [text]), { code: 'compression_failed' }, label);
      await assert.rejects(writer.finish(), { code: 'compression_failed' }, label);
    } finally {
      restore();
    }
  }
});

test('ZipWriter without CompressionStream (Safari before 16.4) stores everything, the same bytes as zipBytes', () => {
  const moduleUrl = new URL('../src/export/zip.js', import.meta.url).href;
  const code =
    'delete globalThis.CompressionStream;' +
    `const { ZipWriter, zipBytes } = await import(${JSON.stringify(moduleUrl)});` +
    "const entries = [{ path: 'd/' }, { path: 'd/a.txt', bytes: 'abc '.repeat(5000) }, { path: 'b.txt', bytes: 'x' }];" +
    'const writer = new ZipWriter();' +
    "for (const e of entries) await writer.add(e.path, e.bytes === undefined ? undefined : [e.bytes.slice(0, 7), e.bytes.slice(7)]);" +
    'const got = new Uint8Array(await new Blob(await writer.finish()).arrayBuffer());' +
    'const want = await zipBytes(entries);' +
    "process.stdout.write(JSON.stringify({ deflates: writer.deflates, same: Buffer.compare(Buffer.from(got), Buffer.from(want)) === 0, methods: [...got].length }));";
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.deflates, false);
  assert.equal(out.same, true);
});
