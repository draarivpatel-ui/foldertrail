// Gate 1 kit: the made-up GPX files the founder imports into a real BaseCamp, and expected.json, which says exactly
// what they hold. Both come from SPEC below, so they cannot drift apart. Run `node tools/gate1/make-gpx.js` to rewrite
// tools/gate1/gpx/*.gpx and tools/gate1/expected.json; test/gate1.test.js checks that the committed files are current.
//
// Everything here is invented: names start with "Gate1 ", positions are in the middle of the South Pacific, the
// Rub' al Khali desert and the South Indian Ocean, times are in 2001-2006, and the addresses and phone numbers are
// fictional (555-01xx numbers are reserved for fiction).
//
// gate1-desert.gpx is written by our own GPX writer (src/export/gpx.js), so Gate 1 also shows whether BaseCamp
// imports what BCR writes. The other two files need Garmin extension elements the writer does not produce
// (an address and phone number on a waypoint; heart rate and air temperature on track points), so they are written
// here with the same escaping and number formatting (src/export/xml.js). Extension element names and order follow
// Garmin's schemas GpxExtensionsv3.xsd (WaypointExtension_t: ... Address, PhoneNumber; Address_t: StreetAddress, City,
// State, Country, PostalCode) and TrackPointExtensionv1.xsd (TrackPointExtension_t: atemp, wtemp, depth, hr, cad),
// read 2026-10-05.

import { writeGpx } from '../../src/export/gpx.js';
import { escapeAttr, escapeText, formatEle, formatGpxLon, formatLat, formatTime } from '../../src/export/xml.js';

export const KIT_VERSION = 1;
const CREATOR = 'BCR Gate 1 kit (made-up test data)';
const GPX_NS = 'http://www.topografix.com/GPX/1/1';
const GPXX_NS = 'http://www.garmin.com/xmlschemas/GpxExtensions/v3';
const GPXTPX_NS = 'http://www.garmin.com/xmlschemas/TrackPointExtension/v1';

/**
 * @typedef {object} SpecPoint
 * @property {number} lat
 * @property {number} lon
 * @property {number|null} ele
 * @property {string|null} time   ISO-8601 UTC, or null
 * @property {number} [hr]        beats per minute (sensor track only)
 * @property {number} [atemp]     degrees Celsius (sensor track only)
 */

/**
 * @typedef {object} Address
 * @property {string} street
 * @property {string} city
 * @property {string} state
 * @property {string} country
 * @property {string} postalCode
 */

/**
 * Integer steps keep every coordinate at exactly 7 decimals, so the GPX text is the value in SPEC.
 * @param {number} deg
 * @param {number} i
 * @param {number} stepE7  step in units of 1e-7 degree
 * @returns {number}
 */
function step(deg, i, stepE7) {
  return Math.round(deg * 1e7 + i * stepE7) / 1e7;
}

/**
 * @param {string} iso
 * @param {number} seconds
 * @returns {string}
 */
function addSeconds(iso, seconds) {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString().replace('.000Z', 'Z');
}

/**
 * A straight run of track points.
 * @param {object} o
 * @param {number} o.n
 * @param {number} o.lat
 * @param {number} o.lon
 * @param {number} o.dLatE7
 * @param {number} o.dLonE7
 * @param {number|null} o.ele0       first elevation, or null for none
 * @param {number} [o.eleStep]
 * @param {string|null} o.t0         first time, or null for none
 * @param {number} [o.dt]            seconds between points
 * @param {boolean} [o.sensors]      add hr and atemp
 * @returns {SpecPoint[]}
 */
function run(o) {
  /** @type {SpecPoint[]} */
  const points = [];
  for (let i = 0; i < o.n; i++) {
    /** @type {SpecPoint} */
    const p = {
      lat: step(o.lat, i, o.dLatE7),
      lon: step(o.lon, i, o.dLonE7),
      ele: o.ele0 === null ? null : o.ele0 + i * (o.eleStep ?? 0),
      time: o.t0 === null ? null : addSeconds(o.t0, i * (o.dt ?? 10)),
    };
    if (o.sensors) {
      p.hr = 100 + i;
      p.atemp = 20.5 + i * 0.25;
    }
    points.push(p);
  }
  return points;
}

const FOLDER_TRIPS = 'Gate1 Trips';
const FOLDER_INNER = 'Gate1 Inner';
const LIST_OCEAN = 'Gate1 Ocean';
const LIST_DESERT = 'Gate1 Desert';
const LIST_DEEP = 'Gate1 Deep';

/** The made-up content, in one place. Labels are what the check page prints; they are never read from a file. */
export const SPEC = Object.freeze({
  folders: [
    { label: 'Folder Trips', name: FOLDER_TRIPS, parent: null },
    { label: 'Folder Inner', name: FOLDER_INNER, parent: FOLDER_TRIPS },
  ],
  lists: [
    { label: 'List Ocean', name: LIST_OCEAN, folder: FOLDER_TRIPS, file: 'gate1-ocean.gpx' },
    { label: 'List Desert', name: LIST_DESERT, folder: FOLDER_TRIPS, file: 'gate1-desert.gpx' },
    { label: 'List Deep', name: LIST_DEEP, folder: FOLDER_INNER, file: 'gate1-deep.gpx' },
  ],
  waypoints: [
    {
      label: 'Waypoint Alpha',
      name: 'Gate1 Waypoint Alpha',
      file: 'gate1-ocean.gpx',
      lists: [LIST_OCEAN, LIST_DESERT], // the founder drags it into the second list by hand
      lat: -48.8761234,
      lon: -123.3934567,
      ele: 12.5,
      time: '2001-02-03T04:05:06Z',
      comment: 'Gate1 comment Alpha',
      symbol: 'Flag, Blue',
      address: null,
      phone: null,
      typedByHand: null,
    },
    {
      label: 'Waypoint Bravo',
      name: 'Gate1 Waypoint Bravo',
      file: 'gate1-ocean.gpx',
      lists: [LIST_OCEAN],
      lat: -48.8812345,
      lon: -123.4012345,
      ele: null,
      time: null,
      comment: '',
      symbol: '',
      // Imported from Garmin's GPX extension fields, if BaseCamp reads them.
      address: {
        street: '1 Gate1 Imported Street',
        city: 'Gate1 Imported City',
        state: 'Gate1 Imported State',
        country: 'Gate1 Imported Country',
        postalCode: 'G1-0001',
      },
      phone: '555-0101',
      typedByHand: null,
    },
    {
      label: 'Waypoint Charlie',
      name: 'Gate1 Waypoint Charlie',
      file: 'gate1-ocean.gpx',
      lists: [LIST_OCEAN],
      lat: -48.8698765,
      lon: -123.3876543,
      ele: null,
      time: null,
      comment: '',
      symbol: '',
      address: null,
      phone: null,
      typedByHand: null,
    },
    {
      label: 'Waypoint Delta',
      name: 'Gate1 Waypoint Delta',
      file: 'gate1-desert.gpx',
      lists: [LIST_DESERT],
      lat: 20.1234567,
      lon: 50.4567891,
      ele: 100.25,
      time: null,
      comment: 'Gate1 comment Delta',
      symbol: '',
      address: null,
      phone: null,
      // The founder types these into BaseCamp's Contact Info by hand (STEPS.md). The GPX file has none of them.
      typedByHand: {
        street: '12 Gate1 Typed Lane',
        city: 'Gate1 Typed Town',
        state: 'Gate1 Typed State',
        country: 'Gate1 Typed Land',
        postalCode: 'G1-0002',
        phone: '555-0102',
      },
    },
    {
      label: 'Waypoint Echo',
      name: 'Gate1 Waypoint Echo',
      file: 'gate1-desert.gpx',
      lists: [LIST_DESERT],
      lat: 20.1345678,
      lon: 50.4678912,
      ele: null,
      time: '2001-02-03T05:06:07Z',
      comment: '',
      symbol: '',
      address: null,
      phone: null,
      typedByHand: null,
    },
    {
      label: 'Waypoint Foxtrot',
      name: 'Gate1 Waypoint Foxtrot',
      file: 'gate1-deep.gpx',
      lists: [LIST_DEEP],
      lat: -35.2512345,
      lon: 85.7512345,
      ele: 3.75,
      time: '2006-07-08T09:10:11Z',
      comment: 'Gate1 comment Foxtrot',
      symbol: '',
      address: null,
      phone: null,
      typedByHand: null,
    },
  ],
  routes: [
    {
      label: 'Route Four',
      name: 'Gate1 Route Four',
      file: 'gate1-desert.gpx',
      lists: [LIST_DESERT],
      via: [
        { label: 'Via One', name: 'Gate1 Via One', lat: 20.1012345, lon: 50.4012345 },
        { label: 'Via Two', name: 'Gate1 Via Two', lat: 20.1112345, lon: 50.4212345 },
        { label: 'Via Three', name: 'Gate1 Via Three', lat: 20.1212345, lon: 50.4412345 },
        { label: 'Via Four', name: 'Gate1 Via Four', lat: 20.1312345, lon: 50.4612345 },
      ],
    },
  ],
  tracks: [
    {
      label: 'Track Timed',
      name: 'Gate1 Track Timed',
      file: 'gate1-desert.gpx',
      lists: [LIST_DESERT, LIST_OCEAN], // the founder drags it into the second list by hand
      segments: [
        run({ n: 10, lat: 20.2001234, lon: 50.5001234, dLatE7: 1500, dLonE7: 2500, ele0: 200, eleStep: 0.5, t0: '2002-03-04T05:06:07Z', dt: 10 }),
      ],
    },
    {
      label: 'Track No Time',
      name: 'Gate1 Track No Time',
      file: 'gate1-desert.gpx',
      lists: [LIST_DESERT],
      segments: [
        run({ n: 8, lat: 20.2101234, lon: 50.5101234, dLatE7: -1200, dLonE7: 2100, ele0: 150.5, eleStep: 1, t0: null }),
      ],
    },
    {
      label: 'Track Bare',
      name: 'Gate1 Track Bare',
      file: 'gate1-desert.gpx',
      lists: [LIST_DESERT],
      segments: [run({ n: 6, lat: 20.2201234, lon: 50.5201234, dLatE7: 900, dLonE7: -1700, ele0: null, t0: null })],
    },
    {
      label: 'Track Two Segments',
      name: 'Gate1 Track Two Segments',
      file: 'gate1-desert.gpx',
      lists: [LIST_DESERT],
      segments: [
        run({ n: 6, lat: 20.2301234, lon: 50.5301234, dLatE7: 1100, dLonE7: 1300, ele0: 300.25, eleStep: 0.25, t0: '2003-04-05T06:07:08Z', dt: 15 }),
        run({ n: 5, lat: 20.2401234, lon: 50.5401234, dLatE7: 1400, dLonE7: -800, ele0: 310.75, eleStep: 0.25, t0: '2003-04-05T07:00:00Z', dt: 15 }),
      ],
    },
    {
      label: 'Twin Track A',
      name: 'Gate1 Twin Track',
      file: 'gate1-desert.gpx',
      lists: [LIST_DESERT],
      segments: [
        run({ n: 5, lat: 20.2501234, lon: 50.5501234, dLatE7: 1000, dLonE7: 1000, ele0: 250, eleStep: 2, t0: '2005-06-07T08:09:10Z', dt: 20 }),
      ],
    },
    {
      label: 'Twin Track B',
      name: 'Gate1 Twin Track', // the same name on purpose, in another file and list
      file: 'gate1-deep.gpx',
      lists: [LIST_DEEP],
      segments: [
        run({ n: 7, lat: -35.2601234, lon: 85.7601234, dLatE7: -1000, dLonE7: 1500, ele0: 0.5, eleStep: 0.5, t0: '2005-06-07T09:00:00Z', dt: 20 }),
      ],
    },
    {
      label: 'Track Sensors',
      name: 'Gate1 Track Sensors',
      file: 'gate1-deep.gpx',
      lists: [LIST_DEEP],
      segments: [
        run({ n: 9, lat: -35.2701234, lon: 85.7701234, dLatE7: 1300, dLonE7: 1300, ele0: 5.5, eleStep: 0.5, t0: '2004-05-06T07:08:09Z', dt: 5, sensors: true }),
      ],
    },
  ],
});

// ---------------------------------------------------------------------------------------------
// GPX text

/**
 * @param {string} iso
 * @returns {number}
 */
function ms(iso) {
  return Date.parse(iso);
}

/**
 * @param {string} tag
 * @param {string} text
 * @param {string} indent
 * @returns {string}
 */
function el(tag, text, indent) {
  return text === '' ? '' : `${indent}<${tag}>${escapeText(text)}</${tag}>\n`;
}

/**
 * @param {number} lat
 * @param {number} lon
 * @returns {string}
 */
function latLonAttrs(lat, lon) {
  const la = formatLat(lat);
  const lo = formatGpxLon(lon);
  if (la === null || lo === null) throw new Error('make-gpx: position out of range');
  return `lat="${la}" lon="${lo}"`;
}

/**
 * @param {number|null} ele
 * @param {string|null} time
 * @param {string} indent
 * @returns {string}
 */
function eleTime(ele, time, indent) {
  let out = '';
  if (ele !== null) out += `${indent}<ele>${formatEle(ele)}</ele>\n`;
  if (time !== null) out += `${indent}<time>${formatTime(ms(time))}</time>\n`;
  return out;
}

/**
 * The header for the hand-written files (the same shape as gpx.js writes, plus the extension namespaces).
 * @param {string} listName
 * @param {boolean} gpxtpx
 * @returns {string}
 */
function header(listName, gpxtpx) {
  const ns = [
    `xmlns="${GPX_NS}"`,
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    `xmlns:gpxx="${GPXX_NS}"`,
    ...(gpxtpx ? [`xmlns:gpxtpx="${GPXTPX_NS}"`] : []),
  ].join(' ');
  const schemaLocation = [
    `${GPX_NS} http://www.topografix.com/GPX/1/1/gpx.xsd`,
    `${GPXX_NS} http://www8.garmin.com/xmlschemas/GpxExtensionsv3.xsd`,
    ...(gpxtpx ? [`${GPXTPX_NS} http://www8.garmin.com/xmlschemas/TrackPointExtensionv1.xsd`] : []),
  ].join(' ');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<gpx version="1.1" creator="${escapeAttr(CREATOR)}" ${ns} xsi:schemaLocation="${schemaLocation}">\n` +
    `  <metadata>\n    <name>${escapeText(listName)}</name>\n` +
    '    <desc>Made-up test data for the BCR Gate 1 check. Not a real place or trip.</desc>\n  </metadata>\n'
  );
}

/**
 * @param {typeof SPEC.waypoints[number]} w
 * @returns {string}
 */
function waypointXml(w) {
  let inner = eleTime(w.ele, w.time, '    ');
  inner += el('name', w.name, '    ');
  inner += el('cmt', w.comment, '    ');
  inner += el('sym', w.symbol, '    ');
  if (w.address !== null || w.phone !== null) {
    inner += '    <extensions>\n      <gpxx:WaypointExtension>\n';
    if (w.address !== null) {
      const a = w.address;
      inner +=
        '        <gpxx:Address>\n' +
        el('gpxx:StreetAddress', a.street, '          ') +
        el('gpxx:City', a.city, '          ') +
        el('gpxx:State', a.state, '          ') +
        el('gpxx:Country', a.country, '          ') +
        el('gpxx:PostalCode', a.postalCode, '          ') +
        '        </gpxx:Address>\n';
    }
    if (w.phone !== null) inner += el('gpxx:PhoneNumber', w.phone, '        ');
    inner += '      </gpxx:WaypointExtension>\n    </extensions>\n';
  }
  return `  <wpt ${latLonAttrs(w.lat, w.lon)}>\n${inner}  </wpt>\n`;
}

/**
 * @param {typeof SPEC.tracks[number]} t
 * @returns {string}
 */
function trackXml(t) {
  let out = `  <trk>\n${el('name', t.name, '    ')}`;
  for (const segment of t.segments) {
    out += '    <trkseg>\n';
    for (const p of segment) {
      let inner = eleTime(p.ele, p.time, '        ');
      if (p.hr !== undefined || p.atemp !== undefined) {
        inner += '        <extensions>\n          <gpxtpx:TrackPointExtension>\n';
        if (p.atemp !== undefined) inner += `            <gpxtpx:atemp>${p.atemp}</gpxtpx:atemp>\n`;
        if (p.hr !== undefined) inner += `            <gpxtpx:hr>${p.hr}</gpxtpx:hr>\n`;
        inner += '          </gpxtpx:TrackPointExtension>\n        </extensions>\n';
      }
      out += inner === '' ? `      <trkpt ${latLonAttrs(p.lat, p.lon)}/>\n` : `      <trkpt ${latLonAttrs(p.lat, p.lon)}>\n${inner}      </trkpt>\n`;
    }
    out += '    </trkseg>\n';
  }
  return out + '  </trk>\n';
}

/**
 * A hand-written file (waypoints, then tracks; these files hold no routes).
 * @param {string} file
 * @param {string} listName
 * @returns {string}
 */
function handWritten(file, listName) {
  const waypoints = SPEC.waypoints.filter((w) => w.file === file);
  const tracks = SPEC.tracks.filter((t) => t.file === file);
  if (SPEC.routes.some((r) => r.file === file)) throw new Error('make-gpx: hand-written files hold no routes');
  const gpxtpx = tracks.some((t) => t.segments.some((s) => s.some((p) => p.hr !== undefined)));
  let out = header(listName, gpxtpx);
  for (const w of waypoints) out += waypointXml(w);
  for (const t of tracks) out += trackXml(t);
  return out + '</gpx>\n';
}

/**
 * The file written by BCR's own GPX writer. It must hold nothing that writer cannot express.
 * @param {string} file
 * @param {string} listName
 * @returns {string}
 */
function viaOurWriter(file, listName) {
  /** @type {import('../../src/model.js').Item[]} */
  const items = [];
  let n = 0;
  for (const w of SPEC.waypoints.filter((x) => x.file === file)) {
    if (w.address !== null || w.phone !== null) throw new Error('make-gpx: our writer cannot carry an address');
    items.push({
      kind: 'waypoint',
      id: `w${n++}`,
      name: w.name,
      comment: w.comment,
      symbol: w.symbol,
      lat: w.lat,
      lon: w.lon,
      ele: w.ele,
      time: w.time === null ? null : ms(w.time),
    });
  }
  for (const r of SPEC.routes.filter((x) => x.file === file)) {
    items.push({
      kind: 'route',
      id: `r${n++}`,
      name: r.name,
      comment: '',
      points: r.via.map((v) => ({ lat: v.lat, lon: v.lon, ele: null, name: v.name, symbol: '' })),
    });
  }
  for (const t of SPEC.tracks.filter((x) => x.file === file)) {
    if (t.segments.some((s) => s.some((p) => p.hr !== undefined))) throw new Error('make-gpx: our writer has no sensors');
    items.push({
      kind: 'track',
      id: `t${n++}`,
      name: t.name,
      comment: '',
      color: null,
      segments: t.segments.map((s) => s.map((p) => ({ lat: p.lat, lon: p.lon, ele: p.ele, time: p.time === null ? null : ms(p.time) }))),
    });
  }
  const { xml, problems } = writeGpx(items, {
    creator: CREATOR,
    name: listName,
    desc: 'Made-up test data for the BCR Gate 1 check. Not a real place or trip.',
  });
  if (problems.length > 0) throw new Error('make-gpx: the GPX writer left something out');
  return xml;
}

// ---------------------------------------------------------------------------------------------
// expected.json

/** @returns {object} */
function expectedObject() {
  const trackPoints = SPEC.tracks.reduce((sum, t) => sum + t.segments.reduce((s, seg) => s + seg.length, 0), 0);
  return {
    kit: 'BCR Gate 1',
    kitVersion: KIT_VERSION,
    note:
      'Everything here is made up. The founder imports gpx/*.gpx into BaseCamp 4.8.13, builds the tree below, ' +
      'types the typedByHand values into Contact Info, and drags the two items marked with two lists. ' +
      'The check page compares a real BaseCamp library against this file and prints only counts and yes/no.',
    files: SPEC.lists.map((l) => ({ file: l.file, importInto: l.name, writtenBy: l.file === 'gate1-desert.gpx' ? 'src/export/gpx.js' : 'tools/gate1/make-gpx.js' })),
    tree: { root: 'My Collection', folders: SPEC.folders, lists: SPEC.lists },
    waypoints: SPEC.waypoints,
    routes: SPEC.routes,
    tracks: SPEC.tracks.map((t) => ({ ...t, pointCount: t.segments.reduce((s, seg) => s + seg.length, 0) })),
    counts: {
      folders: SPEC.folders.length,
      lists: SPEC.lists.length,
      waypoints: SPEC.waypoints.length,
      routeViaPoints: SPEC.routes.reduce((s, r) => s + r.via.length, 0),
      routes: SPEC.routes.length,
      tracks: SPEC.tracks.length,
      trackPoints,
      itemsInTwoLists: [...SPEC.waypoints, ...SPEC.tracks].filter((x) => x.lists.length === 2).length,
    },
  };
}

/**
 * Everything the kit generates, as text. Deterministic: the same SPEC always gives the same bytes.
 * @returns {{ files: Record<string, string>, expectedJson: string }}
 */
export function generate() {
  /** @type {Record<string, string>} */
  const files = {};
  for (const list of SPEC.lists) {
    files[list.file] = list.file === 'gate1-desert.gpx' ? viaOurWriter(list.file, list.name) : handWritten(list.file, list.name);
  }
  return { files, expectedJson: JSON.stringify(expectedObject(), null, 2) + '\n' };
}

// Run directly: write the files next to this script.
if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const here = fileURLToPath(new URL('.', import.meta.url));
  const { files, expectedJson } = generate();
  mkdirSync(`${here}gpx`, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(`${here}gpx/${name}`, text);
  writeFileSync(`${here}expected.json`, expectedJson);
  console.log(`Wrote ${Object.keys(files).length} GPX files and expected.json`);
}
