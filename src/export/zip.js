// ZIP writer for the export download (GPX/KML files in the user's folder tree).
// Two ways in: zipChunks(entries) packs entries whose bytes are all in memory and returns Uint8Array chunks for
// `new Blob(chunks, { type: "application/zip" })`; ZipWriter (used by the export) takes one entry at a time, also
// as a stream of pieces, deflates as the pieces come and keeps only the compressed bytes. Both write the same headers.
// Sizes are known before each entry is written, so no data descriptors are used. ZIP64 records are
// written automatically when an archive needs them (65535+ entries, or sizes/offsets of 4 GiB or more).
// Same input, same bytes: no clock reads, no randomness, entries in input order. Deflated data comes
// from the engine's own CompressionStream, so it can differ between browser engines (each output is
// still valid); compression "store" gives byte-identical archives everywhere.

import { crc32, Crc32 } from './crc32.js';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

const FLAG_UTF8 = 0x0800; // general-purpose bit 11: the name is UTF-8
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const MADE_BY = (3 << 8) | 63; // host Unix (so permissions apply), spec version 6.3
const VERSION_STORE = 10;
const VERSION_DEFLATE_OR_DIR = 20;
const VERSION_ZIP64 = 45;

const EXTRA_ZIP64 = 0x0001;
const EXTRA_UNIX_TIME = 0x5455; // "UT": exact modification time, read by Info-ZIP, 7-Zip, libarchive
// "UX", Info-ZIP's older Unix field (access and modification time). macOS Archive Utility (ditto)
// ignores UT and reads this one from the local header; without it, it takes the DOS fields as local
// time and shifts every file by the user's UTC offset. Checked with ditto on macOS 27.0.1.
const EXTRA_UNIX_OLD = 0x5855;

const MAX16 = 0xffff;
const MAX32 = 0xffffffff;
const TWO32 = 0x100000000;

const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;
const ZIP64_EOCD_SIZE = 56;
const ZIP64_LOCATOR_SIZE = 20;

const FILE_ATTRIBUTES = (0o100644 << 16) >>> 0; // regular file, rw-r--r--
const DIR_ATTRIBUTES = ((0o040755 << 16) | 0x10) >>> 0; // directory, rwxr-xr-x, plus the MS-DOS directory bit

const DOS_MIN_MS = Date.UTC(1980, 0, 1, 0, 0, 0);
const DOS_MAX_MS = Date.UTC(2107, 11, 31, 23, 59, 58);
const INT32_MAX = 0x7fffffff;

const STREAM_CHUNK = 1 << 20;

export class ZipWriteError extends Error {
  /**
   * @param {string} code machine code for the UI: "invalid_path", "duplicate_path", "path_conflict",
   *   "invalid_bytes", "invalid_mtime", "invalid_options", "compression_failed" (ZipWriter only)
   * @param {string} message plain words
   */
  constructor(code, message) {
    super(message);
    this.name = 'ZipWriteError';
    this.code = code;
  }
}

/**
 * @typedef {object} ZipInput
 * @property {string} path  "Folder/Sub/file.gpx"; a trailing "/" makes a (possibly empty) directory entry
 * @property {Uint8Array|string} [bytes]  file content (a string is written as UTF-8); omit for a directory
 * @property {number|Date|null} [mtime]  modification time (ms since epoch, or a Date); default 1980-01-01 00:00
 */

/**
 * @typedef {object} ZipOptions
 * @property {"auto"|"store"} [compression]  "auto" (default) deflates each file when that makes it smaller
 * @property {"auto"|"always"} [zip64]  "always" writes ZIP64 records even when not needed (used by tests)
 */

/**
 * Everything the headers of one entry need, decided before any of its bytes are written.
 * @typedef {object} EntryPlan
 * @property {Uint8Array} name          UTF-8 path
 * @property {boolean} directory
 * @property {number} method            0 stored, 8 deflate
 * @property {number} crc
 * @property {number} compressedSize
 * @property {number} uncompressedSize
 * @property {number} offset            where the entry's local header starts
 * @property {number} dosTime
 * @property {number} dosDate
 * @property {number|null} unixTime     seconds for the UT and UX extra fields, or null to omit them
 * @property {boolean} sizesZip64       sizes go in a ZIP64 extra field
 * @property {boolean} offsetZip64      the offset goes in the central ZIP64 extra field
 */

/**
 * Builds a ZIP archive.
 * The returned chunks may share memory with the input bytes; do not change those until the Blob is built.
 * @param {ZipInput[]} entries
 * @param {ZipOptions} [options]
 * @returns {Promise<Uint8Array[]>}
 */
export async function zipChunks(entries, options = {}) {
  if (options === null || typeof options !== 'object') {
    throw new ZipWriteError('invalid_options', 'Options must be an object.');
  }
  const compression = options.compression ?? 'auto';
  if (compression !== 'auto' && compression !== 'store') {
    throw new ZipWriteError('invalid_options', `Unknown compression "${String(compression)}".`);
  }
  const zip64Mode = options.zip64 ?? 'auto';
  if (zip64Mode !== 'auto' && zip64Mode !== 'always') {
    throw new ZipWriteError('invalid_options', `Unknown zip64 mode "${String(zip64Mode)}".`);
  }
  const forceZip64 = zip64Mode === 'always';
  const prepared = prepareEntries(entries); // validate everything before doing any work
  const deflate = compression === 'auto' && deflateAvailable();

  /** @type {Uint8Array[]} */
  const chunks = [];
  /** @type {EntryPlan[]} */
  const plans = [];
  let offset = 0;
  for (const entry of prepared) {
    let data = entry.bytes;
    let method = METHOD_STORE;
    if (deflate && !entry.directory) {
      const packed = await deflateIfSmaller(entry.bytes);
      if (packed) {
        data = packed;
        method = METHOD_DEFLATE;
      }
    }
    /** @type {EntryPlan} */
    const plan = {
      name: entry.name,
      directory: entry.directory,
      method,
      crc: crc32(entry.bytes),
      compressedSize: data.length,
      uncompressedSize: entry.bytes.length,
      offset,
      dosTime: entry.dosTime,
      dosDate: entry.dosDate,
      unixTime: entry.unixTime,
      ...entryZip64(entry.bytes.length, data.length, offset, forceZip64),
    };
    const header = encodeLocalHeader(plan);
    chunks.push(header);
    if (data.length > 0) chunks.push(data);
    offset += header.length + data.length;
    plans.push(plan);
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const plan of plans) {
    const header = encodeCentralHeader(plan);
    chunks.push(header);
    centralSize += header.length;
  }
  chunks.push(encodeEnd(plans.length, centralSize, centralOffset, forceZip64));
  return chunks;
}

/**
 * Same as zipChunks, joined into one array (handy for tests and small archives).
 * @param {ZipInput[]} entries
 * @param {ZipOptions} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function zipBytes(entries, options) {
  const chunks = await zipChunks(entries, options);
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Streaming writer

// Content that arrives in pieces is held uncompressed only up to this size. Up to it, the entry is stored when
// deflating would not make it smaller, as zipChunks decides; past it, the writer commits to DEFLATE and keeps only
// compressed bytes. zlib's worst case for data that does not compress is about 0.03% larger (deflateBound).
const STREAM_DECIDE_LIMIT = 1 << 20;
// Text pieces are joined up to about this many UTF-16 units before one TextEncoder call.
const TEXT_BATCH = 1 << 16;
// Finished bytes move into a Blob about every FLUSH_BYTES, so the JS heap holds at most one batch per open entry.
// A Blob made from Blobs references them instead of copying (checked in Node 26).
const FLUSH_BYTES = 4 << 20;
// An entry with less data than this keeps its arrays: one Blob per tiny entry would cost more than it saves.
const SMALL_ENTRY = 1 << 16;
// A gzip header longer than this is not what any engine writes; refuse it instead of buffering more.
const MAX_GZIP_HEADER = 1 << 16;

/** @typedef {Uint8Array|string|Iterable<Uint8Array|string>|AsyncIterable<Uint8Array|string>} ZipContent */
/** @typedef {Uint8Array|Blob} ZipPart  never shared memory (toBytes copies that), so every part is a BlobPart */

/**
 * @typedef {object} WriterEntry
 * @property {Uint8Array} name
 * @property {boolean} directory
 * @property {number} dosTime
 * @property {number} dosDate
 * @property {number|null} unixTime
 * @property {number} method
 * @property {number} crc
 * @property {number} compressedSize
 * @property {number} uncompressedSize
 * @property {ZipPart[]} data
 * @property {string} where             "Entry 3 (\"path\")", for messages
 */

/**
 * Writes a ZIP archive one entry at a time and keeps only what goes into the archive: content is deflated as it
 * arrives (or stored), and finished bytes move into Blobs, so a large export never sits in memory uncompressed.
 *
 *   const zip = new ZipWriter();
 *   await zip.add('GPX/', undefined, { mtime });
 *   await zip.add('GPX/All items.gpx', gpxChunks(items, options, tally), { mtime });  // pieces: strings or bytes
 *   const blob = new Blob(await zip.finish(), { type: 'application/zip' });
 *
 * Entries go into the archive in the order add() was called, also when several are filled at the same time.
 * Paths, error codes, headers and the deflate-only-if-smaller rule are those of zipChunks. For the same entries
 * given whole, the archive has the same bytes as zipBytes when stored, and also when deflated in Node (tested) and
 * in Chrome (checked once); other engines' compressors may choose other (valid) deflate bytes. Content given in
 * pieces is decided the same way up to 1 MiB; a longer stream is always deflated, because its uncompressed bytes
 * are no longer kept.
 *
 * The CRC-32 of deflated content comes from the engine: the writer compresses with CompressionStream('gzip'),
 * whose trailer holds the CRC and length of the input (RFC 1952), and strips the gzip wrapper, which leaves the same
 * raw DEFLATE stream as 'deflate-raw' (checked byte for byte in Node 26 and in headless Chrome 154). Stored content
 * gets crc32.js. Without CompressionStream (Safari before 16.4) everything is stored.
 */
export class ZipWriter {
  /** @type {boolean} */
  #deflate;
  /** @type {boolean} */
  #forceZip64;
  #root = pathNode(0);
  #encoder = new TextEncoder();
  /** @type {WriterEntry[]} in archive order */
  #entries = [];
  /** @type {Promise<void>[]} one settled-safe promise per add() */
  #jobs = [];
  #failed = false;
  /** @type {unknown} the first failure; later adds and finish() report it */
  #failure;
  #finishing = false;

  /** @param {ZipOptions} [options] */
  constructor(options = {}) {
    if (options === null || typeof options !== 'object') {
      throw new ZipWriteError('invalid_options', 'Options must be an object.');
    }
    const compression = options.compression ?? 'auto';
    if (compression !== 'auto' && compression !== 'store') {
      throw new ZipWriteError('invalid_options', `Unknown compression "${String(compression)}".`);
    }
    const zip64Mode = options.zip64 ?? 'auto';
    if (zip64Mode !== 'auto' && zip64Mode !== 'always') {
      throw new ZipWriteError('invalid_options', `Unknown zip64 mode "${String(zip64Mode)}".`);
    }
    this.#forceZip64 = zip64Mode === 'always';
    this.#deflate = compression === 'auto' && gzipAvailable();
  }

  /** Whether this writer deflates (false: every entry is stored). */
  get deflates() {
    return this.#deflate;
  }

  /**
   * Adds one entry. The path is checked and its place in the archive taken at once; the content is read and packed
   * before the returned promise resolves. Content is a Uint8Array or string (whole), or an iterable or async iterable
   * of them (pieces, read one at a time and released). Omit it for a directory ("…/"). Byte arrays are used, not
   * copied: do not change one after handing it over.
   * @param {string} path
   * @param {ZipContent} [content]
   * @param {{mtime?: number|Date|null}} [options]
   * @returns {Promise<void>}
   */
  async add(path, content, options = {}) {
    if (this.#finishing) throw new ZipWriteError('invalid_options', 'add() was called after finish().');
    if (this.#failed) throw this.#failure;
    const entry = this.#claim(path, options);
    const job = this.#fill(entry, content);
    this.#jobs.push(
      job.catch((error) => {
        if (this.#failed) return;
        this.#failed = true;
        this.#failure = error;
      }),
    );
    return job;
  }

  /**
   * Waits for every entry, then returns the archive as parts for `new Blob(parts, { type: 'application/zip' })`.
   * Rejects with the first failure of any add().
   * @returns {Promise<BlobPart[]>}
   */
  async finish() {
    if (this.#finishing) throw new ZipWriteError('invalid_options', 'finish() was called twice.');
    this.#finishing = true;
    await Promise.all(this.#jobs);
    if (this.#failed) throw this.#failure;
    /** @type {ZipPart[]} */
    const parts = [];
    /** @type {EntryPlan[]} */
    const plans = [];
    let offset = 0;
    for (const entry of this.#entries) {
      /** @type {EntryPlan} */
      const plan = {
        name: entry.name,
        directory: entry.directory,
        method: entry.method,
        crc: entry.crc,
        compressedSize: entry.compressedSize,
        uncompressedSize: entry.uncompressedSize,
        offset,
        dosTime: entry.dosTime,
        dosDate: entry.dosDate,
        unixTime: entry.unixTime,
        ...entryZip64(entry.uncompressedSize, entry.compressedSize, offset, this.#forceZip64),
      };
      const header = encodeLocalHeader(plan);
      parts.push(header);
      for (const part of entry.data) parts.push(part);
      offset += header.length + entry.compressedSize;
      plans.push(plan);
      entry.data = [];
    }
    const centralOffset = offset;
    let centralSize = 0;
    for (const plan of plans) {
      const header = encodeCentralHeader(plan);
      parts.push(header);
      centralSize += header.length;
    }
    parts.push(encodeEnd(plans.length, centralSize, centralOffset, this.#forceZip64));
    return /** @type {BlobPart[]} */ (parts);
  }

  /**
   * Checks the path and the time, takes the path in the tree and the entry's place in the archive. A refused path
   * leaves the tree as it was.
   * @param {unknown} path
   * @param {unknown} options
   * @returns {WriterEntry}
   */
  #claim(path, options) {
    const index = this.#entries.length;
    const where = `Entry ${index} (${JSON.stringify(path)})`;
    if (options === null || typeof options !== 'object') {
      throw new ZipWriteError('invalid_options', `${where}: options must be an object.`);
    }
    const problem = pathProblem(path);
    if (problem) throw new ZipWriteError('invalid_path', `${where}: ${problem}`);
    const text = /** @type {string} */ (path);
    const directory = text.endsWith('/');
    const name = this.#encoder.encode(text);
    if (name.length > MAX16) {
      throw new ZipWriteError('invalid_path', `${where}: the path is longer than 65535 bytes in UTF-8.`);
    }
    const { dosTime, dosDate, unixTime } = timeFields(/** @type {{mtime?: unknown}} */ (options).mtime, where);

    const keys = (directory ? text.slice(0, -1) : text).split('/').map(segmentKey);
    // Look first, change nothing until the path is known to fit.
    /** @type {PathNode|null} */
    let node = this.#root;
    for (let i = 0; i < keys.length && node !== null; i++) {
      node = node.children?.get(keys[i]) ?? null;
      if (node === null) break;
      if (i < keys.length - 1) {
        if (node.file !== null) throw pathConflict(node.file, folderPrefix(text, i + 1));
        continue;
      }
      const earlier = directory ? node.dir : node.file;
      if (earlier !== null) {
        throw new ZipWriteError(
          'duplicate_path',
          earlier === text
            ? `${where}: the same path appears twice.`
            : `${where}: collides with ${JSON.stringify(earlier)}; they differ only in letter case or ` +
                'Unicode form, which macOS treats as the same name.',
        );
      }
      if (directory && node.file !== null) throw pathConflict(node.file, text);
      if (!directory && (node.dir !== null || node.via !== null)) {
        throw pathConflict(text, node.dir ?? folderPrefix(/** @type {string} */ (node.via), node.depth));
      }
    }
    let at = this.#root;
    for (let i = 0; i < keys.length; i++) {
      at = childNode(at, keys[i]);
      if (i < keys.length - 1 && at.via === null) at.via = text;
    }
    if (directory) at.dir = text;
    else at.file = text;

    /** @type {WriterEntry} */
    const entry = {
      name,
      directory,
      dosTime,
      dosDate,
      unixTime,
      method: METHOD_STORE,
      crc: 0,
      compressedSize: 0,
      uncompressedSize: 0,
      data: [],
      where,
    };
    this.#entries.push(entry);
    return entry;
  }

  /**
   * Reads the content and fills in the entry's method, sizes, CRC and data.
   * @param {WriterEntry} entry
   * @param {unknown} content
   */
  async #fill(entry, content) {
    const where = entry.where;
    if (entry.directory) {
      toBytes(content, true, where, this.#encoder); // refuses content on a directory
      return;
    }
    if (content instanceof Uint8Array || typeof content === 'string') {
      await this.#pack(entry, toBytes(content, false, where, this.#encoder));
      return;
    }
    const iterable =
      content !== null &&
      (typeof content === 'object' || typeof content === 'function') &&
      (typeof (/** @type {any} */ (content)[Symbol.asyncIterator]) === 'function' ||
        typeof (/** @type {any} */ (content)[Symbol.iterator]) === 'function');
    if (!iterable) {
      const message = `${where}: content must be a Uint8Array, a string, or an iterable of them.`;
      throw new ZipWriteError('invalid_bytes', message);
    }
    await this.#packStream(entry, /** @type {AsyncIterable<unknown>|Iterable<unknown>} */ (content), where);
  }

  /**
   * Packs content that arrives in pieces: text is joined into batches and encoded, and everything goes through
   * one Packer that decides between STORE and DEFLATE.
   * @param {WriterEntry} entry
   * @param {AsyncIterable<unknown>|Iterable<unknown>} content
   * @param {string} where
   */
  async #packStream(entry, content, where) {
    const packer = new Packer(this.#deflate, STREAM_DECIDE_LIMIT);
    try {
      let text = '';
      for await (const piece of content) {
        if (typeof piece === 'string') {
          text += piece;
          if (text.length < TEXT_BATCH) continue;
          // A surrogate pair split between two pieces is joined with the next batch.
          const cut = isHighSurrogate(text.charCodeAt(text.length - 1)) ? text.length - 1 : text.length;
          await packer.write(this.#encodeText(text.slice(0, cut), where));
          text = text.slice(cut);
        } else if (piece instanceof Uint8Array) {
          if (text !== '') {
            await packer.write(this.#encodeText(text, where));
            text = '';
          }
          if (piece.length > 0) await packer.write(toBytes(piece, false, where, this.#encoder));
        } else {
          throw new ZipWriteError('invalid_bytes', `${where}: each piece of content must be a Uint8Array or a string.`);
        }
      }
      if (text !== '') await packer.write(this.#encodeText(text, where));
      Object.assign(entry, await packer.finish());
    } catch (error) {
      packer.abort();
      throw error;
    }
  }

  /**
   * Packs content given whole: deflated when that makes it smaller, else stored as the caller's array (no copy).
   * @param {WriterEntry} entry
   * @param {Uint8Array} bytes
   */
  async #pack(entry, bytes) {
    const size = bytes.length;
    if (!this.#deflate || size === 0) {
      Object.assign(entry, {
        method: METHOD_STORE,
        crc: crc32(bytes),
        compressedSize: size,
        uncompressedSize: size,
        data: size ? [bytes] : [],
      });
      return;
    }
    const packer = new Packer(true, Infinity);
    try {
      for (let at = 0; at < size; at += STREAM_CHUNK) await packer.write(bytes.subarray(at, at + STREAM_CHUNK));
      Object.assign(entry, await packer.finish([bytes]));
    } catch (error) {
      packer.abort();
      throw error;
    }
  }

  /**
   * @param {string} text
   * @param {string} where
   * @returns {Uint8Array}
   */
  #encodeText(text, where) {
    if (!wellFormed(text)) {
      throw new ZipWriteError('invalid_bytes', `${where}: the text contains a lone UTF-16 surrogate.`);
    }
    return this.#encoder.encode(text);
  }
}

/**
 * @param {string} file
 * @param {string} folder
 * @returns {ZipWriteError}
 */
function pathConflict(file, folder) {
  return new ZipWriteError(
    'path_conflict',
    `${JSON.stringify(file)} is a file, but ${JSON.stringify(folder)} needs a folder with the same name.`,
  );
}

/**
 * What a Packer hands back for an entry.
 * @typedef {object} PackedEntry
 * @property {number} method
 * @property {number} crc
 * @property {number} compressedSize
 * @property {number} uncompressedSize
 * @property {ZipPart[]} data
 */

/** @param {number} unit */
function isHighSurrogate(unit) {
  return unit >= 0xd800 && unit <= 0xdbff;
}

/**
 * The engine's String.prototype.isWellFormed where it exists (much faster on long text), else the loop above.
 * @param {string} text
 * @returns {boolean}
 */
function wellFormed(text) {
  const native = /** @type {any} */ (String.prototype).isWellFormed;
  return typeof native === 'function' ? native.call(text) : isWellFormed(text);
}

/**
 * One entry's bytes on their way into the archive. When deflating, every piece goes to the compressor at once (so
 * the engine compresses while the next piece is made), and the uncompressed pieces are also kept up to `limit`, so
 * an entry that ends below it can still be stored when deflating did not make it smaller. Past `limit` they are
 * dropped and the entry will be deflated.
 */
class Packer {
  /**
   * @param {boolean} deflate  false: store everything
   * @param {number} limit     uncompressed bytes kept for the store-or-deflate choice
   */
  constructor(deflate, limit) {
    this.limit = limit;
    this.size = 0;
    /** @type {Uint8Array[]|null} uncompressed pieces, while the entry may still be stored */
    this.held = deflate ? [] : null;
    /** @type {GzipDeflater|null} made on the first byte */
    this.deflater = null;
    /** @type {PartList|null} stored bytes, when not deflating at all */
    this.stored = deflate ? null : new PartList(0);
    this.crc = deflate ? null : new Crc32();
  }

  /** @param {Uint8Array} bytes */
  async write(bytes) {
    this.size += bytes.length;
    if (this.stored && this.crc) {
      this.crc.update(bytes);
      this.stored.push(bytes);
      return;
    }
    if (this.held) {
      if (this.size <= this.limit) this.held.push(bytes);
      else this.held = null;
    }
    this.deflater ??= new GzipDeflater();
    await this.deflater.write(bytes);
  }

  /**
   * @param {Uint8Array[]} [whole]  the caller's own arrays, used as stored data when given (no copy)
   * @returns {Promise<PackedEntry>}
   */
  async finish(whole) {
    const size = this.size;
    if (this.stored && this.crc) {
      const data = whole ?? this.stored.finish();
      return { method: METHOD_STORE, crc: this.crc.digest(), compressedSize: size, uncompressedSize: size, data };
    }
    if (!this.deflater) return { method: METHOD_STORE, crc: 0, compressedSize: 0, uncompressedSize: 0, data: [] };
    const out = await this.deflater.finish(size);
    this.deflater = null;
    const held = this.held;
    this.held = null;
    if (held === null || out.size < size) {
      return { method: METHOD_DEFLATE, crc: out.crc, compressedSize: out.size, uncompressedSize: size, data: out.data };
    }
    // Deflating did not help: store, as zipChunks does. The trailer's CRC is the CRC of these same bytes.
    return { method: METHOD_STORE, crc: out.crc, compressedSize: size, uncompressedSize: size, data: whole ?? held };
  }

  abort() {
    this.deflater?.abort();
    this.deflater = null;
    this.held = null;
  }
}

/**
 * Byte parts of one entry. Every FLUSH_BYTES the parts so far become one Blob (except the last `keep` bytes, which
 * may still be cut off), so the JS heap holds at most one batch.
 */
class PartList {
  /** @param {number} keep  bytes at the end that must stay as arrays (the gzip trailer) */
  constructor(keep) {
    this.keep = keep;
    /** @type {Blob[]} */
    this.blobs = [];
    /** @type {Uint8Array[]} */
    this.chunks = [];
    this.chunkBytes = 0;
    this.size = 0;
  }

  /** @param {Uint8Array} chunk */
  push(chunk) {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.chunkBytes += chunk.length;
    this.size += chunk.length;
    if (this.chunkBytes >= FLUSH_BYTES + this.keep && typeof Blob === 'function') this.#flush(this.keep);
  }

  /** @param {number} keep */
  #flush(keep) {
    let k = this.chunks.length;
    let tail = 0;
    while (k > 0 && tail < keep) tail += this.chunks[--k].length;
    if (k === 0) return;
    this.blobs.push(new Blob(/** @type {BlobPart[]} */ (this.chunks.slice(0, k))));
    this.chunks = this.chunks.slice(k);
    this.chunkBytes = tail;
  }

  /**
   * Removes the last `n` bytes (n <= keep) and returns them.
   * @param {number} n
   * @returns {Uint8Array}
   */
  cutTail(n) {
    const out = new Uint8Array(n);
    let need = n;
    while (need > 0) {
      const last = this.chunks[this.chunks.length - 1];
      const take = Math.min(need, last.length);
      out.set(last.subarray(last.length - take), need - take);
      need -= take;
      if (take === last.length) this.chunks.pop();
      else this.chunks[this.chunks.length - 1] = last.subarray(0, last.length - take);
    }
    this.chunkBytes -= n;
    this.size -= n;
    return out;
  }

  /** @returns {ZipPart[]} everything, as Blobs when the entry is not small */
  finish() {
    if (this.size >= SMALL_ENTRY && this.chunks.length > 0 && typeof Blob === 'function') this.#flush(0);
    const parts = [...this.blobs, ...this.chunks];
    this.blobs = [];
    this.chunks = [];
    return parts;
  }
}

/**
 * Raw DEFLATE through CompressionStream('gzip'), with the gzip header and trailer stripped. The input's CRC-32 and
 * length come from the trailer; the length is checked against what was written.
 */
class GzipDeflater {
  constructor() {
    const stream = new CompressionStream('gzip');
    this.writer = stream.writable.getWriter();
    this.out = new PartList(8);
    /** @type {Uint8Array|null} the first bytes, until the header is complete */
    this.head = new Uint8Array(0);
    this.reading = this.#read(stream.readable.getReader());
    this.reading.catch(() => {}); // reported by finish()
  }

  /** @param {ReadableStreamDefaultReader<Uint8Array>} reader */
  async #read(reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        this.#take(value);
      }
    } catch (error) {
      // Nothing reads the output any more, so a writer waiting for room would wait forever: fail it too.
      this.writer.abort(error).catch(() => {});
      reader.cancel(error).catch(() => {});
      throw error;
    }
  }

  /** @param {Uint8Array} chunk */
  #take(chunk) {
    if (this.head !== null) {
      const joined = new Uint8Array(this.head.length + chunk.length);
      joined.set(this.head);
      joined.set(chunk, this.head.length);
      const length = gzipHeaderLength(joined);
      if (length < 0) {
        if (joined.length > MAX_GZIP_HEADER) throw compressionFailed('its header is too long');
        this.head = joined;
        return;
      }
      this.head = null;
      chunk = joined.subarray(length);
    }
    this.out.push(chunk);
  }

  /**
   * Hands over bytes; waits only while the compressor's queue is full, so the next piece can be made meanwhile.
   * @param {Uint8Array} bytes
   */
  async write(bytes) {
    await this.writer.ready;
    // A failed write errors the stream, which close() reports.
    this.writer.write(/** @type {Uint8Array<ArrayBuffer>} */ (bytes)).catch(() => {});
  }

  /**
   * @param {number} size  bytes written, to check against the trailer
   * @returns {Promise<{crc: number, size: number, data: ZipPart[]}>}
   */
  async finish(size) {
    await this.writer.close();
    await this.reading;
    if (this.head !== null || this.out.size < 8) throw compressionFailed('its output ended early');
    const trailer = new DataView(this.out.cutTail(8).buffer);
    const crc = trailer.getUint32(0, true);
    if (trailer.getUint32(4, true) !== size % TWO32) throw compressionFailed('the length in its trailer is wrong');
    const compressed = this.out.size;
    return { crc, size: compressed, data: this.out.finish() };
  }

  abort() {
    this.writer.abort().catch(() => {});
  }
}

/**
 * @param {string} why
 * @returns {ZipWriteError}
 */
function compressionFailed(why) {
  return new ZipWriteError('compression_failed', `The browser's compressor did not work as expected: ${why}.`);
}

/**
 * Length of the gzip header (RFC 1952 §2.3) at the start of `b`, or -1 when more bytes are needed.
 * @param {Uint8Array} b
 * @returns {number}
 */
function gzipHeaderLength(b) {
  if (b.length < 10) return -1;
  if (b[0] !== 0x1f || b[1] !== 0x8b || b[2] !== 8) throw compressionFailed('it did not write a gzip DEFLATE header');
  const flags = b[3];
  if (flags & 0xe0) throw compressionFailed('its gzip header has reserved flags set');
  let at = 10;
  if (flags & 0x04) {
    // FEXTRA: a 2-byte length, then that many bytes
    if (b.length < at + 2) return -1;
    at += 2 + (b[at] | (b[at + 1] << 8));
  }
  for (const flag of [0x08, 0x10]) {
    // FNAME, FCOMMENT: zero-terminated
    if (!(flags & flag)) continue;
    if (at >= b.length) return -1;
    const end = b.indexOf(0, at);
    if (end < 0) return -1;
    at = end + 1;
  }
  if (flags & 0x02) at += 2; // FHCRC
  return b.length >= at ? at : -1;
}

/** @type {boolean|undefined} */
let gzipSupport;

/** @returns {boolean} whether this runtime has CompressionStream("gzip") */
function gzipAvailable() {
  if (gzipSupport === undefined) {
    try {
      gzipSupport = typeof CompressionStream === 'function' && Boolean(new CompressionStream('gzip'));
    } catch {
      gzipSupport = false;
    }
  }
  return gzipSupport;
}

// ---------------------------------------------------------------------------------------------
// Input validation

/**
 * @typedef {object} PreparedEntry
 * @property {Uint8Array} name
 * @property {boolean} directory
 * @property {Uint8Array} bytes
 * @property {number} dosTime
 * @property {number} dosDate
 * @property {number|null} unixTime
 */

/**
 * @param {unknown} entries
 * @returns {PreparedEntry[]}
 */
function prepareEntries(entries) {
  if (!Array.isArray(entries)) throw new ZipWriteError('invalid_options', 'Entries must be an array.');
  const encoder = new TextEncoder();
  /** @type {PreparedEntry[]} */
  const prepared = [];
  // Every path goes into one tree of segment keys, so checking a path costs time in proportion to its
  // length. (Keying every ancestor's full path instead cost 5 s and 1.8 GB for one legal 65,535-byte path.)
  const root = pathNode(0);
  /** @type {PathNode[]} the nodes that hold a file, in input order */
  const fileNodes = [];

  entries.forEach((input, index) => {
    if (input === null || typeof input !== 'object') {
      throw new ZipWriteError('invalid_options', `Entry ${index} is not an object.`);
    }
    const entry = /** @type {ZipInput} */ (input);
    const path = entry.path;
    const where = `Entry ${index} (${JSON.stringify(path)})`;
    const problem = pathProblem(path);
    if (problem) throw new ZipWriteError('invalid_path', `${where}: ${problem}`);

    const directory = path.endsWith('/');
    const name = encoder.encode(path);
    if (name.length > MAX16) {
      throw new ZipWriteError('invalid_path', `${where}: the path is longer than 65535 bytes in UTF-8.`);
    }

    const bytes = toBytes(entry.bytes, directory, where, encoder);
    const { dosTime, dosDate, unixTime } = timeFields(entry.mtime, where);

    const segments = (directory ? path.slice(0, -1) : path).split('/');
    let node = root;
    for (let i = 0; i < segments.length; i++) {
      node = childNode(node, segmentKey(segments[i]));
      if (i < segments.length - 1 && node.via === null) node.via = path;
    }
    const earlier = directory ? node.dir : node.file;
    if (earlier !== null) {
      throw new ZipWriteError(
        'duplicate_path',
        earlier === path
          ? `${where}: the same path appears twice.`
          : `${where}: collides with ${JSON.stringify(earlier)}; they differ only in letter case or ` +
              'Unicode form, which macOS treats as the same name.',
      );
    }
    if (directory) {
      node.dir = path;
    } else {
      node.file = path;
      fileNodes.push(node);
    }
    prepared.push({ name, directory, bytes, dosTime, dosDate, unixTime });
  });

  for (const node of fileNodes) {
    const folder = node.dir ?? (node.via === null ? null : folderPrefix(node.via, node.depth));
    if (folder !== null) {
      throw new ZipWriteError(
        'path_conflict',
        `${JSON.stringify(node.file)} is a file, but ${JSON.stringify(folder)} needs a folder with the same name.`,
      );
    }
  }
  return prepared;
}

/**
 * One name in the tree of every path written so far, reached by segment keys from the root.
 * @typedef {object} PathNode
 * @property {Map<string, PathNode>|null} children
 * @property {string|null} file  the path written as a file here
 * @property {string|null} dir   the path written as an explicit folder entry here
 * @property {string|null} via   the first path that passes through here as a folder (for messages)
 * @property {number} depth      segments from the root to here, this one included
 */

/**
 * @param {number} depth
 * @returns {PathNode}
 */
function pathNode(depth) {
  return { children: null, file: null, dir: null, via: null, depth };
}

/**
 * @param {PathNode} node
 * @param {string} key
 * @returns {PathNode}
 */
function childNode(node, key) {
  if (node.children === null) node.children = new Map();
  let child = node.children.get(key);
  if (child === undefined) {
    child = pathNode(node.depth + 1);
    node.children.set(key, child);
  }
  return child;
}

/**
 * The first `depth` segments of `path`, with a trailing "/" (only built for an error message).
 * @param {string} path  has at least `depth` slashes
 * @param {number} depth
 * @returns {string}
 */
function folderPrefix(path, depth) {
  let at = -1;
  for (let k = 0; k < depth; k++) at = path.indexOf('/', at + 1);
  return path.slice(0, at + 1);
}

/**
 * Why a path cannot go into the archive, or null when it can.
 * Stricter than the ZIP format requires: callers build these names, so anything that would extract
 * badly (outside the target folder, onto another entry, with invisible or misleading characters, or not
 * at all) is a bug to surface. paths.js removes all of these from the names it builds.
 * @param {unknown} path
 * @returns {string|null}
 */
function pathProblem(path) {
  if (typeof path !== 'string') return 'the path must be a string.';
  if (path === '' || path === '/') return 'the path is empty.';
  if (path.startsWith('/')) return 'the path must be relative (it starts with "/").';
  if (path.includes('\\')) return 'the path contains a backslash; ZIP paths use "/" only.';
  if (/[\u0000-\u001f\u007f-\u009f]/.test(path)) return 'the path contains a control character.';
  if (/[\u202a-\u202e\u2066-\u2069]/.test(path)) {
    return 'the path contains a bidirectional-text control, which can make a name display in a misleading order.';
  }
  if (!isWellFormed(path)) return 'the path contains a lone UTF-16 surrogate and cannot be encoded as UTF-8.';
  // Archive Utility (ditto) fails on such a name and leaves the file out ("Illegal byte sequence",
  // checked on macOS 27.0.1). The set follows this engine's Unicode version, as in paths.js.
  if (/\p{Cn}/u.test(path)) return 'the path contains an unassigned character or noncharacter, which macOS cannot use in a file name.';
  const body = path.endsWith('/') ? path.slice(0, -1) : path;
  for (const segment of body.split('/')) {
    if (segment === '') return 'the path has an empty folder name ("//").';
    if (segment === '.' || segment === '..') return 'the path contains a "." or ".." folder name.';
  }
  return null;
}

/**
 * @param {string} text
 * @returns {boolean} true when every surrogate is part of a pair
 */
function isWellFormed(text) {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * Comparison key for one folder or file name: names macOS's default (case-insensitive,
 * normalization-insensitive) APFS volumes treat as one get the same key. NFC, then case folded both
 * ways until stable. Lower-casing alone missed 124 characters APFS folds, among them "ß"/"ss",
 * "µ"/"μ", "ς"/"σ", "ſ"/"s" and "ﬂ"/"fl", and Archive Utility then silently kept one file of such a
 * pair. Checked on macOS 27.0.1 by creating each assigned code point next to its case and
 * normalization variants: this key missed none of those pairs. It over-merges "ı" with "i", which
 * only refuses a pair that would have extracted fine. Keep it the same as nameKey in paths.js, so
 * names that module makes distinct are never refused here.
 * @param {string} segment
 * @returns {string}
 */
function segmentKey(segment) {
  let key = segment.normalize('NFC');
  for (let round = 0; round < 4; round++) {
    const next = key.toUpperCase().toLowerCase().normalize('NFC');
    if (next === key) break;
    key = next;
  }
  return key;
}

/**
 * @param {unknown} bytes
 * @param {boolean} directory
 * @param {string} where
 * @param {TextEncoder} encoder
 * @returns {Uint8Array}
 */
function toBytes(bytes, directory, where, encoder) {
  if (directory) {
    if (bytes === undefined || bytes === null) return new Uint8Array(0);
    const length = typeof bytes === 'string' || bytes instanceof Uint8Array ? bytes.length : -1;
    if (length !== 0) throw new ZipWriteError('invalid_bytes', `${where}: a directory entry cannot have content.`);
    return new Uint8Array(0);
  }
  if (bytes instanceof Uint8Array) {
    // CompressionStream and Blob refuse views of shared memory (Blob per Web IDL, CompressionStream
    // checked in Node), so those are copied; anything else is used as is, without a copy.
    const shared = typeof SharedArrayBuffer === 'function' && bytes.buffer instanceof SharedArrayBuffer;
    return shared ? bytes.slice() : bytes;
  }
  if (typeof bytes === 'string') {
    if (!isWellFormed(bytes)) {
      throw new ZipWriteError('invalid_bytes', `${where}: the text contains a lone UTF-16 surrogate.`);
    }
    return encoder.encode(bytes);
  }
  throw new ZipWriteError('invalid_bytes', `${where}: content must be a Uint8Array or a string.`);
}

/**
 * @param {unknown} mtime
 * @param {string} where
 * @returns {{ dosTime: number, dosDate: number, unixTime: number|null }}
 */
function timeFields(mtime, where) {
  if (mtime === undefined || mtime === null) return { ...dosDateTime(DOS_MIN_MS), unixTime: null };
  const ms = mtime instanceof Date ? mtime.getTime() : mtime;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    throw new ZipWriteError('invalid_mtime', `${where}: mtime must be a finite number of milliseconds or a valid Date.`);
  }
  const seconds = Math.floor(ms / 1000);
  // The UT field is a signed 32-bit count of seconds; outside 1970..2038 only the DOS fields are written.
  const unixTime = seconds >= 0 && seconds <= INT32_MAX ? seconds : null;
  return { ...dosDateTime(ms), unixTime };
}

/**
 * MS-DOS date and time fields, clamped to the range they can hold (1980-01-01 .. 2107-12-31 23:59:58).
 * The fields have no time zone; they are filled from UTC so the bytes never depend on the machine's zone
 * (the UT extra field carries the exact instant for tools that show local time).
 * @param {number} ms
 * @returns {{ dosTime: number, dosDate: number }}
 */
function dosDateTime(ms) {
  const d = new Date(Math.min(Math.max(ms, DOS_MIN_MS), DOS_MAX_MS));
  return {
    dosTime: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    dosDate: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

// ---------------------------------------------------------------------------------------------
// Compression

/** @type {boolean|undefined} */
let deflateSupport;

/** @returns {boolean} whether this runtime has CompressionStream("deflate-raw") */
function deflateAvailable() {
  if (deflateSupport === undefined) {
    try {
      deflateSupport = typeof CompressionStream === 'function' && Boolean(new CompressionStream('deflate-raw'));
    } catch {
      deflateSupport = false;
    }
  }
  return deflateSupport;
}

/**
 * Raw-deflates `bytes`, or returns null when that would not make them smaller.
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array|null>}
 */
async function deflateIfSmaller(bytes) {
  if (bytes.length === 0) return null;
  let at = 0;
  const input = new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(at + STREAM_CHUNK, bytes.length);
      controller.enqueue(bytes.subarray(at, end));
      at = end;
    },
  });
  const reader = input.pipeThrough(new CompressionStream('deflate-raw')).getReader();
  /** @type {Uint8Array[]} */
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total >= bytes.length) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Record encoders (pure functions of an EntryPlan; exported through `internals` for tests)

/**
 * Which values of one entry need ZIP64 fields. 0xFFFFFFFF itself is the "see ZIP64" marker, so it
 * already needs them.
 * @param {number} uncompressedSize
 * @param {number} compressedSize
 * @param {number} offset
 * @param {boolean} force
 * @returns {{ sizesZip64: boolean, offsetZip64: boolean }}
 */
function entryZip64(uncompressedSize, compressedSize, offset, force) {
  return {
    sizesZip64: force || uncompressedSize >= MAX32 || compressedSize >= MAX32,
    offsetZip64: force || offset >= MAX32,
  };
}

/**
 * @param {EntryPlan} plan
 * @returns {number}
 */
function versionNeeded(plan) {
  if (plan.sizesZip64 || plan.offsetZip64) return VERSION_ZIP64;
  if (plan.directory || plan.method === METHOD_DEFLATE) return VERSION_DEFLATE_OR_DIR;
  return VERSION_STORE;
}

/**
 * @param {EntryPlan} plan
 * @returns {Uint8Array}
 */
function encodeLocalHeader(plan) {
  // A local ZIP64 extra field must carry both sizes (APPNOTE 4.5.3).
  const zip64Fields = plan.sizesZip64 ? [plan.uncompressedSize, plan.compressedSize] : [];
  const extraLength = zip64ExtraLength(zip64Fields) + timeExtrasLength(plan);
  const out = new Uint8Array(LOCAL_HEADER_SIZE + plan.name.length + extraLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, SIG_LOCAL, true);
  view.setUint16(4, versionNeeded(plan), true);
  view.setUint16(6, FLAG_UTF8, true);
  view.setUint16(8, plan.method, true);
  view.setUint16(10, plan.dosTime, true);
  view.setUint16(12, plan.dosDate, true);
  view.setUint32(14, plan.crc, true);
  view.setUint32(18, plan.sizesZip64 ? MAX32 : plan.compressedSize, true);
  view.setUint32(22, plan.sizesZip64 ? MAX32 : plan.uncompressedSize, true);
  view.setUint16(26, plan.name.length, true);
  view.setUint16(28, extraLength, true);
  out.set(plan.name, LOCAL_HEADER_SIZE);
  let at = LOCAL_HEADER_SIZE + plan.name.length;
  at = writeZip64Extra(view, at, zip64Fields);
  writeTimeExtras(view, at, plan);
  return out;
}

/**
 * @param {EntryPlan} plan
 * @returns {Uint8Array}
 */
function encodeCentralHeader(plan) {
  /** @type {number[]} */
  const zip64Fields = [];
  if (plan.sizesZip64) zip64Fields.push(plan.uncompressedSize, plan.compressedSize);
  if (plan.offsetZip64) zip64Fields.push(plan.offset);
  const extraLength = zip64ExtraLength(zip64Fields) + timeExtrasLength(plan);
  const out = new Uint8Array(CENTRAL_HEADER_SIZE + plan.name.length + extraLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, SIG_CENTRAL, true);
  view.setUint16(4, MADE_BY, true);
  view.setUint16(6, versionNeeded(plan), true);
  view.setUint16(8, FLAG_UTF8, true);
  view.setUint16(10, plan.method, true);
  view.setUint16(12, plan.dosTime, true);
  view.setUint16(14, plan.dosDate, true);
  view.setUint32(16, plan.crc, true);
  view.setUint32(20, plan.sizesZip64 ? MAX32 : plan.compressedSize, true);
  view.setUint32(24, plan.sizesZip64 ? MAX32 : plan.uncompressedSize, true);
  view.setUint16(28, plan.name.length, true);
  view.setUint16(30, extraLength, true);
  view.setUint16(32, 0, true); // comment length
  view.setUint16(34, 0, true); // disk number
  view.setUint16(36, 0, true); // internal attributes
  view.setUint32(38, plan.directory ? DIR_ATTRIBUTES : FILE_ATTRIBUTES, true);
  view.setUint32(42, plan.offsetZip64 ? MAX32 : plan.offset, true);
  out.set(plan.name, CENTRAL_HEADER_SIZE);
  let at = CENTRAL_HEADER_SIZE + plan.name.length;
  at = writeZip64Extra(view, at, zip64Fields);
  writeTimeExtras(view, at, plan);
  return out;
}

/**
 * The end-of-central-directory record, preceded by the ZIP64 end record and locator when needed.
 * @param {number} count          number of entries
 * @param {number} centralSize    bytes in the central directory
 * @param {number} centralOffset  where the central directory starts
 * @param {boolean} force         write ZIP64 records and sentinels even when the values fit
 * @returns {Uint8Array}
 */
function encodeEnd(count, centralSize, centralOffset, force) {
  const countOverflow = force || count >= MAX16;
  const sizeOverflow = force || centralSize >= MAX32;
  const offsetOverflow = force || centralOffset >= MAX32;
  const zip64 = countOverflow || sizeOverflow || offsetOverflow;
  const out = new Uint8Array((zip64 ? ZIP64_EOCD_SIZE + ZIP64_LOCATOR_SIZE : 0) + EOCD_SIZE);
  const view = new DataView(out.buffer);
  let at = 0;
  if (zip64) {
    const zip64EndOffset = centralOffset + centralSize;
    view.setUint32(0, SIG_ZIP64_EOCD, true);
    setUint64(view, 4, ZIP64_EOCD_SIZE - 12); // size of the rest of this record
    view.setUint16(12, MADE_BY, true);
    view.setUint16(14, VERSION_ZIP64, true);
    view.setUint32(16, 0, true); // this disk
    view.setUint32(20, 0, true); // disk with the central directory
    setUint64(view, 24, count); // entries on this disk
    setUint64(view, 32, count); // entries in total
    setUint64(view, 40, centralSize);
    setUint64(view, 48, centralOffset);
    view.setUint32(56, SIG_ZIP64_LOCATOR, true);
    view.setUint32(60, 0, true); // disk with the ZIP64 end record
    setUint64(view, 64, zip64EndOffset);
    view.setUint32(72, 1, true); // total disks
    at = ZIP64_EOCD_SIZE + ZIP64_LOCATOR_SIZE;
  }
  view.setUint32(at, SIG_EOCD, true);
  view.setUint16(at + 4, 0, true); // this disk
  view.setUint16(at + 6, 0, true); // disk with the central directory
  view.setUint16(at + 8, countOverflow ? MAX16 : count, true);
  view.setUint16(at + 10, countOverflow ? MAX16 : count, true);
  view.setUint32(at + 12, sizeOverflow ? MAX32 : centralSize, true);
  view.setUint32(at + 16, offsetOverflow ? MAX32 : centralOffset, true);
  view.setUint16(at + 20, 0, true); // comment length
  return out;
}

/**
 * @param {number[]} fields
 * @returns {number}
 */
function zip64ExtraLength(fields) {
  return fields.length > 0 ? 4 + 8 * fields.length : 0;
}

/**
 * @param {DataView} view
 * @param {number} at
 * @param {number[]} fields
 * @returns {number} the offset after what was written
 */
function writeZip64Extra(view, at, fields) {
  if (fields.length === 0) return at;
  view.setUint16(at, EXTRA_ZIP64, true);
  view.setUint16(at + 2, 8 * fields.length, true);
  let p = at + 4;
  for (const value of fields) {
    setUint64(view, p, value);
    p += 8;
  }
  return p;
}

/**
 * @param {EntryPlan} plan
 * @returns {number}
 */
function timeExtrasLength(plan) {
  return plan.unixTime === null ? 0 : 4 + 5 + (4 + 8);
}

/**
 * The UT field, then the UX field, with the same bytes in the local and central headers.
 * UT: flags (bit 0 = modification time present) then the time as signed 32-bit seconds; only the
 * modification time is stored, so the central copy may hold the same 5 bytes as the local one.
 * UX: access time then modification time, 32-bit seconds each (both set to the modification time);
 * the optional user and group ids are left out so nothing about ownership is claimed.
 * @param {DataView} view
 * @param {number} at
 * @param {EntryPlan} plan
 * @returns {number}
 */
function writeTimeExtras(view, at, plan) {
  if (plan.unixTime === null) return at;
  view.setUint16(at, EXTRA_UNIX_TIME, true);
  view.setUint16(at + 2, 5, true);
  view.setUint8(at + 4, 1);
  view.setInt32(at + 5, plan.unixTime, true);
  view.setUint16(at + 9, EXTRA_UNIX_OLD, true);
  view.setUint16(at + 11, 8, true);
  view.setUint32(at + 13, plan.unixTime, true);
  view.setUint32(at + 17, plan.unixTime, true);
  return at + 21;
}

/**
 * @param {DataView} view
 * @param {number} at
 * @param {number} value  a non-negative safe integer
 */
function setUint64(view, at, value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`Not a 64-bit size: ${value}`);
  view.setUint32(at, value % TWO32, true);
  view.setUint32(at + 4, Math.floor(value / TWO32), true);
}

/** Low-level encoders, exported so tests can build archives too large to write for real. Not a stable API. */
export const internals = Object.freeze({ encodeLocalHeader, encodeCentralHeader, encodeEnd, entryZip64, dosDateTime });
