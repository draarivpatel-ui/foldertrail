// Gate 1 kit: a tiny synthetic BaseCamp library built from expected.json, written from docs/FORMAT.md only (§3 header
// and framing, §5 W under H-KBM, §6 T under H-KBM, §7 R, §8 GFI, §9 TrackSegments with N = 17).
//
// It exists for two things: test/gate1.test.js, and the check page's self-test, which proves in the founder's own
// browser that the page can read a library before BaseCamp is installed. It is NOT the project's fixture writer
// (tools/fixtures/, which must stay independent of src/format/), and passing against it proves only that the kit
// agrees with FORMAT.md, not that FORMAT.md matches BaseCamp. That is what Gate 1 is for.
//
// Browser built-ins only (TextEncoder, DataView), so the bundled check page can run it.

const SEMICIRCLES_PER_DEGREE = 2 ** 31 / 180;
const ROOT_FOLDER_ID = 0xffffffff;

/**
 * @param {number} deg
 * @returns {number}
 */
export function toSemicircles(deg) {
  return Math.round(deg * SEMICIRCLES_PER_DEGREE) | 0;
}

/** A little-endian byte builder. */
class Bytes {
  constructor() {
    /** @type {number[]} */
    this.out = [];
  }
  /** @param {number} v */
  u8(v) {
    this.out.push(v & 0xff);
    return this;
  }
  /** @param {number} v */
  u16(v) {
    return this.u8(v).u8(v >>> 8);
  }
  /** @param {number} v */
  u32(v) {
    return this.u8(v).u8(v >>> 8).u8(v >>> 16).u8(v >>> 24);
  }
  /** @param {number} v */
  i32(v) {
    return this.u32(v | 0);
  }
  /** @param {number} v */
  f64(v) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    return this.raw(b);
  }
  /** @param {ArrayLike<number>} bytes */
  raw(bytes) {
    for (let i = 0; i < bytes.length; i++) this.out.push(bytes[i] & 0xff);
    return this;
  }
  /** @param {string} s */
  cstr(s) {
    return this.raw(new TextEncoder().encode(s)).u8(0);
  }
  /** @param {number|null} v */
  fdouble(v) {
    return v === null ? this.u8(0) : this.u8(1).f64(v);
  }
  /** @param {number|null} v */
  fint(v) {
    return v === null ? this.u8(0) : this.u8(1).i32(v);
  }
  /**
   * @param {number} lat
   * @param {number} lon
   */
  position(lat, lon) {
    return this.i32(toSemicircles(lat)).i32(toSemicircles(lon));
  }
  bytes() {
    return Uint8Array.from(this.out);
  }
}

/**
 * A framed record: u32 body length, u8 type, body (FORMAT §3.2).
 * @param {string} type
 * @param {Uint8Array} body
 * @returns {Uint8Array}
 */
function frame(type, body) {
  return new Bytes().u32(body.length).u8(type.charCodeAt(0)).raw(body).bytes();
}

/**
 * The shared header (FORMAT §3.1), ending after the bare application cstr.
 * @param {string} signature
 * @param {number} programVersion
 * @returns {Uint8Array}
 */
function header(signature, programVersion) {
  const a = new Bytes().u16(programVersion).cstr('gate1-synth').cstr('Jan 01 2026').cstr('00:00:00').bytes();
  return new Bytes()
    .raw(new TextEncoder().encode(signature))
    .u16(0x0066)
    .raw(frame('D', new Bytes().u16(188).bytes()))
    .raw(frame('A', a))
    .cstr('BaseCamp')
    .bytes();
}

/**
 * @param {Uint8Array[]} parts
 * @returns {Uint8Array}
 */
function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * @param {string|null} iso
 * @returns {number|null}
 */
function unixSeconds(iso) {
  return iso === null ? null : Math.floor(Date.parse(iso) / 1000);
}

/**
 * Deterministic version-4-shaped UUIDs (mulberry32), so the library is the same on every run.
 * @param {number} seed
 * @returns {() => string}
 */
function uuidMaker(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) & 0xff;
  };
  return () => {
    let hex = '';
    for (let i = 0; i < 16; i++) hex += next().toString(16).padStart(2, '0');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`.toUpperCase();
  };
}

/**
 * @typedef {object} SynthOptions
 * @property {boolean} [handTyped]    include the founder's hand-typed Contact Info (default true)
 * @property {boolean} [withGfi]      write FolderData.gfi (default true)
 * @property {number} [programVersion]  the 'A' record's raw u16 (default 408, a GUESS for Mac 4.8)
 * @property {Array<{type: string, body: Uint8Array}>} [extraGdbRecords]  appended before 'V' (for tests)
 * @property {Array<{type: string, body: Uint8Array}>} [extraGfiRecords]  appended at the end (for tests)
 */

/**
 * Builds { path: bytes } for a library folder named "Database/4.8".
 * @param {any} expected  the parsed expected.json
 * @param {SynthOptions} [options]
 * @returns {Map<string, Uint8Array>}
 */
export function buildSyntheticLibrary(expected, options = {}) {
  const handTyped = options.handTyped ?? true;
  const withGfi = options.withGfi ?? true;
  const programVersion = options.programVersion ?? 408;
  const newUuid = uuidMaker(0x6a7e1);
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  const base = 'Database/4.8';

  // ---- AllData.gdb
  /** @type {Uint8Array[]} */
  const gdb = [header('MsRc', programVersion)];

  for (const w of expected.waypoints) {
    const typed = handTyped ? w.typedByHand : null;
    const addr = w.address ?? typed;
    const phone = w.phone ?? (typed ? typed.phone : null);
    const b = new Bytes()
      .cstr(w.name)
      .u32(0) // class
      .position(w.lat, w.lon)
      .cstr(w.comment)
      .fdouble(null) // proximity
      .u32(1) // display: symbol and name
      .u32(w.symbol === '' ? 0 : 18) // icon (any number; the kit only reports it)
      .cstr(addr ? addr.street : '')
      .cstr(addr ? addr.city : '')
      .cstr(addr ? addr.state : '')
      .cstr(addr ? addr.country : '')
      .cstr(addr ? addr.postalCode : '')
      .u8(0)
      .u8(0) // K13, the b = 0 branch
      .fdouble(w.ele) // K14 altitude
      .fdouble(null) // K15 depth
      .u32(0) // K16 links
      .fdouble(null) // K17 temperature
      .fint(null) // K18 time A
      .raw([0, 0, 0, 0, 0, 0]) // K19
      .u32(phone === null ? 0 : 1); // K20
    if (phone !== null) b.cstr(phone).u8(0); // K21
    b.fint(unixSeconds(w.time)) // K22 time B
      .raw([0, 0, 0]) // K23
      .u32(0); // K24 categories
    gdb.push(frame('W', b.bytes()));
  }

  for (const r of expected.routes) {
    const b = new Bytes().cstr(r.name).u8(0).u32(r.via.length);
    for (const v of r.via) {
      b.cstr(v.name).u32(0).u8(0).u32(0).u32(0).u32(0).u16(0).u32(0);
      b.u32(1).position(v.lat, v.lon); // one link point
      b.u8(1); // omit the bounding box
      b.raw([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
      b.fint(null).fint(null).u32(0); // Unknown11, end time (so no duration), no autoroute points
    }
    b.raw([0, 0, 0]).u8(1); // Unknown1, no bounds
    b.u32(0).u32(0).u8(0).cstr('').u8(0).u32(0).u8(1).u8(0).u32(0); // trailer (§7.3)
    gdb.push(frame('R', b.bytes()));
  }

  /** @type {Map<number, string>} */
  const uuidOfTrack = new Map();
  expected.tracks.forEach((t, index) => {
    const all = t.segments.flat();
    const lats = all.map((p) => toSemicircles(p.lat));
    const lons = all.map((p) => toSemicircles(p.lon));
    const first = all.find((p) => p.time !== null);
    const uuid = newUuid();
    uuidOfTrack.set(index, uuid);
    const b = new Bytes()
      .cstr(t.name)
      .u8(1) // display
      .raw([0, 0, 0, 0]) // gap 1
      .u32(0) // colour
      .u32(0) // links
      .cstr('') // notes
      .f64(0) // area
      .fdouble(null)
      .u8(0)
      .i32(Math.max(...lats))
      .i32(Math.max(...lons))
      .i32(Math.min(...lats))
      .i32(Math.min(...lons))
      .fdouble(null) // duration
      .f64(0) // length
      .fint(first ? unixSeconds(first.time) : null)
      .u32(0) // gap 2
      .u32(t.segments.length);
    for (const seg of t.segments) {
      const sl = seg.map((p) => toSemicircles(p.lat));
      const so = seg.map((p) => toSemicircles(p.lon));
      b.u8(0).i32(Math.max(...sl)).i32(Math.max(...so)).i32(Math.min(...sl)).i32(Math.min(...so)).u32(seg.length);
      for (const p of seg) b.position(p.lat, p.lon);
    }
    b.u32(all.length).cstr(uuid);
    gdb.push(frame('T', b.bytes()));

    // TrackSegments/<uuid>: header, bare u32 count, then N = 17 bytes per point when both fields are present.
    const ts = new Bytes().raw(header('MsRc', programVersion)).u32(all.length);
    for (const p of all) {
      ts.fdouble(p.ele).fint(unixSeconds(p.time));
      for (let i = 0; i < 15; i++) ts.u8(0);
    }
    files.set(`${base}/TrackSegments/${uuid}`, ts.bytes());
  });

  for (const extra of options.extraGdbRecords ?? []) gdb.push(frame(extra.type, extra.body));
  gdb.push(frame('V', new Bytes().u8(0).u8(1).bytes()));
  gdb.push(frame('X', new Bytes().cstr('EndOfFile').bytes()));
  files.set(`${base}/AllData.gdb`, concat(gdb));

  if (!withGfi) return files;

  // ---- FolderData.gfi
  /** @type {Map<string, number>} */
  const folderId = new Map();
  expected.tree.folders.forEach((f, i) => folderId.set(f.name, i));
  /** @type {Map<string, number>} */
  const listId = new Map();
  expected.tree.lists.forEach((l, i) => listId.set(l.name, i));

  /** @type {Uint8Array[]} */
  const gfi = [header('DifG', programVersion)];
  /**
   * @param {number} id
   * @param {string} name
   * @param {number} parent
   * @param {Array<[number, number]>} children
   */
  const folder = (id, name, parent, children) => {
    const b = new Bytes().u32(id).cstr(name).u32(parent).u32(children.length);
    for (const [type, child] of children) b.u32(type).u32(child);
    gfi.push(frame('F', b.u8(1).bytes()));
  };
  /** @param {string|null} parentName */
  const childrenOf = (parentName) => {
    /** @type {Array<[number, number]>} */
    const out = [];
    for (const f of expected.tree.folders) if (f.parent === parentName) out.push([1, /** @type {number} */ (folderId.get(f.name))]);
    for (const l of expected.tree.lists) if (l.folder === parentName) out.push([0, /** @type {number} */ (listId.get(l.name))]);
    return out;
  };
  folder(ROOT_FOLDER_ID, expected.tree.root, ROOT_FOLDER_ID, childrenOf(null));
  for (const f of expected.tree.folders) {
    const parent = f.parent === null ? ROOT_FOLDER_ID : /** @type {number} */ (folderId.get(f.parent));
    folder(/** @type {number} */ (folderId.get(f.name)), f.name, parent, childrenOf(f.name));
  }
  for (const l of expected.tree.lists) {
    const b = new Bytes().u32(/** @type {number} */ (listId.get(l.name))).cstr(l.name).u32(0).u32(/** @type {number} */ (folderId.get(l.folder)));
    gfi.push(frame('I', b.bytes()));
  }
  for (const r of expected.routes) {
    for (const list of r.lists) gfi.push(frame('R', new Bytes().u32(/** @type {number} */ (listId.get(list))).cstr(r.name).u8(1).bytes()));
  }
  for (const t of expected.tracks) {
    for (const list of t.lists) gfi.push(frame('T', new Bytes().u32(/** @type {number} */ (listId.get(list))).cstr(t.name).u32(0).bytes()));
  }
  for (const w of expected.waypoints) {
    for (const list of w.lists) gfi.push(frame('W', new Bytes().u32(/** @type {number} */ (listId.get(list))).cstr(w.name).u32(0).bytes()));
  }
  for (const extra of options.extraGfiRecords ?? []) gfi.push(frame(extra.type, extra.body));
  files.set(`${base}/FolderData.gfi`, concat(gfi));
  return files;
}

/** Exposed for tests that need to build extra records the same way. */
export const internals = Object.freeze({ Bytes, frame, header, concat });
