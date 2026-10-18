// Tests for src/format/container.js. All bytes are synthetic and built here from FORMAT.md §3.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  readContainer,
  readHeader,
  classifyVersion,
  ContainerRecord,
  DEFAULT_LIMITS,
  KNOWN_RECORD_TYPES,
  PROBLEM_CODES,
  PROGRAM_VERSION_MAC48,
  programFamily,
  chooseLayout,
} from '../src/format/container.js';

// ---------------------------------------------------------------------------------------------
// Byte builders (test-only)

class Bytes {
  constructor() {
    /** @type {number[]} */
    this.out = [];
  }
  u8(v) {
    this.out.push(v & 0xff);
    return this;
  }
  u16(v) {
    this.out.push(v & 0xff, (v >>> 8) & 0xff);
    return this;
  }
  u32(v) {
    this.out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  ascii(s) {
    for (const ch of s) this.out.push(ch.charCodeAt(0));
    return this;
  }
  cstr(s) {
    for (const b of new TextEncoder().encode(s)) this.out.push(b);
    this.out.push(0);
    return this;
  }
  raw(bytes) {
    for (const b of bytes) this.out.push(b);
    return this;
  }
  build() {
    return Uint8Array.from(this.out);
  }
}

/**
 * @param {object} [o]
 * @returns {Uint8Array}
 */
function header(o = {}) {
  const { sig = 'MsRc', primary = 0x66, version = 188, program = 407, builder = 'bcr-fixture', date = 'Jan 01 2026', time = '00:00:00', app = 'BaseCamp' } = o;
  const authorBody = new Bytes().u16(program).cstr(builder).cstr(date).cstr(time).build();
  return new Bytes()
    .ascii(sig)
    .u16(primary)
    .u32(2)
    .ascii('D')
    .u16(version)
    .u32(authorBody.length)
    .ascii('A')
    .raw(authorBody)
    .cstr(app)
    .build();
}

/**
 * @param {string|number} type
 * @param {Uint8Array|number[]} body
 */
function rec(type, body) {
  const b = new Bytes().u32(body.length);
  if (typeof type === 'number') b.u8(type);
  else b.ascii(type);
  return b.raw(body).build();
}

/** @param {...Uint8Array} parts */
function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const V_RECORD = rec('V', [0x00, 0x01]);
const E_RECORD = rec('E', [0, 0, 0, 0]);
const X_RECORD = rec('X', new Bytes().cstr('EndOfFile').build());

/** A deterministic PRNG (mulberry32) for the fuzz tests. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {string} code */
const codes = (result) => result.problems.map((p) => p.code);
/** @param {ReturnType<typeof readContainer>} result @param {string} code */
const problem = (result, code) => result.problems.find((p) => p.code === code);

// ---------------------------------------------------------------------------------------------
// Header

test('reads a well-formed AllData.gdb header', () => {
  const h = header();
  const r = readHeader(h);
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'gdb');
  assert.equal(r.signature, 'MsRc');
  assert.equal(r.signatureHex, '4D735263');
  assert.equal(r.primaryFormat, 0x66);
  assert.equal(r.formatVersion, 188);
  assert.equal(r.versionClass, 'supported');
  assert.equal(r.programVersion, 407);
  assert.equal(r.application, 'BaseCamp');
  assert.equal(r.authorRecordAsExpected, true);
  assert.equal(r.bodyStart, h.length);
  assert.equal(r.stopped, null);
  assert.deepEqual(r.problems, []);
});

test('the header example in FORMAT.md §12 parses to the documented values', () => {
  // Byte for byte as printed in FORMAT.md §12.
  const hexText =
    '4D 73 52 63 66 00 02 00 00 00 44 BC 00 23 00 00 00 41 97 01 62 63 72 2D 66 69 78 74 75 72 65 00 ' +
    '4A 61 6E 20 30 31 20 32 30 32 36 00 30 30 3A 30 30 3A 30 30 00 42 61 73 65 43 61 6D 70 00';
  const bytes = Uint8Array.from(hexText.split(' ').map((h) => parseInt(h, 16)));
  assert.deepEqual(bytes, header());
  const r = readHeader(bytes, { role: 'gdb' });
  assert.equal(r.ok, true);
  assert.equal(r.formatVersion, 188);
  assert.equal(r.programVersion, 407);
  assert.equal(r.bodyStart, bytes.length);
});

test('reads a FolderData.gfi header and enforces the role', () => {
  const gfi = header({ sig: 'DifG' });
  assert.equal(readHeader(gfi).kind, 'gfi');
  assert.equal(readHeader(gfi, { role: 'gfi' }).ok, true);
  const wrong = readHeader(gfi, { role: 'gdb' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.stopped, 'wrong_file_kind');
  assert.equal(wrong.signature, 'DifG');
  const wrong2 = readHeader(header(), { role: 'gfi' });
  assert.equal(wrong2.stopped, 'wrong_file_kind');
  assert.deepEqual(codes(wrong2), ['wrong_file_kind']);
});

test('TrackSegments role accepts any signature and records it', () => {
  const h = header({ sig: 'Zz9!' });
  const r = readHeader(h, { role: 'tracksegments' });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'tracksegments');
  assert.equal(r.signature, null);
  assert.equal(r.signatureHex, '5A7A3921');
  assert.equal(r.bodyStart, h.length);
  assert.equal(readHeader(header(), { role: 'tracksegments' }).signature, 'MsRc');
  // Any other role rejects the unknown signature as "not a library file".
  assert.equal(readHeader(h).stopped, 'not_library_file');
});

test('every file shorter than 18 bytes is "not a library file", with what could be read', () => {
  const full = header();
  for (let n = 0; n < 18; n++) {
    const r = readHeader(full.subarray(0, n));
    assert.equal(r.ok, false, `length ${n}`);
    assert.equal(r.stopped, 'not_library_file');
    assert.equal(r.signatureHex, n >= 4 ? '4D735263' : null);
    assert.equal(r.primaryFormat, n >= 6 ? 0x66 : null);
    assert.equal(r.formatVersion, n >= 13 ? 188 : null);
    assert.equal(r.bodyStart, 0);
  }
});

test('a primary format other than 0x0066 is not a library file, and the value is reported', () => {
  for (const primary of [0x64, 0x65, 0x67, 0x6600]) {
    const r = readHeader(header({ primary }));
    assert.equal(r.ok, false);
    assert.equal(r.stopped, 'not_library_file');
    assert.equal(r.primaryFormat, primary);
  }
});

test("a 'D' record with the wrong length or type is an unreadable header", () => {
  const h = header();
  const badLen = h.slice();
  badLen[6] = 3;
  assert.equal(readHeader(badLen).stopped, 'bad_header');
  assert.equal(readHeader(badLen).formatVersion, null);
  const badType = h.slice();
  badType[10] = 0x45;
  assert.equal(readHeader(badType).stopped, 'bad_header');
});

test("the 'A' record must be type 'A', at least 2 bytes long, and fit in the file", () => {
  const h = header();
  const badType = h.slice();
  badType[17] = 0x42;
  assert.equal(readHeader(badType).stopped, 'bad_header');
  assert.equal(readHeader(badType).programVersion, null);

  const short = h.slice();
  new DataView(short.buffer).setUint32(13, 1, true);
  assert.equal(readHeader(short).stopped, 'bad_header');

  const huge = h.slice();
  new DataView(huge.buffer).setUint32(13, 0xffffffff, true);
  assert.equal(readHeader(huge).stopped, 'bad_header');

  const pastEnd = h.slice();
  new DataView(pastEnd.buffer).setUint32(13, h.length - 18 + 1, true);
  assert.equal(readHeader(pastEnd).stopped, 'bad_header');
});

test("build strings that do not end exactly at the 'A' record's end are counted, and reading continues at 18 + L_A", () => {
  // Two strings instead of three, then the application name.
  const authorBody = new Bytes().u16(407).cstr('one').cstr('two').build();
  const h = new Bytes().ascii('MsRc').u16(0x66).u32(2).ascii('D').u16(188).u32(authorBody.length).ascii('A').raw(authorBody).cstr('BaseCamp').build();
  const r = readHeader(h);
  assert.equal(r.ok, true);
  assert.equal(r.authorRecordAsExpected, false);
  assert.equal(r.programVersion, 407);
  assert.equal(r.application, 'BaseCamp');
  assert.equal(r.bodyStart, h.length);
  assert.deepEqual(codes(r), ['author_record_unexpected']);

  // Four strings: also not as expected. Minimal 'A' record (version only): not as expected either.
  const four = new Bytes().u16(407).cstr('a').cstr('b').cstr('c').cstr('d').build();
  const h4 = new Bytes().ascii('MsRc').u16(0x66).u32(2).ascii('D').u16(188).u32(four.length).ascii('A').raw(four).cstr('BaseCamp').build();
  assert.equal(readHeader(h4).authorRecordAsExpected, false);
  const two = new Bytes().ascii('MsRc').u16(0x66).u32(2).ascii('D').u16(188).u32(2).ascii('A').u16(480).cstr('BaseCamp').build();
  const r2 = readHeader(two);
  assert.equal(r2.ok, true);
  assert.equal(r2.programVersion, 480);
  assert.equal(r2.authorRecordAsExpected, false);
});

test('the application name: the three known names, "other", and the 64-byte cap', () => {
  for (const app of ['BaseCamp', 'MapSource', 'HomePort']) assert.equal(readHeader(header({ app })).application, app);
  assert.equal(readHeader(header({ app: 'basecamp' })).application, 'other');
  assert.equal(readHeader(header({ app: '' })).application, 'other');
  assert.equal(readHeader(header({ app: 'x'.repeat(63) })).ok, true);
  const tooLong = readHeader(header({ app: 'x'.repeat(64) }));
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.stopped, 'bad_header');
  // No NUL before the end of the file.
  const h = header();
  assert.equal(readHeader(h.subarray(0, h.length - 1)).stopped, 'bad_header');
});

test('program versions are reported raw and never change how the header is read', () => {
  for (const program of [402, 407, 408, 480, 4813, 0, 0xffff]) {
    const r = readHeader(header({ program }));
    assert.equal(r.ok, true);
    assert.equal(r.programVersion, program);
  }
});

test('classifyVersion follows FORMAT.md §4 on raw integers', () => {
  const cases = [
    [107, 'exported'], [108, 'exported'], [109, 'exported'],
    [115, 'too_old'], [138, 'too_old'],
    [146, 'experimental'], [187, 'experimental'], [189, 'experimental'], [403, 'experimental'], [0xffff, 'experimental'],
    [188, 'supported'],
    [0, 'unknown'], [106, 'unknown'], [110, 'unknown'], [114, 'unknown'], [139, 'unknown'], [145, 'unknown'],
    [-1, 'unknown'], [0x10000, 'unknown'], [1.5, 'unknown'], [NaN, 'unknown'], [null, 'unknown'], [undefined, 'unknown'], ['188', 'unknown'],
  ];
  for (const [v, want] of cases) assert.equal(classifyVersion(/** @type {any} */ (v)), want, String(v));
  assert.equal(readHeader(header({ version: 109 })).versionClass, 'exported');
});

test('API misuse throws a TypeError; bad data never throws', () => {
  assert.throws(() => readContainer(/** @type {any} */ ('text')), TypeError);
  assert.throws(() => readContainer(/** @type {any} */ (null)), TypeError);
  assert.throws(() => readHeader(/** @type {any} */ ([1, 2, 3])), TypeError);
  assert.throws(() => readContainer(header(), /** @type {any} */ ({ role: 'zip' })), TypeError);
  assert.throws(() => readContainer(header(), { role: 'tracksegments' }), TypeError);
  assert.throws(() => readContainer(header(), { limits: { maxRecords: -1 } }), TypeError);
  assert.throws(() => readContainer(header(), { limits: { maxRecordBytes: 1.5 } }), TypeError);
  assert.throws(() => readContainer(header(), /** @type {any} */ ({ limits: 5 })), TypeError);
  assert.throws(() => readContainer(header(), /** @type {any} */ ({ onRecord: 5 })), TypeError);
  const empty = readContainer(new Uint8Array(0));
  assert.equal(empty.ok, false);
  assert.equal(empty.complete, false);
  assert.deepEqual(empty.records, []);
});

// ---------------------------------------------------------------------------------------------
// Records

test('frames records, keeps type, offsets and length, and resumes at bodyStart + len', () => {
  const h = header();
  const w = rec('W', [1, 2, 3]);
  const t = rec('T', [9, 8, 7, 6, 5, 4]);
  const file = concat(h, w, t, V_RECORD, E_RECORD, X_RECORD);
  const r = readContainer(file, { role: 'gdb' });
  assert.equal(r.complete, true);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.records.map((x) => x.type), ['W', 'T', 'V', 'E', 'X']);
  assert.deepEqual(r.records.map((x) => x.typeCode), [0x57, 0x54, 0x56, 0x45, 0x58]);
  assert.equal(r.records[0].offset, h.length);
  assert.equal(r.records[0].bodyOffset, h.length + 5);
  assert.equal(r.records[0].length, 3);
  assert.deepEqual([...r.records[0].body], [1, 2, 3]);
  assert.equal(r.records[1].offset, h.length + w.length);
  assert.deepEqual([...r.records[1].body], [9, 8, 7, 6, 5, 4]);
  assert.equal(r.recordCount, 5);
  assert.equal(r.end.present, true);
  assert.equal(r.end.offset, file.length - X_RECORD.length);
  assert.equal(r.end.bytesAfter, 0);
  assert.equal(r.endOffset, file.length);
  assert.ok(r.records[0] instanceof ContainerRecord);
});

test('record bodies are views over the input buffer, never copies', () => {
  const backing = new Uint8Array(4096);
  const file = concat(header(), rec('W', [1, 2, 3, 4]), rec('T', new Uint8Array(100).fill(7)));
  backing.set(file, 123);
  const input = backing.subarray(123, 123 + file.length);
  const r = readContainer(input);
  assert.equal(r.records.length, 2);
  for (const record of r.records) {
    const body = record.body;
    assert.equal(body.buffer, backing.buffer);
    assert.equal(body.byteOffset, 123 + record.bodyOffset);
    assert.equal(body.length, record.length);
  }
  // Writing through the input shows up in the body: the same memory.
  backing[123 + r.records[0].bodyOffset] = 0xee;
  assert.equal(r.records[0].body[0], 0xee);
});

test('a 64 MiB record is handed out as a view, in milliseconds', () => {
  const h = header();
  const bodyLength = 64 * 2 ** 20;
  const file = new Uint8Array(h.length + 5 + bodyLength + X_RECORD.length);
  file.set(h);
  new DataView(file.buffer).setUint32(h.length, bodyLength, true);
  file[h.length + 4] = 0x54; // 'T'
  file.set(X_RECORD, h.length + 5 + bodyLength);
  const started = performance.now();
  const r = readContainer(file);
  const elapsed = performance.now() - started;
  assert.deepEqual(r.records.map((x) => [x.type, x.length]), [['T', bodyLength], ['X', 10]]);
  assert.equal(r.records[0].body.buffer, file.buffer);
  assert.equal(r.complete, true);
  assert.ok(elapsed < 1000, `took ${elapsed} ms`);
});

test('an ArrayBuffer input is wrapped without copying', () => {
  const file = concat(header(), rec('W', [5, 6]));
  const r = readContainer(file.buffer);
  assert.equal(r.records[0].body.buffer, file.buffer);
});

test('a serialised record carries no bytes', () => {
  const r = readContainer(concat(header(), rec('W', new Bytes().cstr('Zq-private-name').build())));
  const json = JSON.stringify(r.records);
  assert.ok(!json.includes('"body"'));
  assert.ok(!json.includes('Zq'));
  assert.deepEqual(Object.keys(JSON.parse(json)[0]).sort(), ['bodyOffset', 'length', 'offset', 'type', 'typeCode']);
});

test("reading does not stop at 'V' (FORMAT.md §3.3 rule 4)", () => {
  const r = readContainer(concat(header(), rec('W', [1]), V_RECORD, rec('W', [2]), rec('W', [3])));
  assert.deepEqual(r.records.map((x) => x.type), ['W', 'V', 'W', 'W']);
  assert.equal(r.complete, true);
  assert.equal(r.end.present, false);
});

test("an 'X' record ends reading; bytes after it are counted and never framed", () => {
  const after = rec('W', [1, 2, 3]);
  const file = concat(header(), rec('W', [1]), X_RECORD, after);
  const r = readContainer(file);
  assert.deepEqual(r.records.map((x) => x.type), ['W', 'X']);
  assert.equal(r.end.present, true);
  assert.equal(r.end.bytesAfter, after.length);
  assert.equal(r.complete, true);
  const p = problem(r, 'data_after_end');
  assert.equal(p.count, 1);
  assert.match(p.message, new RegExp(`goes on for ${after.length} bytes`));
});

test("EOF without an 'X' record is normal", () => {
  const r = readContainer(concat(header(), rec('W', [1]), V_RECORD, E_RECORD));
  assert.equal(r.end.present, false);
  assert.equal(r.complete, true);
  assert.deepEqual(r.problems, []);
});

test('a GFI is read to EOF the same way', () => {
  const r = readContainer(concat(header({ sig: 'DifG' }), rec('F', [1, 2]), rec('I', [3]), rec('T', [4]), rec('W', [5])), { role: 'gfi' });
  assert.equal(r.kind, 'gfi');
  assert.deepEqual(r.records.map((x) => x.type), ['F', 'I', 'T', 'W']);
  assert.equal(r.complete, true);
});

test('a header with no records reads as complete and empty', () => {
  const r = readContainer(header());
  assert.equal(r.complete, true);
  assert.equal(r.recordCount, 0);
  assert.equal(r.endOffset, header().length);
});

test('a record whose length runs past the end: truncated, earlier records kept', () => {
  const h = header();
  const good = rec('W', [1, 2]);
  const bad = rec('T', new Uint8Array(50));
  const file = concat(h, good, bad).subarray(0, h.length + good.length + bad.length - 1);
  const r = readContainer(file);
  assert.equal(r.records.length, 1);
  assert.equal(r.complete, false);
  assert.equal(r.stopped, 'record_truncated');
  assert.deepEqual(codes(r), ['record_truncated']);
  assert.equal(r.endOffset, h.length + good.length);
});

test('a record length larger than the whole file is impossible', () => {
  const file = concat(header(), rec('W', [1]), new Bytes().u32(0xfffffff0).ascii('W').raw([1, 2, 3]).build());
  const r = readContainer(file);
  assert.equal(r.records.length, 1);
  assert.equal(r.stopped, 'record_length_impossible');
  assert.equal(r.complete, false);
});

test('one to four non-zero bytes after the last record are a truncated frame', () => {
  for (let n = 1; n <= 4; n++) {
    const file = concat(header(), rec('W', [1]), new Uint8Array(n).fill(0x41));
    const r = readContainer(file);
    assert.equal(r.records.length, 1);
    assert.equal(r.stopped, 'record_truncated', `n=${n}`);
  }
});

test('zero-length records are kept with an empty body and counted', () => {
  const r = readContainer(concat(header(), rec('W', []), rec('T', []), rec('W', [1])));
  assert.equal(r.records.length, 3);
  assert.equal(r.records[0].body.length, 0);
  assert.equal(problem(r, 'empty_record').count, 2);
  assert.equal(r.complete, true);
});

test('a zero-filled tail is one padding problem, not millions of records', () => {
  for (const zeros of [1, 4, 5, 7, 10, 1000, 16 * 2 ** 20 + 3]) {
    const file = concat(header(), rec('W', [1]), new Uint8Array(zeros));
    const r = readContainer(file);
    assert.equal(r.records.length, 1, `zeros=${zeros}`);
    assert.equal(r.complete, true);
    assert.equal(r.zeroBytes, zeros);
    const p = problem(r, 'zero_padding');
    assert.equal(p.count, 1);
    assert.match(p.message, new RegExp(`^${zeros} bytes of zeros`));
  }
});

test('zeros in the middle are skipped frame by frame and later records are read', () => {
  const file = concat(header(), rec('W', [1]), new Uint8Array(15), rec('T', [2]), new Uint8Array(5), rec('R', [3]));
  const r = readContainer(file);
  assert.deepEqual(r.records.map((x) => x.type), ['W', 'T', 'R']);
  assert.equal(r.zeroBytes, 20);
  assert.equal(problem(r, 'zero_padding').count, 2);
  assert.equal(r.complete, true);
});

test('unknown record types are counted, kept and skipped by their length', () => {
  const r = readContainer(concat(header(), rec('Q', [1, 2]), rec(0xc3, [3]), rec(0x00, [4]), rec('W', [5])));
  assert.deepEqual(r.records.map((x) => x.typeCode), [0x51, 0xc3, 0x00, 0x57]);
  assert.equal(problem(r, 'unknown_record_type').count, 3);
  assert.equal(r.complete, true);
  assert.deepEqual([...r.records[3].body], [5]);
});

test('every type FORMAT.md §3.2 lists is known', () => {
  assert.deepEqual([...KNOWN_RECORD_TYPES].sort(), ['A', 'C', 'D', 'E', 'F', 'G', 'I', 'J', 'K', 'L', 'O', 'R', 'T', 'V', 'W', 'X', 'j'].sort());
  const r = readContainer(concat(header(), ...KNOWN_RECORD_TYPES.filter((t) => t !== 'X').map((t) => rec(t, [1]))));
  assert.equal(problem(r, 'unknown_record_type'), undefined);
});

test('a record over maxRecordBytes is skipped and counted; reading continues after it', () => {
  const file = concat(header(), rec('T', new Uint8Array(1000)), rec('W', [1]), rec('T', new Uint8Array(10)));
  const r = readContainer(file, { limits: { maxRecordBytes: 100 } });
  assert.deepEqual(r.records.map((x) => [x.type, x.length]), [['W', 1], ['T', 10]]);
  assert.equal(problem(r, 'record_too_large').count, 1);
  assert.equal(r.complete, true);
  assert.equal(DEFAULT_LIMITS.maxRecordBytes, 256 * 2 ** 20);
});

test('maxRecords stops reading with a counted problem that names the limit', () => {
  const parts = [header()];
  for (let i = 0; i < 20; i++) parts.push(rec('W', [i]));
  const r = readContainer(concat(...parts), { limits: { maxRecords: 7 } });
  assert.equal(r.records.length, 7);
  assert.equal(r.recordCount, 7);
  assert.equal(r.complete, false);
  assert.equal(r.stopped, 'too_many_records');
  assert.match(problem(r, 'too_many_records').message, /limit of 7\./);
});

test('a hostile file of empty records is bounded by maxRecords, quickly', () => {
  const n = 300_000;
  const h = header();
  const file = new Uint8Array(h.length + n * 5);
  file.set(h);
  for (let i = 0; i < n; i++) file[h.length + i * 5 + 4] = 0x57; // len 0, type 'W'
  const started = performance.now();
  const r = readContainer(file, { limits: { maxRecords: 100_000 } });
  assert.equal(r.records.length, 100_000);
  assert.equal(r.stopped, 'too_many_records');
  assert.ok(performance.now() - started < 5000);
});

test('onRecord streams records without keeping them; its exceptions are the caller\'s', () => {
  const file = concat(header(), rec('W', [1]), rec('T', [2, 3]), X_RECORD);
  const seen = [];
  const r = readContainer(file, { onRecord: (record) => seen.push([record.type, [...record.body]]) });
  assert.deepEqual(seen, [['W', [1]], ['T', [2, 3]], ['X', [...new Bytes().cstr('EndOfFile').build()]]]);
  assert.deepEqual(r.records, []);
  assert.equal(r.recordCount, 3);
  assert.equal(r.complete, true);

  const boom = new Error('caller bug');
  assert.throws(
    () =>
      readContainer(file, {
        onRecord: () => {
          throw boom;
        },
      }),
    (e) => e === boom,
  );
});

test('a failed header yields no records and keeps the header facts', () => {
  const file = concat(header({ primary: 0x65 }), rec('W', [1]));
  const r = readContainer(file);
  assert.equal(r.ok, false);
  assert.equal(r.complete, false);
  assert.deepEqual(r.records, []);
  assert.equal(r.endOffset, 0);
  assert.equal(r.primaryFormat, 0x65);
});

test('problem messages are plain words and every code is documented', () => {
  const file = concat(header(), rec('Q', []), new Uint8Array(10), rec('W', [1]), X_RECORD, new Uint8Array(3).fill(9));
  const r = readContainer(file);
  for (const p of r.problems) {
    assert.ok(PROBLEM_CODES.includes(p.code), p.code);
    assert.match(p.message, /^[A-Z0-9][A-Za-z0-9 ,.'()-]+\.$/);
    assert.ok(Number.isSafeInteger(p.count) && p.count > 0);
  }
  assert.deepEqual(codes(r).sort(), ['data_after_end', 'empty_record', 'unknown_record_type', 'zero_padding']);
});

// ---------------------------------------------------------------------------------------------
// Hostile input: truncations, bit flips and random bytes never throw and never break the invariants

/** @param {Uint8Array} input @param {ReturnType<typeof readContainer>} r */
function assertInvariants(input, r) {
  assert.equal(typeof r.ok, 'boolean');
  assert.ok(Array.isArray(r.problems));
  let previousEnd = r.bodyStart;
  for (const record of r.records) {
    assert.ok(record.offset >= previousEnd, 'records are in order and do not overlap');
    assert.ok(record.bodyOffset + record.length <= input.length, 'bodies lie inside the file');
    assert.equal(record.body.length, record.length);
    previousEnd = record.bodyOffset + record.length;
  }
  assert.ok(r.endOffset <= input.length);
  if (r.complete) assert.ok(r.endOffset === input.length || r.end.present);
  for (const p of r.problems) assert.ok(PROBLEM_CODES.includes(p.code));
}

function fixture() {
  return concat(
    header(),
    rec('W', new Bytes().cstr('a').u32(0).u32(1).u32(2).cstr('').u8(0).u32(0).u32(0).build()),
    rec('T', new Uint8Array(40).fill(3)),
    rec('R', [0, 0, 0, 0, 0]),
    V_RECORD,
    E_RECORD,
    X_RECORD,
  );
}

test('fuzz: every truncation of a fixture', () => {
  const f = fixture();
  for (let n = 0; n <= f.length; n++) {
    const input = f.slice(0, n);
    assertInvariants(input, readContainer(input));
  }
});

test('fuzz: seeded bit flips and byte overwrites', () => {
  const f = fixture();
  const rand = prng(1234);
  for (let i = 0; i < 3000; i++) {
    const input = f.slice();
    const flips = 1 + Math.floor(rand() * 4);
    for (let k = 0; k < flips; k++) {
      const at = Math.floor(rand() * input.length);
      if (rand() < 0.5) input[at] ^= 1 << Math.floor(rand() * 8);
      else input[at] = Math.floor(rand() * 256);
    }
    assertInvariants(input, readContainer(input));
  }
});

test('fuzz: random bytes after a valid header', () => {
  const rand = prng(99);
  const h = header();
  for (let i = 0; i < 500; i++) {
    const tail = new Uint8Array(Math.floor(rand() * 200));
    for (let k = 0; k < tail.length; k++) tail[k] = rand() < 0.6 ? 0 : Math.floor(rand() * 256);
    const input = concat(h, tail);
    assertInvariants(input, readContainer(input, { limits: { maxRecords: 50 } }));
  }
});

// ---------------------------------------------------------------------------------------------
// Adversarial review (2026-10-06). These tests passed on the code as it was: they are kept as evidence for the
// claims in the module header (bounds-checked, never throws, views not copies) and as guards against regressions.

test('a header cut at every byte from 18 up to its full length is unreadable, never an internal error', () => {
  for (const app of ['BaseCamp', 'HomePort', '']) {
    const full = header({ app });
    for (let n = 0; n < full.length; n++) {
      for (const role of ['gdb', 'any', 'tracksegments']) {
        const r = readHeader(full.subarray(0, n), { role: /** @type {any} */ (role) });
        assert.equal(r.ok, false, `n=${n} role=${role}`);
        assert.equal(r.stopped, n < 18 ? 'not_library_file' : 'bad_header', `n=${n} role=${role}`);
        assert.ok(!codes(r).includes('internal_error'));
      }
    }
    assert.equal(readHeader(full).ok, true);
    assert.equal(readContainer(full).complete, true);
  }
});

test('every single-byte change to a small file, in every role, never throws and keeps the invariants', () => {
  const file = concat(header(), rec('W', [1, 2]), V_RECORD, X_RECORD);
  for (let i = 0; i < file.length; i++) {
    for (let v = 0; v < 256; v += 1 + (i > 30 ? 4 : 0)) {
      const input = file.slice();
      input[i] = v;
      for (const role of ['gdb', 'gfi', 'any']) {
        const r = readContainer(input, { role: /** @type {any} */ (role) });
        assertInvariants(input, r);
        assert.ok(!codes(r).includes('internal_error'), `byte ${i} = ${v}, role ${role}`);
      }
      assert.ok(!codes(readHeader(input, { role: 'tracksegments' })).includes('internal_error'));
    }
  }
});

test('record lengths at and around the bytes that are left, and absurd u32 lengths', () => {
  const h = header();
  const tail = 40;
  // The frame is at h.length; tail bytes follow it, so a length of tail - 5 fits exactly.
  const cases = [
    [tail - 5, { complete: true, stopped: null, records: 1 }],
    [tail - 4, { complete: false, stopped: 'record_truncated', records: 0 }],
    [tail, { complete: false, stopped: 'record_truncated', records: 0 }],
    [h.length + tail, { complete: false, stopped: 'record_truncated', records: 0 }],
    [h.length + tail + 1, { complete: false, stopped: 'record_length_impossible', records: 0 }],
    [0x7fffffff, { complete: false, stopped: 'record_length_impossible', records: 0 }],
    [0x80000000, { complete: false, stopped: 'record_length_impossible', records: 0 }],
    [0xffffffff, { complete: false, stopped: 'record_length_impossible', records: 0 }],
  ];
  for (const [length, want] of cases) {
    const file = concat(h, new Uint8Array(tail));
    new DataView(file.buffer).setUint32(h.length, length, true);
    file[h.length + 4] = 0x54;
    const r = readContainer(file);
    assert.equal(r.complete, want.complete, `length ${length}`);
    assert.equal(r.stopped, want.stopped, `length ${length}`);
    assert.equal(r.records.length, want.records, `length ${length}`);
    assert.equal(r.endOffset, want.complete ? file.length : h.length);
    assertInvariants(file, r);
  }
});

test('version fields at 0 and 65535 are read raw; a primary format of 0 or 65535 is not a library', () => {
  for (const v of [0, 65535]) {
    const r = readHeader(header({ version: v, program: v }));
    assert.equal(r.ok, true);
    assert.equal(r.formatVersion, v);
    assert.equal(r.programVersion, v);
    assert.equal(r.versionClass, v === 0 ? 'unknown' : 'experimental');
    const p = readHeader(header({ primary: v }));
    assert.equal(p.ok, false);
    assert.equal(p.primaryFormat, v);
    assert.equal(p.stopped, 'not_library_file');
  }
});

test('a GFI signature where a GDB is expected and the reverse, in every role', () => {
  const gdb = concat(header({ sig: 'MsRc' }), rec('W', [1]));
  const gfi = concat(header({ sig: 'DifG' }), rec('F', [1]));
  const want = [
    [gdb, 'gdb', 'gdb', null],
    [gdb, 'gfi', null, 'wrong_file_kind'],
    [gdb, 'any', 'gdb', null],
    [gfi, 'gdb', null, 'wrong_file_kind'],
    [gfi, 'gfi', 'gfi', null],
    [gfi, 'any', 'gfi', null],
  ];
  for (const [bytes, role, kind, stopped] of want) {
    const r = readContainer(/** @type {Uint8Array} */ (bytes), { role: /** @type {any} */ (role) });
    assert.equal(r.kind, kind, `${role}`);
    assert.equal(r.stopped, stopped, `${role}`);
    assert.equal(r.records.length, kind === null ? 0 : 1);
  }
  // As TrackSegments, both signatures are only recorded.
  assert.equal(readHeader(gfi, { role: 'tracksegments' }).signature, 'DifG');
});

test('a 1 GiB input is framed as views without touching its pages (lazily zeroed memory)', (t) => {
  let file;
  try {
    file = new Uint8Array(2 ** 30);
  } catch {
    t.skip('this machine cannot reserve 1 GiB of address space');
    return;
  }
  const rssBefore = process.memoryUsage().rss;
  const h = header();
  file.set(h);
  const bodyLength = file.length - h.length - 5 - X_RECORD.length;
  new DataView(file.buffer).setUint32(h.length, bodyLength, true);
  file[h.length + 4] = 0x54;
  file.set(X_RECORD, file.length - X_RECORD.length);
  const started = performance.now();
  const big = readContainer(file, { limits: { maxRecordBytes: 2 ** 31 } });
  const capped = readContainer(file);
  const elapsed = performance.now() - started;
  assert.deepEqual(big.records.map((r) => [r.type, r.length]), [['T', bodyLength], ['X', 10]]);
  assert.equal(big.records[0].body.buffer, file.buffer);
  assert.equal(big.complete, true);
  // With the default 256 MiB cap the record is skipped and counted, and the end record is still found.
  assert.deepEqual(capped.records.map((r) => r.type), ['X']);
  assert.deepEqual(codes(capped), ['record_too_large']);
  assert.ok(elapsed < 1000, `took ${elapsed} ms`);
  // Reading touched only the header and the frames, not the gigabyte in between.
  assert.ok(process.memoryUsage().rss - rssBefore < 64 * 2 ** 20, 'the body pages were read or copied');
});

test('millions of tiny records: streamed with onRecord the record limit still applies, quickly', () => {
  const h = header();
  const n = 2_500_000;
  const file = new Uint8Array(h.length + n * 5);
  file.set(h);
  for (let i = 0; i < n; i++) file[h.length + i * 5 + 4] = 0x57; // length 0, type 'W'
  let seen = 0;
  const started = performance.now();
  const r = readContainer(file, { onRecord: () => seen++ });
  const elapsed = performance.now() - started;
  assert.equal(seen, DEFAULT_LIMITS.maxRecords);
  assert.equal(r.recordCount, DEFAULT_LIMITS.maxRecords);
  assert.deepEqual(r.records, []);
  assert.equal(r.stopped, 'too_many_records');
  assert.equal(problem(r, 'empty_record').count, DEFAULT_LIMITS.maxRecords);
  assert.ok(elapsed < 10_000, `took ${elapsed} ms`);
});

test('fuzz: thousands of seeded structured files (absurd lengths, V mid-file, X with bytes after, zero runs)', () => {
  const rand = prng(20261006);
  const pick = (n) => Math.floor(rand() * n);
  const types = [0x57, 0x54, 0x52, 0x56, 0x58, 0x45, 0x46, 0x49, 0x71, 0x00, 0xff];
  const started = performance.now();
  for (let round = 0; round < 4000; round++) {
    const parts = [header({ sig: pick(4) === 0 ? 'DifG' : 'MsRc', version: [188, 0, 65535, 109][pick(4)] })];
    for (let k = pick(12); k > 0; k--) {
      const shape = pick(6);
      if (shape === 0) parts.push(new Uint8Array(pick(12))); // a zero run
      else if (shape === 1) parts.push(new Bytes().u32([0xffffffff, 0x80000000, 0x7fffffff, pick(2 ** 32)][pick(4)]).u8(types[pick(types.length)]).build());
      else parts.push(rec(types[pick(types.length)], Uint8Array.from({ length: pick(20) }, () => pick(256))));
    }
    let input = concat(...parts);
    if (pick(3) === 0) input = input.subarray(0, pick(input.length + 1));
    const kept = readContainer(input, { limits: { maxRecords: 1 + pick(20) } });
    assertInvariants(input, kept);
    assert.ok(!codes(kept).includes('internal_error'), `round ${round}`);
    // Streaming sees exactly the records that would have been kept.
    const streamed = [];
    readContainer(input, { limits: { maxRecords: 1 + pick(20) }, onRecord: (r) => streamed.push(r.offset) });
    const again = readContainer(input, { limits: { maxRecords: 1_000 } });
    const both = [];
    readContainer(input, { limits: { maxRecords: 1_000 }, onRecord: (r) => both.push(r.offset) });
    assert.deepEqual(both, again.records.map((r) => r.offset));
    if (again.end.present) assert.equal(again.records[again.records.length - 1].type, 'X');
  }
  assert.ok(performance.now() - started < 30_000);
});

// ---------------------------------------------------------------------------------------------
// Decision B43: the program version breaks layout ties

test('programFamily: 408 is Mac BaseCamp 4.8, 1-407 an older BaseCamp, anything else unknown', () => {
  assert.equal(PROGRAM_VERSION_MAC48, 408);
  assert.equal(programFamily(408), 'mac48');
  for (const v of [1, 302, 405, 407]) assert.equal(programFamily(v), 'older', String(v));
  for (const v of [0, 409, 480, 4813, 65535, -1, 407.5, NaN, null, undefined, '408']) {
    assert.equal(programFamily(/** @type {any} */ (v)), 'unknown', String(v));
  }
});

test('chooseLayout: one fit is used; ties go to H-MAC48 on 408 and to the one older layout on 1-407; otherwise refused', () => {
  const M = 408;
  const O = 407;
  /** @type {Array<[string, string[], number|null, string|null, string]>} */
  const cases = [
    // type, fits, program version, layout, decision
    ['W', [], M, null, 'none'],
    ['W', ['H-KBM'], M, 'H-KBM', 'only_fit'],
    ['W', ['H-OP'], M, 'H-OP', 'only_fit'],
    ['T', ['H-OP'], M, 'H-OP', 'only_fit'],
    ['R', ['H-MAC48'], M, 'H-MAC48', 'only_fit'],
    ['R', ['H-OP'], M, null, 'not_for_version'],
    ['R', ['H-OP'], O, 'H-OP', 'only_fit'],
    ['R', ['H-OP'], null, 'H-OP', 'only_fit'],
    ['R', ['H-OP'], 480, 'H-OP', 'only_fit'],
    ['W', ['H-OP', 'H-MAC48'], M, 'H-MAC48', 'program_version'],
    ['W', ['H-KBM', 'H-OP', 'H-MAC48'], M, 'H-MAC48', 'program_version'],
    ['W', ['H-KBM', 'H-OP'], M, null, 'several'],
    ['T', ['H-OP', 'H-MAC48'], O, 'H-OP', 'program_version'],
    ['W', ['H-KBM', 'H-MAC48'], O, 'H-KBM', 'program_version'],
    ['W', ['H-KBM', 'H-OP'], O, null, 'several'],
    ['W', ['H-KBM', 'H-OP', 'H-MAC48'], O, null, 'several'],
    ['R', ['H-OP', 'H-MAC48'], M, 'H-MAC48', 'program_version'],
    ['R', ['H-OP', 'H-MAC48'], O, 'H-OP', 'program_version'],
    ['R', ['H-OP', 'H-MAC48'], null, null, 'several'],
    ['R', ['H-OP', 'H-MAC48'], 0, null, 'several'],
    ['R', ['H-OP', 'H-MAC48'], 480, null, 'several'],
    ['W', ['H-OP', 'H-MAC48'], 4813, null, 'several'],
  ];
  for (const [type, fit, version, layout, decision] of cases) {
    assert.deepEqual(chooseLayout(/** @type {any} */ (type), fit, version), { layout, decision }, `${type} ${fit.join('+')} @ ${version}`);
  }
});
