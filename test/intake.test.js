// Tests for src/app/intake.js.
// Browsers are imitated with fake FileSystemEntry / DirectoryReader objects, fake DataTransfers and
// FileLists carrying webkitRelativePath; backups are written with src/export/zip.js. All data is
// synthetic: library files are a made-up 'MsRc' header followed by zeros.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipBytes } from '../src/export/zip.js';
import {
  intake,
  captureDrop,
  toWorkerSource,
  fromWorkerSource,
  SourceReadError,
  DEFAULT_INTAKE_LIMITS,
} from '../src/app/intake.js';
import { buildSummary, extensionClass, detectFeatures } from '../src/app/probe.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const SENT = 'Zq7Sentinel';

/** A made-up library file: the 'MsRc' signature and the 1.2 primary format, then zeros. */
function lib(size = 64, fill = 0) {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set(enc.encode('MsRc'), 0);
  bytes[4] = 0x66;
  return bytes;
}
const gfi = (size = 48) => {
  const bytes = new Uint8Array(size);
  bytes.set(enc.encode('DifG'), 0);
  bytes[4] = 0x66;
  return bytes;
};
const uuid = (i) => `${i.toString(16).padStart(8, '0')}-0000-4000-8000-${(i * 7).toString(16).padStart(12, '0')}`;

// Counts every byte access, so tests can prove that intake reads nothing it does not need.
let reads = 0;
class SpyFile extends File {
  slice(...args) {
    reads++;
    return super.slice(...args);
  }
  arrayBuffer() {
    reads++;
    return super.arrayBuffer();
  }
  stream() {
    reads++;
    return super.stream();
  }
  text() {
    reads++;
    return super.text();
  }
}

/** A file the browser hands over but cannot read (a folder or package that arrived as a file). */
class BrokenFile extends File {
  slice() {
    return { arrayBuffer: () => Promise.reject(new Error('NotReadableError')) };
  }
  arrayBuffer() {
    return Promise.reject(new Error('NotReadableError'));
  }
}

/** A file that shrinks after it was statted. */
class ShrinkingFile extends File {
  slice(start, end) {
    return super.slice(start, Math.max(start, end - 1));
  }
}

/** @type {string[]} */
let statted = [];

class FileEntry {
  constructor(name, data, opts = {}) {
    this.isFile = true;
    this.isDirectory = false;
    this.name = name;
    this.fullPath = `/${name}`;
    this.data = data;
    this.opts = opts;
  }

  file(ok, fail) {
    statted.push(this.name);
    const mode = this.opts.mode ?? 'ok';
    if (mode === 'never') return;
    if (mode === 'throw') throw new Error('file() threw');
    queueMicrotask(() => {
      if (mode === 'error') fail(new Error('NotFoundError'));
      else ok(this.opts.file ?? new SpyFile([this.data], this.name, { lastModified: this.opts.mtime ?? 1000 }));
    });
  }
}

class DirEntry {
  constructor(name, children, opts = {}) {
    this.isFile = false;
    this.isDirectory = true;
    this.name = name;
    this.fullPath = `/${name}`;
    this.children = children;
    this.opts = opts;
    this.readCalls = 0;
  }

  createReader() {
    if (this.opts.mode === 'no-reader') throw new Error('createReader threw');
    const batch = this.opts.batch ?? 100;
    let pos = 0;
    let calls = 0;
    return {
      readEntries: (ok, fail) => {
        this.readCalls++;
        calls++;
        const mode = this.opts.mode ?? 'ok';
        if (mode === 'never') return;
        // The first batch arrives, then the browser fails ('error-later') or goes quiet ('silent-later').
        if (mode === 'silent-later' && calls > 1) return;
        queueMicrotask(() => {
          if (mode === 'error') return fail(new Error('NotReadableError'));
          if (mode === 'error-later' && calls > 1) return fail(new Error('NotReadableError'));
          if (mode === 'endless') return ok(this.children.slice(0, batch));
          if (mode === 'twice') {
            ok(this.children.slice(pos, (pos += batch)));
            return fail(new Error('second answer'));
          }
          if (mode === 'object') return ok({ not: 'an array' });
          ok(this.children.slice(pos, (pos += batch)));
        });
      },
    };
  }
}

const f = (name, data = new Uint8Array(0), opts) => new FileEntry(name, data, opts);
const d = (name, children, opts) => new DirEntry(name, children, opts);

/** A version folder as BaseCamp lays it out. */
function versionDir(name, { tracks = 3, allData = lib(), mtime = 1000, extra = [], trackOpts } = {}) {
  const segments = [];
  for (let i = 0; i < tracks; i++) segments.push(f(uuid(i + 1), lib(40), trackOpts));
  return d(name, [f('AllData.gdb', allData, { mtime }), f('FolderData.gfi', gfi()), d('TrackSegments', segments), ...extra]);
}

/**
 * A fake drop. Like a real one, its items are emptied right after the event (a microtask later), so
 * intake must capture them synchronously.
 */
function dropOf(entries, { withEntries = true, clear = true, files } = {}) {
  const items = entries.map((e) => ({
    kind: 'file',
    type: '',
    webkitGetAsEntry: withEntries ? () => e : undefined,
    getAsFile: () => (e instanceof File ? e : e.isFile ? new File([e.data], e.name) : new File([], e.name)),
  }));
  const dt = { types: ['Files'], items, files: files ?? items.map((i) => i.getAsFile()), dropEffect: 'copy' };
  if (clear) {
    queueMicrotask(() => {
      items.length = 0;
      dt.files = [];
    });
  }
  return dt;
}

/** A File as <input webkitdirectory> delivers it. */
function relFile(path, data = new Uint8Array(0), FileClass = File) {
  const name = path.split('/').pop();
  const file = new FileClass([data], name, { lastModified: 1000 });
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
}

async function backup(name, entries, options) {
  const bytes = await zipBytes(
    entries.map(([path, data]) => (data === null ? { path } : { path, bytes: data })),
    options,
  );
  return new File([bytes], name);
}

const codes = (list) => list.map((p) => p.code).sort();
const has = (list, code) => list.some((p) => p.code === code);
const find = (list, code) => list.find((p) => p.code === code);

// ---------------------------------------------------------------------------------------------
// Drops (FileSystemEntry API)

test('a dropped Database folder: newest version used, batches read to the end, only needed files statted', async () => {
  statted = [];
  reads = 0;
  const thumbnails = d('Thumbnails', [f('t1.jpg'), f('t2.jpg'), f('t3.jpg')]);
  const v48 = versionDir('4.8', { tracks: 250, extra: [thumbnails, f('.DS_Store')] });
  const v47 = versionDir('4.7', { tracks: 30 });
  const db = d('Database', [v47, v48]);
  const result = await intake(dropOf([db]));

  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
  assert.equal(result.found.version, '4.8');
  assert.equal(result.found.versionFolder, 'Database/4.8');
  assert.equal(result.found.trackSegments.size, 250);
  assert.ok(result.found.trackSegments.has(uuid(250)));
  assert.equal(result.input.delivery, 'entries');
  assert.equal(result.input.kind, 'folder');
  assert.equal(result.input.libraryFolders, 2);
  const note = find(result.notes, 'several_versions');
  assert.ok(note, JSON.stringify(result.notes));
  assert.match(note.message, /\(4\.7, 4\.8\)/);
  assert.match(note.message, /Version 4\.8 was used/);

  // readEntries hands out 100 at a time: 3 batches and the empty one that ends the listing.
  const trackDir = v48.children.find((c) => c.name === 'TrackSegments');
  assert.equal(trackDir.readCalls, 4);
  // Statted: both AllData.gdb (to compare them), 4.8's FolderData.gfi and its 250 TrackSegments. Nothing else.
  assert.equal(statted.filter((n) => n === 'AllData.gdb').length, 2);
  assert.equal(statted.filter((n) => n === 'FolderData.gfi').length, 1);
  assert.equal(statted.length, 2 + 1 + 250);
  assert.ok(!statted.includes('t1.jpg'));
  assert.equal(reads, 0, 'intake read file bytes');

  const head = await result.found.allData.bytes(0, 4);
  assert.equal(dec.decode(head), 'MsRc');
  assert.equal(result.found.allData.origin, 'file');
  assert.ok(result.found.allData.blob instanceof File);
  assert.equal(result.found.folderData.size, 48);
});

test('the drop is captured before the first await; a DataTransfer read later is empty', async () => {
  const late = dropOf([versionDir('4.8')]);
  await Promise.resolve();
  await Promise.resolve();
  const result = await intake(late);
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result.problems), ['nothing_dropped']);

  const dt = dropOf([versionDir('4.8')]);
  const capture = captureDrop(dt);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(dt.items.length, 0);
  const fromCapture = await intake(capture);
  assert.equal(fromCapture.ok, true);
  assert.equal(capture.entryApi, true);
  assert.equal(capture.raw[0].entry, 'folder');
  assert.equal(capture.raw[0].name, '4.8');
});

test('deep trees: folders beyond maxDepth are not entered; deep chains do not overflow the stack', async () => {
  let chain = versionDir('4.8');
  for (let i = 0; i < 40; i++) chain = d(`level${i}`, [chain]);
  const tooDeep = await intake(dropOf([chain]));
  assert.equal(tooDeep.ok, false);
  assert.ok(has(tooDeep.problems, 'too_deep'));
  assert.ok(has(tooDeep.problems, 'no_library'));

  let deep = versionDir('4.8');
  for (let i = 0; i < 400; i++) deep = d(`n${i}`, [deep]);
  const found = await intake(dropOf([deep]), { limits: { maxDepth: 1000 } });
  assert.equal(found.ok, true);
  assert.equal(found.found.version, '4.8');

  let side = d('side', []);
  for (let i = 0; i < 40; i++) side = d(`s${i}`, [side]);
  const mixed = await intake(dropOf([d('BaseCamp', [d('Database', [versionDir('4.8')]), side])]));
  assert.equal(mixed.ok, true);
  assert.ok(has(mixed.problems, 'too_deep'));
});

test('a .bclibrary package that arrives as a folder is walked like one', async () => {
  const pkg = d('Trips.bclibrary', [d('Database', [versionDir('4.8')])]);
  const result = await intake(dropOf([pkg]));
  assert.equal(result.ok, true);
  assert.equal(result.input.kind, 'package');
  assert.equal(result.found.versionFolder, 'Trips.bclibrary/Database/4.8');
});

test('a .bclibrary package that arrives as an unreadable or empty file is explained', async () => {
  for (const file of [new BrokenFile([new Uint8Array(96)], 'Trips.bclibrary'), new File([], 'Trips.bclibrary')]) {
    const entry = f('Trips.bclibrary', new Uint8Array(0), { file });
    const result = await intake(dropOf([entry]));
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result.problems), ['package_as_file']);
    assert.match(result.problems[0].message, /Show Package Contents/);
  }
});

test('a .bclibrary package that arrives as a ZIP is read as a backup', async () => {
  const zip = await backup('x', [
    ['Database/4.8/AllData.gdb', lib()],
    ['Database/4.8/FolderData.gfi', gfi()],
    [`Database/4.8/TrackSegments/${uuid(1)}`, lib(40)],
  ]);
  const entry = f('Trips.bclibrary', new Uint8Array(0), { file: new File([zip], 'Trips.bclibrary') });
  const result = await intake(dropOf([entry]));
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.input.kind, 'zip');
  assert.ok(has(result.notes, 'package_as_zip'));
  assert.equal(result.found.allData.origin, 'zip');
});

test('duplicate names: the first wins and is counted; the exact spelling beats a case variant', async () => {
  const first = lib(64, 1);
  const second = lib(64, 2);
  const dup = d('4.8', [f('AllData.gdb', first), f('AllData.gdb', second), f('FolderData.gfi', gfi()), d('TrackSegments', [])]);
  const result = await intake(dropOf([dup]));
  assert.equal(result.ok, true);
  assert.ok(has(result.problems, 'duplicate_name'));
  assert.equal((await result.found.allData.bytes(5, 6))[0], 1);

  const variants = d('4.8', [f('alldata.gdb', first), f('AllData.gdb', second), f('FolderData.gfi', gfi()), d('TrackSegments', [])]);
  const picked = await intake(dropOf([variants]));
  assert.equal(picked.found.allData.name, 'AllData.gdb');
  assert.equal((await picked.found.allData.bytes(5, 6))[0], 2);
  assert.ok(has(picked.problems, 'case_variant'));

  const twice = await intake(dropOf([versionDir('4.8'), versionDir('4.8')]));
  assert.equal(twice.ok, true);
  assert.ok(has(twice.problems, 'duplicate_name'));

  const lowerOnly = await intake(dropOf([d('4.8', [f('alldata.gdb', first), f('folderdata.gfi', gfi()), d('tracksegments', [f(uuid(1), lib(40))])])]));
  assert.equal(lowerOnly.ok, true);
  assert.equal(lowerOnly.found.trackSegments.size, 1);
  assert.ok(lowerOnly.found.folderData);
});

test('0-byte files: an empty AllData.gdb is reported; an empty TrackSegments file is kept and counted', async () => {
  const empty = await intake(dropOf([versionDir('4.8', { allData: new Uint8Array(0) })]));
  assert.equal(empty.ok, false);
  assert.equal(empty.found.allData, null);
  assert.deepEqual(codes(empty.problems), ['all_data_empty']);

  const small = await intake(dropOf([versionDir('4.8', { allData: lib(17) })]));
  assert.deepEqual(codes(small.problems), ['all_data_too_small']);

  const zeroTrack = d('4.8', [f('AllData.gdb', lib()), f('FolderData.gfi', gfi()), d('TrackSegments', [f(uuid(9), new Uint8Array(0)), f('notes.txt', lib(20))])]);
  const result = await intake(dropOf([zeroTrack]));
  assert.equal(result.ok, true);
  assert.equal(result.found.trackSegments.size, 2);
  assert.equal(result.found.trackSegments.get(uuid(9)).size, 0);
  assert.equal((await result.found.trackSegments.get(uuid(9)).bytes()).length, 0);
  assert.equal(result.input.roles.trackSegmentsEmpty, 1);
  assert.equal(result.input.roles.trackSegmentsOtherNames, 1);
});

test('a newer version folder that cannot be used falls back to the older one, and says so', async () => {
  const db = d('Database', [versionDir('4.7'), versionDir('4.8', { allData: new Uint8Array(0) })]);
  const result = await intake(dropOf([db]));
  assert.equal(result.ok, true);
  assert.equal(result.found.version, '4.7');
  const problem = find(result.problems, 'newer_version_unusable');
  assert.ok(problem, JSON.stringify(result.problems));
  assert.match(problem.message, /4\.8/);
  assert.match(problem.message, /older version 4\.7/);
  assert.match(problem.message, /it is empty/);
  assert.match(problem.message, /out of date/);
});

test('version numbers compare as integers, versioned folders beat loose files, then completeness and date', async () => {
  const db = d('Database', [versionDir('4.9'), versionDir('4.10'), versionDir('4.8')]);
  const result = await intake(dropOf([db]));
  assert.equal(result.found.version, '4.10');

  const mixed = await intake(dropOf([f('AllData.gdb', lib()), versionDir('4.8')]));
  assert.equal(mixed.found.version, '4.8');
  assert.ok(has(mixed.notes, 'several_libraries'));

  const a = d('A.bclibrary', [d('Database', [versionDir('4.8', { mtime: 1000 })])]);
  const b = d('B.bclibrary', [d('Database', [versionDir('4.8', { mtime: 5000 })])]);
  const two = await intake(dropOf([a, b]));
  assert.equal(two.found.versionFolder, 'B.bclibrary/Database/4.8');
  assert.ok(has(two.notes, 'several_libraries'));

  const incomplete = d('C', [d('4.8', [f('AllData.gdb', lib(), { mtime: 9000 })])]);
  const complete = d('D', [versionDir('4.8', { mtime: 1 })]);
  const byCompleteness = await intake(dropOf([incomplete, complete]));
  assert.equal(byCompleteness.found.versionFolder, 'D/4.8');
});

// ---------------------------------------------------------------------------------------------
// File lists, loose files, backups

test('a webkitdirectory FileList: paths come from webkitRelativePath', async () => {
  const files = [
    relFile('BaseCamp/Database/4.8/AllData.gdb', lib()),
    relFile('BaseCamp/Database/4.8/FolderData.gfi', gfi()),
    relFile(`BaseCamp/Database/4.8/TrackSegments/${uuid(1)}`, lib(40)),
    relFile(`BaseCamp/Database/4.8/TrackSegments/${uuid(2)}`, lib(40)),
    relFile('BaseCamp/Database/4.8/.DS_Store', lib(8)),
    relFile('BaseCamp/../escape.gdb', lib()),
    relFile('BaseCamp/Database/4.8/AllData.gdb', lib(64, 9)),
  ];
  const result = await intake(files);
  assert.equal(result.ok, true);
  assert.equal(result.input.delivery, 'file-list');
  assert.equal(result.input.kind, 'folder');
  assert.equal(result.found.versionFolder, 'BaseCamp/Database/4.8');
  assert.equal(result.found.trackSegments.size, 2);
  assert.ok(has(result.problems, 'bad_name'));
  assert.ok(has(result.problems, 'duplicate_name'));
  assert.equal((await result.found.allData.bytes(5, 6))[0], 0, 'the first of the duplicates is used');
  assert.equal(result.input.topFolders, 1);
});

test('loose files: AllData.gdb and FolderData.gfi given together', async () => {
  reads = 0;
  const result = await intake([new SpyFile([lib()], 'AllData.gdb'), new SpyFile([gfi()], 'FolderData.gfi')]);
  assert.equal(result.ok, true);
  assert.equal(result.input.delivery, 'files');
  assert.equal(result.input.kind, 'files');
  assert.equal(result.found.versionFolder, '');
  assert.equal(result.found.version, null);
  assert.deepEqual(codes(result.problems), ['no_track_segments']);
  assert.equal(reads, 0);
});

test('a .Backup ZIP: the library is found inside, entries are read on demand, macOS clutter is ignored', async () => {
  const root = 'BaseCamp_20261005';
  const file = await backup(`${root}.Backup`, [
    [`${root}/`, null],
    [`${root}/Database/4.8/AllData.gdb`, lib(5000)],
    [`${root}/Database/4.8/FolderData.gfi`, gfi()],
    [`${root}/Database/4.8/TrackSegments/${uuid(1)}`, lib(40)],
    [`${root}/Database/4.8/TrackSegments/${uuid(2)}`, lib(41)],
    [`${root}/Database/4.8/TrackSegments/${uuid(3)}`, lib(42)],
    [`${root}/Database/4.8/Thumbnails/a.jpg`, lib(30)],
    [`__MACOSX/${root}/Database/4.8/._AllData.gdb`, lib(10)],
  ]);
  const result = await intake(file, { listing: true });
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.deepEqual(result.problems, []);
  assert.equal(result.input.kind, 'zip');
  assert.equal(result.input.archiveEntries, 8);
  assert.equal(result.found.versionFolder, `${root}/Database/4.8`);
  assert.equal(result.found.trackSegments.size, 3);
  const all = result.found.allData;
  assert.equal(all.origin, 'zip');
  assert.equal(all.blob, null);
  assert.equal(all.size, 5000);
  assert.equal(dec.decode(await all.bytes(0, 4)), 'MsRc');
  assert.equal((await all.bytes(4990, 1e9)).length, 10);
  all.release();
  assert.equal((await all.bytes()).length, 5000);
  assert.equal((await result.found.trackSegments.get(uuid(3)).bytes()).length, 42);
  const macRow = result.listing.find((row) => row.path.startsWith('__MACOSX'));
  assert.equal(macRow.skipped, 'hidden or system item');
  assert.equal(result.listing.find((row) => row.role === 'allData').inArchive, true);
});

test('a compressed backup in a browser without DecompressionStream("deflate-raw") is explained', async () => {
  const file = await backup('b.Backup', [
    ['Database/4.8/AllData.gdb', lib(4000)],
    ['Database/4.8/FolderData.gfi', gfi(2000)],
  ]);
  const result = await intake(file, { features: { inflateRaw: false } });
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result.problems), ['cannot_unzip_here']);
  assert.match(result.problems[0].message, /Finder/);

  const stored = await backup('s.Backup', [['Database/4.8/AllData.gdb', lib(4000)]], { compression: 'store' });
  const ok = await intake(stored, { features: { inflateRaw: false } });
  assert.equal(ok.ok, true, 'stored entries need no inflater');
});

test('backups that are not ZIPs, hold no library, or are damaged', async () => {
  const random = new Uint8Array(300).map((_, i) => (i * 37 + 11) & 0xff);
  const notZip = await intake(new File([random], 'x.Backup'));
  assert.deepEqual(codes(notZip.problems), ['backup_not_zip']);

  const empty = await intake(new File([], 'x.Backup'));
  assert.deepEqual(codes(empty.problems), ['backup_empty_file']);

  const noLib = await intake(await backup('y.zip', [['Photos/a.jpg', lib(30)]]));
  assert.deepEqual(codes(noLib.problems), ['backup_no_library']);

  const good = await zipBytes([{ path: 'Database/4.8/AllData.gdb', bytes: lib(3000) }]);
  const cut = await intake(new File([good.subarray(0, good.length - 30)], 'cut.Backup'));
  assert.equal(cut.ok, false);
  assert.equal(cut.problems.length, 1);
  assert.match(cut.problems[0].code, /^backup_/);

  const two = await intake([await backup('a.Backup', [['x', lib()]]), await backup('b.Backup', [['y', lib()]])]);
  assert.deepEqual(codes(two.problems), ['several_backups']);

  // A folder that holds a library and a backup: the folder wins and the backup is not read.
  const both = await intake([relFile('4.8/AllData.gdb', lib()), new File([good], 'old.Backup')]);
  assert.equal(both.ok, true);
  assert.ok(has(both.notes, 'ignored_backups'));

  const nested = await intake([relFile('Stuff/old.Backup', good), relFile('Stuff/readme.txt', lib(10))]);
  assert.deepEqual(codes(nested.problems), ['backup_inside_folder']);
});

test('a backup entry whose data is damaged rejects bytes() with a plain-words SourceReadError', async () => {
  const bytes = await zipBytes([{ path: 'Database/4.8/AllData.gdb', bytes: lib(3000, 7) }], { compression: 'store' });
  // Flip one data byte after the local header: the CRC check fails when the entry is read.
  const damaged = new Uint8Array(bytes);
  damaged[30 + 'Database/4.8/AllData.gdb'.length + 100] ^= 0xff;
  const result = await intake(new File([damaged], 'd.Backup'));
  assert.equal(result.ok, true, 'intake only reads the table of contents');
  await assert.rejects(result.found.allData.bytes(0, 4), (error) => {
    assert.ok(error instanceof SourceReadError);
    assert.equal(error.code, 'damaged');
    return true;
  });
});

test('exports and stray files are explained instead of converted (decision B5)', async () => {
  const gdb = await intake(new File([lib()], `${SENT} hikes.gdb`));
  assert.deepEqual(codes(gdb.problems), ['exported_gdb']);
  assert.match(gdb.problems[0].message, /folders and lists/);

  const renamed = await intake(new File([lib()], 'export'));
  assert.deepEqual(codes(renamed.problems), ['exported_gdb']);

  const gpx = await intake([new File([enc.encode('<gpx/>')], 'a.gpx'), new File([enc.encode('<gpx/>')], 'b.gpx')]);
  assert.deepEqual(codes(gpx.problems), ['gpx_given']);
  assert.equal(gpx.problems[0].count, 2);

  const onlyTree = await intake([new File([gfi()], 'FolderData.gfi')]);
  assert.deepEqual(codes(onlyTree.problems), ['no_all_data']);

  const nothing = await intake([new File([enc.encode('hello')], 'notes.txt')]);
  assert.deepEqual(codes(nothing.problems), ['no_library']);
});

test('signs of a Windows library add a hedged note (decision B32)', async () => {
  const files = [
    relFile('AppData/Roaming/Garmin/BaseCamp/Database/4.7/AllData.gdb', lib()),
    relFile('AppData/Roaming/Garmin/BaseCamp/Database/4.7/FolderData.gfi', gfi()),
    relFile('AppData/Roaming/Garmin/BaseCamp/Database/4.7/TrackSegments/Thumbs.db', lib(20)),
  ];
  const result = await intake(files);
  assert.equal(result.ok, true);
  assert.ok(has(result.notes, 'windows_library'));
  assert.equal(result.input.windowsSigns, 2);
  assert.match(find(result.notes, 'windows_library').message, /not been checked/);

  // A backup written with backslashes, as some Windows tools do. Same length, so the archive stays valid.
  const bytes = await zipBytes([{ path: 'WinRoot/Database/4.7/AllData.gdb', bytes: lib() }], { compression: 'store' });
  const from = enc.encode('WinRoot/Database/4.7/');
  const to = enc.encode('WinRoot\\Database\\4.7\\');
  for (let i = 0; i + from.length <= bytes.length; i++) {
    if (from.every((b, k) => bytes[i + k] === b)) bytes.set(to, i);
  }
  const zipResult = await intake(new File([bytes], 'w.Backup'));
  assert.equal(zipResult.ok, true, JSON.stringify(zipResult.problems));
  assert.equal(zipResult.found.versionFolder, 'WinRoot/Database/4.7');
  assert.ok(has(zipResult.notes, 'windows_library'));

  const mac = await intake(dropOf([versionDir('4.8')]));
  assert.ok(!has(mac.notes, 'windows_library'));
});

// ---------------------------------------------------------------------------------------------
// Browsers misbehaving

test('readEntries errors, silence, double answers and odd answers never hang or throw', async () => {
  const limits = { callbackTimeoutMs: 20 };
  const error = await intake(dropOf([d('Database', [d('4.8', [], { mode: 'error' }), versionDir('4.7')])]), { limits });
  assert.equal(error.found.version, '4.7');
  assert.ok(has(error.problems, 'folder_unreadable'));

  const started = Date.now();
  const silent = await intake(dropOf([d('Database', [d('4.8', [], { mode: 'never' }), versionDir('4.7')])]), { limits });
  assert.ok(Date.now() - started < 5000);
  assert.equal(silent.found.version, '4.7');
  assert.ok(has(silent.problems, 'browser_no_answer'));

  const twice = await intake(dropOf([d('4.8', [f('AllData.gdb', lib()), f('FolderData.gfi', gfi())], { mode: 'twice' })]), { limits });
  assert.equal(twice.ok, true);

  const odd = await intake(dropOf([d('4.8', [], { mode: 'object' })]), { limits });
  assert.ok(has(odd.problems, 'folder_unreadable'));

  const noReader = await intake(dropOf([d('4.8', [], { mode: 'no-reader' })]), { limits });
  assert.ok(has(noReader.problems, 'folder_unreadable'));

  const weird = await intake(dropOf([d('4.8', [null, 5, { isFile: true, name: 'AllData.gdb' }, { get name() { throw new Error('x'); }, isDirectory: true }, f('AllData.gdb', lib())])]), { limits });
  assert.equal(weird.ok, true);
  assert.ok(has(weird.problems, 'bad_entry'));
  assert.ok(weird.problems.find((p) => p.code === 'bad_entry').count >= 3);
});

test('file() that fails, throws or never answers makes the file unreadable, with a fallback to getAsFile', async () => {
  const limits = { callbackTimeoutMs: 20 };
  for (const mode of ['error', 'throw', 'never']) {
    const result = await intake(dropOf([d('4.8', [f('AllData.gdb', lib(), { mode })])]), { limits });
    assert.equal(result.ok, false, mode);
    assert.deepEqual(codes(result.problems), ['all_data_unreadable'], mode);
  }
  const companions = await intake(
    dropOf([d('4.8', [f('AllData.gdb', lib()), f('FolderData.gfi', gfi(), { mode: 'error' }), d('TrackSegments', [f(uuid(1), lib(40), { mode: 'never' })])])]),
    { limits },
  );
  assert.equal(companions.ok, true);
  assert.equal(companions.found.folderData, null);
  assert.deepEqual(codes(companions.problems), ['folder_data_unreadable', 'track_segment_unreadable']);

  // A top-level file whose entry cannot give a File falls back to the item's getAsFile().
  const loose = f('AllData.gdb', lib(), { mode: 'error' });
  const fallback = await intake(dropOf([loose]), { limits });
  assert.equal(fallback.ok, true);
});

test('without webkitGetAsEntry the drop falls back to DataTransfer.files; a folder handed over as a file is explained', async () => {
  const result = await intake(dropOf([new File([lib()], 'AllData.gdb'), new File([gfi()], 'FolderData.gfi')], { withEntries: false }));
  assert.equal(result.ok, true);
  assert.equal(result.input.delivery, 'files');

  const folder = await intake(dropOf([new BrokenFile([new Uint8Array(96)], '4.8')], { withEntries: false }));
  assert.deepEqual(codes(folder.problems), ['folder_as_file']);

  const filesOnly = { types: ['Files'], items: [], files: [new File([lib()], 'AllData.gdb')] };
  const capture = captureDrop(filesOnly);
  assert.equal(capture.usedFiles, true);
  assert.equal(capture.raw[0].kind, 'files-list');
  assert.equal((await intake(capture)).ok, true);

  const strings = await intake({ types: ['text/plain'], items: [{ kind: 'string', type: 'text/plain' }], files: [] });
  assert.deepEqual(codes(strings.problems), ['nothing_dropped']);
});

test('limits: entry count, TrackSegments count and file sizes are capped with clear problems', async () => {
  const endless = await intake(dropOf([d('4.8', [f('a'), f('b'), f('c')], { mode: 'endless', batch: 3 })]), { limits: { maxEntries: 500 } });
  assert.ok(has(endless.problems, 'too_many_files'));
  assert.match(find(endless.problems, 'too_many_files').message, /500/);

  const many = await intake(dropOf([versionDir('4.8', { tracks: 25 })]), { limits: { maxTrackSegments: 10 } });
  assert.equal(many.found.trackSegments.size, 10);
  assert.ok(has(many.problems, 'too_many_track_segments'));

  const big = await intake(dropOf([versionDir('4.8')]), { limits: { maxAllDataBytes: 20 } });
  assert.equal(big.ok, false);
  assert.deepEqual(codes(big.problems), ['all_data_too_large']);
  assert.match(big.problems[0].message, /20 bytes/);

  const bigTree = await intake(dropOf([versionDir('4.8')]), { limits: { maxFolderDataBytes: 10, maxTrackSegmentBytes: 39 } });
  assert.equal(bigTree.ok, true);
  assert.equal(bigTree.found.folderData, null);
  assert.equal(bigTree.found.trackSegments.size, 0);
  assert.deepEqual(codes(bigTree.problems), ['folder_data_too_large', 'track_segment_too_large']);
  assert.equal(find(bigTree.problems, 'track_segment_too_large').count, 3);

  const zipBig = await backup('z.Backup', [['Database/4.8/AllData.gdb', lib(5000)]]);
  const zipResult = await intake(zipBig, { limits: { maxZipEntryBytes: 1000 } });
  assert.deepEqual(codes(zipResult.problems), ['all_data_too_large']);
  assert.match(zipResult.problems[0].message, /Finder/);

  const listed = await intake(dropOf([versionDir('4.8', { tracks: 30 })]), { listing: true, limits: { maxListing: 5 } });
  assert.equal(listed.listing.length, 5);
  assert.ok(listed.listingOmitted > 0);

  const invalid = await intake(dropOf([versionDir('4.8')]), { limits: { maxEntries: -1, maxDepth: Number.NaN, statConcurrency: 0, maxSniff: '3' } });
  assert.equal(invalid.ok, true);
  assert.equal(DEFAULT_INTAKE_LIMITS.maxEntries, 300_000);
});

test('abort: before or during the walk, the result says "cancelled" and finds nothing', async () => {
  const before = new AbortController();
  before.abort();
  const early = await intake(dropOf([versionDir('4.8')]), { signal: before.signal });
  assert.equal(early.ok, false);
  assert.deepEqual(codes(early.problems), ['cancelled']);

  const during = new AbortController();
  setTimeout(() => during.abort(), 10);
  const started = Date.now();
  const late = await intake(dropOf([d('Database', [d('4.8', [], { mode: 'never' })])]), { signal: during.signal });
  assert.ok(Date.now() - started < 5000, 'the abort does not wait for the 30 s timeout');
  assert.deepEqual(codes(late.problems), ['cancelled']);
});

test('hostile inputs never throw', async () => {
  const inputs = [
    undefined,
    null,
    42,
    'AllData.gdb',
    {},
    [],
    [null, 5, {}, 'x'],
    { length: 3 },
    { types: 1, items: { length: 1e12 }, files: null },
    { types: [], get items() { throw new Error('x'); } },
    { captured: true, items: [{ entry: { isDirectory: true, createReader: 5 }, file: null }, { entry: 7, file: null }] },
  ];
  for (const input of inputs) {
    const result = await intake(input);
    assert.equal(result.ok, false);
    assert.ok(Array.isArray(result.problems) && result.problems.length > 0, String(input));
  }
  const badCallback = await intake(dropOf([versionDir('4.8')]), {
    onProgress: () => {
      throw new Error('caller bug');
    },
  });
  assert.equal(badCallback.ok, true);
});

// ---------------------------------------------------------------------------------------------
// Handles and the worker hand-off

test('bytes(start, end) clamps like Blob.slice and rejects impossible ranges and failed reads', async () => {
  const result = await intake([new File([lib(100)], 'AllData.gdb')]);
  const handle = result.found.allData;
  assert.equal((await handle.bytes(90, 500)).length, 10);
  assert.equal((await handle.bytes(500, 600)).length, 0);
  assert.equal((await handle.bytes()).length, 100);
  for (const [s, e] of [[-1, 2], [5, 2], [1.5, 3], [0, Number.NaN]]) {
    await assert.rejects(handle.bytes(s, e), (error) => error instanceof SourceReadError && error.code === 'bad_range');
  }

  const broken = await intake(dropOf([d('4.8', [f('AllData.gdb', lib(), { file: new BrokenFile([lib()], 'AllData.gdb') })])]));
  assert.equal(broken.ok, true, 'intake never reads it');
  await assert.rejects(broken.found.allData.bytes(0, 10), (error) => error instanceof SourceReadError && error.code === 'read_failed');

  const shrinking = await intake([new ShrinkingFile([lib(100)], 'AllData.gdb')]);
  await assert.rejects(shrinking.found.allData.bytes(0, 10), (error) => error instanceof SourceReadError && error.code === 'changed');
});

test('toWorkerSource is structured-cloneable and fromWorkerSource rebuilds working handles', async () => {
  const folder = await intake(dropOf([versionDir('4.8', { tracks: 2 })]));
  const message = structuredClone(toWorkerSource(folder.found));
  assert.equal(message.kind, 'files');
  const revived = await fromWorkerSource(message);
  assert.deepEqual(revived.problems, []);
  assert.equal(revived.found.version, '4.8');
  assert.equal(revived.found.trackSegments.size, 2);
  assert.equal(dec.decode(await revived.found.allData.bytes(0, 4)), 'MsRc');

  const file = await backup('w.Backup', [
    ['B/Database/4.8/AllData.gdb', lib(700)],
    ['B/Database/4.8/FolderData.gfi', gfi()],
    [`B/Database/4.8/TrackSegments/${uuid(4)}`, lib(44)],
  ]);
  const zipped = await intake(file);
  const zipMessage = structuredClone(toWorkerSource(zipped.found));
  assert.equal(zipMessage.kind, 'zip');
  assert.ok(zipMessage.archive instanceof Blob);
  const zipRevived = await fromWorkerSource(zipMessage);
  assert.deepEqual(zipRevived.problems, []);
  assert.equal((await zipRevived.found.allData.bytes()).length, 700);
  assert.equal((await zipRevived.found.trackSegments.get(uuid(4)).bytes()).length, 44);

  zipMessage.allData.entryName = 'something else';
  const changed = await fromWorkerSource(zipMessage);
  assert.ok(has(changed.problems, 'backup_changed'));
  assert.equal(changed.found.allData, null);

  for (const junk of [null, 5, { kind: 'zip', archive: 3 }, { kind: 'files', allData: { name: 'x' } }, { kind: 'other' }]) {
    const out = await fromWorkerSource(junk);
    assert.ok(has(out.problems, 'bad_source'));
    assert.equal(out.found.allData, null);
  }
  const empty = toWorkerSource(null);
  assert.equal(empty.allData, null);
});

test('listing (for the probe) shows every delivered item, skipped ones with a reason, sizes and roles', async () => {
  const result = await intake(dropOf([versionDir('4.8', { tracks: 2, extra: [f('.DS_Store', lib(8)), d('.hidden', [f('x')])] })]), { listing: true });
  const byPath = new Map(result.listing.map((row) => [row.path, row]));
  assert.equal(byPath.get('4.8').kind, 'folder');
  assert.equal(byPath.get('4.8/AllData.gdb').role, 'allData');
  assert.equal(byPath.get('4.8/AllData.gdb').size, 64);
  assert.equal(byPath.get('4.8/FolderData.gfi').role, 'folderData');
  assert.equal(byPath.get(`4.8/TrackSegments/${uuid(1)}`).role, 'trackSegment');
  assert.equal(byPath.get('4.8/.DS_Store').skipped, 'hidden or system item');
  assert.equal(byPath.get('4.8/.hidden').skipped, 'hidden or system item');
  assert.ok(result.listing.every((row) => row.kind === 'folder' || row.skipped !== null || typeof row.size === 'number'));
  assert.equal(typeof result.timings.listMs, 'number');
  assert.equal(result.input.skipped, 2);
});

// ---------------------------------------------------------------------------------------------
// Privacy

test('no problem, note or input fact ever contains a name the user chose', async () => {
  const s = SENT;
  const zip = await backup(`${s}.Backup`, [
    [`${s}/Database/4.8 ${s}/AllData.gdb`, new Uint8Array(0)],
    [`${s}/Database/4.8/AllData.gdb`, lib()],
    [`${s}/Database/4.8/TrackSegments/${s}`, lib(40)],
    [`${s}/${s}.gpx`, lib(10)],
  ]);
  const zip2 = await backup(`${s}2.zip`, [[`${s}/a`, lib()]]);
  // Each scenario is built when it is used: a fake drop, like a real one, is emptied a microtask after it is
  // made, so drops built before an await would all arrive empty ("nothing_dropped") and test nothing.
  const scenarios = [
    () => dropOf([d(s, [d('Database', [versionDir(`4.8 ${s}`), versionDir(`4.8-${s}`, { allData: new Uint8Array(0) }), versionDir('4.7')])])]),
    () => dropOf([d(`${s}.bclibrary`, [d(s, [f('AllData.gdb', new Uint8Array(0))])])]),
    () => dropOf([f(`${s}.bclibrary`, new Uint8Array(0), { file: new BrokenFile([], `${s}.bclibrary`) })]),
    () => dropOf([d(s, [d(s, [], { mode: 'error' }), f(`${s}.gdb`, lib()), f(`${s}.gpx`, lib()), f('.' + s)])]),
    () => [relFile(`${s}/../${s}`, lib()), relFile(`${s}/FolderData.gfi`, gfi()), relFile(`AppData/${s}/4.7/AllData.gdb`, lib())],
    () => [new File([lib()], `${s}.gdb`), new File([lib()], `${s}.gpx`), new File([], `${s}.Backup`)],
    () => zip,
    () => [zip, zip2],
    // Added by the adversarial pass: the problems it introduced must not leak either.
    () => dropOf([d(s, [versionDir('4.7')]), d(s, [versionDir('4.8')])]),
    () => [new File([lib()], 'AllData.gdb'), new File([lib()], 'AllData.gdb'), new File([gfi()], 'FolderData.gfi'), new File([lib(40)], s)],
    () => dropOf([d('4.8', [f('AllData.gdb', lib()), d(s, [f(s), f(`${s}2`)], { mode: 'error-later', batch: 1 })])]),
    () => dropOf([d(s, [d('Cache', [d('12.25', [f('AllData.gdb', lib())])]), d('Database', [versionDir('4.8')])])]),
  ];
  for (const make of scenarios) {
    const result = await intake(make(), { listing: true, limits: { callbackTimeoutMs: 20, maxDepth: 2 } });
    assert.ok(!has(result.problems, 'nothing_dropped'), 'the scenario arrived empty');
    for (const p of [...result.problems, ...result.notes]) {
      assert.ok(!p.message.includes(s), `${p.code} leaks a name: ${p.message}`);
      assert.ok(!p.code.includes(s));
    }
    assert.ok(!JSON.stringify(result.input).includes(s), 'input facts leak a name');
    assert.ok(result.problems.length + result.notes.length > 0);
  }
});

// ---------------------------------------------------------------------------------------------
// The drop probe's summary (it runs in Node without a DOM; only the page part needs one)

test('probe: extension classes never carry the name', () => {
  assert.equal(extensionClass('Trips.bclibrary'), '.bclibrary');
  assert.equal(extensionClass('BaseCamp_1.Backup'), '.backup');
  assert.equal(extensionClass(`${SENT}.ZIP`), '.zip');
  assert.equal(extensionClass(`${SENT}.jpeg`), '(other)');
  assert.equal(extensionClass('4.8'), '(other)');
  assert.equal(extensionClass('.hidden'), '(none)');
  assert.equal(extensionClass('trailing.'), '(none)');
  assert.equal(extensionClass(null), '(none)');
  const features = detectFeatures();
  assert.deepEqual(features.map((f) => f.key), ['webkitGetAsEntry', 'webkitdirectory', 'inflateRaw', 'deflateRaw', 'blobStream']);
  assert.equal(features.find((f) => f.key === 'webkitdirectory').value, null, 'untested without a DOM');
});

test('probe: the structure-only summary holds no name, path or browser-supplied free text', async () => {
  const s = SENT;
  const pkgZip = await backup('p', [[`${s}/Database/4.8/AllData.gdb`, lib()], [`${s}/Database/4.8/TrackSegments/${s}`, lib(40)]]);
  // Built when used (a fake drop is emptied a microtask after it is made).
  const drops = [
    () => dropOf([d(`${s}.bclibrary`, [d('Database', [versionDir('4.8'), versionDir(`4.9 ${s}`)])]), f(`${s}.gdb`, lib())]),
    () => dropOf([f(`${s}.bclibrary`, new Uint8Array(0), { file: new File([pkgZip], `${s}.bclibrary`, { type: `application/${s}` }) })]),
    () => ({ types: ['Files', `text/${s}`], items: [{ kind: s, type: s }], files: [new File([lib()], `${s}.Backup`, { type: s })] }),
  ];
  for (const make of drops) {
    const capture = captureDrop(make());
    assert.ok(capture.items.length > 0, 'the drop arrived empty');
    const result = await intake(capture, { listing: true });
    const text = buildSummary({ how: 'drop', features: detectFeatures(), userAgent: 'TestBrowser/1.0', capture, result, totalMs: 12.4 });
    assert.ok(!text.includes(s), text);
    assert.match(text, /Given by: drop/);
    assert.match(text, /Problems: /);
  }
  const files = [relFile(`${s}/Database/4.8/AllData.gdb`, lib()), relFile(`${s}/Database/4.8/FolderData.gfi`, gfi())];
  const result = await intake(files, { listing: true });
  const text = buildSummary({
    how: 'folder picker',
    features: detectFeatures(),
    userAgent: 'TestBrowser/1.0',
    fileList: { count: 2, withRelativePath: 2 },
    result,
    totalMs: 3,
  });
  assert.ok(!text.includes(s), text);
  assert.match(text, /version folder=4\.8/);
  assert.match(text, /File list: files=2, with webkitRelativePath=2/);
  assert.match(text, /Problems: no_track_segments×1/);
});

test('sniff: false reads no byte of loose files; a backup is still opened by its name, exports explained by name', async () => {
  reads = 0;
  const zip = await zipBytes([{ path: 'Database/4.8/AllData.gdb', bytes: lib(300) }]);
  const opened = await intake(new File([zip], 'b.Backup'), { sniff: false });
  assert.equal(opened.ok, true, JSON.stringify(opened.problems));
  assert.equal(opened.input.kind, 'zip');

  const gdb = await intake(new SpyFile([lib()], 'export.gdb'), { sniff: false });
  assert.deepEqual(codes(gdb.problems), ['exported_gdb']);
  const renamed = await intake(new SpyFile([lib()], 'export'), { sniff: false });
  assert.deepEqual(codes(renamed.problems), ['no_library'], 'without sniffing, an unnamed export is not recognised');
  assert.equal(reads, 0);
});

test('only maxCandidates library folders are compared, and the cap is noted', async () => {
  const db = d('Database', [versionDir('4.6'), versionDir('4.7'), versionDir('4.8')]);
  const result = await intake(dropOf([db]), { limits: { maxCandidates: 2 } });
  assert.equal(result.ok, true);
  assert.equal(result.found.version, '4.7');
  assert.ok(has(result.notes, 'too_many_libraries'));
  assert.equal(result.input.libraryFolders, 3);
});

// ---------------------------------------------------------------------------------------------
// Adversarial pass (independent tester): loops, huge folders, odd names, crafted backups, quirks

/** Two folders that each hold both of them: what a symlink loop looks like through the entry API. */
function loop() {
  const x = d('x', []);
  const y = d('y', []);
  x.children.push(x, y);
  y.children.push(x, y);
  return x;
}

/** The central-directory records of a ZIP, for crafting hostile headers in place. */
function centrals(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  for (let i = 0; i + 46 <= bytes.length; i++) {
    if (view.getUint32(i, true) === 0x02014b50) out.push({ at: i, view });
  }
  return out;
}

/** Replaces every occurrence of `from` with `to` (same byte length), as the Windows test does. */
function patchText(bytes, from, to) {
  const a = enc.encode(from);
  const b = enc.encode(to);
  assert.equal(a.length, b.length);
  for (let i = 0; i + a.length <= bytes.length; i++) if (a.every((x, k) => bytes[i + k] === x)) bytes.set(b, i);
  return bytes;
}

let sliced = 0;
/** Counts the bytes every slice() would hand out. */
class CountingFile extends File {
  slice(...args) {
    const blob = super.slice(...args);
    sliced += blob.size;
    return blob;
  }
}

test('walk order: a looping or huge sibling cannot use up the entry budget before the library is listed', async () => {
  const limits = { maxEntries: 2000 };
  for (const [label, items] of [
    ['library first', () => [versionDir('4.8'), loop()]],
    ['loop first', () => [loop(), versionDir('4.8')]],
  ]) {
    const result = await intake(dropOf(items()), { limits });
    assert.equal(result.ok, true, `${label}: ${JSON.stringify(result.problems)}`);
    assert.equal(result.found.version, '4.8', label);
    assert.equal(result.found.trackSegments.size, 3, label);
    assert.ok(has(result.problems, 'too_many_files'), label);
  }
  // The same inside one dropped folder: a big cache folder listed before the Garmin folder.
  const cache = d('Cache', Array.from({ length: 30 }, (_, i) => d(`c${i}`, Array.from({ length: 100 }, (_, k) => f(`f${k}`)))));
  const appSupport = d('Application Support', [cache, d('Garmin', [d('BaseCamp', [d('Database', [versionDir('4.8')])])])]);
  const nested = await intake(dropOf([appSupport]), { limits });
  assert.equal(nested.ok, true, JSON.stringify(nested.problems));
  assert.equal(nested.found.versionFolder, 'Application Support/Garmin/BaseCamp/Database/4.8');
});

test('walk order: equal libraries are decided by delivery order, the same for a drop and a file list', async () => {
  const drop = await intake(dropOf([d('A', [versionDir('4.8')]), d('B', [versionDir('4.8')])]));
  assert.equal(drop.found.versionFolder, 'A/4.8');
  const list = await intake([relFile('A/4.8/AllData.gdb', lib()), relFile('B/4.8/AllData.gdb', lib())]);
  assert.equal(list.found.versionFolder, 'A/4.8');
});

test('a folder that holds itself (a symlink loop) stops at maxDepth and never hangs', async () => {
  const self = d('a', []);
  self.children.push(self, f('notes.txt', lib(10)));
  const started = Date.now();
  const result = await intake(dropOf([self]));
  assert.ok(Date.now() - started < 5000);
  assert.equal(result.ok, false);
  assert.ok(has(result.problems, 'too_deep'));
  assert.ok(has(result.problems, 'no_library'));
  // The default budget also ends a branching loop, in plain words.
  const big = await intake(dropOf([loop()]), { limits: { maxEntries: 3000 } });
  assert.match(find(big.problems, 'too_many_files').message, /more than 3,000 files and folders/);
});

test('a library where BaseCamp puts one (Database/<version>, or given itself) beats a version-like folder elsewhere', async () => {
  const appSupport = d('Application Support', [
    d('Garmin', [d('BaseCamp', [d('Database', [versionDir('4.8')])])]),
    d('OtherApp', [d('Cache', [d('12.25', [f('AllData.gdb', lib(5000), { mtime: 9000 })])])]),
  ]);
  const result = await intake(dropOf([appSupport]));
  assert.equal(result.found.versionFolder, 'Application Support/Garmin/BaseCamp/Database/4.8');
  assert.equal(result.found.version, '4.8');
  for (const p of [...result.problems, ...result.notes]) assert.ok(!p.message.includes('12.25'), p.message);

  // A copy a user named after a date, complete and newer, does not beat the library in BaseCamp's place.
  const dated = await intake([
    relFile('Backups/10.5/AllData.gdb', lib()),
    relFile('Backups/10.5/FolderData.gfi', gfi()),
    relFile('Garmin/BaseCamp/database/4.7/AllData.gdb', lib()),
  ]);
  assert.equal(dated.found.versionFolder, 'Garmin/BaseCamp/database/4.7');
  for (const p of [...dated.problems, ...dated.notes]) assert.ok(!p.message.includes('10.5'), p.message);

  // An unusable library in its place still falls back to a usable copy elsewhere (usable comes first), and a
  // copy elsewhere is not called "the newer version".
  const fallback = await intake(dropOf([d('Database', [versionDir('4.8', { allData: new Uint8Array(0) })]), d('Copies', [versionDir('9.9')])]));
  assert.equal(fallback.found.versionFolder, 'Copies/9.9');
  assert.ok(!has(fallback.problems, 'newer_version_unusable'));
  const older = await intake(dropOf([d('Database', [versionDir('4.8', { allData: new Uint8Array(0) })]), d('Copies', [versionDir('4.7')])]));
  assert.equal(older.found.versionFolder, 'Copies/4.7');
  assert.match(find(older.problems, 'newer_version_unusable').message, /newer version folder 4\.8/);

  // Still versions: a version folder dropped or picked itself, and Database in any spelling.
  assert.equal((await intake(dropOf([versionDir('4.8')]))).found.version, '4.8');
  assert.equal((await intake([relFile('4.7/AllData.gdb', lib())])).found.version, '4.7');
  assert.equal((await intake([relFile('Lib/database/4.7/AllData.gdb', lib())])).found.version, '4.7');
});

test('sniff: backup-named files are looked at first, so a backup among many loose files is still opened', async () => {
  const zip = await zipBytes([{ path: 'Database/4.8/AllData.gdb', bytes: lib(300) }]);
  const files = Array.from({ length: 20 }, (_, i) => new File(['hello'], `note${i}.txt`));
  files.push(new File([zip], 'x.Backup'));
  const result = await intake(files);
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.input.kind, 'zip');
});

test('readEntries that fails or goes quiet partway: the part listed is used, and the problem says the listing stopped', async () => {
  const tracks = Array.from({ length: 250 }, (_, i) => f(uuid(i + 1), lib(40)));
  for (const mode of ['error-later', 'silent-later']) {
    const v = d('4.8', [f('AllData.gdb', lib()), f('FolderData.gfi', gfi()), d('TrackSegments', tracks, { mode })]);
    const result = await intake(dropOf([v]), { limits: { callbackTimeoutMs: 20 } });
    assert.equal(result.ok, true, mode);
    assert.equal(result.found.trackSegments.size, 100, mode);
    assert.deepEqual(codes(result.problems), ['folder_incomplete'], mode);
    assert.match(find(result.problems, 'folder_incomplete').message, /partway/);
  }
});

test('library files given twice in one place (a flattened list, two same-named folders) are flagged, not silently resolved', async () => {
  // A Database folder picked in a browser that passes no webkitRelativePath: both versions arrive flat.
  const flat = [];
  for (const [fill, mtime] of [[7, 1000], [8, 9000]]) {
    flat.push(new File([lib(64, fill)], 'AllData.gdb', { lastModified: mtime }), new File([gfi()], 'FolderData.gfi'));
    for (let i = 0; i < 3; i++) flat.push(new File([lib(40)], uuid(i + fill * 10)));
  }
  const result = await intake(flat);
  assert.equal(result.ok, true);
  assert.equal(result.input.delivery, 'files');
  const twice = find(result.problems, 'library_file_twice');
  assert.ok(twice, JSON.stringify(result.problems));
  assert.equal(twice.count, 2);
  assert.match(twice.message, /version folder/);

  const twoDb = await intake(dropOf([d('Database', [versionDir('4.7')]), d('Database', [versionDir('4.8')])]));
  assert.equal(twoDb.found.version, '4.7');
  assert.ok(has(twoDb.problems, 'folder_twice'), JSON.stringify(twoDb.problems));
  assert.match(find(twoDb.problems, 'folder_twice').message, /on its own/);
});

test('a code is never in both problems and notes (an encrypted library file in a backup)', async () => {
  const bytes = await zipBytes(
    [
      { path: 'B/Database/4.8/AllData.gdb', bytes: lib(3000) },
      { path: 'B/Database/4.8/FolderData.gfi', bytes: gfi() },
    ],
    { compression: 'store' },
  );
  for (const c of centrals(bytes)) c.view.setUint16(c.at + 8, c.view.getUint16(c.at + 8, true) | 1, true);
  const result = await intake(new File([bytes], 'e.Backup'));
  assert.equal(result.ok, false);
  assert.ok(has(result.problems, 'backup_encrypted'));
  const problemCodes = new Set(result.problems.map((p) => p.code));
  assert.ok(result.notes.every((n) => !problemCodes.has(n.code)), JSON.stringify(result.notes));
});

test('options whose getters throw never make intake throw', async () => {
  const hostile = {
    get limits() {
      throw new Error('x');
    },
    get signal() {
      throw new Error('y');
    },
  };
  const result = await intake(dropOf([versionDir('4.8')]), hostile);
  assert.equal(result.ok, true);
});

test('100,000 TrackSegments files: every readEntries batch is read and every file is used', async () => {
  const v = versionDir('4.8', { tracks: 100_000 });
  const result = await intake(dropOf([v]));
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
  assert.equal(result.found.trackSegments.size, 100_000);
  assert.equal(v.children.find((c) => c.name === 'TrackSegments').readCalls, 1001);

  const files = [relFile('BaseCamp/Database/4.8/AllData.gdb', lib()), relFile('BaseCamp/Database/4.8/FolderData.gfi', gfi())];
  for (let i = 0; i < 100_000; i++) files.push(relFile(`BaseCamp/Database/4.8/TrackSegments/${uuid(i)}`, lib(40)));
  const list = await intake(files);
  assert.equal(list.found.trackSegments.size, 100_000);

  const capped = await intake(dropOf([versionDir('4.8', { tracks: 5000 })]), { limits: { maxTrackSegments: 4000 } });
  assert.equal(capped.found.trackSegments.size, 4000);
  assert.match(find(capped.problems, 'too_many_track_segments').message, /more than 4,000 files; only the first 4,000/);
});

test('names with control characters, RTL overrides and non-ASCII digits are never versions and never in a message', async () => {
  const s = SENT;
  const odd = ['4.8‮', '٤.٨', '４.８', '4.8\n', '4.8‏', `‮${s}`, `${s}\r\n\t\u0007`];
  const drop = dropOf([d('Database', odd.map((name) => d(name, [f('AllData.gdb', lib()), f(`${s}‮gdb.ataDllA`, lib())])))]);
  const result = await intake(drop, { listing: true });
  assert.equal(result.ok, true);
  assert.equal(result.found.version, null);
  for (const p of [...result.problems, ...result.notes]) {
    assert.ok(!p.message.includes(s), p.message);
    assert.ok(!/[‮‏\u0007٤４]/.test(p.message), p.message);
  }
  assert.ok(!JSON.stringify(result.input).includes(s));
  assert.ok(result.listing.some((row) => row.path.includes('‮')), 'the on-page listing keeps names as given');

  // The same names inside a backup (the ZIP writer refuses bidi controls, so they are patched in).
  const bytes = await zipBytes(
    [
      { path: `${s}XXX/Database/4.8XXX/AllData.gdb`, bytes: lib() },
      { path: `${s}/Database/4.8/AllData.gdb`, bytes: lib() },
      { path: `${s}/Database/4.8/TrackSegments/${s}Y`, bytes: lib(40) },
      { path: `${s}/Database/9.9/${s}ZZ`, bytes: lib(40) },
    ],
    { compression: 'store' },
  );
  patchText(patchText(patchText(bytes, 'XXX', '‮'), 'Y', '\u0007'), 'ZZ', '\r\n');
  const zipped = await intake(new File([bytes], `${s}.Backup`));
  assert.equal(zipped.found.version, '4.8');
  assert.equal(zipped.found.trackSegments.size, 1);
  for (const p of [...zipped.problems, ...zipped.notes]) assert.ok(!p.message.includes(s), p.message);
});

test('bomb-like backups are refused in plain words, and intake reads only the table of contents', async () => {
  const s = SENT;
  const store = { compression: 'store' };
  const plain = (result) => {
    for (const p of [...result.problems, ...result.notes]) {
      assert.ok(!p.message.includes(s), p.message);
      assert.ok(!/\d{4,}/.test(p.message.replace(/\d{1,3}(,\d{3})+/g, '')), `raw number in: ${p.message}`);
    }
  };

  // Every entry points at the same data (how many bombs reuse one block).
  const overlap = await zipBytes(
    [
      { path: `${s}/Database/4.8/AllData.gdb`, bytes: lib(3_000_000) },
      { path: `${s}/Database/4.8/FolderData.gfi`, bytes: gfi() },
      { path: `${s}/Database/4.8/TrackSegments/${uuid(1)}`, bytes: lib(40) },
    ],
    store,
  );
  const records = centrals(overlap);
  const first = records[0].view.getUint32(records[0].at + 42, true);
  for (const c of records) c.view.setUint32(c.at + 42, first, true);
  sliced = 0;
  const overlapped = await intake(new CountingFile([overlap], `${s}.Backup`));
  assert.deepEqual(codes(overlapped.problems), ['all_data_damaged']);
  assert.ok(sliced < 200_000, `intake read ${sliced} bytes of a ${overlap.length}-byte backup`);
  plain(overlapped);

  // Declared sizes the compressed data cannot hold: past the size limit, and past what deflate can expand to.
  for (const [declared, code] of [
    [0xfffffff0, 'all_data_too_large'],
    [500_000_000, 'all_data_damaged'],
  ]) {
    const bytes = await zipBytes([{ path: `${s}/Database/4.8/AllData.gdb`, bytes: new Uint8Array(100_000) }]);
    const [rec] = centrals(bytes);
    assert.equal(rec.view.getUint16(rec.at + 10, true), 8, 'deflated');
    rec.view.setUint32(rec.at + 24, declared, true);
    const result = await intake(new File([bytes], 'b.Backup'));
    assert.deepEqual(codes(result.problems), [code]);
    plain(result);
  }

  // Within deflate's ratio the declared size is believed (intake reads no data); bytes() then fails safely.
  const honestLooking = await zipBytes([{ path: 'B/Database/4.8/AllData.gdb', bytes: new Uint8Array(400_000) }]);
  const [rec] = centrals(honestLooking);
  rec.view.setUint32(rec.at + 24, 404_000, true);
  const believed = await intake(new File([honestLooking], 'c.Backup'));
  assert.equal(believed.ok, true);
  await assert.rejects(believed.found.allData.bytes(0, 4), (e) => e instanceof SourceReadError && e.code === 'damaged');

  // More entries than the limit, a library file that is a symbolic link, and an entry that climbs out ("..").
  const many = await zipBytes(Array.from({ length: 100 }, (_, i) => ({ path: `${s}/x${i}`, bytes: lib(20) })), store);
  const tooMany = await intake(new File([many], 'm.Backup'), { limits: { maxEntries: 50 } });
  assert.deepEqual(codes(tooMany.problems), ['backup_too_many_entries']);
  plain(tooMany);

  const link = await zipBytes([{ path: `${s}/Database/4.8/AllData.gdb`, bytes: lib(3000) }], store);
  const [linkRec] = centrals(link);
  linkRec.view.setUint32(linkRec.at + 38, (0o120777 << 16) >>> 0, true);
  const linked = await intake(new File([link], 'l.Backup'));
  assert.deepEqual(codes(linked.problems), ['backup_no_library']);
  assert.ok(has(linked.notes, 'link_skipped'));
  plain(linked);

  const climb = patchText(await zipBytes([{ path: `xx/${s}/AllData.gdb`, bytes: lib() }], store), 'xx/', '../');
  const climbed = await intake(new File([climb], 'u.Backup'));
  assert.equal(climbed.ok, false);
  assert.ok(has(climbed.problems, 'bad_name'));
  plain(climbed);
});

test('a 0-byte AllData.gdb is reported the same way however it arrives, and nothing next to it is used', async () => {
  const empty = new Uint8Array(0);
  const zip = await backup('z.Backup', [['B/Database/4.8/AllData.gdb', empty], ['B/Database/4.8/FolderData.gfi', gfi()]]);
  // Built when used: a drop is emptied a microtask after it is made.
  const inputs = [
    () => dropOf([d('4.8', [f('AllData.gdb', empty), f('FolderData.gfi', gfi()), d('TrackSegments', [f(uuid(1), lib(40))])])]),
    () => [relFile('4.8/AllData.gdb', empty), relFile('4.8/FolderData.gfi', gfi())],
    () => [new File([], 'AllData.gdb'), new File([gfi()], 'FolderData.gfi')],
    () => zip,
  ];
  for (const make of inputs) {
    const result = await intake(make());
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result.problems), ['all_data_empty']);
    assert.equal(result.found.folderData, null);
    assert.equal(result.found.trackSegments.size, 0);
  }
});

test('Safari-style file lists: no webkitRelativePath, some without it, or a getter that throws', async () => {
  const flat = await intake([new File([lib()], 'AllData.gdb'), new File([gfi()], 'FolderData.gfi'), new File([lib(40)], uuid(1))]);
  assert.equal(flat.ok, true);
  assert.equal(flat.input.delivery, 'files');
  assert.equal(flat.input.kind, 'files');
  assert.deepEqual(codes(flat.problems), ['no_track_segments']);

  const mixed = await intake([relFile('4.8/AllData.gdb', lib()), relFile('4.8/FolderData.gfi', gfi()), new File([lib(40)], uuid(2))]);
  assert.equal(mixed.found.version, '4.8');
  assert.equal(mixed.input.delivery, 'file-list');

  const throwing = new File([lib()], 'AllData.gdb');
  Object.defineProperty(throwing, 'webkitRelativePath', {
    get() {
      throw new Error('x');
    },
  });
  assert.equal((await intake([throwing])).ok, true);
});
