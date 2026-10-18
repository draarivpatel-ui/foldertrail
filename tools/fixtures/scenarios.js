// Named synthetic library scenarios for the BaseCamp reader, each with the result a correct reader must produce.
//
// Every name, coordinate and time below is made up. Coordinates sit in a plausible region so that tracks look like
// tracks, but no scenario copies or resembles anyone's real data.
//
// `supportedPath` says whether a scenario counts as coverage of the supported path (H-KBM waypoints and tracks, the
// TrackSegments layout); scenarios built on H-OP or made only of broken records do not (FORMAT.md §12).
// `exercises` (computed by buildScenario) lists which layout hypotheses and point sizes the bytes actually contain.

import { buildLibrary } from './writer.js';
import { deriveExpected } from './expect.js';

/** @typedef {import('./writer.js').LibrarySpec} LibrarySpec */
/** @typedef {import('./writer.js').Point} Point */

/**
 * @typedef {object} Scenario
 * @property {string} name
 * @property {string} title
 * @property {string[]} covers        what the scenario is for, in FORMAT.md terms
 * @property {boolean} supportedPath
 * @property {LibrarySpec} library
 * @property {string[]} [tolerated]   problem codes a correct reader MAY add (FORMAT.md does not settle them)
 * @property {string[]} [notes]
 * @property {{strings: string[], numbers: number[]}} [sentinels]  values that must never appear in a dump
 */

// ---------------------------------------------------------------------------------------------------------------------
// Builders

const T0 = Date.UTC(2026, 0, 10, 8, 0, 0); // a made-up morning
const MIN = 60_000;

/**
 * @param {string} id
 * @param {string} name
 * @param {number} lat
 * @param {number} lon
 * @param {Partial<import('./writer.js').WaypointSpec>} [extra]
 * @returns {import('./writer.js').WaypointSpec}
 */
function wpt(id, name, lat, lon, extra = {}) {
  return { kind: 'waypoint', id, name, comment: '', lat, lon, ele: null, time: null, ...extra };
}

/**
 * @param {string} id
 * @param {string} name
 * @param {Point[][]} segments
 * @param {Partial<import('./writer.js').TrackSpec>} [extra]
 * @returns {import('./writer.js').TrackSpec}
 */
function trk(id, name, segments, extra = {}) {
  return { kind: 'track', id, name, segments, ...extra };
}

/**
 * @param {string} id
 * @param {string} name
 * @param {Array<{name: string, lat: number, lon: number}>} points
 * @param {import('./writer.js').RouteSpec['gdb']} [gdb]
 * @returns {import('./writer.js').RouteSpec}
 */
function rte(id, name, points, gdb) {
  return { kind: 'route', id, name, points, ...(gdb ? { gdb } : {}) };
}

/**
 * @param {string} id
 * @param {string} name
 * @param {string|null} parentId
 * @param {Partial<import('./writer.js').FolderSpec>} [extra]
 * @returns {import('./writer.js').FolderSpec}
 */
function folder(id, name, parentId, extra = {}) {
  return { id, name, type: 'folder', parentId, itemIds: [], ...extra };
}

/**
 * @param {string} id
 * @param {string} name
 * @param {string|null} parentId
 * @param {string[]} itemIds
 * @param {Partial<import('./writer.js').FolderSpec>} [extra]
 * @returns {import('./writer.js').FolderSpec}
 */
function list(id, name, parentId, itemIds, extra = {}) {
  return { id, name, type: 'list', parentId, itemIds, ...extra };
}

/**
 * A straight run of n points. Elevation and time are present only when a start value is given.
 * @param {number} lat
 * @param {number} lon
 * @param {number} n
 * @param {{dLat?: number, dLon?: number, ele?: number|null, dEle?: number, t?: number|null, dt?: number}} [o]
 * @returns {Point[]}
 */
function line(lat, lon, n, o = {}) {
  const { dLat = 0.0009, dLon = 0.0013, ele = null, dEle = 3, t = null, dt = 15_000 } = o;
  return Array.from({ length: n }, (_, i) => ({
    lat: lat + i * dLat,
    lon: lon + i * dLon,
    ele: ele === null ? null : ele + i * dEle,
    time: t === null ? null : t + i * dt,
  }));
}

/**
 * Segments where each one starts exactly where the previous one ended (KBM's shared-endpoint premise, §6.2).
 * @param {number} lat
 * @param {number} lon
 * @param {number[]} counts
 * @param {{ele?: number|null, t?: number|null}} [o]
 * @returns {Point[][]}
 */
function sharedSegments(lat, lon, counts, o = {}) {
  /** @type {Point[][]} */
  const segs = [];
  let at = { lat, lon, ele: o.ele ?? null, time: o.t ?? null };
  counts.forEach((n, k) => {
    const seg = line(at.lat, at.lon, n, { ele: at.ele, t: at.time, dLat: k % 2 ? -0.0007 : 0.0011, dLon: 0.0012 });
    segs.push(seg);
    const last = seg[n - 1];
    at = { lat: last.lat, lon: last.lon, ele: last.ele, time: last.time };
  });
  return segs;
}

// ---------------------------------------------------------------------------------------------------------------------
// Scenarios

/** @type {Scenario[]} */
const LIST = [];

LIST.push({
  name: 'minimal',
  title: 'One waypoint in one list under the root',
  covers: ['container §3', "W H-KBM, every optional field absent (the 33-byte zero tail)", 'GFI root, one list, one W reference'],
  supportedPath: true,
  library: {
    seed: 101,
    header: { programVersion: 407 },
    items: [wpt('w1', 'Trailhead', 47.1, 8.2)],
    folders: [list('l1', 'Day hikes', null, ['w1'])],
  },
});

LIST.push({
  name: 'nested-tree',
  title: 'Folder > folder > folder > list, lists at several depths, empty folder and list, created-by 0, 1 and 8',
  covers: ['GFI F/I tree depth ≥ 3 (§8.1, §8.4)', 'list directly under the root', "I tails for created-by 1 and 8 (§8.2)",
    'folder and list ID spaces both start at 0', 'W, T, R references', 'program version 480'],
  supportedPath: true,
  library: {
    seed: 102,
    header: { programVersion: 480 },
    items: [
      wpt('w1', 'Lower bridge', 46.30, 8.80, { ele: 512, time: T0, gdb: { icon: 7 } }),
      wpt('w2', 'Upper bridge', 46.33, 8.82, { ele: 640, time: T0 + 40 * MIN }),
      wpt('w3', 'Picnic spot', 46.35, 8.79, { comment: 'Benches and a fountain' }),
      wpt('w4', 'Imported point', 46.40, 8.90),
      wpt('w5', 'Loose point', 46.41, 8.91),
      trk('t1', 'Valley walk', [line(46.30, 8.80, 12, { ele: 512, dEle: 10, t: T0, dt: 200_000 })], { gdb: { colorIndex: 11 } }),
      rte('r1', 'Bridge to bridge', [{ name: 'Lower bridge', lat: 46.30, lon: 8.80 }, { name: 'Upper bridge', lat: 46.33, lon: 8.82 }]),
    ],
    folders: [
      folder('f1', 'Region A', null),
      folder('f2', 'Valley B', 'f1'),
      folder('f3', '2026', 'f2'),
      list('l1', 'Valley C walks', 'f3', ['w1', 'w2', 't1']),
      list('l2', 'Favourites', null, ['w3', 'r1']),
      list('l3', 'Imported', 'f1', ['w4'], { createdBy: 1 }),
      list('l4', 'Unlisted Data', null, ['w5'], { createdBy: 8 }),
      folder('f4', 'Empty folder', null),
      list('l5', 'Empty list', 'f2', []),
    ],
  },
});

LIST.push({
  name: 'item-in-two-lists',
  title: 'One waypoint and one track each placed in two lists',
  covers: ['one item in several lists (§10, B9)'],
  supportedPath: true,
  library: {
    seed: 103,
    header: { programVersion: 407 },
    items: [
      wpt('w1', 'Shared summit', 46.9, 7.9, { ele: 2210, time: T0 }),
      wpt('w2', 'Only here', 46.91, 7.91),
      trk('t1', 'Shared ridge', [line(46.9, 7.9, 8, { ele: 2000, t: T0 })]),
    ],
    folders: [
      list('l1', 'Summer 2026', null, ['w1', 't1']),
      folder('f1', 'Ideas', null),
      list('l2', 'Best views', 'f1', ['w1', 'w2']),
      list('l3', 'Ridges', 'f1', ['t1']),
    ],
  },
});

LIST.push({
  name: 'duplicate-names',
  title: 'Two tracks and two waypoints with the same link key, and look-alikes that are not duplicates',
  covers: ['duplicate names go to _Duplicate names with the lists that named them (§10, B10)',
    'same name, different waypoint class: not a duplicate', 'track and waypoint sharing a name: not a duplicate',
    'route via point by name hitting a duplicate does not resolve (§7.4)'],
  supportedPath: true,
  library: {
    seed: 104,
    header: { programVersion: 407 },
    items: [
      wpt('w1', 'Spring', 46.5, 9.1, { ele: 1500 }),
      wpt('w2', 'Spring', 46.6, 9.2, { ele: 1600 }),
      wpt('w3', 'Spring', 46.7, 9.3, { gdb: { class: 1 } }),
      wpt('w4', 'Pass', 46.8, 9.4),
      trk('t1', 'Loop', [line(46.5, 9.1, 5, { t: T0 })]),
      trk('t2', 'Loop', [line(46.6, 9.2, 6, { t: T0 + 86_400_000 })]),
      trk('t3', 'Pass', [line(46.8, 9.4, 4)]),
      rte('r1', 'To the spring', [{ name: 'Pass', lat: 46.8, lon: 9.4 }, { name: 'Spring', lat: 0, lon: 0 }],
        { via: [{}, { byName: true, class: 0 }] }),
      rte('r2', 'To the pass', [{ name: 'Spring start', lat: 46.75, lon: 9.35 }, { name: 'Pass', lat: 0, lon: 0 }],
        { via: [{}, { byName: true, class: 0 }] }),
    ],
    folders: [
      list('l1', 'List A', null, ['t1', 'w1', 'w3', 'w4', 't3', 'r2']),
      list('l2', 'List B', null, ['t2', 'w2', 'r1']),
    ],
  },
});

LIST.push({
  name: 'no-folder-data',
  title: 'AllData.gdb and TrackSegments without FolderData.gfi',
  covers: ['no FolderData.gfi: flat export by type with a loud warning, never an invented tree (B11, §10)',
    'class 8 waypoint counted, not exported (§5.4)'],
  supportedPath: true,
  library: {
    seed: 105,
    header: { programVersion: 407 },
    gfi: null,
    items: [
      wpt('w1', 'Hut', 46.2, 7.6, { ele: 2400 }),
      wpt('w2', 'Map point', 46.21, 7.61, { gdb: { class: 8 } }),
      trk('t1', 'Approach', [line(46.18, 7.58, 10, { ele: 1800, dEle: 60, t: T0 })]),
      rte('r1', 'Up and back', [{ name: 'Car park', lat: 46.18, lon: 7.58 }, { name: 'Hut', lat: 46.2, lon: 7.6 }]),
    ],
    folders: [],
  },
});

LIST.push({
  name: 'tracks-elevation-time',
  title: 'Tracks with and without elevation and time, 17- and 11-byte points, and one without a TrackSegments file',
  covers: ['TrackSegments N = 17 and N = 11 chosen by exact consumption (§9.3)', 'elevation only, time only, neither',
    'mixed present and absent per point', 'missing TrackSegments file: positions only with a warning (§9.3 step 6)',
    'program version 408'],
  supportedPath: true,
  library: {
    seed: 106,
    header: { programVersion: 408 },
    items: [
      trk('t1', 'Both', [line(46.0, 7.0, 10, { ele: 900, t: T0 })]),
      trk('t2', 'Elevation only', [line(46.01, 7.01, 7, { ele: 1000 })]),
      trk('t3', 'Time only', [line(46.02, 7.02, 7, { t: T0 + 3_600_000 })]),
      trk('t4', 'Neither', [line(46.03, 7.03, 5)]),
      trk('t5', 'Mixed', [line(46.04, 7.04, 6, { ele: 700, t: T0 }).map((p, i) => ({
        ...p, ele: i % 2 ? null : p.ele, time: i % 3 === 2 ? null : p.time,
      }))]),
      trk('t6', 'No elevation file', [line(46.05, 7.05, 6)], { ts: { omit: true } }),
      trk('t7', 'Eleven-byte points', [line(46.06, 7.06, 9, { ele: 1234.5, dEle: -1.25, t: T0 })], { ts: { n: 11 } }),
    ],
    folders: [list('l1', 'Tracks', null, ['t1', 't2', 't3', 't4', 't5', 't6', 't7'])],
  },
});

LIST.push({
  name: 'tracksegments-variants',
  title: 'TrackSegments files that must not decode, an unusual signature, impossible values and an uppercase UUID',
  covers: ['TrackSegments signature is accepted whatever it is (§3.1 rule 1, §9.1)',
    'an extra byte set to 1 (slot 9, unknown width): neither size accepted (§9.3 step 3, §15.11)', 'trailing bytes', 'M not matching the track',
    'absurd point count', 'NaN and ≥ 1e24 elevations and a time of 0 are absent (§2 rules 4-5)',
    'uppercase UUID', 'TrackSegments program version 402 while the library says 4813: N is never chosen by version'],
  supportedPath: true,
  library: {
    seed: 107,
    header: { programVersion: 4813 },
    items: [
      trk('t1', 'Odd signature', [line(45.9, 6.9, 5, { ele: 300, t: T0 })], { ts: { signature: 'TrSg' } }),
      trk('t2', 'Flag set', [line(45.91, 6.91, 5, { ele: 300, t: T0 })], { ts: { extraByte: { point: 2, byte: 6 } } }),
      trk('t3', 'Trailing bytes', [line(45.92, 6.92, 5, { ele: 300, t: T0 })], { ts: { trailing: 3 } }),
      trk('t4', 'Short file', [line(45.93, 6.93, 6, { ele: 300, t: T0 })], { ts: { count: 4 } }),
      trk('t5', 'Impossible values', [[
        { lat: 45.94, lon: 6.94, ele: Number.NaN, time: T0 },
        { lat: 45.941, lon: 6.941, ele: 1e25, time: T0 + 10_000 },
        { lat: 45.942, lon: 6.942, ele: 310, time: 0 },
        { lat: 45.943, lon: 6.943, ele: 311, time: T0 + 30_000 },
      ]]),
      trk('t6', 'Upper case id', [line(45.95, 6.95, 4, { ele: 50, t: T0 })], { gdb: { uuid: 'A1B2C3D4-E5F6-4711-8899-AABBCCDDEEFF' } }),
      trk('t7', 'Absurd count', [line(45.96, 6.96, 4, { ele: 50, t: T0 })], { ts: { countOverride: 0x7fffffff } }),
      trk('t8', 'Older program', [line(45.97, 6.97, 4, { ele: 60, t: T0 })], { ts: { programVersion: 402 } }),
    ],
    folders: [list('l1', 'Edge cases', null, ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'])],
  },
});

LIST.push({
  name: 'multi-segment-tracks',
  title: 'Several segments: separate, shared endpoints (both point counts), empty segment, no segments, loose bounds',
  covers: ['one GPX trkseg per stored segment, every stored point kept (§6.5)',
    'M = Σn − (S − 1) with identical shared endpoints: repeated points take their twin\'s values (§9.3 step 5)',
    'M = Σn − (S − 1) without shared endpoints: mismatch', 'empty segment (counted) and S = 0',
    'loose (not tight) bounds, non-zero gap bytes, colour, links, notes, display 0 (§6.1, §6.4)',
    'total point count matching Σn, Σn − (S − 1) and neither (§6.4 g)', 'program version 402'],
  supportedPath: true,
  tolerated: ['track_segments_not_decoded'],
  notes: ['"No segments" has S = 0 and a TrackSegments file with M = 0, which both point sizes consume exactly. ' +
    'FORMAT.md §9.3 step 4 then gives no elevation or time, which loses nothing; whether a reader reports it is not ' +
    'settled, so track_segments_not_decoded is tolerated here.'],
  library: {
    seed: 108,
    header: { programVersion: 402 },
    items: [
      trk('t1', 'Three parts', [line(46.6, 8.6, 4, { ele: 800, t: T0 }), line(46.61, 8.62, 3, { ele: 820, t: T0 + 3_600_000 }),
        line(46.62, 8.64, 5, { ele: 840, t: T0 + 7_200_000 })]),
      trk('t2', 'Joined parts', sharedSegments(46.7, 8.7, [4, 3, 5], { ele: 900, t: T0 }), { ts: { count: 'overlap' }, gdb: { totalCount: 'overlap' } }),
      trk('t3', 'Joined parts, every point', sharedSegments(46.71, 8.71, [3, 3], { ele: 950, t: T0 })),
      trk('t4', 'Gap in the middle', [line(46.72, 8.72, 3, { t: T0 }), [], line(46.73, 8.73, 3, { t: T0 + MIN })]),
      trk('t5', 'No segments', []),
      trk('t6', 'Loose bounds', [line(46.74, 8.74, 5, { ele: 1000, t: T0 }), line(46.75, 8.75, 2, { ele: 1100, t: T0 + MIN })], {
        gdb: {
          boundsPad: { track: 5000, segment: 2000 }, gap1: [1, 2, 3, 4], gap2: [0xde, 0xad, 0xbe, 0xef], colorIndex: 10,
          links: ['link one', 'link two'], notes: 'Made-up notes', display: 0, unknown2: 1.5, area: 12.5, length: 4321.25,
        },
      }),
      trk('t7', 'Odd total', [line(46.76, 8.76, 3), line(46.77, 8.77, 3)], { gdb: { totalCount: 99 } }),
      trk('t8', 'Separate parts, short file', [line(46.78, 8.78, 3, { ele: 1, t: T0 }), line(46.79, 8.79, 3, { ele: 2, t: T0 + MIN })],
        { ts: { count: 'overlap' } }),
    ],
    folders: [list('l1', 'Multi-part', null, ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'])],
  },
});

LIST.push({
  name: 'routes',
  title: 'Routes through via points: link points, by-name look-ups, autoroute, a bad marker, an unresolved name',
  covers: ['R ≥ 1.46 layout (§7.1-§7.3), applied to 1.88 as a GUESS', 'via point from its first link point; shaping points ignored',
    'via point with L = 0 resolved by waypoint name and class', 'A > 0 followed by opaque bytes: stop cleanly, not converted',
    'Unknown7 not all 0xFF: not converted', 'unresolved by-name via point: not converted',
    'program version 407 (until B43 this was 408; a 408 file is Mac BaseCamp 4.8, where a route only H-OP decodes is not converted, §15.11)'],
  supportedPath: true,
  library: {
    seed: 109,
    header: { programVersion: 407 },
    items: [
      wpt('w1', 'Hut', 46.45, 9.65, { ele: 2100 }),
      wpt('w2', 'Lake', 46.47, 9.68),
      rte('r1', 'Direct', [
        { name: 'Start', lat: 46.40, lon: 9.60 },
        { name: 'Bend', lat: 46.42, lon: 9.62 },
        { name: 'End', lat: 46.44, lon: 9.64 },
      ], { via: [{ shaping: [[46.405, 9.605], [46.41, 9.61]] }, {}, {}] }),
      rte('r2', 'By name', [
        { name: 'Start', lat: 46.40, lon: 9.60 },
        { name: 'Hut', lat: 0, lon: 0 },
        { name: 'Lake', lat: 0, lon: 0 },
      ], { via: [{}, { byName: true }, { byName: true }] }),
      rte('r3', 'Autorouted', [
        { name: 'Start', lat: 46.40, lon: 9.60 },
        { name: 'Middle', lat: 46.41, lon: 9.63 },
        { name: 'End', lat: 46.44, lon: 9.64 },
      ], { via: [{}, { autoroute: { count: 2, junk: 30 } }, {}] }),
      rte('r4', 'Bad marker', [{ name: 'A', lat: 46.40, lon: 9.60 }, { name: 'B', lat: 46.41, lon: 9.61 }],
        { via: [{ badUnknown7: true }, {}] }),
      rte('r5', 'Missing via', [{ name: 'A', lat: 46.40, lon: 9.60 }, { name: 'Nowhere', lat: 0, lon: 0 }],
        { via: [{}, { byName: true }] }),
      rte('r6', 'Two points', [{ name: 'Here', lat: 46.46, lon: 9.66 }, { name: 'There', lat: 46.461, lon: 9.667 }], { noBounds: true }),
    ],
    folders: [list('l1', 'Routes', null, ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'w1', 'w2'])],
  },
});

LIST.push({
  name: 'text-encodings',
  title: 'Unicode names, Latin-1 and windows-1252 names, and names that match only after NFC',
  covers: ['UTF-8 names with combining marks, CJK and emoji', 'Latin-1 GDB names: windows-1252 fallback, counted (§11)',
    'byte 0x80 decodes as the euro sign (windows-1252, not ISO-8859-1)', 'raw byte match first (§10)',
    'NFD in AllData.gdb vs NFC in FolderData.gfi: matched after normalising, reported (§11)',
    'Latin-1 in AllData.gdb vs UTF-8 in FolderData.gfi: matched after decoding and normalising, reported'],
  supportedPath: true,
  library: {
    seed: 110,
    header: { programVersion: 407 },
    items: [
      wpt('w1', 'Ünïcödé 日本 😀', 35.0, 135.0, { comment: 'Kommentar mit Ümlaut – ja' }),
      wpt('w2', 'Café', 48.85, 2.35, { nameEncoding: 'latin1' }),
      wpt('w3', '€ Hütte', 47.3, 11.4, { nameEncoding: 'cp1252' }),
      wpt('w4', 'Genève', 46.2, 6.15, { gfiName: 'Genève' }),
      trk('t1', 'Höhenweg', [line(47.0, 11.0, 4)], { nameEncoding: 'latin1', gfiName: 'Höhenweg' }),
    ],
    folders: [
      folder('f1', 'Été 🌞', null),
      list('l1', 'Wanderungen – Sommer', 'f1', ['w1', 'w2', 'w3', 'w4', 't1']),
    ],
  },
});

LIST.push({
  name: 'waypoint-details',
  title: 'Waypoints with address, phone, subclass, links, categories, opaque bytes, both time fields and classes 0/1/8',
  covers: ['H-KBM K8-K12 address cstrs, K20/K21 one phone (§5.2)', 'K13 b = 1 with 24 opaque bytes, and b = 0 with stop byte 1',
    'links and categories', 'non-zero opaque K19/K23 bytes are ignored', 'K18 only, K22 only, both (K22 wins, §5.4)',
    'K19 byte 2 = 1 where H-OP would read its thumbnail flag: still exactly one layout', 'class 1 exported like class 0, class 8 counted',
    'altitude ≥ 1e24 is absent'],
  supportedPath: true,
  library: {
    seed: 111,
    header: { programVersion: 407 },
    items: [
      wpt('w1', 'Bakery', 47.37, 8.54, {
        ele: 432.5, time: T0, comment: 'Opens early',
        gdb: {
          icon: 18, address: { street: '1 Example Street', city: 'Sampletown', state: 'ST', country: 'Nowhere', postal: '00000' },
          phones: ['+00 000 000 000'],
        },
      }),
      wpt('w2', 'Viewpoint', 47.38, 8.55, {
        ele: 610, time: T0 + 10 * MIN,
        gdb: {
          subclass: Array.from({ length: 24 }, (_, i) => (i * 37 + 5) & 0xff), links: ['link a', 'link b'],
          categories: ['Category A', 'Category B'], opaque19: [1, 2, 3, 4, 5, 6], opaque23: [7, 8, 9], depth: 12.5,
          temperature: 21, proximity: 50, display: 2, icon: 6,
        },
      }),
      wpt('w3', 'Probe', 47.39, 8.56, { time: T0 + 20 * MIN, gdb: { timeIn: 'A', opaque19: [0, 1, 0, 0, 0, 0], opaque23: [0xff, 0, 1] } }),
      wpt('w4', 'Both times', 47.40, 8.57, { time: T0 + 120 * MIN, gdb: { otherTime: T0 + 30 * MIN } }),
      wpt('w5', 'Older time only', 47.41, 8.58, { time: T0 + 45 * MIN, gdb: { timeIn: 'A' } }),
      wpt('w6', 'Class one', 47.42, 8.59, { gdb: { class: 1, icon: 3 } }),
      wpt('w7', 'Class eight', 47.43, 8.60, { gdb: { class: 8 } }),
      wpt('w8', 'Too high', 47.44, 8.61, { ele: 1e25 }),
      wpt('w9', 'Stop byte', 47.45, 8.62, { ele: -12.25, gdb: { subclassStop: 1, phones: ['555'], phoneByte: 1 } }),
    ],
    folders: [list('l1', 'Details', null, ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w8', 'w9'])],
  },
});

LIST.push({
  name: 'hop-layouts',
  title: 'Waypoints and tracks written under H-OP (documented hypothesis, not supported-path coverage)',
  covers: ['H-OP 17-byte zero tail, colour ≠ 0, links, thumbnail present, altitude and time (§5.2)',
    'H-OP tracks without the two gaps (§6.1): one segment, two segments, shared endpoints, an empty segment, loose bounds, S = 0',
    'the reader must tell H-OP from H-KBM'],
  supportedPath: false,
  tolerated: ['track_segments_not_decoded'],
  notes: ['Documented hypothesis, not supported-path coverage (FORMAT.md §12).',
    '"Op no segments" has S = 0 and M = 0; see multi-segment-tracks for why track_segments_not_decoded is tolerated.'],
  library: {
    seed: 112,
    header: { programVersion: 407 },
    items: [
      wpt('w1', 'Op plain', 45.0, 10.0, { gdb: { layout: 'op' } }),
      wpt('w2', 'Op colour', 45.01, 10.01, { gdb: { layout: 'op', colour: 5 } }),
      wpt('w3', 'Op links', 45.02, 10.02, { gdb: { layout: 'op', links: ['first', 'second'] } }),
      wpt('w4', 'Op thumbnail', 45.03, 10.03, { gdb: { layout: 'op', thumbnail: { origin: 'thumb origin', uuid: '0f1e2d3c-4b5a-4968-8776-655443322110' } } }),
      wpt('w5', 'Op altitude and time', 45.04, 10.04, { ele: 250.75, time: T0, gdb: { layout: 'op', temperature: 18 } }),
      trk('t1', 'Op track', [line(45.0, 10.0, 6, { ele: 200, t: T0 })], { gdb: { layout: 'op', colorIndex: 13 } }),
      trk('t2', 'Op two parts', [line(45.05, 10.05, 3, { t: T0 }), line(45.06, 10.06, 4, { t: T0 + MIN })], { gdb: { layout: 'op', links: ['x'] } }),
      trk('t3', 'Op shared, gap, loose', [...sharedSegments(45.07, 10.07, [3, 3], { ele: 400, t: T0 }), []],
        { gdb: { layout: 'op', boundsPad: { track: 3000, segment: 1000 } } }),
      trk('t4', 'Op no segments', [], { gdb: { layout: 'op' } }),
    ],
    folders: [list('l1', 'Op layouts', null, ['w1', 'w2', 'w3', 'w4', 'w5', 't1', 't2', 't3', 't4'])],
  },
});

LIST.push({
  name: 'waypoint-negatives',
  title: 'Waypoint records no hypothesis accepts: the agreed prefix is kept, altitude and time are not',
  covers: ['H-KBM phone count 2 is not accepted (§5.2 K20), both with one phone written (KBM\'s reading) and with two', 'a presence flag of 2 (§2 rule 1)', 'record one byte short and one byte long',
    'absurd links count checked before the loop (§3.3 rule 7c)', 'waypoints still get name, position, comment and symbol (B12)'],
  supportedPath: false,
  library: {
    seed: 113,
    header: { programVersion: 407 },
    items: [
      // Count 2 but one phone: exactly the bytes KBM itself would accept (it reads one phone whatever the count), so a
      // reader that ignores the count rule accepts this record and is caught.
      wpt('w1', 'Two phones', 46.1, 7.1, { ele: 100, time: T0, comment: 'kept', gdb: { phones: ['111'], phoneCount: 2, icon: 4 } }),
      wpt('w7', 'Two phones written', 46.16, 7.16, { ele: 100, time: T0, gdb: { phones: ['111', '222'] } }),
      wpt('w2', 'Flag two', 46.11, 7.11, { ele: 100, time: T0, gdb: { badFlag: 'altitude', icon: 5 } }),
      wpt('w3', 'One short', 46.12, 7.12, { ele: 100, time: T0, gdb: { lengthDelta: -1 } }),
      wpt('w4', 'One long', 46.13, 7.13, { ele: 100, time: T0, gdb: { lengthDelta: 1 } }),
      wpt('w5', 'Absurd links', 46.14, 7.14, { ele: 100, time: T0, gdb: { linksCount: 0x7fffffff } }),
      wpt('w6', 'Good one', 46.15, 7.15, { ele: 100, time: T0 }),
    ],
    folders: [list('l1', 'Broken waypoints', null, ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7'])],
  },
});

LIST.push({
  name: 'track-negatives',
  title: 'Track records that fail the mandatory checks are listed by name without points',
  covers: ['a point outside its segment\'s bounds (§6.4 d)', 'segment bounds outside the track bounds (§6.4 e)',
    'segment min > max', 'a bad uuid (§6.4 a)', 'absurd segment count checked before the loop (§6.4 c)',
    'a total point count matching neither rule is still accepted (§6.4 g)'],
  supportedPath: false,
  library: {
    seed: 114,
    header: { programVersion: 407 },
    items: [
      trk('t1', 'Point outside', [line(46.2, 8.2, 4)], { gdb: { pointOutsideSegment: true } }),
      trk('t2', 'Segment outside', [line(46.21, 8.21, 4)], { gdb: { segmentOutsideTrack: true } }),
      trk('t3', 'Min above max', [line(46.22, 8.22, 4)], { gdb: { minAboveMax: true } }),
      trk('t4', 'Bad id', [line(46.23, 8.23, 4)], { gdb: { uuid: 'not-a-uuid' }, ts: { omit: true } }),
      trk('t5', 'Absurd segments', [line(46.24, 8.24, 4)], { gdb: { segmentCount: 0x10000000 } }),
      trk('t6', 'Odd total', [line(46.25, 8.25, 4, { ele: 10, t: T0 })], { gdb: { totalCount: 1000 } }),
      trk('t7', 'Good one', [line(46.26, 8.26, 4, { ele: 10, t: T0 })]),
    ],
    folders: [list('l1', 'Broken tracks', null, ['t1', 't2', 't3', 't4', 't5', 't6', 't7'])],
  },
});

LIST.push({
  name: 'gfi-tree-quirks',
  title: 'A folder cycle, a dangling child, a duplicate folder ID and a list whose two parent records disagree',
  covers: ['cycle guard: a folder listed under two folders stays under the first (§8.4)', 'dangling child reference (counted)',
    'duplicate F record ID ignored after the first (counted)', 'F.children vs I.parent disagreement: F.children wins, reported'],
  supportedPath: true,
  library: {
    seed: 115,
    header: { programVersion: 407 },
    gfi: {
      children: {
        $root: [['folder', 'f1'], ['list', 'l1']],
        f1: [['folder', 'f2'], ['list', 'l2']],
        f2: [['folder', 'f1'], ['list', 'l3'], ['list', 77]],
      },
      listParents: { l2: null },
      duplicateFolder: 'f2',
    },
    items: [wpt('w1', 'One', 46.0, 9.0), wpt('w2', 'Two', 46.01, 9.01), wpt('w3', 'Three', 46.02, 9.02)],
    folders: [
      folder('f1', 'Alpha', null),
      folder('f2', 'Beta', 'f1'),
      list('l1', 'Top list', null, ['w1']),
      list('l2', 'Alpha list', 'f1', ['w2']),
      list('l3', 'Beta list', 'f2', ['w3']),
    ],
  },
});

LIST.push({
  name: 'gfi-unreached-list',
  title: 'A list that no folder lists as a child',
  covers: ['a list no folder reaches goes under the root and is reported (§8.4)'],
  supportedPath: true,
  tolerated: ['list_folder_disagreement'],
  notes: ['The stray list\'s I.parent is the root, and the root\'s F record does not list it. FORMAT.md §8.4 says such a ' +
    'list goes under the root and is reported; whether that also counts as an F.children vs I.parent disagreement is ' +
    'not settled, so list_folder_disagreement is tolerated.'],
  library: {
    seed: 116,
    header: { programVersion: 407 },
    gfi: { children: { $root: [['list', 'l1']] } },
    items: [wpt('w1', 'Listed', 46.0, 9.0), wpt('w2', 'Stray item', 46.01, 9.01)],
    folders: [list('l1', 'Normal list', null, ['w1']), list('l2', 'Stray list', null, ['w2'])],
  },
});

LIST.push({
  name: 'gfi-record-quirks',
  title: 'Dangling item references, BirdsEye references, unexpected F and I tails, and a differing GFI version',
  covers: ['listed but not found in AllData.gdb (§10)', "'K' reference counted, not converted (§8.3)",
    'F tail missing and too long (§8.1)', 'I tail missing for created-by 1 and present for created-by 0 (§8.2)',
    'FolderData.gfi version differs from AllData.gdb: reported, reading continues (§4)'],
  supportedPath: true,
  library: {
    seed: 117,
    header: { programVersion: 407 },
    gfi: {
      header: { version: 187 },
      extraRefs: [
        { type: 'W', list: 'l1', name: 'Ghost' },
        { type: 'T', list: 'l1', name: 'Ghost track' },
        { type: 'K', list: 'l2', name: 'Tile set' },
      ],
    },
    items: [wpt('w1', 'Real', 46.0, 9.0), wpt('w2', 'Also real', 46.01, 9.01), wpt('w3', 'Third', 46.02, 9.02)],
    folders: [
      folder('f1', 'No tail', null, { tail: [] }),
      folder('f2', 'Long tail', 'f1', { tail: [1, 0] }),
      list('l1', 'Imported, no tail', 'f2', ['w1'], { createdBy: 1, tail: [] }),
      list('l2', 'User list with a tail', 'f1', ['w2'], { createdBy: 0, tail: [0] }),
      list('l3', 'Plain', null, ['w3']),
    ],
  },
});

LIST.push({
  name: 'orphans-and-classes',
  title: 'Items no list refers to, and a class 8 waypoint',
  covers: ['items with no GFI reference go to "Not in any list" (§10; see README choice 1)', 'class 8 counted, not exported (§5.4)'],
  supportedPath: true,
  notes: ['FORMAT.md §5.4 says BCR exports class 0/1 waypoints "that the GFI references"; §10 says items with no GFI ' +
    'reference go to Not in any list. This scenario follows §10 (README choice 1).'],
  library: {
    seed: 118,
    header: { programVersion: 407 },
    items: [
      wpt('w1', 'Listed', 46.3, 9.3),
      wpt('w2', 'Unlisted', 46.31, 9.31, { ele: 999 }),
      wpt('w3', 'Class one listed', 46.32, 9.32, { gdb: { class: 1 } }),
      wpt('w4', 'Route support', 46.33, 9.33, { gdb: { class: 8 } }),
      trk('t1', 'Unlisted track', [line(46.3, 9.3, 3, { t: T0 })]),
      rte('r1', 'Unlisted route', [{ name: 'a', lat: 46.3, lon: 9.3 }, { name: 'b', lat: 46.31, lon: 9.31 }]),
    ],
    folders: [list('l1', 'Only list', null, ['w1', 'w3'])],
  },
});

LIST.push({
  name: 'mac48-library',
  title: 'A library in the Mac BaseCamp 4.8 layouts (H-MAC48): smart lists, class-8 via points, sensor data',
  covers: ['W H-MAC48: the H-KBM tail plus 8 bytes, with address, phone, both times and non-zero opaque bytes (§15.11)',
    'T H-MAC48: the 40-byte tail (elevation) and the 24-byte tail (none), non-zero opaque tail bytes (§15.11)',
    'R H-MAC48: link points [this, next], the last via point through its class-8 waypoint record, one by name (§15.11)',
    'class-8 waypoint records named by a route are counted as route via points, not reported (B42)',
    'R H-MAC48 with one via point: it also fits H-OP, and program version 408 picks H-MAC48 (§3.3 rule 8, B43)',
    'TrackSegments 17-slot points with temperature (slot 6) and heart rate (slot 7): elevation and time kept, sensor data reported (§15.11, B41)',
    "'E' of 8 bytes; F records with the 10-byte tail; I records with created-by 3 (5-byte tail) and 8 (§15.11)",
    'smart lists are left out of the tree and place nothing; an item only a smart list names is in no list (B40)',
    'an item in an import list and a user list'],
  supportedPath: true,
  library: {
    seed: 120,
    header: { programVersion: 408 },
    gdb: { eLength: 8 },
    gfi: { folderTail: 'mac48' },
    items: [
      wpt('w1', 'Lakeside camp', -41.2205, 172.4105, {
        ele: 412.5, time: T0, comment: 'By the water',
        gdb: {
          layout: 'mac48', icon: 141, otherTime: T0 + 5 * MIN, phones: ['555-0199'],
          address: { street: '9 Example Shore', city: 'Sampleton', state: 'SS', country: 'Nowhere', postal: 'X-0001' },
        },
      }),
      wpt('w2', 'Old mill', -41.2301, 172.4202, { time: T0 + 60 * MIN, gdb: { layout: 'mac48', icon: 141, otherTime: T0 + 60 * MIN } }),
      wpt('w3', 'Edited spot', -41.2402, 172.4303, { time: T0 + 2 * MIN, gdb: { layout: 'mac48', otherTime: T0 + 90 * MIN, opaque48: [1, 2, 3, 4, 5, 6, 7, 8] } }),
      wpt('w4', 'Only recent', -41.2503, 172.4404, { ele: -3.5, gdb: { layout: 'mac48', timeIn: 'A' , otherTime: null } }),
      wpt('v1', 'Mill start', -41.2601, 172.4501, { gdb: { layout: 'mac48', class: 8, display: 0 } }),
      wpt('v2', 'Mill bend', -41.2611, 172.4521, { gdb: { layout: 'mac48', class: 8, display: 0 } }),
      wpt('v3', 'Mill end', -41.2621, 172.4541, { gdb: { layout: 'mac48', class: 8, display: 0 } }),
      wpt('v4', 'Lone gate', -41.2631, 172.4561, { gdb: { layout: 'mac48', class: 8, display: 0 } }),
      rte('r1', 'Mill loop', [
        { name: 'Mill start', lat: -41.2601, lon: 172.4501 },
        { name: 'Mill bend', lat: -41.2611, lon: 172.4521 },
        { name: 'Mill end', lat: 0, lon: 0 },
      ], { layout: 'mac48' }),
      rte('r2', 'Bend by name', [
        { name: 'Mill start', lat: -41.2601, lon: 172.4501 },
        { name: 'Mill bend', lat: 0, lon: 0 },
        { name: 'Mill end', lat: 0, lon: 0 },
      ], { layout: 'mac48', colour: 3, via: [{}, { byName: true }] }),
      rte('r3', 'Single stop', [{ name: 'Lone gate', lat: 0, lon: 0 }], { layout: 'mac48' }),
      trk('t1', 'Ridge run', [line(-41.21, 172.41, 6, { ele: 300, t: T0 }).map((p, i) => ({ ...p, atemp: 18.5 + i / 2, hr: 120 + i }))],
        { gdb: { layout: 'mac48', colorIndex: 9 } }),
      trk('t2', 'Valley walk', [line(-41.22, 172.42, 5, { ele: 150.25 })], { gdb: { layout: 'mac48', colorIndex: 9 } }),
      trk('t3', 'Drawn line', [line(-41.23, 172.43, 4)], { gdb: { layout: 'mac48', colorIndex: 9, tail3: [0, 7, 0], tail8: [1, 0, 0, 0, 0, 0, 0, 2] } }),
      trk('t4', 'Twin path', [line(-41.24, 172.44, 3, { ele: 10, t: T0 + 10 * MIN })], { gdb: { layout: 'mac48' } }),
      trk('t5', 'Twin path 001', [line(-41.25, 172.45, 3, { ele: 20, t: T0 + 20 * MIN })], { gdb: { layout: 'mac48' } }),
      trk('t6', 'Some heart rate', [line(-41.26, 172.46, 4, { ele: 30, t: T0 + 30 * MIN }).map((p, i) => (i % 2 ? { ...p, hr: 95 } : p))],
        { gdb: { layout: 'mac48', tailA: 2.75, tailB: 0 } }),
    ],
    folders: [
      list('s1', 'Last Week', null, ['w1', 'w2', 'w3', 'w4', 'r1', 'r2', 't1', 't2', 't3', 't4', 't5', 't6'], { createdBy: 3 }),
      list('s2', 'Last Month', null, ['w1', 'w2', 'w3', 'r1', 'r2', 't1', 't2', 't3', 't4', 't5', 't6'], { createdBy: 3 }),
      folder('f1', 'Trips', null),
      list('l1', 'import-list', 'f1', ['w1', 'w2', 'w3', 'r1', 'r2', 'r3', 't1', 't2', 't3', 't4', 't5', 't6']),
      list('l2', 'Favourites', 'f1', ['w1', 't1']),
      list('u1', 'Unlisted Data', null, [], { createdBy: 8 }),
    ],
  },
});

LIST.push({
  name: 'mac48-negatives',
  title: 'Mac 4.8 records that must not be accepted, and Mac 4.8 GFI tails that are not as expected',
  covers: ['an H-MAC48 waypoint one byte short, and with two phones: prefix only (§15.11)',
    'an H-MAC48 track with a tail flag byte of 2: not decoded (§15.11)',
    "a route point's 19-byte run not all 0, and the autoroute-settings flag 1: route not decoded (§15.11)",
    'a route in OP\'s layout, which only H-OP decodes, in a 408 file: not decoded (§3.3 rule 8, B43)',
    'a 17-slot point with slot 9 (unknown width) present: no elevation or time (§15.11)',
    'class-8 waypoints of routes that are not decoded are counted as not exported (B42)',
    'a folder tail of 2 bytes and a smart-list tail of the wrong length are counted (§15.11)'],
  supportedPath: false,
  library: {
    seed: 121,
    header: { programVersion: 408 },
    gdb: { eLength: 8 },
    gfi: { folderTail: 'mac48' },
    items: [
      wpt('w1', 'Cut short', -42.1, 171.1, { ele: 5, time: T0, gdb: { layout: 'mac48', lengthDelta: -1 } }),
      wpt('w2', 'Two phones', -42.11, 171.11, { ele: 5, time: T0, gdb: { layout: 'mac48', phones: ['1', '2'] } }),
      wpt('w3', 'Fine', -42.12, 171.12, { ele: 5, time: T0, gdb: { layout: 'mac48' } }),
      wpt('v1', 'Gate A', -42.2, 171.2, { gdb: { layout: 'mac48', class: 8 } }),
      wpt('v2', 'Gate B', -42.21, 171.21, { gdb: { layout: 'mac48', class: 8 } }),
      rte('r1', 'Noisy run', [{ name: 'Gate A', lat: -42.2, lon: 171.2 }, { name: 'Gate B', lat: 0, lon: 0 }],
        { layout: 'mac48', via: [{ nonZeroRun: 12 }] }),
      rte('r2', 'Has settings', [{ name: 'Gate A', lat: -42.2, lon: 171.2 }, { name: 'Gate B', lat: 0, lon: 0 }],
        { layout: 'mac48', autorouteSettings: true }),
      rte('r3', 'Old layout', [{ name: 'Gate C', lat: -42.22, lon: 171.22 }, { name: 'Gate D', lat: -42.23, lon: 171.23 }]),
      trk('t1', 'Bad flag', [line(-42.3, 171.3, 4, { ele: 9, t: T0 })], { gdb: { layout: 'mac48', badTailFlag: 2 } }),
      trk('t2', 'Unknown slot', [line(-42.31, 171.31, 4, { ele: 9, t: T0 })], { gdb: { layout: 'mac48' }, ts: { extraByte: { point: 1, byte: 6 } } }),
      trk('t3', 'Good track', [line(-42.32, 171.32, 4, { ele: 9, t: T0 })], { gdb: { layout: 'mac48' } }),
    ],
    folders: [
      list('s1', 'Last Week', null, ['w3', 't3'], { createdBy: 3, tail: [1, 1, 0, 0, 0] }),
      folder('f1', 'Odd folder', null, { tail: [1, 0] }),
      list('l1', 'Checks', 'f1', ['w1', 'w2', 'w3', 'r1', 'r2', 'r3', 't1', 't2', 't3']),
    ],
  },
});

LIST.push({
  name: 'corrupt-truncated-record',
  title: 'AllData.gdb ends in the middle of a track record',
  covers: ['a record running past EOF: stop the file, keep what was read, report (§3.3 rule 2)', 'the lost track is listed but not found'],
  supportedPath: false,
  library: {
    seed: 119,
    header: { programVersion: 407 },
    gdb: { truncate: { item: 't1', keep: 20 } },
    items: [
      wpt('w1', 'Before the cut', 46.0, 8.0, { ele: 10, time: T0 }),
      wpt('w2', 'Also before', 46.01, 8.01),
      trk('t1', 'Cut short', [line(46.0, 8.0, 10)], { ts: { omit: true } }),
    ],
    folders: [list('l1', 'Cut', null, ['w1', 'w2', 't1'])],
  },
});

LIST.push({
  name: 'corrupt-absurd-length',
  title: 'A record length field of 0xFFFFFFF0 in the middle of AllData.gdb',
  covers: ['an absurd record length is a record past EOF: stop, keep everything before it, never allocate it (§3.3 rule 2)'],
  supportedPath: false,
  library: {
    seed: 120,
    header: { programVersion: 407 },
    gdb: { absurdLength: { item: 'w2' } },
    items: [
      wpt('w1', 'Survivor', 46.0, 8.0),
      wpt('w2', 'Absurd', 46.01, 8.01),
      wpt('w3', 'After it', 46.02, 8.02),
      trk('t1', 'Also after it', [line(46.0, 8.0, 3)], { ts: { omit: true } }),
    ],
    folders: [list('l1', 'Absurd', null, ['w1', 'w2', 'w3', 't1'])],
  },
});

LIST.push({
  name: 'corrupt-absurd-counts',
  title: 'Absurd counts inside otherwise well-framed records and files',
  covers: ['W links count 0xFFFFFFFF, T segment count 0xFFFFFFFF, TrackSegments M 0xFFFFFFFF: each checked before any loop',
    'reading continues with the next record'],
  supportedPath: false,
  library: {
    seed: 121,
    header: { programVersion: 407 },
    items: [
      wpt('w1', 'Huge links', 46.0, 8.0, { ele: 5, gdb: { linksCount: 0xffffffff } }),
      trk('t1', 'Huge segments', [line(46.0, 8.0, 3)], { gdb: { segmentCount: 0xffffffff } }),
      trk('t2', 'Huge point count', [line(46.01, 8.01, 3, { ele: 1, t: T0 })], { ts: { countOverride: 0xffffffff } }),
      wpt('w2', 'Fine', 46.02, 8.02, { ele: 6 }),
    ],
    folders: [list('l1', 'Counts', null, ['w1', 't1', 't2', 'w2'])],
  },
});

LIST.push({
  name: 'corrupt-bad-signature',
  title: 'AllData.gdb whose signature is not "MsRc"',
  covers: ['bad signature: whole-file problem, stop reading that file (§3.1 rule 1)'],
  supportedPath: false,
  library: {
    seed: 122,
    header: { programVersion: 407 },
    gdb: { header: { signature: 'MsRx' } },
    items: [wpt('w1', 'Unreachable', 46.0, 8.0)],
    folders: [list('l1', 'List', null, ['w1'])],
  },
});

LIST.push({
  name: 'corrupt-wrong-version',
  title: 'File format 135 (BaseCamp 2.x-3.1.x): rejected with a diagnostic dump',
  covers: ['versions 115-138 are rejected (§4, B6)'],
  supportedPath: false,
  library: {
    seed: 123,
    header: { programVersion: 300, version: 135 },
    items: [wpt('w1', 'Old', 46.0, 8.0)],
    folders: [list('l1', 'List', null, ['w1'])],
  },
});

LIST.push({
  name: 'corrupt-garbage',
  title: 'AllData.gdb replaced by 4 KiB of seeded random bytes',
  covers: ['garbage input: whole-file problem, never a crash or a hang'],
  supportedPath: false,
  library: {
    seed: 124,
    header: { programVersion: 407 },
    gdb: { replace: garbage(4096, 0x9a7b) },
    items: [wpt('w1', 'Listed', 46.0, 8.0)],
    folders: [list('l1', 'List', null, ['w1'])],
  },
});

LIST.push({
  name: 'corrupt-bad-d-record',
  title: "A 'D' record whose length is 3",
  covers: ["the 'D' record must have length 2 (§3.1 rule 2)"],
  supportedPath: false,
  library: {
    seed: 125,
    header: { programVersion: 407 },
    gdb: { header: { dLength: 3 } },
    items: [wpt('w1', 'Unreachable', 46.0, 8.0)],
    folders: [list('l1', 'List', null, ['w1'])],
  },
});

LIST.push({
  name: 'version-exported',
  title: 'File format 109: an exported .gdb, not a library',
  covers: ['107-109 are exported files with no folders or lists (§4)'],
  supportedPath: false,
  library: {
    seed: 126,
    header: { programVersion: 605, version: 109, application: 'MapSource' },
    gfi: null,
    items: [],
    folders: [],
  },
});

LIST.push({
  name: 'version-experimental',
  title: 'File format 170: read with the 1.88 hypotheses, labelled experimental',
  covers: ['146-187 are experimental (§4, B6)', 'program version 4813'],
  supportedPath: true,
  library: {
    seed: 127,
    header: { programVersion: 4813, version: 170 },
    items: [wpt('w1', 'Experimental', 46.0, 8.0, { ele: 77, time: T0 }), trk('t1', 'Experimental track', [line(46.0, 8.0, 4, { ele: 1, t: T0 })])],
    folders: [list('l1', 'List', null, ['w1', 't1'])],
  },
});

LIST.push({
  name: 'header-variants',
  title: 'Author record with extra bytes, application "HomePort", builder "dagsqa"',
  covers: ["'A' record whose cstrs do not end at its body end: counted, reading continues at 18 + L_A (§3.1 rule 3)",
    'application names other than BaseCamp are accepted (§3.1 rule 4)'],
  supportedPath: true,
  library: {
    seed: 128,
    header: { programVersion: 407, application: 'HomePort', builder: 'dagsqa', date: '1/2/2026', time: '12:34:56-07:00' },
    gdb: { header: { aExtra: 2 } },
    items: [wpt('w1', 'Header test', 46.0, 8.0)],
    folders: [list('l1', 'List', null, ['w1'])],
  },
});

LIST.push({
  name: 'unknown-record-type',
  title: "An unknown 'Q' record before the waypoints",
  covers: ['unknown record types are counted and skipped (§3.3 rule 3)'],
  supportedPath: true,
  library: {
    seed: 129,
    header: { programVersion: 407 },
    gdb: { extra: [{ at: 'start', type: 'Q', body: [0x51, 0x00, 0xff, 0xfe, 0x00, 0x01, 0x02] }] },
    items: [wpt('w1', 'After unknown', 46.0, 8.0)],
    folders: [list('l1', 'List', null, ['w1'])],
  },
});

LIST.push({
  name: 'no-end-record',
  title: "AllData.gdb without an 'X' record, and a waypoint after the 'V' record",
  covers: ["EOF without 'X' is normal, counted in the dump only (§3.3 rule 4)", "read to EOF, do not stop at 'V'; order violations counted"],
  supportedPath: true,
  library: {
    seed: 130,
    header: { programVersion: 407 },
    gdb: { end: 'VE' },
    items: [wpt('w1', 'Before V', 46.0, 8.0), wpt('w2', 'After V', 46.01, 8.01, { gdb: { afterV: true } })],
    folders: [list('l1', 'List', null, ['w1', 'w2'])],
  },
});

LIST.push({
  name: 'data-after-end-record',
  title: "Seven bytes after the 'X' record",
  covers: ["data after 'X' is counted and reported, never interpreted (§3.3 rule 4)"],
  supportedPath: true,
  library: {
    seed: 131,
    header: { programVersion: 407 },
    gdb: { end: 'VEX+junk', junkAfterEnd: 7 },
    items: [wpt('w1', 'Before the end', 46.0, 8.0)],
    folders: [list('l1', 'List', null, ['w1'])],
  },
});

const SENTINEL = {
  name: 'ZQX-SENTINEL-NAME-7731',
  comment: 'ZQX-SENTINEL-COMMENT-7732',
  list: 'ZQX-SENTINEL-LIST-7733',
  folder: 'ZQX-SENTINEL-FOLDER-7734',
  track: 'ZQX-SENTINEL-TRACK-7735',
  link: 'ZQX-SENTINEL-LINK-7736',
  phone: '7737-7737',
  street: 'ZQX-SENTINEL-STREET-7738',
  uuid: '7a7b7c7d-1234-4abc-9def-0123456789ab',
  lat: 12.3456789,
  lon: -98.7654321,
  time: Date.UTC(2026, 6, 4, 17, 29, 51),
};

LIST.push({
  name: 'privacy-sentinels',
  title: 'Sentinel names, comments, links, address, coordinates, times and a UUID for the dump privacy test',
  covers: ['ARCHITECTURE.md §11: nothing here may appear in the structure-only dump, in any encoding'],
  supportedPath: true,
  sentinels: {
    strings: [SENTINEL.name, SENTINEL.comment, SENTINEL.list, SENTINEL.folder, SENTINEL.track, SENTINEL.link,
      SENTINEL.phone, SENTINEL.street, SENTINEL.uuid],
    numbers: [SENTINEL.lat, SENTINEL.lon, SENTINEL.time, SENTINEL.time / 1000,
      Math.round((SENTINEL.lat * 2 ** 31) / 180), Math.round((SENTINEL.lon * 2 ** 31) / 180)],
  },
  library: {
    seed: 132,
    header: { programVersion: 407 },
    items: [
      wpt('w1', SENTINEL.name, SENTINEL.lat, SENTINEL.lon, {
        comment: SENTINEL.comment, ele: 1234.5, time: SENTINEL.time,
        gdb: { links: [SENTINEL.link], phones: [SENTINEL.phone], address: { street: SENTINEL.street } },
      }),
      trk('t1', SENTINEL.track, [[
        { lat: SENTINEL.lat, lon: SENTINEL.lon, ele: 1234.5, time: SENTINEL.time },
        { lat: SENTINEL.lat + 0.001, lon: SENTINEL.lon + 0.001, ele: 1240, time: SENTINEL.time + 60_000 },
      ]], { gdb: { uuid: SENTINEL.uuid, links: [SENTINEL.link] } }),
    ],
    folders: [folder('f1', SENTINEL.folder, null), list('l1', SENTINEL.list, 'f1', ['w1', 't1'])],
  },
});

/**
 * Seeded garbage that does not start with "MsRc".
 * @param {number} n
 * @param {number} seed
 */
function garbage(n, seed) {
  let s = seed >>> 0;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  if (out[0] === 0x4d) out[0] = 0x00;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// API

/** Every scenario, in a fixed order. */
export const SCENARIOS = Object.freeze(LIST.map((s) => Object.freeze(s)));

/** @returns {string[]} */
export function scenarioNames() {
  return SCENARIOS.map((s) => s.name);
}

/**
 * @param {string} name
 * @returns {Scenario}
 */
export function getScenario(name) {
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s) throw new RangeError(`no scenario named ${JSON.stringify(name)}`);
  return s;
}

/**
 * Builds a scenario's files and its expected result.
 * @param {string|Scenario} which
 */
export function buildScenario(which) {
  const scenario = typeof which === 'string' ? getScenario(which) : which;
  const built = buildLibrary(scenario.library);
  const expected = deriveExpected(scenario.library, built, { tolerated: scenario.tolerated });
  /** @type {{W: string[], T: string[], TS: number[]}} */
  const exercises = { W: [], T: [], TS: [] };
  for (const m of built.manifest.values()) {
    for (const r of m.records) {
      if (r.type === 'W' && r.intended && !exercises.W.includes(r.intended)) exercises.W.push(r.intended);
      if (r.type === 'T' && r.intended && !exercises.T.includes(r.intended)) exercises.T.push(r.intended);
    }
    if (m.role === 'trackSegments' && m.intendedN?.length === 1 && !exercises.TS.includes(m.intendedN[0])) exercises.TS.push(m.intendedN[0]);
  }
  return { scenario, built, expected, exercises };
}
