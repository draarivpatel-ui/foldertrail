// Unit tests for src/format/tracksegments.js (FORMAT.md §9). Hand-built, synthetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTrackSegments, matchTrackSegments } from '../src/format/tracksegments.js';
import { Counts } from '../src/format/gdb.js';

/**
 * A container header (§3.1) with the given signature and program version, then a bare u32 point count and points.
 * @param {Array<{ele?: number|null, time?: number|null, extra?: number[]}>} points
 * @param {{size?: number, signature?: string, program?: number, count?: number, trailing?: number[]}} [o]
 */
function file(points, o = {}) {
  const size = o.size ?? 17;
  /** @type {number[]} */
  const a = [];
  const u8 = (/** @type {number[]} */ ...v) => a.push(...v.map((x) => x & 0xff));
  const u32 = (/** @type {number} */ v) => u8(v, v >>> 8, v >>> 16, v >>> 24);
  const f64 = (/** @type {number} */ v) => {
    const d = new DataView(new ArrayBuffer(8));
    d.setFloat64(0, v, true);
    u8(...new Uint8Array(d.buffer));
  };
  const cstr = (/** @type {string} */ s) => u8(...Array.from(s, (c) => c.charCodeAt(0)), 0);
  u8(...Array.from(o.signature ?? 'MsRc', (c) => c.charCodeAt(0)), 0x66, 0);
  u32(2);
  u8(0x44, 188, 0);
  const author = ['bcr-test', 'Jan 01 2026', '00:00:00'];
  u32(2 + author.reduce((n, s) => n + s.length + 1, 0));
  u8(0x41, (o.program ?? 407) & 0xff, (o.program ?? 407) >>> 8);
  for (const s of author) cstr(s);
  cstr('BaseCamp');
  u32(o.count ?? points.length);
  for (const p of points) {
    if (p.ele === undefined || p.ele === null) u8(0);
    else {
      u8(1);
      f64(p.ele);
    }
    if (p.time === undefined || p.time === null) u8(0);
    else {
      u8(1);
      u32(p.time);
    }
    const extra = p.extra ?? new Array(size - 2).fill(0);
    u8(...extra);
  }
  u8(...(o.trailing ?? []));
  return Uint8Array.from(a);
}

test('17-byte and 11-byte points are chosen by exact consumption, whatever the program version', () => {
  const pts = [{ ele: 900, time: 1700000000 }, { ele: null, time: 1700000015 }, { ele: 903.5, time: null }];
  for (const [size, program] of [[17, 402], [17, 4813], [11, 480], [11, 407]]) {
    const ts = parseTrackSegments(file(pts, { size, program }));
    assert.equal(ts.status, 'decoded', `${size}/${program}`);
    assert.equal(ts.pointSize, size);
    assert.deepEqual([...(ts.ele ?? [])], [900, NaN, 903.5]);
    assert.deepEqual([...(ts.time ?? [])], [1700000000000, 1700000015000, NaN]);
  }
});

test('a further byte set to 1, trailing bytes, or both sizes fitting give no elevation or time', () => {
  const extra = new Array(15).fill(0);
  extra[3] = 1;
  assert.equal(parseTrackSegments(file([{ ele: 1, extra }])).status, 'not_decoded');
  assert.equal(parseTrackSegments(file([{ ele: 1 }], { trailing: [0] })).status, 'not_decoded');
  const empty = parseTrackSegments(file([]));
  assert.deepEqual([empty.status, empty.fitting, empty.count], ['not_decoded', 2, 0]);
  const badFlag = file([{ ele: 1 }]);
  assert.equal(badFlag[badFlag.length - 25], 1); // the elevation flag: 1 + 8 + 1 + 15 bytes from the end
  badFlag[badFlag.length - 25] = 2;
  assert.equal(parseTrackSegments(badFlag).status, 'not_decoded');
});

test('any signature is accepted and recorded; an unreadable header or count is "unreadable"', () => {
  const other = parseTrackSegments(file([{ ele: 1 }], { signature: 'TrSg' }));
  assert.deepEqual([other.status, other.signatureHex], ['decoded', '54725367']);
  assert.equal(parseTrackSegments(new Uint8Array(10)).status, 'unreadable');
  const absurd = parseTrackSegments(file([{ ele: 1 }], { count: 0x7fffffff }));
  assert.equal(absurd.status, 'unreadable');
  const noCount = file([]).subarray(0, -4);
  assert.equal(parseTrackSegments(noCount).status, 'unreadable');
  assert.equal(parseTrackSegments(/** @type {any} */ ('not bytes')).status, 'unreadable');
});

test('impossible values are absent and counted (§2 rules 4 and 5)', () => {
  const counts = new Counts();
  const ts = parseTrackSegments(file([{ ele: 1e24, time: 0 }, { ele: NaN, time: 5 }]), counts);
  assert.equal(ts.status, 'decoded');
  assert.deepEqual([...(ts.ele ?? [])], [NaN, NaN]);
  assert.deepEqual([...(ts.time ?? [])], [NaN, 5000]);
  assert.equal(counts.get('value_treated_as_absent'), 3);
});

test('a huge file is decoded in linear time', () => {
  const n = 200000;
  const ts = parseTrackSegments(file(Array.from({ length: n }, (_, i) => ({ ele: i, time: 1700000000 + i }))));
  assert.equal(ts.count, n);
  assert.equal(ts.status, 'decoded');
});

// ---------------------------------------------------------------------------------------------
// Matching (§9.3 step 5)

/** @param {number[][]} segments  each a list of [lat, lon] semicircle pairs flattened */
function packed(segments) {
  const positions = Int32Array.from(segments.flat());
  const starts = [0];
  for (const s of segments) starts.push(starts[starts.length - 1] + s.length / 2);
  return { positions, starts: Uint32Array.from(starts) };
}

/** @param {number} m */
function decoded(m) {
  const ele = Float64Array.from({ length: m }, (_, i) => 100 + i);
  const time = Float64Array.from({ length: m }, (_, i) => 1000 * (i + 1));
  return /** @type {import('../src/format/tracksegments.js').TrackSegmentsResult} */ ({
    status: 'decoded',
    pointSize: 17,
    count: m,
    signatureHex: null,
    ele,
    time,
    fitting: 1,
  });
}

test('match: one to one when M = Σn', () => {
  const { positions, starts } = packed([[1, 1, 2, 2], [3, 3]]);
  const m = matchTrackSegments(positions, starts, decoded(3));
  assert.equal(m?.rule, 'one_to_one');
  assert.deepEqual([...(m?.ele ?? [])], [100, 101, 102]);
});

test('match: shared endpoints only when every segment starts where the previous one ended', () => {
  const same = packed([[1, 1, 2, 2], [2, 2, 3, 3], [3, 3, 4, 4]]);
  const m = matchTrackSegments(same.positions, same.starts, decoded(4));
  assert.equal(m?.rule, 'shared_endpoints');
  assert.deepEqual([...(m?.ele ?? [])], [100, 101, 101, 102, 102, 103]);
  assert.deepEqual([...(m?.time ?? [])], [1000, 2000, 2000, 3000, 3000, 4000]);
  const differ = packed([[1, 1, 2, 2], [2, 3, 3, 3]]);
  assert.equal(matchTrackSegments(differ.positions, differ.starts, decoded(3)), null);
  const withEmpty = packed([[1, 1, 2, 2], [], [2, 2, 3, 3]]);
  assert.equal(matchTrackSegments(withEmpty.positions, withEmpty.starts, decoded(2)), null);
  assert.equal(matchTrackSegments(same.positions, same.starts, decoded(5)), null);
  assert.equal(matchTrackSegments(same.positions, same.starts, { ...decoded(6), status: 'not_decoded' }), null);
});

// ---------------------------------------------------------------------------------------------
// The 17-slot point (FORMAT.md §15.11): presence bytes for slots 3-17, values after slot 6 (f64) and slot 7 (u8)

/**
 * The bytes after a point's time for slots 3-17.
 * @param {{atemp?: number, hr?: number, present?: number[]}} o  `present`: other slots (3-17) whose presence byte is 1
 */
function slots(o = {}) {
  /** @type {number[]} */
  const out = [];
  for (let slot = 3; slot <= 17; slot++) {
    if (slot === 6 && o.atemp !== undefined) {
      const d = new DataView(new ArrayBuffer(8));
      d.setFloat64(0, o.atemp, true);
      out.push(1, ...new Uint8Array(d.buffer));
    } else if (slot === 7 && o.hr !== undefined) out.push(1, o.hr);
    else out.push((o.present ?? []).includes(slot) ? 1 : 0);
  }
  return out;
}

test('17 slots: temperature and heart rate are read in step, counted, returned (B44), and elevation and time kept', () => {
  const pts = [
    { ele: 5.5, time: 1083827289, extra: slots({ atemp: 20.5, hr: 100 }) },
    { ele: 6, time: 1083827294, extra: slots({ hr: 101 }) },
    { ele: 6.5, time: 1083827299, extra: slots({ atemp: 21 }) },
    { ele: null, time: null, extra: slots() },
  ];
  const ts = parseTrackSegments(file(pts));
  assert.deepEqual([ts.status, ts.pointSize, ts.fitting, ts.count], ['decoded', 17, 1, 4]);
  assert.deepEqual([...(ts.ele ?? [])], [5.5, 6, 6.5, NaN]);
  assert.deepEqual([...(ts.time ?? [])], [1083827289000, 1083827294000, 1083827299000, NaN]);
  assert.deepEqual(ts.sensors, { temperature: 2, heartRate: 2 });
  assert.deepEqual([...(ts.atemp ?? [])], [20.5, NaN, 21, NaN]);
  assert.deepEqual([...(ts.hr ?? [])], [100, 101, NaN, NaN]);
  // The point sizes BaseCamp for Mac 4.8 writes: 17, 25, 29 and 38 bytes (FORMAT.md §15.7).
  const sizes = [file([{ extra: slots() }]), file([{ ele: 1, extra: slots() }]), file([{ ele: 1, time: 2, extra: slots() }]),
    file([{ ele: 1, time: 2, extra: slots({ atemp: 3, hr: 4 }) }])].map((b) => b.length - file([]).length);
  assert.deepEqual(sizes, [17, 25, 29, 38]);
});

test('17 slots: a slot of unknown width present, or a presence byte above 1, gives no elevation or time', () => {
  for (const slot of [3, 4, 5, 8, 12, 17]) {
    const ts = parseTrackSegments(file([{ ele: 1, time: 2, extra: slots() }, { ele: 1, time: 3, extra: slots({ present: [slot] }) }]));
    assert.equal(ts.status, 'not_decoded', `slot ${slot}`);
  }
  const bad = slots();
  bad[4] = 2; // slot 7's presence byte
  assert.equal(parseTrackSegments(file([{ ele: 1, extra: bad }])).status, 'not_decoded');
  // A heart rate whose value is missing at the end of the file.
  const cut = file([{ ele: 1, extra: slots({ hr: 90 }) }]);
  assert.equal(parseTrackSegments(cut.subarray(0, cut.length - 11)).status, 'not_decoded');
});

test('17 slots (B44): no sensor value, no arrays; a heart rate of 0 or a temperature that is not finite is absent and counted', () => {
  const plain = parseTrackSegments(file([{ ele: 1, time: 2, extra: slots() }, { ele: 2, time: 3, extra: slots() }]));
  assert.deepEqual([plain.status, plain.hr, plain.atemp], ['decoded', null, null]);
  const onlyHr = parseTrackSegments(file([{ ele: 1, extra: slots({ hr: 255 }) }, { ele: 2, extra: slots() }]));
  assert.deepEqual([[...(onlyHr.hr ?? [])], onlyHr.atemp], [[255, NaN], null]);
  const counts = new Counts();
  const odd = parseTrackSegments(
    file([{ extra: slots({ hr: 0, atemp: NaN }) }, { extra: slots({ hr: 1, atemp: Infinity }) }, { extra: slots({ atemp: -40 }) }]),
    counts,
  );
  assert.equal(odd.status, 'decoded');
  assert.deepEqual([...(odd.hr ?? [])], [NaN, 1, NaN]);
  assert.deepEqual([...(odd.atemp ?? [])], [NaN, NaN, -40]);
  assert.equal(counts.get('value_treated_as_absent'), 3);
  assert.deepEqual(odd.sensors, { temperature: 3, heartRate: 2 }, 'present slots are still counted');
  // Sensor slots that hold only absent values make no arrays.
  const absentOnly = parseTrackSegments(file([{ extra: slots({ hr: 0, atemp: NaN }) }, { extra: slots() }]));
  assert.deepEqual([absentOnly.status, absentOnly.hr, absentOnly.atemp, absentOnly.sensors], ['decoded', null, null, { temperature: 1, heartRate: 1 }]);
  // 11-byte points have no sensor slots.
  const eleven = parseTrackSegments(file([{ ele: 1, time: 2 }], { size: 11 }));
  assert.deepEqual([eleven.pointSize, eleven.hr, eleven.atemp], [11, null, null]);
});

test('match (B44): heart rate and temperature follow the points one to one, and through shared endpoints like elevation', () => {
  const withSensors = (/** @type {number} */ m) => ({
    ...decoded(m),
    hr: Float64Array.from({ length: m }, (_, i) => (i === 1 ? NaN : 90 + i)),
    atemp: Float64Array.from({ length: m }, (_, i) => 10 + i / 2),
  });
  const one = packed([[1, 1, 2, 2], [3, 3]]);
  const m1 = matchTrackSegments(one.positions, one.starts, withSensors(3));
  assert.deepEqual([[...(m1?.hr ?? [])], [...(m1?.atemp ?? [])]], [[90, NaN, 92], [10, 10.5, 11]]);
  const same = packed([[1, 1, 2, 2], [2, 2, 3, 3], [3, 3, 4, 4]]);
  const m2 = matchTrackSegments(same.positions, same.starts, withSensors(4));
  assert.equal(m2?.rule, 'shared_endpoints');
  assert.deepEqual([...(m2?.hr ?? [])], [90, NaN, NaN, 92, 92, 93]);
  assert.deepEqual([...(m2?.atemp ?? [])], [10, 10.5, 10.5, 11, 11, 11.5]);
  // Without sensor arrays the match has none.
  const m3 = matchTrackSegments(same.positions, same.starts, decoded(4));
  assert.deepEqual([m3?.hr, m3?.atemp], [null, null]);
});
