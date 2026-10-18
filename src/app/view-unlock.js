// The download panel: the price and the licence key when Foldertrail is on sale, or a plain "not on sale
// yet" when it is not; the options; the Download button and its progress.
// The licence check is an honesty gate, not DRM: the page only asks the worker for the ZIP after it passed.

import { PHASE_TEXT, unlockPrivacyNote } from './ui.js';
import { setAttr, setText, show } from './view-dom.js';

/** @typedef {import('./ui.js').State} State */

/**
 * @typedef {object} SaleInfo
 * @property {boolean} onSale
 * @property {string} price         e.g. "$19"
 * @property {string} checkoutUrl   an https: URL (only used when onSale)
 * @property {string} provider      "Polar" or "Gumroad"
 */

/**
 * @param {Record<string, HTMLElement>} els  buyStep, keyLabel, keyRow, savedText and downloadHint are optional
 * @param {SaleInfo} sale
 * @param {{verify: (key: string) => void, forget: () => void, setOptions: (o: {kml?: boolean, perItem?: boolean}) => void,
 *   download: () => void, cancel: () => void}} actions
 */
export function createUnlock(els, sale, actions) {
  const keyInput = /** @type {HTMLInputElement} */ (els.keyInput);
  const unlockBtn = /** @type {HTMLButtonElement} */ (els.unlockBtn);
  const downloadBtn = /** @type {HTMLButtonElement} */ (els.downloadBtn);
  const options = /** @type {HTMLFieldSetElement} */ (els.options);
  const optKml = /** @type {HTMLInputElement} */ (els.optKml);
  const optPerItem = /** @type {HTMLInputElement} */ (els.optPerItem);
  const bar = els.exportBar;
  const fill = /** @type {HTMLElement} */ (bar.querySelector('.progress-fill'));
  const cancelExport = /** @type {HTMLButtonElement} */ (els.cancelExport);
  /** Set by "Remove it": the key field is hidden until the next draw, so it is focused then. */
  let focusKeyNext = false;
  /** @type {{status: string, exporting: boolean}|null} */
  let last = null;

  show(els.presale, !sale.onSale);
  show(els.steps, sale.onSale);
  show(els.price, sale.onSale);
  if (sale.onSale) {
    setText(els.price, sale.price);
    /** @type {HTMLAnchorElement} */ (els.buyLink).href = sale.checkoutUrl;
    setText(els.buyNote, `Opens ${sale.provider}’s checkout page in a new tab.`);
    setText(els.privacy, unlockPrivacyNote(sale.provider));
  }

  els.keyForm.addEventListener('submit', (event) => {
    event.preventDefault();
    // The button stays focusable while a key is checked or the ZIP is made (aria-disabled), so a press does nothing then.
    if (unlockBtn.getAttribute('aria-disabled') === 'true') return;
    actions.verify(keyInput.value);
  });
  keyInput.addEventListener('input', () => {
    if (keyInput.getAttribute('aria-invalid') === 'true') keyInput.removeAttribute('aria-invalid');
  });
  els.forget.addEventListener('click', () => {
    keyInput.value = '';
    focusKeyNext = true;
    actions.forget();
  });
  optKml.addEventListener('change', () => actions.setOptions({ kml: optKml.checked }));
  optPerItem.addEventListener('change', () => actions.setOptions({ perItem: optPerItem.checked }));
  downloadBtn.addEventListener('click', () => actions.download());
  els.cancelExport.addEventListener('click', () => actions.cancel());

  /** @param {State} state */
  function update(state) {
    const licence = state.licence;
    const exporting = state.busy === 'export';
    const checking = licence.status === 'checking';
    const unlocked = licence.status === 'valid';
    // Where keyboard focus was before this draw: controls that are about to be hidden must hand it on.
    const active = /** @type {Element|null} */ (document.activeElement ?? null);
    const focusLost = !active || active === document.body;

    // Licence key
    if (sale.onSale) {
      // Read-only, not disabled, while a key is checked: disabling the focused field would drop keyboard focus.
      keyInput.readOnly = checking || exporting;
      setAttr(unlockBtn, 'aria-disabled', checking || exporting ? 'true' : null);
      setText(unlockBtn, checking ? 'Checking…' : 'Unlock');
      const msg = els.message;
      let words = licence.message;
      if (checking) words = `Checking your license key with ${sale.provider}…`;
      else if (licence.status === 'stored' && !words) words = 'The saved license key will be checked when you download.';
      setText(msg, words);
      msg.classList.toggle('is-bad', licence.status === 'invalid');
      msg.classList.toggle('is-good', unlocked);
      if (licence.status === 'invalid') keyInput.setAttribute('aria-invalid', 'true');
      else keyInput.removeAttribute('aria-invalid');
      show(els.saved, licence.hasStored && licence.status !== 'checking');
      // Once unlocked, buying and pasting are done: only the confirmation and "Remove it" stay.
      show(els.buyStep ?? null, !unlocked);
      show(els.keyLabel ?? null, !unlocked);
      show(els.keyRow ?? null, !unlocked);
      els.steps.classList.toggle('is-unlocked', unlocked);
      if (els.savedText) {
        setText(els.savedText, unlocked ? 'Your key is kept in this browser, so you don’t have to paste it again.' : 'A license key is saved in this browser.');
      }
    }

    // Options and the button
    const canDownload =
      sale.onSale && !exporting && !checking && (licence.status === 'valid' || licence.status === 'stored');
    options.disabled = !sale.onSale || exporting;
    if (optKml.checked !== state.options.kml) optKml.checked = state.options.kml;
    if (optPerItem.checked !== state.options.perItem) optPerItem.checked = state.options.perItem;
    downloadBtn.disabled = !canDownload;
    show(downloadBtn, !exporting);
    if (els.downloadHint) {
      // A greyed-out button alone does not say what turns it on.
      const hint = sale.onSale && !exporting && !canDownload && !checking ? 'Unlock with your license key above to download.' : '';
      setText(els.downloadHint, hint);
      show(els.downloadHint, hint !== '');
    }

    // Progress while the ZIP is made
    show(els.exportProgress, exporting);
    if (exporting) {
      setText(els.exportPhase, PHASE_TEXT[/** @type {keyof typeof PHASE_TEXT} */ (state.phase)] ?? PHASE_TEXT.exporting);
      setBar(bar, fill, state.done, state.total);
    }

    show(els.exportError, Boolean(state.exportError));
    setText(els.exportErrorText, state.exportError ?? '');

    // Keyboard focus: never left on a control that was just hidden.
    if (last) {
      const inKeyForm = active ? els.keyForm.contains(active) : false;
      if (unlocked && !exporting && last.status === 'checking' && (focusLost || inKeyForm) && !downloadBtn.disabled) downloadBtn.focus();
      if (exporting && !last.exporting && (focusLost || active === downloadBtn)) cancelExport.focus();
      if (!exporting && last.exporting && state.view === 'preview' && (focusLost || active === cancelExport)) downloadBtn.focus();
    }
    if (focusKeyNext && !unlocked) {
      focusKeyNext = false;
      keyInput.focus();
    }
    last = { status: licence.status, exporting };
  }

  return { update };
}

/**
 * Draws a progress bar: a fraction when the total is known, a wandering bar when it is not.
 * @param {HTMLElement} bar
 * @param {HTMLElement} fill
 * @param {number} done
 * @param {number|null} total
 */
export function setBar(bar, fill, done, total) {
  const known = typeof total === 'number' && total > 0;
  bar.classList.toggle('is-indeterminate', !known);
  if (known) {
    const fraction = Math.max(0, Math.min(1, done / /** @type {number} */ (total)));
    fill.style.transform = `scaleX(${fraction.toFixed(4)})`;
    bar.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
  } else {
    fill.style.transform = '';
    bar.removeAttribute('aria-valuenow');
  }
}
