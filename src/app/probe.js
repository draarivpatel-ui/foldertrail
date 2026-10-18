// The M0 drop probe (decision B30, ARCHITECTURE.md §16): a bare local page that shows how this browser
// hands over a dropped or picked folder, package or ZIP, and what intake.js makes of it.
// It shows names relative to the drop root and sizes on the page only. The summary meant for the M0 log
// is built from numbers, fixed words and codes, never from a name. No network: the page's CSP forbids it,
// and nothing here asks for it.

import { captureDrop, intake, canInflateRaw } from './intake.js';

const KNOWN_EXTENSIONS = new Set(['bclibrary', 'backup', 'zip', 'gdb', 'gfi', 'gpx']);
// MIME types and drag types can be any text an app puts there, so the summary names only these.
const KNOWN_TYPES = new Set([
  '',
  'Files',
  'text/plain',
  'text/uri-list',
  'text/html',
  'application/zip',
  'application/x-zip',
  'application/x-zip-compressed',
  'application/octet-stream',
  'application/gpx+xml',
  'application/vnd.google-earth.kml+xml',
]);
const MAX_ROWS_SHOWN = 5000;

/**
 * @typedef {object} Feature
 * @property {string} key
 * @property {string} label
 * @property {boolean|null} value  null when it cannot be tested here
 */

/**
 * What this browser offers, by feature detection only (never by version).
 * @returns {Feature[]}
 */
export function detectFeatures() {
  /** @param {() => unknown} test */
  const has = (test) => {
    try {
      return Boolean(test());
    } catch {
      return false;
    }
  };
  const dom = typeof document !== 'undefined';
  return [
    {
      key: 'webkitGetAsEntry',
      label: 'Folder drop (DataTransferItem.webkitGetAsEntry)',
      value: typeof DataTransferItem === 'function' ? 'webkitGetAsEntry' in DataTransferItem.prototype : null,
    },
    {
      key: 'webkitdirectory',
      label: 'Folder picker (<input webkitdirectory>)',
      value: dom ? 'webkitdirectory' in document.createElement('input') : null,
    },
    { key: 'inflateRaw', label: 'Read compressed backups (DecompressionStream "deflate-raw")', value: canInflateRaw() },
    {
      key: 'deflateRaw',
      label: 'Write compressed ZIPs (CompressionStream "deflate-raw")',
      value: has(() => typeof CompressionStream === 'function' && new CompressionStream(/** @type {any} */ ('deflate-raw'))),
    },
    {
      key: 'blobStream',
      label: 'Blob.stream()',
      value: typeof Blob === 'function' && typeof Blob.prototype.stream === 'function',
    },
  ];
}

/**
 * The class of a name's extension, without the name: ".bclibrary", ".backup", ".zip", ".gdb", ".gfi",
 * ".gpx", "(other)" or "(none)".
 * @param {unknown} name
 * @returns {string}
 */
export function extensionClass(name) {
  if (typeof name !== 'string') return '(none)';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '(none)';
  const ext = name.slice(dot + 1).toLowerCase();
  return KNOWN_EXTENSIONS.has(ext) ? `.${ext}` : '(other)';
}

/**
 * The structure-only summary for the M0 log: numbers, fixed words and codes. No name, path or time.
 * @param {object} args
 * @param {string} args.how                 how it was given ("drop", "folder picker", "file picker")
 * @param {Feature[]} args.features
 * @param {string} args.userAgent           shown so the log says which browser; it is not the user's data
 * @param {import('./intake.js').DropCapture|null} [args.capture]
 * @param {{count: number, withRelativePath: number}|null} [args.fileList]
 * @param {import('./intake.js').IntakeResult} args.result
 * @param {number} args.totalMs
 * @returns {string}
 */
export function buildSummary({ how, features, userAgent, capture = null, fileList = null, result, totalMs }) {
  const lines = [];
  lines.push('Drop probe (M0) summary');
  lines.push(`Browser: ${oneLine(userAgent)}`);
  lines.push(`Features: ${features.map((f) => `${f.key}=${yesNo(f.value)}`).join(', ')}`);
  lines.push(`Given by: ${word(how, /^[a-z ()-]{1,40}$/)}`);
  if (capture) {
    lines.push(
      `DataTransfer: types=[${capture.types.map(knownType).join(', ')}], ` +
        `items=${capture.itemCount}, files=${capture.fileCount}, entry API used=${yesNo(capture.entryApi)}, ` +
        `files list used=${yesNo(capture.usedFiles)}`,
    );
    capture.raw.forEach((item, i) => {
      const file =
        item.fileName === null && item.fileSize === null
          ? 'none'
          : `size ${item.fileSize ?? '?'}, type "${knownType(item.fileType ?? '')}"`;
      lines.push(
        `  item ${i + 1}: kind=${word(item.kind, /^[a-z-]{1,20}$/)}, entry=${item.entry}, ` +
          `extension=${extensionClass(item.name ?? item.fileName)}, fullPath depth=${depth(item.fullPath)}, getAsFile: ${file}`,
      );
    });
  }
  if (fileList) lines.push(`File list: files=${fileList.count}, with webkitRelativePath=${fileList.withRelativePath}`);
  const input = result.input;
  const roles = input.roles;
  lines.push(
    `Intake: library found=${yesNo(result.ok)}, came in=${input.kind ?? 'none'}, delivered as=${input.delivery}, ` +
      `version folder=${result.found.version ?? 'none'}`,
  );
  lines.push(
    `Counts: top-level folders=${input.topFolders}, top-level files=${input.topFiles}, files=${input.files}, ` +
      `folders=${input.folders}, skipped=${input.skipped}, folders with AllData.gdb=${input.libraryFolders}, ` +
      `Windows signs=${input.windowsSigns}`,
  );
  lines.push(
    `Roles: AllData.gdb=${roles.allData}, FolderData.gfi=${roles.folderData}, TrackSegments=${roles.trackSegments} ` +
      `(not UUID-named ${roles.trackSegmentsOtherNames}, empty ${roles.trackSegmentsEmpty})`,
  );
  if (input.archiveEntries !== null) lines.push(`Backup: entries=${input.archiveEntries}, ZIP64=${yesNo(input.archiveZip64)}`);
  lines.push(`Problems: ${codeList(result.problems)}`);
  lines.push(`Notes: ${codeList(result.notes)}`);
  lines.push(
    `Time: listing ${result.timings.listMs} ms, statting ${result.timings.statMs} ms, total ${Math.round(totalMs)} ms`,
  );
  const rows = result.listing ? result.listing.length : 0;
  lines.push(`Items listed: ${rows}${result.listingOmitted ? ` (+${result.listingOmitted} beyond the listing limit)` : ''}`);
  return lines.join('\n');
}

/** @param {boolean|null|undefined} value */
function yesNo(value) {
  return value === true ? 'yes' : value === false ? 'no' : 'untested';
}

/**
 * A browser-made word (a MIME type, an item kind) when it has the expected shape, else "(other)".
 * @param {unknown} value
 * @param {RegExp} shape
 */
function word(value, shape) {
  return typeof value === 'string' && shape.test(value) ? value : '(other)';
}

/** @param {unknown} value  a MIME or drag type from the known list, else "(other)" */
function knownType(value) {
  return typeof value === 'string' && KNOWN_TYPES.has(value) ? value : '(other)';
}

/** @param {unknown} text */
function oneLine(text) {
  return typeof text === 'string' ? text.replace(/[\r\n]+/g, ' ').slice(0, 400) : '(unknown)';
}

/** @param {unknown} fullPath  number of non-empty segments, or "none" */
function depth(fullPath) {
  if (typeof fullPath !== 'string') return 'none';
  return String(fullPath.split('/').filter((s) => s !== '').length);
}

/** @param {import('../model.js').Problem[]} list */
function codeList(list) {
  return list.length ? list.map((p) => `${p.code}×${p.count}`).join(', ') : 'none';
}

// ---------------------------------------------------------------------------------------------
// The page (skipped when this module is imported by the Node tests)

if (typeof document !== 'undefined' && typeof window !== 'undefined') init();

function init() {
  /** @param {string} id @returns {any} */
  const $ = (id) => document.getElementById(id);
  $('not-loaded').hidden = true;

  const features = detectFeatures();
  const featureBody = $('features').tBodies[0];
  for (const feature of features) {
    const tr = row(featureBody);
    cell(tr, feature.label);
    cell(tr, yesNo(feature.value), feature.value === true ? 'ok' : feature.value === false ? 'bad' : '');
  }
  $('ua').textContent = navigator.userAgent;

  /** @type {AbortController|null} */
  let controller = null;
  let dragDepth = 0;

  window.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth++;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove('dragging');
  });
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    // Captured now: the browser empties the DataTransfer when this handler returns.
    const capture = captureDrop(event.dataTransfer);
    void run('drop', capture, capture, null);
  });
  for (const [id, how] of [
    ['pick-folder', 'folder picker'],
    ['pick-files', 'file picker'],
  ]) {
    $(id).addEventListener('change', (/** @type {Event} */ event) => {
      const input = /** @type {HTMLInputElement} */ (event.target);
      const files = Array.from(input.files ?? []);
      input.value = '';
      const withRelativePath = files.filter((f) => typeof f.webkitRelativePath === 'string' && f.webkitRelativePath !== '').length;
      void run(how, files, null, { count: files.length, withRelativePath });
    });
  }
  $('cancel').addEventListener('click', () => controller?.abort());

  /**
   * @param {string} how
   * @param {unknown} input
   * @param {import('./intake.js').DropCapture|null} capture
   * @param {{count: number, withRelativePath: number}|null} fileList
   */
  async function run(how, input, capture, fileList) {
    if (controller) controller.abort();
    const mine = new AbortController();
    controller = mine;
    $('cancel').disabled = false;
    const started = performance.now();
    let painted = 0;
    setStatus('Reading…');
    const result = await intake(input, {
      listing: true,
      signal: mine.signal,
      onProgress: (p) => {
        const t = performance.now();
        if (t - painted < 100) return;
        painted = t;
        if (p.phase === 'listing') setStatus(`Listing folders… ${p.done}`);
        else if (p.phase === 'stat') setStatus(`Checking file sizes… ${p.done} of ${p.total ?? '?'}`);
        else setStatus('Opening the backup…');
      },
    });
    if (controller !== mine) return; // a newer drop replaced this one
    controller = null;
    $('cancel').disabled = true;
    const totalMs = performance.now() - started;
    setStatus(result.ok ? 'Done: a library was found.' : 'Done: no usable library was found (see Problems).');
    render(how, capture, fileList, result, totalMs, features);
  }

  /** @param {string} text */
  function setStatus(text) {
    $('status').textContent = text;
  }

  /**
   * @param {string} how
   * @param {import('./intake.js').DropCapture|null} capture
   * @param {{count: number, withRelativePath: number}|null} fileList
   * @param {import('./intake.js').IntakeResult} result
   * @param {number} totalMs
   * @param {Feature[]} feats
   */
  function render(how, capture, fileList, result, totalMs, feats) {
    $('out').hidden = false;
    $('summary').textContent = buildSummary({ how, features: feats, userAgent: navigator.userAgent, capture, fileList, result, totalMs });

    const delivery = $('delivery').tBodies[0];
    delivery.textContent = '';
    if (capture) {
      $('delivery-note').textContent =
        `${capture.itemCount} item(s) and ${capture.fileCount} file(s) in the DataTransfer; types: ` +
        `${capture.types.join(', ') || 'none'}.` +
        (capture.usedFiles ? ' The items gave no entries or files, so DataTransfer.files was used.' : '');
      capture.raw.forEach((item, i) => {
        const tr = row(delivery);
        cell(tr, String(i + 1), 'num');
        cell(tr, item.kind);
        cell(tr, item.type);
        cell(tr, item.entry);
        cell(tr, item.name ?? '');
        cell(tr, item.fullPath ?? '', 'mono');
        cell(tr, item.fileName ?? '');
        cell(tr, item.fileSize === null ? '' : String(item.fileSize), 'num');
        cell(tr, item.fileType ?? '');
      });
    } else if (fileList) {
      $('delivery-note').textContent =
        `Picked with the ${how}: ${fileList.count} file(s), ${fileList.withRelativePath} with a webkitRelativePath.`;
    }

    const found = result.found;
    const resultBody = $('result').tBodies[0];
    resultBody.textContent = '';
    /** @type {[string, string, string?][]} */
    const facts = [
      ['Library found', result.ok ? 'yes' : 'no', result.ok ? 'ok' : 'bad'],
      ['Given by', how],
      ['Delivered as', result.input.delivery],
      ['Library came in', result.input.kind ?? 'none'],
      ['Folder used', found.versionFolder === null ? 'none' : found.versionFolder || '(the top level)'],
      ['Version folder', found.version ?? 'none'],
      ['AllData.gdb', found.allData ? `${found.allData.path} (${found.allData.size} bytes, ${found.allData.origin})` : 'none'],
      ['FolderData.gfi', found.folderData ? `${found.folderData.path} (${found.folderData.size} bytes)` : 'none'],
      ['TrackSegments files', String(found.trackSegments.size)],
      ['Time', `listing ${result.timings.listMs} ms, statting ${result.timings.statMs} ms, total ${Math.round(totalMs)} ms`],
    ];
    for (const [label, value, cls] of facts) {
      const tr = row(resultBody);
      cell(tr, label);
      cell(tr, value, cls ?? '');
    }

    for (const [id, list] of /** @type {[string, import('../model.js').Problem[]][]} */ ([
      ['problems', result.problems],
      ['notes', result.notes],
    ])) {
      const body = $(id).tBodies[0];
      body.textContent = '';
      if (list.length === 0) {
        const tr = row(body);
        cell(tr, 'none');
        cell(tr, '');
        cell(tr, '');
      }
      for (const p of list) {
        const tr = row(body);
        cell(tr, p.code, 'mono');
        cell(tr, String(p.count), 'num');
        cell(tr, p.message);
      }
    }

    const listing = result.listing ?? [];
    const listBody = $('listing').tBodies[0];
    listBody.textContent = '';
    const shown = Math.min(listing.length, MAX_ROWS_SHOWN);
    $('listing-note').textContent =
      `${listing.length} item(s)` +
      (result.listingOmitted ? `, and ${result.listingOmitted} more beyond the listing limit` : '') +
      (shown < listing.length ? `; the first ${shown} are shown` : '') +
      '.';
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < shown; i++) {
      const item = listing[i];
      const tr = document.createElement('tr');
      if (item.skipped) tr.className = 'skipped';
      cell(tr, item.path, 'mono');
      cell(tr, item.kind);
      cell(tr, item.size === null ? '' : String(item.size), 'num');
      cell(tr, item.role ?? '');
      cell(tr, item.inArchive ? 'yes' : '');
      cell(tr, item.skipped ?? '');
      fragment.appendChild(tr);
    }
    listBody.appendChild(fragment);
  }
}

/**
 * @param {HTMLTableSectionElement} body
 * @returns {HTMLTableRowElement}
 */
function row(body) {
  const tr = document.createElement('tr');
  body.appendChild(tr);
  return tr;
}

/**
 * Text only (never HTML): names come from the user's disk and are hostile.
 * @param {HTMLTableRowElement} tr
 * @param {string} text
 * @param {string} [className]
 */
function cell(tr, text, className) {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  tr.appendChild(td);
}
