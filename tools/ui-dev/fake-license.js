// Development only: a licence module with the real API and no network. It accepts the synthetic key
// FT-TEST-0000 and refuses anything else, after a short pause. An accepted key is kept in sessionStorage (this tab
// only), so reloading the converter exercises the saved-key restore path (ui.js restoreLicence) as license.js would.
const STORE = 'foldertrail.dev-license';
const TEST_KEY = 'FT-TEST-0000';

/** @returns {string|null} */
function load() {
  try {
    return globalThis.sessionStorage?.getItem(STORE) ?? null;
  } catch {
    return null;
  }
}

let stored = load();

/** @param {number} ms */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function verifyLicense(key) {
  await pause(500);
  if (String(key).trim() === TEST_KEY) {
    storeLicense(TEST_KEY);
    return { ok: true, code: 'valid', reason: 'valid', message: 'Thank you. Foldertrail is unlocked in this browser.', stored: true };
  }
  return {
    ok: false,
    code: 'invalid',
    reason: 'invalid',
    message: "That key isn't valid for Foldertrail. Check that you copied the whole key.",
  };
}

/** Like license.js: null when no key is saved; otherwise the saved key, re-checked. */
export async function restoreLicense() {
  if (stored === null) return null;
  await pause(300);
  if (stored === TEST_KEY) return { ok: true, code: 'valid', message: 'Unlocked with your saved license key.' };
  clearLicense();
  return { ok: false, code: 'invalid', message: "The saved key isn't valid for Foldertrail." };
}

export function getStoredLicense() {
  return stored;
}

export function storeLicense(key) {
  stored = String(key);
  try {
    globalThis.sessionStorage?.setItem(STORE, stored);
  } catch {
    // blocked storage: the key still works for this page
  }
}

export function clearLicense() {
  stored = null;
  try {
    globalThis.sessionStorage?.removeItem(STORE);
  } catch {
    // nothing to remove
  }
}
