// Record container reader for Garmin BaseCamp library files (FORMAT.md §3, §4).
//
// AllData.gdb ("MsRc") and FolderData.gfi ("DifG") share one container: a 4-byte signature, a u16 primary
// format, a 'D' record holding the file-format version, an 'A' record holding the program version and three
// build strings, a bare application-name string, and then length-prefixed records (u32 little-endian body
// length, u8 type, body) until the end of the file. TrackSegments files share only the header (§9).
//
// The file is hostile input. Every read is bounds-checked before it happens, every length is checked against
// the bytes that are really there before a view is made, and nothing is ever allocated from an unchecked
// length. Record bodies are views over the caller's bytes (no copy), so a 1 GB file costs no more memory than
// the caller's own buffer plus one small object per kept record. Bad data never throws: it ends up as counted
// problems in plain words, which never contain a name, a coordinate, a time or a path.
//
// What this module does not do: interpret record bodies (gdb188.js, gfi.js), read TrackSegments points
// (tracksegments.js), or read a file in windows (chunked.js). Builder, date and time strings from the 'A'
// record are checked for shape only and are never decoded or returned.

const SIG_GDB = 'MsRc';
const SIG_GFI = 'DifG';
const PRIMARY_FORMAT = 0x0066; // "1.2"

const HEADER_MIN = 18; // signature, primary format, 'D' record, 'A' frame
const FRAME = 5; // u32 length + u8 type
const MAX_APPLICATION_BYTES = 64; // GUESS cap from FORMAT.md §3.1 rule 4: the cstr must end within 64 bytes

const TYPE_D = 0x44;
const TYPE_A = 0x41;
const TYPE_X = 0x58;

/** Record type bytes FORMAT.md §3.2 lists (OP p.6). Anything else is counted as unknown and never interpreted. */
export const KNOWN_RECORD_TYPES = Object.freeze(['A', 'C', 'D', 'E', 'F', 'G', 'I', 'j', 'J', 'K', 'L', 'O', 'R', 'T', 'V', 'W', 'X']);
const KNOWN_CODES = new Set(KNOWN_RECORD_TYPES.map((t) => t.charCodeAt(0)));

const APPLICATIONS = Object.freeze(['BaseCamp', 'MapSource', 'HomePort']);
const APPLICATION_BYTES = APPLICATIONS.map((name) => Uint8Array.from(name, (c) => c.charCodeAt(0)));

/**
 * @typedef {object} ContainerLimits
 * @property {number} [maxRecords]      more records than this and reading stops with "too_many_records"
 * @property {number} [maxRecordBytes]  a record body longer than this is skipped and counted ("record_too_large")
 */

/** @type {Readonly<Required<ContainerLimits>>} */
export const DEFAULT_LIMITS = Object.freeze({
  // A large real library holds on the order of 10^5 records (GUESS). Each kept record costs one small object:
  // about 82 bytes of heap measured in Node 26 (Safari not measured), so this cap bounds that at about 160 MB.
  maxRecords: 2_000_000,
  maxRecordBytes: 256 * 2 ** 20, // 256 MiB: a track of about 30 million points
});

/** @typedef {"gdb"|"gfi"|"any"|"tracksegments"} ContainerRole */
/** @typedef {"exported"|"too_old"|"experimental"|"supported"|"unknown"} VersionClass */
/** @typedef {"BaseCamp"|"MapSource"|"HomePort"|"other"} ApplicationName */

/**
 * The parsed header. Fields are filled as far as the bytes allowed, even when the header failed, so a
 * diagnostic can show how far it got.
 * @typedef {object} ContainerHeader
 * @property {boolean} ok                   the header was read; records start at `bodyStart`
 * @property {"gdb"|"gfi"|"tracksegments"|null} kind
 * @property {number} size                  file size in bytes
 * @property {"MsRc"|"DifG"|null} signature a known signature, else null
 * @property {string|null} signatureHex     the first 4 bytes as 8 upper-case hex digits (null when shorter)
 * @property {number|null} primaryFormat    raw u16 at offset 4 (0x0066 for a library)
 * @property {number|null} formatVersion    raw u16 from the 'D' record (188 is "1.88")
 * @property {VersionClass|null} versionClass  classifyVersion(formatVersion)
 * @property {number|null} programVersion   raw u16 from the 'A' record (407 is "4.7"); AllData.gdb's breaks layout ties (B43)
 * @property {boolean|null} authorRecordAsExpected  the three build strings end exactly at the 'A' record's end
 * @property {ApplicationName|null} application
 * @property {number} bodyStart             offset of the first record (or of TrackSegments' point count); 0 if !ok
 * @property {string|null} stopped          code of the whole-file problem that stopped reading, or null
 * @property {import('../model.js').Problem[]} problems
 */

/**
 * One framed record. `body` is a view over the caller's bytes, created on each access (never a copy).
 * Serialising a record (JSON.stringify) gives its type, offset and length only, never its bytes.
 */
export class ContainerRecord {
  /** @type {Uint8Array} */
  #bytes;

  /**
   * @param {Uint8Array} bytes  the whole file
   * @param {number} typeCode
   * @param {number} offset     offset of the 5-byte frame
   * @param {number} length     body length (excluding the frame)
   */
  constructor(bytes, typeCode, offset, length) {
    this.#bytes = bytes;
    /** One character, for example "W". Case matters ('j' and 'J' differ). */
    this.type = String.fromCharCode(typeCode);
    /** The raw type byte. */
    this.typeCode = typeCode;
    /** File offset of the record's 5-byte frame. */
    this.offset = offset;
    /** Body length in bytes, excluding the frame (FORMAT.md's `len`). */
    this.length = length;
    /** File offset of the first body byte. */
    this.bodyOffset = offset + FRAME;
  }

  /** @returns {Uint8Array} the body: `length` bytes, a view that shares the file's buffer */
  get body() {
    return this.#bytes.subarray(this.bodyOffset, this.bodyOffset + this.length);
  }
}

/**
 * @typedef {object} ContainerEnd
 * @property {boolean} present        an 'X' (end of file) record was found; reading stopped after it
 * @property {number|null} offset     its frame offset
 * @property {number} bytesAfter      bytes after the 'X' record (never read)
 */

/**
 * @typedef {ContainerHeader & {
 *   records: ContainerRecord[],
 *   recordCount: number,
 *   end: ContainerEnd,
 *   endOffset: number,
 *   zeroBytes: number,
 *   complete: boolean,
 * }} ContainerResult
 * `records` is empty when an `onRecord` callback was given. `recordCount` counts every record delivered.
 * `zeroBytes` counts zero bytes skipped as padding (frames of five zero bytes, or a zero tail too short for one).
 * `endOffset` is the first byte not read. `complete` is true when the header was read and framing reached the
 * end of the file or an 'X' record without a stopping problem.
 */

/**
 * Classifies a 'D' file-format version (raw u16) per FORMAT.md §4 and decision B6. Compares integers only.
 * @param {number|null|undefined} version
 * @returns {VersionClass}
 */
export function classifyVersion(version) {
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0 || version > 0xffff) return 'unknown';
  if (version >= 107 && version <= 109) return 'exported'; // MapSource / File > Export .gdb: no folders or lists
  if (version >= 115 && version <= 138) return 'too_old'; // BaseCamp 2.x-3.1.x: rejected with a dump
  if (version === 188) return 'supported';
  if (version >= 146) return 'experimental'; // 146-187 and anything above 188
  return 'unknown';
}

/** The 'A' record program version Mac BaseCamp 4.8.13 writes (FORMAT.md §15.1: VERIFIED on both samples). */
export const PROGRAM_VERSION_MAC48 = 408;

/** @typedef {"mac48"|"older"|"unknown"} ProgramFamily */

/**
 * Which family of BaseCamp wrote a file, from its 'A' record program version (decision B43, FORMAT.md §3.3 rule 8):
 * 408 is Mac BaseCamp 4.8.x (VERIFIED, §15.1); 1-407 is an older BaseCamp, Windows or Mac (major × 100 + minor is
 * REPORTED for 4.5-4.7 by OP p.11; applying it to every older version is a GUESS); anything else, or none, is
 * unknown.
 * @param {number|null|undefined} programVersion
 * @returns {ProgramFamily}
 */
export function programFamily(programVersion) {
  if (programVersion === PROGRAM_VERSION_MAC48) return 'mac48';
  if (typeof programVersion === 'number' && Number.isInteger(programVersion) && programVersion >= 1 && programVersion < PROGRAM_VERSION_MAC48) {
    return 'older';
  }
  return 'unknown';
}

/**
 * How a record's layout was chosen (decision B43):
 * - "only_fit": exactly one hypothesis fitted;
 * - "program_version": several fitted, and AllData.gdb's program version picked one;
 * - "several": several fitted and the program version did not pick one (not decoded, as before B43);
 * - "not_for_version": a route only H-OP decoded, in a file written by Mac BaseCamp 4.8 (not decoded);
 * - "none": nothing fitted.
 * @typedef {"only_fit"|"program_version"|"several"|"not_for_version"|"none"} LayoutDecision
 */

/**
 * Chooses one layout from the hypotheses that fitted a record (decision B43, FORMAT.md §3.3 rule 8, §15.11). The
 * structure dump (dump.js) and the reader (gdb.js) both call this, so they decide alike.
 *
 * - One fit: use it. Exception: in a Mac 4.8 file, a route that only H-OP decodes is refused. H-OP is the one route
 *   rule that does not read the record to its end (§7.4), so a route point count damaged downwards can leave it
 *   "decoding" a shorter route; real Mac 4.8 routes always fit H-MAC48 (FORMAT.md §15.11).
 * - Several fits: in a Mac 4.8 file, H-MAC48 if it is one of them; in an older file, the one of H-KBM and H-OP that
 *   fitted, if only one did; otherwise refused.
 * @param {"W"|"T"|"R"} type
 * @param {readonly string[]} fits  labels of the hypotheses that fitted ("H-KBM", "H-OP", "H-MAC48")
 * @param {number|null|undefined} programVersion  AllData.gdb's 'A' record program version
 * @returns {{layout: string|null, decision: LayoutDecision}}
 */
export function chooseLayout(type, fits, programVersion) {
  const family = programFamily(programVersion);
  if (fits.length === 0) return { layout: null, decision: 'none' };
  if (fits.length === 1) {
    if (type === 'R' && family === 'mac48' && fits[0] === 'H-OP') return { layout: null, decision: 'not_for_version' };
    return { layout: fits[0], decision: 'only_fit' };
  }
  if (family === 'mac48' && fits.includes('H-MAC48')) return { layout: 'H-MAC48', decision: 'program_version' };
  if (family === 'older') {
    const older = fits.filter((label) => label === 'H-KBM' || label === 'H-OP');
    if (older.length === 1) return { layout: older[0], decision: 'program_version' };
  }
  return { layout: null, decision: 'several' };
}

/**
 * Reads only the header. Use role "tracksegments" for TrackSegments files: any signature is accepted and
 * recorded (FORMAT.md §3.1 rule 1), and `bodyStart` is where the bare u32 point count begins.
 * @param {Uint8Array|ArrayBuffer} input
 * @param {{ role?: ContainerRole }} [options]
 * @returns {ContainerHeader}
 */
export function readHeader(input, options = {}) {
  const bytes = toBytes(input);
  const role = toRole(options.role);
  const problems = new Problems();
  let header;
  try {
    header = parseHeader(bytes, role, problems);
  } catch {
    header = emptyHeader(bytes.length);
    problems.add('internal_error');
    header.stopped = 'internal_error';
  }
  header.problems = problems.list();
  return header;
}

/**
 * Reads the header and frames every record to the end of the file (or to an 'X' record).
 * With `onRecord`, records are handed to the callback as they are framed and not kept, so memory stays flat
 * whatever the record count; an exception thrown by the callback is the caller's and is re-thrown.
 * @param {Uint8Array|ArrayBuffer} input  the whole file. Bodies are views over it.
 * @param {{ role?: "gdb"|"gfi"|"any", limits?: ContainerLimits, onRecord?: (record: ContainerRecord) => void }} [options]
 * @returns {ContainerResult}
 */
export function readContainer(input, options = {}) {
  const bytes = toBytes(input);
  const role = toRole(options.role);
  if (role === 'tracksegments') {
    throw new TypeError('TrackSegments files are not framed into records; use readHeader() for them.');
  }
  const limits = toLimits(options.limits);
  const onRecord = options.onRecord;
  if (onRecord !== undefined && typeof onRecord !== 'function') throw new TypeError('onRecord must be a function.');

  const problems = new Problems();
  /** @type {ContainerRecord[]} */
  const records = [];
  /** @type {ContainerEnd} */
  const end = { present: false, offset: null, bytesAfter: 0 };
  const scan = { recordCount: 0, endOffset: 0, zeroBytes: 0, stopped: /** @type {string|null} */ (null) };
  /** @type {{ error: unknown } | null} */
  let callbackFailure = null;

  let header;
  try {
    header = parseHeader(bytes, role, problems);
    if (header.ok) {
      const deliver = onRecord
        ? (/** @type {ContainerRecord} */ record) => {
            try {
              onRecord(record);
            } catch (error) {
              callbackFailure = { error };
              throw error;
            }
          }
        : (/** @type {ContainerRecord} */ record) => {
            records.push(record);
          };
      scanRecords(bytes, header.bodyStart, limits, deliver, problems, end, scan);
    }
  } catch (error) {
    if (callbackFailure) throw /** @type {{ error: unknown }} */ (callbackFailure).error;
    header = header ?? emptyHeader(bytes.length);
    problems.add('internal_error');
    scan.stopped = 'internal_error';
  }

  const stopped = header.stopped ?? scan.stopped;
  return {
    ...header,
    stopped,
    problems: problems.list(),
    records,
    recordCount: scan.recordCount,
    end,
    endOffset: header.ok ? scan.endOffset : 0,
    zeroBytes: scan.zeroBytes,
    complete: header.ok && stopped === null,
  };
}

// ---------------------------------------------------------------------------------------------
// Header (FORMAT.md §3.1)

/**
 * @param {number} size
 * @returns {ContainerHeader}
 */
function emptyHeader(size) {
  return {
    ok: false,
    kind: null,
    size,
    signature: null,
    signatureHex: null,
    primaryFormat: null,
    formatVersion: null,
    versionClass: null,
    programVersion: null,
    authorRecordAsExpected: null,
    application: null,
    bodyStart: 0,
    stopped: null,
    problems: [],
  };
}

/**
 * @param {Uint8Array} bytes
 * @param {ContainerRole} role
 * @param {Problems} problems
 * @returns {ContainerHeader}
 */
function parseHeader(bytes, role, problems) {
  const size = bytes.length;
  const header = emptyHeader(size);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  /** @param {string} code */
  const fail = (code) => {
    problems.add(code);
    header.stopped = code;
    return header;
  };

  if (size >= 4) {
    header.signatureHex = hex(bytes, 0, 4);
    const sig = ascii4(bytes);
    if (sig === SIG_GDB || sig === SIG_GFI) header.signature = sig;
  }
  if (size >= 6) header.primaryFormat = view.getUint16(4, true);
  if (size >= 13 && view.getUint32(6, true) === 2 && bytes[10] === TYPE_D) {
    header.formatVersion = view.getUint16(11, true);
    header.versionClass = classifyVersion(header.formatVersion);
  }
  if (size >= HEADER_MIN + 2 && bytes[17] === TYPE_A) header.programVersion = view.getUint16(18, true);

  // Rule 1: length, signature for the role, primary format.
  if (size < HEADER_MIN) return fail('not_library_file');
  if (role === 'tracksegments') {
    header.kind = 'tracksegments';
  } else if (header.signature === SIG_GDB && (role === 'gdb' || role === 'any')) {
    header.kind = 'gdb';
  } else if (header.signature === SIG_GFI && (role === 'gfi' || role === 'any')) {
    header.kind = 'gfi';
  } else {
    return fail(header.signature === null ? 'not_library_file' : 'wrong_file_kind');
  }
  if (header.primaryFormat !== PRIMARY_FORMAT) return fail('not_library_file');

  // Rule 2: the 'D' record has length 2 and type 'D'.
  if (view.getUint32(6, true) !== 2 || bytes[10] !== TYPE_D) return fail('bad_header');

  // Rule 3: the 'A' record has type 'A', a length of at least 2, and fits in the file.
  const authorLength = view.getUint32(13, true);
  if (bytes[17] !== TYPE_A || authorLength < 2 || authorLength > size - HEADER_MIN) return fail('bad_header');
  const authorEnd = HEADER_MIN + authorLength;
  header.authorRecordAsExpected = threeStringsEndAt(bytes, HEADER_MIN + 2, authorEnd);
  if (!header.authorRecordAsExpected) problems.add('author_record_unexpected');

  // Rule 4: the application name is a bare cstr that ends within 64 bytes.
  const searchEnd = Math.min(size, authorEnd + MAX_APPLICATION_BYTES);
  const nul = bytes.subarray(0, searchEnd).indexOf(0, authorEnd);
  if (nul < 0) return fail('bad_header');
  header.application = applicationName(bytes, authorEnd, nul);
  header.bodyStart = nul + 1;
  header.ok = true;
  return header;
}

/**
 * True when exactly three NUL-terminated strings fill [start, end).
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 * @returns {boolean}
 */
function threeStringsEndAt(bytes, start, end) {
  const body = bytes.subarray(0, end);
  let at = start;
  for (let i = 0; i < 3; i++) {
    const nul = body.indexOf(0, at);
    if (nul < 0) return false;
    at = nul + 1;
  }
  return at === end;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} nul  index of the terminating NUL
 * @returns {ApplicationName}
 */
function applicationName(bytes, start, nul) {
  const length = nul - start;
  for (let i = 0; i < APPLICATIONS.length; i++) {
    const known = APPLICATION_BYTES[i];
    if (known.length !== length) continue;
    let same = true;
    for (let j = 0; j < length; j++) {
      if (bytes[start + j] !== known[j]) {
        same = false;
        break;
      }
    }
    if (same) return /** @type {ApplicationName} */ (APPLICATIONS[i]);
  }
  return 'other';
}

// ---------------------------------------------------------------------------------------------
// Records (FORMAT.md §3.2, §3.3)

/**
 * Frames records from `start` to the end of the file. Every record resumes at bodyStart + len.
 * A frame of five zero bytes (length 0, type 0) is padding: it is skipped and counted as zero bytes, not as a
 * record, so a zero-filled tail reads as one problem instead of millions of empty records.
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {Required<ContainerLimits>} limits
 * @param {(record: ContainerRecord) => void} deliver
 * @param {Problems} problems
 * @param {ContainerEnd} end
 * @param {{ recordCount: number, endOffset: number, zeroBytes: number, stopped: string|null }} scan
 */
function scanRecords(bytes, start, limits, deliver, problems, end, scan) {
  const size = bytes.length;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = start;
  let zeroRunStart = -1;
  let zeroBytes = 0;

  /** @param {number} upTo */
  const closeZeroRun = (upTo) => {
    if (zeroRunStart >= 0) {
      zeroBytes += upTo - zeroRunStart;
      problems.add('zero_padding');
      zeroRunStart = -1;
    }
  };
  /** @param {string} code */
  const stop = (code) => {
    problems.add(code);
    scan.stopped = code;
  };

  for (;;) {
    const remaining = size - at;
    if (remaining === 0) break;
    if (remaining < FRAME) {
      if (allZero(bytes, at, size)) {
        if (zeroRunStart < 0) zeroRunStart = at;
        at = size;
        break;
      }
      closeZeroRun(at);
      stop('record_truncated');
      break;
    }
    const length = view.getUint32(at, true);
    const typeCode = bytes[at + 4];
    if (length === 0 && typeCode === 0) {
      if (zeroRunStart < 0) zeroRunStart = at;
      at += FRAME;
      continue;
    }
    closeZeroRun(at);

    const bodyStart = at + FRAME;
    if (length > size - bodyStart) {
      stop(length > size ? 'record_length_impossible' : 'record_truncated');
      break;
    }
    if (length > limits.maxRecordBytes) {
      problems.add('record_too_large');
      at = bodyStart + length;
      continue;
    }
    if (scan.recordCount >= limits.maxRecords) {
      stop('too_many_records');
      problems.setDetail('too_many_records', limits.maxRecords);
      break;
    }
    if (length === 0) problems.add('empty_record');
    if (!KNOWN_CODES.has(typeCode)) problems.add('unknown_record_type');

    const record = new ContainerRecord(bytes, typeCode, at, length);
    scan.recordCount++;
    at = bodyStart + length;
    deliver(record);

    if (typeCode === TYPE_X) {
      end.present = true;
      end.offset = record.offset;
      end.bytesAfter = size - at;
      if (end.bytesAfter > 0) {
        problems.add('data_after_end');
        problems.setDetail('data_after_end', end.bytesAfter);
      }
      break;
    }
  }
  closeZeroRun(at);
  if (zeroBytes > 0) problems.setDetail('zero_padding', zeroBytes);
  scan.zeroBytes = zeroBytes;
  scan.endOffset = at;
}

// ---------------------------------------------------------------------------------------------
// Problems

/** Plain-words messages. `#` is replaced by the problem's detail number. */
const MESSAGES = Object.freeze({
  not_library_file: 'This file is not a BaseCamp library file.',
  wrong_file_kind: 'This file is a different kind of BaseCamp file than the one expected here.',
  bad_header: "The file's header could not be read.",
  author_record_unexpected: "The file's author record is not laid out as expected. Reading continued.",
  record_truncated: 'The file ends in the middle of a record. Everything before that point was read.',
  record_length_impossible:
    'A record claims to be longer than the whole file, so the file is damaged from that point on. Everything before it was read.',
  record_too_large: 'Some records are larger than the size limit and were skipped.',
  empty_record: 'Some records are empty.',
  zero_padding: '# bytes of zeros were skipped. The file may have been padded or damaged.',
  unknown_record_type: 'Some records are of a kind this tool does not know. They were counted and skipped.',
  data_after_end: 'The file goes on for # bytes after its end-of-file record. Those bytes were not read.',
  too_many_records: 'The file holds more records than the limit of #. The rest were not read.',
  internal_error: 'Something unexpected went wrong while reading this file. Everything read before it was kept.',
});

/** Problem codes this module can report, for callers that map them to their own wording. */
export const PROBLEM_CODES = Object.freeze(Object.keys(MESSAGES));

class Problems {
  constructor() {
    /** @type {Map<string, number>} */
    this.counts = new Map();
    /** @type {Map<string, number>} */
    this.details = new Map();
  }

  /** @param {string} code */
  add(code) {
    this.counts.set(code, (this.counts.get(code) ?? 0) + 1);
  }

  /**
   * @param {string} code
   * @param {number} value  a byte count or a limit: never anything read from a field
   */
  setDetail(code, value) {
    this.details.set(code, value);
  }

  /** @returns {import('../model.js').Problem[]} */
  list() {
    /** @type {import('../model.js').Problem[]} */
    const out = [];
    for (const [code, count] of this.counts) {
      const template = /** @type {Record<string, string>} */ (MESSAGES)[code] ?? MESSAGES.internal_error;
      const detail = this.details.get(code);
      const message = template.includes('#') ? template.replace('#', detail === undefined ? 'some' : String(detail)) : template;
      out.push({ code, message, count });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// Small helpers

/**
 * @param {unknown} input
 * @returns {Uint8Array}
 */
function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new TypeError('Expected the file as a Uint8Array or an ArrayBuffer.');
}

/**
 * @param {unknown} role
 * @returns {ContainerRole}
 */
function toRole(role) {
  if (role === undefined) return 'any';
  if (role === 'gdb' || role === 'gfi' || role === 'any' || role === 'tracksegments') return role;
  throw new TypeError('role must be "gdb", "gfi", "any" or "tracksegments".');
}

/**
 * @param {ContainerLimits|undefined} limits
 * @returns {Required<ContainerLimits>}
 */
function toLimits(limits) {
  const out = { ...DEFAULT_LIMITS };
  if (limits === undefined) return out;
  if (limits === null || typeof limits !== 'object') throw new TypeError('limits must be an object.');
  for (const key of /** @type {(keyof ContainerLimits)[]} */ (Object.keys(DEFAULT_LIMITS))) {
    const value = limits[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`Limit ${key} must be a non-negative integer.`);
    out[key] = value;
  }
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function ascii4(bytes) {
  return String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
}

/**
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 * @returns {string}
 */
function hex(bytes, start, end) {
  let out = '';
  for (let i = start; i < end; i++) out += bytes[i].toString(16).toUpperCase().padStart(2, '0');
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 * @returns {boolean}
 */
function allZero(bytes, start, end) {
  for (let i = start; i < end; i++) if (bytes[i] !== 0) return false;
  return true;
}
