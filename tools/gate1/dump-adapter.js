// Gate 1 kit: the one place that knows the structure dump's API (src/format/dump.js, buildDump). Everything else in
// the kit calls structureDump(). If the dump module throws, the kit falls back to basicDump(): a short structure-only
// summary built from container.js's own results (signatures, versions, record counts and lengths), so the founder
// still gets something worth pasting back.
//
// Structure only (ARCHITECTURE.md §11): never a name, comment, coordinate, time, uuid, file name or path.

import { buildDump } from '../../src/format/dump.js';

/**
 * @typedef {object} DumpInput
 * @property {any} gdb   readContainer(AllData.gdb bytes, {role: 'gdb'}) or null
 * @property {any} gfi   readContainer(FolderData.gfi bytes, {role: 'gfi'}) or null
 * @property {Array<{name: string, bytes: Uint8Array, header: any}>} trackSegments   header = readHeader(bytes, {role: 'tracksegments'})
 * @property {"folder"|"zip"|"backup"|"package"|"files"} [inputKind]
 * @property {{count: number, bytes: number}} [otherFiles]   files that came with the library but are not read
 * @property {string} [toolVersion]   shown in the dump, e.g. "1-gate1"
 */

/**
 * The structure dump for one library: dump.js's text and data, or the basic summary if dump.js fails.
 * @param {DumpInput} input
 * @returns {{ text: string, json: object }}
 */
export function structureDump(input) {
  try {
    const segments = Array.isArray(input.trackSegments) ? input.trackSegments : [];
    const dump = buildDump({
      toolVersion: input.toolVersion,
      inputKind: input.inputKind,
      allData: input.gdb ?? null,
      folderData: input.gfi ?? null,
      // An empty folder sends no files when dropped, so "no files" and "no folder" look the same here.
      trackSegments: segments.length > 0 ? segments.map((s) => s.bytes) : null,
      otherFiles: input.otherFiles,
    });
    if (!dump || typeof dump.text !== 'string') throw new Error('no dump text');
    return { text: dump.text, json: dump.data };
  } catch {
    try {
      const basic = basicDump(input);
      return { text: `(The structure dump failed; this is the kit's basic summary instead.)\n${basic.text}`, json: { ...basic.json, dumpFailed: true } };
    } catch {
      return { text: '(The structure dump failed, and so did the basic summary. The comparison below still ran.)\n', json: { dumpFailed: true, basicFailed: true } };
    }
  }
}

/**
 * @param {Record<string, number>} counts
 * @returns {string}
 */
function histogram(counts) {
  const entries = Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.length === 0 ? '-' : entries.map(([k, v]) => `${k}:${v}`).join(', ');
}

/**
 * @param {Record<string, number>} counts
 * @param {unknown} key
 */
function bump(counts, key) {
  const k = String(key);
  counts[k] = (counts[k] ?? 0) + 1;
}

/**
 * Only codes of a safe shape are printed (they come from our own modules, but the dump is an allow-list).
 * @param {unknown} code
 * @returns {string}
 */
function safeCode(code) {
  const s = String(code);
  return /^[a-z0-9_]{1,48}$/i.test(s) ? s : 'other';
}

/**
 * @param {any} c   a container result
 * @returns {{ lines: string[], json: object }}
 */
function describeContainer(c) {
  /** @type {Record<string, {count: number, bytes: number, min: number, max: number}>} */
  const types = {};
  const records = Array.isArray(c.records) ? c.records : [];
  for (const r of records) {
    const t = typeof r.type === 'string' && /^[\x21-\x7e]$/.test(r.type) ? r.type : `0x${Number(r.typeCode ?? 0).toString(16)}`;
    const len = Number(r.length) || 0;
    const s = types[t] ?? (types[t] = { count: 0, bytes: 0, min: len, max: len });
    s.count++;
    s.bytes += len;
    s.min = Math.min(s.min, len);
    s.max = Math.max(s.max, len);
  }
  const problems = Array.isArray(c.problems) ? c.problems.map((/** @type {any} */ p) => ({ code: safeCode(p.code), count: Number(p.count) || 0 })) : [];
  const json = {
    size: Number(c.size) || 0,
    signature: c.signature ?? null,
    signatureHex: typeof c.signatureHex === 'string' && /^[0-9A-F]{0,8}$/.test(c.signatureHex) ? c.signatureHex : null,
    primaryFormat: c.primaryFormat ?? null,
    formatVersion: c.formatVersion ?? null,
    versionClass: c.versionClass ?? null,
    programVersion: c.programVersion ?? null,
    authorRecordAsExpected: c.authorRecordAsExpected ?? null,
    application: c.application ?? null,
    headerRead: !!c.ok,
    complete: !!c.complete,
    stopped: c.stopped ? safeCode(c.stopped) : null,
    recordCount: Number(c.recordCount) || records.length,
    types,
    endRecord: c.end ? { present: !!c.end.present, bytesAfter: Number(c.end.bytesAfter) || 0 } : null,
    problems,
  };
  const lines = [
    `  size ${json.size} bytes; signature ${json.signature ?? `hex ${json.signatureHex ?? '-'}`}; primary format ${json.primaryFormat === null ? '-' : `0x${Number(json.primaryFormat).toString(16).padStart(4, '0')}`}; ` +
      `file format (D) ${json.formatVersion ?? '-'} (${json.versionClass ?? '-'}); program version (A) ${json.programVersion ?? '-'}; ` +
      `application ${json.application ?? '-'}; author record as expected ${json.authorRecordAsExpected === null ? '-' : json.authorRecordAsExpected ? 'yes' : 'no'}`,
    `  header read ${json.headerRead ? 'yes' : 'no'}; framing complete ${json.complete ? 'yes' : 'no'}${json.stopped ? `; stopped: ${json.stopped}` : ''}; records ${json.recordCount}`,
    `  record types (count, total bytes, min-max length): ${
      Object.keys(types).length === 0
        ? '-'
        : Object.entries(types)
            .map(([t, s]) => `${t} ${s.count} ${s.bytes} ${s.min}-${s.max}`)
            .join('; ')
    }`,
  ];
  if (json.endRecord) lines.push(`  end record (X) present ${json.endRecord.present ? 'yes' : 'no'}; bytes after it ${json.endRecord.bytesAfter}`);
  if (problems.length > 0) lines.push(`  problems: ${problems.map((p) => `${p.code} ${p.count}`).join('; ')}`);
  return { lines, json };
}

/**
 * @param {DumpInput} input
 * @returns {{ text: string, json: object }}
 */
export function basicDump(input) {
  /** @type {string[]} */
  const lines = ['(basic structure summary from the kit)'];
  /** @type {any} */
  const json = { source: 'gate1-basic' };
  for (const [label, key] of /** @type {const} */ ([
    ['AllData.gdb', 'gdb'],
    ['FolderData.gfi', 'gfi'],
  ])) {
    const c = input ? input[key] : null;
    if (!c) {
      lines.push(`${label}: not present`);
      json[key] = null;
      continue;
    }
    const d = describeContainer(c);
    lines.push(`${label}:`, ...d.lines);
    json[key] = d.json;
  }
  const ts = input && Array.isArray(input.trackSegments) ? input.trackSegments : [];
  /** @type {Record<string, number>} */
  const signatures = {};
  /** @type {Record<string, number>} */
  const formats = {};
  /** @type {Record<string, number>} */
  const programs = {};
  /** @type {Record<string, number>} */
  const applications = {};
  let headersRead = 0;
  for (const s of ts) {
    const h = s && s.header ? s.header : {};
    if (h.ok) headersRead++;
    const hex = typeof h.signatureHex === 'string' && /^[0-9A-F]{0,8}$/.test(h.signatureHex) ? h.signatureHex : '-';
    bump(signatures, h.signature ?? `hex ${hex}`);
    bump(formats, h.formatVersion ?? '-');
    bump(programs, h.programVersion ?? '-');
    bump(applications, h.application ?? '-');
  }
  lines.push(
    `TrackSegments: ${ts.length} files; headers read ${headersRead}; signatures ${histogram(signatures)}; file formats (D) ${histogram(formats)}; ` +
      `program versions (A) ${histogram(programs)}; applications ${histogram(applications)}`,
  );
  json.trackSegments = { files: ts.length, headersRead, signatures, formats, programs, applications };
  return { text: lines.join('\n') + '\n', json };
}
