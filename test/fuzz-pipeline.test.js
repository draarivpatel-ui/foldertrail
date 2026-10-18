// Hostile-input fuzz of the whole reading pipeline. Every fixture scenario (tools/fixtures) is
// mutated in thousands of seeded ways and run the way the worker runs it: a WorkerSource of Blobs → fromWorkerSource
// (intake.js) → readLibrary → buildPreview and makeDump → exportLibrary → the ZIP, read back with a reader written here.
//
// For every case:
// - no stage throws, and the reader's catch-all (internal_error) never fires;
// - it finishes within a time cap: the cases run in a child process and the parent kills a case that hangs;
// - memory stays bounded: each child has a heap limit; for inputs of 256 KB or more, the library as read (after a GC)
//   and the peak while reading and exporting (sampled at each progress report) stay within 16 × the input (the export
//   also 4 × what it writes) plus a constant; each child's peak RSS is checked at the end;
// - every problem has a known code and its fixed plain-words message, and a token planted in hostile names never
//   reaches a problem message or the structure dump;
// - the ZIP opens: every entry inflates to its stored size and CRC-32, every path is safe, every GPX and KML is
//   well-formed XML, and All items.gpx holds every converted item;
// - on supported-path scenarios, when the mutation is confined to FolderData.gfi, to one TrackSegments file, or to one
//   record of AllData.gdb, every item it cannot have touched still matches the fixture writer's expectation exactly.
//
// Mutations: bit flips, byte runs, insertions, cuts and truncation; records duplicated, reordered and deleted; length
// fields ±1, ±N and absurd; gigantic u32 counts; type bytes changed; names replaced with invalid UTF-8, control
// characters, path-like and markup text, and 64 KB names; folder cycles, self-parents, the root as a child, dangling
// children, list references to missing items and lists; TrackSegments files swapped between tracks, renamed, dropped,
// or with a point count that disagrees; and description-level changes built by the fixture writer (hundreds of
// same-name copies, folders deeper than the cap, hundreds of lists, track and TrackSegments counts that disagree).
//
// A second test runs libraries that are huge in one dimension (scale cases below): each stage named must stay within
// 6 × a same-size control on the ordinary path, and preview, dump and report together within 16 × the input. Cases
// about other owners' files that fail today are marked todo, with the fix in the hand-over.
//
// More cases: BCR_FUZZ_CASES=50000 (default 3000), starting at BCR_FUZZ_FROM (default 0). Another seed: BCR_FUZZ_SEED=<n>.
// BCR_FUZZ_REAL=1 mutates the REAL BaseCamp 4.8.13 samples (testdata/basecamp-real/, made-up content only) instead of
// the fixture scenarios, with the byte-level mutations only (there is no fixture description to change); their
// expectation is tools/e2e/real.js's, and the scale test is skipped. Opt-in.
// One case, in this process, with what was mutated: BCR_FUZZ_CASE=<index> node --test test/fuzz-pipeline.test.js.
// All data is synthetic.

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { inflateRawSync } from 'node:zlib';
import { SCENARIOS, buildScenario } from '../tools/fixtures/scenarios.js';
import { buildLibrary } from '../tools/fixtures/writer.js';
import { buildBackup } from '../tools/fixtures/backup.js';
import { intake, toWorkerSource, fromWorkerSource } from '../src/app/intake.js';
import { readLibrary, LIBRARY_PROBLEMS } from '../src/format/library.js';
import { buildPreview, makeDump, exportLibrary } from '../src/app/pipeline.js';
import { REASONS } from '../src/export/report.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join as joinPath, relative as relativePath } from 'node:path';
import { readContainer, readHeader } from '../src/format/container.js';
import { REAL_SAMPLES, realExpected } from '../tools/e2e/real.js';
import { mapRecord } from '../tools/hexmap.js';

const DEFAULT_SEED = 0x0b5c_f022;
const DEFAULT_CASES = 3000;
const CASE_CAP_MS = Number(process.env.BCR_FUZZ_CASE_MS) || 10_000; // generous: a loaded machine is slower
const RSS_CAP_MB = 1024; // each child process's peak, checked at the end of the run
// Each child's V8 heap (the peak, garbage included): a case that needs more crashes its child and is recorded. The
// checks below are the bound; this is the backstop that keeps a runaway case from taking the machine down.
const HEAP_CAP_MB = 1024;
// The library as read (heap and ArrayBuffers left after a full GC) must stay within HEAP_PER_INPUT × the input bytes plus
// HEAP_SLACK. Checked for inputs of HEAP_CHECK_BYTES or more (and every scale case), since each check costs two GCs.
const HEAP_PER_INPUT = 16;
const HEAP_SLACK = 32 * 2 ** 20;
// The same bound for the peak while reading and while exporting, sampled at every progress report (garbage included,
// so with more slack).
const PEAK_SLACK = 96 * 2 ** 20;
const EXPORT_PER_OUTPUT = 4;
const HEAP_CHECK_BYTES = 256 * 1024;
/** Planted in hostile names; must never reach a problem message or the dump. */
const TOKEN = 'ZQJXQ';
const TOKEN_HEX = Array.from(TOKEN, (c) => c.charCodeAt(0).toString(16)).join('');
const FIXED_NOW = Date.UTC(2026, 9, 6, 12);

// ---------------------------------------------------------------------------------------------
// Seeded randomness

/** @param {number} seed */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** @typedef {() => number} Rng */

/** @param {Rng} r @param {number} n  an integer in [0, n) */
const int = (r, n) => Math.floor(r() * n);
/** @template T @param {Rng} r @param {readonly T[]} a @returns {T} */
const pick = (r, a) => a[int(r, a.length)];

// ---------------------------------------------------------------------------------------------
// Bytes

const utf8 = new TextEncoder();
/** @param {...(ArrayLike<number>|string)} parts */
function cat(...parts) {
  return catAll(parts);
}
/**
 * Like cat, for many parts (a spread of tens of thousands of arguments overflows the stack).
 * @param {Array<ArrayLike<number>|string>} parts
 */
function catAll(parts) {
  const arrays = parts.map((p) => (typeof p === 'string' ? utf8.encode(p) : p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}
/** @param {Uint8Array} b @param {number} at */
const u32 = (b, at) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at, true);
/** @param {Uint8Array} b @param {number} at @param {number} v */
const setU32 = (b, at, v) => new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(at, v >>> 0, true);
/** @param {number} v */
const le32 = (v) => {
  const b = new Uint8Array(4);
  setU32(b, 0, v);
  return b;
};
/** @param {Uint8Array} b @param {number} start @param {number} remove @param {Uint8Array} [insert] */
function splice(b, start, remove, insert = new Uint8Array(0)) {
  return cat(b.subarray(0, start), insert, b.subarray(start + remove));
}

/**
 * Hostile name bytes (never 0x00: a cstr cannot hold it). Most carry TOKEN.
 * @param {Rng} r
 * @returns {Uint8Array}
 */
function hostileName(r) {
  switch (int(r, 16)) {
    case 0:
      return cat([0xc3, 0x28], TOKEN, [0xa0, 0xa1]); // invalid UTF-8
    case 1:
      return cat(TOKEN, [0xed, 0xa0, 0x80], [0xed, 0xbf, 0xbf]); // UTF-8 of lone surrogates
    case 2:
      return cat([0xc0, 0xaf, 0xe0, 0x80, 0xaf], TOKEN); // overlong encodings
    case 3:
      return cat([0xf4, 0x90, 0x80, 0x80, 0xf8, 0x88, 0x80, 0x80, 0x80], TOKEN); // above U+10FFFF, 5-byte form
    case 4:
      return cat(Array.from({ length: 31 }, (_, i) => i + 1), [0x7f], TOKEN); // every control character but NUL
    case 5:
      return cat('A'.repeat(65536 - TOKEN.length), TOKEN); // 64 KB
    case 6: {
      const b = new Uint8Array(65536);
      for (let i = 0; i < b.length; i++) b[i] = 1 + int(r, 255);
      b.set(utf8.encode(TOKEN), int(r, b.length - TOKEN.length));
      return b; // 64 KB of random non-NUL bytes
    }
    case 7:
      return new Uint8Array(0);
    case 8:
      return utf8.encode(pick(r, ['..', '.', '/', `a/../../${TOKEN}`, `/${TOKEN}`, `${TOKEN}/`, '\\..\\', ' ', `${TOKEN}...`]));
    case 9:
      return utf8.encode(pick(r, ['CON', 'nul.gpx', 'COM1.', 'LPT9', `C:\\${TOKEN}`, `${TOKEN}:stream`, `${TOKEN}*?"<>|`]));
    case 10:
      return utf8.encode(`<img src=x onerror=${TOKEN}>&amp;]]><!--"'`);
    case 11:
      return utf8.encode(`\u202E${TOKEN}xpg.exe\u200B\u200D${'e\u0301'.repeat(500)}`);
    case 12:
      return cat([0xef, 0xbb, 0xbf], TOKEN); // a byte-order mark
    case 13:
      return cat(Array.from({ length: 32 }, (_, i) => 0x80 + i), TOKEN); // windows-1252 range, not UTF-8
    case 14:
      return utf8.encode(' . '.repeat(100));
    default:
      return utf8.encode('\u{1F3D4}'.repeat(1024) + TOKEN); // 4 KB of 4-byte characters
  }
}

// ---------------------------------------------------------------------------------------------
// Framing (FORMAT.md §3.2), test-side: records of the current bytes, stopping at the first impossible length

/**
 * @typedef {object} Rec
 * @property {string} type
 * @property {number} offset  of the 5-byte frame
 * @property {number} len
 * @property {string|null} item  the fixture's item id (only for untouched files)
 */

/**
 * @param {Uint8Array} bytes
 * @param {number} headerEnd
 * @returns {Rec[]}
 */
function frame(bytes, headerEnd) {
  /** @type {Rec[]} */
  const out = [];
  let at = headerEnd;
  while (at + 5 <= bytes.length) {
    const len = u32(bytes, at);
    if (len > bytes.length - at - 5) break;
    out.push({ type: String.fromCharCode(bytes[at + 4]), offset: at, len, item: null });
    at += 5 + len;
  }
  return out;
}

/**
 * An 'F' record body (FORMAT.md §8.1), or null when it does not parse.
 * @param {Uint8Array} body
 */
function parseF(body) {
  if (body.length < 5) return null;
  const nul = body.indexOf(0, 4);
  if (nul < 0 || nul + 9 > body.length) return null;
  const n = u32(body, nul + 5);
  let at = nul + 9;
  if (n * 8 > body.length - at) return null;
  /** @type {Array<[number, number]>} */
  const children = [];
  for (let i = 0; i < n; i++, at += 8) children.push([u32(body, at), u32(body, at + 4)]);
  return { id: u32(body, 0), name: body.subarray(4, nul), parent: u32(body, nul + 1), children, tail: body.subarray(at) };
}

/** @param {NonNullable<ReturnType<typeof parseF>>} f */
function buildF(f) {
  return catAll([le32(f.id), f.name, [0], le32(f.parent), le32(f.children.length), ...f.children.flatMap(([t, id]) => [le32(t), le32(id)]), f.tail]);
}

/** @param {string} type @param {Uint8Array} body */
const frameBytes = (type, body) => cat(le32(body.length), [type.charCodeAt(0)], body);

// ---------------------------------------------------------------------------------------------
// Mutations

/**
 * What a single mutation could have touched, for the isolation check (null: anything).
 * @typedef {{kind: 'gfi'} | {kind: 'ts', tracks: string[]} | {kind: 'gdb', affected: string[], noRoutes: boolean}
 *   | {kind: 'gdb-cut', at: number}} Local
 */

/**
 * @typedef {object} State
 * @property {Map<string, Uint8Array>} files
 * @property {Map<string, Uint8Array>} original   the files as built (manifest offsets are valid for these)
 * @property {Map<string, any>} manifest
 * @property {string[]} log
 */

/**
 * Records of a file: the manifest's (with item ids) while the file is untouched, else framed from its bytes.
 * @param {State} st
 * @param {string} path
 * @returns {Rec[]}
 */
function recordsOf(st, path) {
  const bytes = /** @type {Uint8Array} */ (st.files.get(path));
  const m = st.manifest.get(path);
  if (!m) return [];
  if (bytes === st.original.get(path)) {
    // A corrupt fixture's last record can be cut short: keep only records whose bytes are all there.
    return m.records
      .filter((/** @type {any} */ x) => x.offset + 5 + x.len <= bytes.length)
      .map((/** @type {any} */ x) => ({ type: x.type, offset: x.offset, len: x.len, item: x.item ?? null }));
  }
  return frame(bytes, m.headerEnd);
}

/** @param {State} st @param {Rng} r */
function pickFile(st, r) {
  const paths = [...st.files.keys()];
  const ts = paths.filter((p) => p.startsWith('TrackSegments/'));
  const roll = r();
  if (roll < 0.5 || (!st.files.has('FolderData.gfi') && ts.length === 0)) return 'AllData.gdb';
  if (roll < 0.8 && st.files.has('FolderData.gfi')) return 'FolderData.gfi';
  return ts.length > 0 ? pick(r, ts) : st.files.has('FolderData.gfi') ? 'FolderData.gfi' : 'AllData.gdb';
}

/**
 * The Local of a mutation confined to the bytes of one file (not to one record).
 * @param {State} st
 * @param {string} path
 * @returns {Local|null}
 */
function fileLocal(st, path) {
  if (path === 'FolderData.gfi') return { kind: 'gfi' };
  if (path.startsWith('TrackSegments/')) return { kind: 'ts', tracks: [st.manifest.get(path)?.track].filter(Boolean) };
  return null;
}

/** @param {Rng} r */
function gigantic(r) {
  return pick(r, [0xffffffff, 0x7fffffff, 0x80000000, 0x10000000, 0x01000000, 0x00ffffff, 65536, 1 << 20]);
}

/** @type {Record<string, (st: State, r: Rng) => Local|null|undefined>} return undefined: not applicable */
const BYTE_OPS = {
  flip(st, r) {
    const path = pickFile(st, r);
    const b = /** @type {Uint8Array} */ (st.files.get(path)).slice();
    if (b.length === 0) return undefined;
    const n = 1 + int(r, 16);
    for (let i = 0; i < n; i++) b[int(r, b.length)] ^= 1 << int(r, 8);
    st.files.set(path, b);
    st.log.push(`flip ${n} bits in ${path}`);
    return fileLocal(st, path);
  },
  run(st, r) {
    const path = pickFile(st, r);
    const b = /** @type {Uint8Array} */ (st.files.get(path)).slice();
    if (b.length === 0) return undefined;
    const at = int(r, b.length);
    const n = 1 + int(r, 64);
    const v = pick(r, [0x00, 0xff, 0x7f, 0x01, -1]);
    for (let i = at; i < Math.min(b.length, at + n); i++) b[i] = v === -1 ? int(r, 256) : v;
    st.files.set(path, b);
    st.log.push(`run of ${n} × ${v} at ${at} in ${path}`);
    return fileLocal(st, path);
  },
  insert(st, r) {
    const path = pickFile(st, r);
    const b = /** @type {Uint8Array} */ (st.files.get(path));
    const at = int(r, b.length + 1);
    const ins = Uint8Array.from({ length: 1 + int(r, 32) }, () => int(r, 256));
    st.files.set(path, splice(b, at, 0, ins));
    st.log.push(`insert ${ins.length} bytes at ${at} in ${path}`);
    return fileLocal(st, path);
  },
  cut(st, r) {
    const path = pickFile(st, r);
    const b = /** @type {Uint8Array} */ (st.files.get(path));
    if (b.length === 0) return undefined;
    const at = int(r, b.length);
    const n = 1 + int(r, 32);
    st.files.set(path, splice(b, at, n));
    st.log.push(`cut ${n} bytes at ${at} in ${path}`);
    return fileLocal(st, path);
  },
  truncate(st, r) {
    const path = pickFile(st, r);
    const b = /** @type {Uint8Array} */ (st.files.get(path));
    const at = int(r, b.length);
    const untouched = b === st.original.get(path);
    st.files.set(path, b.subarray(0, at));
    st.log.push(`truncate ${path} at ${at} of ${b.length}`);
    if (path === 'AllData.gdb') return untouched ? { kind: 'gdb-cut', at } : null;
    return fileLocal(st, path);
  },
  'rec-flip'(st, r) {
    const path = pickFile(st, r);
    const recs = recordsOf(st, path).filter((x) => x.len > 0);
    if (recs.length === 0) return undefined;
    const rec = pick(r, recs);
    const b = /** @type {Uint8Array} */ (st.files.get(path)).slice();
    const n = 1 + int(r, 4);
    for (let i = 0; i < n; i++) b[rec.offset + 5 + int(r, rec.len)] ^= 1 << int(r, 8);
    st.files.set(path, b);
    st.log.push(`flip ${n} bits in the body of a '${rec.type}' record of ${path}`);
    if (path !== 'AllData.gdb') return fileLocal(st, path);
    return { kind: 'gdb', affected: rec.item ? [rec.item] : [], noRoutes: rec.type === 'W' };
  },
  'rec-dup'(st, r) {
    const path = pickFile(st, r);
    const recs = recordsOf(st, path);
    if (recs.length === 0) return undefined;
    const rec = pick(r, recs);
    const b = /** @type {Uint8Array} */ (st.files.get(path));
    const copy = b.slice(rec.offset, rec.offset + 5 + rec.len);
    const times = r() < 0.2 ? 50 + int(r, 200) : 1;
    const at = r() < 0.5 ? rec.offset + 5 + rec.len : pick(r, recs).offset;
    st.files.set(path, splice(b, at, 0, catAll(Array.from({ length: times }, () => copy))));
    st.log.push(`duplicate a '${rec.type}' record ${times}× in ${path}`);
    if (path !== 'AllData.gdb') return fileLocal(st, path);
    if (!'WTR'.includes(rec.type) || at !== rec.offset + 5 + rec.len) return null;
    return { kind: 'gdb', affected: [], noRoutes: rec.type === 'W' };
  },
  'rec-del'(st, r) {
    const path = pickFile(st, r);
    const recs = recordsOf(st, path);
    if (recs.length === 0) return undefined;
    const rec = pick(r, recs);
    st.files.set(path, splice(/** @type {Uint8Array} */ (st.files.get(path)), rec.offset, 5 + rec.len));
    st.log.push(`delete a '${rec.type}' record of ${path}`);
    if (path !== 'AllData.gdb') return fileLocal(st, path);
    if (!'WTRVE'.includes(rec.type)) return null;
    return { kind: 'gdb', affected: rec.item ? [rec.item] : [], noRoutes: rec.type === 'W' };
  },
  'rec-swap'(st, r) {
    const path = pickFile(st, r);
    const recs = recordsOf(st, path);
    if (recs.length < 2) return undefined;
    let i = int(r, recs.length);
    let j = int(r, recs.length);
    if (i === j) return undefined;
    if (i > j) [i, j] = [j, i];
    const b = /** @type {Uint8Array} */ (st.files.get(path));
    const A = recs[i];
    const B = recs[j];
    const aEnd = A.offset + 5 + A.len;
    const bEnd = B.offset + 5 + B.len;
    st.files.set(path, cat(b.subarray(0, A.offset), b.subarray(B.offset, bEnd), b.subarray(aEnd, B.offset), b.subarray(A.offset, aEnd), b.subarray(bEnd)));
    st.log.push(`swap a '${A.type}' and a '${B.type}' record of ${path}`);
    if (path !== 'AllData.gdb') return fileLocal(st, path);
    return 'WTR'.includes(A.type) && 'WTR'.includes(B.type) ? { kind: 'gdb', affected: [], noRoutes: false } : null;
  },
  'rec-len'(st, r) {
    const path = pickFile(st, r);
    const recs = recordsOf(st, path);
    if (recs.length === 0) return undefined;
    const rec = pick(r, recs);
    const b = /** @type {Uint8Array} */ (st.files.get(path)).slice();
    const rest = b.length - rec.offset - 5;
    const delta = pick(r, [1, -1, 2, -2, 1 + int(r, 64), -(1 + int(r, 64))]);
    const v = pick(r, [rec.len + delta, rec.len + delta, 0, 0xffffffff, 0x7fffffff, 0xfffffff0, rest, rest + 1, b.length]);
    setU32(b, rec.offset, Math.max(0, v));
    st.files.set(path, b);
    st.log.push(`length field of a '${rec.type}' record of ${path}: ${rec.len} → ${Math.max(0, v) >>> 0}`);
    return fileLocal(st, path);
  },
  'rec-type'(st, r) {
    const path = pickFile(st, r);
    const recs = recordsOf(st, path);
    if (recs.length === 0) return undefined;
    const rec = pick(r, recs);
    const b = /** @type {Uint8Array} */ (st.files.get(path)).slice();
    const to = pick(r, [...'WTRFIKJVEXDACGOLj', '\0', '\x7f', 'z']);
    b[rec.offset + 4] = to.charCodeAt(0);
    st.files.set(path, b);
    st.log.push(`type of a '${rec.type}' record of ${path} → '${to}'`);
    return fileLocal(st, path);
  },
  'rec-u32'(st, r) {
    const path = pickFile(st, r);
    const recs = recordsOf(st, path).filter((x) => x.len >= 4);
    if (recs.length === 0) return undefined;
    const rec = pick(r, recs);
    const b = /** @type {Uint8Array} */ (st.files.get(path)).slice();
    const at = rec.offset + 5 + int(r, rec.len - 3);
    const v = gigantic(r);
    setU32(b, at, v);
    st.files.set(path, b);
    st.log.push(`u32 at body offset ${at - rec.offset - 5} of a '${rec.type}' record of ${path} → ${v}`);
    if (path !== 'AllData.gdb') return fileLocal(st, path);
    return { kind: 'gdb', affected: rec.item ? [rec.item] : [], noRoutes: rec.type === 'W' };
  },
  'rec-name'(st, r) {
    // The name cstr: at the start of a GDB W/T/R body; after the u32 ID in a GFI F/I record or reference.
    const path = r() < 0.6 ? 'AllData.gdb' : 'FolderData.gfi';
    if (!st.files.has(path)) return undefined;
    const recs = recordsOf(st, path).filter((x) => (path === 'AllData.gdb' ? 'WTR' : 'FITWR').includes(x.type));
    if (recs.length === 0) return undefined;
    const rec = pick(r, recs);
    const b = /** @type {Uint8Array} */ (st.files.get(path));
    const start = rec.offset + 5 + (path === 'AllData.gdb' ? 0 : 4);
    const end = rec.offset + 5 + rec.len;
    const nul = b.subarray(0, end).indexOf(0, start);
    if (nul < 0) return undefined;
    const name = hostileName(r);
    const next = splice(b, start, nul - start, name);
    setU32(next, rec.offset, rec.len + name.length - (nul - start));
    st.log.push(`name of a '${rec.type}' record of ${path} → ${name.length} hostile bytes`);
    // Half the time, a GDB item's references in FolderData.gfi get the same name, so the item stays in its lists.
    const old = b.slice(start, nul);
    if (path === 'AllData.gdb' && st.files.has('FolderData.gfi') && r() < 0.5) {
      // One pass over the records (splicing once per reference made building some cases quadratic).
      const gfi = /** @type {Uint8Array} */ (st.files.get('FolderData.gfi'));
      /** @type {Uint8Array[]} */
      const parts = [];
      let at = 0;
      for (const ref of frame(gfi, st.manifest.get('FolderData.gfi').headerEnd)) {
        if (ref.type !== rec.type) continue;
        const s = ref.offset + 9;
        const e = gfi.subarray(0, ref.offset + 5 + ref.len).indexOf(0, s);
        if (e < 0 || e - s !== old.length || !gfi.subarray(s, e).every((v, k) => v === old[k])) continue;
        parts.push(gfi.subarray(at, ref.offset), le32(ref.len + name.length - old.length), gfi.subarray(ref.offset + 4, s), name);
        at = e;
      }
      parts.push(gfi.subarray(at));
      st.files.set('FolderData.gfi', catAll(parts));
      st.log.push('… and in its FolderData.gfi references');
      st.files.set(path, next);
      return null; // two files changed
    }
    st.files.set(path, next);
    if (path !== 'AllData.gdb') return { kind: 'gfi' };
    return { kind: 'gdb', affected: rec.item ? [rec.item] : [], noRoutes: rec.type === 'W' };
  },
  'gfi-tree'(st, r) {
    const path = 'FolderData.gfi';
    if (!st.files.has(path)) return undefined;
    const b = /** @type {Uint8Array} */ (st.files.get(path));
    const recs = recordsOf(st, path);
    const folders = recs.flatMap((rec) => {
      const f = rec.type === 'F' ? parseF(b.subarray(rec.offset + 5, rec.offset + 5 + rec.len)) : null;
      return f ? [{ rec, f }] : [];
    });
    if (folders.length === 0) return undefined;
    const lists = recs.filter((x) => x.type === 'I' && x.len >= 4).map((x) => u32(b, x.offset + 5));
    const a = pick(r, folders);
    const c = pick(r, folders);
    const what = int(r, 9);
    /** @type {Map<number, Uint8Array>} record offset → new body */
    const bodies = new Map();
    const change = (/** @type {typeof a} */ x, /** @type {(f: typeof a.f) => void} */ edit) => {
      const f = { ...x.f, children: [...x.f.children] };
      edit(f);
      bodies.set(x.rec.offset, buildF(f));
    };
    let label;
    switch (what) {
      case 0:
        label = 'a folder is its own parent';
        change(a, (f) => (f.parent = f.id));
        break;
      case 1:
        label = 'a folder lists itself as a child';
        change(a, (f) => f.children.push([1, f.id]));
        break;
      case 2:
        label = 'two folders list each other (a cycle)';
        change(a, (f) => f.children.push([1, c.f.id]));
        if (c !== a) change(c, (f) => f.children.push([1, a.f.id]));
        break;
      case 3:
        label = 'a folder lists the root as a child';
        change(a, (f) => f.children.push([1, 0xffffffff]));
        break;
      case 4:
        label = "the root's parent is another folder, and that folder lists the root";
        change(folders[0], (f) => (f.parent = a.f.id));
        if (a !== folders[0]) change(a, (f) => f.children.push([1, folders[0].f.id]));
        break;
      case 5:
        label = 'the root ID changes';
        change(folders[0], (f) => (f.id = pick(r, [0, 1, 7, 0xfffffffe])));
        break;
      case 6:
        label = 'dangling children and unknown child types';
        change(a, (f) => f.children.push([0, 0xabcdef], [1, 0xabcdee], [7, 0], [0xffffffff, 1]));
        break;
      case 7:
        label = 'a list placed in every folder';
        if (lists.length === 0) return undefined;
        for (const x of folders) change(x, (f) => f.children.push([0, lists[0]]));
        break;
      default:
        label = 'every folder lists every folder';
        for (const x of folders) change(x, (f) => f.children.push(...folders.map((y) => /** @type {[number, number]} */ ([1, y.f.id]))));
    }
    /** @type {Uint8Array[]} */
    const parts = [];
    let at = 0;
    for (const rec of recs) {
      const body = bodies.get(rec.offset);
      if (!body) continue;
      parts.push(b.subarray(at, rec.offset), frameBytes('F', body));
      at = rec.offset + 5 + rec.len;
    }
    parts.push(b.subarray(at));
    st.files.set(path, catAll(parts));
    st.log.push(`FolderData.gfi: ${label}`);
    return { kind: 'gfi' };
  },
  'gfi-ref'(st, r) {
    const path = 'FolderData.gfi';
    if (!st.files.has(path)) return undefined;
    const b = /** @type {Uint8Array} */ (st.files.get(path));
    const recs = recordsOf(st, path);
    const lists = recs.filter((x) => x.type === 'I' && x.len >= 4).map((x) => u32(b, x.offset + 5));
    const refs = recs.filter((x) => 'TWR'.includes(x.type));
    const what = int(r, 4);
    /** @type {Uint8Array[]} */
    const extra = [];
    let label;
    if (what === 0 || refs.length === 0) {
      label = 'references to items that do not exist';
      for (let i = 0; i < 1 + int(r, 5); i++) {
        const type = pick(r, ['T', 'W', 'R']);
        const list = lists.length > 0 && r() < 0.8 ? pick(r, lists) : 0xdead;
        const tail = type === 'W' ? le32(int(r, 3)) : type === 'T' ? le32(0) : [0];
        extra.push(frameBytes(type, cat(le32(list), r() < 0.5 ? hostileName(r) : `Missing ${i}`, [0], tail)));
      }
    } else if (what === 1) {
      label = 'references to a list that does not exist';
      const ref = pick(r, refs);
      const body = b.slice(ref.offset + 5, ref.offset + 5 + ref.len);
      if (body.length < 4) return undefined;
      setU32(body, 0, pick(r, [0xdead, 0xffffffff, 0x7fffffff]));
      extra.push(frameBytes(ref.type, body));
    } else if (what === 2) {
      label = 'one reference repeated many times';
      const ref = pick(r, refs);
      const one = b.subarray(ref.offset, ref.offset + 5 + ref.len);
      for (let i = 0; i < 100 + int(r, 400); i++) extra.push(one);
    } else {
      label = 'every item referenced from every list';
      for (const ref of refs) {
        const body = b.slice(ref.offset + 5, ref.offset + 5 + ref.len);
        if (body.length < 4) continue;
        for (const list of lists) {
          setU32(body, 0, list);
          extra.push(frameBytes(ref.type, body.slice()));
        }
      }
    }
    st.files.set(path, catAll([b, ...extra]));
    st.log.push(`FolderData.gfi: ${label}`);
    return { kind: 'gfi' };
  },
  'ts-swap'(st) {
    const ts = [...st.files.keys()].filter((p) => p.startsWith('TrackSegments/'));
    if (ts.length < 2) return undefined;
    const [p, q] = ts;
    const bp = /** @type {Uint8Array} */ (st.files.get(p));
    st.files.set(p, /** @type {Uint8Array} */ (st.files.get(q)));
    st.files.set(q, bp);
    st.log.push('two TrackSegments files swapped between tracks');
    return { kind: 'ts', tracks: [st.manifest.get(p)?.track, st.manifest.get(q)?.track].filter(Boolean) };
  },
  'ts-count'(st, r) {
    const ts = [...st.files.keys()].filter((p) => p.startsWith('TrackSegments/'));
    if (ts.length === 0) return undefined;
    const path = pick(r, ts);
    const at = st.manifest.get(path)?.headerEnd;
    const b = /** @type {Uint8Array} */ (st.files.get(path)).slice();
    if (at === undefined || at + 4 > b.length) return undefined;
    const m = u32(b, at);
    const v = pick(r, [m + 1, m - 1, m + 2 + int(r, 50), m - 2 - int(r, 50), 0, gigantic(r)]);
    setU32(b, at, Math.max(0, v));
    st.files.set(path, b);
    st.log.push(`TrackSegments point count ${m} → ${Math.max(0, v)}`);
    return fileLocal(st, path);
  },
  'ts-rename'(st, r) {
    const ts = [...st.files.keys()].filter((p) => p.startsWith('TrackSegments/'));
    if (ts.length === 0) return undefined;
    const path = pick(r, ts);
    const bytes = /** @type {Uint8Array} */ (st.files.get(path));
    const what = int(r, 3);
    if (what === 0) {
      st.files.set(`TrackSegments/${path.slice(14).toUpperCase()}`, bytes);
      st.log.push('a TrackSegments file name in upper case, next to the original');
      return { kind: 'ts', tracks: [st.manifest.get(path)?.track].filter(Boolean) };
    }
    st.files.delete(path);
    if (what === 1) {
      st.files.set('TrackSegments/00000000-0000-0000-0000-000000000000', bytes);
      st.log.push('a TrackSegments file renamed to an unrelated UUID');
    } else st.log.push('a TrackSegments file dropped');
    return { kind: 'ts', tracks: [st.manifest.get(path)?.track].filter(Boolean) };
  },
};

/**
 * Description-level mutations, built by the fixture writer. Each returns a changed copy of the description, or
 * undefined when it does not apply.
 * @type {Record<string, (lib: any, r: Rng) => any>}
 */
const SPEC_OPS = {
  'spec-names'(lib, r) {
    const targets = [...lib.items, ...(lib.folders ?? [])];
    if (targets.length === 0) return undefined;
    for (let i = 0; i < 1 + int(r, 4); i++) {
      const t = pick(r, targets);
      t.name = hostileName(r);
      delete t.gfiName;
      delete t.nameEncoding;
    }
    return lib;
  },
  'spec-same-name'(lib, r) {
    const name = r() < 0.5 ? 'Same' : hostileName(r);
    for (const it of lib.items) {
      it.name = name;
      delete it.gfiName;
      delete it.nameEncoding;
    }
    return lib;
  },
  'spec-copies'(lib, r) {
    if (lib.items.length === 0) return undefined;
    const it = pick(r, lib.items);
    const n = 20 + int(r, 280);
    const ids = [];
    for (let k = 0; k < n; k++) {
      const copy = structuredClone(it);
      copy.id = `${it.id}~${k}`;
      if (copy.gdb) delete copy.gdb.uuid;
      lib.items.push(copy);
      ids.push(copy.id);
    }
    for (const f of lib.folders ?? []) if (f.itemIds?.includes(it.id)) f.itemIds.push(...ids);
    return lib;
  },
  'spec-deep'(lib, r) {
    if (lib.gfi === null) return undefined;
    const depth = 60 + int(r, 60);
    lib.folders ??= [];
    let parent = null;
    for (let d = 0; d < depth; d++) {
      lib.folders.push({ id: `deep${d}`, name: r() < 0.1 ? hostileName(r) : `Level ${d}`, type: 'folder', parentId: parent, itemIds: [] });
      parent = `deep${d}`;
    }
    lib.folders.push({ id: 'deepList', name: 'Bottom', type: 'list', parentId: parent, itemIds: lib.items.slice(0, 3).map((/** @type {any} */ i) => i.id) });
    return lib;
  },
  'spec-wide'(lib, r) {
    if (lib.gfi === null || lib.items.length === 0) return undefined;
    lib.folders ??= [];
    const n = 100 + int(r, 300);
    const same = r() < 0.5;
    for (let k = 0; k < n; k++) {
      lib.folders.push({ id: `wide${k}`, name: same ? 'Same list' : `List ${k}`, type: 'list', parentId: null, itemIds: [lib.items[k % lib.items.length].id] });
    }
    return lib;
  },
  'spec-counts'(lib, r) {
    const tracks = lib.items.filter((/** @type {any} */ i) => i.kind === 'track');
    const waypoints = lib.items.filter((/** @type {any} */ i) => i.kind === 'waypoint');
    if (tracks.length === 0 && waypoints.length === 0) return undefined;
    if (tracks.length > 0 && (waypoints.length === 0 || r() < 0.7)) {
      const t = pick(r, tracks);
      const points = t.segments.reduce((/** @type {number} */ n, /** @type {any[]} */ s) => n + s.length, 0);
      t.gdb = { ...t.gdb };
      t.ts = { ...t.ts };
      switch (int(r, 4)) {
        case 0:
          t.gdb.totalCount = pick(r, [points + 1, Math.max(0, points - 1), 0, 0xffffffff]);
          break;
        case 1:
          t.gdb.segmentCount = pick(r, [t.segments.length + 1, Math.max(0, t.segments.length - 1), 0xffffffff, 0x10000000]);
          break;
        default:
          t.ts.countOverride = pick(r, [points + 1, Math.max(0, points - 1), 0, 0xffffffff, 0x7fffffff]);
      }
    } else {
      const w = pick(r, waypoints);
      w.gdb = { ...w.gdb };
      if (r() < 0.5) {
        w.gdb.linksCount = pick(r, [0xffffffff, 0x7fffffff, 1000]);
      } else w.gdb.phoneCount = pick(r, [2, 0xffffffff]);
    }
    return lib;
  },
  'spec-text'(lib, r) {
    const waypoints = lib.items.filter((/** @type {any} */ i) => i.kind === 'waypoint');
    if (waypoints.length === 0) return undefined;
    const w = pick(r, waypoints);
    w.comment = pick(r, ['x'.repeat(65536), `<b>${'&'.repeat(1000)}</b>]]>`, '\u0001\u0002\u001f'.repeat(1000), 'é'.repeat(30000)]);
    return lib;
  },
};

// ---------------------------------------------------------------------------------------------
// Running one case

/**
 * A WorkerSource (intake.js toWorkerSource shape) over in-memory files.
 * @param {Map<string, Uint8Array>} files  paths relative to Database/<version>
 */
function workerSource(files) {
  const ref = (/** @type {string} */ name, /** @type {Uint8Array} */ bytes) => ({
    name,
    path: name,
    size: bytes.length,
    lastModified: null,
    blob: new Blob([bytes]),
    index: null,
    entryName: null,
  });
  const get = (/** @type {string} */ name) => (files.has(name) ? ref(name, /** @type {Uint8Array} */ (files.get(name))) : null);
  return {
    kind: 'files',
    archive: null,
    allData: get('AllData.gdb'),
    folderData: get('FolderData.gfi'),
    trackSegments: [...files].filter(([p]) => p.startsWith('TrackSegments/')).map(([p, b]) => [p.slice(14), ref(p.slice(14), b)]),
    versionFolder: 'Database/4.8',
    version: '4.8',
  };
}

/** BCR_FUZZ_REAL=1: the real BaseCamp samples are the bases instead of the fixture scenarios. */
const REAL_FUZZ = process.env.BCR_FUZZ_REAL === '1';
const REAL_BASES = REAL_SAMPLES.map((s) => ({ name: s.name, supportedPath: true, library: null }));

/**
 * A real sample in the shape buildScenario() returns: its files, a manifest framed from the bytes (record offsets and
 * the item each W/T/R record holds; which track each TrackSegments file belongs to, from tools/hexmap.js), and its
 * expectation (tools/e2e/real.js) with item ids and the icon and colour BaseCamp stored (141 and 9 in every record).
 * @param {string} name
 */
function realBase(name) {
  const sample = /** @type {any} */ (REAL_SAMPLES.find((x) => x.name === name));
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  const walk = (/** @type {string} */ dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = joinPath(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files.set(relativePath(sample.source, path).split('\\').join('/'), new Uint8Array(readFileSync(path)));
    }
  };
  walk(sample.source);
  const expected = realExpected(name);
  for (const item of expected.items) {
    item.specId = `${item.kind}:${item.name}`;
    if (item.kind === 'waypoint') item.icon = 141;
    if (item.kind === 'track') item.colorIndex = 9;
  }
  /** @type {Map<string, any>} */
  const manifest = new Map();
  /** @type {Map<string, string>} TrackSegments uuid (lower case) → track item id */
  const trackOfUuid = new Map();
  for (const [path, role] of /** @type {const} */ ([['AllData.gdb', 'gdb'], ['FolderData.gfi', 'gfi']])) {
    const bytes = /** @type {Uint8Array} */ (files.get(path));
    const c = readContainer(bytes, { role });
    const records = c.records.map((r) => {
      const body = bytes.subarray(r.bodyOffset, r.bodyOffset + r.length);
      let item = null;
      if (role === 'gdb' && 'WTR'.includes(r.type)) {
        const lines = mapRecord('gdb', /** @type {'W'|'T'|'R'} */ (r.type), body).lines;
        const itemName = String(lines.find((l) => l.name === 'name')?.value ?? '');
        const cls = lines.find((l) => l.name === 'class')?.value;
        if (r.type === 'W') item = cls === 0 ? `waypoint:${itemName}` : null;
        else item = `${r.type === 'T' ? 'track' : 'route'}:${itemName}`;
        const uuid = lines.find((l) => l.kind === 'uuid')?.value;
        if (r.type === 'T' && typeof uuid === 'string') trackOfUuid.set(uuid.toLowerCase(), /** @type {string} */ (item));
      }
      return { type: r.type, offset: r.offset, bodyStart: r.bodyOffset, len: r.length, lenField: r.length, item, intended: null };
    });
    manifest.set(path, { role, headerEnd: c.bodyStart, length: bytes.length, records });
  }
  for (const [path, bytes] of files) {
    if (!path.startsWith('TrackSegments/')) continue;
    const uuid = path.slice('TrackSegments/'.length).toLowerCase();
    manifest.set(path, { role: 'trackSegments', headerEnd: readHeader(bytes, { role: 'tracksegments' }).bodyStart, length: bytes.length, records: [], track: trackOfUuid.get(uuid) ?? null });
  }
  return { scenario: name, built: { files, manifest }, expected, exercises: [] };
}

/** @type {Map<string, any>} */
const SCENARIO_CACHE = new Map();
/** @param {string} name */
function scenario(name) {
  let s = SCENARIO_CACHE.get(name);
  if (!s) {
    s = name.startsWith('real-') ? realBase(name) : buildScenario(name);
    SCENARIO_CACHE.set(name, s);
  }
  return s;
}

const BYTE_OP_NAMES = Object.keys(BYTE_OPS);
const SPEC_OP_NAMES = Object.keys(SPEC_OPS);

/**
 * Builds case `index`: a scenario (round robin) and 1-3 mutations, all from the seed.
 * @param {number} seed
 * @param {number} index
 */
function makeCase(seed, index) {
  const r = mulberry32((seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0);
  const bases = REAL_FUZZ ? REAL_BASES : SCENARIOS;
  const sc = bases[index % bases.length];
  const base = scenario(sc.name);
  /** @type {string[]} */
  const log = [`case ${index} (seed ${seed}): scenario ${sc.name}`];
  /** @type {string[]} */
  const ops = [];
  let built = base.built;
  let specChanged = false;
  if (sc.library && r() < 0.25) {
    const op = pick(r, SPEC_OP_NAMES);
    const lib = SPEC_OPS[op](structuredClone(sc.library), r);
    if (lib) {
      try {
        built = buildLibrary(lib);
        specChanged = true;
        ops.push(op);
        log.push(op);
      } catch (error) {
        log.push(`${op}: the fixture writer refused the description (${/** @type {Error} */ (error).message})`);
      }
    }
  }
  /** @type {State} */
  const st = { files: new Map(built.files), original: built.files, manifest: built.manifest, log };
  const wanted = specChanged ? int(r, 3) : 1 + (r() < 0.35 ? 1 + int(r, 2) : 0);
  /** @type {Local|null} */
  let local = null;
  let applied = 0;
  for (let tries = 0; applied < wanted && tries < 20; tries++) {
    const op = pick(r, BYTE_OP_NAMES);
    const result = BYTE_OPS[op](st, r);
    if (result === undefined) continue;
    applied++;
    ops.push(op);
    local = result;
  }
  if (specChanged || applied !== 1) local = null;
  const kml = r() < 0.7;
  const perItem = r() < 0.25;
  /** @type {{compression: 'store'|'auto', archiveFlips: number, seed: number}|null} */
  const backup = r() < 0.15 ? { compression: r() < 0.5 ? 'store' : 'auto', archiveFlips: r() < 0.3 ? 1 + int(r, 4) : 0, seed: int(r, 2 ** 31) } : null;
  if (backup) log.push(`as a .Backup (${backup.compression}${backup.archiveFlips ? `, ${backup.archiveFlips} bits of the archive flipped` : ''})`);
  log.push(`export: kml ${kml}, perItem ${perItem}`);
  return { name: sc.name, supportedPath: sc.supportedPath, files: st.files, manifest: base.built.manifest, expected: base.expected, local, kml, perItem, backup, ops, log };
}

/** A full garbage collection, for the memory checks. */
function exposeGc() {
  const gc = /** @type {any} */ (globalThis).gc;
  if (typeof gc === 'function') return /** @type {() => void} */ (gc);
  setFlagsFromString('--expose-gc');
  return /** @type {() => void} */ (runInNewContext('gc'));
}

/**
 * Heap and ArrayBuffers of this thread after a full GC (in a worker, process.memoryUsage() reports these per thread).
 * ArrayBuffers are freed by a sweeper after the GC, so it collects twice with a turn of the event loop between.
 * @param {() => void} gc
 */
async function heapAfterGc(gc) {
  gc();
  await new Promise((resolve) => setImmediate(resolve));
  gc();
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
}

/**
 * Runs one case through the pipeline and checks it. Returns the failures (empty when it passed).
 * @param {ReturnType<typeof makeCase> & {measureHeap?: boolean}} c
 * @param {(() => void)|null} [gc]  given: the memory the read library holds is checked (see HEAP_PER_INPUT)
 */
async function runCase(c, gc = null) {
  /** @type {string[]} */
  const failures = [];
  const fail = (/** @type {string} */ s) => failures.push(s);
  let stage = 'intake';
  /** @type {any} */
  const outcome = { fatal: false, exported: false, noLibrary: false };
  /** @type {Record<string, number>} */
  const ms = {};
  const sizes = { input: 0, preview: 0, dump: 0, report: 0, heldMb: 0, readPeakMb: 0, exportPeakMb: 0 };
  for (const b of c.files.values()) sizes.input += b.length;
  const measure = gc !== null && (sizes.input >= HEAP_CHECK_BYTES || c.measureHeap === true);
  let baseline = 0;
  if (measure && gc) baseline = await heapAfterGc(gc);
  let peak = 0;
  const sample = () => {
    if (!measure) return;
    const m = process.memoryUsage();
    peak = Math.max(peak, m.heapUsed + m.arrayBuffers);
  };
  /**
   * @param {string} what
   * @param {'readPeakMb'|'exportPeakMb'} key
   * @param {number} [output]  bytes written (the export's files, uncompressed): one GPX per list can legitimately be
   *   larger than the list's few bytes of input, so the export may also use EXPORT_PER_OUTPUT × what it writes
   */
  const checkPeak = (what, key, output = 0) => {
    if (!measure) return;
    sizes[key] = Math.round((peak - baseline) / 2 ** 20);
    if (peak - baseline > HEAP_PER_INPUT * sizes.input + EXPORT_PER_OUTPUT * output + PEAK_SLACK) {
      fail(`memory: ${what} reached ${sizes[key]} MB for ${(sizes.input / 2 ** 20).toFixed(1)} MB of input`);
    }
    peak = 0;
  };
  let clock = performance.now();
  const lap = (/** @type {string} */ name) => {
    const now = performance.now();
    ms[name] = (ms[name] ?? 0) + now - clock;
    clock = now;
  };
  try {
    /** @type {any} */
    let source;
    if (c.backup) {
      // The real path for a .Backup: a File → intake (unzip.js) → toWorkerSource → the worker.
      // A folder on macOS cannot hold two names that differ only in case, and the ZIP writer refuses them: keep the first.
      /** @type {Map<string, Uint8Array>} */
      const files = new Map();
      const folded = new Set();
      for (const [path, bytes] of c.files) {
        if (folded.has(path.toLowerCase())) continue;
        folded.add(path.toLowerCase());
        files.set(path, bytes);
      }
      const archive = await buildBackup({ files, databaseVersion: '4.8' }, { compression: c.backup.compression });
      const r = mulberry32(c.backup.seed);
      for (let k = 0; k < c.backup.archiveFlips; k++) archive[int(r, archive.length)] ^= 1 << int(r, 8);
      const found = await intake(new File([archive], 'BaseCamp_fuzz.Backup'));
      for (const p of [...found.problems, ...found.notes]) checkMessage(p, 'intake', fail);
      if (!found.found.allData) {
        // Intake looks at AllData.gdb's first bytes too, so a damaged one can be refused there, with a reason.
        if (found.problems.length === 0) fail('intake found no library and gave no reason');
        outcome.intakeReasons = found.problems.map((p) => p.code);
        outcome.noLibrary = true;
        return { failures, outcome, ms, sizes };
      }
      source = toWorkerSource(found.found);
      structuredClone(source);
    } else source = workerSource(c.files);
    const revived = await fromWorkerSource(source);
    for (const p of revived.problems) checkMessage(p, 'intake', fail);
    if (!revived.found.allData) fail('intake lost AllData.gdb');
    lap('intake');
    stage = 'read';
    const read = await readLibrary(revived.found, { onProgress: sample });
    sample();
    const { library, details } = read;
    lap('read');
    checkPeak('reading', 'readPeakMb');
    if (measure && gc) {
      const held = (await heapAfterGc(gc)) - baseline;
      sizes.heldMb = Math.round(held / 2 ** 20);
      if (held > HEAP_PER_INPUT * sizes.input + HEAP_SLACK) {
        fail(`memory: the library as read holds ${sizes.heldMb} MB for ${(sizes.input / 2 ** 20).toFixed(1)} MB of input`);
      }
    }
    stage = 'check read';
    checkLibrary(read, fail);
    clock = performance.now();
    stage = 'preview';
    const preview = buildPreview(read, { sourceProblems: revived.problems, libraryVersion: '4.8' });
    lap('preview');
    stage = 'dump';
    const dump = makeDump(read, source, { version: '0.0.0-fuzz', environment: { engine: 'Node', engineMajor: 26 } });
    read.diagnostics = { allData: null, folderData: null, trackSegments: null };
    lap('dump');
    stage = 'check preview';
    sizes.preview = JSON.stringify(preview).length;
    sizes.dump = dump.text.length + dump.json.length;
    structuredClone({ preview, dump }); // what postMessage does
    checkPreview(preview, library, fail);
    if (JSON.parse(dump.json).dumpFailed) fail('the structure dump could not be made');
    for (const where of [dump.text, dump.json]) {
      if (where.includes(TOKEN) || where.toLowerCase().includes(TOKEN_HEX)) fail('a name reached the structure dump');
    }
    if (c.local && c.supportedPath && !c.expected.fatal && !c.backup) {
      stage = 'isolation';
      checkIsolation(c, library, fail);
    }
    outcome.fatal = details.fatal !== null;
    if (!details.fatal) {
      clock = performance.now();
      stage = 'export';
      const result = await exportLibrary(read, { kml: c.kml, perItem: c.perItem, now: () => FIXED_NOW, version: '0.0.0-fuzz', onProgress: sample });
      sample();
      const zipBytes = new Uint8Array(await result.zip.arrayBuffer());
      lap('export');
      stage = 'zip';
      const zip = readZip(zipBytes, fail);
      let written = 0;
      for (const bytes of zip.values()) written += bytes.length;
      checkPeak('exporting', 'exportPeakMb', written);
      stage = 'check zip';
      sizes.report = result.report.text.length + result.report.html.length;
      checkExport(zip, library, c, result.report, fail);
      outcome.exported = true;
    }
  } catch (error) {
    const e = /** @type {any} */ (error);
    fail(`threw during ${stage}: ${e?.name}: ${e?.message}\n${String(e?.stack ?? '').split('\n').slice(1, 6).join('\n')}`);
  }
  return { failures, outcome, ms, sizes };
}

// ---------------------------------------------------------------------------------------------
// Checks

const KNOWN_ITEM_REASONS = new Set(Object.keys(REASONS));

/**
 * A problem: a known shape and plain words, never a planted name.
 * @param {any} p
 * @param {string} where
 * @param {(s: string) => void} fail
 */
function checkMessage(p, where, fail) {
  const m = p?.message;
  if (typeof p?.code !== 'string' || p.code === '') fail(`${where}: a problem without a code`);
  if (typeof m !== 'string' || m.length < 10 || m.length > 400) fail(`${where}: problem ${p?.code} has no plain-words message`);
  else {
    if (!/^[A-Z0-9"]/.test(m) || !/[.)]$/.test(m)) fail(`${where}: problem ${p.code} is not a sentence: ${m}`);
    if (/undefined|NaN|\[object|null|#|\{|\}/.test(m)) fail(`${where}: problem ${p.code} has a placeholder: ${m}`);
    if (m.includes(TOKEN)) fail(`${where}: problem ${p.code} carries a name`);
  }
  if (!(Number.isSafeInteger(p?.count) && p.count > 0)) fail(`${where}: problem ${p?.code} has count ${p?.count}`);
}

/**
 * @param {Awaited<ReturnType<typeof readLibrary>>} read
 * @param {(s: string) => void} fail
 */
function checkLibrary(read, fail) {
  const { library, details } = read;
  for (const p of library.problems) {
    const spec = /** @type {any} */ (LIBRARY_PROBLEMS)[p.code];
    if (!spec) fail(`reader: unknown problem code ${p.code}`);
    else if (p.message !== spec.message || p.level !== spec.level) fail(`reader: problem ${p.code} does not carry its fixed message`);
    checkMessage(p, 'reader', fail);
  }
  if (library.problems.some((p) => p.code === 'internal_error')) fail('reader: the catch-all fired (internal_error): a parser threw');
  if (details.fatal) {
    if (!(/** @type {any} */ (LIBRARY_PROBLEMS)[details.fatal.code])) fail(`reader: unknown fatal code ${details.fatal.code}`);
    if (details.fatal.message.includes(TOKEN)) fail('reader: the fatal message carries a name');
    if (library.items.length > 0) fail('reader: items after a fatal problem');
  }
  for (const n of library.notConverted ?? []) {
    if (!KNOWN_ITEM_REASONS.has(n.reason)) fail(`reader: not-converted reason ${n.reason} has no words in report.js`);
  }
  const ids = new Set();
  for (const item of library.items) {
    if (ids.has(item.id)) fail(`reader: item id ${item.id} used twice`);
    ids.add(item.id);
    if (typeof item.name !== 'string') fail('reader: an item without a name');
    if (item.kind === 'waypoint') {
      if (!(Math.abs(item.lat) <= 90 && item.lon >= -180 && item.lon < 180)) fail('reader: a waypoint position out of range');
    } else if (item.kind === 'track') {
      for (const seg of item.segments) {
        for (const p of seg) {
          if (!(Math.abs(p.lat) <= 90 && p.lon >= -180 && p.lon < 180)) fail('reader: a track point out of range');
          if (p.ele !== null && !Number.isFinite(p.ele)) fail('reader: a track elevation that is not finite');
          if (p.time !== null && !(Number.isFinite(p.time) && p.time > 0)) fail('reader: a track time that is not usable');
        }
      }
    } else if (item.kind === 'route') {
      // FORMAT.md §7.1 allows P = 0, so a route may have no points (the KML writer counts kml_no_geometry).
      for (const p of item.points) if (!(Math.abs(p.lat) <= 90 && p.lon >= -180 && p.lon < 180)) fail('reader: a route point out of range');
    }
  }
  const folderIds = new Set(library.folders.map((f) => f.id));
  if (folderIds.size !== library.folders.length) fail('reader: a folder or list id used twice');
  let roots = 0;
  for (const f of library.folders) {
    if (f.parentId === null) roots++;
    else if (!folderIds.has(f.parentId)) fail('reader: a folder whose parent is not in the tree');
    for (const id of f.itemIds) if (!ids.has(id)) fail('reader: a list naming an item that is not in the library');
    if (f.type === 'folder' && f.itemIds.length > 0) fail('reader: a folder holding items');
  }
  if (library.folders.length > 0 && roots !== 1) fail(`reader: ${roots} roots`);
  // Parents before children (pipeline and paths.js rely on it), which also rules out cycles.
  const seen = new Set();
  for (const f of library.folders) {
    if (f.parentId !== null && !seen.has(f.parentId)) fail('reader: a folder listed before its parent (or a cycle)');
    seen.add(f.id);
  }
  if (library.treeMissing !== (library.folders.length === 0)) fail('reader: treeMissing disagrees with the folders');
}

/**
 * @param {any} preview
 * @param {import('../src/model.js').Library} library
 * @param {(s: string) => void} fail
 */
function checkPreview(preview, library, fail) {
  const kinds = { waypoints: 0, tracks: 0, routes: 0 };
  for (const item of library.items) kinds[/** @type {'waypoints'} */ (`${item.kind}s`)]++;
  for (const k of /** @type {const} */ (['waypoints', 'tracks', 'routes'])) {
    if (preview.totals[k] !== kinds[k]) fail(`preview: ${k} total ${preview.totals[k]} ≠ ${kinds[k]}`);
  }
  if (preview.tree.length !== library.folders.length) fail('preview: the tree differs from the folders');
  for (const p of preview.problems) checkMessage(p, 'preview', fail);
  if (preview.fatal && preview.fatal.message.includes(TOKEN)) fail('preview: the fatal message carries a name');
}

/**
 * Whether a reader item has every field the writer expects (from test/reader-vs-fixtures.test.js).
 * @param {any} mine
 * @param {any} want
 * @param {boolean} positionsOnly  tracks: ignore elevation and time
 */
function sameItem(mine, want, positionsOnly) {
  const near = (/** @type {number|null} */ a, /** @type {number|null} */ b) => (a === null || b === null ? a === b : Math.abs(a - b) <= 1e-7);
  if (mine.kind !== want.kind || mine.name !== want.name) return false;
  if (want.kind === 'waypoint') {
    return mine.comment === want.comment && mine.icon === want.icon && near(mine.lat, want.lat) && near(mine.lon, want.lon) && mine.ele === want.ele && mine.time === want.time;
  }
  if (want.kind === 'track') {
    if (mine.colorIndex !== want.colorIndex) return false;
    const segs = mine.segments;
    if (segs.length !== want.segments.length) return false;
    for (let s = 0; s < segs.length; s++) {
      if (segs[s].length !== want.segments[s].length) return false;
      for (let i = 0; i < segs[s].length; i++) {
        const p = segs[s][i];
        const q = want.segments[s][i];
        if (!near(p.lat, q.lat) || !near(p.lon, q.lon)) return false;
        if (!positionsOnly && (p.ele !== q.ele || p.time !== q.time)) return false;
      }
    }
    return true;
  }
  if (mine.points.length !== want.points.length) return false;
  return want.points.every((/** @type {any} */ q, /** @type {number} */ i) => mine.points[i].name === q.name && near(mine.points[i].lat, q.lat) && near(mine.points[i].lon, q.lon));
}

/**
 * A mutation confined to one place leaves every item it cannot have touched exactly as the writer expects.
 * @param {ReturnType<typeof makeCase>} c
 * @param {import('../src/model.js').Library} library
 * @param {(s: string) => void} fail
 */
function checkIsolation(c, library, fail) {
  const local = /** @type {Local} */ (c.local);
  /** @type {any[]} */
  let want = c.expected.items;
  /** @type {Set<string>} */
  let positionsOnly = new Set();
  let exactCount = false;
  if (local.kind === 'gfi') exactCount = true;
  else if (local.kind === 'ts') positionsOnly = new Set(local.tracks);
  else if (local.kind === 'gdb') {
    const affected = new Set(local.affected);
    want = want.filter((i) => !affected.has(i.specId) && !(local.noRoutes && i.kind === 'route'));
  } else {
    // Truncated AllData.gdb: items whose record ends before the cut are intact; routes only if no waypoint was lost.
    const recs = c.manifest.get('AllData.gdb').records;
    const before = new Set(recs.filter((/** @type {any} */ x) => x.item && x.bodyStart + x.len <= local.at).map((/** @type {any} */ x) => x.item));
    const lostWaypoint = recs.some((/** @type {any} */ x) => x.type === 'W' && x.bodyStart + x.len > local.at);
    if (local.at < c.manifest.get('AllData.gdb').headerEnd) return; // fatal: checked elsewhere
    want = want.filter((i) => before.has(i.specId) && !(lostWaypoint && i.kind === 'route'));
  }
  const unmatched = [...library.items];
  for (const w of want) {
    const at = unmatched.findIndex((m) => sameItem(m, w, positionsOnly.has(w.specId)));
    if (at < 0) {
      fail(`isolation: the ${w.kind} of fixture item ${w.specId} no longer matches the writer (${local.kind} mutation)`);
      continue;
    }
    unmatched.splice(at, 1);
  }
  if (exactCount && unmatched.length > 0) fail(`isolation: ${unmatched.length} items more than the writer expects after a FolderData.gfi mutation`);
}

// ---------------------------------------------------------------------------------------------
// The ZIP and its files

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
/** @param {Uint8Array} b */
function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Reads a ZIP with node:zlib, checking signatures, sizes and CRC-32. Entry name → bytes.
 * @param {Uint8Array} bytes
 * @param {(s: string) => void} fail
 * @returns {Map<string, Uint8Array>}
 */
function readZip(bytes, fail) {
  /** @type {Map<string, Uint8Array>} */
  const out = new Map();
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    fail('zip: no end of central directory');
    return out;
  }
  const count = v.getUint16(eocd + 10, true);
  let at = v.getUint32(eocd + 16, true);
  if (count === 0xffff || at === 0xffffffff) {
    fail('zip: ZIP64 at this size');
    return out;
  }
  const dec = new TextDecoder('utf-8', { fatal: true });
  for (let k = 0; k < count; k++) {
    if (at + 46 > bytes.length || v.getUint32(at, true) !== 0x02014b50) {
      fail(`zip: central directory entry ${k} is broken`);
      return out;
    }
    const flags = v.getUint16(at + 8, true);
    const method = v.getUint16(at + 10, true);
    const crc = v.getUint32(at + 16, true);
    const csize = v.getUint32(at + 20, true);
    const size = v.getUint32(at + 24, true);
    const nameLength = v.getUint16(at + 28, true);
    const extra = v.getUint16(at + 30, true);
    const comment = v.getUint16(at + 32, true);
    const offset = v.getUint32(at + 42, true);
    const rawName = bytes.subarray(at + 46, at + 46 + nameLength);
    let name = '';
    try {
      name = dec.decode(rawName);
    } catch {
      fail('zip: an entry name that is not UTF-8');
    }
    if (rawName.some((b) => b >= 0x80) && !(flags & 0x800)) fail('zip: a non-ASCII name without the UTF-8 flag');
    if (v.getUint32(offset, true) !== 0x04034b50) fail(`zip: no local header for an entry`);
    const start = offset + 30 + v.getUint16(offset + 26, true) + v.getUint16(offset + 28, true);
    const data = bytes.subarray(start, start + csize);
    let content = data;
    try {
      if (method === 8) content = new Uint8Array(inflateRawSync(data));
      else if (method !== 0) fail(`zip: method ${method}`);
    } catch {
      fail('zip: an entry does not inflate');
    }
    if (content.length !== size) fail('zip: an entry has the wrong size');
    else if (crc32(content) !== crc) fail('zip: an entry has the wrong CRC-32');
    if (out.has(name)) fail('zip: two entries with the same name');
    out.set(name, content);
    at += 46 + nameLength + extra + comment;
  }
  return out;
}

/**
 * A name as macOS and Windows compare it (case and Unicode form folded).
 * @param {string} name
 */
const fold = (name) => name.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');

/**
 * @param {Map<string, Uint8Array>} zip
 * @param {import('../src/model.js').Library} library
 * @param {ReturnType<typeof makeCase>} c
 * @param {{text: string, html: string}} report
 * @param {(s: string) => void} fail
 */
function checkExport(zip, library, c, report, fail) {
  for (const required of ['READ-ME-FIRST.txt', 'report.txt', 'report.html', 'GPX/All items.gpx']) {
    if (!zip.has(required)) fail(`zip: ${required} is missing`);
  }
  if (c.kml && ![...zip.keys()].some((n) => n.startsWith('KML/') && n.endsWith('.kml'))) fail('zip: the KML is missing');
  const folded = new Set();
  for (const name of zip.keys()) {
    const segments = name.replace(/\/$/, '').split('/');
    if (name.startsWith('/') || name.includes('\\') || /[\u0000-\u001f\u007f]/.test(name)) fail('zip: an unsafe entry name');
    for (const s of segments) {
      if (s === '' || s === '.' || s === '..') fail('zip: an empty, "." or ".." path segment');
      if (utf8.encode(s).length > 255) fail('zip: a path segment longer than 255 bytes');
      if (/[ .]$/.test(s)) fail('zip: a path segment ending in a dot or space (Windows drops it)');
      if (/[<>:"|?*]/.test(s)) fail('zip: a path segment with a character Windows refuses');
    }
    const key = fold(name.replace(/\/$/, ''));
    if (folded.has(key)) fail('zip: two entries that differ only in case or Unicode form');
    folded.add(key);
  }
  const dec = new TextDecoder('utf-8', { fatal: true });
  for (const [name, bytes] of zip) {
    if (!name.endsWith('.gpx') && !name.endsWith('.kml')) continue;
    let text;
    try {
      text = dec.decode(bytes);
    } catch {
      fail(`zip: ${name.endsWith('.gpx') ? 'a GPX' : 'the KML'} file is not UTF-8`);
      continue;
    }
    const xml = checkXml(text);
    if (xml.error) fail(`xml: ${name.endsWith('.gpx') ? 'a GPX' : 'the KML'} file is not well-formed: ${xml.error}`);
    if (name === 'GPX/All items.gpx' && !xml.error) {
      const written = (xml.topLevel.get('wpt') ?? 0) + (xml.topLevel.get('trk') ?? 0) + (xml.topLevel.get('rte') ?? 0);
      if (written !== library.items.length) fail(`export: All items.gpx holds ${written} items, the library ${library.items.length}`);
    }
  }
  if (report.html.includes('<img src=x')) fail('report.html: markup from a name was not escaped');
  for (const [where, text] of [['report.txt', report.text], ['report.html', report.html]]) {
    if (/undefined|\[object|NaN/.test(text.replaceAll(TOKEN, ''))) fail(`${where}: a placeholder leaked into the report`);
  }
}

const XML_ILLEGAL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const NAME = '[A-Za-z_][A-Za-z0-9_:.-]*';
const ENTITY = /&(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9A-Fa-f]+);/y;
const TAG = new RegExp(`<(/?)(${NAME})((?:\\s+${NAME}\\s*=\\s*(?:"[^"<]*"|'[^'<]*'))*)\\s*(/?)>`, 'y');

/**
 * A small XML 1.0 well-formedness check: legal characters, a declaration, balanced tags, attribute values without
 * '<', and '&' only in entity references. Counts the root's element children by name.
 * @param {string} text
 * @returns {{error: string|null, topLevel: Map<string, number>}}
 */
function checkXml(text) {
  /** @type {Map<string, number>} */
  const topLevel = new Map();
  if (XML_ILLEGAL.test(text)) return { error: 'a character XML 1.0 does not allow', topLevel };
  if (!text.startsWith('<?xml ')) return { error: 'no XML declaration', topLevel };
  /** @type {string[]} */
  const stack = [];
  let roots = 0;
  let i = text.indexOf('?>') + 2;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    const chunk = text.slice(i, lt < 0 ? text.length : lt);
    for (let a = chunk.indexOf('&'); a >= 0; a = chunk.indexOf('&', a + 1)) {
      ENTITY.lastIndex = a;
      if (!ENTITY.test(chunk)) return { error: "a bare '&' in text", topLevel };
    }
    if (stack.length === 0 && chunk.trim() !== '') return { error: 'text outside the root element', topLevel };
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0) return { error: 'an unclosed comment', topLevel };
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt);
      if (end < 0 || stack.length === 0) return { error: 'a bad CDATA section', topLevel };
      i = end + 3;
      continue;
    }
    TAG.lastIndex = lt;
    const m = TAG.exec(text);
    if (!m) return { error: `an unreadable tag near offset ${lt}`, topLevel };
    const [, close, name, attrs, selfClose] = m;
    for (let a = attrs.indexOf('&'); a >= 0; a = attrs.indexOf('&', a + 1)) {
      ENTITY.lastIndex = a;
      if (!ENTITY.test(attrs)) return { error: "a bare '&' in an attribute", topLevel };
    }
    if (close) {
      if (stack.pop() !== name) return { error: `a closing tag that does not match (${name})`, topLevel };
    } else {
      if (stack.length === 0 && ++roots > 1) return { error: 'two root elements', topLevel };
      if (stack.length === 1) topLevel.set(name, (topLevel.get(name) ?? 0) + 1);
      if (!selfClose) stack.push(name);
    }
    i = TAG.lastIndex;
  }
  if (stack.length > 0) return { error: 'unclosed elements', topLevel };
  if (roots !== 1) return { error: 'no root element', topLevel };
  return { error: null, topLevel };
}

// ---------------------------------------------------------------------------------------------
// Scale: libraries that are large in one dimension. Each is checked like a fuzz case, and also for linear work (the
// named stages against a control of the same size that takes the ordinary path) and for bounded output (preview, dump
// and report together at most AMPLIFICATION × the input, plus a constant).

const AMPLIFICATION = 16;
const AMPLIFICATION_SLACK = 4 * 2 ** 20;
const RATIO = 6;
const RATIO_SLACK_MS = 500;

/** @param {number} lat @param {number} lon */
const pt = (lat, lon) => ({ lat, lon, ele: null, time: null });
/** @param {string} id @param {string|Uint8Array} name */
const wpSpec = (id, name) => ({ kind: 'waypoint', id, name, comment: '', lat: 46.1, lon: 7.1, ele: null, time: null });
/** A track whose record no layout accepts (a point outside its segment): not converted, listed by name. */
const brokenTrack = (/** @type {string} */ id, /** @type {string} */ name) => ({ kind: 'track', id, name, segments: [[pt(46, 7), pt(46.01, 7.01)]], gdb: { pointOutsideSegment: true } });
/**
 * @param {number} n
 * @param {(i: number) => string[]} itemsOf
 * @param {(i: number) => string|Uint8Array} [nameOf]
 * @param {(i: number) => string|null} [parentOf]
 */
const listSpecs = (n, itemsOf, nameOf = (i) => `List ${i}`, parentOf = () => null) =>
  Array.from({ length: n }, (_, i) => ({ id: `l${i}`, name: nameOf(i), type: 'list', parentId: parentOf(i), itemIds: itemsOf(i) }));

/**
 * @typedef {object} ScaleCase
 * @property {string} name
 * @property {string} owner        the file whose code this case is about
 * @property {string} [todo]       a known failure in another owner's file (the fix is described in the hand-over)
 * @property {() => any} build     a fixture description
 * @property {(() => any)|null} control  the same size on the ordinary path, or null
 * @property {string[]} compare    stages timed against the control
 * @property {boolean} [perItem]
 */

/** @type {ScaleCase[]} */
const SCALE_CASES = [
  {
    name: 'one not-converted track named by 30000 lists',
    owner: 'src/format/library.js',
    build: () => ({ items: [wpSpec('w0', 'Solo'), brokenTrack('t0', 'Broken')], folders: listSpecs(30000, () => ['t0']) }),
    control: () => ({ items: [wpSpec('w0', 'Solo'), brokenTrack('t0', 'Broken')], folders: listSpecs(30000, () => ['w0']) }),
    compare: ['read'],
  },
  {
    name: 'one duplicated name named by 30000 lists',
    owner: 'src/format/library.js',
    build: () => ({ items: [wpSpec('a', 'Twin'), wpSpec('b', 'Twin')], folders: listSpecs(30000, () => ['a']) }),
    control: () => ({ items: [wpSpec('a', 'Twin'), wpSpec('b', 'Other')], folders: listSpecs(30000, () => ['a']) }),
    compare: ['read'],
  },
  {
    name: '2000 not-converted copies of one name, named by 2000 lists',
    owner: 'src/format/library.js',
    build: () => ({
      items: Array.from({ length: 2000 }, (_, i) => brokenTrack(`t${i}`, 'Same')),
      folders: listSpecs(2000, () => ['t0']),
    }),
    control: null,
    compare: [],
  },
  {
    name: '64 nested folders with 64 KB names above 40 lists',
    owner: 'src/format/gfi.js',
    build: () => {
      /** @type {any[]} */
      const folders = [];
      for (let d = 0; d < 64; d++) folders.push({ id: `f${d}`, name: String.fromCharCode(65 + (d % 26)).repeat(65536), type: 'folder', parentId: d === 0 ? null : `f${d - 1}`, itemIds: [] });
      folders.push(...listSpecs(40, () => ['w0', 't0'], undefined, () => 'f63'));
      return { items: [wpSpec('w0', 'Here'), brokenTrack('t0', 'Broken')], folders };
    },
    control: null,
    compare: [],
    perItem: true,
  },
  {
    name: '300 folders that each list every folder',
    owner: 'src/format/gfi.js',
    build: () => {
      const folders = Array.from({ length: 300 }, (_, i) => ({ id: `f${i}`, name: `F${i}`, type: 'folder', parentId: null, itemIds: [] }));
      /** @type {Record<string, any[]>} */
      const children = {};
      for (const f of folders) children[f.id] = folders.map((g) => ['folder', g.id]);
      return { items: [wpSpec('w0', 'Here')], folders, gfi: { children } };
    },
    control: () => {
      const folders = Array.from({ length: 300 }, (_, i) => ({ id: `f${i}`, name: `F${i}`, type: 'folder', parentId: null, itemIds: [] }));
      /** @type {Record<string, any[]>} */
      const children = {};
      for (const f of folders) children[f.id] = folders.map((_, k) => ['folder', 0x00ab0000 + k]); // dangling
      return { items: [wpSpec('w0', 'Here')], folders, gfi: { children } };
    },
    compare: ['read'],
  },
  {
    name: '50000 list entries naming items that do not exist',
    owner: 'src/format/library.js',
    build: () => ({
      items: [wpSpec('w0', 'Solo')],
      folders: listSpecs(1, () => []),
      gfi: { extraRefs: Array.from({ length: 50000 }, (_, i) => ({ type: 'W', list: 'l0', name: `Missing ${i}` })) },
    }),
    control: () => ({
      items: [wpSpec('w0', 'Solo')],
      folders: listSpecs(1, () => []),
      gfi: { extraRefs: Array.from({ length: 50000 }, () => ({ type: 'W', list: 'l0', name: 'Solo' })) },
    }),
    compare: ['read'],
  },
  {
    name: 'a track of 400000 empty segments',
    owner: 'src/format/gdb.js',
    build: () => ({
      items: [{ kind: 'track', id: 't0', name: 'Empty', segments: [...Array.from({ length: 400000 }, () => []), [pt(46, 7)]] }],
      folders: listSpecs(1, () => ['t0']),
    }),
    control: null,
    compare: [],
  },
  {
    name: '20000 lists with the same name',
    owner: 'src/export/paths.js',
    build: () => ({ items: [wpSpec('w0', 'Solo')], folders: listSpecs(20000, () => ['w0'], () => 'Same') }),
    control: () => ({ items: [wpSpec('w0', 'Solo')], folders: listSpecs(20000, () => ['w0']) }),
    compare: ['export'],
  },
  {
    name: '4000 waypoints with the same name in one list',
    owner: 'src/app/pipeline.js',
    build: () => {
      const items = Array.from({ length: 4000 }, (_, i) => wpSpec(`w${i}`, 'Same'));
      return { items, folders: listSpecs(1, () => items.map((i) => i.id)) };
    },
    control: () => {
      const items = Array.from({ length: 4000 }, (_, i) => wpSpec(`w${i}`, `Point ${i}`));
      return { items, folders: listSpecs(1, () => items.map((i) => i.id)) };
    },
    compare: ['export'],
  },
  {
    name: '4000 waypoints with the same name, no FolderData.gfi, one GPX per item',
    owner: 'src/app/pipeline.js',
    build: () => ({ items: Array.from({ length: 4000 }, (_, i) => wpSpec(`w${i}`, 'Same')), gfi: null }),
    control: () => ({ items: Array.from({ length: 4000 }, (_, i) => wpSpec(`w${i}`, `Point ${i}`)), gfi: null }),
    compare: ['export'],
    perItem: true,
  },
];

/**
 * A runCase input for a fixture description.
 * @param {string} name
 * @param {any} lib
 * @param {boolean} perItem
 */
function scaleCaseInput(name, lib, perItem) {
  const built = buildLibrary(lib);
  return { name, supportedPath: false, files: new Map(built.files), manifest: built.manifest, expected: null, local: null, kml: true, perItem, backup: null, ops: [], log: [`scale: ${name}`], measureHeap: true };
}

/**
 * Runs scale case `i` (and its control) and returns its failures.
 * @param {number} i
 */
async function runScale(i, gc) {
  const sc = SCALE_CASES[i];
  const perItem = sc.perItem === true;
  /** @type {string[]} */
  const failures = [];
  /** @type {Record<string, number>} */
  let controlMs = {};
  if (sc.control) {
    const control = await runCase(scaleCaseInput(`${sc.name} (control)`, sc.control(), perItem), gc);
    failures.push(...control.failures.map((f) => `control: ${f}`));
    controlMs = control.ms;
  }
  const result = await runCase(scaleCaseInput(sc.name, sc.build(), perItem), gc);
  failures.push(...result.failures);
  for (const stage of sc.compare) {
    const budget = RATIO * (controlMs[stage] ?? 0) + RATIO_SLACK_MS;
    if (!(result.ms[stage] <= budget)) {
      failures.push(`not linear: ${stage} took ${Math.round(result.ms[stage])} ms, the control ${Math.round(controlMs[stage] ?? 0)} ms (budget ${Math.round(budget)} ms)`);
    }
  }
  const out = result.sizes.preview + result.sizes.dump + result.sizes.report;
  if (out > AMPLIFICATION * result.sizes.input + AMPLIFICATION_SLACK) {
    failures.push(`output not bounded: preview ${result.sizes.preview}, dump ${result.sizes.dump}, report ${result.sizes.report} characters from ${result.sizes.input} input bytes`);
  }
  return { failures, ms: result.ms, sizes: result.sizes };
}

// ---------------------------------------------------------------------------------------------
// Child side: run cases [from, to) and report each one to the parent. The cases run in a child process, so a case that
// runs out of memory or hangs takes down only the child, and the parent says which case it was.

const ROLE = process.env.BCR_FUZZ_ROLE ?? null;
/** @param {object} message */
const post = (message) => /** @type {NonNullable<typeof process.send>} */ (process.send)(message);

if (ROLE === 'bcr-fuzz' && typeof process.send === 'function') {
  const { seed, from, to } = JSON.parse(/** @type {string} */ (process.env.BCR_FUZZ_RANGE));
  const gc = exposeGc();
  /** @type {Record<string, number>} */
  const opCounts = {};
  for (let i = from; i < to; i++) {
    post({ t: 'start', i, log: [`case ${i} (seed ${seed}), while building it`] });
    let c;
    try {
      c = makeCase(seed, i);
    } catch (error) {
      const e = /** @type {any} */ (error);
      post({ t: 'done', i, ms: 0, failures: [`the test's own mutation code failed: ${e?.stack}`], maxRssMb: 0 });
      continue;
    }
    post({ t: 'start', i, log: c.log });
    const started = performance.now();
    const { failures, outcome, sizes } = await runCase(c, gc);
    const ms = performance.now() - started;
    for (const op of c.ops) opCounts[op] = (opCounts[op] ?? 0) + 1;
    post({
      t: 'done',
      i,
      ms,
      failures,
      fatal: outcome.fatal,
      exported: outcome.exported,
      local: c.local !== null && c.supportedPath,
      heldMb: Math.max(sizes.heldMb, sizes.readPeakMb, sizes.exportPeakMb),
      maxRssMb: process.resourceUsage().maxRSS / 1024,
    });
  }
  post({ t: 'end', opCounts });
  process.disconnect();
}

if (ROLE === 'bcr-scale' && typeof process.send === 'function') {
  const { from, to } = JSON.parse(/** @type {string} */ (process.env.BCR_FUZZ_RANGE));
  const gc = exposeGc();
  for (let i = from; i < to; i++) {
    const log = [`scale case ${i}: ${SCALE_CASES[i].name}`];
    post({ t: 'start', i, log });
    const started = performance.now();
    let result;
    try {
      result = await runScale(i, gc);
    } catch (error) {
      result = { failures: [`the test's own scale code failed: ${/** @type {any} */ (error)?.stack}`], ms: {}, sizes: {} };
    }
    post({
      t: 'done',
      i,
      ms: performance.now() - started,
      failures: result.failures,
      detail: { ms: result.ms, sizes: result.sizes },
      maxRssMb: process.resourceUsage().maxRSS / 1024,
    });
  }
  post({ t: 'end', opCounts: {} });
  process.disconnect();
}

// ---------------------------------------------------------------------------------------------
// Parent side: the test

/**
 * Runs cases [from, to) in child processes with a per-case watchdog. A case that hangs, runs out of memory or crashes
 * is recorded and the run goes on in a fresh child from the next case.
 * @param {"bcr-fuzz"|"bcr-scale"} role
 * @param {number} seed
 * @param {number} from
 * @param {number} to
 * @param {number} capMs
 */
async function runInChildren(role, seed, from, to, capMs) {
  /** @type {Array<{i: number, text: string}>} */
  const failures = [];
  /** @type {Record<string, number>} */
  const opCounts = {};
  /** @type {Map<number, any>} */
  const details = new Map();
  const stats = {
    cases: 0,
    fatal: 0,
    exported: 0,
    isolated: 0,
    slowest: /** @type {Array<[number, number]>} */ ([]),
    maxRssMb: 0,
    /** cases that raised a child's peak RSS the most: [MB added, case] */
    rssRaisers: /** @type {Array<[number, number]>} */ ([]),
    /** cases whose read library held the most memory: [MB, case] */
    heaviest: /** @type {Array<[number, number]>} */ ([]),
  };
  /** @param {Array<[number, number]>} list @param {number} value @param {number} i */
  const top = (list, value, i) => {
    list.push([value, i]);
    list.sort((a, b) => b[0] - a[0]);
    list.length = Math.min(list.length, 5);
  };
  let next = from;
  for (let restarts = 0; next < to && restarts < 20; restarts++) {
    next = await new Promise((resolve) => {
      const child = fork(fileURLToPath(import.meta.url), [], {
        env: { ...process.env, BCR_FUZZ_ROLE: role, BCR_FUZZ_RANGE: JSON.stringify({ seed, from: next, to }) },
        execArgv: [`--max-old-space-size=${HEAP_CAP_MB}`, '--expose-gc'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let stderr = '';
      child.stderr?.on('data', (chunk) => {
        stderr = (stderr + String(chunk)).slice(-4000);
      });
      /** @type {{i: number, log: string[]}|null} */
      let current = null;
      /** @type {ReturnType<typeof setTimeout>|undefined} */
      let watchdog;
      let childPeak = 0;
      let settled = false;
      const finish = (/** @type {number} */ resumeAt) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        resolve(resumeAt);
      };
      child.on('message', (/** @type {any} */ m) => {
        if (m.t === 'start') {
          current = { i: m.i, log: m.log };
          clearTimeout(watchdog);
          watchdog = setTimeout(() => {
            failures.push({ i: m.i, text: `hang: did not finish within ${capMs} ms\n  ${m.log.join('\n  ')}` });
            current = null;
            child.kill('SIGKILL');
            finish(m.i + 1);
          }, capMs);
        } else if (m.t === 'done') {
          clearTimeout(watchdog);
          stats.cases++;
          if (m.fatal) stats.fatal++;
          if (m.exported) stats.exported++;
          if (m.local) stats.isolated++;
          if (m.detail) details.set(m.i, m.detail);
          if (m.maxRssMb > childPeak + 8) top(stats.rssRaisers, Math.round(m.maxRssMb - childPeak), m.i);
          childPeak = Math.max(childPeak, m.maxRssMb);
          stats.maxRssMb = Math.max(stats.maxRssMb, m.maxRssMb);
          if (m.heldMb) top(stats.heaviest, m.heldMb, m.i);
          top(stats.slowest, m.ms, m.i);
          const log = current?.log.join('\n  ') ?? '';
          if (m.failures.length > 0) failures.push({ i: m.i, text: `${m.failures.join('\n')}\n  ${log}` });
          current = null;
        } else if (m.t === 'end') {
          for (const [op, n] of Object.entries(m.opCounts)) opCounts[op] = (opCounts[op] ?? 0) + n;
          finish(to);
        }
      });
      child.on('exit', (code, signal) => {
        if (current) {
          const why = /heap out of memory/i.test(stderr) ? `ran out of memory (V8 heap capped at ${HEAP_CAP_MB} MB)` : `the child exited (code ${code}, signal ${signal})`;
          failures.push({ i: current.i, text: `crash: ${why}\n  ${current.log.join('\n  ')}\n  ${stderr.split('\n').slice(0, 3).join('\n  ')}` });
          finish(current.i + 1);
        } else if (!settled) {
          failures.push({ i: -1, text: `crash: the child exited between cases (code ${code}, signal ${signal})\n  ${stderr.split('\n').slice(0, 3).join('\n  ')}` });
          finish(to);
        }
      });
    });
  }
  return { failures, opCounts, stats, details };
}

if (ROLE === null) {
  const { test } = await import('node:test');
  const assert = (await import('node:assert/strict')).default;
  const seed = Number(process.env.BCR_FUZZ_SEED) || DEFAULT_SEED;
  const only = process.env.BCR_FUZZ_CASE;

  if (only !== undefined) {
    test(`fuzz: case ${only} alone`, async (t) => {
      const c = makeCase(seed, Number(only));
      for (const line of c.log) t.diagnostic(line);
      const { failures, ms, sizes } = await runCase(c, exposeGc());
      t.diagnostic(`ms ${JSON.stringify(ms)}; sizes ${JSON.stringify(sizes)}`);
      assert.deepEqual(failures, []);
    });
  } else {
    const cases = Number(process.env.BCR_FUZZ_CASES) || DEFAULT_CASES;
    const first = Number(process.env.BCR_FUZZ_FROM) || 0;
    test(`fuzz: ${cases} mutated libraries through intake, reader, preview, dump, export and ZIP`, async (t) => {
      const started = performance.now();
      const { failures, opCounts, stats } = await runInChildren('bcr-fuzz', seed, first, first + cases, CASE_CAP_MS);
      t.diagnostic(`seed ${seed}: ${stats.cases} cases in ${Math.round(performance.now() - started)} ms; ${stats.exported} exported, ${stats.fatal} fatal, ${stats.isolated} isolation-checked; peak RSS ${Math.round(stats.maxRssMb)} MB`);
      t.diagnostic(`slowest: ${stats.slowest.map(([ms, i]) => `case ${i} ${Math.round(ms)} ms`).join(', ')}`);
      t.diagnostic(`most memory (held after reading, or peak while reading or exporting): ${stats.heaviest.map(([mb, i]) => `case ${i} ${mb} MB`).join(', ')}`);
      t.diagnostic(`raised the peak RSS most: ${stats.rssRaisers.map(([mb, i]) => `case ${i} +${mb} MB`).join(', ')}`);
      t.diagnostic(`mutations: ${Object.entries(opCounts).map(([op, n]) => `${op} ${n}`).join(', ')}`);
      // Distinct failures first (the same bug tends to show up in many cases).
      const distinct = new Map();
      for (const f of failures) {
        const key = f.text.split('\n')[0];
        if (!distinct.has(key)) distinct.set(key, f.text);
      }
      assert.deepEqual([...distinct.values()].slice(0, 15), [], `${failures.length} failing cases, ${distinct.size} distinct`);
      assert.equal(stats.cases, cases, 'every case ran');
      if (cases >= 1000) {
        for (const op of [...BYTE_OP_NAMES, ...(REAL_FUZZ ? [] : SPEC_OP_NAMES)]) assert.ok(opCounts[op] > 0, `mutation ${op} never ran`);
        assert.ok(stats.exported > cases * 0.3, 'enough cases reach the export');
        assert.ok(stats.isolated > cases * 0.1, 'enough cases get the isolation check');
      }
      assert.ok(stats.maxRssMb < RSS_CAP_MB, `peak RSS ${Math.round(stats.maxRssMb)} MB (see the cases that raised it most, above)`);
    });

    test('scale: work stays linear and output stays bounded when one dimension of a library is huge', { skip: REAL_FUZZ ? 'BCR_FUZZ_REAL=1: the real samples only' : false }, async (t) => {
      const { failures, details } = await runInChildren('bcr-scale', seed, 0, SCALE_CASES.length, 12 * CASE_CAP_MS);
      for (let i = 0; i < SCALE_CASES.length; i++) {
        const sc = SCALE_CASES[i];
        const d = details.get(i);
        const mine = failures.filter((f) => f.i === i).map((f) => f.text);
        await t.test(`${sc.name} (${sc.owner})`, sc.todo ? { todo: sc.todo } : {}, (st) => {
          if (d) st.diagnostic(`ms ${JSON.stringify(Object.fromEntries(Object.entries(d.ms).map(([k, v]) => [k, Math.round(Number(v))])))}; sizes ${JSON.stringify(d.sizes)}`);
          assert.deepEqual(mine, []);
        });
      }
    });

    test('the checks catch what they are for', () => {
      // XML: well-formed passes; a bare '&', an unclosed element, a control character and a stray '<' fail.
      assert.equal(checkXml('<?xml version="1.0"?>\n<gpx a="1"><wpt lat="1"><name>A &amp; B</name></wpt><trk/></gpx>\n').error, null);
      assert.deepEqual([...checkXml('<?xml version="1.0"?><gpx><wpt/><wpt/><trk/></gpx>').topLevel], [['wpt', 2], ['trk', 1]]);
      for (const bad of ['<gpx><name>A & B</name></gpx>', '<gpx><name>A</gpx>', '<gpx><name>\u0001</name></gpx>', '<gpx><name>a < b</name></gpx>', '<gpx></gpx><gpx></gpx>']) {
        assert.notEqual(checkXml(`<?xml version="1.0"?>${bad}`).error, null, bad);
      }
      // ZIP: a flipped CRC is caught.
      const entry = utf8.encode('hello');
      const name = utf8.encode('a.txt');
      const local = cat([0x50, 0x4b, 3, 4, 20, 0, 0, 8, 0, 0, 0, 0, 0, 0], le32(crc32(entry) ^ 1), le32(5), le32(5), [name.length, 0, 0, 0], name, entry);
      const central = cat([0x50, 0x4b, 1, 2, 20, 0, 20, 0, 0, 8, 0, 0, 0, 0, 0, 0], le32(crc32(entry) ^ 1), le32(5), le32(5), [name.length, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], le32(0), name);
      const end = cat([0x50, 0x4b, 5, 6, 0, 0, 0, 0, 1, 0, 1, 0], le32(central.length), le32(local.length), [0, 0]);
      /** @type {string[]} */
      const zipFailures = [];
      readZip(cat(local, central, end), (f) => zipFailures.push(f));
      assert.deepEqual(zipFailures, ['zip: an entry has the wrong CRC-32']);
      // Isolation: an item that changed is caught; the same item passes.
      const { built, expected } = scenario('minimal');
      const want = expected.items[0];
      const item = want.kind === 'waypoint' ? { kind: 'waypoint', id: 'w0', name: want.name, comment: want.comment, icon: want.icon, lat: want.lat, lon: want.lon, ele: want.ele, time: want.time } : null;
      assert.ok(item, 'the minimal scenario starts with a waypoint');
      const c = /** @type {any} */ ({ expected: { items: [want] }, local: { kind: 'gfi' }, manifest: built.manifest });
      /** @type {string[]} */
      const ok = [];
      checkIsolation(c, /** @type {any} */ ({ items: [item] }), (f) => ok.push(f));
      assert.deepEqual(ok, []);
      /** @type {string[]} */
      const moved = [];
      checkIsolation(c, /** @type {any} */ ({ items: [{ ...item, lat: item.lat + 0.001 }] }), (f) => moved.push(f));
      assert.match(moved[0] ?? '', /no longer matches the writer/);
      // Messages: a name or a placeholder in a problem is caught.
      /** @type {string[]} */
      const msg = [];
      checkMessage({ code: 'x', message: `The list ${TOKEN} could not be read.`, count: 1 }, 'test', (f) => msg.push(f));
      checkMessage({ code: 'y', message: 'Some # bytes were skipped.', count: 1 }, 'test', (f) => msg.push(f));
      assert.equal(msg.length, 2);
    });
  }
}
