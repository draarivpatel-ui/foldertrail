// KML 2.2 writer (http://www.opengis.net/kml/2.2). One document whose <Folder>s nest exactly like
// the BaseCamp folders and lists (from the repaired tree in paths.js), with a Placemark per item:
// waypoints as Points, tracks and routes as LineStrings clamped to the ground. Items that no list
// mentions go in a last folder named "Unfiled". As in BaseCamp, an item in several lists appears
// in each of those lists' folders.
//
// Element order follows the OGC KML 2.2 schema: a Feature's name, description and styleUrl come in
// that order before its geometry; a Document's Styles come before its Folders; inside a LineString
// the order is tessellate, altitudeMode, coordinates.

import { buildFolderTree } from './paths.js';
import { fastEle, fastLat, fastLon, garminColor } from './gpx.js';
import { MAX_ELEVATION_M, MIN_ELEVATION_M, Tally, WRITER_MESSAGES, escapeText, textOf } from './xml.js';

/** @typedef {import('../model.js').Item} Item */
/** @typedef {import('../model.js').Library} Library */
/** @typedef {import('../model.js').Problem} Problem */
/** @typedef {import('./paths.js').FolderTree} FolderTree */
/** @typedef {import('./paths.js').TreeNode} TreeNode */

export const KML_NS = 'http://www.opengis.net/kml/2.2';

// KML colours are aabbggrr. We found no published RGB values for Garmin's display colours; these
// are approximations from the classic 16-colour palette the names appear to come from (an
// assumption, not a measurement). Transparent is left out on purpose: alpha 00 would make the track invisible, so
// such tracks use the default style.
/** @type {Readonly<Record<string, string>>} */
export const KML_TRACK_COLORS = Object.freeze({
  Black: 'ff000000',
  DarkRed: 'ff000080',
  DarkGreen: 'ff008000',
  DarkYellow: 'ff008080',
  DarkBlue: 'ff800000',
  DarkMagenta: 'ff800080',
  DarkCyan: 'ff808000',
  LightGray: 'ffc0c0c0',
  DarkGray: 'ff808080',
  Red: 'ff0000ff',
  Green: 'ff00ff00',
  Yellow: 'ff00ffff',
  Blue: 'ffff0000',
  Magenta: 'ffff00ff',
  Cyan: 'ffffff00',
  White: 'ffffffff',
});

// Our own defaults (not BaseCamp's): magenta tracks, azure routes, 3 px wide.
const DEFAULT_TRACK_COLOR = 'ffff00ff';
const DEFAULT_ROUTE_COLOR = 'ffff8000';
const LINE_WIDTH = 3;
const POINTS_PER_CHUNK = 1000;

/**
 * @typedef {object} KmlOptions
 * @property {string} [name]         the document's name; omitted when empty
 * @property {string} [unfiledName]  default "Unfiled"
 * @property {FolderTree} [tree]     a tree from buildFolderTree or planExportPaths to reuse; its
 *                                   repairs are then reported by whoever built it, not again here
 */

/** @type {Record<string, string>} */
const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Google Earth renders <description> as HTML, so a comment is HTML-escaped (and its line breaks
 * turned into <br>) before the usual XML escaping. Without this, a comment such as "<b>" would
 * turn bold instead of showing as typed.
 * @param {unknown} comment
 * @param {Tally} tally
 * @returns {string}
 */
function descriptionText(comment, tally) {
  const html = textOf(comment)
    .replace(/[&<>"']/g, (ch) => HTML_ENTITIES[ch])
    .replace(/\r\n?|\n/g, '<br>');
  return escapeText(html, tally);
}

/**
 * @param {unknown} item
 * @returns {item is Item}
 */
function isItem(item) {
  if (item === null || typeof item !== 'object') return false;
  const kind = /** @type {{kind?: unknown}} */ (item).kind;
  return kind === 'waypoint' || kind === 'track' || kind === 'route';
}

/**
 * The style a track uses; counts colours that are not Garmin names.
 * @param {unknown} color
 * @param {Tally} tally
 * @returns {string}
 */
function trackStyleId(color, tally) {
  const name = garminColor(color);
  if (name === null && color !== null && color !== undefined && color !== '') tally.add('track_color_unknown');
  return name !== null && name in KML_TRACK_COLORS ? `track-${name}` : 'track';
}

/**
 * Validated coordinates for a point: "lon,lat" plus the elevation separately, or null when the
 * position is unusable (counted under badCode).
 * @param {unknown} point
 * @param {string} badCode
 * @param {Tally} tally
 * @returns {{ lonLat: string, ele: string|null } | null}
 */
function coordinate(point, badCode, tally) {
  const p = /** @type {Record<string, unknown>} */ (point !== null && typeof point === 'object' ? point : {});
  const lat = fastLat(p.lat);
  const lon = fastLon(p.lon);
  if (lat === null || lon === null) {
    tally.add(badCode);
    return null;
  }
  let ele = null;
  if (p.ele !== null && p.ele !== undefined) {
    ele = fastEle(p.ele);
    if (ele === null) tally.add('elevation_invalid');
  }
  return { lonLat: `${lon},${lat}`, ele };
}

/**
 * A first look at a line, counting nothing: how many points are usable, and whether every usable
 * point has an elevation. It lets the writer choose the geometry before writing, so a long track
 * streams in chunks instead of being held in memory as a list of coordinates. It checks the ranges
 * that make fastLat, fastLon and fastEle (the same as formatLat, formatLon and formatEle) return
 * null, without formatting anything.
 * @param {unknown[]} points
 * @returns {{ usable: number, with3d: boolean }}
 */
function scanLine(points) {
  let usable = 0;
  let with3d = true;
  for (const point of points) {
    const p = /** @type {Record<string, unknown>} */ (point !== null && typeof point === 'object' ? point : {});
    const { lat, lon, ele } = p;
    if (!(typeof lat === 'number' && lat >= -90 && lat <= 90 && typeof lon === 'number' && lon >= -180 && lon <= 180)) continue;
    usable++;
    if (!(typeof ele === 'number' && ele >= MIN_ELEVATION_M && ele <= MAX_ELEVATION_M)) with3d = false;
  }
  return { usable, with3d };
}

/**
 * The geometry for a sequence of points: a LineString clamped to the ground for two or more
 * usable points, a Point for exactly one, nothing for none. Every point is still visited so that
 * unusable positions and elevations are counted. Elevations are written only when every point
 * has one, because a mix of 2D and 3D tuples in one list confuses some readers (and a clamped
 * line ignores altitude anyway).
 * @param {unknown[]} points
 * @param {{ usable: number, with3d: boolean }} scan  from scanLine(points)
 * @param {string} badCode
 * @param {string} indent
 * @param {Tally} tally
 * @returns {Generator<string>}
 */
function* lineGeometry(points, scan, badCode, indent, tally) {
  /** @param {{ lonLat: string, ele: string|null }} c */
  const tuple = (c) => (scan.with3d ? `${c.lonLat},${c.ele}` : c.lonLat);
  if (scan.usable < 2) {
    let only = '';
    for (const point of points) {
      const c = coordinate(point, badCode, tally);
      if (c) only = tuple(c);
    }
    if (scan.usable === 1) {
      tally.add('kml_single_point_line');
      yield `${indent}<Point><coordinates>${only}</coordinates></Point>\n`;
    }
    return;
  }
  let out =
    `${indent}<LineString>\n` +
    `${indent}  <tessellate>1</tessellate>\n` +
    `${indent}  <altitudeMode>clampToGround</altitudeMode>\n` +
    `${indent}  <coordinates>\n`;
  /** @type {string[]} */
  let batch = [];
  for (const point of points) {
    const c = coordinate(point, badCode, tally);
    if (!c) continue;
    batch.push(tuple(c));
    if (batch.length === POINTS_PER_CHUNK) {
      yield `${out}${indent}    ${batch.join(' ')}\n`;
      out = '';
      batch = [];
    }
  }
  if (batch.length > 0) out += `${indent}    ${batch.join(' ')}\n`;
  yield `${out}${indent}  </coordinates>\n${indent}</LineString>\n`;
}

/**
 * Placemark head: name, description and style, in schema order.
 * @param {Item} item
 * @param {string|null} styleId
 * @param {string} indent
 * @param {Tally} tally
 * @returns {string}
 */
function placemarkHead(item, styleId, indent, tally) {
  let out = `${indent}<Placemark>\n`;
  const name = escapeText(item.name, tally);
  if (name !== '') out += `${indent}  <name>${name}</name>\n`;
  const description = descriptionText(item.comment, tally);
  if (description !== '') out += `${indent}  <description>${description}</description>\n`;
  if (styleId !== null) out += `${indent}  <styleUrl>#${styleId}</styleUrl>\n`;
  return out;
}

/**
 * @param {unknown} item
 * @param {string} indent
 * @param {Tally} tally
 * @returns {Generator<string>}
 */
function* placemark(item, indent, tally) {
  if (!isItem(item)) {
    tally.add('item_malformed');
    return;
  }
  const inner = indent + '  ';
  if (item.kind === 'waypoint') {
    const c = coordinate(item, 'waypoint_bad_position', tally);
    if (!c) return;
    const tuple = c.ele === null ? c.lonLat : `${c.lonLat},${c.ele}`;
    yield placemarkHead(item, null, indent, tally) +
      `${inner}<Point><coordinates>${tuple}</coordinates></Point>\n${indent}</Placemark>\n`;
    return;
  }

  if (item.kind === 'route') {
    yield placemarkHead(item, 'route', indent, tally);
    const points = Array.isArray(item.points) ? item.points : [];
    const scan = scanLine(points);
    yield* lineGeometry(points, scan, 'route_point_bad_position', inner, tally);
    if (scan.usable === 0) tally.add('kml_no_geometry');
    yield `${indent}</Placemark>\n`;
    return;
  }

  yield placemarkHead(item, trackStyleId(item.color, tally), indent, tally);
  const segments = (Array.isArray(item.segments) ? item.segments : []).map((s) => (Array.isArray(s) ? s : []));
  const nonEmpty = segments.filter((s) => s.length > 0);
  const scans = nonEmpty.map(scanLine);
  const used = scans.reduce((sum, scan) => sum + scan.usable, 0);
  // One line per segment, so gaps in the recording stay gaps. Segments whose points are all
  // unusable add nothing; a track with no usable point at all gets no geometry (counted below).
  const multi = nonEmpty.length > 1 && used > 0;
  if (multi) yield `${inner}<MultiGeometry>\n`;
  for (let i = 0; i < nonEmpty.length; i++) {
    yield* lineGeometry(nonEmpty[i], scans[i], 'track_point_bad_position', multi ? inner + '  ' : inner, tally);
  }
  if (multi) yield `${inner}</MultiGeometry>\n`;
  if (used === 0) tally.add('kml_no_geometry');
  yield `${indent}</Placemark>\n`;
}

/**
 * @param {string} id
 * @param {string} color
 * @returns {string}
 */
function lineStyle(id, color) {
  return (
    `    <Style id="${id}">\n` +
    `      <LineStyle>\n        <color>${color}</color>\n        <width>${LINE_WIDTH}</width>\n      </LineStyle>\n` +
    `    </Style>\n`
  );
}

/**
 * @param {readonly unknown[]} items
 * @returns {string}
 */
function styles(items) {
  /** @type {Set<string>} */
  const used = new Set();
  for (const item of items) {
    if (!isItem(item) || item.kind !== 'track') continue;
    const name = garminColor(item.color);
    if (name !== null && name in KML_TRACK_COLORS) used.add(name);
  }
  let out = lineStyle('track', DEFAULT_TRACK_COLOR) + lineStyle('route', DEFAULT_ROUTE_COLOR);
  for (const name of Object.keys(KML_TRACK_COLORS)) {
    if (used.has(name)) out += lineStyle(`track-${name}`, KML_TRACK_COLORS[name]);
  }
  return out;
}

/**
 * @param {string} name
 * @param {string} indent
 * @param {Tally} tally
 * @returns {string}
 */
function folderOpen(name, indent, tally) {
  const text = escapeText(name, tally);
  return `${indent}<Folder>\n${indent}  <name>${text.trim() === '' ? 'Untitled' : text}</name>\n`;
}

/**
 * Stream one KML document for the whole library. Omissions are counted in `tally`; repairs to the
 * folder tree are in the tree's own problems.
 * @param {Library} library
 * @param {KmlOptions} options
 * @param {Tally} tally  receives the omission counts (create it with new Tally(WRITER_MESSAGES))
 * @returns {Generator<string>}
 */
export function* kmlChunks(library, options, tally) {
  if (!(tally instanceof Tally)) throw new TypeError('KML: a Tally is required to receive counts');
  const tree = options?.tree ?? buildFolderTree(library);
  const items = Array.isArray(library?.items) ? library.items : [];

  let head = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="${KML_NS}">\n  <Document>\n`;
  const docName = escapeText(options?.name, tally);
  if (docName !== '') head += `    <name>${docName}</name>\n`;
  yield head + styles(items);

  // Depth-first without recursion: a folder's sub-folders come first, then its own placemarks.
  /** @type {{ node: TreeNode, next: number }[]} */
  const stack = [{ node: tree.root, next: 0 }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top.next < top.node.children.length) {
      const child = top.node.children[top.next++];
      yield folderOpen(child.name, '  '.repeat(child.depth + 1), tally);
      stack.push({ node: child, next: 0 });
      continue;
    }
    stack.pop();
    if (top.node === tree.root) continue;
    const indent = '  '.repeat(top.node.depth + 1);
    for (const item of top.node.items) yield* placemark(item, indent + '  ', tally);
    yield `${indent}</Folder>\n`;
  }

  if (tree.unfiled.length > 0) {
    yield folderOpen(options?.unfiledName ?? 'Unfiled', '    ', tally);
    for (const item of tree.unfiled) yield* placemark(item, '      ', tally);
    yield '    </Folder>\n';
  }
  yield '  </Document>\n</kml>\n';
}

/**
 * One KML document for the whole library, with folders nested as in BaseCamp.
 * @param {Library} library
 * @param {KmlOptions} [options]
 * @returns {{ xml: string, problems: Problem[] }}
 */
export function writeKml(library, options = {}) {
  const tally = new Tally(WRITER_MESSAGES);
  const tree = options.tree ?? buildFolderTree(library);
  const xml = [...kmlChunks(library, { ...options, tree }, tally)].join('');
  const treeProblems = options.tree ? [] : tree.problems;
  return { xml, problems: [...treeProblems, ...tally.toProblems()] };
}
