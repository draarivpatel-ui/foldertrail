// Unit tests for src/export/report.js: the user's own conversion report (text and HTML). Synthetic data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildReport, reportSections, folderPaths, LIMITS } from '../src/export/report.js';

/** @returns {{library: import('../src/model.js').Library, details: import('../src/format/library.js').ReadDetails}} */
function sample() {
  return {
    library: {
      items: [
        { kind: 'waypoint', id: 'w0', name: 'Spring <b>&', comment: '', symbol: '', icon: 0, lat: 1, lon: 2, ele: null, time: null },
        { kind: 'track', id: 't0', name: 'Ridge', comment: '', color: null, colorIndex: 0, segments: [[{ lat: 1, lon: 1, ele: null, time: null }]] },
        { kind: 'track', id: 't1', name: 'Loop', comment: '', color: null, colorIndex: 0, segments: [] },
        { kind: 'track', id: 't2', name: 'Loop', comment: '', color: null, colorIndex: 0, segments: [] },
      ],
      folders: [
        { id: 'f', name: 'My Collection', type: 'folder', parentId: null, itemIds: [] },
        { id: 'g', name: 'Alps', type: 'folder', parentId: 'f', itemIds: [] },
        { id: 'l', name: 'Day 1', type: 'list', parentId: 'g', itemIds: ['w0', 't0'] },
        { id: 'm', name: 'Day 2', type: 'list', parentId: 'g', itemIds: ['w0'] },
      ],
      problems: [
        { code: 'route_not_converted', message: 'Some routes were not converted.', count: 2, level: 'report' },
        { code: 'record_order', message: 'Some records are not in the usual order.', count: 1, level: 'dump' },
      ],
      notConverted: [
        { kind: 'route', name: 'Autobahn', reason: 'route_autoroute', listIds: ['l'] },
        { kind: 'track', name: 'Broken\u0007', reason: 'track_not_decoded', listIds: [] },
      ],
      ambiguous: ['t1', 't2'],
      treeMissing: false,
      meta: { source: 'BaseCamp library', version: '188' },
    },
    details: {
      fatal: null,
      experimental: false,
      versions: { gdb: 188, gfi: 188, program: 407 },
      application: 'BaseCamp',
      duplicates: [{ kind: 'track', name: 'Loop', cls: null, itemIds: ['t1', 't2'], copies: 2, listIds: ['l', 'm'] }],
      multiListItems: 1,
      elevationTime: new Map([['t0', 'not_decoded']]),
    },
  };
}

test('the report names what was not converted, and why, with the lists that held it', () => {
  const { library, details } = sample();
  const { text } = buildReport({ library, details, brand: 'Foldertrail', version: '0.1.0', now: Date.UTC(2026, 9, 6, 12), libraryVersion: '4.8' });
  assert.match(text, /^Foldertrail report\n/);
  assert.match(text, /Made on 2026-10-0\d by Foldertrail 0\.1\.0\. This report was made on your computer and was not sent anywhere\./);
  assert.match(text, /Library: file format version 188, from the folder 4\.8\./);
  assert.match(text, /Waypoints: 1/);
  assert.match(text, /Tracks: 3 \(0 with elevation or time\)/);
  assert.match(text, /Items in more than one list: 1/);
  assert.match(text, /Route "Autobahn": it follows roads .* In: My Collection \/ Alps \/ Day 1\./);
  assert.match(text, /Track "Broken": its record did not match a known track layout/);
  assert.doesNotMatch(text, /\u0007/);
  assert.match(text, /Track "Loop": 2 copies\. Named by: My Collection \/ Alps \/ Day 1; My Collection \/ Alps \/ Day 2\./);
  assert.match(text, /"Ridge": its elevation and time file could not be decoded/);
  assert.match(text, /Some routes were not converted\. \(2\)/);
  assert.doesNotMatch(text, /usual order/, 'dump-level problems stay out of the report');
  for (const limit of LIMITS) assert.ok(text.includes(limit));
});

test('the HTML report escapes every value and carries no script', () => {
  const { library, details } = sample();
  library.notConverted?.push({ kind: 'waypoint', name: '<script>alert(1)</script>', reason: 'waypoint_not_decoded', listIds: [] });
  const { html } = buildReport({ library, details });
  assert.match(html, /^<!doctype html>/);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Spring &lt;b&gt;&amp;|Loop/);
  assert.equal((html.match(/<style>/g) ?? []).length, 1);
});

test('a fatal library and a library without a tree are described honestly', () => {
  const { library, details } = sample();
  const fatal = buildReport({
    library: { ...library, items: [], notConverted: [] },
    details: { ...details, fatal: { code: 'not_a_library_file', message: 'AllData.gdb is not a BaseCamp library file.' }, duplicates: [] },
  });
  assert.match(fatal.text, /Nothing was converted: AllData\.gdb is not a BaseCamp library file\./);
  const flat = reportSections({ library: { ...library, folders: [], treeMissing: true, ambiguous: [] }, details: { ...details, experimental: true } });
  const converted = flat.find((s) => s.title === 'Converted');
  assert.ok(converted?.items?.some((i) => i.startsWith('Folders and lists: none could be rebuilt')));
  assert.ok(flat[0].paragraphs?.some((p) => p.includes('experimental')));
});

test('the export summary is stated', () => {
  const { library, details } = sample();
  const { text } = buildReport({ library, details, exported: { files: 7, kml: true, perItem: false, writerProblems: [{ code: 'x', message: 'A writer note.', count: 1 }] } });
  assert.match(text, /Download: 7 files; one GPX file per list, plus one KML file with your folders\./);
  assert.match(text, /A writer note\./);
});

test('folder paths survive loops and missing parents', () => {
  const paths = folderPaths([
    { id: 'a', name: 'A', type: 'folder', parentId: 'b', itemIds: [] },
    { id: 'b', name: 'B', type: 'folder', parentId: 'a', itemIds: [] },
    { id: 'c', name: '', type: 'list', parentId: 'zzz', itemIds: [] },
  ]);
  assert.equal(paths.get('a'), 'B / A');
  assert.equal(paths.get('c'), 'Untitled');
});

// Security audit (2026-10-06). report.html is opened later from the user's disk (file://), where no HTTP header and
// no site CSP applies, and both reports are read as the honest record of what converted.

test('a name cannot add a line of its own to report.txt (line breaks and tabs become spaces)', () => {
  const { library, details } = sample();
  library.notConverted?.push({ kind: 'track', name: 'Mine\n  - Track "Fake": converted fine.\r\nEnd\u2028x\u0085y\tz', reason: 'track_not_decoded', listIds: [] });
  library.folders.push({ id: 'n', name: 'Bad\nList', type: 'list', parentId: 'g', itemIds: [] });
  const { text } = buildReport({ library, details });
  assert.ok(!text.split('\n').some((line) => line.startsWith('  - Track "Fake"')), 'no injected item line');
  assert.match(text, /Track "Mine - Track "Fake": converted fine\. End x y z": its record did not match/);
  assert.doesNotMatch(text, /[\t\r\u0085\u2028\u2029]/);
  assert.equal(folderPaths(library.folders).get('n'), 'My Collection / Alps / Bad List');
});

test('bidirectional-text controls in a name cannot reorder the rest of a report line', () => {
  const { library, details } = sample();
  const bidi = '\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069';
  library.notConverted?.push({ kind: 'waypoint', name: `abc${bidi}def`, reason: 'waypoint_not_decoded', listIds: [] });
  const { text, html } = buildReport({ library, details });
  assert.match(text, /Waypoint "abcdef": its record could not be read\./);
  for (const out of [text, html]) assert.doesNotMatch(out, /[\u202a-\u202e\u2066-\u2069]/);
});

test('report.html carries its own CSP: no script, no remote load, only its one inline style (by hash)', () => {
  const { library, details } = sample();
  const { html } = buildReport({ library, details });
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
  assert.ok(meta, 'a meta Content-Security-Policy');
  const policy = meta[1];
  assert.match(policy, /^default-src 'none'; /);
  assert.doesNotMatch(policy, /unsafe|\*|https?:/);
  for (const d of ["base-uri 'none'", "form-action 'none'"]) assert.ok(policy.includes(d), d);
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
  const hash = createHash('sha256').update(style, 'utf8').digest('base64');
  assert.ok(policy.includes(`style-src 'sha256-${hash}'`), `the style hash in the CSP matches the <style> (want sha256-${hash})`);
  assert.ok(html.indexOf(meta[0]) < html.indexOf('<style>'), 'the policy comes before the style it allows');
  assert.ok(html.indexOf(meta[0]) < html.indexOf('<title>'), 'the policy is the first thing after the charset');
});

test('hostile names stay text in report.html: no tag, attribute or entity trick gets through', () => {
  const { library, details } = sample();
  const hostile = [
    '<img src=x onerror=alert(1)>', '</li><script>alert(1)</script>', '"><svg/onload=alert(1)>', "'><a href=javascript:alert(1)>x</a>",
    '<!--', ']]>', '&lt;script&gt;', '<style>*{display:none}</style>', '<meta http-equiv=refresh content="0;url=https://x.example.invalid/">',
    '<base href="https://x.example.invalid/">', '<link rel=stylesheet href=//x.example.invalid/a.css>', '\u0000<script>',
  ];
  for (const name of hostile) library.notConverted?.push({ kind: 'waypoint', name, reason: 'waypoint_not_decoded', listIds: [] });
  library.folders.push({ id: 'h', name: '</title><script>alert(1)</script>', type: 'list', parentId: 'f', itemIds: [] });
  library.notConverted?.push({ kind: 'route', name: 'R', reason: 'route_not_decoded', listIds: ['h'] });
  const { html } = buildReport({ library, details, brand: '</title><script>x</script>', version: '<b>1</b>' });
  const tags = [...html.matchAll(/<\/?([a-zA-Z][\w-]*)/g)].map((m) => m[1].toLowerCase());
  assert.deepEqual([...new Set(tags)].sort(), ['body', 'h1', 'h2', 'head', 'html', 'li', 'meta', 'p', 'section', 'style', 'title', 'ul']);
  assert.equal((html.match(/<meta /g) ?? []).length, 3, 'charset, viewport and the CSP only');
  for (const tag of html.match(/<[a-zA-Z][^>]*>/g) ?? []) {
    if (tag.startsWith('<meta ')) continue;
    assert.doesNotMatch(tag, /\s(?:on\w+|href|src|style)\s*=/i, tag);
  }
});
