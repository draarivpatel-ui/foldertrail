// Turns the Library's folder/list tree into a plan of ZIP paths, and builds the repaired tree that
// the KML writer also uses.
//
// Layout of the plan:
//   <Folder>/                 one directory per BaseCamp folder, nested as in BaseCamp
//   <Folder>/<List>.gpx       one GPX per list, holding that list's items
//   <Folder>/<Folder>.gpx     only when a folder itself mentions items (BaseCamp folders normally
//                             hold only lists and folders, but the model allows it); those items
//                             stay with their folder instead of being called "Unfiled"
//   Unfiled.gpx               items that no list or folder mentions (only when there are any)
//   All items.gpx             every item in the library, in library order
//
// BaseCamp lets one item sit in several lists. Such an item is written into every one of those
// lists' files, exactly as BaseCamp shows it in each list; that is intended, not a duplicate bug.
//
// The tree is hostile input: parents may be missing, point at themselves, form loops, be lists
// instead of folders, or nest thousands of levels deep. Every repair is counted, every walk is
// iterative, and nesting is capped (deep XML trips parser limits, and deep paths grow quadratically).

import { Tally, textOf } from './xml.js';

/** @typedef {import('../model.js').Item} Item */
/** @typedef {import('../model.js').Folder} Folder */
/** @typedef {import('../model.js').Library} Library */
/** @typedef {import('../model.js').Problem} Problem */

/** Folders nested deeper than this are moved up to this level (counted as folder_depth_flattened).
 * Lists stay inside their folder, one level further down. */
export const MAX_FOLDER_DEPTH = 32;

/** Cap for one path component (file or directory name), in UTF-8 bytes, extension included. */
export const MAX_NAME_BYTES = 120;

// Above this many characters some Windows tools cannot extract a file without long-path support.
// A judgment call: MAX_PATH is 260 including the folder the user extracts into.
const LONG_PATH_CHARS = 200;

export const PATH_MESSAGES = Object.freeze({
  folder_malformed: 'Some folder or list entries were unreadable and were skipped.',
  folder_duplicate_id:
    'Some folders or lists shared an id with another; all were kept, and sub-folders were placed under the first.',
  folder_parent_missing:
    'Some folders or lists belonged to a folder that is not in the library; they were placed at the top level.',
  folder_cycle: 'Some folders were nested inside themselves (a loop); the loop was broken at the top level.',
  list_inside_list: 'Some folders or lists sat inside a list, which BaseCamp does not allow; they were placed beside that list.',
  folder_depth_flattened: `Folders nested more than ${MAX_FOLDER_DEPTH} levels deep were moved up to level ${MAX_FOLDER_DEPTH}.`,
  item_unidentified: 'Some library items had no usable id and could only be placed in Unfiled and All items.',
  item_duplicate_id: 'Some items shared an id; lists use the first such item, and the others are in Unfiled.',
  item_missing: 'Some lists mentioned items that are not in the library; those entries were skipped.',
  item_repeated_in_list: 'Some lists mentioned the same item more than once; it was written once per list.',
  path_long: `Some file paths are longer than ${LONG_PATH_CHARS} characters; on Windows they may need long-path support to unzip.`,
  name_shortened:
    'Some folder or list names were too long to use in full as a file or folder name and were shortened.',
});

/**
 * A folder or list after repair, or the root (folder === null).
 * @typedef {object} TreeNode
 * @property {Folder|null} folder   the source entry, null for the root
 * @property {string} name          the entry's name as text ("" for the root and for empty names)
 * @property {boolean} isList
 * @property {TreeNode|null} parent effective parent after repair (null only for the root)
 * @property {TreeNode[]} children  folders and lists inside this folder, in library order
 * @property {number} depth         root 0, top-level folders 1
 * @property {Item[]} items         items this list/folder mentions, in its order, each once
 */

/**
 * @typedef {object} FolderTree
 * @property {TreeNode} root
 * @property {TreeNode[]} nodes   every folder and list, parents before children (breadth-first)
 * @property {Item[]} unfiled     items no folder or list mentions, in library order
 * @property {Problem[]} problems
 */

/**
 * @param {Folder|null} folder
 * @returns {TreeNode}
 */
function makeNode(folder) {
  return {
    folder,
    name: folder ? textOf(folder.name) : '',
    isList: folder ? folder.type === 'list' : false,
    parent: null,
    children: [],
    depth: 0,
    items: [],
  };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return value !== null && typeof value === 'object';
}

/**
 * Repair the folder/list tree and resolve each entry's items.
 * @param {Library} library
 * @param {{ maxDepth?: number }} [options]
 * @returns {FolderTree}
 */
export function buildFolderTree(library, options = {}) {
  const maxDepth = options.maxDepth ?? MAX_FOLDER_DEPTH;
  if (!Number.isInteger(maxDepth) || maxDepth < 1) throw new RangeError('maxDepth must be an integer >= 1');
  const tally = new Tally(PATH_MESSAGES);
  const root = makeNode(null);

  const folders = Array.isArray(library?.folders) ? library.folders : [];
  /** @type {TreeNode[]} */
  const nodes = [];
  /** @type {Map<string, TreeNode>} */
  const byId = new Map();
  for (const folder of folders) {
    if (!isObject(folder)) {
      tally.add('folder_malformed');
      continue;
    }
    const node = makeNode(folder);
    nodes.push(node);
    if (typeof folder.id !== 'string') continue;
    if (byId.has(folder.id)) tally.add('folder_duplicate_id');
    else byId.set(folder.id, node);
  }

  /** @type {Map<TreeNode, TreeNode|null>} declared parent, before repair */
  const declared = new Map();
  for (const node of nodes) {
    const parentId = /** @type {Folder} */ (node.folder).parentId;
    if (parentId === null || parentId === undefined) {
      declared.set(node, null);
    } else {
      const parent = typeof parentId === 'string' ? byId.get(parentId) : undefined;
      if (!parent) tally.add('folder_parent_missing');
      declared.set(node, parent ?? null);
    }
  }

  breakCycles(nodes, declared, tally);
  const container = resolveContainers(nodes, declared, tally);
  const ordered = placeWithDepthCap(root, nodes, container, maxDepth, tally);
  const unfiled = resolveItems(library, nodes, tally);
  return { root, nodes: ordered, unfiled, problems: tally.toProblems() };
}

/**
 * Cut parent links that close a loop. Walks start in library order, so the result is
 * deterministic: for A -> B -> A starting at A, the link from B back to A is cut and B becomes
 * top level, with A inside it. A self-parent is a loop of one.
 * @param {TreeNode[]} nodes
 * @param {Map<TreeNode, TreeNode|null>} declared  modified in place
 * @param {Tally} tally
 */
function breakCycles(nodes, declared, tally) {
  const ON_WALK = 1;
  const DONE = 2;
  /** @type {Map<TreeNode, number>} */
  const state = new Map();
  for (const start of nodes) {
    if (state.has(start)) continue;
    /** @type {TreeNode[]} */
    const walk = [];
    /** @type {TreeNode|null|undefined} */
    let n = start;
    while (n && !state.has(n)) {
      state.set(n, ON_WALK);
      walk.push(n);
      n = declared.get(n);
    }
    if (n && state.get(n) === ON_WALK) {
      declared.set(walk[walk.length - 1], null);
      tally.add('folder_cycle');
    }
    for (const w of walk) state.set(w, DONE);
  }
}

/**
 * The folder each entry really lives in. BaseCamp lists cannot hold lists or folders; anything
 * whose declared parent is a list moves up to that list's own folder, so it sits beside the list.
 * Memoized, so a long chain of lists costs linear time. Requires an acyclic `declared`.
 * @param {TreeNode[]} nodes
 * @param {Map<TreeNode, TreeNode|null>} declared
 * @param {Tally} tally
 * @returns {Map<TreeNode, TreeNode|null>}  null means top level
 */
function resolveContainers(nodes, declared, tally) {
  /** @type {Map<TreeNode, TreeNode|null>} */
  const memo = new Map();
  /**
   * @param {TreeNode|null} start
   * @returns {TreeNode|null}
   */
  const folderAtOrAbove = (start) => {
    /** @type {TreeNode[]} */
    const lists = [];
    let n = start;
    while (n && n.isList && !memo.has(n)) {
      lists.push(n);
      n = declared.get(n) ?? null;
    }
    const found = n && n.isList ? /** @type {TreeNode|null} */ (memo.get(n)) : n;
    for (const list of lists) memo.set(list, found);
    return found;
  };

  /** @type {Map<TreeNode, TreeNode|null>} */
  const container = new Map();
  for (const node of nodes) {
    const parent = declared.get(node) ?? null;
    if (parent && parent.isList) {
      tally.add('list_inside_list');
      container.set(node, folderAtOrAbove(parent));
    } else {
      container.set(node, parent);
    }
  }
  return container;
}

/**
 * Attach every node under its container, breadth-first from the root. A folder that would sit
 * deeper than maxDepth moves up to level maxDepth (as a sibling there); a list always stays in
 * its folder, so lists can be at level maxDepth + 1.
 * @param {TreeNode} root
 * @param {TreeNode[]} nodes
 * @param {Map<TreeNode, TreeNode|null>} container
 * @param {number} maxDepth
 * @param {Tally} tally
 * @returns {TreeNode[]}  every node, parents before children
 */
function placeWithDepthCap(root, nodes, container, maxDepth, tally) {
  /** @type {Map<TreeNode, TreeNode[]>} */
  const declaredChildren = new Map([[root, []]]);
  for (const node of nodes) declaredChildren.set(node, []);
  for (const node of nodes) {
    /** @type {TreeNode[]} */ (declaredChildren.get(container.get(node) ?? root)).push(node);
  }
  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    const parent = queue[i];
    for (const child of /** @type {TreeNode[]} */ (declaredChildren.get(parent))) {
      let host = parent;
      if (!child.isList && host.depth >= maxDepth) {
        host = /** @type {TreeNode} */ (host.parent);
        tally.add('folder_depth_flattened');
      }
      child.parent = host;
      child.depth = host.depth + 1;
      host.children.push(child);
      queue.push(child);
    }
  }
  return queue.slice(1);
}

/**
 * Fill each node's items from its itemIds and return the items nobody mentions.
 * @param {Library} library
 * @param {TreeNode[]} nodes
 * @param {Tally} tally
 * @returns {Item[]}
 */
function resolveItems(library, nodes, tally) {
  const items = Array.isArray(library?.items) ? library.items : [];
  /** @type {Map<string, Item>} */
  const byId = new Map();
  for (const item of items) {
    if (!isObject(item) || typeof item.id !== 'string') {
      tally.add('item_unidentified');
      continue;
    }
    if (byId.has(item.id)) tally.add('item_duplicate_id');
    else byId.set(item.id, item);
  }

  /** @type {Set<Item>} */
  const mentioned = new Set();
  for (const node of nodes) {
    const ids = /** @type {Folder} */ (node.folder).itemIds;
    if (!Array.isArray(ids)) continue;
    /** @type {Set<Item>} */
    const seen = new Set();
    for (const id of ids) {
      const item = typeof id === 'string' ? byId.get(id) : undefined;
      if (!item) {
        tally.add('item_missing');
      } else if (seen.has(item)) {
        tally.add('item_repeated_in_list');
      } else {
        seen.add(item);
        node.items.push(item);
        mentioned.add(item);
      }
    }
  }
  return items.filter((item) => !mentioned.has(/** @type {Item} */ (item)));
}

// ---------------------------------------------------------------------------------------------
// Safe file and directory names

// Windows device names, reserved with or without an extension ("NUL.tar.gz" is NUL) and in any
// case. Microsoft's "Naming Files, Paths, and Namespaces" (checked 2026-10-05) lists CON, PRN, AUX,
// NUL, COM1-COM9, LPT1-LPT9 and COM/LPT with superscript 1, 2, 3. COM0, LPT0, CONIN$ and CONOUT$
// are not in that list and are added only to be safe: reserving an extra name costs a "_".
// The same page says not to end a name with a space or a period.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00B9\u00B2\u00B3]|lpt[0-9\u00B9\u00B2\u00B3])$/i;

// Characters Windows forbids in names (macOS and Linux forbid "/"; macOS Finder shows ":" as "/").
const FORBIDDEN_CHARS = /[/\\:*?"<>|]/g;
const WHITESPACE_CONTROLS = /[\t\n\v\f\r\x85\u2028\u2029]/g;
// Other C0/C1 controls, DEL, and the bidi embedding/override/isolate controls, which can make a
// name display in a misleading order. Lone surrogates cannot be encoded in UTF-8 at all.
const DROPPED_CHARS = /[\0-\x1F\x7F-\x9F\u202A-\u202E\u2066-\u2069]/g;
const LONE_SURROGATE = /[\uD800-\uDFFF]/gu;
// Unassigned code points, including the noncharacters U+FDD0..U+FDEF and U+xFFFE/U+xFFFF. APFS
// refuses to create such a name ("Illegal byte sequence"), so the file would fail to unzip on a
// Mac. Checked on macOS 27: across every tested code point, APFS rejected exactly the ones this
// matches in Node 26 (Unicode 17). The set follows the browser's Unicode version, which roughly
// tracks the Mac it runs on; a character newer than the Mac that unzips the file can still fail.
const UNASSIGNED = /\p{Cn}/gu;
// Every character in this class is in the BMP, so testing one UTF-16 code unit at a time is exact.
const DOT_OR_SPACE = /^[\s.]$/;

/**
 * Remove leading and trailing dots and white space. Leading dots would hide the file on macOS and
 * Linux; trailing dots and spaces are stripped by Windows, which would make two different names
 * collide or a name vanish. A scan rather than /[\s.]+$/, which backtracks quadratically on a
 * long inner run of spaces (a hostile name could stall the page).
 * @param {string} s
 * @returns {string}
 */
function trimDotsAndSpaces(s) {
  let start = 0;
  let end = s.length;
  while (start < end && DOT_OR_SPACE.test(s[start])) start++;
  while (end > start && DOT_OR_SPACE.test(s[end - 1])) end--;
  return start === 0 && end === s.length ? s : s.slice(start, end);
}

export const UNTITLED = 'Untitled';

/**
 * Make a name safe as one path component on macOS, Windows and Linux, before any extension is
 * added. Never returns an empty string. Byte length is not capped here (see fitName).
 * @param {unknown} name
 * @returns {string}
 */
export function safeStem(name) {
  // Normalized last: removing a control character can bring a base letter and a combining mark
  // together, and the result must still be NFC.
  const s = textOf(name)
    .replace(LONE_SURROGATE, '_')
    .replace(UNASSIGNED, '_')
    .replace(WHITESPACE_CONTROLS, ' ')
    .replace(DROPPED_CHARS, '')
    .replace(FORBIDDEN_CHARS, '_');
  const clean = trimDotsAndSpaces(s).normalize('NFC');
  return clean === '' ? UNTITLED : clean;
}

/**
 * @param {string} s
 * @returns {number}
 */
export function utf8Length(s) {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3; // BMP, or a lone surrogate (encoded as U+FFFD, 3 bytes)
  }
  return bytes;
}

/** @type {{ segment(s: string): Iterable<{ segment: string }> } | null | undefined} */
let graphemes;

/**
 * User-perceived characters when Intl.Segmenter exists (so an emoji sequence or an accent is not
 * cut in half), otherwise code points. Either way a code point is never split.
 * @param {string} s
 * @returns {Iterable<string>}
 */
function* units(s) {
  if (graphemes === undefined) {
    graphemes = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
      ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      : null;
  }
  if (graphemes) {
    for (const g of graphemes.segment(s)) yield g.segment;
  } else {
    yield* s;
  }
}

/**
 * The longest prefix of s that fits in maxBytes of UTF-8.
 * @param {string} s
 * @param {number} maxBytes
 * @returns {string}
 */
export function truncateUtf8(s, maxBytes) {
  if (utf8Length(s) <= maxBytes) return s;
  let out = '';
  let bytes = 0;
  for (const unit of units(s)) {
    const b = utf8Length(unit);
    if (bytes + b > maxBytes) break;
    out += unit;
    bytes += b;
  }
  return out;
}

/**
 * True when the part of a full name before its first dot is a Windows device name.
 * @param {string} fullName
 * @returns {boolean}
 */
export function isWindowsReserved(fullName) {
  const dot = fullName.indexOf('.');
  let end = dot < 0 ? fullName.length : dot;
  while (end > 0 && fullName[end - 1] === ' ') end--; // Windows ignores spaces before the extension
  return end <= 7 && WINDOWS_RESERVED.test(fullName.slice(0, end)); // "CONOUT$" is the longest
}

/**
 * The part of a stem that fits beside `otherBytes` of suffix and extension within MAX_NAME_BYTES.
 * Truncation can expose trailing dots or spaces or leave nothing, so those are fixed on the result.
 * One byte of the budget is kept for the "_" that defuses a reserved name.
 * @param {string} stem
 * @param {number} otherBytes
 * @returns {string}
 */
function fitStem(stem, otherBytes) {
  const s = trimDotsAndSpaces(truncateUtf8(stem, MAX_NAME_BYTES - otherBytes - 1)).normalize('NFC');
  return s === '' ? UNTITLED : s;
}

/**
 * A full name with a Windows device name defused by a "_" before the first dot ("CON.gpx" ->
 * "CON_.gpx").
 * @param {string} full
 * @returns {string}
 */
function defuseReserved(full) {
  if (!isWindowsReserved(full)) return full;
  const dot = full.indexOf('.');
  return dot < 0 ? full + '_' : full.slice(0, dot) + '_' + full.slice(dot);
}

/**
 * Build stem + suffix + ext within MAX_NAME_BYTES, trimming the stem only, then defuse a reserved
 * name that the result spells (truncation can expose one).
 * @param {string} stem    from safeStem
 * @param {string} suffix  "" or " (n)"
 * @param {string} ext     "" for a directory, ".gpx" for a file
 * @returns {string}
 */
export function fitName(stem, suffix, ext) {
  return defuseReserved(fitStem(stem, utf8Length(suffix) + utf8Length(ext)) + suffix + ext);
}

/**
 * Comparison key for names in one directory. Windows and default macOS volumes ignore case, and
 * macOS treats differently normalized names as the same, so names are compared in NFC with case
 * folded both ways, repeated until stable: one round maps capital sharp s to sharp s but not on to
 * "ss", yet APFS treats all three as one name (checked on a case-insensitive APFS volume). This
 * over-merges a few pairs, which only costs an unneeded " (2)".
 * @param {string} name
 * @returns {string}
 */
function nameKey(name) {
  let key = name.normalize('NFC');
  for (let round = 0; round < 4; round++) {
    const next = key.toUpperCase().toLowerCase().normalize('NFC');
    if (next === key) break;
    key = next;
  }
  return key;
}

/**
 * Names already used in one directory. Numbered names are tracked per "family": the stem as it is
 * cut to fit beside a suffix of a given width, plus the extension. Stems that only collide once
 * cut share a family, so each family's counter only moves forward and claiming stays linear.
 */
class Namespace {
  constructor() {
    /** @type {Set<string>} */
    this.used = new Set();
    /** @type {Map<string, number>} family -> next number to try */
    this.next = new Map();
  }

  /** @param {string} name */
  reserve(name) {
    this.used.add(nameKey(name));
  }

  /**
   * @param {string} name
   * @returns {boolean} true when the name was free and is now taken
   */
  take(name) {
    const key = nameKey(name);
    if (this.used.has(key)) return false;
    this.used.add(key);
    return true;
  }

  /**
   * A name for stem + ext that is unique here, adding " (2)", " (3)", ... when needed.
   * @param {string} stem  from safeStem
   * @param {string} ext
   * @returns {{ name: string, shortened: boolean }}  shortened: the stem had to be cut to fit
   */
  claim(stem, ext) {
    const extBytes = utf8Length(ext);
    const fitted = fitStem(stem, extBytes);
    const first = defuseReserved(fitted + ext);
    if (this.take(first)) return { name: first, shortened: fitted !== stem };
    let n = 2;
    for (;;) {
      const digits = String(n).length;
      const cut = fitStem(stem, extBytes + digits + 3); // " (" + digits + ")"
      // NUL cannot occur in a safe name, so it separates the parts unambiguously.
      const family = `${digits}\0${nameKey(cut)}\0${nameKey(ext)}`;
      const start = this.next.get(family) ?? n;
      if (start > n) {
        n = start; // may change the digit count, so recompute the family
        continue;
      }
      this.next.set(family, n + 1);
      const candidate = defuseReserved(`${cut} (${n})${ext}`);
      if (this.take(candidate)) return { name: candidate, shortened: cut !== stem };
      n++;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The plan

/**
 * @typedef {object} PlannedFile
 * @property {string} path      ZIP entry path, "/"-separated, NFC, e.g. "Hiking/Alps/Day 1.gpx"
 * @property {"list"|"folder"|"unfiled"|"all"} role
 * @property {string|null} folderId  the list or folder this file mirrors (null for unfiled/all)
 * @property {string} title     the original name, for the GPX <metadata><name>
 * @property {Item[]} items     what the file holds, in order (objects from library.items)
 */

/**
 * @typedef {object} PathPlan
 * @property {string[]} directories  every directory, parents first, each ending in "/"
 * @property {PlannedFile[]} files
 * @property {FolderTree} tree       the repaired tree (reuse it for the KML)
 * @property {Problem[]} problems    tree repairs and path warnings, each code once
 */

/**
 * @typedef {object} PlanOptions
 * @property {string} [allItemsName]      default "All items"
 * @property {string} [unfiledName]       default "Unfiled"
 * @property {string} [extension]         default ".gpx"
 * @property {string[]} [reserveRootNames] full names the caller will add at the top level
 *                                         (e.g. "All items.kml", "Report.txt"); no folder or
 *                                         list will take them
 * @property {number} [maxDepth]          default MAX_FOLDER_DEPTH
 */

/**
 * Plan the ZIP layout for a library. Names are made safe and unique per directory (folders and
 * files share one namespace), so the paths can be written as they are.
 * @param {Library} library
 * @param {PlanOptions} [options]
 * @returns {PathPlan}
 */
export function planExportPaths(library, options = {}) {
  const ext = options.extension ?? '.gpx';
  const tree = buildFolderTree(library, { maxDepth: options.maxDepth });
  const tally = new Tally(PATH_MESSAGES);

  /** @type {string[]} */
  const directories = [];
  /** @type {PlannedFile[]} */
  const files = [];
  /** @type {Map<TreeNode, { path: string, names: Namespace }>} */
  const dirs = new Map();

  const rootNames = new Namespace();
  dirs.set(tree.root, { path: '', names: rootNames });
  // The caller's own files first, so that nothing planned here can take their names.
  for (const name of Array.isArray(options.reserveRootNames) ? options.reserveRootNames : []) {
    rootNames.reserve(textOf(name));
  }
  /**
   * @param {Namespace} names
   * @param {string} name
   * @returns {string}
   */
  const claimFile = (names, name) => {
    const claimed = names.claim(safeStem(name), ext);
    if (claimed.shortened) tally.add('name_shortened');
    return claimed.name;
  };
  const allItemsName = claimFile(rootNames, options.allItemsName ?? 'All items');
  const unfiledName = tree.unfiled.length > 0 ? claimFile(rootNames, options.unfiledName ?? 'Unfiled') : null;

  for (const node of tree.nodes) {
    const host = /** @type {{ path: string, names: Namespace }} */ (dirs.get(/** @type {TreeNode} */ (node.parent)));
    const folderId = typeof node.folder?.id === 'string' ? node.folder.id : null;
    const title = node.name.trim() === '' ? UNTITLED : node.name;
    if (node.isList) {
      files.push({ path: host.path + claimFile(host.names, node.name), role: 'list', folderId, title, items: node.items });
      continue;
    }
    const stem = safeStem(node.name);
    const dir = host.names.claim(stem, '');
    const own = { path: host.path + dir.name + '/', names: new Namespace() };
    dirs.set(node, own);
    directories.push(own.path);
    let shortened = dir.shortened;
    if (node.items.length > 0) {
      const file = own.names.claim(stem, ext);
      shortened = shortened || file.shortened;
      files.push({ path: own.path + file.name, role: 'folder', folderId, title, items: node.items });
    }
    if (shortened) tally.add('name_shortened'); // once per folder, whether its directory or its file was cut
  }

  if (unfiledName !== null) {
    files.push({ path: unfiledName, role: 'unfiled', folderId: null, title: options.unfiledName ?? 'Unfiled', items: tree.unfiled });
  }
  const allItems = Array.isArray(library?.items) ? library.items : [];
  files.push({ path: allItemsName, role: 'all', folderId: null, title: options.allItemsName ?? 'All items', items: allItems });

  for (const path of [...directories, ...files.map((f) => f.path)]) {
    if (path.length > LONG_PATH_CHARS) tally.add('path_long');
  }
  return { directories, files, tree, problems: [...tree.problems, ...tally.toProblems()] };
}
