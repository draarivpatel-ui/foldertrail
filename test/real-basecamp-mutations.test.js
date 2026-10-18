// Adversarial checks of the H-MAC48 reader on REAL BaseCamp 4.8.13 output (testdata/basecamp-real/, made-up content
// only): the sample is damaged in memory (bytes flipped, records truncated, files cut short, fields set to values the
// layout refuses) and the reader must degrade honestly:
//   1. nothing throws and nothing hangs;
//   2. an item that is still converted has the values of the undamaged sample, unless the damaged byte is in that
//      item's own record or TrackSegments file (a byte of a name, position or time cannot be told from a real one: the
//      format has no checksums), or in a route's via-point waypoint record (FORMAT.md §15.11: its position and icon
//      feed the route); and an item may move to "Duplicate names" (reported) when a damaged record now carries its
//      name, since FolderData.gfi links items by name (FORMAT.md §10);
//   3. an item that is lost is named in "not converted", or the report gains a problem that says so;
//   4. no single changed byte makes a record switch from one accepted layout to another, and the structure dump
//      (dump.js) and the reader agree on every damaged record;
//   5. (decision B43) the record parsers get the program version AllData.gdb's header gives (408 in both samples), as
//      the reader does, so a damaged route point count can no longer leave H-OP reading a shorter route.
// What is accepted ON PURPOSE, and pinned here so a change is noticed: the waypoint's last 8 bytes and the route's
// last 10 bytes are never checked (FORMAT.md §15.11), and a record cut back to an older layout's length can be read
// under that layout (see the truncation test).
//
// The full byte-by-byte library sweep (about 30,000 libraries, a few minutes) is opt-in:
//   env BCR_REAL_SWEEP=1 node --test test/real-basecamp-mutations.test.js
// Without it, the library sweep takes every 3rd byte with one flip, and every 7th length.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { intake, toWorkerSource, fromWorkerSource } from '../src/app/intake.js';
import { readLibrary, LIBRARY_PROBLEMS } from '../src/format/library.js';
import { exportLibrary } from '../src/app/pipeline.js';
import { readContainer, readHeader, chooseLayout } from '../src/format/container.js';
import { parseWaypoint, parseTrack, parseRoute, Counts } from '../src/format/gdb.js';
import { DEFAULT_LAYOUTS } from '../src/format/dump.js';
import { mapRecord } from '../tools/hexmap.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REAL = join(HERE, '..', 'testdata', 'basecamp-real');
const RUNS = /** @type {const} */ (['run1-gate1', 'run2-structured']);
const FULL = process.env.BCR_REAL_SWEEP === '1';

/** @param {string} run @returns {Map<string, Uint8Array>} relative path → bytes ("AllData.gdb", "TrackSegments/<uuid>") */
function loadRun(run) {
  const root = join(REAL, run, '4.8');
  /** @type {Map<string, Uint8Array>} */
  const out = new Map();
  const walk = (/** @type {string} */ dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.set(relative(root, path).split('\\').join('/'), new Uint8Array(readFileSync(path)));
    }
  };
  walk(root);
  return out;
}

/**
 * The app's path: a webkitdirectory file list → intake → worker source (structured-cloned) → readLibrary. When intake
 * refuses the files (an AllData.gdb too short to be one, say), its problems are returned instead.
 * @param {Map<string, Uint8Array>} files
 * @returns {Promise<any>}
 */
async function readOrRefuse(files) {
  const list = [...files].map(([rel, bytes]) => {
    const file = new File([bytes], rel.split('/').pop() ?? rel, { lastModified: 1000 });
    Object.defineProperty(file, 'webkitRelativePath', { value: `4.8/${rel}` });
    return file;
  });
  const found = await intake(list);
  if (!found.ok) return { refused: found.problems };
  const revived = await fromWorkerSource(structuredClone(toWorkerSource(found.found)));
  return readLibrary(revived.found);
}

/** @param {Map<string, Uint8Array>} files */
async function readFiles(files) {
  const read = await readOrRefuse(files);
  assert.equal(read.refused, undefined, 'intake took the files');
  return read;
}

/** @param {any} item */
const keyOf = (item) => `${item.kind}:${item.name}`;
/** The exported values of an item (ids differ between reads). @param {any} item */
const valuesOf = (item) => JSON.stringify(item, (k, v) => (k === 'id' ? undefined : ArrayBuffer.isView(v) ? Array.from(v) : v));
/** @param {any} library @returns {Map<string, string>} item key → its lists, by name */
function listsOf(library) {
  const byId = new Map(library.items.map((/** @type {any} */ i) => [i.id, i]));
  /** @type {Map<string, string[]>} */
  const out = new Map();
  for (const f of library.folders) for (const id of f.itemIds) out.set(keyOf(byId.get(id)), [...(out.get(keyOf(byId.get(id))) ?? []), f.name]);
  return new Map([...out].map(([k, v]) => [k, v.sort().join('|')]));
}
/** @param {any} library */
const reportCounts = (library) => new Map(library.problems.filter((/** @type {any} */ p) => p.level === 'report').map((/** @type {any} */ p) => [p.code, p.count]));
/** @param {any} library */
const problemCounts = (library) => Object.fromEntries(library.problems.map((/** @type {any} */ p) => [p.code, p.count]));

/** @param {Uint8Array} bytes @param {string} role */
function records(bytes, role) {
  const c = readContainer(bytes, { role });
  assert.equal(c.ok, true);
  return c.records.map((r) => ({ ...r, body: bytes.subarray(r.bodyOffset, r.bodyOffset + r.length) }));
}

/** The leading cstr of a body, as text. @param {Uint8Array} body */
function leadingName(body) {
  const end = body.indexOf(0);
  return new TextDecoder().decode(body.subarray(0, end < 0 ? body.length : end));
}

/**
 * A copy of a container file with one record's body replaced (its u32 length rewritten; container.js frames a record
 * as u32 length, u8 type, body).
 * @param {Uint8Array} file
 * @param {{offset: number, bodyOffset: number, length: number}} rec
 * @param {Uint8Array} body
 */
function withBody(file, rec, body) {
  const out = new Uint8Array(file.length - rec.length + body.length);
  out.set(file.subarray(0, rec.bodyOffset));
  out.set(body, rec.bodyOffset);
  out.set(file.subarray(rec.bodyOffset + rec.length), rec.bodyOffset + body.length);
  new DataView(out.buffer).setUint32(rec.offset, body.length, true);
  return out;
}

/** Offset of a field inside a record body, by the hexmap tool's field name (tools/hexmap.js, FORMAT.md §15). */
function fieldOffset(/** @type {'W'|'T'|'R'} */ type, /** @type {Uint8Array} */ body, /** @type {string} */ name) {
  const line = mapRecord('gdb', type, body).lines.find((l) => l.name === name);
  assert.ok(line, `${type} field "${name}"`);
  return line.off;
}

/** Mac BaseCamp 4.8.13's program version, as both samples' AllData.gdb header gives it (FORMAT.md §15.1). */
const MAC48 = 408;
const parsers = { W: parseWaypoint, T: parseTrack, R: parseRoute };
/** Parses a record as the reader does for these samples: with their program version (B43). */
const parse = (/** @type {'W'|'T'|'R'} */ type, /** @type {Uint8Array} */ body) => parsers[type](body, new Counts(), MAC48);
/** Whether a parse result is used: a layout chosen for W and T, status ok for R. @param {string} type @param {any} p */
const used = (type, p) => (type === 'R' ? p.status === 'ok' : p.layout !== null);
/** @param {any} p */
const parsedValues = (p) =>
  JSON.stringify({ ...p, accepted: undefined, layout: undefined, decision: undefined, prefixFailure: undefined }, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v));
/** Layouts the structure dump accepts for a body (exact fit, every check passed). @param {'W'|'T'|'R'} type @param {Uint8Array} body */
const dumpAccepts = (type, body) =>
  DEFAULT_LAYOUTS.gdb[type].filter((l) => {
    const r = l.walk(body);
    return r.outcome === 'exact' && r.checks.length === 0;
  }).map((l) => l.label);

// ---------------------------------------------------------------------------------------------
// 1. Every byte of every W, T and R record, one at a time

for (const run of RUNS) {
  test(`${run}: no changed byte in a W, T or R record throws, switches layout, or makes the dump and the reader disagree`, () => {
    const gdb = loadRun(run).get('AllData.gdb');
    assert.ok(gdb);
    let tried = 0;
    let refused = 0;
    /** @type {string[]} */
    const problems = [];
    for (const rec of records(gdb, 'gdb')) {
      const type = /** @type {'W'|'T'|'R'} */ (rec.type);
      if (!(type in parsers)) continue;
      const base = parse(type, rec.body);
      assert.equal(base.layout, 'H-MAC48', `${type} ${base.name}: the undamaged record`);
      for (let i = 0; i < rec.body.length; i++) {
        for (const v of new Set([rec.body[i] ^ 0x01, rec.body[i] ^ 0x02, rec.body[i] ^ 0x80, 0x00, 0xff])) {
          if (v === rec.body[i]) continue;
          const body = rec.body.slice();
          body[i] = v;
          tried++;
          const p = parse(type, body);
          const where = `${type} "${base.name}" byte ${i} ${rec.body[i]}→${v}`;
          // The dump and the reader read the same layouts and choose alike (B43: both call chooseLayout). For R, only
          // H-MAC48 is compared: the dump's H-OP walker also reads the trailer, which the reader's H-OP rule skips (§7.4).
          const dump = dumpAccepts(type, body);
          if (type === 'R') {
            if ((p.layout === 'H-MAC48') !== dump.includes('H-MAC48')) problems.push(`${where}: reader ${p.layout}, dump ${dump}`);
          } else {
            if (dump.length !== p.accepted) problems.push(`${where}: reader fits ${p.accepted}, dump ${dump}`);
            if (chooseLayout(type, dump, MAC48).layout !== p.layout) problems.push(`${where}: reader ${p.layout}, dump ${dump}`);
          }
          if (!used(type, p)) {
            refused++;
            continue;
          }
          if (p.layout !== base.layout) problems.push(`${where}: switched ${base.layout} → ${p.layout}`);
        }
      }
    }
    assert.deepEqual(problems, []);
    assert.ok(tried > 15_000 && refused > 5_000, `tried ${tried}, refused ${refused}`);
  });

  test(`${run}: a W, T or R record cut short is refused, except a cut back to an older layout's length`, () => {
    const gdb = loadRun(run).get('AllData.gdb');
    assert.ok(gdb);
    /** @type {string[]} */
    const accepted = [];
    for (const rec of records(gdb, 'gdb')) {
      const type = /** @type {'W'|'T'|'R'} */ (rec.type);
      if (!(type in parsers)) continue;
      const base = parse(type, rec.body);
      for (let k = 0; k < rec.body.length; k++) {
        const p = parse(type, rec.body.slice(0, k));
        if (!used(type, p)) continue;
        const same = parsedValues(p) === parsedValues(base);
        accepted.push(`${type} ${base.name} cut by ${rec.body.length - k}: ${p.layout}${same ? '' : ', other values'}`);
      }
    }
    // H-MAC48 = H-KBM + 8 bytes (W) or + 24/40 bytes (T), so cutting those off leaves a valid H-KBM record with the
    // same values. Three timed waypoints cut by 28 bytes also fit H-OP, with OTHER values: a record whose length field
    // and body were both cut would be read wrongly. Two coordinated changes, never seen; kept as an open item
    // (Gate 1 run 1), pinned here so a change to the layouts shows up.
    const cutToKbm = accepted.filter((a) => /: H-KBM$/.test(a));
    assert.equal(cutToKbm.length, 17, accepted.join('\n'));
    for (const a of cutToKbm) assert.match(a, /^(W .* cut by 8|T Gate1 Track Bare cut by 24|T .* cut by 40): H-KBM$/);
    const toOp = accepted.filter((a) => /: H-OP/.test(a));
    assert.deepEqual(
      toOp.filter((a) => a.endsWith('other values')).sort(),
      ['W Gate1 Waypoint Alpha cut by 28: H-OP, other values', 'W Gate1 Waypoint Echo cut by 28: H-OP, other values', 'W Gate1 Waypoint Foxtrot cut by 28: H-OP, other values'],
    );
    assert.equal(accepted.length, cutToKbm.length + toOp.length, 'nothing else is accepted');
    assert.ok(!accepted.some((a) => a.startsWith('R ')), 'a route cut short is never read');
  });
}

// ---------------------------------------------------------------------------------------------
// 2. Targeted damage to the fields the Mac 4.8 layout added

const RUN1 = loadRun('run1-gate1');
const BASE = await readFiles(RUN1);

test('the undamaged run1 sample, for reference: 14 items, nothing lost, two report-level notes', () => {
  assert.equal(BASE.library.items.length, 14);
  assert.deepEqual(BASE.library.notConverted, []);
  assert.deepEqual(problemCounts(BASE.library), { smart_lists_left_out: 2, track_sensor_data_kept: 1, route_via_point_record: 4 });
});

/**
 * run1 with one GDB record's body changed.
 * @param {'W'|'T'|'R'} type
 * @param {string} name
 * @param {(body: Uint8Array) => Uint8Array} change
 */
async function withRecord(type, name, change) {
  const gdb = /** @type {Uint8Array} */ (RUN1.get('AllData.gdb'));
  const rec = records(gdb, 'gdb').find((r) => r.type === type && leadingName(r.body) === name);
  assert.ok(rec, `${type} ${name}`);
  const files = new Map(RUN1);
  files.set('AllData.gdb', withBody(gdb, rec, change(rec.body.slice())));
  return readFiles(files);
}

/** Every item but `except` is exactly as in the undamaged sample. @param {any} read @param {string[]} except */
function othersUnchanged(read, except) {
  const items = new Map(read.library.items.map((/** @type {any} */ i) => [keyOf(i), i]));
  for (const item of BASE.library.items) {
    if (except.includes(keyOf(item))) continue;
    const got = items.get(keyOf(item));
    assert.ok(got, `${keyOf(item)} is still there`);
    assert.equal(valuesOf(got), valuesOf(item), `${keyOf(item)} unchanged`);
  }
}

test('a per-track flag that is not 0 or 1: that track is not converted, is named with its reason, and nothing else moves', async () => {
  const read = await withRecord('T', 'Gate1 Track Sensors', (b) => {
    b[fieldOffset('T', b, 'per-track flags (11 bytes)') + 4] = 2;
    return b;
  });
  assert.deepEqual(read.library.notConverted.map((/** @type {any} */ n) => [n.kind, n.name, n.reason]), [['track', 'Gate1 Track Sensors', 'track_not_decoded']]);
  assert.equal(reportCounts(read.library).get('track_not_decoded'), 1);
  othersUnchanged(read, ['track:Gate1 Track Sensors']);
  // Its TrackSegments file now belongs to no track; the sensor note goes with it.
  assert.equal(problemCounts(read.library).track_sensor_data_kept, undefined);
  assert.equal(problemCounts(read.library).track_segments_unused, 1);
});

test('the opaque bytes of the track tail, and the "A"/"B" values, are not checked; their flags are', async () => {
  const opaque = await withRecord('T', 'Gate1 Track Timed', (b) => {
    const at = fieldOffset('T', b, 'unknown (8 bytes, Mac 4.8)');
    b.fill(0xab, at, at + 8);
    const head = fieldOffset('T', b, 'unknown (3 bytes)');
    b.fill(0xcd, head, head + 3);
    return b;
  });
  othersUnchanged(opaque, []);
  const flag = await withRecord('T', 'Gate1 Track Timed', (b) => {
    b[fieldOffset('T', b, 'ascent? (m)')] = 7; // the fdouble's presence flag
    return b;
  });
  assert.deepEqual(flag.library.notConverted.map((/** @type {any} */ n) => n.name), ['Gate1 Track Timed']);
});

test('a non-zero byte in a route point\'s 19-byte run, or the autoroute-settings flag set: the route is named as not converted, never as "road-following"', async () => {
  for (const [what, change] of /** @type {Array<[string, (b: Uint8Array) => void]>} */ ([
    ['19-byte run', (b) => (b[fieldOffset('R', b, 'point 2: unknown (19 bytes)') + 12] = 1)],
    ['autoroute settings', (b) => (b[fieldOffset('R', b, 'autoroute settings present')] = 1)],
  ])) {
    const read = await withRecord('R', 'Gate1 Route Four', (b) => {
      change(b);
      return b;
    });
    assert.deepEqual(read.library.notConverted.map((/** @type {any} */ n) => [n.kind, n.name, n.reason]), [['route', 'Gate1 Route Four', 'route_not_decoded']], what);
    assert.equal(reportCounts(read.library).get('route_not_converted'), 1, what);
    othersUnchanged(read, ['route:Gate1 Route Four']);
  }
});

/** run1's route record and the body offsets of its four via points (FORMAT.md §15.5). */
function run1Route() {
  const gdb = /** @type {Uint8Array} */ (RUN1.get('AllData.gdb'));
  const rec = records(gdb, 'gdb').find((r) => r.type === 'R');
  assert.ok(rec);
  const body = rec.body;
  const starts = [1, 2, 3, 4].map((k) => fieldOffset('R', body, `point ${k}: name`));
  const trailer = fieldOffset('R', body, 'no bounds');
  /** @type {Array<[number, number]>} */
  const points = starts.map((at, k) => [at, k < 3 ? starts[k + 1] : trailer]);
  return { body, count: fieldOffset('R', body, 'route point count'), points, trailer };
}

test('the route\'s point count damaged downwards (4 → 0, 1, 2, 3) is refused on run1, whatever the next via point\'s name holds (B43)', () => {
  const { body: real, count: at, points } = run1Route();
  assert.equal(new DataView(real.buffer, real.byteOffset).getUint32(at, true), 4);
  for (const n of [0, 1, 2, 3]) {
    const body = real.slice();
    body[at] = n;
    const p = parse('R', body);
    // H-MAC48 runs out of step; H-OP (which stops before the trailer) reads the next via point's name as bounds and
    // refuses its latitude.
    assert.deepEqual([p.status, p.accepted, p.points.length], ['not_decoded', 0, 0], `count ${n}`);
  }
  // Before B43 this was a known weakness: with the second via point's third character below 0x40 (here a space), H-OP
  // read the count damaged to 1 as a one-point route and dropped the other via points without a word. In a file whose
  // header says 408, a route only H-OP decodes is now refused ("not_for_version"), and the reader counts it.
  const body = real.slice();
  const second = points[1][0];
  body[second + 2] = 0x20;
  assert.equal(parse('R', body).layout, 'H-MAC48', 'the changed name alone is still read fully');
  body[at] = 1;
  const counts = new Counts();
  const p = parseRoute(body, counts, MAC48);
  assert.deepEqual([p.status, p.layout, p.accepted, p.decision, p.points.length], ['not_decoded', null, 1, 'not_for_version', 0]);
  assert.equal(counts.get('route_op_only_in_mac48_file'), 1);
  // Without the header's word (no program version, or a version that is not 408) H-OP's rule is as before: an older
  // BaseCamp's route is only ever read by H-OP, so there it stays the only rule (FORMAT.md §7.4).
  for (const version of [null, 407, 480]) {
    const old = parseRoute(body, new Counts(), version);
    assert.deepEqual([old.status, old.layout, old.points.map((v) => v.name)], ['ok', 'H-OP', ['Gate1 Via One']], `version ${version}`);
  }
});

test('the route\'s point count damaged downwards, swept over every value of every byte of the next via point: never a shorter route in a 408 file (B43)', () => {
  const { body: real, count: at, points } = run1Route();
  let tried = 0;
  let shortenedWithoutVersion = 0;
  /** @type {string[]} */
  const shortened = [];
  for (let n = 0; n < 4; n++) {
    const [from, to] = points[n];
    for (let i = from; i < to; i++) {
      for (let v = 0; v < 256; v++) {
        const body = real.slice();
        body[at] = n;
        body[i] = v;
        tried++;
        const p = parse('R', body);
        if (p.status === 'ok' && p.points.length !== 4) shortened.push(`count ${n}, byte ${i} = ${v}: ${p.layout}, ${p.points.length} points`);
        const old = parseRoute(body, new Counts(), null);
        if (old.status === 'ok' && old.points.length !== 4) shortenedWithoutVersion++;
      }
    }
  }
  assert.equal(tried, 256 * (points[3][1] - points[0][0]), 'every byte of the four via points, each swept for the count that makes it the next one');
  assert.deepEqual(shortened.slice(0, 5), []);
  // The same damage, read without the program version (H-OP's rule alone), shortens the route silently in many
  // cases: the sweep would catch a rule that brought that back.
  assert.ok(shortenedWithoutVersion > 50, `${shortenedWithoutVersion}`);
});

test('run1\'s route cut down to one real via point fits both route layouts: 408 reads it as H-MAC48, 407 as H-OP (the same point), no version refuses it (B43)', () => {
  const { body: real, count: at, points, trailer } = run1Route();
  for (const [k, name] of [[0, 'Gate1 Via One'], [1, 'Gate1 Via Two'], [2, 'Gate1 Via Three'], [3, 'Gate1 Via Four']]) {
    const [from, to] = points[/** @type {number} */ (k)];
    const body = new Uint8Array([...real.subarray(0, at), 1, 0, 0, 0, ...real.subarray(from, to), ...real.subarray(trailer)]);
    const mac = parseRoute(body, new Counts(), MAC48);
    assert.deepEqual([mac.status, mac.layout, mac.accepted, mac.decision, mac.points.map((p) => p.name)], ['ok', 'H-MAC48', 2, 'program_version', [name]]);
    const older = parseRoute(body, new Counts(), 407);
    assert.deepEqual([older.status, older.layout, older.decision], ['ok', 'H-OP', 'program_version']);
    assert.deepEqual(older.points, mac.points, 'both layouts read the same via point');
    for (const version of [null, 0, 409, 480, 4813]) {
      const counts = new Counts();
      const none = parseRoute(body, counts, version);
      assert.deepEqual([none.status, none.layout, none.accepted, none.decision], ['not_decoded', null, 2, 'several'], `version ${version}`);
      assert.equal(counts.get('route_several_layouts'), 1);
    }
  }
});

test('run1 through the app with its route cut down to its last via point: converted from the class-8 waypoint record, and the dump says why (B43)', async () => {
  const { points: offsets, count: at, trailer } = run1Route();
  const read = await withRecord('R', 'Gate1 Route Four', (b) => new Uint8Array([...b.subarray(0, at), 1, 0, 0, 0, ...b.subarray(offsets[3][0], offsets[3][1]), ...b.subarray(trailer)]));
  assert.deepEqual(read.library.notConverted, []);
  const route = /** @type {any} */ (read.library.items.find((/** @type {any} */ i) => i.kind === 'route'));
  const four = /** @type {any} */ (BASE.library.items.find((/** @type {any} */ i) => i.kind === 'route')).points[3];
  assert.deepEqual(route.points, [four], 'the one via point, where the undamaged route had it');
  assert.equal(problemCounts(read.library).route_layout_by_program_version, 1);
  othersUnchanged(read, ['route:Gate1 Route Four']);
});

test('a damaged name that now equals another track\'s: that track goes to "Duplicate names", and the report says why', async () => {
  // Found by the full sweep (BCR_REAL_SWEEP=1): the space in "Gate1 Twin Track 001" set to 0 ends the name early.
  const read = await withRecord('T', 'Gate1 Twin Track 001', (b) => {
    assert.equal(b[16], 0x20);
    b[16] = 0;
    return b;
  });
  assert.deepEqual(read.library.notConverted.map((/** @type {any} */ n) => [n.kind, n.name, n.reason]), [['track', 'Gate1 Twin Track', 'track_not_decoded']]);
  const twin = /** @type {any} */ (read.library.items.find((/** @type {any} */ i) => i.name === 'Gate1 Twin Track'));
  assert.deepEqual(read.library.ambiguous, [twin.id]);
  assert.equal(twin.segments.flat().length, 7, 'Twin B itself is unchanged');
  const told = reportCounts(read.library);
  for (const code of ['duplicate_names', 'track_not_decoded', 'listed_but_not_found']) assert.equal(told.get(code), 1, code);
  othersUnchanged(read, ['track:Gate1 Twin Track', 'track:Gate1 Twin Track 001']);
});

test('a two-point Mac 4.8 route can be built that H-OP also reads: both layouts accept it; the program version decides (B43)', () => {
  // an independent reviewer's construction, re-built here: two minimal points with no
  // links; in the second, bytes of the opaque run are set so that H-OP, reading 6 bytes where Mac 4.8 has 19, finds its
  // bounds flag and the 0xFF marker in step.
  const u32 = (/** @type {number} */ v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24];
  const zeros = (/** @type {number} */ n) => Array(n).fill(0);
  const ff = Array(8).fill(0xff);
  const first = [0, ...u32(8), 0, ...zeros(18), ...u32(0), 1, ...ff, ...zeros(19)];
  const second = [0, ...u32(8), 0, ...zeros(18), ...u32(0), 0, ...zeros(16), ...ff, ...zeros(19)];
  const trailer = [1, ...u32(0), ...u32(0), 0, 0, 0, ...u32(0), 1, 0, ...u32(6), ...zeros(10)];
  const clean = new Uint8Array([0, 0, ...u32(2), ...first, ...second, ...trailer]);
  assert.deepEqual([parseRoute(clean, new Counts()).layout, parseRoute(clean, new Counts()).accepted], ['H-MAC48', 1]);
  second[15] = 1;
  second.fill(0xff, 16, 24);
  const both = new Uint8Array([0, 0, ...u32(2), ...first, ...second, ...trailer]);
  assert.equal(both.length, 166);
  const counts = new Counts();
  const p = parseRoute(both, counts);
  assert.deepEqual([p.status, p.layout, p.accepted, p.decision], ['not_decoded', null, 2, 'several']);
  assert.equal(counts.map.get('route_several_layouts'), 1);
  // In a Mac 4.8 file H-MAC48, which reads the record to its end, decides; in an older one, H-OP.
  const mac = parseRoute(both, new Counts(), MAC48);
  assert.deepEqual([mac.status, mac.layout, mac.decision, mac.points.length], ['ok', 'H-MAC48', 'program_version', 2]);
  const older = parseRoute(both, new Counts(), 407);
  assert.deepEqual([older.status, older.layout, older.decision], ['ok', 'H-OP', 'program_version']);
});

test('by design, the waypoint\'s last 8 bytes and the route\'s last 10 bytes are never checked (FORMAT.md §15.11)', async () => {
  const wp = await withRecord('W', 'Gate1 Waypoint Bravo', (b) => {
    const at = fieldOffset('W', b, 'unknown (8 bytes, Mac 4.8)');
    b.fill(0xee, at, at + 8);
    return b;
  });
  othersUnchanged(wp, []);
  const route = await withRecord('R', 'Gate1 Route Four', (b) => {
    const at = fieldOffset('R', b, 'unknown (10 bytes, Mac 4.8)');
    b.fill(0x77, at, at + 10);
    return b;
  });
  othersUnchanged(route, []);
});

test('Unknown10 = 0 with its two positions: a latitude out of range is refused by the reader AND by the structure dump', () => {
  const gdb = /** @type {Uint8Array} */ (RUN1.get('AllData.gdb'));
  const rec = records(gdb, 'gdb').find((r) => r.type === 'R');
  assert.ok(rec);
  const at = fieldOffset('R', rec.body, 'unknown flag (OP Unknown10)');
  assert.equal(rec.body[at], 1);
  /** @param {number} lat semicircles */
  const withBounds = (lat) => {
    const body = new Uint8Array(rec.body.length + 16);
    body.set(rec.body.subarray(0, at));
    body[at] = 0;
    const view = new DataView(body.buffer);
    view.setInt32(at + 1, lat, true);
    view.setInt32(at + 9, 0, true);
    body.set(rec.body.subarray(at + 1), at + 17);
    return body;
  };
  const good = withBounds(2 ** 29);
  assert.equal(parseRoute(good, new Counts()).layout, 'H-MAC48');
  assert.deepEqual(dumpAccepts('R', good), ['H-MAC48']);
  const bad = withBounds(0x41000000);
  assert.equal(parseRoute(bad, new Counts()).status, 'not_decoded');
  assert.deepEqual(dumpAccepts('R', bad), [], 'the dump must not report an exact fit the reader refuses');
});

/** run1 with one TrackSegments file replaced. @param {string} track @param {(b: Uint8Array) => Uint8Array} change */
async function withSegments(track, change) {
  const t = /** @type {any} */ (BASE.library.items.find((/** @type {any} */ i) => i.name === track));
  const gdb = /** @type {Uint8Array} */ (RUN1.get('AllData.gdb'));
  const rec = records(gdb, 'gdb').find((r) => r.type === 'T' && leadingName(r.body) === track);
  assert.ok(t && rec);
  const uuid = /** @type {string} */ (parseTrack(rec.body, new Counts()).uuid);
  const name = /** @type {string} */ ([...RUN1.keys()].find((k) => k.toLowerCase() === `tracksegments/${uuid.toLowerCase()}`));
  const bytes = RUN1.get(name);
  assert.ok(bytes, name);
  const files = new Map(RUN1);
  files.set(name, change(bytes.slice()));
  return { read: await readFiles(files), bytes };
}

test('a TrackSegments slot of unknown width marked present: positions kept, elevation and time dropped and said so', async () => {
  const { read } = await withSegments('Gate1 Track Timed', (b) => {
    const start = /** @type {number} */ (readHeader(b, { role: 'tracksegments' }).bodyStart) + 4;
    // Point 1: slot 1 present (1 + 8), slot 2 present (1 + 4), then slot 3's presence byte.
    assert.deepEqual([b[start], b[start + 9], b[start + 14]], [1, 1, 0]);
    b[start + 14] = 1;
    return b;
  });
  const track = /** @type {any} */ (read.library.items.find((/** @type {any} */ i) => i.name === 'Gate1 Track Timed'));
  const before = /** @type {any} */ (BASE.library.items.find((/** @type {any} */ i) => i.name === 'Gate1 Track Timed'));
  assert.deepEqual(track.segments.map((/** @type {any[]} */ s) => s.map((p) => [p.lat, p.lon])), before.segments.map((/** @type {any[]} */ s) => s.map((p) => [p.lat, p.lon])));
  assert.ok(track.segments.flat().every((/** @type {any} */ p) => p.ele === null && p.time === null));
  assert.equal(read.details.elevationTime.get(track.id), 'not_decoded');
  assert.equal(reportCounts(read.library).get('track_segments_not_decoded'), 1);
  othersUnchanged(read, ['track:Gate1 Track Timed']);
  const exported = await exportLibrary(read, { now: () => Date.UTC(2026, 9, 7, 12), compression: 'store' });
  assert.match(exported.report.text, /\nTracks without elevation and time\n[\s\S]*Gate1 Track Timed/);
});

test('a sensor track whose TrackSegments file does not match it: the mismatch is reported, not "elevations and times kept"', async () => {
  const { read } = await withSegments('Gate1 Track Sensors', (b) => {
    const at = /** @type {number} */ (readHeader(b, { role: 'tracksegments' }).bodyStart);
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const m = view.getUint32(at, true);
    assert.equal(m, 9);
    assert.equal((b.length - at - 4) % m, 0);
    const size = (b.length - at - 4) / m;
    const out = b.slice(0, b.length - size); // one point fewer: still a well-formed file, 8 points for 9 positions
    new DataView(out.buffer).setUint32(at, m - 1, true);
    return out;
  });
  const track = /** @type {any} */ (read.library.items.find((/** @type {any} */ i) => i.name === 'Gate1 Track Sensors'));
  assert.equal(read.details.elevationTime.get(track.id), 'mismatch');
  assert.equal(reportCounts(read.library).get('track_segments_mismatch'), 1);
  assert.equal(problemCounts(read.library).track_sensor_data_kept, undefined, 'nothing from that file was kept');
  assert.equal(track.sensorData, false);
  assert.ok(track.segments.flat().every((/** @type {any} */ p) => !('hr' in p) && !('atemp' in p)), 'no sensor value from a file that does not match');
  const exported = await exportLibrary(read, { now: () => Date.UTC(2026, 9, 7, 12), compression: 'store' });
  assert.ok(!exported.report.text.includes(LIBRARY_PROBLEMS.track_sensor_data_kept.message));
});

test('FolderData.gfi: a smart list whose tail is unexpected is still left out (created-by decides), and the dump notes the tail', async () => {
  const gfi = /** @type {Uint8Array} */ (RUN1.get('FolderData.gfi'));
  const rec = records(gfi, 'gfi').find((r) => r.type === 'I' && new TextDecoder().decode(r.body).includes('Last Week'));
  assert.ok(rec);
  const body = rec.body.slice();
  assert.deepEqual([...body.subarray(body.length - 5)], [1, 0, 0, 0, 0]);
  body[body.length - 1] = 7;
  const files = new Map(RUN1);
  files.set('FolderData.gfi', withBody(gfi, rec, body));
  const read = await readFiles(files);
  assert.equal(problemCounts(read.library).smart_lists_left_out, 2);
  assert.equal(problemCounts(read.library).list_tail_unexpected, 1);
  assert.ok(!read.library.folders.some((/** @type {any} */ f) => f.name === 'Last Week' || f.name === 'Last Month'));
  othersUnchanged(read, []);
  assert.deepEqual(listsOf(read.library), listsOf(BASE.library));
});

// ---------------------------------------------------------------------------------------------
// 3. Whole libraries through the app's path: every file, byte by byte (strided unless BCR_REAL_SWEEP=1), and cut short

test(`run1 through the app: changed bytes and cut files never throw, never change an unrelated item, and every loss is told${FULL ? ' (full sweep)' : ''}`, { timeout: FULL ? 1_800_000 : 120_000 }, async () => {
  const gdbRecords = records(/** @type {Uint8Array} */ (RUN1.get('AllData.gdb')), 'gdb');
  /** Item keys a byte of AllData.gdb belongs to (its record's item; a via-point W record also feeds its route). */
  const ownersOf = (/** @type {number} */ off) => {
    const rec = gdbRecords.find((r) => off >= r.offset && off < r.bodyOffset + r.length);
    if (!rec) return null;
    const name = leadingName(rec.body);
    const owners = [`${{ W: 'waypoint', T: 'track', R: 'route' }[/** @type {'W'|'T'|'R'} */ (rec.type)] ?? rec.type}:${name}`];
    for (const r of BASE.library.items) if (r.kind === 'route' && r.points.some((/** @type {any} */ p) => p.name === name)) owners.push(keyOf(r));
    return owners;
  };
  /** TrackSegments file → the track it belongs to. */
  const trackOfFile = new Map(
    gdbRecords.filter((r) => r.type === 'T').map((r) => {
      const p = parseTrack(r.body, new Counts());
      return [`trackSegments/${p.uuid}`.toLowerCase(), `track:${p.name}`];
    }),
  );
  const baseItems = new Map(BASE.library.items.map((/** @type {any} */ i) => [keyOf(i), i]));
  const baseLists = listsOf(BASE.library);
  const baseReport = reportCounts(BASE.library);
  let runs = 0;
  /** @type {string[]} */
  const problems = [];

  /** @param {string} file @param {number|null} off @param {Map<string, Uint8Array>} files @param {string} label */
  const trial = async (file, off, files, label) => {
    runs++;
    let read;
    try {
      read = await readOrRefuse(files);
    } catch (error) {
      problems.push(`${label}: threw ${error}`);
      return;
    }
    if (read.refused) {
      if (read.refused.length === 0) problems.push(`${label}: refused without a word`);
      return;
    }
    if (read.details.fatal) {
      if (!read.details.fatal.message) problems.push(`${label}: fatal without a message`);
      return;
    }
    const lib = read.library;
    const told = [...reportCounts(lib)].some(([code, n]) => (baseReport.get(code) ?? 0) < n) || lib.notConverted.length > 0;
    const items = new Map(lib.items.map((/** @type {any} */ i) => [keyOf(i), i]));
    const lists = listsOf(lib);
    const ambiguous = new Set(lib.ambiguous);
    const owners = file === 'AllData.gdb' && off !== null ? ownersOf(off) : null;
    const mayChange = (/** @type {string} */ key) =>
      off === null ||
      (file === 'AllData.gdb' && (owners === null || owners.includes(key))) ||
      (file.startsWith('TrackSegments/') && trackOfFile.get(file.toLowerCase()) === key);
    for (const [key, item] of baseItems) {
      const got = items.get(key);
      if (!got) {
        if (!told) problems.push(`${label}: ${key} lost without a word`);
        continue;
      }
      if (valuesOf(got) !== valuesOf(item) && !mayChange(key)) problems.push(`${label}: ${key} changed by a byte that is not its own`);
      // A damaged record that now carries this item's name makes the name ambiguous: the item goes to "Duplicate
      // names" and the report says so (seen in the full sweep: "Gate1 Twin Track 001" cut to "Gate1 Twin Track").
      const duplicated = ambiguous.has(got.id) && reportCounts(lib).has('duplicate_names');
      if (lists.get(key) !== baseLists.get(key) && file !== 'FolderData.gfi' && !mayChange(key) && !duplicated) problems.push(`${label}: ${key} moved lists`);
    }
    for (const key of items.keys()) {
      if (!baseItems.has(key) && file !== 'AllData.gdb') problems.push(`${label}: a new item ${key} from ${file}`);
    }
  };

  const stride = () => (FULL ? 1 : 3);
  for (const [file, bytes] of RUN1) {
    const start = file === 'AllData.gdb' ? gdbRecords[0].offset : 0;
    for (let i = start; i < bytes.length; i += stride(file)) {
      for (const v of FULL ? new Set([bytes[i] ^ 0x01, 0xff, 0x00]) : [bytes[i] ^ 0x01]) {
        if (v === bytes[i]) continue;
        const changed = bytes.slice();
        changed[i] = v;
        await trial(file, i, new Map(RUN1).set(file, changed), `${file} byte ${i} ${bytes[i]}→${v}`);
      }
    }
    for (let k = 0; k < bytes.length; k += FULL ? 1 : 7) await trial(file, null, new Map(RUN1).set(file, bytes.slice(0, k)), `${file} cut to ${k}`);
  }
  assert.deepEqual(problems.slice(0, 20), []);
  assert.ok(runs > (FULL ? 25_000 : 2_500), `libraries read: ${runs}`);
});
