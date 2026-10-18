// Tests for the Gate 1 kit (tools/gate1/): the made-up GPX files and expected.json, the comparison, the check page's
// pipeline, the bundled page, and the founder's steps. All data is synthetic and made up.
//
// Run: node --test --test-concurrency=2 test/gate1.test.js

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test, describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { generate, SPEC } from '../tools/gate1/make-gpx.js';
import { compareLibrary, internals as compareInternals, POSITION_TOLERANCE } from '../tools/gate1/compare.js';
import { buildSyntheticLibrary, internals as synthInternals, toSemicircles } from '../tools/gate1/synth.js';
import {
  runCheck,
  selfTest,
  selfTestPassed,
  roleOf,
  libraryKey,
  fromBlob,
  inputsFromDrop,
  inputsFromPicker,
  MAX_LIBRARY_FILE_BYTES,
} from '../tools/gate1/check.js';
import { basicDump, structureDump } from '../tools/gate1/dump-adapter.js';
import { buildPage, buildBundle, transformModule, collectModules, sha256Source } from '../tools/gate1/build.js';
import { readContainer, readHeader } from '../src/format/container.js';
import { zipBytes } from '../src/export/zip.js';
import { SCENARIOS, buildScenario } from '../tools/fixtures/scenarios.js';
import { buildBackup } from '../tools/fixtures/backup.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.join(HERE, '..', 'tools', 'gate1');
const read = (/** @type {string} */ rel) => readFileSync(path.join(KIT, rel), 'utf8');
const EXPECTED = JSON.parse(read('expected.json'));
const LIB = 'Database/4.8';

/** @param {Map<string, Uint8Array>} files */
function parsedLibrary(files) {
  const gdbBytes = files.get(`${LIB}/AllData.gdb`);
  const gfiBytes = files.get(`${LIB}/FolderData.gfi`);
  return {
    gdb: gdbBytes ? readContainer(gdbBytes, { role: 'gdb' }) : null,
    gfi: gfiBytes ? readContainer(gfiBytes, { role: 'gfi' }) : null,
    trackSegments: [...files]
      .filter(([p]) => p.includes('/TrackSegments/'))
      .map(([p, bytes]) => ({ name: p.split('/').pop() ?? '', bytes, bodyStart: readHeader(bytes, { role: 'tracksegments' }).bodyStart })),
  };
}

/**
 * @param {Map<string, Uint8Array>} files
 * @param {string} [prefix]
 */
function asInputs(files, prefix = 'Users/x/Library/Application Support/Garmin/BaseCamp') {
  return [...files].map(([p, bytes]) => fromBlob(`${prefix}/${p}`, new Blob([bytes]), false));
}

/** @param {any} value */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** A tiny well-formedness check: balanced tags, one root, no stray markup characters in text. */
function checkXml(/** @type {string} */ xml) {
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n'), 'XML declaration first');
  const body = xml.slice(xml.indexOf('?>') + 2);
  /** @type {string[]} */
  const stack = [];
  let roots = 0;
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>/g;
  let last = 0;
  for (const m of body.matchAll(re)) {
    const text = body.slice(last, m.index);
    assert.ok(!/[<>]/.test(text), `stray markup in text near "${text.slice(0, 40)}"`);
    assert.ok(!/&(?!(amp|lt|gt|quot|apos);)/.test(text), 'unescaped ampersand');
    last = (m.index ?? 0) + m[0].length;
    const [, close, name, , selfClose] = m;
    if (close) assert.equal(stack.pop(), name, `closing ${name}`);
    else if (!selfClose) {
      if (stack.length === 0) roots++;
      stack.push(name);
    } else if (stack.length === 0) roots++;
  }
  assert.equal(stack.length, 0, 'every element closed');
  assert.equal(roots, 1, 'one root element');
  assert.equal(body.slice(last).trim(), '', 'nothing after the root');
}

/**
 * @param {string} xml
 * @param {string} tag
 */
function countTag(xml, tag) {
  return (xml.match(new RegExp(`<${tag}[\\s>/]`, 'g')) ?? []).length;
}

// ---------------------------------------------------------------------------------------------

describe('made-up GPX files and expected.json', () => {
  test('the committed files are exactly what make-gpx.js generates (rerun it after changing SPEC)', () => {
    const { files, expectedJson } = generate();
    assert.deepEqual(Object.keys(files).sort(), ['gate1-deep.gpx', 'gate1-desert.gpx', 'gate1-ocean.gpx']);
    for (const [name, text] of Object.entries(files)) assert.equal(read(`gpx/${name}`), text, `gpx/${name} is stale`);
    assert.equal(read('expected.json'), expectedJson, 'expected.json is stale');
  });

  test('generation is deterministic', () => {
    assert.deepEqual(generate(), generate());
  });

  test('every GPX file is well-formed and declares the namespaces it uses', () => {
    for (const list of EXPECTED.tree.lists) {
      const xml = read(`gpx/${list.file}`);
      checkXml(xml);
      assert.match(xml, /<gpx version="1\.1" [^>]*xmlns="http:\/\/www\.topografix\.com\/GPX\/1\/1"/);
      for (const [prefix, ns] of [
        ['gpxx', 'http://www.garmin.com/xmlschemas/GpxExtensions/v3'],
        ['gpxtpx', 'http://www.garmin.com/xmlschemas/TrackPointExtension/v1'],
      ]) {
        if (xml.includes(`<${prefix}:`)) assert.ok(xml.includes(`xmlns:${prefix}="${ns}"`), `${list.file} declares ${prefix}`);
      }
    }
  });

  test('every element sits where the GPX 1.1 and Garmin extension schemas put it (order, namespaces, ranges)', () => {
    // Child sequences copied from the schemas as published (read 2026-10-06): topografix.com/GPX/1/1/gpx.xsd,
    // www8.garmin.com/xmlschemas/GpxExtensionsv3.xsd and TrackPointExtensionv1.xsd. Full XSD validation (xmllint
    // --schema) is not run because it needs the schema files downloaded; this checks the parts these files use.
    const wpt = ['ele', 'time', 'magvar', 'geoidheight', 'name', 'cmt', 'desc', 'src', 'link*', 'sym', 'type', 'fix', 'sat', 'hdop', 'vdop', 'pdop', 'ageofdgpsdata', 'dgpsid', 'extensions'];
    /** @type {Record<string, string[]>} */
    const SEQ = {
      gpx: ['metadata', 'wpt*', 'rte*', 'trk*', 'extensions'],
      metadata: ['name', 'desc', 'author', 'copyright', 'link*', 'time', 'keywords', 'bounds', 'extensions'],
      wpt,
      rtept: wpt,
      trkpt: wpt,
      rte: ['name', 'cmt', 'desc', 'src', 'link*', 'number', 'type', 'extensions', 'rtept*'],
      trk: ['name', 'cmt', 'desc', 'src', 'link*', 'number', 'type', 'extensions', 'trkseg*'],
      trkseg: ['trkpt*', 'extensions'],
      'gpxx:WaypointExtension': ['gpxx:Proximity', 'gpxx:Temperature', 'gpxx:Depth', 'gpxx:DisplayMode', 'gpxx:Categories', 'gpxx:Address', 'gpxx:PhoneNumber*', 'gpxx:Extensions'],
      'gpxx:Address': ['gpxx:StreetAddress*', 'gpxx:City', 'gpxx:State', 'gpxx:Country', 'gpxx:PostalCode', 'gpxx:Extensions'],
      'gpxtpx:TrackPointExtension': ['gpxtpx:atemp', 'gpxtpx:wtemp', 'gpxtpx:depth', 'gpxtpx:hr', 'gpxtpx:cad', 'gpxtpx:Extensions'],
    };
    const NS = {
      '': 'http://www.topografix.com/GPX/1/1',
      gpxx: 'http://www.garmin.com/xmlschemas/GpxExtensions/v3',
      gpxtpx: 'http://www.garmin.com/xmlschemas/TrackPointExtension/v1',
    };
    const XSD = {
      'http://www.topografix.com/GPX/1/1': 'http://www.topografix.com/GPX/1/1/gpx.xsd',
      'http://www.garmin.com/xmlschemas/GpxExtensions/v3': 'http://www8.garmin.com/xmlschemas/GpxExtensionsv3.xsd',
      'http://www.garmin.com/xmlschemas/TrackPointExtension/v1': 'http://www8.garmin.com/xmlschemas/TrackPointExtensionv1.xsd',
    };
    for (const list of EXPECTED.tree.lists) {
      const xml = read(`gpx/${list.file}`);
      /** @type {Array<{name: string, attrs: Record<string, string>, children: any[], text: string}>} */
      const stack = [{ name: '#doc', attrs: {}, children: [], text: '' }];
      const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/g;
      const body = xml.slice(xml.indexOf('?>') + 2);
      for (const m of body.matchAll(re)) {
        if (m[5] !== undefined) {
          stack[stack.length - 1].text += m[5];
          continue;
        }
        const [, close, name, attrText, self] = m;
        if (close) {
          stack.pop();
          continue;
        }
        /** @type {Record<string, string>} */
        const attrs = {};
        for (const a of (attrText ?? '').matchAll(/([\w:.-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
        const node = { name, attrs, children: [], text: '' };
        stack[stack.length - 1].children.push(node);
        if (!self) stack.push(node);
      }
      const root = stack[0].children[0];
      assert.equal(root.name, 'gpx');
      assert.equal(root.attrs.version, '1.1');
      assert.ok(root.attrs.creator, 'creator is required');
      // Namespaces: the default one is GPX 1.1; every prefix used is declared with Garmin's exact URI, and the
      // schemaLocation pairs each namespace with its own schema.
      assert.equal(root.attrs.xmlns, NS['']);
      const locations = (root.attrs['xsi:schemaLocation'] ?? '').trim().split(/\s+/);
      assert.equal(locations.length % 2, 0);
      /** @type {Map<string, string>} */
      const where = new Map();
      for (let i = 0; i < locations.length; i += 2) where.set(locations[i], locations[i + 1]);
      for (const [ns, xsd] of where) assert.equal(XSD[/** @type {keyof typeof XSD} */ (ns)], xsd, `${list.file}: schema for ${ns}`);
      for (const [prefix, uri] of Object.entries(NS)) {
        if (prefix === '') continue;
        const declared = root.attrs[`xmlns:${prefix}`];
        if (xml.includes(`<${prefix}:`)) {
          assert.equal(declared, uri, `${list.file}: ${prefix} namespace`);
          assert.ok(where.has(uri), `${list.file}: schemaLocation names ${prefix}`);
        }
        if (declared !== undefined) assert.equal(declared, uri, `${list.file}: ${prefix} is declared with the right URI`);
      }
      /** @param {any} node */
      const visit = (node) => {
        const seq = SEQ[node.name];
        if (seq) {
          let at = 0;
          for (const child of node.children) {
            let found = -1;
            for (let k = at; k < seq.length; k++) {
              if (seq[k].replace(/\*$/, '') === child.name) {
                found = k;
                break;
              }
            }
            assert.ok(found >= 0, `${list.file}: <${child.name}> is not allowed here in <${node.name}> (or is out of order)`);
            at = seq[found].endsWith('*') ? found : found + 1;
          }
        }
        if (['wpt', 'rtept', 'trkpt'].includes(node.name)) {
          const lat = Number(node.attrs.lat);
          const lon = Number(node.attrs.lon);
          assert.ok(lat >= -90 && lat <= 90 && lon >= -180 && lon < 180, `${list.file}: position in range`);
        }
        if (node.name === 'gpxtpx:hr') assert.ok(/^\d+$/.test(node.text) && Number(node.text) >= 1 && Number(node.text) <= 255, 'heart rate is 1-255');
        if (node.name === 'gpxtpx:atemp' || node.name === 'ele') assert.ok(Number.isFinite(Number(node.text)), `${node.name} is a number`);
        if (node.name === 'time') assert.match(node.text, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
        for (const c of node.children) visit(c);
      };
      visit(root);
    }
  });

  test('each file holds exactly the items expected.json says, with the same names, positions, elevations and times', () => {
    for (const list of EXPECTED.tree.lists) {
      const xml = read(`gpx/${list.file}`);
      const wpts = EXPECTED.waypoints.filter((/** @type {any} */ w) => w.file === list.file);
      const trks = EXPECTED.tracks.filter((/** @type {any} */ t) => t.file === list.file);
      const rtes = EXPECTED.routes.filter((/** @type {any} */ r) => r.file === list.file);
      assert.equal(countTag(xml, 'wpt'), wpts.length, `${list.file} wpt`);
      assert.equal(countTag(xml, 'trk'), trks.length, `${list.file} trk`);
      assert.equal(countTag(xml, 'trkseg'), trks.reduce((s, /** @type {any} */ t) => s + t.segments.length, 0));
      assert.equal(countTag(xml, 'trkpt'), trks.reduce((s, /** @type {any} */ t) => s + t.pointCount, 0));
      assert.equal(countTag(xml, 'rte'), rtes.length);
      assert.equal(countTag(xml, 'rtept'), rtes.reduce((s, /** @type {any} */ r) => s + r.via.length, 0));

      const wptTags = [...xml.matchAll(/<wpt lat="([^"]+)" lon="([^"]+)">([\s\S]*?)<\/wpt>/g)];
      wptTags.forEach((m, i) => {
        const w = wpts[i];
        assert.equal(Number(m[1]), w.lat);
        assert.equal(Number(m[2]), w.lon);
        assert.ok(m[3].includes(`<name>${w.name}</name>`));
        if (w.ele === null) assert.ok(!m[3].includes('<ele>'));
        else assert.equal(Number(/<ele>([^<]+)<\/ele>/.exec(m[3])?.[1]), w.ele);
        if (w.time === null) assert.ok(!m[3].includes('<time>'));
        else assert.ok(m[3].includes(`<time>${w.time}</time>`));
        if (w.address) {
          for (const v of Object.values(w.address)) assert.ok(m[3].includes(`>${v}</gpxx:`), `address value in ${w.label}`);
          assert.ok(m[3].includes(`<gpxx:PhoneNumber>${w.phone}</gpxx:PhoneNumber>`));
        }
      });
      const trkpts = [...xml.matchAll(/<trkpt lat="([^"]+)" lon="([^"]+)"(?:\/>|>([\s\S]*?)<\/trkpt>)/g)];
      const points = trks.flatMap((/** @type {any} */ t) => t.segments.flat());
      assert.equal(trkpts.length, points.length);
      trkpts.forEach((m, i) => {
        const p = points[i];
        assert.equal(Number(m[1]), p.lat);
        assert.equal(Number(m[2]), p.lon);
        const inner = m[3] ?? '';
        assert.equal(inner.includes('<ele>') ? Number(/<ele>([^<]+)<\/ele>/.exec(inner)?.[1]) : null, p.ele);
        assert.equal(/<time>([^<]+)<\/time>/.exec(inner)?.[1] ?? null, p.time);
        if (p.hr !== undefined) assert.ok(inner.includes(`<gpxtpx:hr>${p.hr}</gpxtpx:hr>`) && inner.includes(`<gpxtpx:atemp>${p.atemp}</gpxtpx:atemp>`));
      });
      // gpxtpx elements follow the schema order (atemp before hr).
      for (const m of xml.matchAll(/<gpxtpx:TrackPointExtension>([\s\S]*?)<\/gpxtpx:TrackPointExtension>/g)) {
        assert.ok(m[1].indexOf('<gpxtpx:atemp>') < m[1].indexOf('<gpxtpx:hr>'));
      }
    }
  });

  test('the made-up content keeps to its rules', () => {
    const items = [...EXPECTED.waypoints, ...EXPECTED.tracks, ...EXPECTED.routes];
    const names = [...items.map((x) => x.name), ...EXPECTED.routes.flatMap((/** @type {any} */ r) => r.via.map((/** @type {any} */ v) => v.name))];
    const lists = new Set(EXPECTED.tree.lists.map((/** @type {any} */ l) => l.name));
    const folders = new Set(EXPECTED.tree.folders.map((/** @type {any} */ f) => f.name));
    for (const n of [...names, ...lists, ...folders]) assert.match(n, /^Gate1 [A-Za-z0-9 ]+$/, `made-up name ${n}`);
    // Names are unique except the one deliberate pair of tracks.
    /** @type {Map<string, number>} */
    const uses = new Map();
    for (const n of names) uses.set(n, (uses.get(n) ?? 0) + 1);
    assert.deepEqual([...uses].filter(([, c]) => c > 1), [['Gate1 Twin Track', 2]]);
    const twins = EXPECTED.tracks.filter((/** @type {any} */ t) => t.name === 'Gate1 Twin Track');
    assert.notEqual(twins[0].file, twins[1].file, 'the twins are in different files');
    // Labels are unique, so the report can name each item.
    const labels = [...items, ...EXPECTED.routes.flatMap((/** @type {any} */ r) => r.via)].map((x) => x.label);
    assert.equal(new Set(labels).size, labels.length);
    // Every item is in a list that exists, and lists are in folders that exist.
    for (const x of items) for (const l of x.lists) assert.ok(lists.has(l));
    for (const l of EXPECTED.tree.lists) assert.ok(folders.has(l.folder));
    for (const f of EXPECTED.tree.folders) assert.ok(f.parent === null || folders.has(f.parent));
    assert.equal(EXPECTED.counts.itemsInTwoLists, 2);
    // Positions are in three made-up areas far from any trail: South Pacific, Rub' al Khali, South Indian Ocean.
    const areas = [
      { lat: [-49, -48.8], lon: [-123.5, -123.3] },
      { lat: [20.09, 20.3], lon: [50.39, 50.6] },
      { lat: [-35.3, -35.2], lon: [85.7, 85.8] },
    ];
    const allPoints = [
      ...EXPECTED.waypoints,
      ...EXPECTED.routes.flatMap((/** @type {any} */ r) => r.via),
      ...EXPECTED.tracks.flatMap((/** @type {any} */ t) => t.segments.flat()),
    ];
    for (const p of allPoints) {
      assert.ok(areas.some((a) => p.lat >= a.lat[0] && p.lat <= a.lat[1] && p.lon >= a.lon[0] && p.lon <= a.lon[1]), `point in a made-up area`);
      assert.equal(Math.round(p.lat * 1e7) / 1e7, p.lat, '7 decimals at most');
      assert.equal(Math.round(p.lon * 1e7) / 1e7, p.lon, '7 decimals at most');
      if (p.ele !== null && p.ele !== undefined) assert.equal(p.ele * 4, Math.round(p.ele * 4), 'elevations are exact in binary');
      if (p.time) {
        const ms = Date.parse(p.time);
        assert.ok(ms > Date.parse('2000-01-01T00:00:00Z') && ms < Date.parse('2010-01-01T00:00:00Z'), 'made-up time in 2000-2009');
      }
    }
    // Times are whole seconds, so a stored i32 Unix time can match them exactly.
    for (const p of allPoints) if (p.time) assert.equal(Date.parse(p.time) % 1000, 0);
    // Features the founder's check needs: an imported address, a hand-typed one, a timed and an untimed track,
    // a sensor track, a two-segment track and a four-point route.
    assert.ok(EXPECTED.waypoints.some((/** @type {any} */ w) => w.address && w.phone));
    assert.ok(EXPECTED.waypoints.some((/** @type {any} */ w) => w.typedByHand && w.address === null));
    assert.ok(EXPECTED.tracks.some((/** @type {any} */ t) => t.segments.flat().every((/** @type {any} */ p) => p.time === null)));
    assert.ok(EXPECTED.tracks.some((/** @type {any} */ t) => t.segments.flat().every((/** @type {any} */ p) => p.time !== null && p.ele !== null)));
    assert.ok(EXPECTED.tracks.some((/** @type {any} */ t) => t.segments.flat().some((/** @type {any} */ p) => p.hr !== undefined)));
    assert.ok(EXPECTED.tracks.some((/** @type {any} */ t) => t.segments.length === 2));
    assert.equal(EXPECTED.routes[0].via.length, 4);
    assert.equal(SPEC.lists.length, EXPECTED.tree.lists.length);
  });

  test('gate1-desert.gpx comes from BCR\'s own GPX writer (so Gate 1 also checks that BaseCamp imports it)', () => {
    const xml = read('gpx/gate1-desert.gpx');
    assert.ok(!xml.includes('gpxx:') && !xml.includes('gpxtpx:'));
    assert.equal(EXPECTED.files.find((/** @type {any} */ f) => f.file === 'gate1-desert.gpx').writtenBy, 'src/export/gpx.js');
  });
});

// ---------------------------------------------------------------------------------------------

describe('STEPS.md', () => {
  const steps = read('STEPS.md');

  test('names every folder, list, file and hand-typed value exactly as expected.json does', () => {
    for (const f of EXPECTED.tree.folders) assert.ok(steps.includes(`**${f.name}**`), f.name);
    for (const l of EXPECTED.tree.lists) {
      assert.ok(steps.includes(`**${l.name}**`), l.name);
      assert.ok(steps.includes(`File > Import into '${l.name}'`), `import into ${l.name}`);
      assert.ok(steps.includes(`**${l.file}**`), l.file);
    }
    const typed = EXPECTED.waypoints.find((/** @type {any} */ w) => w.typedByHand);
    assert.ok(steps.includes(`**${typed.name}**`));
    for (const v of Object.values(typed.typedByHand)) assert.ok(steps.includes(`| ${v} |`), `typed value ${v}`);
    for (const x of [...EXPECTED.waypoints, ...EXPECTED.tracks]) {
      if (x.lists.length > 1) assert.ok(steps.includes(`**${x.name}**`), `drag step for ${x.name}`);
    }
  });

  test('uses the menu names from the BaseCamp Mac manual and the official download page', () => {
    for (const s of [
      'File > New List Folder',
      'File > New List',
      'File > Backup',
      'File > Export Selected User Data',
      'Contact Info',
      'References',
      'https://www8.garmin.com/support/download_details.jsp?id=4450',
      '~/Library/Application Support/Garmin/BaseCamp/Database',
      'Command-Shift-G',
      'check.html',
      'Quit BaseCamp',
    ]) {
      assert.ok(steps.includes(s), s);
    }
  });

  test('says which decisions are the founder\'s, and how to undo everything', () => {
    assert.match(steps, /Installing BaseCamp/);
    assert.match(steps, /licence agreement/);
    assert.match(steps, /## Undo/);
    assert.match(steps, /Applications\*\* and drag \*\*BaseCamp\*\* to the Trash/);
    assert.match(steps, /That is a guess/);
  });

  // The sections a first-time reader acts on: the decisions block (before the first rule) and the undo section.
  const decisions = steps.slice(0, steps.indexOf('\n---'));
  const undo = steps.slice(steps.indexOf('## Undo'));

  test('Rosetta is not claimed to be installed: it is the founder\'s decision, and the undo section says what stays', () => {
    // Checked on this Mac on 2026-10-06: an Intel program would not run ("Bad CPU type in executable"), and no
    // Rosetta package receipt exists. DECISIONS B4 says the same. A step list that says otherwise is wrong.
    assert.ok(!/Rosetta[^.]*already (on|installed)/i.test(steps), 'STEPS.md must not say Rosetta is already on this Mac');
    assert.match(decisions, /Rosetta/, 'installing Rosetta is listed among the founder\'s decisions');
    assert.match(undo, /Rosetta/, 'the undo section says what happens to Rosetta');
  });

  test('checks for existing BaseCamp data before installing, so the undo cannot delete anything real', () => {
    const install = steps.indexOf('## Step 1.');
    const precheck = steps.indexOf('~/Library/Application Support/Garmin');
    assert.ok(precheck > 0 && precheck < install, 'the Garmin folder is checked before BaseCamp is installed');
    assert.match(undo, /Application Support\/Garmin/);
  });

  test('names the exact download and covers both installer shapes and the undo of each', () => {
    assert.ok(steps.includes('BaseCampforMac_4813.dmg'), 'the file name from the download page');
    assert.match(steps, /Intel/);
    assert.match(undo, /BaseCampforMac_4813\.dmg/, 'the downloaded file is removed too');
  });

  test('every page text it tells the founder to look for is really on the page', () => {
    const page = read('check.template.html') + read('check.js');
    // Bold words that name something on check.html.
    for (const s of ['Self-test passed', 'Copy report', 'Choose a folder…']) {
      assert.ok(steps.includes(s), `STEPS.md mentions ${s}`);
      assert.ok(page.includes(s), `check page shows ${s}`);
    }
    assert.ok(steps.includes('"Done'), 'STEPS says to wait for Done');
    assert.ok(/setStatus\('Done\./.test(read('check.js')), 'the page says Done when the report is ready');
    assert.ok(steps.includes('FAILED') && read('check.js').includes('Self-test FAILED'));
  });

  test('covers the dialogs and Finder habits a first-time Mac user will meet', () => {
    assert.match(steps, /Keep Both|keep both/i, 'what to do when BaseCamp finds the twin track name twice');
    assert.match(steps, /Gate1\.Backup[^\n]*may show as[^\n]*Gate1/i, 'Finder may hide the .Backup extension');
    assert.ok(steps.includes("File > Export 'My Collection'"), 'a KML fallback that the manual documents');
    assert.match(steps, /only one list[^\n]*tell me/i, 'what to do when an item lands in one list');
  });
});

// ---------------------------------------------------------------------------------------------

describe('compareLibrary', () => {
  test('a synthetic library made from expected.json matches everything', () => {
    const { lines, json } = compareLibrary(parsedLibrary(buildSyntheticLibrary(EXPECTED)), EXPECTED);
    const text = lines.join('\n');
    assert.match(text, /Waypoints found by name: 6 of 6; positions matched: 6 of 6; comments matched: 3 of 3/);
    assert.match(text, /Tracks found by name: 7 of 7; track points found in order: 56 of 56/);
    assert.match(text, /Routes found by name: 1 of 1/);
    assert.match(text, /TrackSegments files matched to our tracks: 7 of 7; elevations matched: 50 of 50; times matched: 42 of 42/);
    assert.match(text, /Items placed in the right lists: 16 of 16; items in two lists: 2 of 2/);
    assert.match(text, /Track references carrying the shared track name: 2 \(expected 2\)/);
    assert.match(text, /Records that are not ours: W 0, T 0, R 0/);
    const j = /** @type {any} */ (json);
    for (const t of j.gdb.tracks) {
      assert.equal(t.pointsFoundInOrder, t.pointsExpected, t.label);
      assert.equal(t.segments.bytesPerPoint !== null, true);
    }
    // FORMAT.md §6.2: a segment header is 21 bytes, so that is the gap between two segments' points.
    assert.deepEqual(j.gdb.tracks.find((/** @type {any} */ t) => t.label === 'Track Two Segments').gapsBetweenSegments, [21]);
    // H-KBM as the synthetic library writes it: the street directly after the prefix, the altitude flag 7 bytes on.
    const bravo = j.gdb.waypoints.find((/** @type {any} */ w) => w.label === 'Waypoint Bravo');
    assert.equal(bravo.markers.street.afterPrefix, 0);
    const alpha = j.gdb.waypoints.find((/** @type {any} */ w) => w.label === 'Waypoint Alpha');
    assert.deepEqual(alpha.markers.elevation, { at: alpha.prefixEnd + 8, afterPrefix: 8, encoding: 'f64', flagBefore: true });
    assert.equal(alpha.positionAsDegreesAt, undefined, 'only looked for when the semicircles do not match');
    // TrackSegments: 1 + 8 elevation, 1 + 4 time, 15 zero bytes (FORMAT.md §9, N = 17).
    const timed = j.gdb.tracks.find((/** @type {any} */ t) => t.label === 'Track Timed');
    assert.equal(timed.segments.bytesPerPoint, 29);
    assert.equal(timed.segments.elevationAt, 1);
    assert.equal(timed.segments.timeAt, 10);
    assert.equal(j.gfi.placements.found, j.gfi.placements.expected);
  });

  test('without the hand-typed Contact Info, the typed address is reported as not found', () => {
    const { json } = compareLibrary(parsedLibrary(buildSyntheticLibrary(EXPECTED, { handTyped: false })), EXPECTED);
    const delta = /** @type {any} */ (json).gdb.waypoints.find((/** @type {any} */ w) => w.label === 'Waypoint Delta');
    assert.equal(delta.markers.street, null);
    assert.equal(delta.markers.phone, null);
  });

  test('a renamed twin is counted by its name prefix, not matched by guesswork', () => {
    const renamed = clone(EXPECTED);
    renamed.tracks.find((/** @type {any} */ t) => t.label === 'Twin Track B').name = 'Gate1 Twin Track 2';
    const { lines, json } = compareLibrary(parsedLibrary(buildSyntheticLibrary(renamed)), EXPECTED);
    const j = /** @type {any} */ (json);
    const a = j.gdb.tracks.find((/** @type {any} */ t) => t.label === 'Twin Track A');
    const b = j.gdb.tracks.find((/** @type {any} */ t) => t.label === 'Twin Track B');
    assert.equal(a.records, 1);
    assert.equal(a.recordsStartingWithName, 2);
    assert.equal(a.pointsFoundInOrder, 5);
    assert.equal(b.pointsFoundInOrder, undefined, 'B is not found under the shared name');
    assert.match(lines.join('\n'), /Twin Track B: not found \(records with this name 1; records starting with this name 2\)/);
    assert.match(lines.join('\n'), /Records that are not ours: W 0, T 1, R 0/);
  });

  test('the twin with the shared name is told apart by its own points', () => {
    const { json } = compareLibrary(parsedLibrary(buildSyntheticLibrary(EXPECTED)), EXPECTED);
    const tracks = /** @type {any} */ (json).gdb.tracks;
    for (const label of ['Twin Track A', 'Twin Track B']) {
      const t = tracks.find((/** @type {any} */ x) => x.label === label);
      assert.equal(t.pointsFoundInOrder, t.pointsExpected, label);
    }
  });

  test('a moved waypoint is reported as a position mismatch', () => {
    const moved = clone(EXPECTED);
    moved.waypoints[0].lat += 0.001;
    const { json } = compareLibrary(parsedLibrary(buildSyntheticLibrary(moved)), EXPECTED);
    const w = /** @type {any} */ (json).gdb.waypoints[0];
    assert.equal(w.records, 1);
    assert.equal(w.positionMatches, false);
  });

  test('values stored in another encoding are still located, and the encoding is named', () => {
    // A made-up "drifted" layout: elevation as f32, time from Garmin's 1989 epoch, position as two f64 degrees.
    const { Bytes } = synthInternals;
    const alpha = EXPECTED.waypoints[0];
    const unix = Date.parse(alpha.time) / 1000;
    const body = new Bytes().cstr(alpha.name).u32(0).f64(alpha.lat).f64(alpha.lon).cstr(alpha.comment).u8(0).u32(1).u32(0);
    body.u8(1);
    const eleAt = body.bytes().length;
    const f = new Uint8Array(4);
    new DataView(f.buffer).setFloat32(0, alpha.ele, true);
    body.raw(f).u8(1).i32(unix - 631065600);
    const { json, lines } = compareLibrary({ gdb: { records: [{ type: 'W', body: body.bytes() }] }, gfi: null, trackSegments: [] }, EXPECTED);
    const w = /** @type {any} */ (json).gdb.waypoints[0];
    assert.equal(w.positionMatches, false);
    assert.equal(w.positionAsDegreesAt, alpha.name.length + 1 + 4);
    assert.equal(w.markers.elevation.encoding, 'f32');
    assert.equal(w.markers.elevation.at, eleAt);
    assert.equal(w.markers.time.encoding, 'garmin-1989');
    assert.match(lines.join('\n'), /Waypoint Alpha: [^\n]*position no; position as f64 degrees at 25;[^\n]*elevation as f32 at [^\n]*time as garmin-1989 at /);

    // TrackSegments with Garmin-epoch times: found, named, and every point checked in that encoding.
    const timed = EXPECTED.tracks.find((/** @type {any} */ t) => t.label === 'Track Timed');
    const pts = timed.segments.flat();
    const ts = new Bytes().raw(synthInternals.header('MsRc', 408)).u32(pts.length);
    for (const p of pts) ts.fdouble(p.ele).fint(Date.parse(p.time) / 1000 - 631065600).raw(new Uint8Array(15));
    const probe = compareInternals.probeSegments(ts.bytes(), pts, undefined);
    assert.equal(probe.timeEncoding, 'garmin-1989');
    assert.equal(probe.timesMatched, pts.length);
    assert.equal(probe.elevationEncoding, 'f64');
    assert.equal(probe.elevationsMatched, pts.length);
  });

  test('positions within the tolerance match, beyond it they do not', () => {
    const { findPosition, semicircles } = compareInternals;
    const lat = 20.1234567;
    const lon = 50.4567891;
    for (const [d, found] of [
      [0, true],
      [POSITION_TOLERANCE, true],
      [-POSITION_TOLERANCE, true],
      [POSITION_TOLERANCE + 1, false],
    ]) {
      const b = new synthInternals.Bytes().u8(7).i32(semicircles(lat) + /** @type {number} */ (d)).i32(semicircles(lon)).bytes();
      assert.equal(findPosition(b, lat, lon) === 1, found, `offset ${d}`);
    }
    assert.equal(toSemicircles(lat), semicircles(lat));
  });

  test('missing files are said plainly', () => {
    const lib = parsedLibrary(buildSyntheticLibrary(EXPECTED, { withGfi: false }));
    const { lines } = compareLibrary({ ...lib, gfi: null }, EXPECTED);
    assert.ok(lines.includes('FolderData.gfi: not found, so the folder and list tree was not compared.'));
    const none = compareLibrary({ gdb: null, gfi: null, trackSegments: [] }, EXPECTED);
    assert.ok(none.lines.includes('AllData.gdb: not found, so items were not compared.'));
  });

  test('a TrackSegments file that is missing or has a bad header is reported, not guessed', () => {
    const files = buildSyntheticLibrary(EXPECTED);
    const lib = parsedLibrary(files);
    const broken = lib.trackSegments.map((s, i) => (i === 0 ? { name: s.name, bytes: s.bytes.slice(0, 10) } : s)).slice(0, 6);
    const { json } = compareLibrary({ ...lib, trackSegments: broken }, EXPECTED);
    const tracks = /** @type {any} */ (json).gdb.tracks;
    assert.equal(tracks.filter((/** @type {any} */ t) => t.segmentsFileFound).length, 6);
    const bad = tracks.find((/** @type {any} */ t) => t.segments && !t.segments.headerRead);
    assert.ok(bad, 'the truncated file is flagged');
    assert.equal(bad.segments.pointCount, null);
  });

  test('never throws on hostile or malformed input', () => {
    const odd = [
      null,
      undefined,
      {},
      { gdb: { records: 'x' }, gfi: { records: [null, 1, { type: 'W' }, { type: 87, body: new Uint8Array(0) }] }, trackSegments: [null, { name: 5 }] },
      { gdb: { records: [{ type: 'W', body: new Uint8Array([0xff, 0xff]) }, { type: 'T', body: new Uint8Array(3) }, { type: 'R', body: new Uint8Array(1) }] }, gfi: null, trackSegments: null },
      {
        gdb: null,
        gfi: { records: [{ type: 'F', body: Uint8Array.of(255, 255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 255) }, { type: 'I', body: Uint8Array.of(1, 0, 0, 0, 65) }] },
        trackSegments: [],
      },
    ];
    for (const lib of odd) {
      const out = compareLibrary(/** @type {any} */ (lib), EXPECTED);
      assert.ok(Array.isArray(out.lines) && out.lines.length > 0);
    }
    for (const exp of [null, {}, { waypoints: 1 }]) {
      const out = compareLibrary(parsedLibrary(buildSyntheticLibrary(EXPECTED)), exp);
      assert.match(out.lines.join('\n'), /not usable/);
    }
  });

  test('a folder record whose child count is too large is not trusted', () => {
    const b = new synthInternals.Bytes().u32(0).cstr('Gate1 Trips').u32(0xffffffff).u32(0x7fffffff).bytes();
    const out = compareLibrary({ gdb: null, gfi: { records: [{ type: 'F', body: b }] }, trackSegments: [] }, EXPECTED);
    assert.match(out.lines.join('\n'), /Folder Trips: records 1; parent field right yes; listed in parent's children no; bytes after children -/);
  });
});

// ---------------------------------------------------------------------------------------------

describe('privacy: the report never repeats what the library holds', () => {
  // Foreign content a real library might hold. None of it may appear in the report, in any encoding.
  const SENTINEL_NAME = 'Zq9SentinelPlace';
  const SENTINEL_LAT = 47.6543219;
  const SENTINEL_LON = -122.3456781;
  const SENTINEL_TIME = Date.parse('2019-08-07T06:05:04Z') / 1000;
  const SENTINEL_UUID = 'ABCDEF12-3456-4789-ABCD-EF0123456789';
  const SENTINEL_LIST = 'Zq9SentinelList';

  function sentinelLibrary() {
    const { Bytes } = synthInternals;
    const w = new Bytes().cstr(SENTINEL_NAME).u32(0).position(SENTINEL_LAT, SENTINEL_LON).cstr(`${SENTINEL_NAME} comment`).u8(0).u32(1).u32(0);
    for (let i = 0; i < 5; i++) w.cstr(`${SENTINEL_NAME} street ${i}`);
    w.u8(0).u8(0).u8(1).f64(1234.5).u8(0).u32(0).u8(0).u8(1).i32(SENTINEL_TIME).raw([0, 0, 0, 0, 0, 0]).u32(1).cstr('555-9999').u8(0).u8(0).raw([0, 0, 0]).u32(0);
    const t = new Bytes().cstr(SENTINEL_NAME).u8(1).raw([0, 0, 0, 0]).u32(0).u32(0).cstr('').f64(0).u8(0).u8(0);
    t.position(SENTINEL_LAT, SENTINEL_LON).position(SENTINEL_LAT, SENTINEL_LON).u8(0).f64(0).u8(1).i32(SENTINEL_TIME).u32(0).u32(1);
    t.u8(0).position(SENTINEL_LAT, SENTINEL_LON).position(SENTINEL_LAT, SENTINEL_LON).u32(1).position(SENTINEL_LAT, SENTINEL_LON).u32(1).cstr(SENTINEL_UUID);
    const r = new Bytes().cstr(SENTINEL_NAME).u8(0).u32(0).raw([0, 0, 0]).u8(1);
    const files = buildSyntheticLibrary(EXPECTED, {
      extraGdbRecords: [
        { type: 'W', body: w.bytes() },
        { type: 'T', body: t.bytes() },
        { type: 'R', body: r.bytes() },
      ],
      extraGfiRecords: [
        { type: 'I', body: new Bytes().u32(77).cstr(SENTINEL_LIST).u32(0).u32(0).bytes() },
        { type: 'W', body: new Bytes().u32(77).cstr(SENTINEL_NAME).u32(0).bytes() },
        { type: 'T', body: new Bytes().u32(77).cstr(SENTINEL_NAME).u32(0).bytes() },
      ],
    });
    const ts = new Bytes().raw(synthInternals.header('MsRc', 408)).u32(1).u8(1).f64(1234.5).u8(1).i32(SENTINEL_TIME);
    for (let i = 0; i < 15; i++) ts.u8(0);
    files.set(`${LIB}/TrackSegments/${SENTINEL_UUID}`, ts.bytes());
    return files;
  }

  /** Every way the sentinels could leak. */
  function forbidden() {
    const out = [
      SENTINEL_NAME,
      SENTINEL_LIST,
      SENTINEL_UUID,
      SENTINEL_UUID.toLowerCase(),
      '555-9999',
      String(SENTINEL_LAT),
      String(SENTINEL_LON),
      SENTINEL_LAT.toFixed(4),
      SENTINEL_LON.toFixed(4),
      String(toSemicircles(SENTINEL_LAT)),
      String(toSemicircles(SENTINEL_LON)),
      String(SENTINEL_TIME),
      new Date(SENTINEL_TIME * 1000).toISOString().slice(0, 19),
      '2019-08-07',
      '1234.5',
      Buffer.from(SENTINEL_NAME).toString('hex'),
      Buffer.from(SENTINEL_NAME).toString('base64').slice(0, 12),
      'Users/x',
      'Application Support',
    ];
    // The made-up names themselves are never echoed either: the report uses the kit's labels.
    for (const w of EXPECTED.waypoints) out.push(w.name, w.lat.toFixed(5), String(w.lat));
    for (const l of EXPECTED.tree.lists) out.push(l.name);
    for (const t of EXPECTED.tracks) out.push(t.name);
    return out;
  }

  test('neither the text nor the JSON contains any name, coordinate, time, uuid or path', async () => {
    const report = await runCheck(asInputs(sentinelLibrary()), { expected: EXPECTED, features: { a: true } });
    const all = report.text + '\n' + JSON.stringify(report.json);
    for (const s of forbidden()) assert.ok(!all.includes(s), `report leaks ${JSON.stringify(s)}`);
    // The foreign records are counted, not named.
    assert.match(report.text, /Records that are not ours: W 1, T 1, R 1/);
    assert.match(report.text, /Waypoints found by name: 6 of 6/);
  });

  test('raw numbers read at guessed offsets are printed only when small, so a time or a coordinate never shows', async () => {
    // FORMAT.md's offsets are guesses until Gate 1. If the Mac layout differs, the class, icon, point-count and
    // "created by" slots hold whatever sits there: here a time and a coordinate, in our own records and in a list
    // that is not ours.
    const { Bytes } = synthInternals;
    const files = buildSyntheticLibrary(EXPECTED, {
      extraGdbRecords: [{ type: 'W', body: new Bytes().cstr('Gate1 Via One').u32(SENTINEL_TIME).position(20.1012345, 50.4012345).cstr('').u8(0).u32(0).u32(0).bytes() }],
      extraGfiRecords: [{ type: 'I', body: new Bytes().u32(78).cstr(SENTINEL_LIST).u32(SENTINEL_TIME).u32(0).bytes() }],
    });
    const enc = new TextEncoder();
    /**
     * @param {any} container
     * @param {string} type
     * @param {number} nameAt   where the name starts in the body
     * @param {string} name
     */
    const body = (container, type, nameAt, name) => {
      const n = enc.encode(name + '\0');
      const r = container.records.find((/** @type {any} */ x) => x.type === type && Buffer.from(x.body.subarray(nameAt, nameAt + n.length)).equals(Buffer.from(n)));
      assert.ok(r, `${type} ${name}`);
      return /** @type {Uint8Array} */ (r.body); // a view into the file's bytes: writes change the file
    };
    const put = (/** @type {Uint8Array} */ b, /** @type {number} */ at, /** @type {number} */ v) => new DataView(b.buffer, b.byteOffset).setUint32(at, v >>> 0, true);
    const gdb = readContainer(/** @type {Uint8Array} */ (files.get(`${LIB}/AllData.gdb`)), { role: 'gdb' });
    const gfi = readContainer(/** @type {Uint8Array} */ (files.get(`${LIB}/FolderData.gfi`)), { role: 'gfi' });
    const alpha = 'Gate1 Waypoint Alpha';
    put(body(gdb, 'W', 0, alpha), alpha.length + 1, SENTINEL_TIME); // class slot
    const charlie = 'Gate1 Waypoint Charlie'; // no comment, no proximity: the icon sits 4 bytes after the comment's NUL + flag
    put(body(gdb, 'W', 0, charlie), charlie.length + 1 + 4 + 8 + 1 + 1 + 4, toSemicircles(SENTINEL_LAT)); // icon slot
    const route = 'Gate1 Route Four';
    put(body(gdb, 'R', 0, route), route.length + 2, SENTINEL_TIME); // point count slot
    put(body(gfi, 'I', 4, 'Gate1 Ocean'), 4 + 'Gate1 Ocean'.length + 1, toSemicircles(SENTINEL_LON)); // created-by slot
    // The point count of one of our TrackSegments files.
    const [tsPath, tsBytes] = /** @type {[string, Uint8Array]} */ ([...files].find(([p]) => p.includes('/TrackSegments/')));
    put(tsBytes, /** @type {number} */ (readHeader(tsBytes, { role: 'tracksegments' }).bodyStart), SENTINEL_TIME);
    assert.ok(tsPath);

    const report = await runCheck(asInputs(files), { expected: EXPECTED });
    const all = report.text + '\n' + JSON.stringify(report.json);
    for (const v of [SENTINEL_TIME, toSemicircles(SENTINEL_LAT), toSemicircles(SENTINEL_LON)]) {
      for (const s of [String(v), String(v >>> 0)]) assert.ok(!all.includes(s), `report leaks ${s}`);
    }
    // Still useful: the slot is named, and its value is said to be out of the small range.
    assert.match(report.text, /Waypoint Alpha: records 1; length \d+; class large;/);
    assert.match(report.text, /Waypoint Charlie: [^\n]*icon large;/);
    assert.match(report.text, /point count field large \(expected 4\)/);
    assert.match(report.text, /List Ocean: records 1; created by large;/);
    assert.match(report.text, /List "created by" values: [^\n]*large:2/);
    assert.match(report.text, /Via One: waypoint records 1; class large;/);
    assert.match(report.text, /segment points large;/);
  });

  test('the same holds for the kit\'s basic fallback summary', () => {
    const lib = parsedLibrary(sentinelLibrary());
    const basic = basicDump({ gdb: lib.gdb, gfi: lib.gfi, trackSegments: lib.trackSegments.map((s) => ({ ...s, header: readHeader(s.bytes, { role: 'tracksegments' }) })) });
    const all = basic.text + JSON.stringify(basic.json);
    for (const s of forbidden()) assert.ok(!all.includes(s), `basic dump leaks ${JSON.stringify(s)}`);
    assert.match(basic.text, /record types \(count, total bytes, min-max length\): W 7/);
  });
});

// ---------------------------------------------------------------------------------------------

describe('check page pipeline (runCheck)', () => {
  test('file roles and library folders', () => {
    assert.equal(roleOf('a/Database/4.8/AllData.gdb'), 'alldata');
    assert.equal(roleOf('a\\Database\\4.8\\FOLDERDATA.GFI'), 'folderdata');
    assert.equal(roleOf('a/4.8/TrackSegments/0A1B2C3D-0000-4000-A000-0123456789AB'), 'tracksegment');
    assert.equal(roleOf('a/4.8/TrackSegments/.DS_Store'), 'other');
    assert.equal(roleOf('a/4.8/TrackSegments/notes.txt'), 'other');
    assert.equal(roleOf('a/4.8/AllData.gdb.bak'), 'other');
    assert.equal(roleOf(''), 'other');
    assert.equal(libraryKey('x/4.8/AllData.gdb', 'alldata'), 'x/4.8');
    assert.equal(libraryKey('x/4.8/TrackSegments/0A1B2C3D-0000-4000-A000-0123456789AB', 'tracksegment'), 'x/4.8');
    assert.equal(libraryKey('AllData.gdb', 'alldata'), '');
  });

  test('a dropped 4.8 folder: full match, and the report says how it came in', async () => {
    const report = await runCheck(asInputs(buildSyntheticLibrary(EXPECTED)), { expected: EXPECTED, features: { 'read folders dropped on the page': true } });
    assert.match(report.text, /^BCR Gate 1 check, kit version 1\n/);
    assert.match(report.text, /Browser can do: read folders dropped on the page yes/);
    assert.match(report.text, /Input: folder/);
    assert.match(report.text, /Files by role: AllData.gdb 1, FolderData.gfi 1, TrackSegments 7, other 0/);
    assert.match(report.text, /Library folders found: 1/);
    assert.match(report.text, /--- Structure dump ---/);
    assert.match(report.text, /bcr-structure-dump/);
    assert.match(report.text, /Items placed in the right lists: 16 of 16/);
    assert.ok(selfTestPassed(report, EXPECTED));
  });

  test('a .Backup file (a ZIP) gives the same result', async () => {
    const files = buildSyntheticLibrary(EXPECTED);
    const zip = await zipBytes([...files].map(([p, bytes]) => ({ path: `BaseCamp_20261006/${p}`, bytes })));
    const report = await runCheck([fromBlob('BaseCamp_20261006.Backup', new Blob([zip]), true)], { expected: EXPECTED });
    assert.match(report.text, /Input: backup/);
    assert.match(report.text, /ZIP entries: 9 \(not needed: 0, not readable: 0\)/);
    assert.match(report.text, /Tracks found by name: 7 of 7; track points found in order: 56 of 56/);
    assert.ok(selfTestPassed(report, EXPECTED));
  });

  test('a stored (uncompressed) ZIP with other entries and a renamed extension is still found by its bytes', async () => {
    const files = buildSyntheticLibrary(EXPECTED);
    const entries = [...files].map(([p, bytes]) => ({ path: `B/${p}`, bytes }));
    entries.push({ path: 'B/Database/4.8/Thumbnails/x.jpg', bytes: new Uint8Array([1, 2, 3]) });
    const zip = await zipBytes(entries, { compression: 'store' });
    const report = await runCheck([fromBlob('backup copy.dat', new Blob([zip]), true)], { expected: EXPECTED });
    assert.match(report.text, /Input: zip/);
    assert.match(report.text, /ZIP entries: 10 \(not needed: 1, not readable: 0\)/);
    assert.match(report.text, /Files by role: AllData.gdb 1, FolderData.gfi 1, TrackSegments 7, other 1/);
    assert.match(report.text, /Other files: 1, 3 bytes \(not read\)/);
    assert.ok(selfTestPassed(report, EXPECTED));
  });

  test('loose AllData.gdb and FolderData.gfi files picked on their own', async () => {
    const files = buildSyntheticLibrary(EXPECTED);
    const picked = [
      new File([/** @type {Uint8Array} */ (files.get(`${LIB}/AllData.gdb`))], 'AllData.gdb'),
      new File([/** @type {Uint8Array} */ (files.get(`${LIB}/FolderData.gfi`))], 'FolderData.gfi'),
    ];
    const report = await runCheck(inputsFromPicker(picked), { expected: EXPECTED });
    assert.match(report.text, /Input: files/);
    assert.match(report.text, /Waypoints found by name: 6 of 6/);
    assert.match(report.text, /TrackSegments files matched to our tracks: 0 of 7/);
  });

  test('a renamed library file is recognised by its signature when dropped on its own', async () => {
    const files = buildSyntheticLibrary(EXPECTED);
    const report = await runCheck([fromBlob('copy of the database', new Blob([/** @type {Uint8Array} */ (files.get(`${LIB}/AllData.gdb`))]), true)], { expected: EXPECTED });
    assert.match(report.text, /Files by role: AllData.gdb 1, FolderData.gfi 0/);
    assert.match(report.text, /Waypoints found by name: 6 of 6/);
  });

  test('two version folders are reported as two libraries', async () => {
    const files = buildSyntheticLibrary(EXPECTED);
    const inputs = [...asInputs(files, 'G/4.7copy'), ...asInputs(files, 'G/4.8copy')];
    const report = await runCheck(inputs, { expected: EXPECTED });
    assert.match(report.text, /Library folders found: 2/);
    assert.match(report.text, /=== Library 1 of 2 ===/);
    assert.match(report.text, /=== Library 2 of 2 ===/);
  });

  test('nothing useful dropped: a plain answer, no crash', async () => {
    const empty = await runCheck([], { expected: EXPECTED });
    assert.match(empty.text, /No AllData.gdb or FolderData.gfi was found/);
    const junk = await runCheck([fromBlob('holiday.jpg', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])]), true)], { expected: EXPECTED });
    assert.match(junk.text, /other 1/);
    assert.match(junk.text, /Library folders found: 0/);
  });

  test('a damaged ZIP and a package dropped as a file are explained', async () => {
    const zip = new Uint8Array(64);
    zip.set([0x50, 0x4b, 0x03, 0x04]);
    const bad = await runCheck([fromBlob('x.Backup', new Blob([zip]), true)], { expected: EXPECTED });
    assert.match(bad.text, /A ZIP or \.Backup file could not be opened \(reason code: [a-z_]+\)/);
    const pkg = await runCheck([fromBlob('My.bclibrary', new Blob([]), true)], { expected: EXPECTED });
    assert.match(pkg.text, /Show Package Contents/);
  });

  test('a .Backup inside a dropped folder (say the whole "Gate1 results" folder) is not opened, but the report says what to do', async () => {
    // STEPS.md has the founder save Gate1.Backup into a "Gate1 results" folder; dragging that folder instead of the
    // file is an easy slip. Before, the report said only that nothing was found.
    const files = buildSyntheticLibrary(EXPECTED);
    const zip = await zipBytes([...files].map(([p, bytes]) => ({ path: `Gate1/${p}`, bytes })));
    const inputs = [
      fromBlob('Gate1 results/Gate1.Backup', new Blob([zip]), false),
      fromBlob('Gate1 results/Gate1 Ocean export.gpx', new Blob(['<gpx/>']), false),
    ];
    const report = await runCheck(inputs, { expected: EXPECTED });
    assert.match(report.text, /Library folders found: 0/);
    assert.match(report.text, /Note: [^\n]*\.Backup file was inside the dropped folder[^\n]*on its own/);
    assert.ok(!report.text.includes('Gate1 results') && !report.text.includes('Gate1.Backup'), 'no file or folder names');
  });

  test('files that are too large or unreadable are counted, not read', async () => {
    const huge = { path: 'L/4.8/AllData.gdb', size: MAX_LIBRARY_FILE_BYTES + 1, read: async () => assert.fail('must not read') };
    const failing = { path: 'L/4.8/FolderData.gfi', size: 10, read: async () => Promise.reject(new Error('gone')) };
    const report = await runCheck([huge, failing], { expected: EXPECTED });
    assert.match(report.text, /AllData.gdb could not be read \(too large or unreadable\)/);
    assert.match(report.text, /FolderData.gfi could not be read \(too large or unreadable\)/);
  });

  test('the dump adapter falls back to the basic summary if the dump fails', () => {
    const lib = parsedLibrary(buildSyntheticLibrary(EXPECTED));
    // The first read of trackSegments (inside the dump call) fails; the fallback's read works.
    let first = true;
    const flaky = /** @type {any} */ ({
      gdb: lib.gdb,
      gfi: lib.gfi,
      get trackSegments() {
        if (first) {
          first = false;
          throw new Error('boom');
        }
        return [];
      },
    });
    const out = structureDump(flaky);
    assert.match(out.text, /The structure dump failed; this is the kit's basic summary instead/);
    assert.match(out.text, /AllData.gdb:\n  size 2663 bytes; signature MsRc; primary format 0x0066/);
    assert.equal(/** @type {any} */ (out.json).dumpFailed, true);
    // If even the fallback fails, a plain line comes back instead of an exception.
    const hopeless = /** @type {any} */ ({ get gdb() { throw new Error('x'); }, get gfi() { throw new Error('x'); }, get trackSegments() { throw new Error('x'); } });
    assert.match(structureDump(hopeless).text, /and so did the basic summary/);
  });

  test('seeded damage (truncation and bit flips) never throws, hangs or loses the report', async () => {
    const files = buildSyntheticLibrary(EXPECTED);
    let seed = 0x5eed;
    const rand = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 2 ** 32;
    };
    const keys = [...files.keys()];
    const started = Date.now();
    for (let i = 0; i < 120; i++) {
      const damaged = new Map(files);
      const key = keys[Math.floor(rand() * 3) === 0 ? 0 : Math.floor(rand() * keys.length)];
      const original = /** @type {Uint8Array} */ (files.get(key));
      let bytes = original.slice();
      if (rand() < 0.5) bytes = bytes.slice(0, Math.floor(rand() * bytes.length));
      for (let f = 0; f < 1 + Math.floor(rand() * 8); f++) {
        if (bytes.length === 0) break;
        bytes[Math.floor(rand() * bytes.length)] ^= 1 << Math.floor(rand() * 8);
      }
      damaged.set(key, bytes);
      const report = await runCheck(asInputs(damaged), { expected: EXPECTED });
      assert.match(report.text, /BCR Gate 1 check/);
      assert.ok(!report.json || !(/** @type {any} */ (report.json).internalError), `case ${i} hit an internal error`);
    }
    assert.ok(Date.now() - started < 60_000, 'bounded time');
  });

  test('the self-test passes, and fails when something is missing', async () => {
    const { passed, report } = await selfTest(EXPECTED);
    assert.equal(passed, true);
    assert.ok(report);
    const broken = clone(EXPECTED);
    broken.waypoints.push({ ...broken.waypoints[0], label: 'Extra', name: 'Gate1 Not There' });
    assert.equal(selfTestPassed(/** @type {any} */ (report), broken), false);
  });
});

// ---------------------------------------------------------------------------------------------

describe('taking in a drop (inputsFromDrop)', () => {
  // Stand-ins for the browser's FileSystemEntry objects (webkitGetAsEntry), shaped like the WebKit/Chromium API.
  /**
   * @param {string} fullPath
   * @param {Uint8Array} bytes
   * @param {{ fail?: boolean }} [o]
   */
  const fileEntry = (fullPath, bytes, o = {}) => ({
    isFile: true,
    isDirectory: false,
    name: fullPath.split('/').pop(),
    fullPath,
    file(/** @type {(f: File) => void} */ ok, /** @type {(e: Error) => void} */ fail) {
      setTimeout(() => (o.fail ? fail(new Error('not allowed')) : ok(new File([bytes], fullPath.split('/').pop() ?? ''))), 0);
    },
  });
  /**
   * @param {string} fullPath
   * @param {any[]} children
   * @param {{ batch?: number, endless?: boolean }} [o]
   */
  const dirEntry = (fullPath, children, o = {}) => ({
    isFile: false,
    isDirectory: true,
    name: fullPath.split('/').pop(),
    fullPath,
    createReader() {
      let i = 0;
      return {
        readEntries(/** @type {(b: any[]) => void} */ ok) {
          if (o.endless) return void setTimeout(() => ok(children), 0);
          const batch = children.slice(i, i + (o.batch ?? 100));
          i += batch.length;
          setTimeout(() => ok(batch), 0);
        },
      };
    },
  });
  /** @param {Map<string, Uint8Array>} files  a synthetic library, as a 4.8 folder entry */
  const folderEntry = (files, batch = 3) => {
    /** @type {Map<string, any[]>} */
    const dirs = new Map([['/4.8', []], ['/4.8/TrackSegments', []]]);
    for (const [p, bytes] of files) {
      const full = `/4.8/${p.slice(LIB.length + 1)}`;
      const dir = full.slice(0, full.lastIndexOf('/'));
      /** @type {any[]} */ (dirs.get(dir)).push(fileEntry(full, bytes));
    }
    const ts = dirEntry('/4.8/TrackSegments', /** @type {any[]} */ (dirs.get('/4.8/TrackSegments')), { batch });
    return dirEntry('/4.8', [.../** @type {any[]} */ (dirs.get('/4.8')), ts], { batch });
  };
  /** @param {any[]} entries */
  const transfer = (entries, files = /** @type {File[]} */ ([])) => ({
    items: entries.map((e) => ({ kind: 'file', webkitGetAsEntry: () => e })),
    files,
  });

  test('a dropped 4.8 folder, read in several batches, gives the full library and a full match', async () => {
    const files = buildSyntheticLibrary(EXPECTED);
    const { inputs, truncated, failed } = await inputsFromDrop(/** @type {any} */ (transfer([folderEntry(files)])));
    assert.equal(inputs.length, files.size);
    assert.equal(truncated, false);
    assert.equal(failed, 0);
    assert.ok(inputs.every((i) => i.topLevel === false), 'files inside a folder are not top-level');
    const report = await runCheck(inputs, { expected: EXPECTED });
    assert.match(report.text, /Input: folder/);
    assert.ok(selfTestPassed(report, EXPECTED));
  });

  test('the entries are taken synchronously, inside the drop event', () => {
    let calls = 0;
    const dt = { items: [1, 2, 3].map(() => ({ kind: 'file', webkitGetAsEntry: () => (calls++, null) })), files: [] };
    const pending = inputsFromDrop(/** @type {any} */ (dt));
    assert.equal(calls, 3, 'every item was asked for its entry before inputsFromDrop returned');
    return pending;
  });

  test('a single dropped file is top-level, so a .Backup is opened as a ZIP', async () => {
    const files = buildSyntheticLibrary(EXPECTED);
    const zip = await zipBytes([...files].map(([p, bytes]) => ({ path: `B/${p}`, bytes })));
    const { inputs } = await inputsFromDrop(/** @type {any} */ (transfer([fileEntry('/Gate1.Backup', zip)])));
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].topLevel, true);
    const report = await runCheck(inputs, { expected: EXPECTED });
    assert.match(report.text, /Input: backup/);
    assert.ok(selfTestPassed(report, EXPECTED));
  });

  test('without webkitGetAsEntry the dropped files are used as they are', async () => {
    const gdb = /** @type {Uint8Array} */ (buildSyntheticLibrary(EXPECTED).get(`${LIB}/AllData.gdb`));
    const dt = { items: [{ kind: 'file' }, { kind: 'string' }], files: [new File([gdb], 'AllData.gdb')] };
    const { inputs } = await inputsFromDrop(/** @type {any} */ (dt));
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].topLevel, true);
    assert.equal(roleOf(inputs[0].path), 'alldata');
  });

  test('an entry the browser cannot open is counted and the rest are still read', async () => {
    const files = buildSyntheticLibrary(EXPECTED);
    const root = folderEntry(files);
    const broken = dirEntry('/4.8b', [fileEntry('/4.8b/AllData.gdb', new Uint8Array(1), { fail: true }), fileEntry('/4.8b/x.txt', new Uint8Array(1))]);
    const { inputs, failed } = await inputsFromDrop(/** @type {any} */ (transfer([broken, root])));
    assert.equal(failed, 1);
    assert.equal(inputs.length, files.size + 1);
  });

  test('a dropped file whose entry the browser will not open is read from the dropped File instead', async () => {
    // Seen in headless Chrome 154 on check.html opened from disk (file://): webkitGetAsEntry() hands out the entry,
    // but entry.file() fails with EncodingError, while dataTransfer.files holds the same file and it reads fine. The
    // original code used only the entry, so a dropped .Backup gave "nothing readable".
    const files = buildSyntheticLibrary(EXPECTED);
    const zip = await zipBytes([...files].map(([p, bytes]) => ({ path: `B/${p}`, bytes })));
    let inEvent = true;
    const list = [new File([zip], 'Gate1.Backup')];
    const dt = {
      items: [{ kind: 'file', webkitGetAsEntry: () => fileEntry('/Gate1.Backup', zip, { fail: true }) }],
      // Like a real DataTransfer, the list is empty once the drop event is over.
      get files() {
        return inEvent ? list : [];
      },
    };
    const pending = inputsFromDrop(/** @type {any} */ (dt));
    inEvent = false;
    const { inputs, failed } = await pending;
    assert.equal(failed, 0, 'the file was recovered, so it is not counted as failed');
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].topLevel, true);
    const report = await runCheck(inputs, { expected: EXPECTED });
    assert.match(report.text, /Input: backup/);
    assert.ok(selfTestPassed(report, EXPECTED));
  });

  test('a dropped folder the browser will not open stays counted as failed; its placeholder File is never read', async () => {
    const brokenDir = {
      isFile: false,
      isDirectory: true,
      name: '4.8',
      fullPath: '/4.8',
      createReader: () => ({
        readEntries: (/** @type {any} */ _ok, /** @type {(e: Error) => void} */ fail) => setTimeout(() => fail(new Error('EncodingError')), 0),
      }),
    };
    let read = 0;
    const placeholder = { name: '4.8', size: 160, arrayBuffer: async () => (read++, new ArrayBuffer(0)), slice: () => placeholder };
    const { inputs, failed } = await inputsFromDrop(/** @type {any} */ (transfer([brokenDir], /** @type {any} */ ([placeholder]))));
    assert.equal(failed, 1);
    assert.equal(inputs.length, 0);
    assert.equal(read, 0);
  });

  test('a reader that never runs dry, and a folder too deep, both stop at the caps', async () => {
    const endless = dirEntry('/loop', [dirEntry('/loop/a', [], { endless: true })], { endless: true });
    const looped = await inputsFromDrop(/** @type {any} */ (transfer([endless])), { maxEntries: 50 });
    assert.equal(looped.truncated, true);
    /** @type {any} */
    let deep = fileEntry('/d/AllData.gdb', new Uint8Array(1));
    for (let i = 0; i < 6; i++) deep = dirEntry(`/d${i}`, [deep]);
    const capped = await inputsFromDrop(/** @type {any} */ (transfer([deep])), { maxDepth: 3 });
    assert.equal(capped.truncated, true);
    assert.equal(capped.inputs.length, 0);
    const fine = await inputsFromDrop(/** @type {any} */ (transfer([deep])), { maxDepth: 10 });
    assert.equal(fine.inputs.length, 1);
    const fewFiles = await inputsFromDrop(/** @type {any} */ (transfer([folderEntry(buildSyntheticLibrary(EXPECTED))])), { maxFiles: 4 });
    assert.equal(fewFiles.inputs.length, 4);
    assert.equal(fewFiles.truncated, true);
  });
});

// ---------------------------------------------------------------------------------------------

describe('every scenario of the independent fixture writer (tools/fixtures) goes through the check page safely', () => {
  // These libraries are written from FORMAT.md by code that never reads src/format/, so they reach the kit in shapes
  // its own synth.js never makes (other names, encodings, damage, fatal headers). The founder's real library may hold
  // more than the Gate1 items, so for each one: no crash, no internal error, and nothing it holds in the report.
  // Every fixed word the report can print is in the bundled source; a name that is not there can only have come from
  // the library, so those are the names checked (short names such as "Hut" would collide with ordinary words).
  const source = buildBundle().js;
  /**
   * @param {any} scenario
   * @param {any} expected
   * @returns {string[]}
   */
  function forbiddenFor(scenario, expected) {
    /** @type {Set<string>} */
    const words = new Set(scenario.sentinels ? scenario.sentinels.strings : []);
    /** @type {number[]} */
    const numbers = scenario.sentinels ? [...scenario.sentinels.numbers] : [];
    /** @param {any} p */
    const point = (p) => {
      numbers.push(p.lat, p.lon, toSemicircles(p.lat), toSemicircles(p.lon));
      if (typeof p.time === 'number') numbers.push(p.time, Math.floor(p.time / 1000));
      if (typeof p.ele === 'number' && !Number.isInteger(p.ele)) numbers.push(p.ele);
    };
    for (const it of expected.items) {
      words.add(it.name);
      if (typeof it.comment === 'string') words.add(it.comment);
      if (typeof it.lat === 'number') point(it);
      for (const seg of it.segments ?? []) for (const p of seg) point(p);
      for (const p of it.points ?? []) {
        words.add(p.name);
        point(p);
      }
    }
    for (const t of expected.tree ?? []) for (const part of t.path) words.add(part);
    for (const x of [...(expected.notDecoded ?? []), ...(expected.routesNotConverted ?? [])]) words.add(x.name);
    /** @type {string[]} */
    const out = [];
    for (const w of words) if (typeof w === 'string' && w.length >= 4 && !source.includes(w)) out.push(w);
    for (const n of numbers) {
      if (!Number.isFinite(n)) continue;
      const forms = [String(n), String(Math.abs(n))];
      if (!Number.isInteger(n)) forms.push(n.toFixed(4), n.toFixed(5));
      else if (Math.abs(n) > 1e8) forms.push(new Date(n > 1e11 ? n : n * 1000).toISOString().slice(0, 16));
      for (const f of forms) if (f.replace(/[^0-9]/g, '').length >= 5) out.push(f);
    }
    return out;
  }

  for (const s of SCENARIOS) {
    test(`${s.name}`, async () => {
      const { built, expected, scenario } = buildScenario(s.name);
      const base = `Users/x/Library/Application Support/Garmin/BaseCamp/Database/${built.databaseVersion}`;
      const folder = [...built.files].map(([p, bytes]) => fromBlob(`${base}/${p}`, new Blob([bytes]), false));
      const backup = await buildBackup(built, { compression: 'auto', name: 'BaseCamp_x' });
      const forbidden = forbiddenFor(scenario, expected);
      for (const [how, inputs] of /** @type {const} */ ([
        ['folder', folder],
        ['backup', [fromBlob('x.Backup', new Blob([backup]), true)]],
      ])) {
        const report = await runCheck(inputs, { expected: EXPECTED });
        assert.ok(!report.json.internalError, `${how}: internal error`);
        assert.doesNotMatch(report.text, /internal error|dump failed/, `${how}: a step failed`);
        for (const lib of report.json.libraries) {
          assert.ok(!lib.dumpError && !(lib.dump && lib.dump.dumpFailed), `${how}: the structure dump failed`);
          assert.ok(!lib.compare.gdbError && !lib.compare.gfiError, `${how}: the comparison stopped early`);
        }
        assert.match(report.text, /Library folders found: 1/, `${how}: the library was found`);
        const all = report.text + '\n' + JSON.stringify(report.json);
        for (const f of forbidden) assert.ok(!all.includes(f), `${how}: report leaks ${JSON.stringify(f)}`);
      }
    });
  }
});

describe('the bundled page (check.html)', () => {
  const committed = read('check.html');
  const scriptStart = committed.indexOf('<script>') + '<script>'.length;
  const scriptEnd = committed.lastIndexOf('</script>');
  const js = committed.slice(scriptStart, scriptEnd);
  const style = /<style>([\s\S]*?)<\/style>/.exec(committed)?.[1] ?? '';
  const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(committed)?.[1] ?? '';

  test('check.html is current (rerun `node tools/gate1/build.js` after changing any bundled module)', () => {
    const { html } = buildPage();
    assert.ok(html === committed, 'tools/gate1/check.html is stale: run node tools/gate1/build.js');
  });

  test('the policy blocks every network request and allows only this exact script and style', () => {
    const hash = (/** @type {string} */ s) => `sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}`;
    assert.ok(policy.includes(`script-src '${hash(js)}'`), 'script hash matches the inline script');
    assert.ok(policy.includes(`style-src '${hash(style)}'`), 'style hash matches the inline style');
    for (const d of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "object-src 'none'"]) assert.ok(policy.includes(d), d);
    assert.ok(!/unsafe-|https?:|\*/.test(policy), 'no unsafe-*, no hosts, no wildcards');
    assert.equal(sha256Source('abc'), 'sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
    // The policy must come before anything it governs.
    assert.ok(committed.indexOf('Content-Security-Policy') < committed.indexOf('<style>'));
    assert.equal((committed.match(/<script/g) ?? []).length, 1, 'one script element, inline');
    assert.ok(!/\sstyle=|\son[a-z]+=|<link|<iframe|<img|<form/i.test(committed.replace(js, '')), 'no inline handlers, links, frames, images or forms');
  });

  test('the script holds no network code and nothing that would end the script element early', () => {
    for (const s of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'importScripts', 'new Worker', 'http://', 'https://', '</script', '<!--']) {
      assert.ok(!js.includes(s), `bundle contains ${s}`);
    }
  });

  test('the bundle runs on its own in a bare context (no document, no Node globals): Gate1 is defined and the self-test passes', async () => {
    // Only what a browser page also has. No require, process or Buffer.
    const context = vm.createContext({ TextEncoder, TextDecoder, Blob, setTimeout, clearTimeout });
    vm.runInContext(js, context, { filename: 'check.html#script' });
    const Gate1 = /** @type {any} */ (context).Gate1;
    assert.equal(typeof Gate1.runCheck, 'function');
    assert.equal(typeof Gate1.init, 'function');
    assert.equal(Gate1.EXPECTED.kitVersion, EXPECTED.kitVersion);
    const { passed } = await Gate1.selfTest(Gate1.EXPECTED);
    assert.equal(passed, true);
  });

  /** Runs the bundle in this realm (a vm context has its own Uint8Array, which DecompressionStream's output is not). */
  function bundleHere() {
    const before = /** @type {any} */ (globalThis).Gate1;
    new Function(js)();
    const Gate1 = /** @type {any} */ (globalThis).Gate1;
    if (before === undefined) delete (/** @type {any} */ (globalThis).Gate1);
    else /** @type {any} */ (globalThis).Gate1 = before;
    return Gate1;
  }

  test('the bundle reads a .Backup ZIP through DecompressionStream exactly as the modules do', async () => {
    const Gate1 = bundleHere();
    const files = buildSyntheticLibrary(EXPECTED);
    const zip = await zipBytes([...files].map(([p, bytes]) => ({ path: `X/${p}`, bytes })));
    const viaBundle = await Gate1.runCheck([Gate1.fromBlob('x.Backup', new Blob([zip]), true)], { expected: Gate1.EXPECTED });
    const viaModules = await runCheck([fromBlob('x.Backup', new Blob([zip]), true)], { expected: EXPECTED });
    assert.equal(viaBundle.text, viaModules.text);
  });

  test('the bundle includes the reader modules the task names, in dependency order', () => {
    const { modules } = buildBundle();
    for (const m of ['src/format/container.js', 'src/format/dump.js', 'src/format/unzip.js', 'tools/gate1/check.js']) assert.ok(modules.includes(m), m);
    assert.equal(modules[modules.length - 1], 'tools/gate1/check.js');
    assert.ok(modules.indexOf('src/export/crc32.js') < modules.indexOf('src/format/unzip.js'));
    assert.ok(modules.indexOf('src/format/container.js') < modules.indexOf('src/format/dump.js'));
  });
});

describe('build.js refuses what it does not understand', () => {
  const file = path.join(KIT, 'x.js');
  for (const [label, source, message] of [
    ['default export', 'export default 1;\n', /default exports/],
    ['export *', "export * from './y.js';\n", /export \*/],
    ['side-effect import', "import './y.js';\n", /side-effect/],
    ['dynamic import', "const m = import('./y.js');\n", /dynamic import/],
    ['import.meta', 'const u = import.meta.url;\n', /import\.meta/],
    ['bare specifier', "import { a } from 'node:fs';\n", /only relative imports/],
    ['default import', "import a from './y.js';\n", /unsupported import clause/],
    ['destructured export', 'export const { a, b } = c;\n', /does not understand/],
  ]) {
    test(label, () => assert.throws(() => transformModule(file, /** @type {string} */ (source), 'm'), /** @type {RegExp} */ (message)));
  }

  test('JSDoc import() types in comments are fine; named, renamed and namespace imports are rewritten', () => {
    const out = transformModule(
      file,
      "/** @type {import('./y.js').T} */\nimport { a, b as c } from './y.js';\nimport * as ns from './z.js';\nexport function f() { return a + c + ns.q; }\nconst g = 1;\nexport { g as h };\n",
      'm',
    );
    assert.deepEqual(out.imports.map((i) => i.bindings), [[{ imported: 'a', local: 'a' }, { imported: 'b', local: 'c' }], []]);
    assert.equal(out.imports[1].namespace, 'ns');
    assert.deepEqual([...out.exports], [['f', 'f'], ['h', 'g']]);
    assert.ok(!/^\s*(import|export)\b/m.test(out.body));
  });

  test('the words "import (" inside a string or comment are not taken for a dynamic import', () => {
    assert.doesNotThrow(() => transformModule(file, "const a = 'made on import (1)';\n// import (x)\nconst b = `import (y)`;\nexport { a, b };\n", 'm'));
  });

  test('cycles and missing names stop the build', () => {
    const sources = /** @type {Record<string, string>} */ ({
      [path.join(KIT, 'a.js')]: "import { b } from './b.js';\nexport const a = 1;\n",
      [path.join(KIT, 'b.js')]: "import { a } from './a.js';\nexport const b = 2;\n",
      [path.join(KIT, 'c.js')]: "import { nope } from './d.js';\nexport const c = 1;\n",
      [path.join(KIT, 'd.js')]: 'export const d = 1;\n',
    });
    const readFake = (/** @type {string} */ f) => {
      if (!(f in sources)) throw new Error('missing');
      return sources[f];
    };
    assert.throws(() => collectModules(path.join(KIT, 'a.js'), readFake), /import cycle/);
    assert.throws(() => collectModules(path.join(KIT, 'c.js'), readFake), /does not export/);
  });
});

// ---------------------------------------------------------------------------------------------
// The real Mac BaseCamp 4.8.13 samples (testdata/basecamp-real/, made-up content only). The comparison must find every
// made-up value the sample really holds. What it does not hold is pinned as "not found" on purpose: run1 was not
// built as STEPS.md asks (BaseCamp made one import list, "gate1-ocean", and no address was typed), and BaseCamp
// renamed the second "Gate1 Twin Track" to "Gate1 Twin Track 001" (FORMAT.md §15.1).

describe('the real BaseCamp 4.8.13 samples (testdata/basecamp-real)', () => {
  const REAL = path.join(HERE, '..', 'testdata', 'basecamp-real');

  /** @param {string} run  the folder holding 4.8 */
  async function check(run) {
    /** @type {import('../tools/gate1/check.js').InputFile[]} */
    const inputs = [];
    const root = path.join(REAL, run);
    const walk = (/** @type {string} */ dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else inputs.push(fromBlob(path.relative(root, full).split(path.sep).join('/'), new Blob([readFileSync(full)])));
      }
    };
    walk(path.join(root, '4.8'));
    const report = await runCheck(inputs, { expected: EXPECTED });
    assert.equal(report.compare.length, 1, `${run}: one library`);
    return { text: report.text, json: /** @type {any} */ (report.compare[0]) };
  }

  for (const run of ['run1-gate1', 'run2-structured']) {
    test(`${run}: every made-up item, track point and TrackSegments value in the sample is found and matched`, async () => {
      const { text, json } = await check(run);
      assert.match(text, /Waypoints found by name: 6 of 6; positions matched: 6 of 6; comments matched: 3 of 3/);
      assert.match(text, /Tracks found by name: 7 of 7; track points found in order: 56 of 56/);
      assert.match(text, /Routes found by name: 1 of 1; via points stored as waypoint records: 4 /);
      assert.match(text, /TrackSegments files matched to our tracks: 7 of 7; elevations matched: 50 of 50; times matched: 42 of 42/);
      assert.match(text, /Records that are not ours: W 0, T 0, R 0/);
      const tracks = json.gdb.tracks;
      for (const t of tracks) {
        assert.equal(t.pointsFoundInOrder, t.pointsExpected, t.label);
        assert.equal(t.segmentsFileFound, true, t.label);
        // Mac 4.8 (§15.4 row 18): the uuid is followed by the 40-byte tail, or the 24-byte one on the track without
        // elevation; the old §6.1 "ends with the uuid" does not hold.
        assert.equal(t.endsWithUuid, false, t.label);
        assert.equal(t.uuidBytesFromEnd, t.label === 'Track Bare' ? 37 + 24 : 37 + 40, t.label);
      }
      const twinA = tracks.find((/** @type {any} */ t) => t.label === 'Twin Track A');
      const twinB = tracks.find((/** @type {any} */ t) => t.label === 'Twin Track B');
      assert.equal(twinA.renamedByBaseCamp, true, 'Twin A (gate1-desert.gpx) is the renamed "… 001"');
      assert.equal(twinB.renamedByBaseCamp, false);
      assert.match(text, /Twin Track A: records with this name 1; records starting with this name 2; renamed by BaseCamp \(number added\) yes; length 241; points in order 5 of 5/);
      // The 17-slot points (§15.7): elevation at 1, time at 10, temperature and heart rate on the sensor track.
      const sensors = tracks.find((/** @type {any} */ t) => t.label === 'Track Sensors').segments;
      assert.deepEqual(
        [sensors.bytesPerPoint, sensors.elevationAt, sensors.timeAt, sensors.temperatureAt, sensors.heartRateAt, sensors.elevationsMatched, sensors.timesMatched],
        [38, 1, 10, 18, 27, 9, 9],
      );
      assert.ok(json.gdb.waypoints.every((/** @type {any} */ w) => w.positionMatches), 'every waypoint position');
      assert.ok(json.gdb.viaPoints.every((/** @type {any} */ v) => v.records === 1 && v.positionMatches === 1), 'every via point record');
    });
  }

  test('run1: what the sample does not hold is reported as not found, not guessed', async () => {
    const { text } = await check('run1-gate1');
    // No address was typed into Delta in run1; Bravo's imported address and phone are there.
    assert.match(text, /Waypoint Delta: .*street not found; city not found; state not found; country not found; postalCode not found; phone not found/);
    assert.match(text, /Waypoint Bravo: .*street at prefix\+0; city at prefix\+24; state at prefix\+44; country at prefix\+65; postalCode at prefix\+88; phone at prefix\+120/);
    // The tree was not built as STEPS.md asks: one import list named after the first GPX file.
    assert.match(text, /Our folders found: 1 of 2; our lists found: 0 of 3/);
    assert.match(text, /Items placed in the right lists: 0 of 16; items in two lists: 0 of 2/);
    assert.match(text, /List "created by" values: 0:1, 3:2, 8:1/);
    assert.match(text, /Folder Trips: records 1; parent field right yes; listed in parent's children yes; bytes after children 10/);
  });

  test('run2: the typed address and phone are found; the two user lists and the nested folder are found', async () => {
    const { text } = await check('run2-structured');
    assert.match(text, /Waypoint Delta: .*street at prefix\+0; city at prefix\+20; state at prefix\+37; country at prefix\+55; postalCode at prefix\+72; phone at prefix\+112/);
    // BaseCamp stored Delta's altitude as 100.2792 m after the edit (a round trip through feet, §15.3 row 14).
    assert.match(text, /Waypoint Delta: .*elevation not found/);
    assert.match(text, /Our folders found: 2 of 2; our lists found: 2 of 3/);
    assert.match(text, /Folder Inner: records 1; parent field right yes; listed in parent's children yes; bytes after children 10/);
    assert.match(text, /List Desert: records 1; created by 0; parent field right yes; listed in folder's children yes; references 2 of ours/);
    assert.match(text, /List Deep: records 1; created by 0; parent field right yes; listed in folder's children yes; references 2 of ours/);
  });

  test('the report on a real sample holds no name, coordinate, time or uuid from it', async () => {
    const { text, json } = await check('run1-gate1');
    const all = text + '\n' + JSON.stringify(json);
    for (const w of EXPECTED.waypoints) for (const s of [w.name, w.lat.toFixed(5), w.lon.toFixed(5)]) assert.ok(!all.includes(s), s);
    for (const t of EXPECTED.tracks) assert.ok(!all.includes(t.name), t.name);
    for (const f of readdirSync(path.join(REAL, 'run1-gate1', '4.8', 'TrackSegments'))) assert.ok(!all.toLowerCase().includes(f.toLowerCase()), 'a uuid');
    assert.ok(!all.includes('gate1-ocean') && !all.includes('2026-10-07'), 'a list name or an import time');
  });
});
