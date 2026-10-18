// TrackSegments/<uuid> decoder: per-point elevation and time for one track (FORMAT.md §9, §15.7, §15.11).
//
// Layout: the shared container header (§3.1, any signature), then a bare u32 point count M, then M points. Two point
// layouts are tried, never chosen by the file's version, and the file must end exactly after the last point:
//   - 17 slots (H-MAC48, §15.11): 17 presence bytes in order, each 0 or 1, each followed by its value when 1. Slot 1 is
//     the elevation (f64), slot 2 the time (i32), slot 6 the air temperature (f64), slot 7 the heart rate (u8). A 1 in
//     any other slot fails the layout, because that value's width is unknown. With slots 3-17 absent this is exactly
//     the old 17-byte point (fdouble elevation, fint time, 15 zero bytes), so it replaces it.
//   - 11 bytes (§9.2): fdouble elevation, fint time, then 9 bytes that must all be 0.
// Exactly one fits: use it. Both or neither: no elevation or time (§9.3 step 4). Air temperature and heart rate are
// returned too (decision B44), as arrays that exist only when some point holds the value.
//
// Matching to the track (§9.3 step 5) is in matchTrackSegments(): one to one when M = Σn; with shared endpoints
// removed when M = Σn − (S − 1) and every segment really starts where the previous one ended; otherwise nothing.
//
// Hostile input: M is checked against the bytes left before any loop; work is O(file length). Nothing throws.

import { readHeader } from './container.js';
import { Counts, ALTITUDE_ABSENT_AT } from './gdb.js';

/** Point sizes tried, in this order: 17 presence slots (FORMAT.md §15.11) and the fixed 11 bytes (§9.2). */
export const POINT_SIZES = Object.freeze([17, 11]);
const SMALLEST_POINT = 11;
const SLOTS = 17;
/** Value width of each slot (index 0 = slot 1) when present; 0 = unknown width (a present value fails the layout). */
const SLOT_WIDTH = Object.freeze([8, 4, 0, 0, 0, 8, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const SLOT_ELEVATION = 0;
const SLOT_TIME = 1;
const SLOT_TEMPERATURE = 5;
const SLOT_HEART_RATE = 6;

/**
 * @typedef {object} TrackSegmentsResult
 * @property {"decoded"|"not_decoded"|"unreadable"} status
 *   decoded: exactly one point size fits; not_decoded: both or neither fits; unreadable: header or count unusable
 * @property {number|null} pointSize   17 (the 17-slot point) or 11 when decoded
 * @property {number|null} count       M
 * @property {string|null} signatureHex  the first 4 bytes (diagnostic; FORMAT.md §9.1 says the value is UNKNOWN)
 * @property {Float64Array|null} ele   metres, NaN = absent (§2 rule 4 applied)
 * @property {Float64Array|null} time  ms, NaN = absent (§2 rule 5 applied)
 * @property {Float64Array|null} hr     heart rate in bpm (slot 7), NaN = absent; null when no point holds one (B44)
 * @property {Float64Array|null} atemp  air temperature in °C (slot 6), NaN = absent; null when no point holds one (B44)
 * @property {number} fitting          how many point sizes fitted (0, 1 or 2)
 * @property {{temperature: number, heartRate: number}} sensors  points whose slot 6 / slot 7 is present (decoded files
 *   only), before any value is treated as absent
 */

/**
 * Decodes one TrackSegments file.
 * @param {Uint8Array} bytes
 * @param {Counts} [counts]  receives value_treated_as_absent
 * @returns {TrackSegmentsResult}
 */
export function parseTrackSegments(bytes, counts = new Counts()) {
  /** @type {TrackSegmentsResult} */
  const out = {
    status: 'unreadable',
    pointSize: null,
    count: null,
    signatureHex: null,
    ele: null,
    time: null,
    hr: null,
    atemp: null,
    fitting: 0,
    sensors: { temperature: 0, heartRate: 0 },
  };
  if (!(bytes instanceof Uint8Array)) return out;
  const header = readHeader(bytes, { role: 'tracksegments' });
  out.signatureHex = header.signatureHex;
  if (!header.ok) return out;
  const start = header.bodyStart;
  if (bytes.length - start < 4) return out;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const m = view.getUint32(start, true);
  out.count = m;
  const pointsStart = start + 4;
  if (m * SMALLEST_POINT > bytes.length - pointsStart) return out;

  /** @type {number[]} */
  const fits = [];
  if (walkSlots(bytes, pointsStart, m, null)) fits.push(17);
  if (fitsEleven(bytes, pointsStart, m)) fits.push(11);
  out.fitting = fits.length;
  if (fits.length !== 1) {
    out.status = 'not_decoded';
    return out;
  }
  out.status = 'decoded';
  out.pointSize = fits[0];
  const ele = new Float64Array(m);
  const time = new Float64Array(m);
  if (out.pointSize === 17) {
    /** @type {SlotTarget} */
    const into = { view, ele, time, hr: null, atemp: null, sensors: out.sensors, counts };
    walkSlots(bytes, pointsStart, m, into);
    out.hr = into.hr;
    out.atemp = into.atemp;
  } else {
    let at = pointsStart;
    for (let i = 0; i < m; i++) {
      if (bytes[at] === 1) {
        ele[i] = elevationOf(view.getFloat64(at + 1, true), counts);
        at += 9;
      } else {
        ele[i] = NaN;
        at += 1;
      }
      if (bytes[at] === 1) {
        time[i] = timeOf(view.getInt32(at + 1, true), counts);
        at += 5;
      } else {
        time[i] = NaN;
        at += 1;
      }
      at += SMALLEST_POINT - 2;
    }
  }
  out.ele = ele;
  out.time = time;
  return out;
}

/**
 * §2 rule 4: a present elevation that is NaN, infinite or ≥ 1e24 is absent (NaN) and counted.
 * @param {number} e
 * @param {Counts} counts
 */
function elevationOf(e, counts) {
  if (Number.isFinite(e) && e < ALTITUDE_ABSENT_AT) return e;
  counts.add('value_treated_as_absent');
  return NaN;
}

/**
 * A present air temperature that is NaN or infinite is absent (NaN) and counted, as for elevation (§2 rule 4). Range
 * checks are the writer's (xml.js formatTemperature).
 * @param {number} t
 * @param {Counts} counts
 */
function temperatureOf(t, counts) {
  if (Number.isFinite(t)) return t;
  counts.add('value_treated_as_absent');
  return NaN;
}

/**
 * A present heart rate of 0 is absent (NaN) and counted: no heart beats at 0 per minute, and Garmin's schema starts
 * at 1 (BeatsPerMinute_t). 1-255 are kept.
 * @param {number} bpm  u8
 * @param {Counts} counts
 */
function heartRateOf(bpm, counts) {
  if (bpm > 0) return bpm;
  counts.add('value_treated_as_absent');
  return NaN;
}

/**
 * §2 rule 5: a present time ≤ 0 is absent (NaN) and counted; otherwise ms.
 * @param {number} seconds  i32
 * @param {Counts} counts
 */
function timeOf(seconds, counts) {
  if (seconds > 0) return seconds * 1000;
  counts.add('value_treated_as_absent');
  return NaN;
}

/**
 * Where walkSlots() stores what it reads. `hr` and `atemp` start null and are made (filled with NaN) at the first point
 * that holds a usable value, so a file without one costs nothing more.
 * @typedef {{view: DataView, ele: Float64Array, time: Float64Array, hr: Float64Array|null, atemp: Float64Array|null,
 *   sensors: {temperature: number, heartRate: number}, counts: Counts}} SlotTarget
 */

/**
 * Walks m points of 17 presence slots from `start` (FORMAT.md §15.11). Returns true when every presence byte is 0 or 1,
 * no slot of unknown width is present, and the file ends exactly after the last point. With `into`, it also stores
 * each point's elevation (metres), time (ms), air temperature (°C) and heart rate (bpm), NaN when absent (§2 rules 4
 * and 5 applied and counted, and the rules of temperatureOf and heartRateOf), and counts the points holding each
 * sensor value; call it that way only after a first pass returned true.
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} m
 * @param {SlotTarget|null} into
 * @returns {boolean}
 */
function walkSlots(bytes, start, m, into) {
  const end = bytes.length;
  let at = start;
  for (let i = 0; i < m; i++) {
    if (into) {
      into.ele[i] = NaN;
      into.time[i] = NaN;
    }
    let temperature = false;
    let heartRate = false;
    for (let slot = 0; slot < SLOTS; slot++) {
      if (at >= end) return false;
      const present = bytes[at++];
      if (present === 0) continue;
      if (present !== 1) return false;
      const width = SLOT_WIDTH[slot];
      if (width === 0 || at + width > end) return false;
      if (into) {
        if (slot === SLOT_ELEVATION) into.ele[i] = elevationOf(into.view.getFloat64(at, true), into.counts);
        else if (slot === SLOT_TIME) into.time[i] = timeOf(into.view.getInt32(at, true), into.counts);
        else if (slot === SLOT_TEMPERATURE) {
          // Made only for a usable value, so a file whose sensor slots hold only absent values costs nothing more.
          const c = temperatureOf(into.view.getFloat64(at, true), into.counts);
          if (!Number.isNaN(c)) (into.atemp ??= new Float64Array(m).fill(NaN))[i] = c;
        } else if (slot === SLOT_HEART_RATE) {
          const bpm = heartRateOf(bytes[at], into.counts);
          if (!Number.isNaN(bpm)) (into.hr ??= new Float64Array(m).fill(NaN))[i] = bpm;
        }
      }
      if (slot === SLOT_TEMPERATURE) temperature = true;
      else if (slot === SLOT_HEART_RATE) heartRate = true;
      at += width;
    }
    if (into) {
      if (temperature) into.sensors.temperature++;
      if (heartRate) into.sensors.heartRate++;
    }
  }
  return at === end;
}

/**
 * True when m points of 11 bytes (fdouble elevation, fint time, 9 further bytes that must all be 0) fill
 * [start, end of file) exactly, with every flag 0 or 1.
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} m
 * @returns {boolean}
 */
function fitsEleven(bytes, start, m) {
  const end = bytes.length;
  const extra = SMALLEST_POINT - 2;
  let at = start;
  for (let i = 0; i < m; i++) {
    // Smallest this point can be: two absent flags plus the further bytes.
    if (at + 2 + extra > end) return false;
    const eFlag = bytes[at];
    if (eFlag > 1) return false;
    at += eFlag === 1 ? 9 : 1;
    if (at >= end) return false;
    const tFlag = bytes[at];
    if (tFlag > 1) return false;
    at += tFlag === 1 ? 5 : 1;
    if (at + extra > end) return false;
    for (let k = 0; k < extra; k++) if (bytes[at + k] !== 0) return false;
    at += extra;
  }
  return at === end;
}

/**
 * Maps decoded TrackSegments values onto a track's points (§9.3 step 5).
 * @param {Int32Array} positions        [lat, lon, …] in semicircles
 * @param {Uint32Array} segmentStarts   point index of each segment's start; length S + 1
 * @param {TrackSegmentsResult} ts      a decoded result
 * @returns {{ele: Float64Array, time: Float64Array, hr: Float64Array|null, atemp: Float64Array|null,
 *   rule: "one_to_one"|"shared_endpoints"} | null}  null: no match. hr and atemp are null when the file holds none.
 */
export function matchTrackSegments(positions, segmentStarts, ts) {
  if (ts.status !== 'decoded' || !ts.ele || !ts.time || ts.count === null) return null;
  const total = positions.length / 2;
  const segments = segmentStarts.length - 1;
  const m = ts.count;
  const hr = ts.hr ?? null;
  const atemp = ts.atemp ?? null;
  if (m === total) return { ele: ts.ele, time: ts.time, hr, atemp, rule: 'one_to_one' };
  if (segments > 1 && m === total - (segments - 1)) {
    // Every segment after the first must start exactly where the previous one ended (KBM's premise, checked).
    for (let s = 1; s < segments; s++) {
      const first = segmentStarts[s];
      const prevEnd = segmentStarts[s];
      const prevStart = segmentStarts[s - 1];
      if (first === segmentStarts[s + 1] || prevEnd === prevStart) return null; // an empty segment: no endpoint
      const last = prevEnd - 1;
      if (positions[2 * first] !== positions[2 * last] || positions[2 * first + 1] !== positions[2 * last + 1]) return null;
    }
    const ele = new Float64Array(total);
    const time = new Float64Array(total);
    const hrOut = hr ? new Float64Array(total) : null;
    const atempOut = atemp ? new Float64Array(total) : null;
    let j = 0;
    for (let s = 0; s < segments; s++) {
      for (let i = segmentStarts[s]; i < segmentStarts[s + 1]; i++) {
        if (s > 0 && i === segmentStarts[s]) {
          // The repeated point takes its twin's values (the previous segment's last point).
          ele[i] = ele[i - 1];
          time[i] = time[i - 1];
          if (hrOut) hrOut[i] = hrOut[i - 1];
          if (atempOut) atempOut[i] = atempOut[i - 1];
          continue;
        }
        ele[i] = ts.ele[j];
        time[i] = ts.time[j];
        if (hrOut && hr) hrOut[i] = hr[j];
        if (atempOut && atemp) atempOut[i] = atemp[j];
        j++;
      }
    }
    return { ele, time, hr: hrOut, atemp: atempOut, rule: 'shared_endpoints' };
  }
  return null;
}
