// Tests for src/export/kml.js. All data is synthetic. Well-formedness and element order are
// checked with the system xmllint against a subset of the OGC KML 2.2 schema written out below.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KML_TRACK_COLORS, kmlChunks, writeKml } from '../src/export/kml.js';
import { GARMIN_COLORS } from '../src/export/gpx.js';
import { MAX_FOLDER_DEPTH, buildFolderTree } from '../src/export/paths.js';
import { Tally, WRITER_MESSAGES } from '../src/export/xml.js';

// Special characters are built from code points so the source stays plain ASCII and unambiguous.
const ch = (/** @type {number[]} */ ...cps) => String.fromCharCode(...cps);
const cp = (/** @type {number[]} */ ...cps) => String.fromCodePoint(...cps);

/** @typedef {import('../src/model.js').Library} Library */
/** @typedef {import('../src/model.js').Folder} Folder */
/** @typedef {import('../src/model.js').Item} Item */

// ---------------------------------------------------------------------------------------------
// xmllint helpers

const hasXmllint = (() => {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const NO_XMLLINT = hasXmllint ? false : 'xmllint is not installed';

const dir = mkdtempSync(join(tmpdir(), 'bcr-kml-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let fileCounter = 0;

/** @param {string} content @param {string} ext */
function tempFile(content, ext = '.kml') {
  const path = join(dir, `f${++fileCounter}${ext}`);
  writeFileSync(path, content, 'utf8');
  return path;
}

/** @param {string} xml */
function assertWellFormed(xml) {
  execFileSync('xmllint', ['--noout', '--nonet', tempFile(xml)], { stdio: ['ignore', 'pipe', 'pipe'] });
}

/** @param {string} xml */
function assertSchemaValid(xml) {
  execFileSync('xmllint', ['--noout', '--nonet', '--schema', KML_XSD_PATH, tempFile(xml)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** The XPath string value; xmllint adds one newline after it. @param {string} xml @param {string} xpath */
function xpathString(xml, xpath) {
  const out = execFileSync('xmllint', ['--nonet', '--xpath', `string(${xpath})`, tempFile(xml)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out.endsWith('\n') ? out.slice(0, -1) : out;
}

/** XPath step for a KML element in the default namespace. @param {string} name */
const el = (name) => `*[local-name()="${name}"]`;

// A subset of the OGC KML 2.2 schema (ogckml22.xsd): only the elements this writer produces, in the
// schema's order (Feature: name, description, styleUrl, then geometry; Document: Styles before
// Features; LineString: tessellate, altitudeMode, coordinates; colour: 4-byte hexBinary). The
// coordinates pattern is stricter than the schema's string list: plain decimals, 2 or 3 per tuple.
const NUM = String.raw`-?\d+(\.\d+)?`;
const TUPLE = `${NUM},${NUM}(,${NUM})?`;
const KML_XSD = String.raw`<?xml version="1.0" encoding="UTF-8"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns="http://www.opengis.net/kml/2.2"
  targetNamespace="http://www.opengis.net/kml/2.2" elementFormDefault="qualified">
  <xsd:element name="kml">
    <xsd:complexType><xsd:sequence><xsd:element ref="Document"/></xsd:sequence></xsd:complexType>
  </xsd:element>
  <xsd:element name="Document">
    <xsd:complexType>
      <xsd:sequence>
        <xsd:element name="name" type="xsd:string" minOccurs="0"/>
        <xsd:element ref="Style" minOccurs="0" maxOccurs="unbounded"/>
        <xsd:element ref="Folder" minOccurs="0" maxOccurs="unbounded"/>
      </xsd:sequence>
    </xsd:complexType>
  </xsd:element>
  <xsd:element name="Style">
    <xsd:complexType>
      <xsd:sequence>
        <xsd:element name="LineStyle">
          <xsd:complexType>
            <xsd:sequence>
              <xsd:element name="color" type="colorType"/>
              <xsd:element name="width" type="xsd:double"/>
            </xsd:sequence>
          </xsd:complexType>
        </xsd:element>
      </xsd:sequence>
      <xsd:attribute name="id" type="xsd:ID" use="required"/>
    </xsd:complexType>
  </xsd:element>
  <xsd:element name="Folder">
    <xsd:complexType>
      <xsd:sequence>
        <xsd:element name="name" type="xsd:string"/>
        <xsd:choice minOccurs="0" maxOccurs="unbounded">
          <xsd:element ref="Folder"/>
          <xsd:element ref="Placemark"/>
        </xsd:choice>
      </xsd:sequence>
    </xsd:complexType>
  </xsd:element>
  <xsd:element name="Placemark">
    <xsd:complexType>
      <xsd:sequence>
        <xsd:element name="name" type="xsd:string" minOccurs="0"/>
        <xsd:element name="description" type="xsd:string" minOccurs="0"/>
        <xsd:element name="styleUrl" type="xsd:anyURI" minOccurs="0"/>
        <xsd:choice minOccurs="0">
          <xsd:element ref="Point"/>
          <xsd:element ref="LineString"/>
          <xsd:element ref="MultiGeometry"/>
        </xsd:choice>
      </xsd:sequence>
    </xsd:complexType>
  </xsd:element>
  <xsd:element name="Point">
    <xsd:complexType>
      <xsd:sequence><xsd:element name="coordinates" type="coordinatesType"/></xsd:sequence>
    </xsd:complexType>
  </xsd:element>
  <xsd:element name="LineString">
    <xsd:complexType>
      <xsd:sequence>
        <xsd:element name="tessellate" type="xsd:boolean"/>
        <xsd:element name="altitudeMode" type="altitudeModeType"/>
        <xsd:element name="coordinates" type="coordinatesType"/>
      </xsd:sequence>
    </xsd:complexType>
  </xsd:element>
  <xsd:element name="MultiGeometry">
    <xsd:complexType>
      <xsd:choice minOccurs="0" maxOccurs="unbounded">
        <xsd:element ref="Point"/>
        <xsd:element ref="LineString"/>
      </xsd:choice>
    </xsd:complexType>
  </xsd:element>
  <xsd:simpleType name="colorType">
    <xsd:restriction base="xsd:hexBinary"><xsd:length value="4"/></xsd:restriction>
  </xsd:simpleType>
  <xsd:simpleType name="altitudeModeType">
    <xsd:restriction base="xsd:string">
      <xsd:enumeration value="clampToGround"/>
      <xsd:enumeration value="relativeToGround"/>
      <xsd:enumeration value="absolute"/>
    </xsd:restriction>
  </xsd:simpleType>
  <xsd:simpleType name="coordinatesType">
    <xsd:restriction base="xsd:string">
      <xsd:pattern value="\s*${TUPLE}(\s+${TUPLE})*\s*"/>
    </xsd:restriction>
  </xsd:simpleType>
</xsd:schema>
`;
const KML_XSD_PATH = join(dir, 'kml-subset.xsd');
writeFileSync(KML_XSD_PATH, KML_XSD, 'utf8');

// ---------------------------------------------------------------------------------------------
// Synthetic library

/** @returns {Item} */
function wpt(id, overrides = {}) {
  return { kind: 'waypoint', id, name: id, comment: '', symbol: '', lat: 46.5, lon: 7.25, ele: 1500, time: null, ...overrides };
}

/** @returns {Item} */
function trk(id, overrides = {}) {
  return {
    kind: 'track', id, name: id, comment: '', color: null,
    segments: [[{ lat: 46.5, lon: 7.25, ele: 1500, time: 0 }, { lat: 46.51, lon: 7.26, ele: 1510, time: 1000 }]],
    ...overrides,
  };
}

/** @returns {Item} */
function rte(id, overrides = {}) {
  return {
    kind: 'route', id, name: id, comment: '',
    points: [{ lat: 46.5, lon: 7.25, ele: null, name: 'A', symbol: '' }, { lat: 46.6, lon: 7.3, ele: null, name: 'B', symbol: '' }],
    ...overrides,
  };
}

/** @param {string} id @param {string} name @param {string|null} parentId @param {string[]} [itemIds] @returns {Folder} */
const folder = (id, name, parentId = null, itemIds = []) => ({ id, name, type: 'folder', parentId, itemIds });
/** @param {string} id @param {string} name @param {string|null} parentId @param {string[]} [itemIds] @returns {Folder} */
const list = (id, name, parentId = null, itemIds = []) => ({ id, name, type: 'list', parentId, itemIds });

/** @param {Item[]} items @param {Folder[]} folders @returns {Library} */
function library(items, folders) {
  return { items, folders, problems: [], meta: { source: 'synthetic', version: null } };
}

/** @param {{ code: string, count: number }[]} problems */
function counts(problems) {
  return Object.fromEntries(problems.map((p) => [p.code, p.count]));
}

/** @param {string} s */
function unescape(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/**
 * "Folder/Sub/List: Placemark" for every named placemark, read from the writer's output.
 * @param {string} xml
 * @returns {string[]}
 */
function placemarkPaths(xml) {
  /** @type {string[]} */
  const stack = [];
  /** @type {string[]} */
  const out = [];
  let awaiting = /** @type {'folder'|'placemark'|null} */ (null);
  for (const m of xml.matchAll(/<(\/?)(Folder|Placemark)>|<name>([^<]*)<\/name>/g)) {
    if (m[2] === 'Folder') {
      if (m[1]) stack.pop();
      else awaiting = 'folder';
    } else if (m[2] === 'Placemark') {
      awaiting = m[1] ? null : 'placemark';
    } else if (awaiting === 'folder') {
      stack.push(unescape(m[3]));
      awaiting = null;
    } else if (awaiting === 'placemark') {
      out.push(`${stack.join('/')}: ${unescape(m[3])}`);
      awaiting = null;
    }
  }
  return out;
}

/** A library that exercises every branch of the writer. */
function richLibrary() {
  return library(
    [
      wpt('Summit', { comment: `<b>bold</b>\nline 2 & "q"`, lon: 180 }),
      wpt('Hut <A&B>', { ele: null }),
      trk('Ridge', { color: 'red' }),
      trk('Ghost', { color: 'Transparent' }),
      trk('Odd colour', { color: 'Chartreuse' }),
      trk('One point', { segments: [[{ lat: 1, lon: 1, ele: null, time: null }]] }),
      trk('No points', { segments: [] }),
      trk('Bad points', { segments: [[{ lat: NaN, lon: 1, ele: null, time: null }]] }),
      trk('Two segments', {
        color: 'DarkGreen',
        segments: [
          [{ lat: 1, lon: 1, ele: 10, time: null }, { lat: 1.1, lon: 1.1, ele: 11, time: null }],
          [],
          [{ lat: 2, lon: 2, ele: null, time: null }, { lat: 2.1, lon: 2.1, ele: 12, time: null }],
          [{ lat: 3, lon: 3, ele: null, time: null }],
        ],
      }),
      rte('Route', { comment: 'via the lake' }),
      rte('Short route', { points: [{ lat: 5, lon: 5, ele: null, name: '', symbol: '' }] }),
      wpt(`Loose ${cp(0x1f600)} ${ch(1)}end`),
    ],
    [
      folder('f1', 'Hiking'),
      folder('f2', 'Alps & Co', 'f1'),
      list('l1', 'Day 1', 'f2', ['Summit', 'Ridge', 'Ghost', 'Two segments']),
      list('l2', 'Favourites', null, ['Summit', 'Hut <A&B>', 'Route']),
      list('l3', '', 'f1', ['Odd colour', 'One point', 'No points', 'Bad points', 'Short route']),
      folder('f3', 'Empty'),
    ],
  );
}

// ---------------------------------------------------------------------------------------------

describe('KML writer', () => {
  test('a full document is well-formed and valid against the KML 2.2 schema subset', { skip: NO_XMLLINT }, () => {
    const { xml } = writeKml(richLibrary(), { name: 'My library' });
    assertWellFormed(xml);
    assertSchemaValid(xml);
  });

  test('the schema subset really rejects a wrong element order (so the check means something)', { skip: NO_XMLLINT }, () => {
    const { xml } = writeKml(richLibrary());
    const swapped = xml.replace(/(<description>[^<]*<\/description>)(\s*)(<styleUrl>[^<]*<\/styleUrl>)/, '$3$2$1');
    assert.notEqual(swapped, xml);
    assert.throws(() => assertSchemaValid(swapped));
    assert.throws(() => assertSchemaValid(xml.replace('<coordinates>180,', '<coordinates>1e2,')));
  });

  test('folders nest like the BaseCamp tree; an item in two lists appears in both', () => {
    const { xml } = writeKml(richLibrary());
    assert.deepEqual(placemarkPaths(xml), [
      'Hiking/Alps & Co/Day 1: Summit',
      'Hiking/Alps & Co/Day 1: Ridge',
      'Hiking/Alps & Co/Day 1: Ghost',
      'Hiking/Alps & Co/Day 1: Two segments',
      'Hiking/Untitled: Odd colour',
      'Hiking/Untitled: One point',
      'Hiking/Untitled: No points',
      'Hiking/Untitled: Bad points',
      'Hiking/Untitled: Short route',
      'Favourites: Summit',
      'Favourites: Hut <A&B>',
      'Favourites: Route',
      `Unfiled: Loose ${cp(0x1f600)} end`,
    ]);
    assert.match(xml, /<Folder>\n {6}<name>Empty<\/name>\n {4}<\/Folder>/);
  });

  test('names are escaped once; descriptions are HTML-escaped too because viewers render them as HTML', { skip: NO_XMLLINT }, () => {
    const { xml } = writeKml(richLibrary());
    const pm = (/** @type {string} */ name) => `//${el('Placemark')}[${el('name')}="${name}"]`;
    assert.equal(xpathString(xml, `${pm('Hut <A&B>')}/${el('name')}`), 'Hut <A&B>');
    assert.equal(
      xpathString(xml, `${pm('Summit')}/${el('description')}`),
      '&lt;b&gt;bold&lt;/b&gt;<br>line 2 &amp; &quot;q&quot;',
    );
    assert.equal(xpathString(xml, `//${el('Folder')}/${el('name')}[.="Alps & Co"]`), 'Alps & Co');
  });

  test('longitude 180 stays 180 (KML allows it); elevation is the third value', () => {
    const { xml } = writeKml(library([wpt('E', { lon: 180, ele: 12.5 })], []));
    assert.match(xml, /<Point><coordinates>180,46.5,12.5<\/coordinates><\/Point>/);
  });

  test('lines are clamped to the ground; elevations only when every point has one', () => {
    const { xml } = writeKml(richLibrary());
    const ridge = xml.slice(xml.indexOf('<name>Ridge</name>'));
    assert.match(ridge, /<LineString>\s*<tessellate>1<\/tessellate>\s*<altitudeMode>clampToGround<\/altitudeMode>\s*<coordinates>\s*7.25,46.5,1500.0 7.26,46.51,1510.0\s*<\/coordinates>/);
    const route = xml.slice(xml.indexOf('<name>Route</name>'));
    assert.match(route, /<coordinates>\s*7.25,46.5 7.3,46.6\s*<\/coordinates>/);
    const two = xml.slice(xml.indexOf('<name>Two segments</name>'), xml.indexOf('</MultiGeometry>'));
    assert.match(two, /1,1,10.0 1.1,1.1,11.0/);
    assert.match(two, /2,2 2.1,2.1\s/, 'one missing elevation makes that line 2D');
  });

  test('multi-segment tracks become MultiGeometry; one usable point becomes a Point; none, no geometry', () => {
    const { xml, problems } = writeKml(richLibrary());
    const two = xml.slice(xml.indexOf('<name>Two segments</name>'));
    assert.match(two, /^<name>Two segments<\/name>\s*<styleUrl>#track-DarkGreen<\/styleUrl>\s*<MultiGeometry>\s*<LineString>[\s\S]*?<\/LineString>\s*<LineString>[\s\S]*?<\/LineString>\s*<Point><coordinates>3,3<\/coordinates><\/Point>\s*<\/MultiGeometry>/);
    const one = xml.slice(xml.indexOf('<name>One point</name>'));
    assert.match(one, /^<name>One point<\/name>\s*<styleUrl>#track<\/styleUrl>\s*<Point><coordinates>1,1<\/coordinates><\/Point>\s*<\/Placemark>/);
    const none = xml.slice(xml.indexOf('<name>No points</name>'));
    assert.match(none, /^<name>No points<\/name>\s*<styleUrl>#track<\/styleUrl>\s*<\/Placemark>/);
    const c = counts(problems);
    assert.equal(c.kml_single_point_line, 3, 'One point, the last segment of Two segments, Short route');
    assert.equal(c.kml_no_geometry, 2, 'No points and Bad points');
    assert.equal(c.track_point_bad_position, 1);
  });

  test('track colours: known names get a style, Transparent and unknown names use the default', () => {
    const { xml, problems } = writeKml(richLibrary());
    assert.match(xml, /<Style id="track-Red">\s*<LineStyle>\s*<color>ff0000ff<\/color>/);
    assert.match(xml, /<Style id="track-DarkGreen">/);
    assert.equal((xml.match(/<Style id="track-Red">/g) ?? []).length, 1);
    assert.doesNotMatch(xml, /track-Transparent|track-Blue|Chartreuse/);
    assert.match(xml.slice(xml.indexOf('<name>Ghost</name>')), /^<name>Ghost<\/name>\s*<styleUrl>#track<\/styleUrl>/);
    assert.equal(counts(problems).track_color_unknown, 1);
    assert.deepEqual(Object.keys(KML_TRACK_COLORS), GARMIN_COLORS.filter((c) => c !== 'Transparent'));
    for (const value of Object.values(KML_TRACK_COLORS)) assert.match(value, /^ff[0-9a-f]{6}$/);
  });

  test('styles come before folders and the unfiled folder comes last', () => {
    const { xml } = writeKml(richLibrary(), { unfiledName: 'Not in a list' });
    assert.ok(xml.lastIndexOf('</Style>') < xml.indexOf('<Folder>'));
    assert.match(xml, /<Folder>\n {6}<name>Not in a list<\/name>[\s\S]*<\/Folder>\n {2}<\/Document>\n<\/kml>\n$/);
  });

  test('no Unfiled folder when every item is in a list; an empty library is still valid', { skip: NO_XMLLINT }, () => {
    const { xml } = writeKml(library([wpt('a')], [list('l', 'L', null, ['a'])]));
    assert.doesNotMatch(xml, /Unfiled/);
    const empty = writeKml(library([], []));
    assertSchemaValid(empty.xml);
    assert.deepEqual(empty.problems, []);
  });

  test('illegal characters are removed and counted; malformed items skipped and counted', () => {
    const lib = library(/** @type {any[]} */ ([wpt(`a${ch(0xffff)}b`), null, { kind: 'circle', id: 'c' }]), []);
    const { xml, problems } = writeKml(lib);
    assert.match(xml, /<name>ab<\/name>/);
    // The tree reports the item without an id; the writer reports both items it could not draw.
    assert.deepEqual(counts(problems), { item_unidentified: 1, item_malformed: 2, text_illegal_chars: 1 });
    assert.equal(new Set(problems.map((p) => p.code)).size, problems.length, 'each code once');
  });

  test(`a tree nested 300 deep is capped at ${MAX_FOLDER_DEPTH} levels and stays parseable`, { skip: NO_XMLLINT }, () => {
    const folders = Array.from({ length: 300 }, (_, i) => folder(`f${i}`, `L${i}`, i === 0 ? null : `f${i - 1}`));
    folders.push(list('l', 'Bottom', 'f299', ['a']));
    const { xml, problems } = writeKml(library([wpt('a')], folders));
    assertWellFormed(xml); // libxml2 rejects documents nested deeper than 256 elements
    assertSchemaValid(xml);
    assert.equal(counts(problems).folder_depth_flattened, 300 - MAX_FOLDER_DEPTH);
    const deepest = Math.max(...placemarkPaths(xml).map((p) => p.split(': ')[0].split('/').length));
    assert.equal(deepest, MAX_FOLDER_DEPTH + 1);
  });

  test('cycles and missing parents finish and are reported once', { skip: NO_XMLLINT }, () => {
    const lib = library([wpt('a')], [folder('a', 'A', 'b'), folder('b', 'B', 'a'), list('l', 'L', 'a', ['a']), list('o', 'O', 'gone')]);
    const { xml, problems } = writeKml(lib);
    assertSchemaValid(xml);
    assert.deepEqual(counts(problems), { folder_cycle: 1, folder_parent_missing: 1 });
    assert.deepEqual(placemarkPaths(xml), ['B/A/L: a']);
  });

  test('a tree passed in is reused and its repairs are not reported again', () => {
    const lib = library([wpt('a')], [folder('a', 'A', 'a'), list('l', 'L', 'a', ['a'])]);
    const tree = buildFolderTree(lib);
    const reused = writeKml(lib, { tree });
    const fresh = writeKml(lib);
    assert.equal(reused.xml, fresh.xml);
    assert.deepEqual(reused.problems, []);
    assert.deepEqual(counts(fresh.problems), { folder_cycle: 1 });
  });

  test('streaming: chunks stay bounded for long tracks and join to the same document', () => {
    const points = Array.from({ length: 25_000 }, (_, i) => ({ lat: 45 + i * 1e-5, lon: 7, ele: 500, time: null }));
    const lib = library([trk('Long', { segments: [points] })], []);
    const chunks = [...kmlChunks(lib, {}, new Tally(WRITER_MESSAGES))];
    assert.ok(chunks.length >= 25, `${chunks.length} chunks`);
    assert.ok(Math.max(...chunks.map((c) => c.length)) < 100_000);
    assert.equal(chunks.join(''), writeKml(lib).xml);
    assert.throws(() => [...kmlChunks(lib, {}, /** @type {any} */ (null))], TypeError);
  });

  test('10 000 items in 1 000 lists write in well under a second', () => {
    const items = Array.from({ length: 10_000 }, (_, i) => wpt(`i${i}`, { lat: (i % 180) - 89.5, lon: (i % 360) - 179.5 }));
    const folders = Array.from({ length: 1000 }, (_, l) => list(`l${l}`, `List ${l}`, null, items.slice(l * 10, l * 10 + 10).map((i) => i.id)));
    const started = performance.now();
    const { xml, problems } = writeKml(library(items, folders));
    const ms = performance.now() - started;
    assert.ok(ms < 1000, `${ms} ms`);
    assert.equal((xml.match(/<Placemark>/g) ?? []).length, 10_000);
    assert.deepEqual(problems, []);
  });
});

// ---------------------------------------------------------------------------------------------
// Adversarial cases (added by an independent tester). Synthetic data only.

// More seeds for a one-off deep run: BCR_FUZZ_SEEDS=5000 node --test test/kml.test.js
const FUZZ_SEEDS = Number(process.env.BCR_FUZZ_SEEDS) || 40;

/** Deterministic PRNG (mulberry32) so a failing fuzz case can be replayed from its seed. */
function mulberry32(/** @type {number} */ seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Validate many documents with one xmllint run; the error names the files that failed. @param {string[]} docs */
function assertAllSchemaValid(docs) {
  for (let i = 0; i < docs.length; i += 200) assertBatchSchemaValid(docs.slice(i, i + 200), i);
}

/** @param {string[]} docs @param {number} offset */
function assertBatchSchemaValid(docs, offset) {
  const files = docs.map((xml) => tempFile(xml));
  try {
    execFileSync('xmllint', ['--noout', '--nonet', '--schema', KML_XSD_PATH, ...files], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const stderr = String(/** @type {any} */ (error).stderr);
    const failed = files.map((f, i) => (stderr.includes(f) ? offset + i : -1)).filter((i) => i >= 0);
    throw new Error(`documents ${failed.join(', ')} are not schema-valid:\n${stderr.slice(0, 2000)}`);
  }
}

const TEXT_PIECES = [
  'Hut', ' ', '&', '<', '>', '"', "'", ']]>', '<b>', '&amp;', '\r\n', '\r', '\n', '\t', ch(0), ch(0x1f),
  ch(0xfffe), ch(0xd800), ch(0xdc00), cp(0x1f600), 'e' + ch(0x301), '.', '..', 'CON', '/', 'x'.repeat(40),
];
const ODD_NUMBERS = [0, -0, 1e-7, 5e-8, 90, -90, 180, -180, 179.99999999, 90.00000004, 1e25, NaN, Infinity, -Infinity,
  1e-300, '45', null, undefined, {}, 12000, -12000, 100000.01];
const COLOURS = [...GARMIN_COLORS, 'red', 'TRANSPARENT', 'Chartreuse', '', null, 42];

/**
 * A hostile library: odd text and numbers, bad points, and a folder tree with loops, missing
 * parents, lists in lists and items mentioned many times.
 * @param {() => number} rand
 * @returns {Library}
 */
function randomLibrary(rand) {
  const pick = (/** @type {readonly any[]} */ arr) => arr[Math.floor(rand() * arr.length)];
  const count = (/** @type {number} */ n) => Math.floor(rand() * n);
  const text = () => {
    if (rand() < 0.05) return pick([null, undefined, 42]);
    let s = '';
    for (let i = count(5); i > 0; i--) s += pick(TEXT_PIECES);
    return s;
  };
  const num = (/** @type {number} */ lo, /** @type {number} */ hi) => (rand() < 0.15 ? pick(ODD_NUMBERS) : lo + rand() * (hi - lo));
  const point = () => ({ lat: num(-90, 90), lon: num(-180, 180), ele: rand() < 0.3 ? null : num(-500, 9000), time: null });
  const itemCount = count(30);
  /** @type {any[]} */
  const items = [];
  for (let i = 0; i < itemCount; i++) {
    const id = rand() < 0.05 ? undefined : `i${count(itemCount + 2)}`;
    const r = rand();
    if (r < 0.04) items.push(pick([null, 7, { kind: 'circle', id }]));
    else if (r < 0.4) items.push({ kind: 'waypoint', id, name: text(), comment: text(), symbol: '', ...point() });
    else if (r < 0.7) {
      const points = Array.from({ length: count(5) }, () => (rand() < 0.05 ? null : { ...point(), name: text(), symbol: '' }));
      items.push({ kind: 'route', id, name: text(), comment: text(), points });
    } else {
      const segments = Array.from({ length: count(4) }, () => (rand() < 0.05 ? 'junk' : Array.from({ length: count(5) }, point)));
      items.push({ kind: 'track', id, name: text(), comment: text(), color: pick(COLOURS), segments });
    }
  }
  const folderCount = count(25);
  /** @type {any[]} */
  const folders = [];
  for (let i = 0; i < folderCount; i++) {
    const r = rand();
    const parentId = r < 0.3 ? null : r < 0.95 ? `f${count(folderCount + 2)}` : 5;
    const itemIds = Array.from({ length: count(6) }, () => `i${count(itemCount + 2)}`);
    folders.push({ id: `f${rand() < 0.9 ? i : count(folderCount)}`, name: text(), type: rand() < 0.5 ? 'folder' : 'list', parentId, itemIds });
  }
  return library(items, folders);
}

const usable = (/** @type {any} */ p) =>
  p !== null && typeof p === 'object' && typeof p.lat === 'number' && p.lat >= -90 && p.lat <= 90 &&
  typeof p.lon === 'number' && p.lon >= -180 && p.lon <= 180;

/**
 * Independent prediction of the KML for a library: one Placemark per mention of a drawable item
 * (a waypoint needs a usable position; tracks and routes always get one), plus the geometry counts.
 * @param {Library} lib
 */
function expectedKml(lib) {
  const tree = buildFolderTree(lib);
  const mentions = [...tree.nodes.flatMap((n) => n.items), ...tree.unfiled];
  const c = { placemarks: 0, kml_no_geometry: 0, kml_single_point_line: 0 };
  for (const it of /** @type {any[]} */ (mentions)) {
    if (it === null || typeof it !== 'object' || !['waypoint', 'track', 'route'].includes(it.kind)) continue;
    if (it.kind === 'waypoint') {
      if (usable(it)) c.placemarks++;
      continue;
    }
    c.placemarks++;
    const lines = it.kind === 'route'
      ? [Array.isArray(it.points) ? it.points : []]
      : (Array.isArray(it.segments) ? it.segments : []).filter((s) => Array.isArray(s) && s.length > 0);
    let total = 0;
    for (const line of lines) {
      const n = line.filter(usable).length;
      if (n === 1) c.kml_single_point_line++;
      total += n;
    }
    if (total === 0) c.kml_no_geometry++;
  }
  return c;
}

describe('adversarial: KML', () => {
  test('fuzz: hostile libraries always give a schema-valid KML whose placemarks and counts match the input', { skip: NO_XMLLINT }, () => {
    const docs = [];
    for (let seed = 1; seed <= FUZZ_SEEDS; seed++) {
      const lib = randomLibrary(mulberry32(seed));
      const { xml, problems } = writeKml(lib, { name: 'fuzz' });
      const want = expectedKml(lib);
      const got = counts(problems);
      assert.equal((xml.match(/<Placemark>/g) ?? []).length, want.placemarks, `seed ${seed}: placemarks`);
      assert.equal(got.kml_no_geometry ?? 0, want.kml_no_geometry, `seed ${seed}: kml_no_geometry`);
      assert.equal(got.kml_single_point_line ?? 0, want.kml_single_point_line, `seed ${seed}: kml_single_point_line`);
      assert.doesNotMatch(xml, /NaN|Infinity|undefined|\[object/, `seed ${seed}`);
      docs.push(xml);
    }
    assertAllSchemaValid(docs);
  });
});

describe('adversarial: KML streaming', () => {
  test('a track whose segments have no usable point gets no empty MultiGeometry', () => {
    const bad = { lat: NaN, lon: 1, ele: null, time: null };
    const { xml, problems } = writeKml(library([trk('Lost', { segments: [[bad], [bad, bad]] })], []));
    assert.doesNotMatch(xml, /MultiGeometry/);
    assert.match(xml.slice(xml.indexOf('<name>Lost</name>')), /^<name>Lost<\/name>\s*<styleUrl>#track<\/styleUrl>\s*<\/Placemark>/);
    assert.deepEqual(counts(problems), { track_point_bad_position: 3, kml_no_geometry: 1 });
  });

  test('a 1 000 000-point track streams without holding its coordinates in memory', () => {
    // The input itself is large; the writer must not add a second copy of it as coordinate objects.
    const n = 1_000_000;
    const points = Array.from({ length: n }, (_, i) => ({ lat: 45 + i * 1e-7, lon: 7 + i * 1e-7, ele: 500, time: null }));
    const lib = library([trk('Huge', { segments: [points] })], []);
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    let chunks = 0;
    let longest = 0;
    const started = performance.now();
    for (const chunk of kmlChunks(lib, {}, new Tally(WRITER_MESSAGES))) {
      longest = Math.max(longest, chunk.length);
      if (++chunks % 50 === 0) peak = Math.max(peak, process.memoryUsage().heapUsed);
    }
    const ms = performance.now() - started;
    assert.ok(chunks >= n / 1000, `${chunks} chunks`);
    assert.ok(longest < 100_000, `longest chunk ${longest}`);
    assert.ok(peak - before < 100e6, `heap grew by ${Math.round((peak - before) / 1e6)} MB`);
    assert.ok(ms < 5000, `${ms} ms`);
  });
});
