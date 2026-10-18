// Development only: a module worker that speaks the page <-> worker protocol (src/app/ui.js) with a made-up
// library, so the page can be built and checked before the real reader exists. It is served in place of
// /js/app/worker.js by tools/ui-dev/shoot.js; it is never copied into dist/. Every name here is invented.
//
// It looks at nothing in the source it is given except whether a FolderData.gfi was found.

import { buildDump } from '../format/dump.js';

/** @type {number|null} */
let parsedId = null;

/** @param {number} ms */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {number} id
 * @param {string} phase
 * @param {number} steps
 * @param {number} ms
 */
async function phase(id, phase, steps, ms) {
  for (let i = 0; i <= steps; i++) {
    self.postMessage({ type: 'progress', id, phase, done: i, total: steps });
    await wait(ms / steps);
  }
}

/** @type {Array<[string, string, 'folder'|'list', string|null, number, number, number]>} */
const TREE = [
  ['root', 'My Collection', 'folder', null, 0, 0, 0],
  ['f-hike', 'Hiking', 'folder', 'root', 0, 0, 0],
  ['f-alps', 'Alpine week (made up)', 'folder', 'f-hike', 0, 0, 0],
  ['l-day1', 'Day 1 · Lake circuit', 'list', 'f-alps', 14, 2, 0],
  ['l-day2', 'Day 2 · Ridge traverse', 'list', 'f-alps', 9, 1, 1],
  ['l-day3', 'Day 3 · Hut to hut, the long way round over the pass and down through the larch woods', 'list', 'f-alps', 6, 1, 0],
  ['f-local', 'Local loops', 'folder', 'f-hike', 0, 0, 0],
  ['l-river', 'River path', 'list', 'f-local', 3, 4, 0],
  ['l-hostile', '<img src=x onerror=alert(1)> & “quotes”', 'list', 'f-local', 1, 0, 0],
  ['f-moto', 'Motorcycle', 'folder', 'root', 0, 0, 0],
  ['l-coast', 'Coast road (planned)', 'list', 'f-moto', 22, 0, 3],
  ['l-fuel', 'Fuel stops', 'list', 'f-moto', 41, 0, 0],
  ['f-cache', 'Geocaching', 'folder', 'root', 0, 0, 0],
  ['l-caches', 'Café du Lac series', 'list', 'f-cache', 18, 0, 0],
  ['f-empty', 'Ideas', 'folder', 'root', 0, 0, 0],
  ['l-inbox', 'Imported from device', 'list', 'root', 7, 3, 0],
];

function preview(treeMissing) {
  const tree = treeMissing
    ? []
    : TREE.map(([id, name, type, parentId, waypoints, tracks, routes]) => ({
        id,
        name,
        type,
        parentId,
        counts: { waypoints, tracks, routes },
      }));
  return {
    meta: { source: 'BaseCamp library (AllData.gdb)', version: '188', experimental: false, libraryVersion: '4.8' },
    fatal: null,
    multiListItems: 5,
    duplicates: [
      { kind: 'waypoint', name: 'Trailhead parking', copies: 2, listIds: ['l-day1', 'l-river'] },
    ],
    totals: { folders: treeMissing ? 0 : 7, lists: treeMissing ? 0 : 9, waypoints: 124, tracks: 12, routes: 4 },
    tree,
    unlisted: { waypoints: 3, tracks: 1, routes: 0 },
    ambiguousCount: 2,
    treeMissing,
    notConverted: [
      { kind: 'track', name: 'Old logger import', reason: 'track_not_decoded', listIds: ['l-inbox'] },
      { kind: 'route', name: 'Coast road, autorouted', reason: 'autoroute', listIds: ['l-coast'] },
      { kind: 'route', name: 'Pass detour', reason: 'via_unresolved', listIds: ['l-day2'] },
    ],
    problems: [
      {
        code: 'track_segments_missing',
        message: 'A track has no elevation and time file; it keeps its positions only.',
        count: 2,
        level: 'report',
      },
      { code: 'item_in_several_lists', message: 'An item is in several lists and was written into each.', count: 5, level: 'report' },
    ],
  };
}

self.addEventListener('message', async (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'parse') {
    const id = msg.id;
    const treeMissing = !msg.source || !msg.source.folderData;
    await phase(id, 'reading', 10, 700);
    await phase(id, 'parsing', 20, 1100);
    await phase(id, 'linking', 5, 400);
    const dump = buildDump({ toolVersion: '0.1.0', engine: 'Blink', engineMajor: 140, inputKind: 'backup' });
    parsedId = id;
    self.postMessage({ type: 'parsed', id, preview: preview(treeMissing), dump: { text: dump.text, json: dump.json } });
    return;
  }
  if (msg.type === 'export') {
    const id = msg.id;
    // Like the real pipeline: an export names the library it wants by the id it was parsed with.
    if (parsedId === null || id !== parsedId) {
      self.postMessage({ type: 'error', id, code: 'not_parsed', message: 'Open a library first.' });
      return;
    }
    await phase(id, 'exporting', 12, 1200);
    const report = [
      'Foldertrail report (made-up library, development fake)',
      '',
      'Converted: 124 waypoints, 12 tracks, 4 routes, in 9 lists and 7 folders.',
      'Not in any list: 3 waypoints, 1 track.',
      'Duplicate names: 2 items, saved in _Duplicate names.',
      '',
      'Not converted',
      '  Track "Old logger import": its points could not be read.',
      '  Route "Coast road, autorouted": road-following detail.',
      '  Route "Pass detour": a via point could not be found.',
      '',
      'Notes',
      '  2 tracks have no elevation and time file; they keep their positions only.',
      '  5 items are in several lists and were written into each.',
    ].join('\n');
    const zip = new Blob([new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)])], { type: 'application/zip' });
    self.postMessage({
      type: 'exported',
      id,
      zip,
      filename: 'foldertrail-export-2026-10-06.zip',
      report: { text: report, html: '<p>unused</p>' },
    });
  }
});
