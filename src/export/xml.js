// Shared helpers for the XML writers (GPX, KML): escaping, number and time formatting, and a
// tally of everything a writer had to leave out. Browser built-ins only.
//
// Formatters return null instead of a string when a value is not usable (NaN, Infinity, out of
// range). Writers then omit the element and count the omission, so a file never carries garbage
// and the report can say what was left out.

/** @typedef {import('../model.js').Problem} Problem */

// Characters that XML 1.0 forbids (Char production): C0 controls other than tab, LF and CR,
// U+FFFE, U+FFFF, and lone surrogates. With the `u` flag a surrogate range only matches
// unpaired surrogates, because a valid pair is read as one code point.
const ILLEGAL_XML_CHARS = /[\0-\x08\x0B\x0C\x0E-\x1F\uD800-\uDFFF\uFFFE\uFFFF]/gu;

/** @type {Record<string, string>} */
const TEXT_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/** @type {Record<string, string>} */
const ATTR_ENTITIES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
  // A parser normalizes raw tab/LF/CR in an attribute value to spaces; character references survive.
  '\t': '&#9;',
  '\n': '&#10;',
  '\r': '&#13;',
};

/**
 * Turn a value that should be text into a string without inventing content: strings pass,
 * numbers and booleans are stringified, anything else (null, objects) becomes "".
 * @param {unknown} value
 * @returns {string}
 */
export function textOf(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return '';
}

/**
 * Remove every character XML 1.0 cannot carry.
 * @param {string} s
 * @returns {string}
 */
export function stripIllegalXmlChars(s) {
  return s.replace(ILLEGAL_XML_CHARS, '');
}

/**
 * @param {unknown} value
 * @param {Tally} [tally]  when given, counts each string that lost characters
 * @returns {string}
 */
function cleanText(value, tally) {
  const s = textOf(value);
  const clean = stripIllegalXmlChars(s);
  if (tally && clean.length !== s.length) tally.add('text_illegal_chars');
  return clean;
}

/**
 * Escape text for element content. Line ends are normalized to LF (an XML parser would do the
 * same to raw CR LF), and characters illegal in XML 1.0 are removed.
 * @param {unknown} value
 * @param {Tally} [tally]
 * @returns {string}
 */
export function escapeText(value, tally) {
  return cleanText(value, tally)
    .replace(/\r\n?/g, '\n')
    .replace(/[&<>]/g, (ch) => TEXT_ENTITIES[ch]);
}

/**
 * Escape text for a double- or single-quoted attribute value. Tab, LF and CR become character
 * references so they survive attribute-value normalization.
 * @param {unknown} value
 * @param {Tally} [tally]
 * @returns {string}
 */
export function escapeAttr(value, tally) {
  return cleanText(value, tally).replace(/[&<>"'\t\n\r]/g, (ch) => ATTR_ENTITIES[ch]);
}

/**
 * Fixed-point decimal without exponent notation, trailing zeros trimmed, and no "-0".
 * Callers guarantee |v| < 1e21 (toFixed switches to exponent notation above that).
 * @param {number} v
 * @param {number} decimals
 * @returns {string}
 */
function trimmedFixed(v, decimals) {
  let s = v.toFixed(decimals);
  if (s.includes('.')) s = s.replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

/**
 * @param {unknown} v
 * @returns {v is number}
 */
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Latitude in decimal degrees, up to 7 decimals (about 1 cm). Null when not in -90..90.
 * @param {unknown} v
 * @returns {string|null}
 */
export function formatLat(v) {
  if (!isFiniteNumber(v) || v < -90 || v > 90) return null;
  return trimmedFixed(v, 7);
}

/**
 * Longitude in decimal degrees, up to 7 decimals. Null when not in -180..180 (inclusive, as KML
 * allows).
 * @param {unknown} v
 * @returns {string|null}
 */
export function formatLon(v) {
  if (!isFiniteNumber(v) || v < -180 || v > 180) return null;
  return trimmedFixed(v, 7);
}

/**
 * Longitude for GPX 1.1, whose schema range is -180 <= lon < 180. +180 is the same meridian as
 * -180, so it is written as -180 rather than dropped. The check runs after rounding because a
 * value such as 179.99999999 rounds to 180.
 * @param {unknown} v
 * @returns {string|null}
 */
export function formatGpxLon(v) {
  const s = formatLon(v);
  return s === '180' ? '-180' : s;
}

// Sanity bounds for elevation, in metres. A judgment call, not a standard: the deepest ocean
// point is about -11 000 m, and 100 km is the edge of space. They exist to reject sentinel values
// such as the 1e25 "no elevation" marker found in Garmin data, which would otherwise be written
// as a 26-digit number.
export const MIN_ELEVATION_M = -12000;
export const MAX_ELEVATION_M = 100000;

/**
 * Elevation in metres with one or two decimals ("123.0", "123.4", "123.46"). Null when not a
 * finite number within the sanity bounds.
 * @param {unknown} v
 * @returns {string|null}
 */
export function formatEle(v) {
  if (!isFiniteNumber(v) || v < MIN_ELEVATION_M || v > MAX_ELEVATION_M) return null;
  let s = v.toFixed(2);
  if (s.endsWith('0')) s = s.slice(0, -1);
  return s === '-0.0' ? '0.0' : s;
}

/**
 * Heart rate for Garmin's TrackPointExtension (BeatsPerMinute_t: xsd:unsignedByte, minInclusive 1; read from
 * www8.garmin.com/xmlschemas/TrackPointExtensionv2.xsd on 2026-10-07). Null unless an integer 1-255.
 * @param {unknown} v  beats per minute
 * @returns {string|null}
 */
export function formatHeartRate(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 255 ? String(v) : null;
}

// Sanity bounds for air temperature, in degrees Celsius. Absolute zero is a physical limit; the upper bound is a
// judgment call, far above any air a person carries a GPS through, that rejects garbage such as 1e300 (which would
// otherwise be written as a 301-digit number).
export const MIN_TEMPERATURE_C = -273.15;
export const MAX_TEMPERATURE_C = 1000;

/**
 * Air temperature for Garmin's TrackPointExtension (DegreesCelsius_t: xsd:double), with up to two decimals, trailing
 * zeros trimmed ("20.5", "21", "-3.25"). Null when not a finite number within the sanity bounds.
 * @param {unknown} v  degrees Celsius
 * @returns {string|null}
 */
export function formatTemperature(v) {
  if (!isFiniteNumber(v) || v < MIN_TEMPERATURE_C || v > MAX_TEMPERATURE_C) return null;
  return trimmedFixed(v, 2);
}

// toISOString() only produces the four-digit 'YYYY' form for years 0000..9999, and XML Schema 1.0
// has no year 0000, so times are limited to 0001-01-01 .. 9999-12-31 UTC.
export const MIN_TIME_MS = -62135596800000; // 0001-01-01T00:00:00Z
export const MAX_TIME_MS = 253402300799999; // 9999-12-31T23:59:59.999Z

/**
 * ISO-8601 UTC time 'YYYY-MM-DDTHH:MM:SSZ', with milliseconds only when they are not zero.
 * Fractional milliseconds are rounded. Null when not a finite time within the supported range.
 * @param {unknown} ms  milliseconds since 1970-01-01 UTC
 * @returns {string|null}
 */
export function formatTime(ms) {
  if (!isFiniteNumber(ms)) return null;
  const rounded = Math.round(ms);
  if (rounded < MIN_TIME_MS || rounded > MAX_TIME_MS) return null;
  const iso = new Date(rounded).toISOString();
  return iso.endsWith('.000Z') ? iso.slice(0, -5) + 'Z' : iso;
}

/** Plain-words messages for every omission the GPX and KML writers count. Never a value or name. */
export const WRITER_MESSAGES = Object.freeze({
  item_malformed: 'Some items were not readable as a waypoint, track or route and were left out.',
  waypoint_bad_position: 'Some waypoints had no valid position and were left out.',
  route_point_bad_position: 'Some route points had no valid position and were left out.',
  track_point_bad_position: 'Some track points had no valid position and were left out.',
  elevation_invalid: 'Some elevations were not a usable number and were left out (the points were kept).',
  time_invalid: 'Some times were not a usable date and were left out (the points were kept).',
  heart_rate_invalid: 'Some heart rates were not a usable whole number and were left out (the points were kept).',
  temperature_invalid: 'Some temperatures were not a usable number and were left out (the points were kept).',
  text_illegal_chars:
    'Some names or comments contained characters a GPX or KML file cannot hold; those characters were removed.',
  track_color_unknown: 'Some track colors were not a known Garmin color name and were left out.',
  kml_single_point_line:
    'In the KML, some track segments or routes had only one usable point and are shown as a single point.',
  kml_no_geometry: 'In the KML, some tracks or routes had no usable point; only their names are listed.',
});

/**
 * Counts problems by code. Each code must have a message; an unknown code is a programming
 * error and throws, so a typo cannot silently drop a count.
 */
export class Tally {
  /** @param {Readonly<Record<string, string>>} messages  code -> plain-words message */
  constructor(messages) {
    this.messages = messages;
    /** @type {Map<string, number>} */
    this.counts = new Map();
  }

  /**
   * @param {string} code
   * @param {number} [n]
   */
  add(code, n = 1) {
    if (!Object.prototype.hasOwnProperty.call(this.messages, code)) {
      throw new Error(`Tally: unknown problem code "${code}"`);
    }
    if (!Number.isInteger(n) || n < 0) throw new RangeError(`Tally: bad count ${n}`);
    if (n === 0) return;
    this.counts.set(code, (this.counts.get(code) ?? 0) + n);
  }

  /**
   * @param {string} code
   * @returns {number}
   */
  get(code) {
    return this.counts.get(code) ?? 0;
  }

  /** @returns {Problem[]} in the order codes were first counted */
  toProblems() {
    return [...this.counts].map(([code, count]) => ({ code, message: this.messages[code], count }));
  }
}
