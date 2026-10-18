// Packs a fixture library as a BaseCamp-style ".Backup" file: a ZIP of <name>/Database/<version>/… (FORMAT.md §1, §12).
//
// The task for this tool says to build it with src/export/zip.js; FORMAT.md §12 and ARCHITECTURE.md §14 describe a
// separate node:zlib writer instead. This file is the only place in tools/fixtures/ that imports from src/, so swapping
// the ZIP writer later touches nothing else (see README.md, "Choices").

import { zipBytes } from '../../src/export/zip.js';

/**
 * @typedef {object} BackupOptions
 * @property {string} [name]            top folder inside the archive, default "BaseCamp_x"
 * @property {'store'|'auto'} [compression]  "store" (default) gives byte-identical archives on every engine; "auto"
 *   deflates with the engine's CompressionStream when that is smaller
 * @property {'auto'|'always'} [zip64]  "always" writes ZIP64 records even though the archive is small
 * @property {boolean} [directories]    write explicit folder entries (default true)
 */

/**
 * The archive entries, in order: folders first when requested, then AllData.gdb, FolderData.gfi and the
 * TrackSegments files in the library's own order.
 * @param {{files: Map<string, Uint8Array>, databaseVersion: string}} built  the result of buildLibrary
 * @param {BackupOptions} [options]
 * @returns {Array<{path: string, bytes?: Uint8Array}>}
 */
export function backupEntries(built, options = {}) {
  const name = options.name ?? 'BaseCamp_x';
  if (!/^[A-Za-z0-9_. -]+$/.test(name) || name.startsWith('.')) throw new RangeError('backup name must be a plain folder name');
  const base = `${name}/Database/${built.databaseVersion}/`;
  /** @type {Array<{path: string, bytes?: Uint8Array}>} */
  const entries = [];
  const dirs = options.directories ?? true;
  if (dirs) entries.push({ path: `${name}/` }, { path: `${name}/Database/` }, { path: base });
  let tsDir = false;
  for (const [path, bytes] of built.files) {
    if (dirs && !tsDir && path.startsWith('TrackSegments/')) {
      entries.push({ path: `${base}TrackSegments/` });
      tsDir = true;
    }
    entries.push({ path: base + path, bytes });
  }
  return entries;
}

/**
 * Builds the .Backup bytes.
 * @param {{files: Map<string, Uint8Array>, databaseVersion: string}} built
 * @param {BackupOptions} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function buildBackup(built, options = {}) {
  return zipBytes(backupEntries(built, options), {
    compression: options.compression ?? 'store',
    zip64: options.zip64 ?? 'auto',
  });
}
