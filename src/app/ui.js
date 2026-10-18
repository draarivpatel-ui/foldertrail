// The app's logic, without the DOM: the state machine, the worker protocol, the words on the page, and
// the folder tree built from the worker's flat list. main.js wires it to the page; the view-*.js files
// draw the state. Everything here runs in Node too, so test/ui.test.js can drive the whole flow with a
// fake worker.
//
// Worker protocol (shared with src/app/worker.js):
//   page -> worker  {type:'parse', id, source}           source = toWorkerSource(found) from intake.js
//   worker -> page  {type:'progress', id, phase, done, total}
//   worker -> page  {type:'parsed', id, preview, dump}   the full library stays in the worker
//   page -> worker  {type:'export', id, options:{kml, perItem}}   only after the licence check passed
//   worker -> page  {type:'exported', id, zip, filename, report:{text, html}}
//   worker -> page  {type:'error', id, code, message}    plain words, never a name or a coordinate
// An 'export' carries the SAME id as the 'parse' of the library it is for: the worker exports only the library
// it parsed under that id and answers anything else with a 'not_parsed' error (pipeline.js). A new id always
// means a new library.
// Messages are hostile input like everything else: anything malformed, or for another id, is ignored or
// turned into a plain error. Nothing here throws past its caller.

/** @typedef {import('../model.js').Problem} Problem */

/**
 * @typedef {object} Counts
 * @property {number} waypoints
 * @property {number} tracks
 * @property {number} routes
 */

/**
 * @typedef {object} TreeEntry  one row of preview.tree, as the worker sends it
 * @property {string} id
 * @property {string} name
 * @property {"folder"|"list"} type
 * @property {string|null} parentId
 * @property {Counts} counts
 */

/**
 * @typedef {object} NotConvertedEntry
 * @property {"waypoint"|"track"|"route"} kind
 * @property {string} name
 * @property {string} reason
 * @property {string[]} listIds
 */

/**
 * @typedef {object} Preview
 * @property {{source: string, version: string|null}} meta
 * @property {{folders: number, lists: number, waypoints: number, tracks: number, routes: number}} totals
 * @property {TreeEntry[]} tree
 * @property {Counts} unlisted
 * @property {number} ambiguousCount
 * @property {boolean} treeMissing
 * @property {NotConvertedEntry[]} notConverted
 * @property {Problem[]} problems
 * @property {boolean} experimental   the file format is read experimentally (decision B6)
 * @property {string|null} libraryVersion  the version folder the worker read, such as "4.8"
 * @property {{code: string, message: string}|null} fatal  nothing could be converted
 * @property {{kind: string, name: string, copies: number, listIds: string[]}[]} duplicates  listIds: the lists that name it
 */

/**
 * @typedef {object} TreeNode
 * @property {string} id
 * @property {string} name
 * @property {"folder"|"list"} type
 * @property {Counts} counts
 * @property {number} depth
 * @property {TreeNode[]} children
 * @property {number} lists    lists anywhere below this node
 * @property {number} folders  folders anywhere below this node
 */

// ---------------------------------------------------------------------------------------------
// Limits on what the page will hold or draw. The worker may send anything; these keep the page responsive.

export const LIMITS = Object.freeze({
  treeRows: 20_000,
  treeDepth: 64,
  notConverted: 5_000,
  problems: 200,
  nameLength: 300,
  messageLength: 600,
  reportChars: 2_000_000,
  dumpChars: 2_000_000,
  licenceKeyLength: 200,
  licenceTimeoutMs: 30_000,
});

// ---------------------------------------------------------------------------------------------
// Words

export const STEP_LABELS = Object.freeze([
  { key: 'open', label: 'Choose library' },
  { key: 'read', label: 'Read' },
  { key: 'preview', label: 'Preview' },
  { key: 'download', label: 'Download' },
]);

/** What the page says while each phase runs. */
export const PHASE_TEXT = Object.freeze({
  listing: 'Finding the library…',
  stat: 'Checking the library files…',
  backup: 'Opening the backup…',
  reading: 'Reading the library files…',
  parsing: 'Reading waypoints, tracks and routes…',
  linking: 'Matching items to your folders and lists…',
  exporting: 'Writing your GPX files…',
  starting: 'Starting…',
});

export const TEXT = Object.freeze({
  cancelled: 'Reading stopped. Nothing was changed.',
  exportCancelled: 'Download canceled.',
  workerFailed:
    'Something went wrong inside the converter, and it stopped. Nothing was sent anywhere. Try again; if it ' +
    'happens again, try another current browser.',
  workerUnsupported:
    'This browser can’t run the converter. Use a current version of Chrome, Firefox or Safari.',
  badReply: 'The converter sent back something this page could not use. Try again.',
  exportFailed: 'The download could not be made.',
  noLicenceModule: 'License checking is not available in this copy of the page.',
  licenceEmpty: 'Paste your license key first.',
  licenceTooLong: 'That is too long to be a license key. Check what was pasted.',
  licenceTimeout: 'The license check took too long. Check your internet connection and try again.',
  licenceFailed: 'The license key could not be checked. Try again in a moment.',
  licenceValid: 'License accepted. You can download your files.',
  licenceRestoring: 'Checking the license key saved in this browser…',
  licenceRestored: 'Unlocked with your saved license key.',
  licenceSavedRejected:
    'The payment provider no longer accepts the license key saved in this browser, so it was removed. Paste a ' +
    'current key to unlock.',
  nothingConverted: 'Nothing in this library could be converted.',
  internal: 'Something unexpected went wrong on this page. Try again.',
});

/**
 * Why something was not converted, keyed by the NotConverted.reason codes the reader emits (src/format/library.js:
 * waypoint_not_decoded, track_not_decoded, route_autoroute, route_not_decoded, route_via_unresolved). The report
 * says the same things in src/export/report.js (REASONS); test/ui.test.js checks both lists and the reader's real
 * output against this table. Each entry is [one item, several items]: the page shows them in groups.
 * @type {Readonly<Record<string, readonly [string, string]>>}
 */
const REASON_TEXT = Object.freeze({
  waypoint_not_decoded: [
    'Its record could not be read, so it is not in the download.',
    'Their records could not be read, so they are not in the download.',
  ],
  track_not_decoded: [
    'Its record does not match a track layout Foldertrail knows, so its points could not be read safely. It is ' +
      'not in the download.',
    'Their records do not match a track layout Foldertrail knows, so their points could not be read safely. ' +
      'They are not in the download.',
  ],
  route_autoroute: [
    'It follows roads (BaseCamp calculated it). This version of Foldertrail can’t convert routes like that, so it is ' +
      'not in the download.',
    'They follow roads (BaseCamp calculated them). This version of Foldertrail can’t convert routes like that, so ' +
      'they are not in the download.',
  ],
  route_not_decoded: [
    'Its record could not be read, so it is not in the download.',
    'Their records could not be read, so they are not in the download.',
  ],
  route_via_unresolved: [
    'One or more of its via points could not be found in the library, so it could not be drawn. It is not in ' +
      'the download.',
    'Each has a via point that could not be found in the library, so they could not be drawn. They are not in ' +
      'the download.',
  ],
});

/**
 * The heading of a group of not-converted items: what the items have in common, so two groups never share a title.
 * Each entry is [one item, several items]; the count and the kind go in front ("2 routes that follow roads").
 * @type {Readonly<Record<string, readonly [string, string]>>}
 */
const REASON_TITLE = Object.freeze({
  waypoint_not_decoded: ['that could not be read', 'that could not be read'],
  track_not_decoded: ['that could not be read', 'that could not be read'],
  route_autoroute: ['that follows roads', 'that follow roads'],
  route_not_decoded: ['that could not be read', 'that could not be read'],
  route_via_unresolved: ['with a via point that is missing', 'with a via point that is missing'],
});

/** For a reason code this page does not know (a newer reader, or a hostile message). */
const REASON_FALLBACK = Object.freeze([
  'It could not be converted, so it is not in the download.',
  'They could not be converted, so they are not in the download.',
]);

/**
 * Plain words for why one item (or `count` items) of a kind was not converted.
 * @param {string} kind     "waypoint", "track" or "route"
 * @param {string} reason   a NotConverted.reason code
 * @param {number} [count]  how many items the sentence is about (1 by default)
 * @returns {string}
 */
export function reasonText(kind, reason, count = 1) {
  const known = typeof reason === 'string' && hasOwn(REASON_TEXT, reason) && reason.startsWith(`${kind}_`);
  const pair = known ? REASON_TEXT[reason] : REASON_FALLBACK;
  return count === 1 ? pair[0] : pair[1];
}

/**
 * The heading of a group of `count` not-converted items of one kind: "1 route that follows roads", "3 tracks that could
 * not be read"; "2 waypoints not converted" for a reason this page does not know.
 * @param {string} kind
 * @param {string} reason
 * @param {number} count
 * @returns {string}
 */
export function reasonTitle(kind, reason, count) {
  const known = typeof reason === 'string' && hasOwn(REASON_TITLE, reason) && reason.startsWith(`${kind}_`);
  const what = plural(count, kind);
  return known ? `${what} ${REASON_TITLE[reason][count === 1 ? 0 : 1]}` : `${what} not converted`;
}

/**
 * The note under the license key field: what unlocking sends, and to whom (docs/ARCHITECTURE.md §9, §10).
 * @param {string} provider  "Polar" or "Gumroad"
 * @returns {string}
 */
export function unlockPrivacyNote(provider) {
  return (
    `Unlocking sends your license key and a product ID to ${provider}, to check the key. A key saved in this ` +
    'browser is checked again at most once per browser session, when this page opens. Your library is never ' +
    'sent anywhere.'
  );
}

/**
 * Domains reserved for examples and tests (RFC 2606, RFC 6761). An address there is a placeholder, never a real
 * support address, so the page never shows it.
 */
const PLACEHOLDER_DOMAIN = /(?:^|\.)(?:example\.(?:com|net|org)|example|invalid|test|localhost|local)$/i;

/**
 * What the diagnostic section says about getting help. A real address (CONFIG.supportEmail) comes back as `email`;
 * without one, or with a placeholder, `text` says so in plain words instead.
 * @param {unknown} value   CONFIG.supportEmail
 * @param {boolean} onSale  whether the page is selling (then "when it goes on sale" would be false)
 * @returns {{email: string, text: string}}
 */
export function supportContact(value, onSale) {
  const address = typeof value === 'string' ? value.trim() : '';
  const wellFormed = address.length <= 254 && /^[^\s@<>"()[\]\\,;:]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/.test(address);
  if (wellFormed && !PLACEHOLDER_DOMAIN.test(address.slice(address.indexOf('@') + 1))) return { email: address, text: '' };
  return {
    email: '',
    text: onSale
      ? 'Copy it and keep it. A support address isn’t listed here yet.'
      : 'Copy it and keep it; a support address will be listed here when Foldertrail goes on sale.',
  };
}

/**
 * "1 track", "12 tracks", "no tracks".
 * @param {number} n
 * @param {string} one
 * @param {string} [many]
 */
export function plural(n, one, many = `${one}s`) {
  if (n === 0) return `no ${many}`;
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

/** @param {number} n */
export function formatNumber(n) {
  if (!Number.isFinite(n)) return '0';
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * "a", "a and b", "a, b and c".
 * @param {string[]} parts
 */
export function joinWords(parts) {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * "12 waypoints, 3 tracks and 1 route"; only the kinds that are present; "" when none are.
 * @param {Counts} counts
 */
export function countsPhrase(counts) {
  const parts = [];
  if (counts.waypoints > 0) parts.push(plural(counts.waypoints, 'waypoint'));
  if (counts.tracks > 0) parts.push(plural(counts.tracks, 'track'));
  if (counts.routes > 0) parts.push(plural(counts.routes, 'route'));
  return joinWords(parts);
}

/**
 * The one-sentence summary at the top of the preview.
 * @param {Preview} preview
 * @returns {string}
 */
export function summarySentence(preview) {
  const t = preview.totals;
  // The worker's totals count what converts; items that will not convert are listed apart (preview.notConverted).
  // "Your library holds 2 routes" would be false when it holds 7 and 5 cannot be converted, so then the sentence
  // says what converts, and how many more there are.
  const left = notConvertedCounts(preview.notConverted);
  const items = countsPhrase(t);
  if (items === '' && countsPhrase(left) === '') return 'No waypoints, tracks or routes were found in this library.';
  const where = [];
  if (!preview.treeMissing && t.lists > 0) where.push(plural(t.lists, 'list'));
  if (!preview.treeMissing && t.folders > 0) where.push(plural(t.folders, 'folder'));
  const place = where.length > 0 ? `, in ${joinWords(where)}` : '';
  if (countsPhrase(left) === '') return `Your library holds ${items}${place}.`;
  const more = /** @type {string[]} */ ([]);
  for (const [key, one] of /** @type {const} */ ([['waypoints', 'waypoint'], ['tracks', 'track'], ['routes', 'route']])) {
    const n = left[key];
    if (n > 0) more.push(`${formatNumber(n)} more ${n === 1 ? one : `${one}s`}`);
  }
  const total = left.waypoints + left.tracks + left.routes;
  if (items === '') {
    const which = total === 1 ? 'it can’t be converted; it’s' : 'none of them can be converted; they’re';
    return `Your library holds ${countsPhrase(left)}${place}, but ${which} listed below.`;
  }
  return `Foldertrail can convert ${items}${place}. ${joinWords(more)} can’t be converted; ${total === 1 ? 'it’s' : 'they’re'} listed below.`;
}

/**
 * How many items of each kind will not convert.
 * @param {NotConvertedEntry[]} list
 * @returns {Counts}
 */
export function notConvertedCounts(list) {
  const out = { waypoints: 0, tracks: 0, routes: 0 };
  for (const n of Array.isArray(list) ? list : []) {
    if (n.kind === 'waypoint') out.waypoints++;
    else if (n.kind === 'track') out.tracks++;
    else if (n.kind === 'route') out.routes++;
  }
  return out;
}

/**
 * For each list: how many of its items will not convert, and how many it names that went to "_Duplicate names"
 * instead (the list's own file will not hold them). Lists with neither are not in the map.
 * @param {Preview} preview
 * @returns {Map<string, {notConverted: Counts, duplicates: Counts}>}
 */
export function listShortfalls(preview) {
  /** @type {Map<string, {notConverted: Counts, duplicates: Counts}>} */
  const out = new Map();
  const key = /** @type {const} */ ({ waypoint: 'waypoints', track: 'tracks', route: 'routes' });
  /** @param {string} id */
  const entry = (id) => {
    let e = out.get(id);
    if (!e) {
      e = { notConverted: { waypoints: 0, tracks: 0, routes: 0 }, duplicates: { waypoints: 0, tracks: 0, routes: 0 } };
      out.set(id, e);
    }
    return e;
  };
  for (const n of preview.notConverted) {
    for (const id of new Set(n.listIds)) entry(id).notConverted[key[n.kind]]++;
  }
  for (const d of preview.duplicates) {
    for (const id of new Set(d.listIds ?? [])) entry(id).duplicates[key[d.kind]]++;
  }
  return out;
}

/**
 * The done view's steps: what to do with the ZIP, and where the files are for the options the user chose (the ZIP's
 * layout: src/app/pipeline.js). Plain sentences, one step each.
 * @param {{kml: boolean, perItem: boolean}} options
 * @param {boolean} treeMissing   no folder file: the GPX files are grouped by type
 * @returns {string[]}
 */
export function nextSteps(options, treeMissing) {
  const gpx = treeMissing
    ? 'Open the GPX folder. Your items are grouped by type there: Waypoints.gpx, Tracks.gpx and Routes.gpx.'
    : options.perItem
      ? 'Open the GPX folder. It has a folder for each list, inside your folders, with one GPX file per item.'
      : 'Open the GPX folder. It has one GPX file for each list, inside your folders.';
  return [
    'Unzip the file (double-click it in Finder).',
    `${gpx} All items.gpx holds everything in one file.${options.kml ? ' The KML folder has one file with your whole folder tree, for Google Earth.' : ''}`,
    'Import the files into any app that reads GPX, such as Gaia GPS, CalTopo or OsmAnd. An item that is in several ' +
      'lists is in each of their files, so import one list at a time, or All items.gpx once, to avoid copies.',
  ];
}

/**
 * The small line under the summary: which version folder, which file format.
 * @param {Preview} preview
 * @param {string|null} versionFolder  the BaseCamp folder name, such as "4.8", when known
 */
export function metaLine(preview, versionFolder) {
  const parts = [];
  const folder = versionFolder ?? preview.libraryVersion;
  if (folder) parts.push(`From the ${folder} folder`);
  if (preview.meta.version) parts.push(`library format ${preview.meta.version}`);
  return parts.join(' · ');
}

/**
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1000) return `${Math.round(bytes)} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

// ---------------------------------------------------------------------------------------------
// Feature detection (never version sniffing)

/**
 * @typedef {object} Support
 * @property {boolean} moduleWorker   module workers: required
 * @property {boolean} inflateRaw     DecompressionStream('deflate-raw'): needed to open a .Backup directly
 * @property {boolean} deflateRaw     CompressionStream('deflate-raw'): without it the ZIP is stored uncompressed
 * @property {boolean} folderDrop     DataTransferItem.webkitGetAsEntry: dropping a folder
 * @property {boolean} folderPicker   <input webkitdirectory>
 * @property {boolean} clipboard      navigator.clipboard.writeText
 */

/**
 * What this browser offers, by trying it.
 * @param {any} [env]  the global object (tests pass a fake)
 * @returns {Support}
 */
export function detectSupport(env = globalThis) {
  /** @param {() => unknown} test */
  const has = (test) => {
    try {
      return Boolean(test());
    } catch {
      return false;
    }
  };
  return {
    moduleWorker: has(() => supportsModuleWorker(env)),
    inflateRaw: has(() => typeof env.DecompressionStream === 'function' && new env.DecompressionStream('deflate-raw')),
    deflateRaw: has(() => typeof env.CompressionStream === 'function' && new env.CompressionStream('deflate-raw')),
    folderDrop: has(
      () => typeof env.DataTransferItem === 'function' && 'webkitGetAsEntry' in env.DataTransferItem.prototype,
    ),
    folderPicker: has(() => env.document && 'webkitdirectory' in env.document.createElement('input')),
    clipboard: has(() => env.navigator?.clipboard && typeof env.navigator.clipboard.writeText === 'function'),
  };
}

/**
 * A browser that knows module workers reads the `type` option while it converts the arguments, before it
 * looks at the URL. The URL here cannot be parsed, so no worker is ever started and nothing is fetched (and
 * so nothing touches the Content-Security-Policy).
 * @param {any} env
 */
function supportsModuleWorker(env) {
  if (typeof env.Worker !== 'function') return false;
  let read = false;
  const options = {
    get type() {
      read = true;
      return 'module';
    },
  };
  try {
    // eslint-disable-next-line no-new
    new env.Worker('http://[', options);
  } catch {
    // expected: the URL is invalid
  }
  return read;
}

/**
 * What the page should say about this browser.
 * @param {Support} support
 * @returns {{blocking: string|null, notes: string[]}}
 */
export function supportMessages(support) {
  if (!support.moduleWorker) {
    return {
      blocking:
        'This browser is too old to run Foldertrail. On macOS 10.13 or 10.14, Safari can’t be updated far ' +
        'enough: use a current version of Chrome or Firefox instead. On a newer Mac, update Safari or use ' +
        'Chrome or Firefox.',
      notes: [],
    };
  }
  const notes = [];
  if (!support.inflateRaw) {
    notes.push(
      'This browser can’t open backup files directly. Double-click the backup in Finder first (rename it to ' +
        'end in .zip if Finder won’t open it), then drop the folder that appears.',
    );
  }
  if (!support.folderDrop && support.folderPicker) {
    notes.push('This browser can’t take a dropped folder. Use Choose folder instead.');
  }
  return { blocking: null, notes };
}

// ---------------------------------------------------------------------------------------------
// The tree

/**
 * Builds the nested tree from the worker's flat rows. Rows whose parent is missing, or that would make a
 * cycle, are attached at the top level; rows past the depth or row limits are dropped and counted.
 * @param {TreeEntry[]} rows
 * @param {{maxDepth?: number, maxRows?: number}} [limits]
 * @returns {{roots: TreeNode[], shown: number, dropped: number}}
 */
export function buildTree(rows, limits = {}) {
  const maxDepth = limits.maxDepth ?? LIMITS.treeDepth;
  const maxRows = limits.maxRows ?? LIMITS.treeRows;
  /** @type {Map<string, TreeNode>} */
  const byId = new Map();
  /** @type {Map<string, string|null>} */
  const parentOf = new Map();
  /** @type {string[]} */
  const order = [];
  let dropped = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (byId.size >= maxRows) {
      dropped++;
      continue;
    }
    const entry = normaliseTreeEntry(row);
    if (!entry || byId.has(entry.id)) {
      dropped++;
      continue;
    }
    byId.set(entry.id, {
      id: entry.id,
      name: entry.name,
      type: entry.type,
      counts: entry.counts,
      depth: 0,
      children: [],
      lists: 0,
      folders: 0,
    });
    parentOf.set(entry.id, entry.parentId);
    order.push(entry.id);
  }

  const onCycle = findCycles(order, parentOf, byId);
  /** @type {TreeNode[]} */
  const roots = [];
  for (const id of order) {
    const node = /** @type {TreeNode} */ (byId.get(id));
    const parentId = parentOf.get(id) ?? null;
    const parent = parentId !== null ? byId.get(parentId) : undefined;
    if (parent && !onCycle.has(id)) parent.children.push(node);
    else roots.push(node);
  }

  // Depths and the "lists/folders below" totals, without recursion (a hostile tree can be deep).
  let shown = 0;
  /** @type {{node: TreeNode, depth: number, parent: TreeNode|null}[]} */
  const stack = roots.map((node) => ({ node, depth: 0, parent: null }));
  /** @type {TreeNode[]} */
  const visitOrder = [];
  /** @type {Map<TreeNode, TreeNode|null>} */
  const parents = new Map();
  while (stack.length > 0) {
    const { node, depth, parent } = /** @type {{node: TreeNode, depth: number, parent: TreeNode|null}} */ (stack.pop());
    node.depth = depth;
    parents.set(node, parent);
    visitOrder.push(node);
    shown++;
    if (depth + 1 >= maxDepth) {
      dropped += countDescendants(node);
      node.children = [];
      continue;
    }
    for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i], depth: depth + 1, parent: node });
  }
  for (let i = visitOrder.length - 1; i >= 0; i--) {
    const node = visitOrder[i];
    const parent = parents.get(node);
    if (!parent) continue;
    parent.lists += node.lists + (node.type === 'list' ? 1 : 0);
    parent.folders += node.folders + (node.type === 'folder' ? 1 : 0);
  }
  return { roots, shown, dropped };
}

/**
 * The rows whose parent links go round in a circle (a folder inside itself, A in B in A). They are put at the
 * top level, which breaks every cycle; rows that merely hang below a cycle keep their parent. Linear time: each
 * row is walked once, so a hostile 100,000-deep chain costs no more than a flat list.
 * @param {string[]} order
 * @param {Map<string, string|null>} parentOf
 * @param {Map<string, TreeNode>} byId
 * @returns {Set<string>}
 */
function findCycles(order, parentOf, byId) {
  /** @type {Map<string, 1|2>} 1: on the walk in progress, 2: settled */
  const state = new Map();
  /** @type {Set<string>} */
  const onCycle = new Set();
  for (const start of order) {
    if (state.has(start)) continue;
    /** @type {string[]} */
    const path = [];
    /** @type {string|null} */
    let current = start;
    while (current !== null && !state.has(current)) {
      state.set(current, 1);
      path.push(current);
      const parent = parentOf.get(current) ?? null;
      current = parent !== null && byId.has(parent) ? parent : null;
    }
    if (current !== null && state.get(current) === 1) {
      for (let i = path.indexOf(current); i < path.length; i++) onCycle.add(path[i]);
    }
    for (const id of path) state.set(id, 2);
  }
  return onCycle;
}

/** @param {TreeNode} node */
function countDescendants(node) {
  let n = 0;
  const stack = [...node.children];
  while (stack.length > 0) {
    const next = /** @type {TreeNode} */ (stack.pop());
    n++;
    for (const child of next.children) stack.push(child);
  }
  return n;
}

/**
 * Visits every node depth-first, parents before children.
 * @param {TreeNode[]} roots
 * @param {(node: TreeNode) => void} visit
 */
export function walkTree(roots, visit) {
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const node = /** @type {TreeNode} */ (stack.pop());
    visit(node);
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
}

/**
 * Groups the not-converted items by kind and reason (unknown reasons share one group per kind), with the sentence
 * for that many items. Tracks first, then routes, then waypoints; otherwise in the worker's order.
 * @param {NotConvertedEntry[]} items
 * @returns {{kind: string, reason: string, title: string, text: string, names: string[]}[]}
 */
export function groupNotConverted(items) {
  /** @type {Map<string, {kind: string, reason: string, title: string, text: string, names: string[]}>} */
  const groups = new Map();
  for (const item of items) {
    const reason = reasonText(item.kind, item.reason) === reasonText(item.kind, '') ? '' : item.reason;
    const key = `${item.kind}\u0000${reason}`;
    let group = groups.get(key);
    if (!group) {
      group = { kind: item.kind, reason, title: '', text: '', names: [] };
      groups.set(key, group);
    }
    group.names.push(item.name);
  }
  for (const group of groups.values()) {
    group.text = reasonText(group.kind, group.reason, group.names.length);
    group.title = reasonTitle(group.kind, group.reason, group.names.length);
  }
  const order = { track: 0, route: 1, waypoint: 2 };
  return [...groups.values()].sort(
    (a, b) =>
      (/** @type {Record<string, number>} */ (order)[a.kind] ?? 3) - (/** @type {Record<string, number>} */ (order)[b.kind] ?? 3),
  );
}

// ---------------------------------------------------------------------------------------------
// Making the worker's messages safe to use

/** @param {unknown} v */
function count(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), Number.MAX_SAFE_INTEGER) : 0;
}

/**
 * @param {unknown} v
 * @param {number} max
 */
function text(v, max) {
  if (typeof v !== 'string') return '';
  return v.length > max ? `${v.slice(0, max)}…` : v;
}

/** @param {unknown} v @returns {Counts} */
function counts(v) {
  const o = /** @type {any} */ (v && typeof v === 'object' ? v : {});
  return { waypoints: count(o.waypoints), tracks: count(o.tracks), routes: count(o.routes) };
}

/**
 * @param {unknown} row
 * @returns {TreeEntry|null}
 */
function normaliseTreeEntry(row) {
  if (!row || typeof row !== 'object') return null;
  const r = /** @type {any} */ (row);
  const id = typeof r.id === 'string' || typeof r.id === 'number' ? String(r.id) : '';
  if (id === '') return null;
  const parentId = typeof r.parentId === 'string' || typeof r.parentId === 'number' ? String(r.parentId) : null;
  return {
    id,
    name: text(r.name, LIMITS.nameLength),
    type: r.type === 'folder' ? 'folder' : 'list',
    parentId,
    counts: counts(r.counts),
  };
}

/**
 * Turns whatever the worker sent as `preview` into a Preview the page can draw without checking again.
 * @param {unknown} value
 * @returns {Preview|null}
 */
export function normalisePreview(value) {
  if (!value || typeof value !== 'object') return null;
  const p = /** @type {any} */ (value);
  const totals = p.totals && typeof p.totals === 'object' ? p.totals : {};
  const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
  const tree = Array.isArray(p.tree) ? p.tree.slice(0, LIMITS.treeRows + 1) : [];
  const notConverted = Array.isArray(p.notConverted) ? p.notConverted : [];
  const problems = Array.isArray(p.problems) ? p.problems : [];
  const fatal = p.fatal && typeof p.fatal === 'object' ? p.fatal : null;
  const duplicates = Array.isArray(p.duplicates) ? p.duplicates : [];
  return {
    meta: {
      source: text(meta.source, 200),
      version: typeof meta.version === 'string' && /^[0-9][0-9.]{0,15}$/.test(meta.version) ? meta.version : null,
    },
    experimental: meta.experimental === true,
    libraryVersion:
      typeof meta.libraryVersion === 'string' && /^\d{1,3}(?:\.\d{1,3}){0,3}$/.test(meta.libraryVersion) ? meta.libraryVersion : null,
    fatal: fatal
      ? {
          code: typeof fatal.code === 'string' ? fatal.code.slice(0, 64) : '',
          message: text(fatal.message, LIMITS.messageLength) || TEXT.nothingConverted,
        }
      : null,
    duplicates: duplicates
      .slice(0, LIMITS.notConverted)
      .filter((/** @type {any} */ d) => d && typeof d === 'object')
      .map((/** @type {any} */ d) => ({
        kind: d.kind === 'waypoint' || d.kind === 'route' ? d.kind : 'track',
        name: text(d.name, LIMITS.nameLength),
        copies: count(d.copies),
        listIds: Array.isArray(d.listIds) ? d.listIds.filter((/** @type {unknown} */ x) => typeof x === 'string').slice(0, 50) : [],
      })),
    totals: {
      folders: count(totals.folders),
      lists: count(totals.lists),
      waypoints: count(totals.waypoints),
      tracks: count(totals.tracks),
      routes: count(totals.routes),
    },
    tree,
    unlisted: counts(p.unlisted),
    ambiguousCount: count(p.ambiguousCount),
    treeMissing: p.treeMissing === true,
    notConverted: notConverted
      .slice(0, LIMITS.notConverted)
      .filter((/** @type {any} */ n) => n && typeof n === 'object')
      .map((/** @type {any} */ n) => ({
        kind: n.kind === 'waypoint' || n.kind === 'route' ? n.kind : 'track',
        name: text(n.name, LIMITS.nameLength),
        reason: typeof n.reason === 'string' ? n.reason.slice(0, 64) : '',
        listIds: Array.isArray(n.listIds) ? n.listIds.filter((/** @type {unknown} */ x) => typeof x === 'string').slice(0, 50) : [],
      })),
    problems: normaliseProblems(problems).filter((problem) => problem.level !== 'dump'),
  };
}

/**
 * @param {unknown} list
 * @returns {Problem[]}
 */
export function normaliseProblems(list) {
  if (!Array.isArray(list)) return [];
  /** @type {Problem[]} */
  const out = [];
  for (const item of list.slice(0, LIMITS.problems)) {
    if (!item || typeof item !== 'object') continue;
    const p = /** @type {any} */ (item);
    const message = text(p.message, LIMITS.messageLength);
    if (message === '') continue;
    out.push({
      code: typeof p.code === 'string' ? p.code.slice(0, 64) : '',
      message,
      count: count(p.count) || 1,
      level: p.level === 'dump' ? 'dump' : 'report',
    });
  }
  return out;
}

/**
 * The name the browser saves the ZIP under: the worker's when it is a plain, safe file name.
 * @param {unknown} name
 * @param {Date} [now]
 */
export function safeZipName(name, now = new Date()) {
  if (typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,120}\.zip$/.test(name) && !name.includes('..')) {
    return name;
  }
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `foldertrail-export-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.zip`;
}

/**
 * Object.hasOwn needs Safari 15.4; this works on every browser the app supports.
 * @param {object} object
 * @param {PropertyKey} key
 */
function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** @param {unknown} v */
function isBlobLike(v) {
  return Boolean(v) && typeof v === 'object' && typeof (/** @type {any} */ (v).size) === 'number' && typeof (/** @type {any} */ (v).slice) === 'function';
}

// ---------------------------------------------------------------------------------------------
// The controller

/**
 * @typedef {"none"|"off"|"stored"|"checking"|"valid"|"invalid"} LicenceStatus
 *   off: not on sale (or no licence module); none: no key yet; stored: a key saved earlier, not yet checked
 *   in this session; checking; valid; invalid (the message says why)
 */

/**
 * @typedef {object} State
 * @property {"open"|"read"|"preview"|"done"|"error"} view
 * @property {"intake"|"parse"|"export"|null} busy
 * @property {string} phase       a PHASE_TEXT key
 * @property {number} done
 * @property {number|null} total  null when unknown
 * @property {string[]} openErrors   why the last thing given could not be used
 * @property {string|null} status    a short line, such as "Reading stopped."
 * @property {Problem[]} intakeNotes   from intake: worth telling, not limiting
 * @property {Problem[]} intakeProblems  from intake: limits the conversion, but a library was found
 * @property {string|null} versionFolder
 * @property {Preview|null} preview
 * @property {number} previewId    changes with every new preview (views redraw the tree only then)
 * @property {{text: string, json: string}|null} dump
 * @property {{status: LicenceStatus, message: string, hasStored: boolean}} licence
 * @property {{kml: boolean, perItem: boolean}} options
 * @property {string|null} exportError
 * @property {{blob: Blob, filename: string, size: number, reportText: string}|null} result
 * @property {string|null} error   the error view's message
 * @property {boolean} onSale
 */

/**
 * @typedef {object} WorkerLink
 * @property {(message: unknown) => void} post
 * @property {() => void} terminate
 */

/**
 * @typedef {object} ControllerDeps
 * @property {(input: unknown, options: {signal: AbortSignal, onProgress: (p: {phase: string, done: number, total: number|null}) => void}) => Promise<any>} intake
 * @property {(found: any) => unknown} toWorkerSource
 * @property {(onMessage: (data: unknown) => void, onFailure: (kind: "error"|"messageerror") => void) => WorkerLink} createWorker
 * @property {{verifyLicense: (key: string) => Promise<{ok: boolean, reason?: string, message?: string}>, getStoredLicense?: () => string|null, storeLicense?: (key: string) => void, clearLicense?: () => void, restoreLicense?: () => Promise<{ok: boolean, code?: string, message?: string}|null>}|null} [license]
 *   src/app/license.js; restoreLicense (optional) re-checks a saved key at most once per browser session
 * @property {boolean} onSale       CONFIG is set up (isConfigured())
 * @property {Support} [support]
 * @property {(state: State) => void} onChange
 * @property {(ms: number) => Promise<void>} [sleep]
 */

/**
 * @param {ControllerDeps} deps
 */
export function createController(deps) {
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const licence = deps.license ?? null;
  const onSale = deps.onSale === true && licence !== null && typeof licence.verifyLicense === 'function';

  let stored = null;
  if (onSale && typeof licence?.getStoredLicense === 'function') {
    try {
      const value = licence.getStoredLicense();
      stored = typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
    } catch {
      stored = null;
    }
  }

  /** @type {State} */
  let state = {
    view: 'open',
    busy: null,
    phase: 'starting',
    done: 0,
    total: null,
    openErrors: [],
    status: null,
    intakeNotes: [],
    intakeProblems: [],
    versionFolder: null,
    preview: null,
    previewId: 0,
    dump: null,
    licence: { status: onSale ? (stored ? 'stored' : 'none') : 'off', message: '', hasStored: stored !== null },
    options: { kml: true, perItem: false },
    exportError: null,
    result: null,
    error: null,
    onSale,
  };

  /** @type {WorkerLink|null} */
  let worker = null;
  /** The id of the library being read or held by the worker. An export carries the same id (the worker uses it to
   *  check it still holds that library), so a new id means a new library. */
  let messageId = 0;
  /** Exports that were cancelled but whose one closing answer (exported or error) has not arrived yet. */
  let exportsToDrop = 0;
  /** @type {AbortController|null} */
  let intakeAbort = null;
  let intakeRun = 0;

  /** @param {Partial<State>} patch */
  function set(patch) {
    state = { ...state, ...patch };
    try {
      deps.onChange(state);
    } catch {
      // a drawing failure must not break the flow
    }
  }

  function ensureWorker() {
    if (worker) return worker;
    worker = deps.createWorker(onWorkerMessage, onWorkerFailure);
    return worker;
  }

  function dropWorker() {
    if (!worker) return;
    try {
      worker.terminate();
    } catch {
      // already gone
    }
    worker = null;
  }

  /** @param {"error"|"messageerror"} kind */
  function onWorkerFailure(kind) {
    const wasBusy = state.busy;
    dropWorker();
    messageId++;
    exportsToDrop = 0;
    if (wasBusy === 'export') {
      set({ busy: null, exportError: TEXT.workerFailed });
      return;
    }
    if (wasBusy === 'parse') {
      const unsupported = deps.support ? !deps.support.moduleWorker : false;
      set({ view: 'error', busy: null, error: unsupported ? TEXT.workerUnsupported : TEXT.workerFailed });
    }
    // When nothing was running (say the preview is showing), the next download explains that the converter
    // has to start again; there is nothing to interrupt now.
    void kind;
  }

  /** @param {unknown} data */
  function onWorkerMessage(data) {
    if (!data || typeof data !== 'object') return;
    const msg = /** @type {any} */ (data);
    if (msg.id !== messageId) return;
    // The worker answers messages in order, and every export ends with exactly one 'exported' or 'error'. The
    // answers to cancelled exports come first, so they are dropped here, one each.
    if (exportsToDrop > 0 && (msg.type === 'exported' || msg.type === 'error') && state.busy !== 'parse') {
      exportsToDrop--;
      return;
    }
    if (state.busy !== 'parse' && state.busy !== 'export') return;
    switch (msg.type) {
      case 'progress': {
        const phase = typeof msg.phase === 'string' && hasOwn(PHASE_TEXT, msg.phase) ? msg.phase : state.phase;
        const total = typeof msg.total === 'number' && Number.isFinite(msg.total) && msg.total > 0 ? msg.total : null;
        const done = total === null ? 0 : Math.min(count(msg.done), total);
        set({ phase, done, total });
        return;
      }
      case 'parsed': {
        if (state.busy !== 'parse') return;
        const preview = normalisePreview(msg.preview);
        if (!preview) {
          set({ view: 'error', busy: null, error: TEXT.badReply });
          return;
        }
        const dump =
          msg.dump && typeof msg.dump === 'object'
            ? { text: text(msg.dump.text, LIMITS.dumpChars), json: text(msg.dump.json, LIMITS.dumpChars) }
            : null;
        if (preview.fatal) {
          // Nothing can be converted: say why, and keep the diagnostic report (it is what helps most here).
          set({ view: 'error', busy: null, error: preview.fatal.message, preview: null, dump: dump && (dump.text || dump.json) ? dump : null });
          return;
        }
        set({
          view: 'preview',
          busy: null,
          preview,
          previewId: state.previewId + 1,
          dump: dump && (dump.text || dump.json) ? dump : null,
          exportError: null,
          result: null,
          status: null,
        });
        return;
      }
      case 'exported': {
        if (state.busy !== 'export') return;
        if (!isBlobLike(msg.zip)) {
          set({ busy: null, exportError: `${TEXT.exportFailed} ${TEXT.badReply}` });
          return;
        }
        const report = msg.report && typeof msg.report === 'object' ? msg.report : {};
        set({
          view: 'done',
          busy: null,
          exportError: null,
          result: {
            blob: msg.zip,
            filename: safeZipName(msg.filename),
            size: count(msg.zip.size),
            reportText: text(report.text, LIMITS.reportChars),
          },
        });
        return;
      }
      case 'error': {
        const message = text(msg.message, LIMITS.messageLength) || TEXT.internal;
        if (state.busy === 'export') set({ busy: null, exportError: message });
        else set({ view: 'error', busy: null, error: message });
        return;
      }
      default:
    }
  }

  /**
   * Reads what the user gave (a DropCapture, a FileList or Files), then hands the library to the worker.
   * @param {unknown} input
   */
  async function open(input) {
    if (state.busy) return;
    const run = ++intakeRun;
    intakeAbort = typeof AbortController === 'function' ? new AbortController() : null;
    set({
      view: 'read',
      busy: 'intake',
      phase: 'listing',
      done: 0,
      total: null,
      openErrors: [],
      status: null,
      error: null,
    });
    /** @type {any} */
    let result;
    try {
      result = await deps.intake(input, {
        signal: /** @type {AbortSignal} */ (intakeAbort?.signal),
        onProgress: (p) => {
          if (run !== intakeRun || state.busy !== 'intake') return;
          const phase = p && hasOwn(PHASE_TEXT, p.phase) ? p.phase : 'listing';
          const total = p && typeof p.total === 'number' && p.total > 0 ? p.total : null;
          set({ phase, total, done: total === null ? 0 : Math.min(count(p.done), total) });
        },
      });
    } catch {
      result = null;
    }
    if (run !== intakeRun) return; // cancelled meanwhile
    intakeAbort = null;
    if (!result || typeof result !== 'object') {
      set({ view: 'open', busy: null, openErrors: [TEXT.internal] });
      return;
    }
    const problems = normaliseProblems(result.problems);
    if (problems.some((p) => p.code === 'cancelled')) {
      set({ view: 'open', busy: null, status: TEXT.cancelled });
      return;
    }
    if (result.ok !== true) {
      const messages = [...new Set(problems.map((p) => p.message))];
      set({ view: 'open', busy: null, openErrors: messages.length > 0 ? messages : [TEXT.internal] });
      return;
    }
    let source;
    try {
      source = deps.toWorkerSource(result.found);
    } catch {
      set({ view: 'open', busy: null, openErrors: [TEXT.internal] });
      return;
    }
    const versionFolder =
      typeof result.found?.version === 'string' && /^\d{1,3}(?:\.\d{1,3}){0,3}$/.test(result.found.version)
        ? result.found.version
        : null;
    messageId++;
    exportsToDrop = 0; // answers to the old library's exports now carry an old id, and are ignored anyway
    set({
      busy: 'parse',
      phase: 'reading',
      done: 0,
      total: null,
      intakeNotes: normaliseProblems(result.notes),
      intakeProblems: problems,
      versionFolder,
      preview: null,
      dump: null,
      result: null,
    });
    try {
      ensureWorker().post({ type: 'parse', id: messageId, source });
    } catch {
      dropWorker();
      set({ view: 'error', busy: null, error: deps.support && !deps.support.moduleWorker ? TEXT.workerUnsupported : TEXT.workerFailed });
    }
  }

  /** Stops whatever is running. */
  function cancel() {
    if (state.busy === 'intake') {
      intakeRun++;
      try {
        intakeAbort?.abort();
      } catch {
        // ignore
      }
      intakeAbort = null;
      set({ view: 'open', busy: null, status: TEXT.cancelled });
    } else if (state.busy === 'parse') {
      // Stopping the worker is the only way to stop its work; a new one starts with the next library.
      dropWorker();
      messageId++;
      exportsToDrop = 0;
      set({ view: 'open', busy: null, status: TEXT.cancelled, preview: null, dump: null });
    } else if (state.busy === 'export') {
      // The worker keeps the library, so it is not stopped: the answer to this export is dropped when it comes.
      exportsToDrop++;
      set({ busy: null, exportError: TEXT.exportCancelled });
    }
  }

  /**
   * Checks a licence key with the payment provider (through src/app/license.js).
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async function verify(key) {
    if (!onSale || !licence) {
      set({ licence: { ...state.licence, status: 'off', message: TEXT.noLicenceModule } });
      return false;
    }
    const clean = typeof key === 'string' ? key.trim() : '';
    if (clean === '') {
      set({ licence: { ...state.licence, status: 'invalid', message: TEXT.licenceEmpty } });
      return false;
    }
    if (clean.length > LIMITS.licenceKeyLength) {
      set({ licence: { ...state.licence, status: 'invalid', message: TEXT.licenceTooLong } });
      return false;
    }
    if (state.licence.status === 'checking') return false;
    set({ licence: { ...state.licence, status: 'checking', message: '' } });
    /** @type {{ok: boolean, message: string}} */
    let outcome;
    /** @type {unknown} */
    let answerStored = false;
    try {
      const answer = await Promise.race([
        Promise.resolve().then(() => licence.verifyLicense(clean)),
        sleep(LIMITS.licenceTimeoutMs).then(() => 'timeout'),
      ]);
      if (answer === 'timeout') outcome = { ok: false, message: TEXT.licenceTimeout };
      else if (answer && typeof answer === 'object' && /** @type {any} */ (answer).ok === true) {
        answerStored = /** @type {any} */ (answer).stored;
        outcome = { ok: true, message: text(/** @type {any} */ (answer).message, LIMITS.messageLength) || TEXT.licenceValid };
      } else {
        const message = answer && typeof answer === 'object' ? text(/** @type {any} */ (answer).message, LIMITS.messageLength) : '';
        outcome = { ok: false, message: message || TEXT.licenceFailed };
      }
    } catch {
      outcome = { ok: false, message: TEXT.licenceFailed };
    }
    if (outcome.ok) {
      try {
        // The licence module normally saves an accepted key itself (and says so with `stored`).
        if (!(answerStored === true)) licence.storeLicense?.(clean);
      } catch {
        // storage can be blocked (private windows); the licence still works for this visit
      }
      stored = clean;
      set({ licence: { status: 'valid', message: outcome.message, hasStored: true } });
      return true;
    }
    set({ licence: { ...state.licence, status: 'invalid', message: outcome.message } });
    return false;
  }

  let restoreDone = false;

  /**
   * When the page opens: re-checks a key saved in this browser through license.js restoreLicense(), which asks the
   * provider at most once per browser session. Runs once per page; does nothing when not on sale, when no key is
   * saved, or when the licence module has no restoreLicense. If the user checks a key or removes the saved one
   * meanwhile, the late answer is ignored. Never throws.
   * @returns {Promise<void>}
   */
  async function restoreLicence() {
    if (restoreDone) return;
    restoreDone = true;
    if (!onSale || !licence || typeof licence.restoreLicense !== 'function' || state.licence.status !== 'stored') return;
    const restore = licence.restoreLicense;
    set({ licence: { ...state.licence, message: TEXT.licenceRestoring } });
    /** @type {unknown} */
    let answer = null;
    try {
      answer = await Promise.race([
        Promise.resolve().then(() => restore()),
        sleep(LIMITS.licenceTimeoutMs).then(() => null),
      ]);
    } catch {
      answer = null;
    }
    if (state.licence.status !== 'stored') return; // the user acted first: their check stands
    const result = /** @type {any} */ (answer && typeof answer === 'object' ? answer : {});
    if (result.ok === true) {
      set({ licence: { status: 'valid', message: TEXT.licenceRestored, hasStored: true } });
    } else if (result.ok === false && (result.code === 'invalid' || result.code === 'refunded')) {
      // license.js has already removed the key from this browser.
      stored = null;
      set({ licence: { status: 'invalid', message: TEXT.licenceSavedRejected, hasStored: false } });
    } else {
      // Nothing decided (no answer, or nothing saved after all): the key is checked at download, as before.
      set({ licence: { ...state.licence, message: '' } });
    }
  }

  /** Forgets the saved key (this browser only). */
  function forgetLicence() {
    try {
      licence?.clearLicense?.();
    } catch {
      // ignore
    }
    stored = null;
    if (onSale) set({ licence: { status: 'none', message: '', hasStored: false } });
  }

  /** @param {{kml?: boolean, perItem?: boolean}} patch */
  function setOptions(patch) {
    set({
      options: {
        kml: typeof patch.kml === 'boolean' ? patch.kml : state.options.kml,
        perItem: typeof patch.perItem === 'boolean' ? patch.perItem : state.options.perItem,
      },
    });
  }

  /** Asks the worker for the ZIP; only after the licence check passed (an honesty gate, not DRM). */
  async function download() {
    if (state.busy || !state.preview || !worker) {
      if (!worker && state.preview) set({ exportError: `${TEXT.exportFailed} ${TEXT.workerFailed}` });
      return;
    }
    if (!onSale) return;
    if (state.licence.status !== 'valid') {
      const key = state.licence.status === 'stored' || state.licence.status === 'invalid' ? stored : null;
      if (!key) {
        set({ licence: { ...state.licence, status: 'invalid', message: TEXT.licenceEmpty } });
        return;
      }
      if (!(await verify(key))) return;
    }
    set({ busy: 'export', phase: 'exporting', done: 0, total: null, exportError: null });
    try {
      worker.post({ type: 'export', id: messageId, options: { kml: state.options.kml, perItem: state.options.perItem } });
    } catch {
      dropWorker();
      set({ busy: null, exportError: `${TEXT.exportFailed} ${TEXT.workerFailed}` });
    }
  }

  /** Back to the start; the worker (and the library it holds) is let go. */
  function reset() {
    if (state.busy === 'intake') cancel();
    dropWorker();
    messageId++;
    exportsToDrop = 0;
    set({
      view: 'open',
      busy: null,
      openErrors: [],
      status: null,
      intakeNotes: [],
      intakeProblems: [],
      versionFolder: null,
      preview: null,
      dump: null,
      exportError: null,
      result: null,
      error: null,
      licence: { ...state.licence, message: state.licence.status === 'invalid' ? '' : state.licence.message },
    });
  }

  /** From the error view: back to the preview when there is one, else to the start. */
  function dismissError() {
    if (state.preview && worker) set({ view: 'preview', error: null });
    else reset();
  }

  return {
    get state() {
      return state;
    },
    open,
    cancel,
    verify,
    restoreLicence,
    forgetLicence,
    setOptions,
    download,
    reset,
    dismissError,
  };
}
