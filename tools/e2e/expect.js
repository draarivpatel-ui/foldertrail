// What the page and the downloaded ZIP must show for one fixture scenario, derived from the independent fixture
// writer's expectation (tools/fixtures/expect.js, "Expected result" in tools/fixtures/README.md), plus a minimal GPX
// reader and the comparisons. Pure functions, no browser: test/e2e.test.js checks them on their own as well.
//
// Nothing here imports src/: the layout rules come from docs/ARCHITECTURE.md §6 and the comments at the top of
// src/app/pipeline.js (the documented export layout), so a change in the app that breaks that layout shows up here.

/**
 * Positions: ARCHITECTURE §6 says 9 decimals, but src/export/xml.js (formatLat/formatLon) writes 7, so a written position
 * can be up to 5e-8° from the stored one. 1e-7° (about 1 cm) allows that and nothing more.
 */
export const DEGREES = 1e-7;
/** Elevations are written with at most 2 decimals. */
export const METRES = 0.006;

export const ROOT_NAME = 'My Collection';
export const NOT_IN_ANY_LIST = 'Not in any list';
export const ALL_ITEMS = 'All items';
export const DUPLICATES_DIR = '_Duplicate names';
/** The flat files written instead of the tree when there is no usable FolderData.gfi (B11). */
export const FLAT_FILE = Object.freeze({ waypoint: 'Waypoints', track: 'Tracks', route: 'Routes' });
export const KIND_WORD = Object.freeze({ waypoint: 'Waypoint', track: 'Track', route: 'Route' });
const KIND_KEY = /** @type {const} */ ({ waypoint: 'waypoints', track: 'tracks', route: 'routes' });

/**
 * @typedef {{waypoints: number, tracks: number, routes: number}} Counts
 * @typedef {{path: string[], type: 'folder'|'list', counts: Counts|null}} ExpectedRow
 * @typedef {object} ExpectedFile
 * @property {'list'|'unfiled'|'duplicate'|'flat'|'all'} role
 * @property {string|null} zipPath   the exact path when it is fixed (a plain name, or a name the app chooses itself)
 * @property {string[]|null} listPath  for a list: its name path from the root
 * @property {any[]} items            the fixture's expected items this file must hold (as a multiset)
 * @typedef {object} ExpectedLayout
 * @property {boolean} fatal
 * @property {boolean} treeMissing
 * @property {{waypoints: number, tracks: number, routes: number, lists: number, folders: number}} totals
 * @property {ExpectedRow[]} rows
 * @property {number} unlisted        items in no list (shown under "Saved outside your lists")
 * @property {number} ambiguous       items whose list could not be decided
 * @property {ExpectedFile[]} files
 * @property {any[]} duplicateItems   items written one per file under _Duplicate names
 * @property {string[]} notConvertedNames  tracks not decoded and routes not converted, named on the page
 */

/** @param {string[]} path */
export const pathKey = (path) => path.join(' / ');

/**
 * Derives the page and ZIP expectations from a fixture's `expected`.
 * @param {any} expected  deriveExpected() output (or the CLI's <name>.expected.json "expected")
 * @returns {ExpectedLayout}
 */
export function expectedLayout(expected) {
  const fatal = Boolean(expected.fatal);
  const items = fatal ? [] : expected.items;
  const tree = fatal ? [] : expected.tree ?? [];
  const treeMissing = !fatal && tree.length === 0;
  const totals = { waypoints: 0, tracks: 0, routes: 0, lists: 0, folders: 0 };
  for (const item of items) totals[KIND_KEY[/** @type {'waypoint'|'track'|'route'} */ (item.kind)]]++;
  for (const entry of tree) {
    if (entry.type === 'list') totals.lists++;
    else if (entry.path.length > 1) totals.folders++; // the root folder is not counted (it is in every library)
  }

  /** @type {Map<string, ExpectedRow>} */
  const rows = new Map();
  for (const entry of tree) {
    rows.set(pathKey(entry.path), { path: entry.path, type: entry.type, counts: entry.type === 'list' ? { waypoints: 0, tracks: 0, routes: 0 } : null });
  }
  /** @type {Map<string, any[]>} */
  const byList = new Map();
  for (const item of items) {
    for (const list of item.lists ?? []) {
      const key = pathKey(list);
      const row = rows.get(key);
      if (row?.counts) row.counts[KIND_KEY[/** @type {'waypoint'|'track'|'route'} */ (item.kind)]]++;
      byList.set(key, [...(byList.get(key) ?? []), item]);
    }
  }

  /** @type {ExpectedFile[]} */
  const files = [];
  if (!fatal) {
    if (treeMissing) {
      for (const kind of /** @type {const} */ (['waypoint', 'track', 'route'])) {
        const ofKind = items.filter((/** @type {any} */ i) => i.kind === kind);
        if (ofKind.length > 0) files.push({ role: 'flat', zipPath: `GPX/${FLAT_FILE[kind]}.gpx`, listPath: null, items: ofKind });
      }
    } else {
      const siblingsClash = clashingSiblings(tree);
      for (const entry of tree) {
        if (entry.type !== 'list') continue;
        const exact = entry.path.every((/** @type {string} */ name) => isPlainName(name)) && !siblingsClash.has(pathKey(entry.path));
        files.push({
          role: 'list',
          zipPath: exact ? `GPX/${entry.path.join('/')}.gpx` : null,
          listPath: entry.path,
          items: byList.get(pathKey(entry.path)) ?? [],
        });
      }
      const unfiled = items.filter((/** @type {any} */ i) => i.placement === 'not-in-any-list');
      if (unfiled.length > 0) files.push({ role: 'unfiled', zipPath: `GPX/${NOT_IN_ANY_LIST}.gpx`, listPath: null, items: unfiled });
    }
    files.push({ role: 'all', zipPath: `GPX/${ALL_ITEMS}.gpx`, listPath: null, items });
  }
  const duplicateItems = items.filter((/** @type {any} */ i) => i.placement === 'duplicate-names');
  const notConvertedNames = fatal
    ? []
    : [...(expected.notDecoded ?? []), ...(expected.routesNotConverted ?? [])].map((/** @type {any} */ n) => n.name);
  return {
    fatal,
    treeMissing,
    totals,
    rows: [...rows.values()],
    unlisted: items.filter((/** @type {any} */ i) => i.placement === 'not-in-any-list').length,
    ambiguous: duplicateItems.length,
    files,
    duplicateItems,
    notConvertedNames,
  };
}

/**
 * A name no safe-path rule could change (ARCHITECTURE §6 strips / : \ * ? " < > |, control characters and leading
 * dots, normalises to NFC and caps at 120 UTF-8 bytes). Only for these is the exact ZIP path asserted; any other name
 * is checked by the properties a safe name must have (see checkSafeSegment).
 * @param {string} name
 */
export function isPlainName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9 _(),'-]*$/.test(name) && !/ $/.test(name) && name.length <= 100;
}

/**
 * List paths whose name clashes with a sibling once case is folded (the app then adds " (2)").
 * @param {{path: string[], type: string}[]} tree
 * @returns {Set<string>}
 */
function clashingSiblings(tree) {
  /** @type {Map<string, string[]>} */
  const seen = new Map();
  for (const entry of tree) {
    const parent = pathKey(entry.path.slice(0, -1));
    const key = `${parent}\u0000${String(entry.path.at(-1)).normalize('NFC').toLowerCase()}`;
    seen.set(key, [...(seen.get(key) ?? []), pathKey(entry.path)]);
  }
  /** @type {Set<string>} */
  const out = new Set();
  for (const paths of seen.values()) if (paths.length > 1) for (const p of paths) out.add(p);
  return out;
}

/**
 * Problems with one path segment of a file the app wrote (empty when it is a safe name).
 * @param {string} segment
 * @returns {string[]}
 */
export function checkSafeSegment(segment) {
  const out = [];
  if (segment === '') out.push('empty name');
  if (/[/:\\*?"<>|]/.test(segment)) out.push('a character that is not allowed in a file name');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(segment)) out.push('a control character');
  if (segment.startsWith('.')) out.push('a leading dot');
  if (segment !== segment.normalize('NFC')) out.push('not NFC');
  if (new TextEncoder().encode(segment).length > 124) out.push('longer than 120 bytes plus an extension');
  return out;
}

// ---------------------------------------------------------------------------------------------
// A minimal GPX reader: enough to compare names, positions, elevations and times. Not a validator (xmllint is).

/** @param {string} s */
export function unescapeXml(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, e) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}

/**
 * The text of the first <tag> child in `body`, or null.
 * @param {string} body
 * @param {string} tag
 */
function child(body, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body);
  return m ? unescapeXml(m[1]) : null;
}

/**
 * @param {string} attrs
 * @param {string} name
 */
function attrNumber(attrs, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? Number(m[1]) : NaN;
}

/**
 * @typedef {{lat: number, lon: number, ele: number|null, time: number|null, name: string|null, hr: number|null,
 *   atemp: number|null}} GpxPoint  hr and atemp: Garmin's TrackPointExtension (B44), null when not written
 * @typedef {{kind: 'waypoint', name: string, comment: string|null, lat: number, lon: number, ele: number|null, time: number|null}} GpxWaypoint
 * @typedef {{kind: 'track', name: string, segments: GpxPoint[][]}} GpxTrack
 * @typedef {{kind: 'route', name: string, points: GpxPoint[]}} GpxRoute
 * @typedef {{name: string|null, desc: string|null, items: (GpxWaypoint|GpxTrack|GpxRoute)[]}} Gpx
 */

/**
 * @param {string} tag  wpt, trkpt or rtept
 * @param {string} body
 * @returns {GpxPoint[]}
 */
function points(tag, body) {
  /** @type {GpxPoint[]} */
  const out = [];
  const re = new RegExp(`<${tag}\\s([^>]*?)(?:/>|>([\\s\\S]*?)</${tag}>)`, 'g');
  for (const m of body.matchAll(re)) {
    const inner = m[2] ?? '';
    const ele = child(inner, 'ele');
    const time = child(inner, 'time');
    const hr = child(inner, 'gpxtpx:hr');
    const atemp = child(inner, 'gpxtpx:atemp');
    out.push({
      lat: attrNumber(m[1], 'lat'),
      lon: attrNumber(m[1], 'lon'),
      ele: ele === null ? null : Number(ele),
      time: time === null ? null : Date.parse(time),
      name: child(inner, 'name'),
      hr: hr === null ? null : Number(hr),
      atemp: atemp === null ? null : Number(atemp),
    });
  }
  return out;
}

/**
 * @param {string} xml
 * @returns {Gpx}
 */
export function parseGpx(xml) {
  const meta = /<metadata>([\s\S]*?)<\/metadata>/.exec(xml);
  /** @type {Gpx['items']} */
  const items = [];
  for (const m of xml.matchAll(/<wpt\s([^>]*?)(?:\/>|>([\s\S]*?)<\/wpt>)/g)) {
    const inner = m[2] ?? '';
    const ele = child(inner, 'ele');
    const time = child(inner, 'time');
    items.push({
      kind: 'waypoint',
      name: child(inner, 'name') ?? '',
      comment: child(inner, 'cmt'),
      lat: attrNumber(m[1], 'lat'),
      lon: attrNumber(m[1], 'lon'),
      ele: ele === null ? null : Number(ele),
      time: time === null ? null : Date.parse(time),
    });
  }
  for (const m of xml.matchAll(/<rte>([\s\S]*?)<\/rte>/g)) {
    const head = m[1].split('<rtept')[0];
    items.push({ kind: 'route', name: child(head, 'name') ?? '', points: points('rtept', m[1]) });
  }
  for (const m of xml.matchAll(/<trk>([\s\S]*?)<\/trk>/g)) {
    const head = m[1].split('<trkseg')[0];
    const segments = [...m[1].matchAll(/<trkseg>([\s\S]*?)<\/trkseg>|<trkseg\/>/g)].map((s) => points('trkpt', s[1] ?? ''));
    items.push({ kind: 'track', name: child(head, 'name') ?? '', segments });
  }
  return { name: meta ? child(meta[1], 'name') : null, desc: meta ? child(meta[1], 'desc') : null, items };
}

// ---------------------------------------------------------------------------------------------
// Comparisons

/** Characters XML 1.0 cannot carry; the writers drop them (src/export/xml.js), so they are dropped here too. */
// eslint-disable-next-line no-control-regex
const NOT_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
/** @param {string} s */
export const xmlSafe = (s) => String(s ?? '').replace(NOT_XML, '');

/**
 * @param {number|null} want
 * @param {number|null} got
 * @param {number} tolerance
 */
function near(want, got, tolerance) {
  if (want === null || want === undefined) return got === null;
  return got !== null && Number.isFinite(got) && Math.abs(got - want) <= tolerance;
}

/**
 * Why a GPX item does not match an expected item, or '' when it does.
 * @param {any} want  a fixture item
 * @param {any} got   a parseGpx item
 * @returns {string}
 */
export function itemMismatch(want, got) {
  if (got.kind !== want.kind) return 'kind';
  if (got.name !== xmlSafe(want.name)) return 'name';
  if (want.kind === 'waypoint') {
    if (!near(want.lat, got.lat, DEGREES) || !near(want.lon, got.lon, DEGREES)) return `position ${got.lat},${got.lon} (want ${want.lat},${want.lon})`;
    if (!near(want.ele, got.ele, METRES)) return `elevation ${got.ele} (want ${want.ele})`;
    if (!near(want.time, got.time, 0)) return `time ${got.time} (want ${want.time})`;
    if (want.comment && got.comment !== xmlSafe(want.comment)) return 'comment';
    return '';
  }
  if (want.kind === 'route') {
    if (got.points.length !== want.points.length) return `${got.points.length} route points (want ${want.points.length})`;
    for (let i = 0; i < want.points.length; i++) {
      const p = got.points[i];
      const q = want.points[i];
      if (!near(q.lat, p.lat, DEGREES) || !near(q.lon, p.lon, DEGREES)) return `route point ${i} position`;
      if ((p.name ?? '') !== xmlSafe(q.name)) return `route point ${i} name`;
    }
    return '';
  }
  // Empty segments carry nothing; whether one is written as an empty <trkseg> is not asserted.
  const wantSegs = want.segments.filter((/** @type {any[]} */ s) => s.length > 0);
  const gotSegs = got.segments.filter((/** @type {any[]} */ s) => s.length > 0);
  if (gotSegs.length !== wantSegs.length) return `${gotSegs.length} non-empty segments (want ${wantSegs.length})`;
  for (let s = 0; s < wantSegs.length; s++) {
    if (gotSegs[s].length !== wantSegs[s].length) return `segment ${s}: ${gotSegs[s].length} points (want ${wantSegs[s].length})`;
    for (let i = 0; i < wantSegs[s].length; i++) {
      const p = gotSegs[s][i];
      const q = wantSegs[s][i];
      if (!near(q.lat, p.lat, DEGREES) || !near(q.lon, p.lon, DEGREES)) return `segment ${s} point ${i} position`;
      if (!near(q.ele, p.ele, METRES)) return `segment ${s} point ${i} elevation ${p.ele} (want ${q.ele})`;
      if (!near(q.time, p.time, 0)) return `segment ${s} point ${i} time ${p.time} (want ${q.time})`;
      // B44: heart rate exactly; air temperature as written, to two decimals.
      if (!near(q.hr ?? null, p.hr, 0)) return `segment ${s} point ${i} heart rate ${p.hr} (want ${q.hr})`;
      if (!near(q.atemp ?? null, p.atemp, 0.005)) return `segment ${s} point ${i} temperature ${p.atemp} (want ${q.atemp})`;
    }
  }
  return '';
}

/**
 * Compares the items in one GPX file with the expected items, as multisets.
 * @param {any[]} want
 * @param {Gpx['items']} got
 * @returns {string[]}  problems, empty when they match
 */
export function compareItems(want, got) {
  const left = [...got];
  const out = [];
  for (const w of want) {
    const at = left.findIndex((g) => itemMismatch(w, g) === '');
    if (at >= 0) {
      left.splice(at, 1);
      continue;
    }
    const sameName = left.find((g) => g.kind === w.kind && g.name === xmlSafe(w.name));
    out.push(
      sameName
        ? `${w.kind} "${w.name}": ${itemMismatch(w, sameName)}`
        : `${w.kind} "${w.name}" is missing`,
    );
  }
  for (const g of left) out.push(`unexpected ${g.kind} "${g.name}"`);
  return out;
}

/**
 * The point placemarks of a KML file: name and position (lon,lat[,alt]). Enough to check waypoint positions.
 * @param {string} xml
 * @returns {{name: string, lat: number, lon: number}[]}
 */
export function kmlPoints(xml) {
  const out = [];
  for (const m of xml.matchAll(/<Placemark>([\s\S]*?)<\/Placemark>/g)) {
    const point = /<Point>[\s\S]*?<coordinates>([^<]*)<\/coordinates>/.exec(m[1]);
    if (!point) continue;
    const [lon, lat] = point[1].trim().split(',').map(Number);
    out.push({ name: unescapeXml(/<name>([\s\S]*?)<\/name>/.exec(m[1])?.[1] ?? ''), lat, lon });
  }
  return out;
}
