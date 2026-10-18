// ZIP reader for archives the user drops in (for example a BaseCamp backup).
// The archive is hostile input: every offset is bounds-checked, sizes are capped by configurable limits,
// inflated output may never exceed the size the archive declared, and every CRC is verified.
// Archive-level failures throw a ZipReadError with a code the UI can explain; problems with single
// entries are reported on the entry (`issue`) and counted in `problems`, and the other entries stay readable.
// Entries are listed when the archive is opened; their data is read and inflated only when read() is called.

import { crc32 } from '../export/crc32.js';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_DIGITAL_SIGNATURE = 0x05054b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;
const ZIP64_EOCD_MIN_SIZE = 56;
const ZIP64_LOCATOR_SIZE = 20;

const MAX16 = 0xffff;
const MAX32 = 0xffffffff;
const TWO32 = 0x100000000;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;
const FLAG_MASKED_HEADERS = 0x2000;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const METHOD_AES = 99;

const EXTRA_ZIP64 = 0x0001;
const EXTRA_UNIX_TIME = 0x5455;
const EXTRA_UNIX_OLD = 0x5855; // Info-ZIP's older Unix field; macOS Finder (ditto) writes only this one
const EXTRA_UNICODE_PATH = 0x7075;

const HOST_UNIX = 3;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

// Deflate cannot expand data more than 1032:1 (a 258-byte match costs at least 2 bits); the constant
// covers block headers. A declared size above this bound cannot be honest.
const DEFLATE_MAX_RATIO = 1032;
const DEFLATE_RATIO_SLACK = 4096;

const READ_CHUNK = 1 << 20;
// Compressed data goes to the inflater in pieces this small. An engine that inflates a whole input
// chunk before handing anything back could otherwise build up to 1032 times the piece (about 1 GiB for
// a 1 MiB piece) before read() sees that the output is too large; 64 KiB caps that at about 66 MiB.
// Node's DecompressionStream does not do this; the browsers' have not been measured.
const INFLATE_PIECE = 1 << 16;

/** @type {Required<UnzipLimits>} */
export const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 100_000,
  maxEntryBytes: 2 ** 30, // 1 GiB
  maxTotalBytes: 2 ** 32, // 4 GiB
  maxCentralDirectoryBytes: 64 * 2 ** 20, // 64 MiB
});

export class ZipReadError extends Error {
  /**
   * @param {string} code machine code. Archive level: "empty_file", "not_zip", "truncated", "corrupt",
   *   "multi_disk", "too_many_entries", "too_large", "bad_input", "read_failed".
   *   From read(): an entry issue code, or "bad_local_header", "corrupt_data", "size_mismatch",
   *   "crc_mismatch", "limit_exceeded", "out_of_memory", "unsupported_runtime", "read_failed".
   * @param {string} message plain words
   */
  constructor(code, message) {
    super(message);
    this.name = 'ZipReadError';
    this.code = code;
  }
}

/**
 * Anything that can hand out byte ranges of the archive. read() must return exactly `length` bytes.
 * @typedef {object} RandomAccessSource
 * @property {number} size
 * @property {(offset: number, length: number) => Promise<Uint8Array>} read
 */

/**
 * @typedef {object} UnzipLimits
 * @property {number} [maxEntries]      more entries than this and openZip throws "too_many_entries"
 * @property {number} [maxEntryBytes]   entries larger than this are listed with issue "too_large"
 * @property {number} [maxTotalBytes]   total bytes all read() calls on this archive may return
 * @property {number} [maxCentralDirectoryBytes]  a larger central directory makes openZip throw "too_large"
 */

/**
 * @typedef {object} ZipEntry
 * @property {string} name            as stored (UTF-8 when flagged or valid, else CP437); may be unsafe, see below
 * @property {boolean} isDirectory
 * @property {boolean} isSymlink      a Unix symbolic link; read() returns the link target as bytes
 * @property {number} method          0 stored, 8 deflate, anything else is unsupported
 * @property {number} compressedSize
 * @property {number} uncompressedSize
 * @property {number} crc32
 * @property {boolean} encrypted
 * @property {number|null} modified   ms since epoch: the UT extra field when present, else the older
 *                                    Unix (UX) field, else the DOS fields read as UTC (they carry no
 *                                    zone); null when they are invalid
 * @property {boolean} unsafeName     empty, absolute, drive-letter, NUL or ".." path: never use it as a path
 * @property {boolean} duplicate      an earlier entry has exactly the same name
 * @property {IssueCode|null} issue   why read() will refuse this entry, or null
 * @property {() => Promise<Uint8Array>} read  the entry's bytes, inflated and CRC-checked
 */

/**
 * @typedef {object} ZipArchive
 * @property {ZipEntry[]} entries     in central-directory order
 * @property {import('../model.js').Problem[]} problems  what could not be read, counted
 * @property {string} comment
 * @property {boolean} zip64
 */

/**
 * @typedef {"unsafe_name"|"encrypted"|"unsupported_method"|"bad_zip64_extra"|"too_large"|"bad_size"|"bad_offset"|"overlapping"} IssueCode
 */

/** Plain-words reasons for each entry issue (used in thrown errors and in `problems`). @type {Record<IssueCode, string>} */
const ISSUE_TEXT = Object.freeze({
  unsafe_name: 'Entries whose names are empty, absolute paths, or climb out of their folder ("..") were not read.',
  encrypted: 'Password-protected entries are not supported and were not read.',
  unsupported_method: 'Entries compressed with a method other than "stored" or "deflate" were not read.',
  bad_zip64_extra: 'Entries whose large-file (ZIP64) size information is missing or damaged were not read.',
  too_large: 'Entries larger than the size limit for one file were not read.',
  bad_size: 'Entries whose recorded sizes are impossible for their compression method were not read.',
  bad_offset: 'Entries whose data lies outside the archive were not read.',
  overlapping: 'Entries whose data overlaps another entry (a sign of a damaged or malicious archive) were not read.',
});

/**
 * Opens a ZIP archive and lists its entries.
 * @param {Uint8Array|ArrayBuffer|Blob|RandomAccessSource} input
 * @param {UnzipLimits} [limits]
 * @returns {Promise<ZipArchive>}
 */
export async function openZip(input, limits = {}) {
  const max = resolveLimits(limits);
  const source = toSource(input);
  if (source.size === 0) throw new ZipReadError('empty_file', 'The file is empty.');
  const problems = new ProblemCounter();

  const end = await findEnd(source, problems);
  if (end.declaredCount !== null && end.declaredCount > max.maxEntries) {
    throw tooManyEntries(end.declaredCount, max.maxEntries);
  }
  if (end.centralSize > max.maxCentralDirectoryBytes) {
    throw new ZipReadError(
      'too_large',
      `The archive's table of contents is ${end.centralSize} bytes, more than the limit of ${max.maxCentralDirectoryBytes}.`,
    );
  }
  const central = await source.read(end.centralStart, end.centralSize);
  const records = parseCentralDirectory(central, max.maxEntries, problems);
  if (end.declaredCount !== null && records.length !== end.declaredCount) {
    problems.add(
      'entry_count_mismatch',
      'The archive says it holds a different number of entries than its table of contents lists.',
    );
  }

  const localOffsets = records.map((record) => (record.offset === null ? -1 : record.offset + end.shift));
  const issues = records.map((record, i) => firstIssue(record, localOffsets[i], end.centralStart, max));
  const boundaries = dataBoundaries(localOffsets, end.centralStart);
  markOverlaps(records, localOffsets, boundaries, issues);

  const budget = { remaining: max.maxTotalBytes };
  /** @type {Set<string>} */
  const seenNames = new Set();
  const entries = records.map((record, i) => {
    const duplicate = seenNames.has(record.name);
    seenNames.add(record.name);
    if (duplicate) problems.add('duplicate_name', 'Some names appear more than once in the archive.');
    if (record.badNameEncoding) {
      problems.add('bad_name_encoding', 'Some names are not valid UTF-8; unreadable characters were replaced.');
    }
    const issue = issues[i];
    if (issue !== null) problems.add(issue, ISSUE_TEXT[issue]);
    return makeEntry(record, duplicate, issue, (entry) => readEntry(source, entry, localOffsets[i], boundaries[i], budget));
  });

  return { entries, problems: problems.list(), comment: end.comment, zip64: end.zip64 };
}

// ---------------------------------------------------------------------------------------------
// Sources

/**
 * @param {UnzipLimits} limits
 * @returns {Required<UnzipLimits>}
 */
function resolveLimits(limits) {
  /** @type {Required<UnzipLimits>} */
  const out = { ...DEFAULT_LIMITS };
  for (const key of /** @type {(keyof UnzipLimits)[]} */ (Object.keys(DEFAULT_LIMITS))) {
    const value = limits?.[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ZipReadError('bad_input', `Limit ${key} must be a non-negative integer.`);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Wraps the input so every read is bounds-checked and returns exactly the bytes asked for.
 * @param {unknown} input
 * @returns {RandomAccessSource}
 */
function toSource(input) {
  /** @type {RandomAccessSource} */
  let raw;
  if (input instanceof Uint8Array) {
    raw = { size: input.length, read: async (offset, length) => input.subarray(offset, offset + length) };
  } else if (input instanceof ArrayBuffer) {
    const bytes = new Uint8Array(input);
    raw = { size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) };
  } else if (typeof Blob === 'function' && input instanceof Blob) {
    raw = {
      size: input.size,
      read: async (offset, length) => new Uint8Array(await input.slice(offset, offset + length).arrayBuffer()),
    };
  } else if (
    input !== null &&
    typeof input === 'object' &&
    Number.isSafeInteger(/** @type {any} */ (input).size) &&
    /** @type {any} */ (input).size >= 0 &&
    typeof (/** @type {any} */ (input).read) === 'function'
  ) {
    raw = /** @type {RandomAccessSource} */ (input);
  } else {
    throw new ZipReadError('bad_input', 'Expected the archive as bytes, a Blob or File, or a random-access source.');
  }
  const size = raw.size;
  return {
    size,
    async read(offset, length) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > size) {
        throw new ZipReadError('corrupt', 'The archive points outside the file.');
      }
      /** @type {unknown} */
      let bytes;
      try {
        bytes = await raw.read(offset, length);
      } catch (error) {
        throw new ZipReadError('read_failed', `The file could not be read (${describe(error)}).`);
      }
      if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
        throw new ZipReadError('read_failed', 'The file could not be read completely; it may have changed on disk.');
      }
      return bytes;
    },
  };
}

/**
 * @param {Uint8Array} bytes
 * @returns {DataView}
 */
function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * A little-endian 64-bit field as a Number, or null when it does not fit in a safe integer.
 * @param {DataView} view
 * @param {number} at
 * @returns {number|null}
 */
function getUint64(view, at) {
  const low = view.getUint32(at, true);
  const high = view.getUint32(at + 4, true);
  if (high > 0x1fffff) return null; // 2^53 / 2^32
  return high * TWO32 + low;
}

/**
 * @param {RandomAccessSource} source
 * @param {number} offset
 * @returns {Promise<number|null>} the 32-bit value at `offset`, or null when it lies outside the file
 */
async function u32At(source, offset) {
  if (offset < 0 || offset + 4 > source.size) return null;
  return viewOf(await source.read(offset, 4)).getUint32(0, true);
}

// ---------------------------------------------------------------------------------------------
// End of central directory

/**
 * @typedef {object} EndInfo
 * @property {number} centralStart   where the central directory really starts in the file
 * @property {number} centralSize
 * @property {number} shift          added to stored offsets (bytes prepended to the archive)
 * @property {number|null} declaredCount  entry count the archive declares, or null when unknown
 * @property {string} comment
 * @property {boolean} zip64
 */

/**
 * Finds the end-of-central-directory record by scanning backwards. A candidate counts only when the
 * central directory it points to starts with the right signature, so a comment that happens to contain
 * the signature bytes does not fool it. Candidates whose comment ends exactly at the end of the file are
 * tried first; only then are candidates followed by stray bytes considered.
 * @param {RandomAccessSource} source
 * @param {ProblemCounter} problems
 * @returns {Promise<EndInfo>}
 */
async function findEnd(source, problems) {
  const tailLength = Math.min(source.size, EOCD_SIZE + MAX16);
  const tailStart = source.size - tailLength;
  const tail = await source.read(tailStart, tailLength);
  const view = viewOf(tail);
  let sawSignature = false;
  let sawMultiDisk = false;
  // An empty archive has no central directory whose signature could confirm it, so 22 plausible bytes
  // inside a comment pass as one and would hide the real archive. A candidate with entries wins; an
  // empty one is kept only for when nothing else validates.
  /** @type {{ end: EndInfo, exactEnd: boolean }|null} */
  let empty = null;
  for (const exactEnd of [true, false]) {
    for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
      if (view.getUint32(i, true) !== SIG_EOCD) continue;
      sawSignature = true;
      const commentEnd = i + EOCD_SIZE + view.getUint16(i + 20, true);
      if (exactEnd ? commentEnd !== tail.length : commentEnd >= tail.length) continue;
      const result = await interpretEnd(source, tailStart + i, view, i);
      if (result === 'multi_disk') {
        sawMultiDisk = true;
        continue;
      }
      if (result === null) continue;
      const end = { ...result, comment: decodeText(tail.subarray(i + EOCD_SIZE, commentEnd), false).text };
      if (end.centralSize > 0) return reportEnd(end, exactEnd, problems);
      empty ??= { end, exactEnd };
    }
  }
  if (empty !== null) return reportEnd(empty.end, empty.exactEnd, problems);
  if (sawMultiDisk) {
    throw new ZipReadError('multi_disk', 'This is one part of a split (multi-part) archive, which is not supported.');
  }
  if (sawSignature) {
    throw new ZipReadError('corrupt', "The archive's table of contents is damaged or missing.");
  }
  if ((await u32At(source, 0)) === SIG_LOCAL) {
    throw new ZipReadError('truncated', 'The archive is incomplete: its end is missing (the file may be cut short).');
  }
  throw new ZipReadError('not_zip', 'This file is not a ZIP archive.');
}

/**
 * @param {EndInfo} end
 * @param {boolean} exactEnd  the end record's comment ends exactly at the end of the file
 * @param {ProblemCounter} problems
 * @returns {EndInfo}
 */
function reportEnd(end, exactEnd, problems) {
  if (!exactEnd) {
    problems.add('trailing_data', 'The file has extra bytes after the end of the archive; they were ignored.');
  }
  if (end.shift > 0) {
    problems.add('prefixed_data', 'The archive is preceded by other data (as in a self-extractor); it was skipped.');
  }
  return end;
}

/**
 * Validates one end-record candidate.
 * @param {RandomAccessSource} source
 * @param {number} eocdPos  position of the candidate in the file
 * @param {DataView} tail
 * @param {number} i        position of the candidate in `tail`
 * @returns {Promise<Omit<EndInfo, 'comment'>|null|'multi_disk'>}
 */
async function interpretEnd(source, eocdPos, tail, i) {
  const disk = tail.getUint16(i + 4, true);
  const centralDisk = tail.getUint16(i + 6, true);
  const countOnDisk = tail.getUint16(i + 8, true);
  let count = tail.getUint16(i + 10, true);
  let centralSize = tail.getUint32(i + 12, true);
  let centralOffset = tail.getUint32(i + 16, true);

  /** @type {number|null} */
  let declaredCount = count;
  let zip64 = false;
  let centralEnd = eocdPos; // the central directory ends where the end records begin
  /** @type {null|'multi_disk'} why the ZIP64 records could not be used, when they were looked for */
  let zip64Failure = null;
  if ((await u32At(source, eocdPos - ZIP64_LOCATOR_SIZE)) === SIG_ZIP64_LOCATOR) {
    const z = await readZip64End(source, eocdPos - ZIP64_LOCATOR_SIZE);
    if (z === null || z === 'multi_disk') {
      zip64Failure = z;
    } else {
      ({ count, centralSize, centralOffset } = z);
      declaredCount = count;
      centralEnd = z.position;
      zip64 = true;
    }
  }
  if (!zip64) {
    // Also reached when the 20 bytes before the end record only look like a ZIP64 locator: they can be
    // the tail of the last central record (a name, extra field or comment). The 32-bit values decide.
    if (disk !== 0 || centralDisk !== 0 || countOnDisk !== count) return 'multi_disk';
    if (centralSize === MAX32 || centralOffset === MAX32) return zip64Failure; // ZIP64 markers need ZIP64 records
    // Some writers let the 16-bit count wrap or saturate; the central directory is then parsed by size alone.
    if (count === MAX16) declaredCount = null;
  }

  if (centralSize > centralEnd) return null;
  const expectedStart = centralEnd - centralSize;
  if (centralSize === 0) {
    // An empty archive. Its stored offset cannot point past where the (empty) directory would end, and
    // bytes before that point that the archive does not account for are reported like prepended data.
    return count === 0 && centralOffset <= expectedStart
      ? { centralStart: expectedStart, centralSize, shift: expectedStart - centralOffset, declaredCount: 0, zip64 }
      : null;
  }
  if (centralOffset + centralSize <= centralEnd && (await u32At(source, centralOffset)) === SIG_CENTRAL) {
    return { centralStart: centralOffset, centralSize, shift: 0, declaredCount, zip64 };
  }
  // Data prepended to the archive (a self-extractor stub, a download header) shifts every stored offset.
  if (expectedStart > centralOffset && (await u32At(source, expectedStart)) === SIG_CENTRAL) {
    return { centralStart: expectedStart, centralSize, shift: expectedStart - centralOffset, declaredCount, zip64 };
  }
  return null;
}

/**
 * Reads the ZIP64 end record that the locator at `locatorPos` points to.
 * @param {RandomAccessSource} source
 * @param {number} locatorPos
 * @returns {Promise<{ position: number, count: number, centralSize: number, centralOffset: number }|null|'multi_disk'>}
 */
async function readZip64End(source, locatorPos) {
  const locator = viewOf(await source.read(locatorPos, ZIP64_LOCATOR_SIZE));
  const recordDisk = locator.getUint32(4, true);
  const storedPosition = getUint64(locator, 8);
  const totalDisks = locator.getUint32(16, true);
  if (recordDisk !== 0 || totalDisks > 1) return 'multi_disk';
  if (storedPosition === null) return null;

  // Try the stored position, then the usual spot right before the locator (when data was prepended).
  for (const position of [storedPosition, locatorPos - ZIP64_EOCD_MIN_SIZE]) {
    if (position < 0 || position + ZIP64_EOCD_MIN_SIZE > locatorPos) continue;
    const record = viewOf(await source.read(position, ZIP64_EOCD_MIN_SIZE));
    if (record.getUint32(0, true) !== SIG_ZIP64_EOCD) continue;
    const recordSize = getUint64(record, 4);
    if (recordSize === null || recordSize < ZIP64_EOCD_MIN_SIZE - 12 || position + 12 + recordSize > locatorPos) {
      continue;
    }
    const disk = record.getUint32(16, true);
    const centralDisk = record.getUint32(20, true);
    const countOnDisk = getUint64(record, 24);
    const count = getUint64(record, 32);
    const centralSize = getUint64(record, 40);
    const centralOffset = getUint64(record, 48);
    if (disk !== 0 || centralDisk !== 0 || countOnDisk !== count) return 'multi_disk';
    if (count === null || centralSize === null || centralOffset === null) return null;
    return { position, count, centralSize, centralOffset };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Central directory

/**
 * @typedef {object} CentralRecord
 * @property {string} name
 * @property {boolean} badNameEncoding
 * @property {number} hostSystem
 * @property {number} flags
 * @property {number} method
 * @property {number} crc
 * @property {number|null} compressedSize    null when a ZIP64 value was needed but missing or too large
 * @property {number|null} uncompressedSize
 * @property {number|null} offset
 * @property {number} externalAttributes
 * @property {number|null} modified
 */

/**
 * @param {Uint8Array} central
 * @param {number} maxEntries
 * @param {ProblemCounter} problems
 * @returns {CentralRecord[]}
 */
function parseCentralDirectory(central, maxEntries, problems) {
  const view = viewOf(central);
  /** @type {CentralRecord[]} */
  const records = [];
  let at = 0;
  while (at < central.length) {
    if (central.length - at >= 4 && view.getUint32(at, true) === SIG_DIGITAL_SIGNATURE) break;
    if (central.length - at < CENTRAL_HEADER_SIZE || view.getUint32(at, true) !== SIG_CENTRAL) {
      problems.add('central_directory_damaged', "Part of the archive's table of contents is damaged; entries after it were not listed.");
      break;
    }
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const recordLength = CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;
    if (at + recordLength > central.length) {
      problems.add('central_directory_damaged', "Part of the archive's table of contents is damaged; entries after it were not listed.");
      break;
    }
    if (records.length >= maxEntries) throw tooManyEntries(records.length + 1, maxEntries);
    records.push(parseCentralRecord(central, view, at, nameLength, extraLength));
    at += recordLength;
  }
  return records;
}

/**
 * @param {Uint8Array} central
 * @param {DataView} view
 * @param {number} at
 * @param {number} nameLength
 * @param {number} extraLength
 * @returns {CentralRecord}
 */
function parseCentralRecord(central, view, at, nameLength, extraLength) {
  const madeBy = view.getUint16(at + 4, true);
  const flags = view.getUint16(at + 8, true);
  const method = view.getUint16(at + 10, true);
  const dosTime = view.getUint16(at + 12, true);
  const dosDate = view.getUint16(at + 14, true);
  const crc = view.getUint32(at + 16, true);
  const compressed32 = view.getUint32(at + 20, true);
  const uncompressed32 = view.getUint32(at + 24, true);
  const diskStart = view.getUint16(at + 34, true);
  const externalAttributes = view.getUint32(at + 38, true);
  const offset32 = view.getUint32(at + 42, true);
  const nameBytes = central.subarray(at + CENTRAL_HEADER_SIZE, at + CENTRAL_HEADER_SIZE + nameLength);
  const extra = central.subarray(at + CENTRAL_HEADER_SIZE + nameLength, at + CENTRAL_HEADER_SIZE + nameLength + extraLength);

  // Fields set to all ones are stored in the ZIP64 extra field, in this fixed order (APPNOTE 4.5.3).
  const needs = [uncompressed32 === MAX32, compressed32 === MAX32, offset32 === MAX32, diskStart === MAX16];
  const fields = readExtraFields(extra, nameBytes, needs);
  const [uncompressedSize, compressedSize, offset] = [uncompressed32, compressed32, offset32].map((value, k) =>
    needs[k] ? fields.zip64[k] : value,
  );

  let name = fields.unicodeName;
  let badNameEncoding = false;
  if (name === null) {
    ({ text: name, bad: badNameEncoding } = decodeText(nameBytes, (flags & FLAG_UTF8) !== 0));
  }
  return {
    name,
    badNameEncoding,
    hostSystem: madeBy >> 8,
    flags,
    method,
    crc,
    compressedSize,
    uncompressedSize,
    offset,
    externalAttributes,
    modified: fields.unixTime !== null ? fields.unixTime * 1000 : dosToMs(dosDate, dosTime),
  };
}

/**
 * @param {Uint8Array} extra
 * @param {Uint8Array} nameBytes
 * @param {boolean[]} needs  which of [uncompressed, compressed, offset, disk] the ZIP64 field must hold
 * @returns {{ zip64: (number|null)[], unixTime: number|null, unicodeName: string|null }} unixTime from
 *   the UT field, else from the older UX field
 */
function readExtraFields(extra, nameBytes, needs) {
  const view = viewOf(extra);
  /** @type {(number|null)[]} */
  const zip64 = [null, null, null, null];
  /** @type {number|null} */
  let unixTime = null;
  /** @type {number|null} */
  let oldUnixTime = null;
  /** @type {string|null} */
  let unicodeName = null;
  let at = 0;
  while (at + 4 <= extra.length) {
    const id = view.getUint16(at, true);
    const size = view.getUint16(at + 2, true);
    const start = at + 4;
    if (start + size > extra.length) break; // a malformed tail; any field it should have held stays missing
    if (id === EXTRA_ZIP64) {
      let p = start;
      for (let k = 0; k < 4; k++) {
        if (!needs[k]) continue;
        const width = k === 3 ? 4 : 8;
        if (p + width > start + size) break;
        zip64[k] = width === 8 ? getUint64(view, p) : view.getUint32(p, true);
        p += width;
      }
    } else if (id === EXTRA_UNIX_TIME && size >= 5 && (view.getUint8(start) & 1) !== 0) {
      unixTime = view.getInt32(start + 1, true);
    } else if (id === EXTRA_UNIX_OLD && size >= 8) {
      oldUnixTime = view.getUint32(start + 4, true); // after the access time
    } else if (id === EXTRA_UNICODE_PATH && size >= 5 && view.getUint8(start) === 1) {
      // Info-ZIP's Unicode path: valid only while the CRC still matches the plain name it replaces.
      if (view.getUint32(start + 1, true) === crc32(nameBytes)) {
        const decoded = decodeText(extra.subarray(start + 5, start + size), true);
        if (!decoded.bad) unicodeName = decoded.text;
      }
    }
    at = start + size;
  }
  return { zip64, unixTime: unixTime ?? oldUnixTime, unicodeName };
}

/** CP437, the original IBM PC character set: the ZIP default for names without the UTF-8 flag (0x80..0xFF). */
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

/**
 * Decodes a name or comment. Flagged text is UTF-8. Unflagged text is UTF-8 when it is valid UTF-8
 * (macOS tools write UTF-8 without setting the flag), otherwise CP437.
 * @param {Uint8Array} bytes
 * @param {boolean} utf8Flag
 * @returns {{ text: string, bad: boolean }}
 */
function decodeText(bytes, utf8Flag) {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), bad: false };
  } catch {
    if (utf8Flag) return { text: new TextDecoder('utf-8').decode(bytes), bad: true };
  }
  let text = '';
  for (const byte of bytes) text += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80];
  return { text, bad: false };
}

/**
 * @param {number} date
 * @param {number} time
 * @returns {number|null}
 */
function dosToMs(date, time) {
  const year = 1980 + (date >> 9);
  const month = (date >> 5) & 0x0f;
  const day = date & 0x1f;
  const hours = time >> 11;
  const minutes = (time >> 5) & 0x3f;
  const seconds = (time & 0x1f) * 2;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hours > 23 || minutes > 59 || seconds > 59) return null;
  const ms = Date.UTC(year, month - 1, day, hours, minutes, seconds);
  return new Date(ms).getUTCDate() === day ? ms : null; // rejects 31 February and friends
}

// ---------------------------------------------------------------------------------------------
// Entries

/**
 * @param {string} name
 * @returns {boolean}
 */
function isUnsafeName(name) {
  if (name === '' || name.includes('\0')) return true;
  const path = name.replace(/\\/g, '/');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return true;
  return path.split('/').includes('..');
}

/**
 * The first reason read() cannot proceed, in order of what the user most needs to know.
 * @param {CentralRecord} record
 * @param {number} localOffset
 * @param {number} centralStart
 * @param {Required<UnzipLimits>} max
 * @returns {IssueCode|null}
 */
function firstIssue(record, localOffset, centralStart, max) {
  const { method, compressedSize, uncompressedSize } = record;
  if (isUnsafeName(record.name)) return 'unsafe_name';
  if (isEncrypted(record)) return 'encrypted';
  if (method !== METHOD_STORE && method !== METHOD_DEFLATE) return 'unsupported_method';
  if (compressedSize === null || uncompressedSize === null || record.offset === null) return 'bad_zip64_extra';
  if (uncompressedSize > max.maxEntryBytes) return 'too_large';
  if (method === METHOD_STORE && compressedSize !== uncompressedSize) return 'bad_size';
  if (method === METHOD_DEFLATE && uncompressedSize > compressedSize * DEFLATE_MAX_RATIO + DEFLATE_RATIO_SLACK) {
    return 'bad_size';
  }
  if (localOffset < 0 || localOffset + LOCAL_HEADER_SIZE + compressedSize > centralStart) return 'bad_offset';
  return null;
}

/**
 * @param {CentralRecord} record
 * @returns {boolean}
 */
function isEncrypted(record) {
  return (record.flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION | FLAG_MASKED_HEADERS)) !== 0 || record.method === METHOD_AES;
}

/**
 * @param {CentralRecord} record
 * @param {boolean} duplicate
 * @param {IssueCode|null} issue
 * @param {(entry: ZipEntry) => Promise<Uint8Array>} reader
 * @returns {ZipEntry}
 */
function makeEntry(record, duplicate, issue, reader) {
  const mode = record.externalAttributes >>> 16;
  /** @type {ZipEntry} */
  const entry = {
    name: record.name,
    isDirectory: record.name.endsWith('/') || record.name.endsWith('\\'),
    isSymlink: record.hostSystem === HOST_UNIX && (mode & S_IFMT) === S_IFLNK,
    method: record.method,
    compressedSize: record.compressedSize ?? -1,
    uncompressedSize: record.uncompressedSize ?? -1,
    crc32: record.crc,
    encrypted: isEncrypted(record),
    modified: record.modified,
    unsafeName: isUnsafeName(record.name),
    duplicate,
    issue,
    read: () => reader(entry),
  };
  // Frozen so a caller cannot clear `issue` or change the sizes that read() relies on.
  return Object.freeze(entry);
}

/**
 * For each entry, the position its data must end by: the next local header after its own, or the
 * central directory. Computed from one sort so large archives stay fast.
 * @param {number[]} localOffsets  -1 for entries without a usable offset
 * @param {number} centralStart
 * @returns {number[]}
 */
function dataBoundaries(localOffsets, centralStart) {
  const order = localOffsets.map((_, i) => i).filter((i) => localOffsets[i] >= 0);
  order.sort((a, b) => localOffsets[a] - localOffsets[b]);
  const boundaries = localOffsets.map(() => centralStart);
  let next = centralStart;
  for (let k = order.length - 1; k >= 0; k--) {
    const offset = localOffsets[order[k]];
    boundaries[order[k]] = Math.min(next, centralStart);
    if (k === 0 || localOffsets[order[k - 1]] !== offset) next = offset;
  }
  return boundaries;
}

/**
 * Marks entries whose local header shares its position with another entry's, or whose data would run
 * into the next entry. Overlapping entries are how "zip bombs" reuse one block of data many times.
 * @param {CentralRecord[]} records
 * @param {number[]} localOffsets
 * @param {number[]} boundaries
 * @param {(IssueCode|null)[]} issues  updated in place
 */
function markOverlaps(records, localOffsets, boundaries, issues) {
  /** @type {Map<number, number>} */
  const users = new Map();
  for (const offset of localOffsets) if (offset >= 0) users.set(offset, (users.get(offset) ?? 0) + 1);
  records.forEach((record, i) => {
    if (issues[i] !== null || localOffsets[i] < 0 || record.compressedSize === null) return;
    const shared = (users.get(localOffsets[i]) ?? 0) > 1;
    const runsOver = localOffsets[i] + LOCAL_HEADER_SIZE + record.compressedSize > boundaries[i];
    if (shared || runsOver) issues[i] = 'overlapping';
  });
}

/**
 * @param {RandomAccessSource} source
 * @param {ZipEntry} entry
 * @param {number} localOffset
 * @param {number} boundary
 * @param {{ remaining: number }} budget
 * @returns {Promise<Uint8Array>}
 */
async function readEntry(source, entry, localOffset, boundary, budget) {
  if (entry.issue !== null) throw new ZipReadError(entry.issue, ISSUE_TEXT[entry.issue]);
  const size = entry.uncompressedSize;
  if (size > budget.remaining) {
    throw new ZipReadError('limit_exceeded', 'Reading this entry would go past the total size limit for this archive.');
  }
  budget.remaining -= size;
  try {
    return await inflateEntry(source, entry, localOffset, boundary);
  } catch (error) {
    budget.remaining += size;
    throw error;
  }
}

/**
 * @param {RandomAccessSource} source
 * @param {ZipEntry} entry
 * @param {number} localOffset
 * @param {number} boundary
 * @returns {Promise<Uint8Array>}
 */
async function inflateEntry(source, entry, localOffset, boundary) {
  if (localOffset + LOCAL_HEADER_SIZE > boundary) throw new ZipReadError('bad_offset', ISSUE_TEXT.bad_offset);
  const header = viewOf(await source.read(localOffset, LOCAL_HEADER_SIZE));
  if (header.getUint32(0, true) !== SIG_LOCAL) {
    throw new ZipReadError('bad_local_header', "The entry's header is missing or damaged.");
  }
  const dataStart = localOffset + LOCAL_HEADER_SIZE + header.getUint16(26, true) + header.getUint16(28, true);
  if (dataStart + entry.compressedSize > boundary) throw new ZipReadError('bad_offset', ISSUE_TEXT.bad_offset);

  /** @type {Uint8Array} */
  let out;
  try {
    out = new Uint8Array(entry.uncompressedSize);
  } catch {
    throw new ZipReadError('out_of_memory', 'There is not enough memory to read this entry.');
  }
  let input;
  if (entry.method === METHOD_DEFLATE) {
    input = rangeStream(source, dataStart, entry.compressedSize, INFLATE_PIECE).pipeThrough(inflateRaw());
  } else {
    input = rangeStream(source, dataStart, entry.compressedSize, READ_CHUNK);
  }
  const reader = input.getReader();
  let filled = 0;
  let crc = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.length > out.length - filled) {
        throw new ZipReadError('size_mismatch', 'The entry holds more data than the archive declares.');
      }
      out.set(value, filled);
      crc = crc32(value, crc);
      filled += value.length;
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    if (error instanceof ZipReadError) throw error;
    throw new ZipReadError('corrupt_data', `The entry's compressed data is damaged (${describe(error)}).`);
  }
  if (filled !== out.length) throw new ZipReadError('size_mismatch', 'The entry holds less data than the archive declares.');
  if (crc !== entry.crc32) throw new ZipReadError('crc_mismatch', "The entry's data does not match its checksum; it is damaged.");
  return out;
}

/**
 * A raw-deflate decompressor. An engine that has DecompressionStream but not its "deflate-raw" format
 * throws a TypeError here, which becomes "unsupported_runtime".
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
function inflateRaw() {
  if (typeof DecompressionStream !== 'function') {
    throw new ZipReadError('unsupported_runtime', 'This browser cannot decompress ZIP data (no DecompressionStream).');
  }
  try {
    // The DOM typings declare the writable side as BufferSource, which TypeScript will not unify with
    // Uint8Array chunks; at run time it accepts them and yields Uint8Array.
    return /** @type {TransformStream<Uint8Array, Uint8Array>} */ (
      /** @type {unknown} */ (new DecompressionStream('deflate-raw'))
    );
  } catch (error) {
    throw new ZipReadError('unsupported_runtime', `This browser cannot decompress ZIP data (${describe(error)}).`);
  }
}

/**
 * The bytes [start, start + length) of the source as a stream: read READ_CHUNK bytes at a time and
 * handed on in pieces of at most `pieceSize` bytes, one piece per pull.
 * @param {RandomAccessSource} source
 * @param {number} start
 * @param {number} length
 * @param {number} pieceSize
 * @returns {ReadableStream<Uint8Array>}
 */
function rangeStream(source, start, length, pieceSize) {
  let at = start;
  const end = start + length;
  /** @type {Uint8Array} */
  let pending = new Uint8Array(0);
  return new ReadableStream({
    async pull(controller) {
      if (pending.length === 0) {
        if (at >= end) {
          controller.close();
          return;
        }
        const size = Math.min(READ_CHUNK, end - at);
        pending = await source.read(at, size);
        at += size;
      }
      const piece = pending.subarray(0, pieceSize);
      pending = pending.subarray(piece.length);
      controller.enqueue(piece);
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Reporting

class ProblemCounter {
  constructor() {
    /** @type {Map<string, import('../model.js').Problem>} */
    this.byCode = new Map();
  }

  /**
   * @param {string} code
   * @param {string} message
   */
  add(code, message) {
    const existing = this.byCode.get(code);
    if (existing) existing.count++;
    else this.byCode.set(code, { code, message, count: 1 });
  }

  /** @returns {import('../model.js').Problem[]} */
  list() {
    return [...this.byCode.values()];
  }
}

/**
 * @param {number} count
 * @param {number} limit
 * @returns {ZipReadError}
 */
function tooManyEntries(count, limit) {
  return new ZipReadError('too_many_entries', `The archive holds ${count} or more entries, more than the limit of ${limit}.`);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describe(error) {
  return error instanceof Error && error.message ? error.message : String(error);
}
