// The preview: the summary, the folder tree, what is saved outside the lists, what will not convert, and
// the notes from reading. Names are drawn as text only.
//
// The tree follows the WAI-ARIA tree pattern with flat rows (aria-level, aria-setsize, aria-posinset) and a
// roving tabindex: one Tab stop, arrow keys to move, Right/Left to open and close folders, Home/End.
// Only the rows of open folders are in the page, so a library with thousands of lists stays quick.

import {
  buildTree,
  countsPhrase,
  formatNumber,
  groupNotConverted,
  listShortfalls,
  metaLine,
  plural,
  summarySentence,
  walkTree,
} from './ui.js';
import { clear, h, icon, setText, show } from './view-dom.js';

/** Rows drawn at once; past this the page says so (the download still has everything). */
const MAX_VISIBLE_ROWS = 5000;
/** Below this many folders and lists, every folder starts open. */
const OPEN_ALL_BELOW = 400;
/** Names shown in a not-converted group before "Show all". */
const NAMES_SHOWN = 24;

/**
 * Problem codes that mean the reader left out records that might have been waypoints, tracks or routes. With any of
 * them, the page does not say "every item counted above will be converted" (it would be true of the counts, but it
 * reads as "nothing was left out").
 */
const LEFT_OUT_CODES = new Set([
  'waypoint_not_decoded', 'waypoint_class_not_exported', 'track_not_decoded', 'route_not_converted', 'record_truncated',
  'record_too_large', 'too_many_records', 'data_after_end_record', 'unknown_record_type', 'listed_but_not_found',
  'all_data_too_large', 'internal_error',
]);

/** @typedef {import('./ui.js').TreeNode} TreeNode */
/** @typedef {import('./ui.js').Preview} Preview */
/** @typedef {import('./ui.js').State} State */

/**
 * @param {{summary: HTMLElement, meta: HTMLElement, notices: HTMLElement, tree: HTMLElement, treeNote: HTMLElement,
 *   expandAll: HTMLButtonElement, collapseAll: HTMLButtonElement, also: HTMLElement, ncFacts: HTMLElement,
 *   ncItems: HTMLElement, notesSection: HTMLElement, notesList: HTMLElement, head?: HTMLElement|null}} els
 *   head: the column headings above the tree (hidden when there is no tree to head)
 */
export function createPreview(els) {
  const tree = createTree(els.tree, els.treeNote, els.expandAll, els.collapseAll, els.head ?? null);
  let drawnId = -1;

  /** @param {State} state */
  function update(state) {
    const preview = state.preview;
    if (!preview || state.previewId === drawnId) return;
    drawnId = state.previewId;
    setText(els.summary, summarySentence(preview));
    setText(els.meta, metaLine(preview, state.versionFolder));
    drawNotices(els.notices, preview);
    tree.setData(preview);
    drawAlso(els.also, preview);
    drawNotConverted(els.ncFacts, els.ncItems, preview);
    drawNotes(els.notesSection, els.notesList, state);
  }

  return { update };
}

/**
 * @param {HTMLElement} box
 * @param {Preview} preview
 */
function drawNotices(box, preview) {
  clear(box);
  if (preview.experimental) {
    box.appendChild(
      h(
        'div',
        { class: 'notice notice-warn' },
        icon('alert'),
        h(
          'div',
          null,
          h('p', { class: 'notice-title', text: 'Read experimentally' }),
          h('p', {
            text:
              'This library was saved by a BaseCamp version whose file format Foldertrail reads experimentally. ' +
              'Check the converted files against BaseCamp before you rely on them.',
          }),
        ),
      ),
    );
  }
  if (preview.treeMissing) {
    box.appendChild(
      h(
        'div',
        { class: 'notice notice-warn' },
        icon('alert'),
        h(
          'div',
          null,
          h('p', { class: 'notice-title', text: 'No folders or lists were found' }),
          h('p', {
            text:
              'The folder file (FolderData.gfi) is missing or can’t be read, so your items will be saved grouped ' +
              'by type, without folders. Foldertrail doesn’t invent a folder tree.',
          }),
        ),
      ),
    );
  }
}

/**
 * @param {HTMLElement} box
 * @param {Preview} preview
 */
function drawAlso(box, preview) {
  clear(box);
  const rows = [];
  // Without a folder tree every item counts as unlisted, but the download groups them by type instead (the notice
  // above says so), so there is no "Not in any list" file to point at.
  const unlisted = preview.treeMissing ? '' : countsPhrase(preview.unlisted);
  if (unlisted !== '') {
    rows.push(
      h(
        'div',
        { class: 'also-row' },
        icon('file'),
        h(
          'div',
          null,
          h('h3', { class: 'also-title' }, 'Not in any list', ' ', h('span', { class: 'also-count', text: unlisted })),
          h('p', { text: 'These are in the library but in none of your lists. They are saved in a file of their own.' }),
        ),
      ),
    );
  }
  if (preview.ambiguousCount > 0) {
    const n = preview.ambiguousCount;
    rows.push(
      h(
        'div',
        { class: 'also-row' },
        icon('alert'),
        h(
          'div',
          null,
          h('h3', { class: 'also-title' }, 'Duplicate names', ' ', h('span', { class: 'also-count', text: plural(n, 'item') })),
          h('p', {
            text:
              `${n === 1 ? 'An item shares' : 'These items share'} a name with another item of the same kind, so ` +
              'Foldertrail can’t tell which list each one belongs in. It doesn’t guess: they are saved in a folder ' +
              'called “_Duplicate names”, and the report says which lists mention them.',
          }),
          preview.duplicates.length > 0
            ? h(
                'ul',
                { class: 'also-names' },
                preview.duplicates.slice(0, 12).map((d) =>
                  h('li', null, icon(d.kind), h('span', { class: 'also-name', text: d.name || '(no name)' }), d.copies > 1 ? h('span', { class: 'also-copies', text: `${d.copies} copies` }) : null),
                ),
                preview.duplicates.length > 12 ? h('li', { class: 'also-more', text: `and ${formatNumber(preview.duplicates.length - 12)} more, listed in the report` }) : null,
              )
            : null,
        ),
      ),
    );
  }
  if (rows.length === 0) return;
  box.appendChild(
    h(
      'section',
      { class: 'section', attrs: { 'aria-labelledby': 'also-title' } },
      h('h2', { attrs: { id: 'also-title' }, text: 'Saved outside your lists' }),
      h('div', { class: 'also' }, rows),
    ),
  );
}

/**
 * @param {HTMLElement} facts
 * @param {HTMLElement} items
 * @param {Preview} preview
 */
function drawNotConverted(facts, items, preview) {
  clear(facts);
  clear(items);
  /** @param {string} name @param {string} words */
  const fact = (name, words) => h('li', null, icon(name), h('span', { text: words }));
  const leftOut = preview.problems.some((p) => LEFT_OUT_CODES.has(p.code));
  if (preview.notConverted.length === 0 && !leftOut && (preview.totals.waypoints + preview.totals.tracks + preview.totals.routes) > 0) {
    facts.appendChild(fact('check', 'Every waypoint, track and route counted above will be converted.'));
  }
  if (preview.totals.routes > 0 || preview.notConverted.some((n) => n.kind === 'route')) {
    // The reader leaves road-following routes out entirely (reason route_autoroute), so the page must not suggest
    // they are converted without their road detail.
    facts.appendChild(
      fact(
        'route',
        'Routes are saved as straight lines between their via points. A GPS device can work out the roads again ' +
          'when you navigate the route. Routes that follow roads (calculated by BaseCamp) are not converted in ' +
          'this version.',
      ),
    );
  }
  facts.appendChild(fact('info', 'BirdsEye imagery, custom maps, Adventures, geocache logs and photos are not converted.'));

  const groups = groupNotConverted(preview.notConverted);
  const panel = groups.length > 0 ? h('div', { class: 'nc-panel' }) : null;
  if (panel) items.appendChild(panel);
  for (const group of groups) {
    const shown = group.names.slice(0, NAMES_SHOWN);
    const rest = group.names.slice(NAMES_SHOWN);
    /** @param {string[]} names */
    const nameList = (names) => h('ul', { class: 'nc-names' }, names.map((name) => nameItem(name)));
    /** @type {HTMLElement} */ (panel).appendChild(
      h(
        'div',
        { class: 'nc-group' },
        h(
          'div',
          { class: 'nc-head' },
          icon('alert'),
          h(
            'div',
            null,
            h('h3', { class: 'nc-head-title', text: group.title }),
            h('p', { text: group.text }),
          ),
        ),
        nameList(shown),
        rest.length > 0
          ? h('details', { class: 'nc-more' }, h('summary', { text: `Show ${formatNumber(rest.length)} more` }), nameList(rest))
          : null,
      ),
    );
  }
}

/** @param {string} name */
function nameItem(name) {
  return name === '' ? h('li', { class: 'is-untitled', text: '(no name)' }) : h('li', { text: name });
}

/**
 * @param {HTMLElement} section
 * @param {HTMLElement} list
 * @param {State} state
 */
function drawNotes(section, list, state) {
  clear(list);
  const preview = /** @type {Preview} */ (state.preview);
  // What a notice above already says is not repeated here.
  const kinds = new Set(preview.notConverted.map((n) => n.kind));
  const skip = new Set([
    ...(preview.treeMissing ? ['no_folder_data', 'folder_data_unreadable'] : []),
    ...(preview.experimental ? ['experimental_version'] : []),
    // Said, with names and the right counts, in "What will not convert" and "Saved outside your lists".
    ...(kinds.has('route') ? ['route_not_converted'] : []),
    ...(kinds.has('track') ? ['track_not_decoded'] : []),
    ...(kinds.has('waypoint') ? ['waypoint_not_decoded'] : []),
    ...(preview.ambiguousCount > 0 ? ['duplicate_names'] : []),
    ...(!preview.treeMissing && countsPhrase(preview.unlisted) !== '' ? ['not_in_any_list'] : []),
    // Without TrackSegments, tracks lose elevation and time; a library with no tracks loses nothing.
    ...(preview.totals.tracks === 0 && !kinds.has('track') ? ['no_track_segments'] : []),
  ]);
  const seen = new Set();
  const all = [...state.intakeProblems, ...preview.problems, ...state.intakeNotes];
  for (const problem of all) {
    if (skip.has(problem.code) || seen.has(problem.message)) continue;
    seen.add(problem.message);
    list.appendChild(
      h(
        'li',
        null,
        h('span', { text: problem.message }),
        problem.count > 1 ? h('span', { class: 'note-count', text: `×${formatNumber(problem.count)}` }) : null,
      ),
    );
  }
  show(section, list.childElementCount > 0);
}

/** @param {string} s */
function capitalise(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------------------------
// The tree

/**
 * @param {HTMLElement} container  the role=tree element
 * @param {HTMLElement} note
 * @param {HTMLButtonElement} expandBtn
 * @param {HTMLButtonElement} collapseBtn
 * @param {HTMLElement|null} [head]  the column headings, hidden when there is no tree
 */
export function createTree(container, note, expandBtn, collapseBtn, head = null) {
  /** The band under the tree that holds the note and the buttons; hidden when it would be empty. */
  const foot = /** @type {HTMLElement|null} */ (typeof note.closest === 'function' ? note.closest('.tree-foot') : null);
  /** @type {TreeNode[]} */
  let roots = [];
  /** @type {Map<string, {node: TreeNode, parent: TreeNode|null}>} */
  let index = new Map();
  /** @type {Set<string>} */
  let expanded = new Set();
  /** @type {string|null} */
  let activeId = null;
  /** @type {HTMLElement[]} */
  let rows = [];
  let truncated = false;
  let droppedRows = 0;
  /** @type {Preview|null} */
  let current = null;
  /** @type {ReturnType<typeof listShortfalls>} */
  let shortfalls = new Map();

  container.addEventListener('keydown', onKey);
  container.addEventListener('click', onClick);
  expandBtn.addEventListener('click', () => {
    for (const { node } of index.values()) if (node.children.length > 0) expanded.add(node.id);
    render(true);
  });
  collapseBtn.addEventListener('click', () => {
    expanded.clear();
    // Keep the top level open, so the tree never collapses to a single line.
    for (const node of roots) if (node.children.length > 0) expanded.add(node.id);
    const parent = activeId ? topAncestor(activeId) : null;
    if (parent) activeId = parent;
    render(true);
  });

  /** @param {Preview} preview */
  function setData(preview) {
    current = preview;
    shortfalls = listShortfalls(preview);
    const built = buildTree(preview.tree);
    roots = built.roots;
    droppedRows = built.dropped;
    index = new Map();
    /** @type {{node: TreeNode, parent: TreeNode|null}[]} */
    const stack = roots.map((node) => ({ node, parent: null }));
    while (stack.length > 0) {
      const item = /** @type {{node: TreeNode, parent: TreeNode|null}} */ (stack.pop());
      index.set(item.node.id, item);
      for (const child of item.node.children) stack.push({ node: child, parent: item.node });
    }
    expanded = new Set();
    const openAll = index.size < OPEN_ALL_BELOW;
    walkTree(roots, (node) => {
      if (node.children.length > 0 && (openAll || node.depth < 1)) expanded.add(node.id);
    });
    activeId = roots[0]?.id ?? null;
    render(false);
  }

  /** @param {boolean} keepFocus */
  function render(keepFocus) {
    const hadFocus = keepFocus || container.contains(document.activeElement);
    clear(container);
    rows = [];
    truncated = false;
    const frag = document.createDocumentFragment();

    if (roots.length === 0) {
      const words = current?.treeMissing
        ? 'There are no folders or lists to show. Your items will be saved grouped by type.'
        : 'This library has no folders or lists.';
      frag.appendChild(h('p', { class: 'tree-empty', text: words }));
      container.removeAttribute('role');
      container.appendChild(frag);
      show(expandBtn, false);
      show(collapseBtn, false);
      show(head, false);
      drawNote();
      return;
    }
    container.setAttribute('role', 'tree');
    show(head, true);
    const hasNested = [...index.values()].some(({ node }) => node.children.length > 0 && node.depth > 0) ||
      roots.some((node) => node.children.length > 0);
    show(expandBtn, hasNested);
    show(collapseBtn, hasNested);

    /** @type {{node: TreeNode, guides: string[], pos: number, size: number}[]} */
    const stack = [];
    for (let i = roots.length - 1; i >= 0; i--) stack.push({ node: roots[i], guides: [], pos: i + 1, size: roots.length });
    while (stack.length > 0) {
      if (rows.length >= MAX_VISIBLE_ROWS) {
        truncated = true;
        break;
      }
      const item = /** @type {{node: TreeNode, guides: string[], pos: number, size: number}} */ (stack.pop());
      const row = drawRow(item.node, item.guides, item.pos, item.size);
      rows.push(row);
      frag.appendChild(row);
      if (item.node.children.length > 0 && expanded.has(item.node.id)) {
        const kids = item.node.children;
        // A child's guides: its ancestors' columns (a line goes on where that ancestor has a later sibling),
        // then its own column, a tee or a final elbow.
        const inherited = item.node.depth === 0 ? [] : [...item.guides.slice(0, -1), item.pos < item.size ? 'pipe' : 'blank'];
        for (let i = kids.length - 1; i >= 0; i--) {
          stack.push({ node: kids[i], guides: [...inherited, i < kids.length - 1 ? 'tee' : 'elbow'], pos: i + 1, size: kids.length });
        }
      }
    }
    container.appendChild(frag);
    if (!rows.some((row) => row.dataset.id === activeId)) activeId = rows[0]?.dataset.id ?? null;
    for (const row of rows) row.tabIndex = row.dataset.id === activeId ? 0 : -1;
    drawNote();
    if (hadFocus) focusActive();
  }

  function drawNote() {
    const parts = [];
    if (current && !current.treeMissing) {
      // The worker's totals, so this line and the summary above always agree (they leave out the top folder,
      // "My Collection", which every library has).
      const lists = capitalise(plural(current.totals.lists, 'list'));
      parts.push(current.totals.folders > 0 ? `${lists} in ${plural(current.totals.folders, 'folder')}` : lists);
    }
    if (truncated) parts.push(`showing the first ${formatNumber(MAX_VISIBLE_ROWS)} rows; the download has them all`);
    if (droppedRows > 0) parts.push(`${plural(droppedRows, 'row')} could not be shown here`);
    setText(note, parts.join(' · '));
    if (foot) show(foot, parts.length > 0 || !expandBtn.hidden || !collapseBtn.hidden);
  }

  /**
   * @param {TreeNode} node
   * @param {string[]} guides
   * @param {number} pos
   * @param {number} size
   */
  function drawRow(node, guides, pos, size) {
    const isFolder = node.type === 'folder';
    const open = expanded.has(node.id);
    const hasKids = node.children.length > 0;
    const counts = countsPhrase(node.counts);
    const folderSub = isFolder ? folderSummary(node) : '';
    const name = node.name.trim() === '' ? '' : node.name;
    // What the list names in BaseCamp but its own file will not hold: items that will not convert, and items whose
    // name another item shares (they go to "_Duplicate names"). Without this a list of road routes reads "Empty".
    const short = isFolder ? undefined : shortfalls.get(node.id);
    const flags = [];
    if (short) {
      const nc = countsPhrase(short.notConverted);
      const dup = countsPhrase(short.duplicates);
      if (nc) flags.push(`${nc} not converted`);
      if (dup) flags.push(`${dup} in “_Duplicate names”`);
    }
    const listSub = counts || (flags.length > 0 ? 'nothing that converts' : 'empty');
    const label = isFolder
      ? `${name || 'Untitled folder'}, folder${folderSub ? `, ${folderSub}` : ''}`
      : `${name || 'Untitled list'}, list, ${listSub}${flags.map((f) => `, ${f}`).join('')}`;

    const row = h(
      'div',
      {
        class: `row ${isFolder ? 'row-folder' : 'row-list'}`,
        attrs: {
          role: 'treeitem',
          'aria-level': node.depth + 1,
          'aria-setsize': size,
          'aria-posinset': pos,
          'aria-expanded': hasKids ? String(open) : null,
          'aria-label': label,
          'data-id': node.id,
        },
      },
      h(
        'span',
        { class: 'row-name' },
        guides.length > 0 ? h('span', { class: 'guides', attrs: { 'aria-hidden': 'true' } }, guides.map((g) => h('span', { class: `g g-${g}` }))) : null,
        h('span', { class: `twisty${!hasKids && guides.length > 0 ? ' twisty-leaf' : ''}`, attrs: { 'aria-hidden': 'true' } }, hasKids ? icon('chevron') : null),
        icon(isFolder ? 'folder' : 'list', 'row-icon'),
        h(
          'span',
          { class: 'row-text' },
          h('span', { class: `row-title${name ? '' : ' is-untitled'}`, text: name || (isFolder ? 'Untitled folder' : 'Untitled list') }),
          isFolder ? (folderSub ? h('span', { class: 'row-sub', text: folderSub }) : null) : h('span', { class: 'row-sub', text: listSub }),
          flags.length > 0
            ? h('span', { class: 'row-flag' }, icon('alert'), h('span', { class: 'row-flag-items' }, flags.map((f) => h('span', { text: f }))))
            : null,
        ),
      ),
      // The numbers are in the row's label already; read out on their own they are just "4, 1, en dash".
      ...(['waypoints', 'tracks', 'routes'].map((key) => {
        if (isFolder) return h('span', { class: 'num', attrs: { 'aria-hidden': 'true' } });
        const n = node.counts[/** @type {"waypoints"|"tracks"|"routes"} */ (key)];
        return h('span', { class: `num${n === 0 ? ' is-zero' : ''}`, attrs: { 'aria-hidden': 'true' }, text: n === 0 ? '–' : formatNumber(n) });
      })),
    );
    row.tabIndex = -1;
    return row;
  }

  /** @param {TreeNode} node */
  function folderSummary(node) {
    const parts = [];
    if (node.lists > 0) parts.push(plural(node.lists, 'list'));
    if (node.lists === 0 && node.folders > 0) parts.push(plural(node.folders, 'folder'));
    return parts.length > 0 ? parts.join(', ') : 'empty';
  }

  /** @param {string} id */
  function topAncestor(id) {
    let entry = index.get(id);
    let steps = 0;
    while (entry && entry.parent && steps++ < 10_000) {
      if (entry.parent.depth === 0) return entry.parent.id;
      entry = index.get(entry.parent.id);
    }
    return id;
  }

  function focusActive() {
    const row = rows.find((r) => r.dataset.id === activeId);
    if (row) {
      row.tabIndex = 0;
      row.focus({ preventScroll: false });
    }
  }

  /** @param {string|null} id */
  function setActive(id) {
    if (!id) return;
    activeId = id;
    for (const row of rows) row.tabIndex = row.dataset.id === id ? 0 : -1;
    focusActive();
  }

  /** @param {string} id */
  function toggle(id) {
    const entry = index.get(id);
    if (!entry || entry.node.children.length === 0) return;
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    activeId = id;
    render(true);
  }

  /** @param {MouseEvent} event */
  function onClick(event) {
    const target = /** @type {Element|null} */ (event.target instanceof Element ? event.target : null);
    const row = /** @type {HTMLElement|null} */ (target?.closest('.row') ?? null);
    if (!row || !row.dataset.id) return;
    if (row.hasAttribute('aria-expanded')) toggle(row.dataset.id);
    else setActive(row.dataset.id);
  }

  /** @param {KeyboardEvent} event */
  function onKey(event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const i = rows.findIndex((row) => row.dataset.id === activeId);
    if (i < 0) return;
    const row = rows[i];
    const id = /** @type {string} */ (row.dataset.id);
    const entry = index.get(id);
    let handled = true;
    switch (event.key) {
      case 'ArrowDown':
        setActive(rows[Math.min(i + 1, rows.length - 1)].dataset.id ?? null);
        break;
      case 'ArrowUp':
        setActive(rows[Math.max(i - 1, 0)].dataset.id ?? null);
        break;
      case 'Home':
        setActive(rows[0].dataset.id ?? null);
        break;
      case 'End':
        setActive(rows[rows.length - 1].dataset.id ?? null);
        break;
      case 'ArrowRight':
        if (entry && entry.node.children.length > 0) {
          if (!expanded.has(id)) toggle(id);
          else setActive(entry.node.children[0].id);
        }
        break;
      case 'ArrowLeft':
        if (entry && entry.node.children.length > 0 && expanded.has(id)) toggle(id);
        else if (entry?.parent) setActive(entry.parent.id);
        break;
      case 'Enter':
      case ' ':
        if (entry && entry.node.children.length > 0) toggle(id);
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  }

  return { setData };
}
