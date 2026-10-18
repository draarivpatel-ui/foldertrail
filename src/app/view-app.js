// Wires the page to the controller in ui.js: drops and file pickers, the worker, the step rail, each view,
// the download link and the copy buttons. main.js loads this module only in a browser that can run the app.

import { captureDrop, intake, toWorkerSource } from './intake.js';
import { createController, detectSupport, formatBytes, nextSteps, PHASE_TEXT, supportContact, supportMessages } from './ui.js';
import { byId, clear, h, icon, setText, show } from './view-dom.js';
import { createPreview } from './view-preview.js';
import { createUnlock, setBar } from './view-unlock.js';

/** @typedef {import('./ui.js').State} State */

const PROVIDERS = /** @type {Record<string, string>} */ ({ polar: 'Polar', gumroad: 'Gumroad' });

const TITLES = /** @type {Record<State["view"], string>} */ ({
  open: 'Foldertrail · Convert your BaseCamp library',
  read: 'Foldertrail · Reading…',
  preview: 'Foldertrail · Preview',
  done: 'Foldertrail · Your files are ready',
  error: 'Foldertrail · Something went wrong',
});

/**
 * @param {{config: any, isConfigured: (() => boolean)|null, license: any}} modules
 *   config and license may be null when their modules are missing: the page then shows the preview only.
 */
export function startApp(modules) {
  const config = modules.config && typeof modules.config === 'object' ? modules.config : {};
  const support = detectSupport();
  const sale = saleInfo(config, modules.isConfigured, modules.license);

  const views = {
    open: byId('view-open'),
    read: byId('view-read'),
    preview: byId('view-preview'),
    done: byId('view-done'),
    error: byId('view-error'),
  };
  const dropzone = byId('dropzone');
  const folderInput = /** @type {HTMLInputElement} */ (byId('folder-input'));
  const fileInput = /** @type {HTMLInputElement} */ (byId('file-input'));
  const chooseFolder = /** @type {HTMLButtonElement} */ (byId('choose-folder'));
  const chooseFile = /** @type {HTMLButtonElement} */ (byId('choose-file'));
  const readBar = byId('read-progress');
  const readFill = /** @type {HTMLElement} */ (readBar.querySelector('.progress-fill'));
  const downloadAgain = /** @type {HTMLAnchorElement} */ (byId('download-again'));
  const dumpText = byId('dump-text');
  const toggleDump = byId('toggle-dump');

  // ----- the controller

  const controller = createController({
    intake: (input, options) => intake(input, options),
    toWorkerSource,
    createWorker,
    license: sale.onSale ? modules.license : null,
    onSale: sale.onSale,
    support,
    onChange: scheduleRender,
  });

  /**
   * @param {(data: unknown) => void} onMessage
   * @param {(kind: "error"|"messageerror") => void} onFailure
   */
  function createWorker(onMessage, onFailure) {
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event) => onMessage(event.data));
    worker.addEventListener('error', (event) => {
      event.preventDefault();
      onFailure('error');
    });
    worker.addEventListener('messageerror', () => onFailure('messageerror'));
    return {
      post: (/** @type {unknown} */ message) => worker.postMessage(message),
      terminate: () => worker.terminate(),
    };
  }

  // ----- views that draw themselves

  const preview = createPreview({
    summary: byId('preview-summary'),
    meta: byId('preview-meta'),
    notices: byId('preview-notices'),
    tree: byId('tree'),
    treeNote: byId('tree-note'),
    expandAll: /** @type {HTMLButtonElement} */ (byId('expand-all')),
    collapseAll: /** @type {HTMLButtonElement} */ (byId('collapse-all')),
    also: byId('also-saved'),
    ncFacts: byId('not-converted-facts'),
    ncItems: byId('not-converted-items'),
    notesSection: byId('reading-notes'),
    notesList: byId('reading-notes-list'),
    head: byId('tree-head'),
  });

  const unlock = createUnlock(
    {
      presale: byId('presale'),
      steps: byId('licence-steps'),
      price: byId('unlock-price'),
      buyLink: byId('buy-link'),
      buyNote: byId('buy-note'),
      privacy: byId('licence-privacy'),
      keyForm: byId('key-form'),
      keyInput: byId('licence-key'),
      unlockBtn: byId('unlock-btn'),
      message: byId('licence-message'),
      saved: byId('licence-saved'),
      forget: byId('forget-licence'),
      options: byId('options'),
      optKml: byId('opt-kml'),
      optPerItem: byId('opt-per-item'),
      downloadBtn: byId('download-btn'),
      exportProgress: byId('export-progress'),
      exportPhase: byId('export-phase'),
      exportBar: byId('export-bar'),
      cancelExport: byId('cancel-export'),
      exportError: byId('export-error'),
      exportErrorText: byId('export-error-text'),
      buyStep: byId('buy-step'),
      keyLabel: byId('licence-key-label'),
      keyRow: byId('key-row'),
      savedText: byId('licence-saved-text'),
      downloadHint: byId('download-hint'),
    },
    sale,
    {
      verify: (key) => void controller.verify(key),
      forget: () => controller.forgetLicence(),
      setOptions: (o) => controller.setOptions(o),
      download: () => void controller.download(),
      cancel: () => controller.cancel(),
    },
  );

  // ----- browser support

  const messages = supportMessages(support);
  if (messages.blocking) {
    setText(byId('support-blocking-text'), messages.blocking);
    show(byId('support-blocking'), true);
    chooseFolder.disabled = true;
    chooseFile.disabled = true;
    dropzone.classList.add('is-disabled');
  }
  const notesBox = byId('support-notes');
  for (const note of messages.notes) {
    notesBox.appendChild(h('p', { class: 'notice notice-info' }, icon('info'), h('span', { text: note })));
  }
  if (!support.folderPicker) {
    show(chooseFolder, false);
    show(byId('chrome-note'), false);
  }

  // ----- choosing a library

  chooseFolder.addEventListener('click', () => folderInput.click());
  chooseFile.addEventListener('click', () => fileInput.click());
  for (const input of [folderInput, fileInput]) {
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      input.value = '';
      if (files.length > 0) start(files);
    });
  }

  /** @param {unknown} input */
  function start(input) {
    if (messages.blocking) return;
    const view = controller.state.view;
    if (controller.state.busy) return;
    if (view !== 'open') controller.reset();
    void controller.open(input);
  }

  // Dropping works anywhere on the page. A drop that is not files (text into the key field, say) is left alone.
  let dragDepth = 0;
  /** @param {DragEvent} event */
  const hasFiles = (event) => {
    try {
      return Array.from(event.dataTransfer?.types ?? []).includes('Files');
    } catch {
      return false;
    }
  };
  document.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth++;
    if (canTakeDrop()) document.body.classList.add('is-dragging');
  });
  document.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = canTakeDrop() ? 'copy' : 'none';
  });
  document.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove('is-dragging');
  });
  document.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('is-dragging');
    if (!canTakeDrop()) return;
    // The browser empties the DataTransfer when this handler returns, so it is captured now.
    start(captureDrop(event.dataTransfer));
  });

  function canTakeDrop() {
    return !messages.blocking && !controller.state.busy;
  }

  // ----- the other buttons

  byId('cancel-read').addEventListener('click', () => controller.cancel());
  byId('start-over').addEventListener('click', () => controller.reset());
  byId('error-retry').addEventListener('click', () => controller.dismissError());

  const copyPath = /** @type {HTMLButtonElement} */ (byId('copy-path'));
  copyPath.addEventListener('click', async () => {
    const label = /** @type {HTMLElement} */ (copyPath.querySelector('.btn-text'));
    const ok = await copyText(byId('db-path').textContent ?? '', byId('db-path'));
    setText(label, ok ? 'Copied' : 'Press ⌘C');
    setTimeout(() => setText(label, 'Copy'), 2400);
  });

  byId('copy-dump').addEventListener('click', async () => {
    const dump = controller.state.dump;
    const status = byId('copy-dump-status');
    if (!dump) return;
    const ok = await copyText(dump.text || dump.json, null);
    status.classList.toggle('is-bad', !ok);
    if (ok) setText(status, 'Copied.');
    else {
      showDump(true);
      selectAll(dumpText);
      setText(status, 'Copying was blocked. The report is selected below: press ⌘C (or Ctrl+C).');
    }
    setTimeout(() => setText(status, ''), 6000);
  });
  toggleDump.addEventListener('click', () => showDump(dumpText.hidden));

  /** @param {boolean} visible */
  function showDump(visible) {
    show(dumpText, visible);
    toggleDump.setAttribute('aria-expanded', String(visible));
    setText(toggleDump, visible ? 'Hide it' : 'Show it');
  }

  // ----- static words from the config

  const version = typeof config.version === 'string' && /^[0-9][0-9A-Za-z.+-]{0,30}$/.test(config.version) ? config.version : '';
  setText(byId('footer-meta'), `${version ? `Foldertrail ${version}. ` : ''}Runs in your browser. Nothing is uploaded.`);
  // A real support address, or plain words saying there is none yet; never a placeholder address (ui.js).
  const help = supportContact(config.supportEmail, sale.onSale);
  const contact = byId('support-contact');
  clear(contact);
  if (help.email) {
    contact.append('To ask for help, paste it into an email to ', h('a', { attrs: { href: `mailto:${help.email}` }, text: help.email }), '.');
  } else {
    contact.append(help.text);
  }
  show(contact, true);

  // ----- drawing

  /** @type {State|null} */
  let pending = null;
  /** @type {State|null} */
  let drawn = null;
  let frame = 0;
  let objectUrl = '';

  /** @param {State} state */
  function scheduleRender(state) {
    pending = state;
    if (frame) return;
    // Progress can arrive many times a frame; draw once per frame. (rAF is paused in background tabs, so a
    // timer backs it up.)
    const run = () => {
      if (!frame) return;
      frame = 0;
      if (pending) render(pending);
    };
    frame = requestAnimationFrame(run);
    setTimeout(run, 120);
  }

  /** @param {State} state */
  function render(state) {
    const previous = drawn;
    drawn = state;

    // Views
    for (const [name, el] of Object.entries(views)) show(el, name === state.view);
    if (!previous || previous.view !== state.view) {
      document.title = TITLES[state.view];
      if (previous) focusHeading(views[state.view]);
    }

    drawRail(state);

    // 1. Open
    const errorsBox = byId('open-errors');
    const errorsList = byId('open-errors-list');
    if (!previous || previous.openErrors !== state.openErrors) {
      clear(errorsList);
      for (const message of state.openErrors) errorsList.appendChild(h('li', { text: message }));
      show(errorsBox, state.openErrors.length > 0);
    }
    setText(byId('open-status'), state.view === 'open' ? state.status ?? '' : '');

    // 2. Read
    if (state.view === 'read') {
      setText(byId('read-phase'), PHASE_TEXT[/** @type {keyof typeof PHASE_TEXT} */ (state.phase)] ?? PHASE_TEXT.starting);
      setBar(readBar, readFill, state.done, state.total);
      setText(
        byId('read-detail'),
        state.total ? `${Math.round((state.done / state.total) * 100)}%` : '',
      );
    }

    // 3 and 4. Preview and download
    preview.update(state);
    unlock.update(state);

    // 5. Done
    if (state.result && (!previous || previous.result !== state.result)) {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(state.result.blob);
      downloadAgain.href = objectUrl;
      downloadAgain.download = state.result.filename;
      const size = formatBytes(state.result.size);
      setText(
        byId('done-summary'),
        `Your browser should now be saving ${state.result.filename}${size ? ` (${size})` : ''}, usually to your ` +
          'Downloads folder. If it didn’t, use Download again.',
      );
      setText(byId('report-text'), state.result.reportText || 'The report is in the ZIP file, as report.txt.');
      // Where the files are depends on the options chosen and on whether the folder tree could be read.
      const steps = byId('next-steps');
      clear(steps);
      for (const step of nextSteps(state.options, Boolean(state.preview?.treeMissing))) steps.appendChild(h('li', { text: step }));
      // Start the download once; "Download again" is there if the browser blocked it.
      downloadAgain.click();
    }
    if (!state.result && objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = '';
      downloadAgain.removeAttribute('href');
    }

    // Error
    setText(byId('error-message'), state.error ?? '');

    // Diagnostic report
    const diag = byId('diagnostic');
    const showDiag = Boolean(state.dump) && (state.view === 'preview' || state.view === 'done' || state.view === 'error');
    show(diag, showDiag);
    if (state.dump && (!previous || previous.dump !== state.dump)) {
      setText(dumpText, state.dump.text || state.dump.json);
      showDump(false);
    }
  }

  /** @param {State} state */
  function drawRail(state) {
    let current = 0;
    let doneUpTo = -1;
    let failed = -1;
    if (state.view === 'read') current = 1;
    else if (state.view === 'preview') current = state.busy === 'export' ? 3 : 2;
    else if (state.view === 'done') {
      current = -1;
      doneUpTo = 3;
    } else if (state.view === 'error') {
      failed = state.preview ? 3 : 1;
      current = -1;
    }
    if (current >= 0) doneUpTo = current - 1;
    if (failed >= 0) doneUpTo = failed - 1;
    const steps = document.querySelectorAll('.step');
    steps.forEach((step, i) => {
      step.classList.toggle('is-done', i <= doneUpTo);
      step.classList.toggle('is-current', i === current);
      step.classList.toggle('is-failed', i === failed);
      if (i === current || i === failed) step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
      // The step's state for screen readers (aria-label on a plain span is not read out, so it is text).
      const label = step.querySelector('.step-label');
      if (label) {
        const status = i <= doneUpTo ? ' (done)' : i === failed ? ' (stopped)' : '';
        let note = /** @type {HTMLElement|null} */ (label.querySelector('.visually-hidden'));
        if (!note && status) {
          note = h('span', { class: 'visually-hidden' });
          label.appendChild(note);
        }
        if (note) setText(note, status);
      }
    });
  }

  /** @param {HTMLElement} view */
  function focusHeading(view) {
    const heading = /** @type {HTMLElement|null} */ (view.querySelector('h1'));
    if (heading) heading.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  // First draw
  byId('boot-note').hidden = true;
  render(controller.state);

  // A license key saved on an earlier visit is checked again now, at most once per browser session
  // (license.js restoreLicense; nothing is asked when not on sale or when no key is saved).
  void controller.restoreLicence();
}

/**
 * Whether the page may sell: the config says so, the checkout link is a real https: URL, and the licence
 * module is there.
 * @param {any} config
 * @param {(() => boolean)|null} isConfigured
 * @param {any} license
 * @returns {import('./view-unlock.js').SaleInfo}
 */
export function saleInfo(config, isConfigured, license) {
  let configured = false;
  try {
    configured = typeof isConfigured === 'function' && isConfigured() === true;
  } catch {
    configured = false;
  }
  let checkoutUrl = '';
  try {
    const url = new URL(String(config.checkoutUrl ?? ''));
    if (url.protocol === 'https:') checkoutUrl = url.href;
  } catch {
    checkoutUrl = '';
  }
  const hasLicence = Boolean(license) && typeof license.verifyLicense === 'function';
  const provider = PROVIDERS[String(config.licenseProvider ?? '')] ?? 'the payment provider';
  const price = typeof config.priceDisplay === 'string' && config.priceDisplay.length <= 24 ? config.priceDisplay : '';
  return { onSale: configured && checkoutUrl !== '' && hasLicence, price, checkoutUrl, provider };
}

/**
 * Copies text to the clipboard. Falls back to a selection and execCommand where the async API is missing
 * or refused. Never throws.
 * @param {string} text
 * @param {HTMLElement|null} source  an element showing the same text, selected for the fallback
 * @returns {Promise<boolean>}
 */
async function copyText(text, source) {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'visually-hidden';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (ok) return true;
  } catch {
    // fall through
  }
  if (source) selectAll(source);
  return false;
}

/** @param {HTMLElement} el */
function selectAll(el) {
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  } catch {
    // nothing more to do
  }
}
