// The conversion report: what converted, what did not and why, by name (report.txt and report.html).
//
// The report is the user's own: it lives in their download, on their computer, so it names their items and lists.
// It is never part of the structure-only diagnostic dump, and nothing here is sent anywhere. Every sentence is
// plain and honest: what was skipped is said, and why.
//
// report.html is a stand-alone file opened from disk: one inline <style>, no scripts, every value escaped.

import { trackShape } from '../format/library.js';

/** @typedef {import('../model.js').Library} Library */
/** @typedef {import('../model.js').Item} Item */
/** @typedef {import('../model.js').Problem} Problem */
/** @typedef {import('../format/library.js').ReadDetails} ReadDetails */

/** Why something was not converted, in plain words, by NotConverted.reason. */
export const REASONS = Object.freeze({
  waypoint_not_decoded: 'its record could not be read',
  track_not_decoded: 'its record did not match a known track layout, so its points could not be read safely',
  route_autoroute: 'it follows roads (BaseCamp calculated it), and this version cannot convert routes like that',
  route_not_decoded: 'its record could not be decoded',
  route_via_unresolved: 'one or more of its via points could not be found in the library',
});

/** Why a converted track has no elevation and time, by ReadDetails.elevationTime value. */
const ELEVATION_TIME = Object.freeze({
  missing: 'no elevation and time file was found for it',
  not_decoded: 'its elevation and time file could not be decoded (it may hold sensor data this version cannot read)',
  mismatch: 'its elevation and time file does not match its points',
  unreadable: 'its elevation and time file could not be read',
});

const KIND_WORD = Object.freeze({ waypoint: 'Waypoint', track: 'Track', route: 'Route' });

/** Limits of this version, stated in every report (ARCHITECTURE.md §7). */
export const LIMITS = Object.freeze([
  'Routes are converted as straight lines through their via points. Road-following routes are listed above, not converted.',
  'Waypoint addresses, phone numbers and categories are not exported.',
  'BirdsEye imagery, custom maps, Adventures, geocache logs and photos are not converted.',
  'Heart rate and air temperature readings in tracks are kept in the GPX files only; the KML file does not hold them. Other sensor readings, such as cadence, are not read.',
  "How this tool reads BaseCamp's files was worked out from public notes, not from Garmin. Check important items against BaseCamp.",
]);

/**
 * @typedef {object} ExportSummary
 * @property {number} files          files in the download (GPX, KML, report)
 * @property {boolean} kml
 * @property {boolean} perItem
 * @property {Problem[]} [writerProblems]  what the GPX/KML writers and the path planner had to change or leave out
 */

/**
 * @typedef {object} ReportInput
 * @property {Library} library
 * @property {ReadDetails} [details]
 * @property {ExportSummary|null} [exported]  null for a report made before any download
 * @property {Problem[]} [sourceProblems]     problems from finding the library (intake), plain words
 * @property {string} [brand]
 * @property {string} [version]
 * @property {number} [now]                   ms since epoch
 * @property {string|null} [libraryVersion]   the version folder, e.g. "4.8" (BaseCamp's own name, never a path)
 */

/**
 * @typedef {object} ReportSection
 * @property {string} title
 * @property {string[]} [paragraphs]
 * @property {string[]} [items]
 */

/**
 * Builds the report as text and as HTML.
 * @param {ReportInput} input
 * @returns {{text: string, html: string}}
 */
export function buildReport(input) {
  const sections = reportSections(input);
  const brand = clean(input.brand ?? 'Foldertrail') || 'Foldertrail';
  const title = `${brand} report`;
  return { text: renderText(title, sections), html: renderHtml(title, sections) };
}

/**
 * The report's content, as sections (shared by the text and HTML renderings).
 * @param {ReportInput} input
 * @returns {ReportSection[]}
 */
export function reportSections(input) {
  const library = input.library;
  const details = input.details;
  const brand = clean(input.brand ?? 'Foldertrail') || 'Foldertrail';
  const items = Array.isArray(library?.items) ? library.items : [];
  const folders = Array.isArray(library?.folders) ? library.folders : [];
  const paths = folderPaths(folders);
  /** @param {string[]} ids */
  const where = (ids) => ids.map((id) => paths.get(id)).filter((p) => p !== undefined).join('; ');

  /** @type {ReportSection[]} */
  const sections = [];
  const date = new Date(Number.isFinite(input.now) ? /** @type {number} */ (input.now) : Date.now());
  const made = `Made on ${isoDate(date)} by ${brand}${input.version ? ` ${clean(input.version)}` : ''}.`;
  const intro = [
    `${made} This report was made on your computer and was not sent anywhere.`,
  ];
  const libraryLine = [];
  if (library?.meta?.version) libraryLine.push(`file format version ${clean(library.meta.version)}`);
  if (input.libraryVersion) libraryLine.push(`from the folder ${clean(input.libraryVersion)}`);
  if (libraryLine.length > 0) intro.push(`Library: ${libraryLine.join(', ')}.`);
  if (details?.experimental) {
    intro.push('This library is in a format version this tool was not built for. Treat the result as experimental.');
  }
  if (details?.fatal) intro.push(`Nothing was converted: ${clean(details.fatal.message)}`);
  sections.push({ title: 'Summary', paragraphs: intro });

  // Converted.
  const counts = { waypoint: 0, track: 0, route: 0 };
  let withElevationTime = 0;
  let withSensors = 0;
  for (const item of items) {
    counts[item.kind]++;
    if (item.kind === 'track') {
      const shape = trackShape(item);
      if (shape.withElevation || shape.withTime) withElevationTime++;
      if (shape.withHeartRate || shape.withTemperature) withSensors++;
    }
  }
  const lists = folders.filter((f) => f.type === 'list').length;
  const subfolders = folders.filter((f) => f.type === 'folder' && f.parentId !== null).length;
  const converted = [
    `Waypoints: ${counts.waypoint}`,
    `Tracks: ${counts.track}${
      counts.track > 0
        ? ` (${withElevationTime} with elevation or time${withSensors > 0 ? `, ${withSensors} with heart rate or temperature` : ''})`
        : ''
    }`,
    `Routes: ${counts.route}`,
  ];
  if (library?.treeMissing) {
    converted.push('Folders and lists: none could be rebuilt, so items were grouped by type.');
  } else {
    converted.push(`Lists: ${lists}`, `Folders: ${subfolders} (not counting the top folder)`);
    if (details?.multiListItems) {
      converted.push(`Items in more than one list: ${details.multiListItems} (written into each of those lists)`);
    }
    const ambiguous = new Set(library.ambiguous ?? []);
    const listed = new Set(folders.flatMap((f) => f.itemIds));
    const unlisted = items.filter((i) => !listed.has(i.id) && !ambiguous.has(i.id)).length;
    if (unlisted > 0) converted.push(`Items in no list: ${unlisted} (in "Not in any list")`);
    if (ambiguous.size > 0) converted.push(`Items whose list could not be decided: ${ambiguous.size} (in "_Duplicate names")`);
  }
  if (input.exported) {
    const e = input.exported;
    converted.push(
      `Download: ${e.files} file${e.files === 1 ? '' : 's'}; ${e.perItem ? 'one GPX file per item' : 'one GPX file per list'}` +
        `${e.kml ? ', plus one KML file with your folders' : ''}.`,
    );
  }
  sections.push({ title: 'Converted', items: converted });

  // Not converted, by name.
  const notConverted = Array.isArray(library?.notConverted) ? library.notConverted : [];
  if (notConverted.length > 0) {
    sections.push({
      title: 'Not converted',
      paragraphs: ['These items are in your library but are not in the download.'],
      items: notConverted.map((n) => {
        const kind = KIND_WORD[n.kind] ?? 'Item';
        const reason = /** @type {Record<string, string>} */ (REASONS)[n.reason] ?? 'it could not be read';
        const inLists = where(n.listIds ?? []);
        return `${kind} "${clean(n.name)}": ${reason}.${inLists ? ` In: ${inLists}.` : ''}`;
      }),
    });
  }

  // Duplicate names.
  const duplicates = details?.duplicates ?? [];
  if (duplicates.length > 0) {
    sections.push({
      title: 'Duplicate names',
      paragraphs: [
        'Your lists name these items, but the library holds more than one item of that kind with the same name, so it cannot tell which copy belongs in which list. This tool does not guess: every copy is in the "_Duplicate names" folder. Put them back in their lists by hand.',
      ],
      items: duplicates.map((d) => {
        const kind = KIND_WORD[d.kind] ?? 'Item';
        const inLists = where(d.listIds);
        return `${kind} "${clean(d.name)}": ${d.copies} copies${inLists ? `. Named by: ${inLists}` : ''}.`;
      }),
    });
  }

  // Tracks without elevation and time.
  /** @type {string[]} */
  const lostDetail = [];
  if (details?.elevationTime) {
    for (const item of items) {
      if (item.kind !== 'track') continue;
      const status = details.elevationTime.get(item.id);
      const why = status ? /** @type {Record<string, string>} */ (ELEVATION_TIME)[status] : undefined;
      if (why) lostDetail.push(`"${clean(item.name)}": ${why}.`);
    }
  }
  if (lostDetail.length > 0) {
    sections.push({
      title: 'Tracks without elevation and time',
      paragraphs: ['These tracks were converted with their positions only.'],
      items: lostDetail,
    });
  }

  // Problems, in plain words (report level only).
  const problems = [...(input.sourceProblems ?? []), ...(library?.problems ?? []), ...(input.exported?.writerProblems ?? [])]
    .filter((p) => p && (p.level ?? 'report') === 'report' && typeof p.message === 'string');
  if (problems.length > 0) {
    sections.push({
      title: 'Notes and problems',
      items: problems.map((p) => `${clean(p.message)}${p.count > 1 ? ` (${p.count})` : ''}`),
    });
  }

  sections.push({ title: 'Limits of this version', items: [...LIMITS] });
  return sections;
}

/**
 * "My Collection / Hiking / Day 1" for every folder and list. Iterative, with a guard against loops.
 * @param {import('../model.js').Folder[]} folders
 * @returns {Map<string, string>}
 */
export function folderPaths(folders) {
  const byId = new Map();
  for (const f of folders) if (f && typeof f.id === 'string' && !byId.has(f.id)) byId.set(f.id, f);
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const folder of byId.values()) {
    /** @type {string[]} */
    const names = [];
    /** @type {Set<string>} */
    const seen = new Set();
    let at = folder;
    while (at && !seen.has(at.id) && names.length < 64) {
      seen.add(at.id);
      names.unshift(clean(at.name) || 'Untitled');
      at = at.parentId === null || at.parentId === undefined ? null : byId.get(at.parentId);
    }
    out.set(folder.id, names.join(' / '));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Rendering

/**
 * Makes a value safe to put inside one line of the report, and trims it:
 * - line and paragraph breaks and tabs become one space, so a name cannot start a line of its own in report.txt
 *   (a fake "  - Track ...: converted" item);
 * - other control characters are removed (they would garble a text file);
 * - bidirectional embedding, override and isolate controls are removed, so a name cannot reorder the rest of its
 *   line (the reason after it); paths.js and zip.js refuse the same characters in file names.
 * @param {unknown} value
 * @returns {string}
 */
function clean(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/ *[\t\n\v\f\r\u0085\u2028\u2029]+ */g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim();
}

/** @param {Date} d */
function isoDate(d) {
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * @param {string} title
 * @param {ReportSection[]} sections
 * @returns {string}
 */
function renderText(title, sections) {
  let out = `${title}\n${'='.repeat(title.length)}\n`;
  for (const s of sections) {
    out += `\n${s.title}\n${'-'.repeat(s.title.length)}\n`;
    for (const p of s.paragraphs ?? []) out += `${p}\n`;
    for (const item of s.items ?? []) out += `  - ${item}\n`;
  }
  return out;
}

/** @param {string} s */
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/**
 * @param {string} title
 * @param {ReportSection[]} sections
 * @returns {string}
 */
function renderHtml(title, sections) {
  let body = `<h1>${escapeHtml(title)}</h1>\n`;
  for (const s of sections) {
    body += `<section>\n<h2>${escapeHtml(s.title)}</h2>\n`;
    for (const p of s.paragraphs ?? []) body += `<p>${escapeHtml(p)}</p>\n`;
    if (s.items && s.items.length > 0) {
      body += '<ul>\n';
      for (const item of s.items) body += `<li>${escapeHtml(item)}</li>\n`;
      body += '</ul>\n';
    }
    body += '</section>\n';
  }
  return (
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    `<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">\n` +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<title>${escapeHtml(title)}</title>\n` +
    `<style>${REPORT_CSS}</style>\n</head>\n<body>\n` +
    body +
    '</body>\n</html>\n'
  );
}

/** The report's only style, inline because the file is opened on its own from disk. */
const REPORT_CSS =
  '\n' +
  ':root{color-scheme:light dark;--fg:#1d1d1f;--bg:#fff;--muted:#555;--rule:#ddd}\n' +
  '@media (prefers-color-scheme:dark){:root{--fg:#f2f2f2;--bg:#1c1c1e;--muted:#aaa;--rule:#444}}\n' +
  'body{font:16px/1.5 -apple-system,system-ui,sans-serif;color:var(--fg);background:var(--bg);max-width:46rem;margin:2rem auto;padding:0 1rem}\n' +
  'h1{font-size:1.6rem}h2{font-size:1.15rem;margin-top:2rem;border-bottom:1px solid var(--rule);padding-bottom:.25rem}\n' +
  'li{margin:.25rem 0;overflow-wrap:anywhere}p{color:var(--muted)}\n';

/**
 * report.html is opened later from the user's disk (file://), where the site's HTTP header policy does not apply, so
 * it carries its own. Everything in it is escaped text; this is the second layer, in case that ever breaks: no
 * script runs, nothing loads from anywhere (no image, font or stylesheet that would tell a server the report was
 * opened), no form posts, and only REPORT_CSS styles the page (by its SHA-256, so an injected <style> could not hide
 * a section). Change REPORT_CSS and this hash together: test/report.test.js recomputes it.
 */
const REPORT_CSP =
  "default-src 'none'; style-src 'sha256-AGp12q82onWK/XrY1VGiu3QSZb8DnVSqHzZzda2v7W4='; base-uri 'none'; form-action 'none'";
