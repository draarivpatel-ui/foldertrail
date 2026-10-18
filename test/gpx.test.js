// Tests for src/export/xml.js (escaping, number and time formatting) and src/export/gpx.js.
// All data is synthetic. Well-formedness and element order are checked with the system xmllint
// against a subset of the GPX 1.1 schema written out below.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_TIME_MS,
  MIN_TIME_MS,
  Tally,
  WRITER_MESSAGES,
  escapeAttr,
  escapeText,
  formatEle,
  formatGpxLon,
  formatHeartRate,
  formatLat,
  formatLon,
  formatTemperature,
  formatTime,
  stripIllegalXmlChars,
  textOf,
} from '../src/export/xml.js';
import {
  GARMIN_COLORS,
  GPXTPX_NS,
  GPXTPX_XSD,
  fastEle,
  fastGpxLon,
  fastLat,
  fastLon,
  fastTime,
  garminColor,
  gpxChunks,
  writeGpx,
  writeItemGpx,
} from '../src/export/gpx.js';

// Special characters are built from code points so the source stays plain ASCII and unambiguous.
const ch = (/** @type {number[]} */ ...cps) => String.fromCharCode(...cps);
const cp = (/** @type {number[]} */ ...cps) => String.fromCodePoint(...cps);
const HIGH = ch(0xd83d); // a lone high surrogate
const LOW = ch(0xde00); // a lone low surrogate
const SMILE = cp(0x1f600); // a valid surrogate pair

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

const dir = mkdtempSync(join(tmpdir(), 'bcr-gpx-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let fileCounter = 0;

/** @param {string} xml */
function tempFile(xml, ext = '.gpx') {
  const path = join(dir, `f${++fileCounter}${ext}`);
  writeFileSync(path, xml, 'utf8');
  return path;
}

/** Throws (with xmllint's message) unless the document is well-formed. @param {string} xml */
function assertWellFormed(xml) {
  execFileSync('xmllint', ['--noout', '--nonet', tempFile(xml)], { stdio: ['ignore', 'pipe', 'pipe'] });
}

/** @param {string} xml */
function assertSchemaValid(xml) {
  execFileSync('xmllint', ['--noout', '--nonet', '--schema', GPX_XSD_PATH, tempFile(xml)], {
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

/** XPath step for a GPX element regardless of namespace prefix. @param {string} name */
const el = (name) => `*[local-name()="${name}"]`;

// A subset of the GPX 1.1 schema (http://www.topografix.com/GPX/1/1/gpx.xsd), transcribed from its
// sequences: only the elements this writer produces, in the schema's order, with the schema's
// lat/lon ranges (longitude is maxExclusive 180). Elements the writer never emits are left out,
// which makes the subset stricter, not looser. The Garmin part is from GpxExtensionsv3.xsd.
const GPXX_XSD = `<?xml version="1.0" encoding="UTF-8"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  targetNamespace="http://www.garmin.com/xmlschemas/GpxExtensions/v3" elementFormDefault="qualified">
  <xsd:element name="TrackExtension">
    <xsd:complexType>
      <xsd:sequence>
        <xsd:element name="DisplayColor" minOccurs="0">
          <xsd:simpleType>
            <xsd:restriction base="xsd:token">
              ${GARMIN_COLORS.map((c) => `<xsd:enumeration value="${c}"/>`).join('\n              ')}
            </xsd:restriction>
          </xsd:simpleType>
        </xsd:element>
      </xsd:sequence>
    </xsd:complexType>
  </xsd:element>
</xsd:schema>
`;

// The part of Garmin's TrackPointExtension v2 this writer produces (B44), transcribed from
// www8.garmin.com/xmlschemas/TrackPointExtensionv2.xsd as published (read 2026-10-07): the element, the start of
// TrackPointExtension_t's sequence (atemp, wtemp, depth, hr) and the two simple types with their restrictions.
const GPXTPX_SUBSET_XSD = `<?xml version="1.0" encoding="UTF-8"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns="http://www.garmin.com/xmlschemas/TrackPointExtension/v2"
  targetNamespace="http://www.garmin.com/xmlschemas/TrackPointExtension/v2" elementFormDefault="qualified">
  <xsd:element name="TrackPointExtension" type="TrackPointExtension_t"/>
  <xsd:complexType name="TrackPointExtension_t">
    <xsd:sequence>
      <xsd:element name="atemp" type="DegreesCelsius_t" minOccurs="0"/>
      <xsd:element name="wtemp" type="DegreesCelsius_t" minOccurs="0"/>
      <xsd:element name="depth" type="xsd:double" minOccurs="0"/>
      <xsd:element name="hr" type="BeatsPerMinute_t" minOccurs="0"/>
    </xsd:sequence>
  </xsd:complexType>
  <xsd:simpleType name="DegreesCelsius_t">
    <xsd:restriction base="xsd:double"/>
  </xsd:simpleType>
  <xsd:simpleType name="BeatsPerMinute_t">
    <xsd:restriction base="xsd:unsignedByte">
      <xsd:minInclusive value="1"/>
    </xsd:restriction>
  </xsd:simpleType>
</xsd:schema>
`;

const GPX_XSD = `<?xml version="1.0" encoding="UTF-8"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns="http://www.topografix.com/GPX/1/1"
  targetNamespace="http://www.topografix.com/GPX/1/1" elementFormDefault="qualified">
  <xsd:import namespace="http://www.garmin.com/xmlschemas/GpxExtensions/v3" schemaLocation="gpxx-subset.xsd"/>
  <xsd:import namespace="http://www.garmin.com/xmlschemas/TrackPointExtension/v2" schemaLocation="gpxtpx-subset.xsd"/>
  <xsd:element name="gpx" type="gpxType"/>
  <xsd:complexType name="gpxType">
    <xsd:sequence>
      <xsd:element name="metadata" type="metadataType" minOccurs="0"/>
      <xsd:element name="wpt" type="wptType" minOccurs="0" maxOccurs="unbounded"/>
      <xsd:element name="rte" type="rteType" minOccurs="0" maxOccurs="unbounded"/>
      <xsd:element name="trk" type="trkType" minOccurs="0" maxOccurs="unbounded"/>
    </xsd:sequence>
    <xsd:attribute name="version" type="xsd:string" use="required" fixed="1.1"/>
    <xsd:attribute name="creator" type="xsd:string" use="required"/>
  </xsd:complexType>
  <xsd:complexType name="metadataType">
    <xsd:sequence>
      <xsd:element name="name" type="xsd:string" minOccurs="0"/>
      <xsd:element name="desc" type="xsd:string" minOccurs="0"/>
      <xsd:element name="time" type="xsd:dateTime" minOccurs="0"/>
    </xsd:sequence>
  </xsd:complexType>
  <xsd:complexType name="wptType">
    <xsd:sequence>
      <xsd:element name="ele" type="xsd:decimal" minOccurs="0"/>
      <xsd:element name="time" type="xsd:dateTime" minOccurs="0"/>
      <xsd:element name="name" type="xsd:string" minOccurs="0"/>
      <xsd:element name="cmt" type="xsd:string" minOccurs="0"/>
      <xsd:element name="sym" type="xsd:string" minOccurs="0"/>
      <xsd:element name="extensions" type="extensionsType" minOccurs="0"/>
    </xsd:sequence>
    <xsd:attribute name="lat" type="latitudeType" use="required"/>
    <xsd:attribute name="lon" type="longitudeType" use="required"/>
  </xsd:complexType>
  <xsd:complexType name="rteType">
    <xsd:sequence>
      <xsd:element name="name" type="xsd:string" minOccurs="0"/>
      <xsd:element name="cmt" type="xsd:string" minOccurs="0"/>
      <xsd:element name="rtept" type="wptType" minOccurs="0" maxOccurs="unbounded"/>
    </xsd:sequence>
  </xsd:complexType>
  <xsd:complexType name="trkType">
    <xsd:sequence>
      <xsd:element name="name" type="xsd:string" minOccurs="0"/>
      <xsd:element name="cmt" type="xsd:string" minOccurs="0"/>
      <xsd:element name="extensions" type="extensionsType" minOccurs="0"/>
      <xsd:element name="trkseg" type="trksegType" minOccurs="0" maxOccurs="unbounded"/>
    </xsd:sequence>
  </xsd:complexType>
  <xsd:complexType name="trksegType">
    <xsd:sequence>
      <xsd:element name="trkpt" type="wptType" minOccurs="0" maxOccurs="unbounded"/>
    </xsd:sequence>
  </xsd:complexType>
  <xsd:complexType name="extensionsType">
    <xsd:sequence>
      <xsd:any namespace="##other" processContents="lax" minOccurs="0" maxOccurs="unbounded"/>
    </xsd:sequence>
  </xsd:complexType>
  <xsd:simpleType name="latitudeType">
    <xsd:restriction base="xsd:decimal">
      <xsd:minInclusive value="-90.0"/>
      <xsd:maxInclusive value="90.0"/>
    </xsd:restriction>
  </xsd:simpleType>
  <xsd:simpleType name="longitudeType">
    <xsd:restriction base="xsd:decimal">
      <xsd:minInclusive value="-180.0"/>
      <xsd:maxExclusive value="180.0"/>
    </xsd:restriction>
  </xsd:simpleType>
</xsd:schema>
`;

writeFileSync(join(dir, 'gpxx-subset.xsd'), GPXX_XSD, 'utf8');
writeFileSync(join(dir, 'gpxtpx-subset.xsd'), GPXTPX_SUBSET_XSD, 'utf8');
const GPX_XSD_PATH = join(dir, 'gpx-subset.xsd');
writeFileSync(GPX_XSD_PATH, GPX_XSD, 'utf8');

// ---------------------------------------------------------------------------------------------
// Synthetic items

/** @returns {import('../src/model.js').Waypoint} */
function waypoint(overrides = {}) {
  return {
    kind: 'waypoint', id: 'w1', name: 'Spring', comment: '', symbol: 'Flag, Blue',
    lat: 46.5, lon: 7.25, ele: 1500, time: Date.UTC(2023, 6, 1, 8, 30), ...overrides,
  };
}

/** @returns {import('../src/model.js').Track} */
function track(overrides = {}) {
  const t0 = Date.UTC(2023, 6, 1, 9);
  return {
    kind: 'track', id: 't1', name: 'Ridge walk', comment: 'windy', color: null,
    segments: [[
      { lat: 46.5, lon: 7.25, ele: 1500, time: t0 },
      { lat: 46.501, lon: 7.251, ele: 1510.25, time: t0 + 60000 },
    ]],
    ...overrides,
  };
}

/** @returns {import('../src/model.js').Route} */
function route(overrides = {}) {
  return {
    kind: 'route', id: 'r1', name: 'To the hut', comment: '',
    points: [
      { lat: 46.5, lon: 7.25, ele: null, name: 'Start', symbol: 'Flag, Green' },
      { lat: 46.6, lon: 7.3, ele: 2000, name: '', symbol: '' },
    ],
    ...overrides,
  };
}

const OPTS = { creator: 'BCR test suite' };

/** The child element names of the first element matching `tag`, in document order. */
function childTags(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[ >][\\s\\S]*?</${tag}>`));
  assert.ok(m, `no <${tag}> found`);
  const inner = m[0].replace(/^<[^>]*>/, '');
  return [...inner.matchAll(/<([A-Za-z:]+)[ >/]/g)].map((x) => x[1]);
}

// ---------------------------------------------------------------------------------------------

describe('xml escaping', () => {
  test('text escapes &, < and > and leaves quotes alone', () => {
    assert.equal(escapeText('a & b < c > d "e" \'f\''), 'a &amp; b &lt; c &gt; d "e" \'f\'');
    assert.equal(escapeText(']]>'), ']]&gt;');
  });

  test('attributes also escape quotes and keep tab, LF and CR as character references', () => {
    assert.equal(escapeAttr(`a"b'c<d>&`), 'a&quot;b&apos;c&lt;d&gt;&amp;');
    assert.equal(escapeAttr('x\ty\nz\rw'), 'x&#9;y&#10;z&#13;w');
  });

  test('text normalizes CR LF and lone CR to LF', () => {
    assert.equal(escapeText('a\r\nb\rc\nd'), 'a\nb\nc\nd');
  });

  test('characters illegal in XML 1.0 are removed, legal ones kept', () => {
    const c0 = Array.from({ length: 32 }, (_, i) => ch(i)).join('');
    assert.equal(stripIllegalXmlChars(c0), '\t\n\r');
    assert.equal(stripIllegalXmlChars(`a${ch(0xfffe)}b${ch(0xffff)}c`), 'abc');
    assert.equal(stripIllegalXmlChars(`a${HIGH}b${LOW}c`), 'abc');
    assert.equal(stripIllegalXmlChars(`${LOW}${HIGH}`), '', 'reversed pair is two lone surrogates');
    assert.equal(stripIllegalXmlChars(`x${SMILE}y`), `x${SMILE}y`, 'a valid pair survives');
    const legal = `${ch(0x7f)}${ch(0x85)}${ch(0xfffd)}${ch(0xe000)}${cp(0x10ffff)}${ch(0xd7ff)}`;
    assert.equal(stripIllegalXmlChars(legal), legal);
  });

  test('escaping counts each string that lost characters', () => {
    const tally = new Tally(WRITER_MESSAGES);
    escapeText(`a${ch(1)}${ch(2)}`, tally);
    escapeAttr(`b${HIGH}`, tally);
    escapeText('clean', tally);
    assert.equal(tally.get('text_illegal_chars'), 2);
  });

  test('textOf turns non-strings into text without inventing content', () => {
    assert.equal(textOf(null), '');
    assert.equal(textOf(undefined), '');
    assert.equal(textOf({ a: 1 }), '');
    assert.equal(textOf(5), '5');
    assert.equal(escapeText(null), '');
  });
});

describe('number and time formatting', () => {
  test('latitude: range edges, -0, tiny and huge values, non-numbers', () => {
    assert.equal(formatLat(90), '90');
    assert.equal(formatLat(-90), '-90');
    assert.equal(formatLat(90.0000001), null);
    assert.equal(formatLat(-90.0000001), null);
    assert.equal(formatLat(0), '0');
    assert.equal(formatLat(-0), '0');
    assert.equal(formatLat(-1e-10), '0', 'rounds to zero without a bare minus sign');
    assert.equal(formatLat(1e-7), '0.0000001');
    assert.equal(formatLat(Number.MIN_VALUE), '0');
    assert.equal(formatLat(12.3456789012), '12.3456789');
    assert.equal(formatLat(-45.1), '-45.1');
    for (const bad of [NaN, Infinity, -Infinity, 1e300, -1e300, null, undefined, '45', {}, true]) {
      assert.equal(formatLat(bad), null, String(bad));
    }
  });

  test('longitude: inclusive 180 for KML, wrapped to -180 for GPX (also after rounding)', () => {
    assert.equal(formatLon(180), '180');
    assert.equal(formatLon(-180), '-180');
    assert.equal(formatLon(180.0000001), null);
    assert.equal(formatLon(-180.0000001), null);
    assert.equal(formatGpxLon(180), '-180');
    assert.equal(formatGpxLon(179.99999999), '-180');
    assert.equal(formatGpxLon(179.9999999), '179.9999999');
    assert.equal(formatGpxLon(-180), '-180');
    assert.equal(formatGpxLon(-0), '0');
    assert.equal(formatGpxLon(NaN), null);
  });

  test('no exponent notation for any accepted coordinate', () => {
    const values = [1e-7, 5e-8, 1e-20, -1e-20, 89.99999999999, 179.123456789, 1e-300, 0.1 + 0.2];
    for (const v of values) {
      assert.doesNotMatch(String(formatLat(Math.min(v, 90))), /e/i);
      assert.doesNotMatch(String(formatLon(v)), /e/i);
    }
  });

  test('elevation: one or two decimals, sanity bounds reject sentinels', () => {
    assert.equal(formatEle(0), '0.0');
    assert.equal(formatEle(-0), '0.0');
    assert.equal(formatEle(-0.001), '0.0');
    assert.equal(formatEle(123), '123.0');
    assert.equal(formatEle(123.4), '123.4');
    assert.equal(formatEle(123.456), '123.46');
    assert.equal(formatEle(-12000), '-12000.0');
    assert.equal(formatEle(100000), '100000.0');
    for (const bad of [1e25, -12000.01, 100000.01, NaN, Infinity, -Infinity, '12', null]) {
      assert.equal(formatEle(bad), null, String(bad));
    }
  });

  test('time: whole seconds without milliseconds, milliseconds only when non-zero', () => {
    assert.equal(formatTime(0), '1970-01-01T00:00:00Z');
    assert.equal(formatTime(Date.UTC(2024, 1, 29, 23, 59, 59)), '2024-02-29T23:59:59Z');
    assert.equal(formatTime(Date.UTC(2024, 4, 1, 12, 0, 0, 250)), '2024-05-01T12:00:00.250Z');
    assert.equal(formatTime(1.4), '1970-01-01T00:00:00.001Z', 'fractional ms are rounded');
    assert.equal(formatTime(-1000), '1969-12-31T23:59:59Z');
    assert.equal(formatTime(-0), '1970-01-01T00:00:00Z');
  });

  test('time: only years 0001..9999 (four digits, no year zero)', () => {
    assert.equal(formatTime(MIN_TIME_MS), '0001-01-01T00:00:00Z');
    assert.equal(formatTime(MAX_TIME_MS), '9999-12-31T23:59:59.999Z');
    for (const bad of [MIN_TIME_MS - 1, MAX_TIME_MS + 1, 8.64e15, -8.64e15, NaN, Infinity, null, '0']) {
      assert.equal(formatTime(bad), null, String(bad));
    }
  });
});

describe('Tally', () => {
  test('unknown codes throw so a typo cannot drop a count', () => {
    const tally = new Tally(WRITER_MESSAGES);
    assert.throws(() => tally.add('no_such_code'), /unknown problem code/);
    assert.throws(() => tally.add('time_invalid', -1), RangeError);
  });

  test('problems carry code, plain message and count', () => {
    const tally = new Tally(WRITER_MESSAGES);
    tally.add('time_invalid');
    tally.add('time_invalid', 2);
    tally.add('elevation_invalid', 0);
    assert.deepEqual(tally.toProblems(), [
      { code: 'time_invalid', message: WRITER_MESSAGES.time_invalid, count: 3 },
    ]);
  });

  test('messages never contain digits that could be a coordinate', () => {
    for (const message of Object.values(WRITER_MESSAGES)) assert.doesNotMatch(message, /\d/);
  });
});

describe('GPX writer', () => {
  test('a full document is well-formed and valid against the GPX 1.1 schema subset', { skip: NO_XMLLINT }, () => {
    const items = [
      track({ color: 'DarkBlue', segments: [[{ lat: 1, lon: 2, ele: null, time: null }], []] }),
      waypoint({ name: `Hut <A&B> "x" ${SMILE}`, comment: `line 1\r\nline 2${ch(0)}`, lon: 180 }),
      route(),
      waypoint({ id: 'w2', name: '', comment: '', symbol: '', ele: null, time: null }),
      track({ id: 't2', color: null, name: '' }),
    ];
    const { xml, problems } = writeGpx(items, { ...OPTS, name: 'All items', desc: 'Synthetic', time: 0 });
    assertWellFormed(xml);
    assertSchemaValid(xml);
    assert.deepEqual(problems.map((p) => p.code), ['text_illegal_chars']);
  });

  test('each file kind validates: waypoint only, route only, track with every colour', { skip: NO_XMLLINT }, () => {
    assertSchemaValid(writeGpx([waypoint()], OPTS).xml);
    assertSchemaValid(writeGpx([route()], OPTS).xml);
    assertSchemaValid(writeGpx([], OPTS).xml);
    const tracks = GARMIN_COLORS.map((c, i) => track({ id: `t${i}`, color: c }));
    assertSchemaValid(writeGpx(tracks, OPTS).xml);
  });

  test('the schema subset really rejects wrong order and lon="180" (so the checks above mean something)', { skip: NO_XMLLINT }, () => {
    const good = writeGpx([waypoint()], OPTS).xml;
    assertSchemaValid(good);
    const swapped = good.replace(/(<ele>[^<]*<\/ele>)(\s*)(<time>[^<]*<\/time>)/, '$3$2$1');
    assert.notEqual(swapped, good);
    assert.throws(() => assertSchemaValid(swapped));
    assert.throws(() => assertSchemaValid(good.replace('lon="7.25"', 'lon="180"')));
    assert.throws(() => assertSchemaValid(writeGpx([track({ color: 'Red' })], OPTS).xml.replace('>Red<', '>Purple<')));
  });

  test('wpt children follow schema order: ele, time, name, cmt, sym', () => {
    const { xml } = writeGpx([waypoint({ comment: 'c' })], OPTS);
    assert.deepEqual(childTags(xml, 'wpt'), ['ele', 'time', 'name', 'cmt', 'sym']);
  });

  test('rte and trk children follow schema order (extensions before trkseg)', () => {
    const rte = writeGpx([route({ comment: 'c' })], OPTS).xml;
    assert.deepEqual(childTags(rte, 'rte').slice(0, 3), ['name', 'cmt', 'rtept']);
    assert.deepEqual(childTags(rte, 'rtept'), ['name', 'sym']);
    const trk = writeGpx([track({ color: 'Red' })], OPTS).xml;
    assert.deepEqual(childTags(trk, 'trk').slice(0, 5), ['name', 'cmt', 'extensions', 'gpxx:TrackExtension', 'gpxx:DisplayColor']);
    assert.ok(trk.indexOf('</extensions>') < trk.indexOf('<trkseg>'));
    assert.deepEqual(childTags(trk, 'trkpt'), ['ele', 'time']);
  });

  test('all waypoints come before routes before tracks, keeping order within each kind', () => {
    const items = [track({ name: 'T1' }), route({ name: 'R1' }), waypoint({ name: 'W1' }), track({ name: 'T2' }), waypoint({ name: 'W2' })];
    const { xml } = writeGpx(items, OPTS);
    const order = [...xml.matchAll(/<(wpt|rte|trk)[ >][\s\S]*?<name>(\w+)<\/name>/g)].map((m) => m[2]);
    assert.deepEqual(order, ['W1', 'W2', 'R1', 'T1', 'T2']);
  });

  test('escaped text reads back exactly (illegal characters removed)', { skip: NO_XMLLINT }, () => {
    const name = `A & B <c> "d" 'e' ${SMILE} ]]> ${ch(0x1b)}end`;
    const { xml } = writeGpx([waypoint({ name })], { creator: `me & "you" <x>${ch(9)}` });
    assert.equal(xpathString(xml, `//${el('wpt')}/${el('name')}`), name.replace(ch(0x1b), ''));
    assert.equal(xpathString(xml, `/${el('gpx')}/@creator`), `me & "you" <x>${ch(9)}`);
  });

  test('longitude +180 is written as -180 (GPX range is -180 <= lon < 180)', () => {
    const { xml } = writeGpx([waypoint({ lon: 180 }), waypoint({ lon: 179.999999999 })], OPTS);
    assert.equal((xml.match(/lon="-180"/g) ?? []).length, 2);
  });

  test('unusable positions drop the point; unusable ele/time drop only that element; all counted', () => {
    const items = [
      waypoint({ lat: NaN }),
      waypoint({ lat: 91 }),
      waypoint({ lon: Infinity }),
      waypoint({ lat: null }),
      waypoint({ id: 'ok', name: 'kept', ele: 1e25, time: 1e20 }),
      track({ segments: [[{ lat: 1, lon: 1, ele: null, time: null }, { lat: -91, lon: 1, ele: 0, time: 0 }]] }),
      route({ points: [{ lat: 1, lon: 'x', ele: null, name: '', symbol: '' }] }),
    ];
    const { xml, problems } = writeGpx(items, OPTS);
    const counts = Object.fromEntries(problems.map((p) => [p.code, p.count]));
    assert.deepEqual(counts, {
      waypoint_bad_position: 4,
      elevation_invalid: 1,
      time_invalid: 1,
      track_point_bad_position: 1,
      route_point_bad_position: 1,
    });
    assert.equal((xml.match(/<wpt /g) ?? []).length, 1);
    assert.match(xml, /<wpt lat="46.5" lon="7.25">\n {4}<name>kept<\/name>/);
    assert.doesNotMatch(xml, /NaN|Infinity|e\+|undefined|null/);
  });

  test('absent elevation and time (null) are not counted as problems', () => {
    const { problems } = writeGpx([waypoint({ ele: null, time: null })], OPTS);
    assert.deepEqual(problems, []);
  });

  test('Garmin colour: canonical spelling, namespace only when used, unknown colours counted', () => {
    const plain = writeGpx([track(), waypoint()], OPTS);
    assert.doesNotMatch(plain.xml, /gpxx|garmin/i);

    const coloured = writeGpx([track({ color: ' darkred ' })], OPTS);
    assert.match(coloured.xml, /xmlns:gpxx="http:\/\/www.garmin.com\/xmlschemas\/GpxExtensions\/v3"/);
    assert.match(coloured.xml, /<gpxx:DisplayColor>DarkRed<\/gpxx:DisplayColor>/);

    const unknown = writeGpx([track({ color: 'Chartreuse' }), track({ color: '' })], OPTS);
    assert.doesNotMatch(unknown.xml, /gpxx/);
    assert.deepEqual(unknown.problems.map((p) => [p.code, p.count]), [['track_color_unknown', 1]]);

    assert.equal(garminColor('TRANSPARENT'), 'Transparent');
    assert.equal(garminColor(42), null);
  });

  test('empty segments stay as empty trkseg elements', () => {
    const { xml } = writeGpx([track({ segments: [[], []] })], OPTS);
    assert.equal((xml.match(/<trkseg>/g) ?? []).length, 2);
  });

  test('malformed items are skipped and counted once', () => {
    const items = /** @type {any[]} */ ([null, 7, { kind: 'polygon' }, waypoint()]);
    const { xml, problems } = writeGpx(items, OPTS);
    assert.deepEqual(problems.map((p) => [p.code, p.count]), [['item_malformed', 3]]);
    assert.equal((xml.match(/<wpt /g) ?? []).length, 1);
  });

  test('metadata holds name, desc and time in schema order, and is omitted when empty', () => {
    const { xml } = writeGpx([], { ...OPTS, name: 'List & co', desc: 'd', time: Date.UTC(2026, 0, 2) });
    assert.match(xml, /<metadata>\n {4}<name>List &amp; co<\/name>\n {4}<desc>d<\/desc>\n {4}<time>2026-01-02T00:00:00Z<\/time>\n {2}<\/metadata>/);
    assert.doesNotMatch(writeGpx([], OPTS).xml, /metadata/);
  });

  test('creator is required', () => {
    assert.throws(() => writeGpx([], /** @type {any} */ ({})), TypeError);
    assert.throws(() => writeGpx([], { creator: '  ' }), TypeError);
    assert.throws(() => writeGpx(/** @type {any} */ ('nope'), OPTS), TypeError);
  });

  test('one item per file: the title defaults to the item name', () => {
    const { xml } = writeItemGpx(track({ name: 'Solo' }), OPTS);
    assert.match(xml, /<metadata>\n {4}<name>Solo<\/name>/);
    assert.equal((xml.match(/<trk>/g) ?? []).length, 1);
    assert.match(writeItemGpx(track(), { ...OPTS, name: 'Other' }).xml, /<name>Other<\/name>/);
  });

  test('streaming: chunks stay bounded for long tracks and join to the same document', () => {
    const points = Array.from({ length: 25_000 }, (_, i) => ({ lat: 45 + i * 1e-5, lon: 7, ele: 500 + (i % 100), time: i * 1000 }));
    const items = [track({ segments: [points] })];
    const tally = new Tally(WRITER_MESSAGES);
    const chunks = [...gpxChunks(items, OPTS, tally)];
    const longest = Math.max(...chunks.map((c) => c.length));
    assert.ok(chunks.length >= 25, `expected the track in several chunks, got ${chunks.length}`);
    assert.ok(longest < 200_000, `longest chunk ${longest} characters`);
    assert.equal(chunks.join(''), writeGpx(items, OPTS).xml);
    assert.equal((chunks.join('').match(/<trkpt /g) ?? []).length, 25_000);
  });

  test('gpxChunks requires a Tally so counts cannot be lost', () => {
    assert.throws(() => [...gpxChunks([], OPTS, /** @type {any} */ (undefined))], TypeError);
  });
});

// ---------------------------------------------------------------------------------------------
// Adversarial cases (added by an independent tester). Synthetic data only.

// More seeds for a one-off deep run: BCR_FUZZ_SEEDS=5000 node --test test/gpx.test.js
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
    execFileSync('xmllint', ['--noout', '--nonet', '--schema', GPX_XSD_PATH, ...files], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const stderr = String(/** @type {any} */ (error).stderr);
    const failed = files.map((f, i) => (stderr.includes(f) ? offset + i : -1)).filter((i) => i >= 0);
    throw new Error(`documents ${failed.join(', ')} are not schema-valid:\n${stderr.slice(0, 2000)}`);
  }
}

const TEXT_PIECES = [
  'Hut', ' ', '&', '<', '>', '"', "'", ']]>', '<![CDATA[', '&amp;', '&#0;', '\r\n', '\r', '\n', '\t',
  ch(0), ch(1), ch(0x1f), ch(0x7f), ch(0x85), ch(0x2028), ch(0xfffe), ch(0xffff), ch(0xfffd), HIGH, LOW,
  SMILE, cp(0x10ffff), 'e' + ch(0x301), '--', '?>', '<?xml', 'x'.repeat(50),
];

const ODD_NUMBERS = [
  0, -0, 1e-7, 5e-8, -5e-8, 90, -90, 180, -180, 179.99999999, -179.99999996, 90.00000004, 1e25, -1e25, NaN,
  Infinity, -Infinity, 1e-300, Number.MAX_VALUE, Number.MIN_VALUE, '45', null, undefined, true, {}, [],
  12000, -12000, 100000, 100000.01, 8.64e15, MIN_TIME_MS, MAX_TIME_MS, MAX_TIME_MS + 1,
];

const COLOURS = [...GARMIN_COLORS, 'red', ' Blue ', 'TRANSPARENT', 'Chartreuse', '', null, undefined, 42, {}];

/** @param {() => number} rand */
function fuzzer(rand) {
  const pick = (/** @type {readonly any[]} */ arr) => arr[Math.floor(rand() * arr.length)];
  const text = () => {
    if (rand() < 0.05) return pick([null, undefined, 42, {}, true]);
    let s = '';
    for (let i = Math.floor(rand() * 6); i > 0; i--) s += pick(TEXT_PIECES);
    return s;
  };
  const num = (/** @type {number} */ lo, /** @type {number} */ hi) => (rand() < 0.15 ? pick(ODD_NUMBERS) : lo + rand() * (hi - lo));
  const opt = (/** @type {number} */ lo, /** @type {number} */ hi) => (rand() < 0.3 ? null : num(lo, hi));
  const point = () => ({ lat: num(-90, 90), lon: num(-180, 180), ele: opt(-500, 9000), time: opt(0, 2e12) });
  const item = () => {
    const r = rand();
    if (r < 0.05) return pick([null, 7, 'x', { kind: 'polygon' }, []]);
    if (r < 0.4) return { kind: 'waypoint', id: 'w', name: text(), comment: text(), symbol: text(), ...point() };
    if (r < 0.7) {
      return {
        kind: 'route', id: 'r', name: text(), comment: text(),
        points: Array.from({ length: Math.floor(rand() * 5) }, () => (rand() < 0.05 ? null : { ...point(), name: text(), symbol: text() })),
      };
    }
    const segments = rand() < 0.05 ? 'not an array' : Array.from({ length: Math.floor(rand() * 4) }, () =>
      rand() < 0.05 ? null : Array.from({ length: Math.floor(rand() * 5) }, () => (rand() < 0.05 ? 'junk' : point())));
    return { kind: 'track', id: 't', name: text(), comment: text(), color: pick(COLOURS), segments };
  };
  return { item, text };
}

/** Independent re-statement of the writer's rules, used to predict what it must write and count. */
const usableLat = (/** @type {any} */ v) => typeof v === 'number' && v >= -90 && v <= 90;
const usableLon = (/** @type {any} */ v) => typeof v === 'number' && v >= -180 && v <= 180;
const presentBad = (/** @type {any} */ v, /** @type {number} */ lo, /** @type {number} */ hi) =>
  v !== null && v !== undefined && !(typeof v === 'number' && v >= lo && v <= hi);

/**
 * What the writer must produce for these items: element counts and problem counts.
 * @param {any[]} items
 */
function expectedGpx(items) {
  const c = { wpt: 0, rtept: 0, trkpt: 0, waypoint_bad_position: 0, route_point_bad_position: 0, track_point_bad_position: 0,
    elevation_invalid: 0, time_invalid: 0, item_malformed: 0, track_color_unknown: 0 };
  const isObj = (/** @type {any} */ v) => v !== null && typeof v === 'object';
  /** @param {any} p @param {'wpt'|'rtept'|'trkpt'} tag @param {string} bad @param {boolean} withTime */
  const visit = (p, tag, bad, withTime) => {
    const q = isObj(p) ? p : {};
    if (!usableLat(q.lat) || !usableLon(q.lon)) {
      c[/** @type {keyof c} */ (bad)]++;
      return;
    }
    c[tag]++;
    if (presentBad(q.ele, -12000, 100000)) c.elevation_invalid++;
    if (withTime && presentBad(q.time, MIN_TIME_MS - 0.5, MAX_TIME_MS + 0.49)) c.time_invalid++;
  };
  for (const it of items) {
    if (!isObj(it) || !['waypoint', 'route', 'track'].includes(it.kind)) c.item_malformed++;
    else if (it.kind === 'waypoint') visit(it, 'wpt', 'waypoint_bad_position', true);
    else if (it.kind === 'route') for (const p of Array.isArray(it.points) ? it.points : []) visit(p, 'rtept', 'route_point_bad_position', false);
    else {
      if (garminColor(it.color) === null && it.color !== null && it.color !== undefined && it.color !== '') c.track_color_unknown++;
      for (const s of Array.isArray(it.segments) ? it.segments : []) {
        for (const p of Array.isArray(s) ? s : []) visit(p, 'trkpt', 'track_point_bad_position', true);
      }
    }
  }
  return c;
}

describe('adversarial: GPX', () => {
  test('fuzz: hostile items always give a schema-valid file whose contents and counts match the input', { skip: NO_XMLLINT }, () => {
    const docs = [];
    for (let seed = 1; seed <= FUZZ_SEEDS; seed++) {
      const rand = mulberry32(seed);
      const { item, text } = fuzzer(rand);
      const items = Array.from({ length: Math.floor(rand() * 30) }, item);
      const { xml, problems } = writeGpx(items, { creator: 'fuzz', name: text(), desc: text(), time: rand() < 0.5 ? null : 0 });
      const got = Object.fromEntries(problems.map((p) => [p.code, p.count]));
      const want = expectedGpx(items);
      for (const tag of /** @type {const} */ (['wpt', 'rtept', 'trkpt'])) {
        assert.equal((xml.match(new RegExp(`<${tag} `, 'g')) ?? []).length, want[tag], `seed ${seed}: <${tag}> count`);
      }
      for (const [code, n] of Object.entries(want)) {
        if (!['wpt', 'rtept', 'trkpt'].includes(code)) assert.equal(got[code] ?? 0, n, `seed ${seed}: ${code}`);
      }
      assert.doesNotMatch(xml, /NaN|Infinity|undefined|\[object|e[+-]\d/, `seed ${seed}`);
      docs.push(xml);
    }
    assertAllSchemaValid(docs);
  });

  test('a creator made only of characters XML cannot hold is rejected like an empty one', () => {
    assert.throws(() => writeGpx([], { creator: `${ch(1)}${ch(0xfffe)}` }), TypeError);
    assert.throws(() => writeGpx([], { creator: ` ${HIGH} ` }), TypeError);
  });

  test('a 200 000-point track streams quickly in bounded chunks', () => {
    const points = Array.from({ length: 200_000 }, (_, i) => ({ lat: 45 + i * 1e-6, lon: 7, ele: 500, time: 1.6e12 + i * 1000 }));
    const started = performance.now();
    let longest = 0;
    let trkpts = 0;
    for (const chunk of gpxChunks([track({ segments: [points] })], OPTS, new Tally(WRITER_MESSAGES))) {
      longest = Math.max(longest, chunk.length);
      trkpts += (chunk.match(/<trkpt /g) ?? []).length;
    }
    const ms = performance.now() - started;
    assert.equal(trkpts, 200_000);
    assert.ok(longest < 200_000, `longest chunk ${longest}`);
    assert.ok(ms < 3000, `${ms} ms`);
  });
});

// The writers format every point with the fast formatters in gpx.js; they must give exactly the strings of the
// xml.js formatters. Checked on every boundary, on values a hair either side of each rounding tie, and on millions of
// values of the kinds a library holds.
describe('fast point formatting equals the xml.js formatters', () => {
  const f64 = new Float64Array(1);
  const bits = new BigInt64Array(f64.buffer);
  /** x moved by n units in the last place (x > 0). */
  const ulps = (/** @type {number} */ x, /** @type {number} */ n) => {
    f64[0] = x;
    bits[0] += BigInt(n);
    return f64[0];
  };
  const SPECIAL = [NaN, Infinity, -Infinity, null, undefined, '45', {}, true, 0n, -0, 0, Number.MIN_VALUE, -Number.MIN_VALUE, 1e-300, -1e-300];
  /** Positive values within a few ulps of x, and their negatives. */
  const around = (/** @type {number} */ x) => {
    /** @type {number[]} */
    const out = [];
    if (!(x > 0)) return out;
    for (let n = -3; n <= 3; n++) out.push(ulps(x, n), -ulps(x, n));
    return out;
  };

  /**
   * @param {(v: any) => string|null} fast
   * @param {(v: any) => string|null} slow
   * @param {Iterable<any>} values
   * @param {string} label
   */
  const same = (fast, slow, values, label) => {
    let n = 0;
    for (const v of values) {
      const want = slow(v);
      const got = fast(v);
      if (got !== want) assert.fail(`${label}(${typeof v === 'number' ? v.toPrecision(21) : String(v)}): ${got} !== ${want}`);
      n++;
    }
    return n;
  };

  test('coordinates: boundaries, rounding ties to 7 decimals, random and semicircle values', () => {
    const rand = mulberry32(7);
    /** @type {number[]} */
    const values = [...SPECIAL, 90, -90, 180, -180, 179.99999995, 179.99999994999, -179.99999995, 89.99999995, 90.0000001, 180.0000001];
    for (const edge of [90, 180, 1e-7, 5e-8, 0.5, 1, 45.1, 12.3456789012]) values.push(...around(edge));
    // Ties: (k + 0.5) / 1e7 for k across the whole range, and the doubles just either side.
    for (let i = 0; i < 40000; i++) {
      const k = Math.floor(rand() * 1.8e9);
      values.push(...around((k + 0.5) / 1e7));
    }
    // Exact binary ties (dyadic values whose 8th decimal is exactly 5).
    for (let k = 1; k < 2000; k++) values.push(k / 256, -k / 256, k / 1024 + 0.5);
    // Random doubles, rounded decimals, and what the reader makes from 32-bit semicircles.
    for (let i = 0; i < 100000; i++) {
      values.push((rand() * 2 - 1) * 180, Math.round((rand() * 2 - 1) * 1.8e6) / 1e4);
      values.push((((rand() * 2 ** 32) | 0) * 180) / 2 ** 31);
    }
    let n = same(fastLat, formatLat, values, 'lat');
    n += same(fastLon, formatLon, values, 'lon');
    n += same(fastGpxLon, formatGpxLon, values, 'gpxLon');
    assert.ok(n > 1_000_000);
  });

  test('elevations: bounds, rounding ties to 2 decimals, random values', () => {
    const rand = mulberry32(11);
    /** @type {number[]} */
    const values = [...SPECIAL, -12000, 100000, -12000.01, 100000.01, 1e25, -0.001, 0.004, 0.005, -0.005, 0.015, 123.455, 123.445];
    for (const edge of [12000, 100000, 0.005, 0.05, 0.5, 123.456]) values.push(...around(edge));
    for (let i = 0; i < 40000; i++) {
      const k = Math.floor(rand() * 1e7);
      for (const v of around((k + 0.5) / 100)) if (v >= -12000) values.push(v);
    }
    for (let i = 0; i < 150000; i++) {
      values.push(rand() * 112000 - 12000, Math.round(rand() * 1.12e6 - 1.2e5) / 10, Math.fround(rand() * 9000 - 500));
    }
    assert.ok(same(fastEle, formatEle, values, 'ele') > 500_000);
  });

  test('times: every year 0001..9999 at its edges, random instants, fractions and runs across midnight', () => {
    const rand = mulberry32(13);
    /** @type {any[]} */
    const values = [...SPECIAL, MIN_TIME_MS, MAX_TIME_MS, MIN_TIME_MS - 1, MAX_TIME_MS + 1, MAX_TIME_MS + 0.4, MAX_TIME_MS + 0.5];
    values.push(MIN_TIME_MS - 0.5, MIN_TIME_MS - 0.6, -0.5, -0.4, 0.5, 1.5, -1.5, -1, -1000, -86400000, 8.64e15, -8.64e15);
    for (let year = 1; year <= 9999; year++) {
      const at = (/** @type {number[]} */ ...f) => {
        const d = new Date(0);
        d.setUTCFullYear(year, f[0], f[1]);
        d.setUTCHours(f[2], f[3], f[4], f[5]);
        return d.getTime();
      };
      values.push(at(0, 1, 0, 0, 0, 0), at(1, 28, 23, 59, 59, 999), at(1, 29, 12, 0, 0, 0), at(2, 1, 0, 0, 0, 1), at(11, 31, 23, 59, 59, 999));
    }
    for (let i = 0; i < 300000; i++) {
      values.push(MIN_TIME_MS + rand() * (MAX_TIME_MS - MIN_TIME_MS));
      values.push(Math.round((rand() * 2 - 1) * 4e12));
    }
    // Consecutive points, as in a track: one second apart over midnight, and alternating days.
    const start = Date.UTC(2024, 1, 28, 23, 59, 0);
    for (let k = 0; k < 200000; k++) values.push(start + k * 1000, start - k * 86400000 + (k % 7) * 333);
    assert.ok(same(fastTime, formatTime, values, 'time') > 900_000);
  });
});

// ---------------------------------------------------------------------------------------------
// Heart rate and air temperature (decision B44): Garmin's TrackPointExtension v2

test('formatHeartRate: an integer 1-255, else null; formatTemperature: two decimals at most, within the bounds', () => {
  assert.deepEqual([1, 100, 255].map(formatHeartRate), ['1', '100', '255']);
  for (const bad of [0, -1, 256, 100.5, NaN, Infinity, '100', null, undefined]) assert.equal(formatHeartRate(bad), null, String(bad));
  assert.deepEqual([20.5, 20.75, 21, 21.25, -3.25, 0, -0, 21.125, 21.3].map(formatTemperature), ['20.5', '20.75', '21', '21.25', '-3.25', '0', '0', '21.13', '21.3']);
  assert.deepEqual([-273.15, 1000].map(formatTemperature), ['-273.15', '1000']);
  for (const bad of [-273.16, 1000.01, 1e300, NaN, -Infinity, '20', null]) assert.equal(formatTemperature(bad), null, String(bad));
});

/** A track whose points carry heart rate and temperature, some only one of them, one neither. */
function sensorTrack(overrides = {}) {
  const t0 = Date.UTC(2023, 6, 1, 9);
  return track({
    segments: [[
      { lat: 46.5, lon: 7.25, ele: 1500, time: t0, hr: 100, atemp: 20.5 },
      { lat: 46.501, lon: 7.251, ele: null, time: t0 + 5000, hr: 101 },
      { lat: 46.502, lon: 7.252, ele: 1501, time: null, atemp: -3.25 },
      { lat: 46.503, lon: 7.253, ele: null, time: null },
    ]],
    ...overrides,
  });
}

test('track points: heart rate and temperature are written as TrackPointExtension v2, last in the trkpt, atemp before hr, schema-valid', () => {
  const { xml, problems } = writeGpx([waypoint(), sensorTrack({ color: 'Red' })], { creator: 'test' });
  assert.deepEqual(problems, []);
  assertWellFormed(xml);
  assertSchemaValid(xml);
  assert.ok(xml.includes(`xmlns:gpxtpx="${GPXTPX_NS}"`));
  assert.ok(xml.includes(`${GPXTPX_NS} ${GPXTPX_XSD}`), 'schemaLocation names the v2 schema');
  assert.equal(GPXTPX_NS, 'http://www.garmin.com/xmlschemas/TrackPointExtension/v2');
  const tpx = (/** @type {string} */ local) => `//${el('trkpt')}/${el('extensions')}/${el('TrackPointExtension')}/*[local-name()="${local}" and namespace-uri()="${GPXTPX_NS}"]`;
  assert.equal(xpathString(xml, `count(${tpx('hr')})`), '2');
  assert.equal(xpathString(xml, `count(${tpx('atemp')})`), '2');
  assert.equal(xpathString(xml, `count(//${el('trkpt')}[4]/*)`), '0', 'a point with neither has no extensions');
  assert.equal(xpathString(xml, `//${el('trkpt')}[1]/${el('extensions')}//${el('hr')}`), '100');
  assert.equal(xpathString(xml, `//${el('trkpt')}[1]/${el('extensions')}//${el('atemp')}`), '20.5');
  assert.equal(xpathString(xml, `//${el('trkpt')}[3]/${el('extensions')}//${el('atemp')}`), '-3.25');
  assert.equal(xpathString(xml, `name(//${el('trkpt')}[1]/*[last()])`), 'extensions');
  assert.match(xml, /<gpxtpx:atemp>20\.5<\/gpxtpx:atemp>\n\s*<gpxtpx:hr>100<\/gpxtpx:hr>/);
  // Waypoints and route points never carry them, even if an object has the fields.
  const other = writeGpx([waypoint({ hr: 90, atemp: 10 }), route({ points: [{ lat: 1, lon: 2, ele: null, name: 'a', symbol: '', hr: 90 }] })], { creator: 'test' }).xml;
  assert.ok(!other.includes('gpxtpx'));
});

test('track points: a schema-invalid heart rate (0, 256, 1.5) or temperature (NaN, 1e300) is left out and counted; the point stays', () => {
  const t = track({
    segments: [[
      { lat: 1, lon: 2, ele: null, time: null, hr: 0, atemp: NaN },
      { lat: 1.1, lon: 2.1, ele: null, time: null, hr: 256, atemp: 1e300 },
      { lat: 1.2, lon: 2.2, ele: null, time: null, hr: 1.5, atemp: 22 },
    ]],
  });
  const { xml, problems } = writeGpx([t], { creator: 'test' });
  assertSchemaValid(xml);
  assert.equal((xml.match(/<trkpt /g) ?? []).length, 3);
  assert.deepEqual(Object.fromEntries(problems.map((p) => [p.code, p.count])), { heart_rate_invalid: 3, temperature_invalid: 2 });
  assert.equal(xpathString(xml, `count(//${el('hr')})`), '0');
  assert.equal(xpathString(xml, `//${el('atemp')}`), '22');
});

test('the gpxtpx namespace is declared only when a track has sensor data, decided by the sensorData flag without reading points', () => {
  const plain = writeGpx([track()], { creator: 'test' }).xml;
  assert.ok(!plain.includes('gpxtpx'), 'no sensor data: the header is as before B44');
  // A track that says it has none is believed: its points are not read to decide the header.
  let reads = 0;
  const flagged = { ...track(), sensorData: false };
  Object.defineProperty(flagged, 'segments', { enumerable: true, get: () => (reads++, track().segments) });
  writeGpx([flagged], { creator: 'test' });
  assert.equal(reads, 1, 'segments read once, to write them');
  const told = writeGpx([{ ...track(), sensorData: true }], { creator: 'test' }).xml;
  assert.ok(told.split('\n')[1].includes('xmlns:gpxtpx'), 'a track that says it has sensor data gets the declaration');
  assertSchemaValid(told);
  // A track that says it has none but does: each extension declares the prefix itself, so the file stays valid.
  const { xml } = writeGpx([sensorTrack({ sensorData: false })], { creator: 'test' });
  assert.ok(!xml.split('\n')[1].includes('xmlns:gpxtpx'));
  assert.equal((xml.match(new RegExp(`<gpxtpx:TrackPointExtension xmlns:gpxtpx="${GPXTPX_NS.replace(/[/.]/g, '\\$&')}">`, 'g')) ?? []).length, 3);
  assertWellFormed(xml);
  assertSchemaValid(xml);
});

test('the schema subset really checks the extension: a heart rate of 0, or hr before atemp, is refused by xmllint', { skip: NO_XMLLINT }, () => {
  const good = writeGpx([sensorTrack()], { creator: 'test' }).xml;
  assertSchemaValid(good);
  assert.throws(() => assertSchemaValid(good.replace('<gpxtpx:hr>100</gpxtpx:hr>', '<gpxtpx:hr>0</gpxtpx:hr>')));
  const swapped = good.replace(
    /(<gpxtpx:atemp>20\.5<\/gpxtpx:atemp>)(\n\s*)(<gpxtpx:hr>100<\/gpxtpx:hr>)/,
    '$3$2$1',
  );
  assert.notEqual(swapped, good);
  assert.throws(() => assertSchemaValid(swapped));
});
