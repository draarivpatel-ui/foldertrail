// GPX 1.1 writer (http://www.topografix.com/GPX/1/1). Element order follows the GPX 1.1 schema
// (gpx.xsd): a file holds metadata, then every wpt, then every rte, then every trk; inside a
// waypoint the order is ele, time, name, cmt, sym; inside a track it is name, cmt, extensions,
// trkseg. Track colour uses Garmin's GPX extension (GpxExtensions/v3 TrackExtension/DisplayColor)
// and only when the colour is a name that schema allows. A track point's heart rate and air
// temperature (decision B44) use Garmin's TrackPointExtension v2, as the last child of the trkpt
// (wptType puts extensions last), with atemp before hr as that schema's sequence requires.
//
// The writer streams: gpxChunks() yields pieces of the file so a large library never has to sit
// in one string (the ZIP writer feeds them to a CompressionStream). writeGpx() joins them.
//
// Counts are per write. An item written to several files (its lists, Unfiled, All items) is
// counted once per file, so a report should take its counts from one complete file such as
// "All items.gpx".

import {
  MAX_ELEVATION_M,
  MAX_TIME_MS,
  MIN_ELEVATION_M,
  MIN_TIME_MS,
  Tally,
  WRITER_MESSAGES,
  escapeAttr,
  escapeText,
  formatEle,
  formatHeartRate,
  formatLon,
  formatTemperature,
  stripIllegalXmlChars,
} from './xml.js';

/** @typedef {import('../model.js').Item} Item */
/** @typedef {import('../model.js').Waypoint} Waypoint */
/** @typedef {import('../model.js').Track} Track */
/** @typedef {import('../model.js').Route} Route */
/** @typedef {import('../model.js').Problem} Problem */

export const GPX_NS = 'http://www.topografix.com/GPX/1/1';
export const GPX_XSD = 'http://www.topografix.com/GPX/1/1/gpx.xsd';
export const GPXX_NS = 'http://www.garmin.com/xmlschemas/GpxExtensions/v3';
export const GPXX_XSD = 'http://www8.garmin.com/xmlschemas/GpxExtensionsv3.xsd';
// Garmin's TrackPointExtension v2 (targetNamespace and element names read from the published XSD on 2026-10-07:
// TrackPointExtension_t is the sequence atemp, wtemp, depth, hr, cad, speed, course, bearing, Extensions, all
// optional). BaseCamp's own GPX export writes v1, whose sequence starts with the same atemp, wtemp, depth, hr, cad.
export const GPXTPX_NS = 'http://www.garmin.com/xmlschemas/TrackPointExtension/v2';
export const GPXTPX_XSD = 'http://www8.garmin.com/xmlschemas/TrackPointExtensionv2.xsd';

// DisplayColor_t from GpxExtensionsv3.xsd, in the schema's order and spelling.
export const GARMIN_COLORS = Object.freeze([
  'Black', 'DarkRed', 'DarkGreen', 'DarkYellow', 'DarkBlue', 'DarkMagenta', 'DarkCyan', 'LightGray',
  'DarkGray', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White', 'Transparent',
]);

const COLOR_BY_LOWER = new Map(GARMIN_COLORS.map((c) => [c.toLowerCase(), c]));

// Long track segments are yielded in batches so no single chunk grows with the track length.
const POINTS_PER_CHUNK = 1000;

// ---------------------------------------------------------------------------------------------
// Point formatting, fast. A large library has millions of points, and per point the xml.js formatters ran toFixed
// and a regular expression for each coordinate and built a Date for each time: most of the export's time. These
// give the same strings as formatLat, formatLon, formatGpxLon, formatEle and formatTime in xml.js (test/gpx.test.js
// compares them on every boundary and on millions of values); kml.js uses them too.

const DOT_ZEROS = ['.', '.0', '.00', '.000', '.0000', '.00000', '.000000'];
const TWO_DIGITS = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));
// Index = milliseconds: "Z" for none, else ".mmmZ".
const MILLIS_Z = Array.from({ length: 1000 }, (_, i) => (i === 0 ? 'Z' : `.${String(i).padStart(3, '0')}Z`));
const DAY_MS = 86400000;

/**
 * A finite `v` with |v| <= 180, as trimmedFixed(v, 7) in xml.js writes it: up to 7 decimals, trailing zeros
 * trimmed, never "-0". toFixed rounds the exact binary value, half away from zero. Here |v| * 1e7 < 2^31, so the
 * product is within 2^-22 of the exact value, and away from a half, rounding it gives the same integer. Within
 * 1e-5 of a half, toFixed decides (formatLon is trimmedFixed for this range).
 * @param {number} v
 * @returns {string}
 */
function degrees(v) {
  const negative = v < 0;
  const scaled = (negative ? -v : v) * 1e7;
  const whole = Math.floor(scaled);
  const rest = scaled - whole;
  if (rest > 0.49999 && rest < 0.50001) return /** @type {string} */ (formatLon(v));
  const n = rest < 0.5 ? whole : whole + 1;
  if (n === 0) return '0';
  const int = Math.floor(n / 1e7);
  let frac = n - int * 1e7;
  const head = negative ? `-${int}` : `${int}`;
  if (frac === 0) return head;
  let width = 7;
  while (frac % 10 === 0) {
    frac /= 10;
    width--;
  }
  const digits = `${frac}`;
  return head + DOT_ZEROS[width - digits.length] + digits;
}

/**
 * Same as formatLat in xml.js.
 * @param {unknown} v
 * @returns {string|null}
 */
export function fastLat(v) {
  return typeof v === 'number' && v >= -90 && v <= 90 ? degrees(v) : null;
}

/**
 * Same as formatLon in xml.js (-180..180 inclusive, as KML allows).
 * @param {unknown} v
 * @returns {string|null}
 */
export function fastLon(v) {
  return typeof v === 'number' && v >= -180 && v <= 180 ? degrees(v) : null;
}

/**
 * Same as formatGpxLon in xml.js: +180 (also after rounding) is written as -180.
 * @param {unknown} v
 * @returns {string|null}
 */
export function fastGpxLon(v) {
  const s = fastLon(v);
  return s === '180' ? '-180' : s;
}

/**
 * Same as formatEle in xml.js: one or two decimals, null outside the sanity bounds. |v| * 100 < 2^24, so the
 * product is within 2^-30 of the exact value; within 1e-5 of a half, formatEle decides.
 * @param {unknown} v
 * @returns {string|null}
 */
export function fastEle(v) {
  if (typeof v !== 'number' || !(v >= MIN_ELEVATION_M && v <= MAX_ELEVATION_M)) return null;
  const negative = v < 0;
  const scaled = (negative ? -v : v) * 100;
  const whole = Math.floor(scaled);
  const rest = scaled - whole;
  if (rest > 0.49999 && rest < 0.50001) return formatEle(v);
  const n = rest < 0.5 ? whole : whole + 1;
  if (n === 0) return '0.0';
  const int = Math.floor(n / 100);
  const frac = n - int * 100;
  const head = negative ? `-${int}.` : `${int}.`;
  return frac % 10 === 0 ? head + frac / 10 : head + (frac < 10 ? '0' : '') + frac;
}

// The "YYYY-MM-DDT" of the last day formatted: a track's points are nearly always on the same day as the one before.
let cachedDay = NaN;
let cachedDayText = '';

/**
 * Same as formatTime in xml.js ("YYYY-MM-DDTHH:MM:SSZ", milliseconds only when not zero), with one Date per new
 * day instead of one per point.
 * @param {unknown} ms
 * @returns {string|null}
 */
export function fastTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const t = Math.round(ms);
  if (t < MIN_TIME_MS || t > MAX_TIME_MS) return null;
  const day = Math.floor(t / DAY_MS);
  let rest = t - day * DAY_MS;
  if (day !== cachedDay) {
    cachedDayText = new Date(day * DAY_MS).toISOString().slice(0, 11);
    cachedDay = day;
  }
  const h = Math.floor(rest / 3600000);
  rest -= h * 3600000;
  const m = Math.floor(rest / 60000);
  rest -= m * 60000;
  const s = Math.floor(rest / 1000);
  return cachedDayText + TWO_DIGITS[h] + ':' + TWO_DIGITS[m] + ':' + TWO_DIGITS[s] + MILLIS_Z[rest - s * 1000];
}

// ---------------------------------------------------------------------------------------------

/**
 * The schema spelling of a Garmin colour name, matched case-insensitively, or null.
 * @param {unknown} value
 * @returns {string|null}
 */
export function garminColor(value) {
  if (typeof value !== 'string') return null;
  return COLOR_BY_LOWER.get(value.trim().toLowerCase()) ?? null;
}

/**
 * @typedef {object} GpxOptions
 * @property {string} creator        required: the program that wrote the file
 * @property {string} [name]         the file's title (<metadata><name>), omitted when empty
 * @property {string} [desc]         a description (<metadata><desc>), omitted when empty
 * @property {number|null} [time]    when the file was made, ms since epoch (<metadata><time>)
 */

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
 * @template T
 * @param {unknown} value
 * @returns {T[]}
 */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * A text child element, or "" when the text is empty.
 * @param {string} tag
 * @param {unknown} value
 * @param {string} indent
 * @param {Tally} tally
 * @returns {string}
 */
function textElement(tag, value, indent, tally) {
  const text = escapeText(value, tally);
  return text === '' ? '' : `${indent}<${tag}>${text}</${tag}>\n`;
}

/**
 * An optional formatted value: absent (null/undefined) writes nothing silently; present but
 * unusable writes nothing and is counted.
 * @param {string} tag
 * @param {unknown} value
 * @param {(v: unknown) => string|null} format
 * @param {string} badCode
 * @param {string} indent
 * @param {Tally} tally
 * @returns {string}
 */
function numberElement(tag, value, format, badCode, indent, tally) {
  if (value === null || value === undefined) return '';
  const s = format(value);
  if (s === null) {
    tally.add(badCode);
    return '';
  }
  return `${indent}<${tag}>${s}</${tag}>\n`;
}

/**
 * A track point's heart rate and air temperature as Garmin's TrackPointExtension (B44), or "" when it has neither.
 * A value that is present but unusable is left out and counted. When the file's root element did not declare the
 * gpxtpx prefix (the track said it had no sensor data), the element declares it itself, so the file stays
 * namespace-well-formed.
 * @param {Record<string, unknown>} p
 * @param {string} indent    the indent of the trkpt's children
 * @param {boolean} declared the root element declares xmlns:gpxtpx
 * @param {Tally} tally
 * @returns {string}
 */
function sensorExtensions(p, indent, declared, tally) {
  const hr = p.hr;
  const atemp = p.atemp;
  if ((hr === null || hr === undefined) && (atemp === null || atemp === undefined)) return '';
  const inner = indent + '    ';
  // TrackPointExtension_t's sequence: atemp before hr.
  const values =
    numberElement('gpxtpx:atemp', atemp, formatTemperature, 'temperature_invalid', inner, tally) +
    numberElement('gpxtpx:hr', hr, formatHeartRate, 'heart_rate_invalid', inner, tally);
  if (values === '') return '';
  const ns = declared ? '' : ` xmlns:gpxtpx="${GPXTPX_NS}"`;
  return (
    `${indent}<extensions>\n${indent}  <gpxtpx:TrackPointExtension${ns}>\n` +
    values +
    `${indent}  </gpxtpx:TrackPointExtension>\n${indent}</extensions>\n`
  );
}

/**
 * One wptType element (wpt, rtept or trkpt), or "" when its position is unusable (counted).
 * Children are written in schema order: ele, time, name, cmt, sym, extensions.
 * @param {string} tag
 * @param {unknown} point
 * @param {{ time?: boolean, name?: boolean, cmt?: boolean, sym?: boolean, sensors?: boolean, declared?: boolean }} fields
 *   sensors: write heart rate and air temperature (track points); declared: the root declares xmlns:gpxtpx
 * @param {string} badPositionCode
 * @param {string} indent
 * @param {Tally} tally
 * @returns {string}
 */
function pointElement(tag, point, fields, badPositionCode, indent, tally) {
  const p = /** @type {Record<string, unknown>} */ (point !== null && typeof point === 'object' ? point : {});
  const lat = fastLat(p.lat);
  const lon = fastGpxLon(p.lon);
  if (lat === null || lon === null) {
    tally.add(badPositionCode);
    return '';
  }
  const inner = indent + '  ';
  let children = numberElement('ele', p.ele, fastEle, 'elevation_invalid', inner, tally);
  if (fields.time) children += numberElement('time', p.time, fastTime, 'time_invalid', inner, tally);
  if (fields.name) children += textElement('name', p.name, inner, tally);
  if (fields.cmt) children += textElement('cmt', p.comment, inner, tally);
  if (fields.sym) children += textElement('sym', p.symbol, inner, tally);
  if (fields.sensors) children += sensorExtensions(p, inner, fields.declared === true, tally);
  const open = `${indent}<${tag} lat="${lat}" lon="${lon}"`;
  return children === '' ? `${open}/>\n` : `${open}>\n${children}${indent}</${tag}>\n`;
}

/**
 * @param {Waypoint} wpt
 * @param {Tally} tally
 * @returns {string}
 */
function waypointXml(wpt, tally) {
  const fields = { time: true, name: true, cmt: true, sym: true };
  return pointElement('wpt', wpt, fields, 'waypoint_bad_position', '  ', tally);
}

/**
 * @param {Route} route
 * @param {Tally} tally
 * @returns {Generator<string>}
 */
function* routeChunks(route, tally) {
  let head = '  <rte>\n';
  head += textElement('name', route.name, '    ', tally);
  head += textElement('cmt', route.comment, '    ', tally);
  yield head;
  const fields = { name: true, sym: true };
  let batch = '';
  let n = 0;
  for (const point of asArray(route.points)) {
    batch += pointElement('rtept', point, fields, 'route_point_bad_position', '    ', tally);
    if (++n % POINTS_PER_CHUNK === 0) {
      yield batch;
      batch = '';
    }
  }
  yield batch + '  </rte>\n';
}

/**
 * @param {Track} track
 * @param {Tally} tally
 * @param {boolean} sensorsDeclared  the root element declares xmlns:gpxtpx
 * @returns {Generator<string>}
 */
function* trackChunks(track, tally, sensorsDeclared) {
  let head = '  <trk>\n';
  head += textElement('name', track.name, '    ', tally);
  head += textElement('cmt', track.comment, '    ', tally);
  const color = garminColor(track.color);
  if (color !== null) {
    head +=
      '    <extensions>\n' +
      '      <gpxx:TrackExtension>\n' +
      `        <gpxx:DisplayColor>${color}</gpxx:DisplayColor>\n` +
      '      </gpxx:TrackExtension>\n' +
      '    </extensions>\n';
  } else if (track.color !== null && track.color !== undefined && track.color !== '') {
    tally.add('track_color_unknown');
  }
  yield head;
  const fields = { time: true, sensors: true, declared: sensorsDeclared };
  for (const segment of asArray(track.segments)) {
    let batch = '    <trkseg>\n';
    let n = 0;
    for (const point of asArray(segment)) {
      batch += pointElement('trkpt', point, fields, 'track_point_bad_position', '      ', tally);
      if (++n % POINTS_PER_CHUNK === 0) {
        yield batch;
        batch = '';
      }
    }
    yield batch + '    </trkseg>\n';
  }
  yield '  </trk>\n';
}

/**
 * @param {readonly unknown[]} items
 * @returns {boolean}
 */
function anyTrackHasColor(items) {
  for (const item of items) {
    if (isItem(item) && item.kind === 'track' && garminColor(item.color) !== null) return true;
  }
  return false;
}

/**
 * Whether any track may hold heart rate or air temperature (B44). A track's own `sensorData` flag decides when it has
 * one (the reader sets it on every track, so its points are never built here); otherwise its points are looked at.
 * @param {readonly unknown[]} items
 * @returns {boolean}
 */
function anyTrackHasSensors(items) {
  for (const item of items) {
    if (!isItem(item) || item.kind !== 'track') continue;
    if (typeof item.sensorData === 'boolean') {
      if (item.sensorData) return true;
      continue;
    }
    for (const segment of asArray(item.segments)) {
      for (const point of asArray(segment)) {
        if (point === null || typeof point !== 'object') continue;
        const p = /** @type {Record<string, unknown>} */ (point);
        if ((p.hr !== null && p.hr !== undefined) || (p.atemp !== null && p.atemp !== undefined)) return true;
      }
    }
  }
  return false;
}

/**
 * @param {GpxOptions} options
 * @param {boolean} withGarmin
 * @param {boolean} withSensors  declare Garmin's TrackPointExtension (B44)
 * @param {Tally} tally
 * @returns {string}
 */
function header(options, withGarmin, withSensors, tally) {
  let schemaLocation = `${GPX_NS} ${GPX_XSD}`;
  let ns = `xmlns="${GPX_NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`;
  if (withGarmin) {
    ns += ` xmlns:gpxx="${GPXX_NS}"`;
    schemaLocation += ` ${GPXX_NS} ${GPXX_XSD}`;
  }
  if (withSensors) {
    ns += ` xmlns:gpxtpx="${GPXTPX_NS}"`;
    schemaLocation += ` ${GPXTPX_NS} ${GPXTPX_XSD}`;
  }
  let out =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<gpx version="1.1" creator="${escapeAttr(options.creator, tally)}" ${ns} ` +
    `xsi:schemaLocation="${schemaLocation}">\n`;
  // metadataType order: name, desc, author, copyright, link, time, ...
  let meta = textElement('name', options.name, '    ', tally);
  meta += textElement('desc', options.desc, '    ', tally);
  meta += numberElement('time', options.time, fastTime, 'time_invalid', '    ', tally);
  if (meta !== '') out += `  <metadata>\n${meta}  </metadata>\n`;
  return out;
}

/**
 * @param {unknown} options
 * @returns {asserts options is GpxOptions}
 */
function checkOptions(options) {
  const creator = options && typeof options === 'object' ? /** @type {GpxOptions} */ (options).creator : undefined;
  // Judged after removing what XML cannot hold, since that is what the file would carry.
  if (typeof creator !== 'string' || stripIllegalXmlChars(creator).trim() === '') {
    throw new TypeError('GPX: options.creator must be a non-empty string');
  }
}

/**
 * Stream one GPX 1.1 document holding these items. Waypoints, routes and tracks keep their
 * relative order within each kind; the schema requires all waypoints before routes before tracks.
 * Anything left out is counted in `tally`.
 * @param {readonly unknown[]} items  normally Item[]; anything else is skipped and counted
 * @param {GpxOptions} options
 * @param {Tally} tally  receives the omission counts (create it with new Tally(WRITER_MESSAGES))
 * @returns {Generator<string>}
 */
export function* gpxChunks(items, options, tally) {
  if (!Array.isArray(items)) throw new TypeError('GPX: items must be an array');
  checkOptions(options);
  if (!(tally instanceof Tally)) throw new TypeError('GPX: a Tally is required to receive counts');

  const withSensors = anyTrackHasSensors(items);
  yield header(options, anyTrackHasColor(items), withSensors, tally);
  for (const item of items) {
    if (!isItem(item)) tally.add('item_malformed');
    else if (item.kind === 'waypoint') yield waypointXml(item, tally);
  }
  for (const item of items) {
    if (isItem(item) && item.kind === 'route') yield* routeChunks(item, tally);
  }
  for (const item of items) {
    if (isItem(item) && item.kind === 'track') yield* trackChunks(item, tally, withSensors);
  }
  yield '</gpx>\n';
}

/**
 * One GPX file for a whole list or folder (or any set of items).
 * @param {readonly unknown[]} items
 * @param {GpxOptions} options
 * @returns {{ xml: string, problems: Problem[] }}
 */
export function writeGpx(items, options) {
  const tally = new Tally(WRITER_MESSAGES);
  const xml = [...gpxChunks(items, options, tally)].join('');
  return { xml, problems: tally.toProblems() };
}

/**
 * One GPX file for a single item. The file title defaults to the item's name.
 * @param {Item} item
 * @param {GpxOptions} options
 * @returns {{ xml: string, problems: Problem[] }}
 */
export function writeItemGpx(item, options) {
  checkOptions(options);
  const name = options.name ?? (isItem(item) ? item.name : undefined);
  return writeGpx([item], { ...options, name });
}
