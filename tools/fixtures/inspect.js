// Self-check for the fixture writer: a small byte-level walker written from docs/FORMAT.md (§3.1-§3.3, §5.3, §6.4,
// §8, §9.3, §15.11), never from src/format/.
//
// Its only job is to prove that the writer's bytes mean what each scenario says they mean: that framing adds up, and
// that every W and T record validates under exactly the layout hypothesis the scenario intended (and no other), and
// every TrackSegments file under exactly the intended per-point size. Without that check an expected result could be
// silently wrong: a record that validated under both hypotheses would be "matched more than one layout" for a correct
// reader. It is not a reader: it keeps no names, builds no model and is only run by tests.

const TWO30 = 2 ** 30;
const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

class Fail extends Error {
  /**
   * @param {string} code
   * @param {number} offset
   */
  constructor(code, offset) {
    super(`${code} at ${offset}`);
    this.code = code;
    this.offset = offset;
  }
}

class Cursor {
  /**
   * @param {Uint8Array} bytes
   * @param {number} [start]
   * @param {number} [end]
   */
  constructor(bytes, start = 0, end = bytes.length) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = start;
    this.end = end;
  }

  get remaining() {
    return this.end - this.pos;
  }

  /** @param {number} n */
  need(n) {
    if (n > this.remaining) throw new Fail('short', this.pos);
  }

  u8() {
    this.need(1);
    return this.bytes[this.pos++];
  }

  u16() {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32() {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  i32() {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f64() {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  /** @param {number} n */
  skip(n) {
    this.need(n);
    this.pos += n;
  }

  /** @returns {Uint8Array} the bytes before the terminator */
  cstr() {
    const at = this.bytes.subarray(this.pos, this.end).indexOf(0);
    if (at < 0) throw new Fail('cstr', this.pos);
    const out = this.bytes.subarray(this.pos, this.pos + at);
    this.pos += at + 1;
    return out;
  }

  flag() {
    const v = this.u8();
    if (v > 1) throw new Fail('flag', this.pos - 1);
    return v;
  }

  /** @param {number} v */
  zero(v) {
    if (v !== 0) throw new Fail('nonzero', this.pos - 1);
  }

  fdouble() {
    return this.flag() ? this.f64() : null;
  }

  fint() {
    return this.flag() ? this.i32() : null;
  }

  position() {
    const lat = this.i32();
    const lon = this.i32();
    if (lat < -TWO30 || lat > TWO30) throw new Fail('latitude', this.pos - 8);
    return { lat, lon };
  }

  uuid() {
    const b = this.cstr();
    if (b.length !== 36 || !UUID_SHAPE.test(String.fromCharCode(...b))) throw new Fail('uuid', this.pos);
  }

  /** u32 n, then n cstrs; the count is checked against the bytes left before the loop. */
  cstrList() {
    const n = this.u32();
    if (n > this.remaining) throw new Fail('count', this.pos - 4);
    for (let i = 0; i < n; i++) this.cstr();
    return n;
  }

  done() {
    if (this.pos !== this.end) throw new Fail(this.pos < this.end ? 'leftover' : 'overrun', this.pos);
  }
}

/**
 * Parses the §3.1 header. Never throws.
 * @param {Uint8Array} bytes
 * @returns {{ok: true, signature: string, primary: number, version: number, programVersion: number,
 *   application: string, authorExact: boolean, end: number} | {ok: false, code: string}}
 */
export function readHeader(bytes) {
  try {
    const c = new Cursor(bytes);
    if (bytes.length < 18) return { ok: false, code: 'short' };
    const signature = String.fromCharCode(...bytes.subarray(0, 4));
    c.skip(4);
    const primary = c.u16();
    const dLen = c.u32();
    const dType = c.u8();
    if (dLen !== 2 || dType !== 0x44) return { ok: false, code: 'd_record' };
    const version = c.u16();
    const aLen = c.u32();
    const aType = c.u8();
    if (aType !== 0x41 || aLen < 2 || aLen > c.remaining) return { ok: false, code: 'a_record' };
    const aEnd = c.pos + aLen;
    const a = new Cursor(bytes, c.pos, aEnd);
    const programVersion = a.u16();
    let authorExact = true;
    try {
      a.cstr();
      a.cstr();
      a.cstr();
      a.done();
    } catch {
      authorExact = false;
    }
    c.pos = aEnd;
    const appStart = c.pos;
    const app = new Cursor(bytes, appStart, Math.min(bytes.length, appStart + 64));
    const application = String.fromCharCode(...app.cstr());
    return { ok: true, signature, primary, version, programVersion, application, authorExact, end: app.pos };
  } catch (e) {
    return { ok: false, code: e instanceof Fail ? e.code : 'error' };
  }
}

/**
 * Walks §3.2 frames from `start` to EOF.
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {{stopAtX?: boolean}} [opts]
 * @returns {{records: Array<{type: string, offset: number, bodyStart: number, len: number}>,
 *   stop: 'eof'|'truncated'|'x', afterX: number, truncatedAt: number|null}}
 */
export function walkRecords(bytes, start, opts = {}) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  /** @type {Array<{type: string, offset: number, bodyStart: number, len: number}>} */
  const records = [];
  let pos = start;
  while (pos < bytes.length) {
    if (bytes.length - pos < 5) return { records, stop: 'truncated', afterX: 0, truncatedAt: pos };
    const len = view.getUint32(pos, true);
    const type = String.fromCharCode(bytes[pos + 4]);
    if (len > bytes.length - pos - 5) return { records, stop: 'truncated', afterX: 0, truncatedAt: pos };
    records.push({ type, offset: pos, bodyStart: pos + 5, len });
    pos += 5 + len;
    if (type === 'X' && opts.stopAtX !== false) return { records, stop: 'x', afterX: bytes.length - pos, truncatedAt: null };
  }
  return { records, stop: 'eof', afterX: 0, truncatedAt: null };
}

/**
 * Runs one hypothesis; true only if it consumes the body exactly and every check holds.
 * @param {Uint8Array} body
 * @param {(c: Cursor) => void} parse
 */
function accepts(body, parse) {
  try {
    const c = new Cursor(body);
    parse(c);
    c.done();
    return true;
  } catch (e) {
    if (e instanceof Fail) return false;
    throw e;
  }
}

/** @param {Cursor} c  §5.1 agreed prefix */
function waypointPrefix(c) {
  c.cstr();
  c.u32();
  c.position();
  c.cstr();
  c.fdouble();
  c.u32();
  c.u32();
}

/** @param {Cursor} c  §5.2 H-KBM tail */
function waypointKbmTail(c) {
  for (let i = 0; i < 5; i++) c.cstr();
  const b = c.u8();
  if (b === 1) c.skip(24);
  else if (b === 0) c.flag();
  else throw new Fail('subclass', c.pos - 1);
  c.fdouble();
  c.fdouble();
  c.cstrList();
  c.fdouble();
  c.fint();
  c.skip(6);
  const phones = c.u32();
  if (phones > 1) throw new Fail('phones', c.pos - 4);
  if (phones === 1) {
    c.cstr();
    c.skip(1);
  }
  c.fint();
  c.skip(3);
  c.cstrList();
}

/** @param {Cursor} c  §5.2 H-OP tail */
function waypointOpTail(c) {
  c.u32();
  c.zero(c.u8());
  c.zero(c.flag());
  c.zero(c.flag());
  c.fdouble();
  c.zero(c.u8());
  c.cstrList();
  c.fdouble();
  c.fint();
  c.zero(c.u8());
  if (c.flag()) {
    c.cstr();
    c.uuid();
    for (let i = 0; i < 8; i++) c.zero(c.u8());
  }
}

/**
 * Which layout hypotheses accept a 'W' body (FORMAT.md §3.3 rule 7, §5.3, §15.11).
 * @param {Uint8Array} body
 * @returns {Array<'kbm'|'op'|'mac48'>}
 */
export function acceptedWaypointLayouts(body) {
  /** @type {Array<'kbm'|'op'|'mac48'>} */
  const out = [];
  if (accepts(body, (c) => { waypointPrefix(c); waypointKbmTail(c); })) out.push('kbm');
  if (accepts(body, (c) => { waypointPrefix(c); waypointOpTail(c); })) out.push('op');
  // H-MAC48: the H-KBM tail, then 8 bytes that are never checked.
  if (accepts(body, (c) => { waypointPrefix(c); waypointKbmTail(c); c.skip(8); })) out.push('mac48');
  return out;
}

/**
 * @param {Cursor} c
 * @param {boolean} kbm
 * @param {boolean} [mac48]  H-KBM plus the Mac 4.8 tail (§15.11)
 */
function trackRecord(c, kbm, mac48 = false) {
  c.cstr();
  c.flag(); // display: 0 or 1
  if (kbm) c.skip(4);
  c.u32();
  c.cstrList();
  c.cstr();
  c.f64();
  c.fdouble();
  c.flag(); // Unknown3: 0 or 1
  const tmax = c.position();
  const tmin = c.position();
  c.fdouble();
  c.f64();
  c.fint();
  if (kbm) c.skip(4);
  const segments = c.u32();
  if (segments * 21 > c.remaining) throw new Fail('segments', c.pos - 4);
  for (let k = 0; k < segments; k++) {
    c.flag(); // segment Unknown1: 0 or 1
    const smax = c.position();
    const smin = c.position();
    const n = c.u32();
    if (n * 8 > c.remaining) throw new Fail('points', c.pos - 4);
    for (let i = 0; i < n; i++) {
      const p = c.position();
      if (p.lat < smin.lat || p.lat > smax.lat || p.lon < smin.lon || p.lon > smax.lon) throw new Fail('point_bounds', c.pos - 8);
    }
    if (n >= 1) {
      if (smin.lat > smax.lat || smin.lon > smax.lon) throw new Fail('segment_minmax', c.pos);
      if (tmin.lat > smin.lat || tmin.lon > smin.lon || smax.lat > tmax.lat || smax.lon > tmax.lon) throw new Fail('segment_in_track', c.pos);
      if (tmin.lat > tmax.lat || tmin.lon > tmax.lon) throw new Fail('track_minmax', c.pos);
    }
  }
  c.u32(); // total point count: recorded, never an acceptance rule (§6.4 g)
  c.uuid();
  if (mac48) {
    c.skip(3);
    for (let i = 0; i < 11; i++) c.flag();
    c.fdouble();
    c.fdouble();
    c.skip(8);
  }
}

/**
 * Which layout hypotheses accept a 'T' body (FORMAT.md §3.3 rule 7, §6.4).
 * @param {Uint8Array} body
 * @returns {Array<'kbm'|'op'|'mac48'>}
 */
export function acceptedTrackLayouts(body) {
  /** @type {Array<'kbm'|'op'|'mac48'>} */
  const out = [];
  if (accepts(body, (c) => trackRecord(c, true))) out.push('kbm');
  if (accepts(body, (c) => trackRecord(c, false))) out.push('op');
  if (accepts(body, (c) => trackRecord(c, true, true))) out.push('mac48');
  return out;
}

/**
 * Which per-point sizes accept a TrackSegments file (FORMAT.md §9.3 steps 1-3, with §15.11's 17-slot point for 17:
 * presence bytes for slots 3-17, values only after slot 6 (8 bytes) and slot 7 (1 byte)).
 * @param {Uint8Array} bytes
 * @returns {{accepted: number[], count: number|null, values: Array<{ele: number|null, time: number|null}>|null}}
 */
export function acceptedTrackSegmentSizes(bytes) {
  const h = readHeader(bytes);
  if (!h.ok || h.primary !== 0x66) return { accepted: [], count: null, values: null };
  const c = new Cursor(bytes, h.end);
  let m;
  try {
    m = c.u32();
  } catch {
    return { accepted: [], count: null, values: null };
  }
  if (m * 11 > c.remaining) return { accepted: [], count: m, values: null };
  const start = c.pos;
  /** @type {number[]} */
  const accepted = [];
  /** @type {Array<{ele: number|null, time: number|null}>|null} */
  let values = null;
  for (const n of [17, 11]) {
    /** @type {Array<{ele: number|null, time: number|null}>} */
    const vals = [];
    const ok = accepts(bytes.subarray(start), (p) => {
      for (let i = 0; i < m; i++) {
        const ele = p.fdouble();
        const time = p.fint();
        if (n === 11) for (let k = 0; k < n - 2; k++) p.zero(p.u8());
        else {
          for (let slot = 3; slot <= 17; slot++) {
            if (!p.flag()) continue;
            if (slot === 6) p.f64();
            else if (slot === 7) p.u8();
            else throw new Fail('slot', p.pos - 1);
          }
        }
        vals.push({ ele, time });
      }
    });
    if (ok) {
      accepted.push(n);
      values = vals;
    }
  }
  return { accepted, count: m, values: accepted.length === 1 ? values : null };
}

/**
 * Decodes the GFI records the writer emits (FORMAT.md §8), reporting how each record's tail looked.
 * @param {Uint8Array} bytes
 */
export function readGfi(bytes) {
  const h = readHeader(bytes);
  if (!h.ok) return null;
  const walk = walkRecords(bytes, h.end, { stopAtX: false });
  /** @type {Array<{id: number, name: Uint8Array, parent: number, children: Array<[number, number]>, tail: number[]}>} */
  const folders = [];
  /** @type {Array<{id: number, name: Uint8Array, createdBy: number, parent: number, tail: number[]}>} */
  const lists = [];
  /** @type {Array<{type: string, list: number, name: Uint8Array, extra: number|null}>} */
  const refs = [];
  for (const r of walk.records) {
    const c = new Cursor(bytes, r.bodyStart, r.bodyStart + r.len);
    if (r.type === 'F') {
      const id = c.u32();
      const name = c.cstr();
      const parent = c.u32();
      const n = c.u32();
      if (n * 8 > c.remaining) throw new Fail('children', c.pos);
      /** @type {Array<[number, number]>} */
      const children = [];
      for (let i = 0; i < n; i++) children.push([c.u32(), c.u32()]);
      folders.push({ id, name, parent, children, tail: [...bytes.subarray(c.pos, c.end)] });
    } else if (r.type === 'I') {
      const id = c.u32();
      const name = c.cstr();
      const createdBy = c.u32();
      const parent = c.u32();
      lists.push({ id, name, createdBy, parent, tail: [...bytes.subarray(c.pos, c.end)] });
    } else {
      const list = c.u32();
      const name = c.cstr();
      let extra = null;
      if (r.type === 'T' || r.type === 'W') extra = c.u32();
      else if (r.type === 'R') extra = c.u8();
      c.done();
      refs.push({ type: r.type, list, name, extra });
    }
  }
  return { header: h, walk, folders, lists, refs };
}
