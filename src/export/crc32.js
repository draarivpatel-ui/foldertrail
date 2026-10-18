// CRC-32 (IEEE 802.3, reflected polynomial 0xEDB88320), the checksum ZIP stores for every entry.
// Table-driven, one byte at a time: simple and fast enough for the sizes a browser can hold.

/** @type {Uint32Array} */
const TABLE = makeTable();

/** @returns {Uint32Array} */
function makeTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

/**
 * CRC-32 of `bytes`, continuing from a previous result (zlib convention).
 * `crc32(b, crc32(a))` equals the CRC of `a` followed by `b`; start with 0 (the CRC of nothing).
 * @param {Uint8Array} bytes
 * @param {number} [previous] a finished CRC-32 of the bytes before these, or 0
 * @returns {number} unsigned 32-bit CRC
 */
export function crc32(bytes, previous = 0) {
  // An ArrayBuffer has no `length`, so it would silently give the CRC of nothing (which then "verifies"
  // an empty entry); other array-likes can hold values that are not bytes.
  if (!(bytes instanceof Uint8Array)) throw new TypeError('crc32 expects a Uint8Array.');
  let c = ~previous >>> 0;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** Incremental CRC-32 for data that arrives in chunks. */
export class Crc32 {
  constructor() {
    /** @private */
    this.value = 0;
  }

  /**
   * @param {Uint8Array} bytes
   * @returns {this}
   */
  update(bytes) {
    this.value = crc32(bytes, this.value);
    return this;
  }

  /** @returns {number} the unsigned 32-bit CRC of everything passed to update() so far */
  digest() {
    return this.value;
  }
}
