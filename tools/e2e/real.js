// Real BaseCamp output in the e2e run: libraries written by Garmin BaseCamp for Mac 4.8.13 holding ONLY made-up
// content (testdata/basecamp-real/README.md). Development only; nothing here is copied into dist/.
//
// The expectation is built the same way the fixture writer's is (tools/fixtures/expect.js shape), but from two
// independent sources, never from the reader:
//   - tools/gate1/expected.json: what the imported GPX files held (names, positions, comments, elevations, times);
//   - what BaseCamp measurably did with them (FORMAT.md §15, testdata/basecamp-real/README.md): one import list
//     "gate1-ocean" under the folder "Gate1 Trips"; its smart lists "Last Week" and "Last Month" (left out, B40) and
//     "Unlisted Data" (kept, empty) under My Collection; the second "Gate1 Twin Track" (Twin Track A, from
//     gate1-desert.gpx) renamed "Gate1 Twin Track 001"; the two-segment GPX track stored as ONE segment; a waypoint
//     whose GPX had no <time> carries the import time (B42); the route's via points as class-8 records (not waypoints).
// It imports nothing from src/.
//
// Samples and how each is handed to the page:
//   real-run1: the founder's Gate 1 run, as a folder (<name>/Database/4.8) and as the 4.8 folder itself;
//   real-run2: run1 plus user lists, a nested folder and items in two lists, as a folder and as BaseCamp's OWN
//              File > Backup (run2-exports/BaseCamp_261007.Backup, byte-identical inside to run2-structured/4.8).

import { readFileSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const REAL = join(ROOT, 'testdata', 'basecamp-real');
const GATE1 = JSON.parse(readFileSync(join(ROOT, 'tools', 'gate1', 'expected.json'), 'utf8'));

const COLLECTION = 'My Collection';
const TRIPS = [COLLECTION, 'Gate1 Trips'];
const OCEAN = [...TRIPS, 'gate1-ocean'];
const DESERT = [...TRIPS, 'Gate1 Desert'];
const INNER = [...TRIPS, 'Gate1 Inner'];
const DEEP = [...INNER, 'Gate1 Deep'];
const UNLISTED = [COLLECTION, 'Unlisted Data'];
/** BaseCamp's own smart lists (created-by 3): they must appear nowhere in the download (B40). */
export const SMART_LISTS = Object.freeze(['Last Week', 'Last Month']);

/**
 * BaseCamp's import time, stored as the creation time of waypoints whose GPX had no <time> (FORMAT.md §15.3 row 22;
 * read from the run1 bytes with tools/hexmap.js --show-text). gate1-ocean.gpx was imported at 11:40:16Z,
 * gate1-desert.gpx at 11:40:26Z.
 */
const IMPORT_TIME = Object.freeze({
  'Gate1 Waypoint Bravo': '2026-10-07T11:40:16Z',
  'Gate1 Waypoint Charlie': '2026-10-07T11:40:16Z',
  'Gate1 Waypoint Delta': '2026-10-07T11:40:26Z',
});

/** expected.json track label → the name BaseCamp stored (the twins told apart by their positions, FORMAT.md §15.7). */
const TRACK_NAME = Object.freeze({
  'Track Timed': 'Gate1 Track Timed',
  'Track No Time': 'Gate1 Track No Time',
  'Track Bare': 'Gate1 Track Bare',
  'Track Two Segments': 'Gate1 Track Two Segments',
  'Twin Track A': 'Gate1 Twin Track 001',
  'Twin Track B': 'Gate1 Twin Track',
  'Track Sensors': 'Gate1 Track Sensors',
});

/**
 * @typedef {object} RealSample
 * @property {string} name
 * @property {string} source       the 4.8 folder BaseCamp wrote
 * @property {string|null} backup  BaseCamp's own .Backup of the same library, when there is one
 * @property {('folder'|'backup'|'version-folder')[]} intakes
 * @property {string[][]} tree     folder and list name paths; a folder's path ends with an empty string
 * @property {Record<string, string[][]>} alsoIn  item name → the user lists it was dragged into as well
 * @property {Record<string, number>} elevation   item name → altitude BaseCamp changed
 * @property {Record<string, number>} report       problem phrase → count the report must show
 */

/** @type {readonly RealSample[]} */
export const REAL_SAMPLES = Object.freeze([
  {
    name: 'real-run1',
    source: join(REAL, 'run1-gate1', '4.8'),
    backup: null,
    intakes: ['folder', 'version-folder'],
    tree: [[COLLECTION, ''], [...TRIPS, ''], OCEAN, UNLISTED],
    alsoIn: {},
    elevation: {},
    report: {},
  },
  {
    name: 'real-run2',
    source: join(REAL, 'run2-structured', '4.8'),
    backup: join(REAL, 'run2-exports', 'BaseCamp_261007.Backup'),
    intakes: ['folder', 'backup'],
    tree: [[COLLECTION, ''], [...TRIPS, ''], OCEAN, DESERT, [...INNER, ''], DEEP, UNLISTED],
    // README: "Gate1 Waypoint Alpha and Gate1 Track Timed are in gate1-ocean AND Gate1 Desert; Gate1 Route Four and
    // Gate1 Track Two Segments are in gate1-ocean AND Gate1 Deep."
    alsoIn: {
      'Gate1 Waypoint Alpha': [DESERT],
      'Gate1 Track Timed': [DESERT],
      'Gate1 Route Four': [DEEP],
      'Gate1 Track Two Segments': [DEEP],
    },
    // FORMAT.md §15.3 row 14: after its contact info was typed, BaseCamp stored Delta's altitude as 329 ft.
    elevation: { 'Gate1 Waypoint Delta': 329 * 0.3048 },
    report: { 'Items in more than one list: 4': 1 },
  },
]);

/** @param {string} name */
export function realSample(name) {
  const s = REAL_SAMPLES.find((x) => x.name === name);
  if (!s) throw new Error(`no real sample ${name}`);
  return s;
}

/** @param {string|null} iso */
const ms = (iso) => (iso === null ? null : Date.parse(iso));

/**
 * The expectation for a real sample, in the fixture writer's shape (tools/fixtures/expect.js), so expectedLayout(),
 * checkPreview() and checkZip() use it unchanged.
 * @param {string} name
 */
export function realExpected(name) {
  const s = realSample(name);
  /** @param {string} item */
  const lists = (item) => [OCEAN, ...(s.alsoIn[item] ?? [])];
  /** @type {any[]} */
  const items = [];
  for (const w of GATE1.waypoints) {
    items.push({
      kind: 'waypoint',
      name: w.name,
      comment: w.comment,
      lat: w.lat,
      lon: w.lon,
      ele: w.name in s.elevation ? s.elevation[w.name] : w.ele,
      time: ms(w.time ?? /** @type {Record<string, string>} */ (IMPORT_TIME)[w.name] ?? null),
      placement: 'lists',
      lists: lists(w.name),
    });
  }
  for (const r of GATE1.routes) {
    items.push({
      kind: 'route',
      name: r.name,
      points: r.via.map((/** @type {any} */ v) => ({ name: v.name, lat: v.lat, lon: v.lon })),
      placement: 'lists',
      lists: lists(r.name),
    });
  }
  for (const t of GATE1.tracks) {
    const name = /** @type {Record<string, string>} */ (TRACK_NAME)[t.label];
    if (!name) throw new Error(`no stored name for ${t.label}`);
    items.push({
      kind: 'track',
      name,
      // BaseCamp joined the GPX segments into one (FORMAT.md §15.4).
      segments: [t.segments.flat().map((/** @type {any} */ p) => ({ lat: p.lat, lon: p.lon, ele: p.ele, time: ms(p.time), hr: p.hr ?? null, atemp: p.atemp ?? null }))],
      placement: 'lists',
      lists: lists(name),
    });
  }
  const multi = Object.keys(s.alsoIn).length;
  return {
    fatal: null,
    versions: { gdb: 188, gfi: 188 },
    experimental: false,
    tree: s.tree.map((p) => (p.at(-1) === '' ? { path: p.slice(0, -1), type: 'folder' } : { path: p, type: 'list' })),
    items,
    notDecoded: [],
    routesNotConverted: [],
    duplicates: [],
    problems: [
      { code: 'smart_lists_left_out', count: 2 },
      { code: 'track_sensor_data_kept', count: 1 },
      ...(multi > 0 ? [{ code: 'item_in_several_lists', count: multi }] : []),
    ],
    counted: [{ code: 'route_via_point_record', count: 4 }],
    tolerated: [],
  };
}

/**
 * Copies a real sample into <dir>/<name>/Database/4.8/ (and its .Backup to <dir>/<name>.Backup). The testdata copy
 * is never written to.
 * @param {string} dir
 * @param {string[]} names
 * @returns {Promise<Map<string, {expected: any, bytes: number, real: true}>>}
 */
export async function writeRealSamples(dir, names) {
  /** @type {Map<string, {expected: any, bytes: number, real: true}>} */
  const out = new Map();
  for (const name of names) {
    const s = realSample(name);
    const target = join(dir, name, 'Database', '4.8');
    await rm(join(dir, name), { recursive: true, force: true });
    let bytes = 0;
    /** @param {string} from @param {string} to */
    const copy = async (from, to) => {
      await mkdir(to, { recursive: true });
      for (const entry of await readdir(from, { withFileTypes: true })) {
        if (entry.isDirectory()) await copy(join(from, entry.name), join(to, entry.name));
        else if (entry.isFile()) {
          await copyFile(join(from, entry.name), join(to, entry.name));
          bytes += (await stat(join(from, entry.name))).size;
        }
      }
    };
    await copy(s.source, target);
    if (s.backup) await copyFile(s.backup, join(dir, `${name}.Backup`));
    out.set(name, { expected: realExpected(name), bytes, real: true });
  }
  return out;
}

/**
 * The KML's folder tree: every <Folder> as its name path, with the names of the placemarks directly inside it.
 * @param {string} xml
 * @returns {Map<string, string[]>}  "My Collection / Gate1 Trips" → placemark names
 */
export function kmlFolders(xml) {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  /** @type {string[]} */
  const stack = [];
  /** @type {'folder'|'placemark'|null} */
  let pendingName = null;
  for (const m of xml.matchAll(/<(\/?)(Folder|Placemark)>|<name>([\s\S]*?)<\/name>/g)) {
    if (m[2] === 'Folder') {
      if (m[1]) stack.pop();
      else pendingName = 'folder';
    } else if (m[2] === 'Placemark') {
      if (!m[1]) pendingName = 'placemark';
    } else if (pendingName) {
      const name = unescape(m[3]);
      if (pendingName === 'folder') {
        stack.push(name);
        out.set(stack.join(' / '), []);
      } else out.get(stack.join(' / '))?.push(name);
      pendingName = null;
    }
  }
  return out;
}

/** @param {string} s */
function unescape(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/**
 * Checks for a real sample on top of the fixture checks: the exact ZIP listing, the KML folder nesting with each
 * folder's placemarks, no smart list anywhere, and what the report says.
 * @param {string} name
 * @param {Map<string, Uint8Array>} files  ZIP entries (no directories)
 * @param {string[]} problems
 */
export function checkRealZip(name, files, problems) {
  const s = realSample(name);
  const expected = realExpected(name);
  const text = (/** @type {string} */ n) => new TextDecoder().decode(files.get(n));

  // The listing: one GPX per list (smart lists left out), All items, one KML, the report and the read-me.
  const lists = expected.tree.filter((/** @type {any} */ e) => e.type === 'list').map((/** @type {any} */ e) => `GPX/${e.path.join('/')}.gpx`);
  const want = [...lists, 'GPX/All items.gpx', 'KML/My Collection.kml', 'READ-ME-FIRST.txt', 'report.html', 'report.txt'].sort();
  const got = [...files.keys()].sort();
  if (got.join('\n') !== want.join('\n')) problems.push(`real sample ZIP holds ${got.join(', ')}; want ${want.join(', ')}`);
  for (const n of got) {
    if (SMART_LISTS.some((smart) => n.includes(smart))) problems.push(`a smart list was written: ${n}`);
  }

  // KML: the folders nest as the tree, each with exactly its items as placemarks.
  if (files.has('KML/My Collection.kml')) {
    const kml = text('KML/My Collection.kml');
    const folders = kmlFolders(kml);
    /** @type {Map<string, string[]>} */
    const wantFolders = new Map(expected.tree.map((/** @type {any} */ e) => [e.path.join(' / '), /** @type {string[]} */ ([])]));
    for (const item of expected.items) for (const l of item.lists) wantFolders.get(l.join(' / '))?.push(item.name);
    for (const [path, names] of wantFolders) {
      const placed = folders.get(path);
      if (!placed) problems.push(`KML has no folder ${path}`);
      else if ([...placed].sort().join('|') !== [...names].sort().join('|')) {
        problems.push(`KML folder ${path} holds ${placed.length} placemarks (${[...placed].sort().join(', ')}), want ${names.length}`);
      }
    }
    for (const path of folders.keys()) if (!wantFolders.has(path)) problems.push(`KML has an unexpected folder ${path}`);
    for (const smart of SMART_LISTS) if (kml.includes(`<name>${smart}</name>`)) problems.push(`KML names the smart list ${smart}`);
  }

  // The report: what was left out and why; nothing "not converted"; the counts.
  if (files.has('report.txt')) {
    const report = text('report.txt');
    const lines = [
      '  - Waypoints: 6',
      '  - Tracks: 7 (6 with elevation or time, 1 with heart rate or temperature)',
      '  - Routes: 1',
      `  - Lists: ${lists.length}`,
      `  - Folders: ${expected.tree.filter((/** @type {any} */ e) => e.type === 'folder').length - 1} (not counting the top folder)`,
      ...Object.keys(s.report).map((phrase) => `  - ${phrase}`),
    ];
    for (const line of lines) if (!report.split('\n').some((l) => l.startsWith(line))) problems.push(`report.txt has no line "${line.trim()}"`);
    if (!/BaseCamp's smart lists \(such as "Last Week" and "Last Month"\) were not saved as lists[^\n]*\(2\)/.test(report)) {
      problems.push('report.txt does not say that the 2 smart lists were left out');
    }
    if (!/Some tracks also hold heart rate or air temperature readings\. They are kept in the GPX files/.test(report)) {
      problems.push('report.txt does not say heart rate and temperature were kept in the GPX files');
    }
    for (const section of ['Not converted', 'Duplicate names', 'Tracks without elevation and time']) {
      if (report.includes(`\n${section}\n`)) problems.push(`report.txt has a "${section}" section`);
    }
    if (/waypoint records are the via points/i.test(report)) problems.push('report.txt mentions the via-point records (dump-level only, B42)');
  }
}
