// Export speed and memory (src/app/pipeline.js with src/export/zip.js, gpx.js and kml.js).
//
// Each run happens in a child process, so its peak resident memory (process.resourceUsage().maxRSS) belongs to the
// run alone and not to the test runner. The library is written to a temporary folder first and handed over as
// file-backed Blobs (fs.openAsBlob), like the File objects a browser passes in, so the input bytes are not counted
// as memory either. The peak is read twice: after parsing and after exporting; the difference is the export's.
//
//   node --test test/perf.test.js                 quarter-size library and a 192 MB stream (memory only; always on)
//   BCR_PERF=1 node --test test/perf.test.js      also the full-size run: 20k waypoints, 2k tracks × 2k points with
//                                                 elevation and time, 500 lists, KML on; prints "perf (full): …"
//   BCR_PERF_KML=0                                leaves the KML out of the full-size run
//
// Measured on the maintainer's Mac (Node 26, normal priority), 2026-10-06. Full size: export 15.4 s and a peak of
// 2.9 GB with the old writer (every file held as bytes, then deflated); about 4.9 s with the streaming writer. Its
// peak is about 690 MB, but parsing alone reaches about 450 MB before the export starts (src/format; the reader's
// budget, not this one); the export adds about 230 MB, 137 MB of which is the finished ZIP itself. Quarter size:
// the export added 596 MB to the peak with the old writer and 141 MB with the streaming one.
// Timings are only asserted in the opt-in run: a machine under load (background priority) is slower.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

const CHILD = process.env.BCR_PERF_CHILD;
if (CHILD) {
  const job = JSON.parse(CHILD);
  const result = job.kind === 'stream' ? await childStream(job) : await childExport(job);
  process.stdout.write(`PERF ${JSON.stringify(result)}\n`);
} else {
  test('memory: exporting a quarter-size library adds far less to the peak than the text it writes', () => {
    const r = measure({ waypoints: 5000, tracks: 500, points: 2000, lists: 125, kml: true });
    console.log(describe('quarter', r));
    assert.deepEqual(r.totals, { folders: 0, lists: 125, waypoints: 5000, tracks: 500, routes: 0 });
    assert.ok(r.uncompressedMB > 280, `the export writes ${r.uncompressedMB} MB of GPX and KML text`);
    // Old writer: +596 MB (peak 801 MB). Streaming writer: +141 MB (peak 346 MB).
    assert.ok(r.maxRssMB - r.parsePeakMB < 300, `the export raised the peak by ${r.maxRssMB - r.parsePeakMB} MB`);
    assert.ok(r.maxRssMB < 500, `peak RSS ${r.maxRssMB} MB`);
  });

  test('memory: a 192 MB stream through ZipWriter keeps only its compressed bytes', () => {
    const r = run({ kind: 'stream', mb: 192 });
    console.log(`perf (stream): ${r.textMB} MB of text in ${r.ms} ms, zip ${r.zipMB} MB, peak rss ${r.beforeMB} → ${r.afterMB} MB`);
    assert.ok(r.textMB >= 192);
    // Measured: +82 to +90 MB (an 18 MB ZIP plus garbage not yet collected). Holding the text would add 192 MB more.
    assert.ok(r.afterMB - r.beforeMB < 180, `the stream raised the peak by ${r.afterMB - r.beforeMB} MB`);
  });

  test(
    'performance: the full-size library exports in under 6 s',
    { skip: process.env.BCR_PERF !== '1' && 'set BCR_PERF=1 to run' },
    () => {
      const kml = process.env.BCR_PERF_KML !== '0';
      const r = measure({ waypoints: 20000, tracks: 2000, points: 2000, lists: 500, kml });
      console.log(describe('full', r));
      assert.deepEqual(r.totals, { folders: 0, lists: 500, waypoints: 20000, tracks: 2000, routes: 0 });
      assert.deepEqual(r.trackSegmentProblems, []);
      assert.ok(r.exportMs < 6000, `export took ${r.exportMs} ms`);
      assert.ok(r.maxRssMB - r.parsePeakMB < 300, `the export raised the peak by ${r.maxRssMB - r.parsePeakMB} MB`);
    },
  );
}

/**
 * @param {string} label
 * @param {any} r
 */
function describe(label, r) {
  return (
    `perf (${label}): parse ${r.parseMs} ms, export ${r.exportMs} ms, zip ${r.zipMB} MB from ${r.uncompressedMB} MB of text, ` +
    `peak rss ${r.parsePeakMB} MB after parsing, ${r.maxRssMB} MB after exporting`
  );
}

/**
 * Runs one job in a child process and returns what it printed.
 * @param {object} job
 * @returns {any}
 */
function run(job) {
  const child = spawnSync(process.execPath, [SELF], {
    env: { ...process.env, BCR_PERF_CHILD: JSON.stringify(job) },
    encoding: 'utf8',
    timeout: 300_000,
  });
  const line = (child.stdout ?? '').split('\n').find((l) => l.startsWith('PERF '));
  assert.ok(line, `child failed (status ${child.status}): ${child.stderr}`);
  return JSON.parse(line.slice(5));
}

/**
 * Writes the library to a temporary folder, exports it in a child process, and returns what it measured.
 * @param {{waypoints: number, tracks: number, points: number, lists: number, kml: boolean}} size
 */
function measure(size) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcr-perf-'));
  try {
    for (const [name, bytes] of largeLibrary(size)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), bytes);
    }
    return run({ kind: 'export', dir, kml: size.kml });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Peak resident memory so far, in MB (maxRSS is in KiB). */
function peakMB() {
  return Math.round((process.resourceUsage().maxRSS * 1024) / 1e6);
}

/**
 * The child: parse and export the library in `dir`.
 * @param {{dir: string, kml: boolean}} job
 */
async function childExport(job) {
  const { Pipeline } = await import('../src/app/pipeline.js');
  /** @param {string} rel */
  const ref = async (rel) => {
    const blob = await fs.openAsBlob(path.join(job.dir, rel));
    const name = path.basename(rel);
    return { name, path: name, size: blob.size, lastModified: null, blob, index: null, entryName: null };
  };
  const segments = fs.readdirSync(path.join(job.dir, 'TrackSegments'));
  const source = {
    kind: 'files',
    archive: null,
    allData: await ref('AllData.gdb'),
    folderData: await ref('FolderData.gfi'),
    trackSegments: await Promise.all(segments.map(async (n) => [n, await ref(`TrackSegments/${n}`)])),
    versionFolder: 'Database/4.8',
    version: '4.8',
  };
  /** @type {any[]} */
  const out = [];
  const pipeline = new Pipeline({ brand: 'Foldertrail', version: '0.1.0', post: (m) => out.push(m) });
  const t0 = performance.now();
  await pipeline.handle({ type: 'parse', id: 1, source });
  const t1 = performance.now();
  const parsePeakMB = peakMB();
  const parsed = out.find((m) => m.type === 'parsed');
  if (!parsed) throw new Error(JSON.stringify(out.find((m) => m.type === 'error')));
  await pipeline.handle({ type: 'export', id: 1, options: { kml: job.kml, perItem: false } });
  const t2 = performance.now();
  const maxRssMB = peakMB(); // before reading the ZIP back, which is this test's own cost
  const exported = out.find((m) => m.type === 'exported');
  if (!exported) throw new Error(JSON.stringify(out.find((m) => m.type === 'error')));
  const zip = new Uint8Array(await exported.zip.arrayBuffer());
  return {
    parseMs: Math.round(t1 - t0),
    exportMs: Math.round(t2 - t1),
    parsePeakMB,
    maxRssMB,
    zipMB: round1(zip.length / 1e6),
    uncompressedMB: round1(uncompressedSize(zip) / 1e6),
    totals: parsed.preview.totals,
    trackSegmentProblems: parsed.preview.problems.filter((/** @type {any} */ p) => p.code.startsWith('track_segments')),
  };
}

/**
 * The child: `mb` MB of made-up track points, one 1000-point string at a time, through one ZipWriter entry.
 * @param {{mb: number}} job
 */
async function childStream(job) {
  const { ZipWriter } = await import('../src/export/zip.js');
  let produced = 0;
  function* pieces() {
    for (let i = 0; produced < job.mb * 1e6; ) {
      let s = '';
      for (const end = i + 1000; i < end; i++) {
        s += `      <trkpt lat="${(45 + i * 1e-7).toFixed(7)}" lon="${(7 + (i % 9973) * 1e-6).toFixed(7)}">\n        <ele>${i % 3000}.5</ele>\n      </trkpt>\n`;
      }
      produced += s.length;
      yield s;
    }
  }
  const beforeMB = peakMB();
  const t0 = performance.now();
  const writer = new ZipWriter();
  await writer.add('big.gpx', pieces());
  const zip = new Blob(await writer.finish());
  const ms = Math.round(performance.now() - t0);
  return { textMB: Math.round(produced / 1e6), ms, zipMB: round1(zip.size / 1e6), beforeMB, afterMB: peakMB() };
}

/** @param {number} x */
function round1(x) {
  return Math.round(x * 10) / 10;
}

/**
 * Sum of the uncompressed sizes in a ZIP's central directory (ZIP64 sizes included).
 * @param {Uint8Array} zip
 */
function uncompressedSize(zip) {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = zip.length - 22;
  while (eocd >= 0 && v.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('no end of central directory');
  let count = v.getUint16(eocd + 10, true);
  let at = v.getUint32(eocd + 16, true);
  if (count === 0xffff || at === 0xffffffff) {
    const z64 = Number(v.getBigUint64(eocd - 20 + 8, true));
    count = Number(v.getBigUint64(z64 + 32, true));
    at = Number(v.getBigUint64(z64 + 48, true));
  }
  let total = 0;
  for (let k = 0; k < count; k++) {
    if (v.getUint32(at, true) !== 0x02014b50) throw new Error('bad central header');
    let size = v.getUint32(at + 24, true);
    const nameLength = v.getUint16(at + 28, true);
    const extra = v.getUint16(at + 30, true);
    const comment = v.getUint16(at + 32, true);
    if (size === 0xffffffff) {
      let e = at + 46 + nameLength;
      while (e < at + 46 + nameLength + extra) {
        if (v.getUint16(e, true) === 1) {
          size = Number(v.getBigUint64(e + 4, true));
          break;
        }
        e += 4 + v.getUint16(e + 2, true);
      }
    }
    total += size;
    at += 46 + nameLength + extra + comment;
  }
  return total;
}

// ---------------------------------------------------------------------------------------------
// The synthetic library (FORMAT.md §3, §5, §6, §8, §9): every name, position and time is made up.

/**
 * Writes a synthetic library straight into typed arrays: `waypoints` waypoints and `tracks` tracks of `points`
 * points each (with elevation and time), spread over `lists` lists in one folder.
 * @param {{waypoints: number, tracks: number, points: number, lists: number}} size
 * @returns {Map<string, Uint8Array>}  paths relative to Database/<version>
 */
function largeLibrary(size) {
  const enc = new TextEncoder();
  const header = (/** @type {string} */ sig) => {
    const author = enc.encode('perf\x00Jan 01 2026\x0000:00:00\x00');
    const app = enc.encode('BaseCamp\x00');
    const b = new Uint8Array(18 + 2 + author.length + app.length);
    const v = new DataView(b.buffer);
    b.set(enc.encode(sig), 0);
    v.setUint16(4, 0x66, true);
    v.setUint32(6, 2, true);
    b[10] = 0x44;
    v.setUint16(11, 188, true);
    v.setUint32(13, 2 + author.length, true);
    b[17] = 0x41;
    v.setUint16(18, 407, true);
    b.set(author, 20);
    b.set(app, 20 + author.length);
    return b;
  };
  /** @type {Uint8Array[]} */
  const gdbParts = [header('MsRc')];
  const frame = (/** @type {string} */ type, /** @type {Uint8Array} */ body) => {
    const f = new Uint8Array(5 + body.length);
    new DataView(f.buffer).setUint32(0, body.length, true);
    f[4] = type.charCodeAt(0);
    f.set(body, 5);
    gdbParts.push(f);
  };
  const semi = (/** @type {number} */ d) => Math.round((d * 2 ** 31) / 180);
  for (let i = 0; i < size.waypoints; i++) {
    const name = enc.encode(`Waypoint ${i}`);
    const body = new Uint8Array(name.length + 1 + 4 + 8 + 1 + 1 + 4 + 4 + 33);
    const v = new DataView(body.buffer);
    body.set(name, 0);
    const at = name.length + 1 + 4;
    v.setInt32(at, semi(45 + (i % 1000) * 0.001), true);
    v.setInt32(at + 4, semi(7 + Math.floor(i / 1000) * 0.001), true);
    frame('W', body);
  }
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  const n = size.points;
  for (let t = 0; t < size.tracks; t++) {
    const name = enc.encode(`Track ${t}`);
    const uuid = `00000000-0000-4000-8000-${String(t).padStart(12, '0')}`;
    const lat0 = semi(45 + (t % 100) * 0.01);
    const lon0 = semi(7 + Math.floor(t / 100) * 0.01);
    const fixed = name.length + 1 + 1 + 4 + 4 + 4 + 1 + 8 + 1 + 1 + 16 + 1 + 8 + 1 + 4 + 4;
    const body = new Uint8Array(fixed + 21 + 8 * n + 4 + 37);
    const v = new DataView(body.buffer);
    body.set(name, 0);
    let at = name.length + 1;
    body[at] = 1;
    at += 1 + 4 + 4 + 4 + 1 + 8 + 1 + 1;
    const maxLat = lat0 + (n - 1) * 100;
    const maxLon = lon0 + (n - 1) * 100;
    v.setInt32(at, maxLat, true);
    v.setInt32(at + 4, maxLon, true);
    v.setInt32(at + 8, lat0, true);
    v.setInt32(at + 12, lon0, true);
    at += 16 + 1 + 8 + 1 + 4;
    v.setUint32(at, 1, true);
    at += 4 + 1;
    v.setInt32(at, maxLat, true);
    v.setInt32(at + 4, maxLon, true);
    v.setInt32(at + 8, lat0, true);
    v.setInt32(at + 12, lon0, true);
    v.setUint32(at + 16, n, true);
    at += 20;
    for (let k = 0; k < n; k++, at += 8) {
      v.setInt32(at, lat0 + k * 100, true);
      v.setInt32(at + 4, lon0 + k * 100, true);
    }
    v.setUint32(at, n, true);
    body.set(enc.encode(uuid), at + 4);
    frame('T', body);
    const head = header('MsRc');
    const ts = new Uint8Array(head.length + 4 + 29 * n); // fdouble 9 + fint 5 + 15 further bytes
    ts.set(head, 0);
    const tv = new DataView(ts.buffer);
    tv.setUint32(head.length, n, true);
    let p = head.length + 4;
    for (let k = 0; k < n; k++, p += 29) {
      ts[p] = 1;
      tv.setFloat64(p + 1, 500 + k * 0.5, true);
      ts[p + 9] = 1;
      tv.setInt32(p + 10, 1700000000 + k * 5, true);
    }
    files.set(`TrackSegments/${uuid}`, ts);
  }
  frame('X', enc.encode('EndOfFile\x00'));
  files.set('AllData.gdb', concat(gdbParts));

  /** @type {Uint8Array[]} */
  const gfiParts = [header('DifG')];
  const gframe = (/** @type {string} */ type, /** @type {number[]} */ bytes) => {
    const f = new Uint8Array(5 + bytes.length);
    new DataView(f.buffer).setUint32(0, bytes.length, true);
    f[4] = type.charCodeAt(0);
    f.set(bytes, 5);
    gfiParts.push(f);
  };
  const u32 = (/** @type {number} */ x) => [x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff, (x >>> 24) & 0xff];
  const cstr = (/** @type {string} */ s) => [...enc.encode(s), 0];
  const children = [];
  for (let l = 0; l < size.lists; l++) children.push(...u32(0), ...u32(l));
  gframe('F', [...u32(0xffffffff), ...cstr('My Collection'), ...u32(0xffffffff), ...u32(size.lists), ...children, 1]);
  for (let l = 0; l < size.lists; l++) gframe('I', [...u32(l), ...cstr(`List ${l}`), ...u32(0), ...u32(0xffffffff)]);
  for (let t = 0; t < size.tracks; t++) gframe('T', [...u32(t % size.lists), ...cstr(`Track ${t}`), ...u32(0)]);
  for (let i = 0; i < size.waypoints; i++) gframe('W', [...u32(i % size.lists), ...cstr(`Waypoint ${i}`), ...u32(0)]);
  files.set('FolderData.gfi', concat(gfiParts));
  return files;
}

/** @param {Uint8Array[]} parts */
function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
