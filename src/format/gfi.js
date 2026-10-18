// FolderData.gfi: the folder and list tree, and the item references that place items in lists (FORMAT.md §8).
//
// Records (after the "DifG" header that container.js reads): 'F' folders, 'I' items (each one a BaseCamp list), then
// 'T', 'W', 'R' references naming an item of AllData.gdb by type and name, and 'K'/'J' BirdsEye references (counted,
// not converted). Folder IDs and list IDs are separate ID spaces: every child reference carries a type (§8.4).
//
// The tree is hostile input: children may dangle, IDs may repeat, folders may form loops or sit in two places, and
// the root may be missing. buildTree() never recurses, guards against cycles with a visited set, caps depth at 64,
// keeps the first of anything that repeats, and counts every repair. Nothing throws.

import { Cursor, ParseStop, decodeText, rawKey, Counts } from './gdb.js';

export const ROOT_FOLDER_ID = 0xffffffff;
export const MAX_TREE_DEPTH = 64;
/** The predefined root's name in BaseCamp (used only when the file has no usable root). */
export const ROOT_NAME = 'My Collection';
/**
 * Folder and list names longer than this (in UTF-16 code units) are shortened to it plus '…' and counted
 * (name_shortened). A name is repeated in the path of every folder and list below it (the report, each list's GPX
 * description), so an unbounded name multiplies by the number of lists. GUESS: BaseCamp's own names are far shorter.
 */
export const MAX_NAME_CHARS = 255;

/** 'I' created-by value of a smart list ("Last Week", "Last Month"; FORMAT.md §15.11, decision B40). */
export const SMART_LIST = 3;

const CHILD_LIST = 0;
const CHILD_FOLDER = 1;
/** Stands for a display-only root; a u32 folder ID can never be negative. */
const DISPLAY_ROOT = -1;

/**
 * @typedef {object} GfiFolder
 * @property {number} id
 * @property {string} name
 * @property {number} parent      parent folder ID as stored
 * @property {Array<{type: number, id: number}>} children  type 0 = list, 1 = folder (others dropped and counted)
 */

/**
 * @typedef {object} GfiList
 * @property {number} id
 * @property {string} name
 * @property {number} createdBy   0 user or import list, 1 auto-created on import (OP), 3 a smart list (Mac 4.8), 8 the
 *   "Unlisted Data" item
 * @property {number} parent      parent folder ID as stored (I.parent)
 */

/**
 * @typedef {object} GfiReference
 * @property {"waypoint"|"track"|"route"} kind
 * @property {number} listId
 * @property {string} key      raw name bytes
 * @property {string} name     decoded
 * @property {number|null} cls waypoint class (W references only)
 */

/**
 * @typedef {object} GfiContent
 * @property {GfiFolder[]} folders  in file order, duplicates of an ID dropped
 * @property {GfiList[]} lists      in file order, duplicates of an ID dropped
 * @property {GfiReference[]} references
 * @property {number} birdsEye      'K' and 'J' references (not converted)
 */

/**
 * Parses the records of a FolderData.gfi container.
 * @param {Iterable<{type: string, body: Uint8Array}>} records
 * @param {Counts} counts  receives: text_not_utf8, folder_record_unreadable, list_record_unreadable,
 *   reference_unreadable, folder_tail_unexpected, list_tail_unexpected, unknown_child_type, duplicate_id,
 *   not_converted_kind, gfi_record_unexpected, name_shortened
 * @returns {GfiContent}
 */
export function parseFolderData(records, counts) {
  /** @type {GfiContent} */
  const out = { folders: [], lists: [], references: [], birdsEye: 0 };
  /** @type {Set<number>} */
  const folderIds = new Set();
  /** @type {Set<number>} */
  const listIds = new Set();
  for (const record of records) {
    const body = record.body;
    try {
      switch (record.type) {
        case 'F': {
          const folder = parseFolder(body, counts);
          if (!folder) break;
          if (folderIds.has(folder.id)) counts.add('duplicate_id');
          else {
            folderIds.add(folder.id);
            out.folders.push(folder);
          }
          break;
        }
        case 'I': {
          const list = parseList(body, counts);
          if (!list) break;
          if (listIds.has(list.id)) counts.add('duplicate_id');
          else {
            listIds.add(list.id);
            out.lists.push(list);
          }
          break;
        }
        case 'T':
        case 'W':
        case 'R': {
          const ref = parseReference(record.type, body, counts);
          if (ref) out.references.push(ref);
          break;
        }
        case 'K':
        case 'J':
          out.birdsEye++;
          counts.add('not_converted_kind');
          break;
        default:
          // Unknown types are already counted by the container; known GDB-only types are counted here.
          counts.add('gfi_record_unexpected');
      }
    } catch (error) {
      if (!(error instanceof ParseStop)) throw error;
      counts.add('gfi_record_unexpected');
    }
  }
  return out;
}

/**
 * 'F' folder (§8.1).
 * @param {Uint8Array} body
 * @param {Counts} counts
 * @returns {GfiFolder|null}
 */
function parseFolder(body, counts) {
  const c = new Cursor(body);
  try {
    const id = c.u32('F1');
    const nameRange = c.cstr('F2');
    const parent = c.u32('F3');
    const n = c.count(8, 'F4');
    /** @type {Array<{type: number, id: number}>} */
    const children = [];
    for (let i = 0; i < n; i++) {
      const type = c.u32('F5');
      const child = c.u32('F5');
      if (type === CHILD_LIST || type === CHILD_FOLDER) children.push({ type, id: child });
      else counts.add('unknown_child_type');
    }
    // OP's one byte, or Mac 4.8's ten (u8, u32, i32 time, u8; FORMAT.md §15.8, §15.11). The values are not used.
    if (c.remaining !== 1 && c.remaining !== 10) counts.add('folder_tail_unexpected');
    return { id, name: boundedName(decodeText(body, nameRange, counts), counts), parent, children };
  } catch (error) {
    if (!(error instanceof ParseStop)) throw error;
    counts.add('folder_record_unreadable');
    return null;
  }
}

/**
 * 'I' item, which is a BaseCamp list (§8.2).
 * @param {Uint8Array} body
 * @param {Counts} counts
 * @returns {GfiList|null}
 */
function parseList(body, counts) {
  const c = new Cursor(body);
  try {
    const id = c.u32('I1');
    const nameRange = c.cstr('I2');
    const createdBy = c.u32('I3');
    const parent = c.u32('I4');
    let tailOk;
    if (createdBy === 0) tailOk = c.remaining === 0;
    else if (c.remaining === 9) tailOk = c.u8('I5') === 1 && c.u32('I5') === 1 && c.u32('I5') === 9;
    // A smart list on Mac 4.8 (FORMAT.md §15.8, §15.11): u8 1, u32 0.
    else if (createdBy === SMART_LIST && c.remaining === 5) tailOk = c.u8('I5') === 1 && c.u32('I5') === 0;
    else tailOk = false;
    if (!tailOk) counts.add('list_tail_unexpected');
    return { id, name: boundedName(decodeText(body, nameRange, counts), counts), createdBy, parent };
  } catch (error) {
    if (!(error instanceof ParseStop)) throw error;
    counts.add('list_record_unreadable');
    return null;
  }
}

/**
 * A folder or list name cut to MAX_NAME_CHARS (never inside a surrogate pair) plus '…', counted as name_shortened.
 * @param {string} name
 * @param {Counts} counts
 * @returns {string}
 */
function boundedName(name, counts) {
  if (name.length <= MAX_NAME_CHARS) return name;
  counts.add('name_shortened');
  const last = name.charCodeAt(MAX_NAME_CHARS - 1);
  const cut = last >= 0xd800 && last <= 0xdbff ? MAX_NAME_CHARS - 1 : MAX_NAME_CHARS;
  return `${name.slice(0, cut)}\u2026`;
}

/**
 * 'T', 'W' or 'R' reference (§8.3). Only the agreed prefix is required: ID and name, plus the class for 'W'.
 * @param {string} type
 * @param {Uint8Array} body
 * @param {Counts} counts
 * @returns {GfiReference|null}
 */
function parseReference(type, body, counts) {
  const c = new Cursor(body);
  try {
    const listId = c.u32('1');
    const nameRange = c.cstr('2');
    const cls = type === 'W' ? c.u32('3') : null;
    const kind = type === 'W' ? 'waypoint' : type === 'T' ? 'track' : 'route';
    return { kind, listId, key: rawKey(body, nameRange), name: decodeText(body, nameRange, counts), cls };
  } catch (error) {
    if (!(error instanceof ParseStop)) throw error;
    counts.add('reference_unreadable');
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The tree (§8.4)

/**
 * @typedef {object} TreeNodeOut
 * @property {string} id           model id: "f<id>" for folders, "l<id>" for lists, "f-root" for a display-only root
 * @property {string} name
 * @property {"folder"|"list"} type
 * @property {string|null} parentId
 * @property {number} sourceId     the ID in the file (-1 for a display-only root)
 */

/**
 * @typedef {object} TreeResult
 * @property {TreeNodeOut[]} nodes   root first, then pre-order in child order (parents always before children)
 * @property {Map<number, string>} listIds  list ID in the file → model id, for every list placed in the tree
 * @property {string} rootId
 */

/**
 * The model id of a folder or list.
 * @param {"folder"|"list"} type
 * @param {number} id
 */
export function modelId(type, id) {
  return (type === 'folder' ? 'f' : 'l') + id;
}

/**
 * Builds the folder and list tree. Each folder or list is placed once:
 * - the root is folder 0xFFFFFFFF; failing that, a folder that is its own parent; failing that, a display-only root
 *   that holds every folder and list no folder claims (counted as root_missing);
 * - a folder or list sits under the first folder (in file order) whose children name it; later claims are counted as
 *   folder_in_two_places; references to IDs that do not exist are counted as dangling_child;
 * - the tree is walked from the root with a visited set and a depth cap of 64. Folders the walk does not reach are
 *   left out (folder_not_in_tree); lists it does not reach go under the root (list_not_in_tree);
 * - a reached list whose own parent field (I.parent) names a different folder keeps the F.children placement and is
 *   counted as list_folder_disagreement.
 * @param {GfiContent} content
 * @param {Counts} counts
 * @returns {TreeResult}
 */
export function buildTree(content, counts) {
  /** @type {Map<number, GfiFolder>} */
  const folders = new Map(content.folders.map((f) => [f.id, f]));
  /** @type {Map<number, GfiList>} */
  const lists = new Map(content.lists.map((l) => [l.id, l]));

  /** @type {GfiFolder|null} */
  let fileRoot = folders.get(ROOT_FOLDER_ID) ?? null;
  if (!fileRoot) fileRoot = content.folders.find((f) => f.parent === f.id) ?? null;
  const rootKey = fileRoot ? fileRoot.id : DISPLAY_ROOT;

  // First claim wins: child (type, id) → the folder that first lists it.
  /** @type {Map<number, number>} folder id → claiming folder id */
  const folderOwner = new Map();
  /** @type {Map<number, number>} list id → claiming folder id */
  const listOwner = new Map();
  for (const folder of content.folders) {
    for (const child of folder.children) {
      if (child.type === CHILD_FOLDER) {
        if (!folders.has(child.id)) counts.add('dangling_child');
        else if (child.id === rootKey || child.id === folder.id || folderOwner.has(child.id)) counts.add('folder_in_two_places');
        else folderOwner.set(child.id, folder.id);
      } else if (!lists.has(child.id)) counts.add('dangling_child');
      else if (listOwner.has(child.id)) counts.add('folder_in_two_places');
      else listOwner.set(child.id, folder.id);
    }
  }

  // Without a root in the file, a display-only root holds every folder and list that no folder claims (§8.1).
  /** @type {GfiFolder} */
  let root;
  if (fileRoot) root = fileRoot;
  else {
    counts.add('root_missing');
    /** @type {Array<{type: number, id: number}>} */
    const children = [];
    for (const f of content.folders) {
      if (!folderOwner.has(f.id)) {
        folderOwner.set(f.id, DISPLAY_ROOT);
        children.push({ type: CHILD_FOLDER, id: f.id });
      }
    }
    for (const l of content.lists) {
      if (!listOwner.has(l.id)) {
        listOwner.set(l.id, DISPLAY_ROOT);
        children.push({ type: CHILD_LIST, id: l.id });
      }
    }
    root = { id: DISPLAY_ROOT, name: ROOT_NAME, parent: DISPLAY_ROOT, children };
  }

  /** @type {TreeNodeOut[]} */
  const nodes = [];
  /** @type {Map<number, string>} */
  const listIds = new Map();
  const rootId = fileRoot ? modelId('folder', root.id) : 'f-root';
  /** @param {number} id */
  const folderModelId = (id) => (id === DISPLAY_ROOT ? 'f-root' : modelId('folder', id));
  nodes.push({ id: rootId, name: root.name, type: 'folder', parentId: null, sourceId: fileRoot ? root.id : -1 });

  /** @type {Set<number>} */
  const visited = new Set();
  /** @type {Set<number>} */
  const placedLists = new Set();
  let tooDeep = 0;
  {
    visited.add(root.id);
    // Iterative pre-order walk in child order: each folder's children (lists and folders, as the file lists them)
    // come right after it, and a sub-folder's whole subtree before the next sibling.
    /** @type {Array<{folder: GfiFolder, depth: number, next: number}>} */
    const stack = [{ folder: root, depth: 0, next: 0 }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.next >= top.folder.children.length) {
        stack.pop();
        continue;
      }
      const child = top.folder.children[top.next++];
      const parentModel = folderModelId(top.folder.id);
      if (child.type === CHILD_LIST) {
        if (listOwner.get(child.id) !== top.folder.id || placedLists.has(child.id)) continue;
        const list = /** @type {GfiList} */ (lists.get(child.id));
        placedLists.add(list.id);
        const id = modelId('list', list.id);
        listIds.set(list.id, id);
        nodes.push({ id, name: list.name, type: 'list', parentId: parentModel, sourceId: list.id });
        if (fileRoot && list.parent !== top.folder.id) counts.add('list_folder_disagreement');
        continue;
      }
      if (folderOwner.get(child.id) !== top.folder.id || visited.has(child.id)) continue;
      if (top.depth + 1 > MAX_TREE_DEPTH) {
        tooDeep++;
        continue;
      }
      visited.add(child.id);
      const folder = /** @type {GfiFolder} */ (folders.get(child.id));
      nodes.push({ id: folderModelId(folder.id), name: folder.name, type: 'folder', parentId: parentModel, sourceId: folder.id });
      stack.push({ folder, depth: top.depth + 1, next: 0 });
    }
  }
  if (tooDeep > 0) counts.add('tree_too_deep', tooDeep);
  for (const folder of content.folders) {
    if (folder !== root && !visited.has(folder.id)) counts.add('folder_not_in_tree');
  }
  // Lists the walk did not reach go directly under the root (§8.4).
  for (const list of content.lists) {
    if (placedLists.has(list.id)) continue;
    const id = modelId('list', list.id);
    listIds.set(list.id, id);
    nodes.push({ id, name: list.name, type: 'list', parentId: rootId, sourceId: list.id });
    counts.add('list_not_in_tree');
  }
  return { nodes, listIds, rootId };
}
