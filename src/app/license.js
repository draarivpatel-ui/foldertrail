// Licence-key check: the ONLY module in the app allowed to make a network request (decision B22,
// tools/check-no-network.js enforces it). It asks the payment provider whether a key is valid.
//
// THIS IS AN HONESTY GATE, NOT DRM. The whole app runs in the visitor's browser, so anyone can patch this check out.
// It exists to make paying the normal path and to tell honest buyers clearly what happened, not to stop a determined
// person. Do not add obfuscation, fingerprinting, phone-home or anything else "DRM-like" here.
//
// What is sent, and to whom: only the key the user typed and our PUBLIC organization or product id, to the provider
// chosen in src/config.js. Polar: POST https://api.polar.sh/v1/customer-portal/license-keys/validate with JSON
// {key, organization_id} (Polar documents this endpoint as needing no authentication and safe for public clients).
// Gumroad: POST https://api.gumroad.com/v2/licenses/verify with form fields product_id, license_key and
// increment_uses_count=false. No cookies, no referrer, no library data, nothing else. Checked against the providers'
// docs on 2026-10-06 (Polar OpenAPI 2026-04; Gumroad API docs and its open-source licenses controller).
//
// What is stored: a key that the provider accepted, in this browser's localStorage, so the buyer does not have to
// paste it again. Never the buyer's email or anything else the provider returns. Everything works without storage.
//
// No retry storms: the module never retries on its own. Identical checks in flight share one request, at most
// MAX_CHECKS_PER_WINDOW checks go out per minute, and after the provider answers 429 we wait before asking again.
// Every function here returns a result object; none of them throws.

import { CONFIG, isConfigured } from '../config.js';

export const POLAR_VALIDATE_URL = 'https://api.polar.sh/v1/customer-portal/license-keys/validate';
export const GUMROAD_VERIFY_URL = 'https://api.gumroad.com/v2/licenses/verify';
/** The only origins this module talks to: the origins of the two connect-src endpoints in site/_headers (test/headers.test.js). */
export const LICENSE_ORIGINS = Object.freeze(['https://api.polar.sh', 'https://api.gumroad.com']);
export const LICENSE_PROVIDERS = Object.freeze(['polar', 'gumroad']);

/** localStorage key for a validated licence (versioned so a later format can ignore old entries). */
export const STORAGE_KEY = 'foldertrail.license.v1';
/** sessionStorage key: set once the stored key has been re-checked in this browser session. */
export const SESSION_KEY = 'foldertrail.license.rechecked';

export const DEFAULT_TIMEOUT_MS = 15000;
/** Key length limits. Gumroad keys are 35 characters and Polar keys a prefix plus a 36-character UUID (their docs). */
export const MIN_KEY_LENGTH = 16;
export const MAX_KEY_LENGTH = 256;
/**
 * The characters a key may contain: Gumroad keys are hex digits and hyphens, Polar keys a letter prefix, "_" and a
 * UUID. Anything else (spaces, "@", ".", ",") means the user pasted something that is not a key, such as their
 * email address or a sentence, and that must never be sent to anyone.
 */
const KEY_SHAPE = /^[A-Za-z0-9_-]+$/;
/** Raw input longer than this is rejected before any processing (someone pasted a document). */
const MAX_RAW_LENGTH = 4096;
/** A provider answer larger than this (in bytes) is treated as a provider problem: never parsed, never read whole. */
const MAX_RESPONSE_CHARS = 256 * 1024;
export const MAX_CHECKS_PER_WINDOW = 5;
export const CHECK_WINDOW_MS = 60_000;
/** After the provider says "too many requests", wait this long before sending another check. */
export const RATE_LIMIT_COOLDOWN_MS = 60_000;

/**
 * @typedef {"not_configured"|"empty"|"malformed"|"invalid"|"refunded"|"offline"|"network"|"timeout"|"rate_limited"|"provider_error"} LicenseFailCode
 */

/**
 * @typedef {object} LicenseOk
 * @property {true} ok
 * @property {"valid"} code
 * @property {"polar"|"gumroad"} provider
 * @property {string} key          the normalised key (trimmed)
 * @property {string} message      plain words for the page
 * @property {boolean} stored      whether the key was saved in this browser
 * @property {boolean} [rechecked] restoreLicense only: false when the saved key was trusted without asking the provider
 */

/**
 * @typedef {object} LicenseFail
 * @property {false} ok
 * @property {LicenseFailCode} code
 * @property {string} message      plain words for the page; never contains the key
 * @property {boolean} retry       true when trying again later could help (network trouble), false when it cannot
 */

/** @typedef {LicenseOk|LicenseFail} LicenseResult */

/**
 * What is kept in localStorage: the key and which provider accepted it, nothing else (no time, no email, nothing the
 * provider returned). The privacy page promises exactly this. Older entries that also hold a time still load.
 * @typedef {object} StoredLicense
 * @property {"polar"|"gumroad"} provider
 * @property {string} key
 */

/**
 * Everything the checker touches from the outside world, injectable for tests. Defaults are the browser's own.
 * @typedef {object} LicenseDeps
 * @property {(input: string, init: object) => Promise<any>} [fetch]
 * @property {Partial<import('../config.js').Config>} [config]
 * @property {Storage|null} [storage]         localStorage stand-in; null = no storage
 * @property {Storage|null} [session]         sessionStorage stand-in; null = no storage
 * @property {() => number} [now]
 * @property {() => boolean} [online]         false = definitely offline (navigator.onLine === false)
 * @property {number} [timeoutMs]
 */

/** @param {string} brand */
function messages(brand) {
  const name = brand || 'this app';
  return {
    valid: `Thank you. ${name} is unlocked in this browser.`,
    not_configured: `${name} isn't on sale yet, so there is nothing to unlock. The free preview still works.`,
    empty: 'Paste your license key first.',
    malformed: "That doesn't look like a license key. Copy it again from your receipt email.",
    invalid: `That key isn't valid for ${name}. Check that you copied the whole key.`,
    refunded: `That purchase was refunded or disputed, so its key no longer unlocks ${name}.`,
    offline: 'Your computer seems to be offline. Connect to the internet and try again.',
    network: "Couldn't reach the payment provider — check your connection and try again.",
    timeout: "The payment provider didn't answer in time. Try again in a minute.",
    rate_limited: 'Too many tries in a short time. Wait a minute, then try again.',
    provider_error: "The payment provider couldn't check your key just now. Try again in a few minutes.",
  };
}

/** Codes where asking again later could give a different answer. */
const RETRYABLE = new Set(['offline', 'network', 'timeout', 'rate_limited', 'provider_error']);

/**
 * Turn whatever the user pasted into a key, or say why it cannot be one. Trims spaces and line breaks at the ends
 * (a key copied from an email often carries them) and drops invisible zero-width characters. Whitespace INSIDE is
 * refused rather than removed, and only key characters are accepted, so a pasted sentence or an email address is
 * never sent anywhere.
 * @param {unknown} raw
 * @returns {{ok: true, key: string} | {ok: false, code: "empty"|"malformed"}}
 */
export function normalizeKey(raw) {
  if (typeof raw !== 'string') return { ok: false, code: 'empty' };
  if (raw.length > MAX_RAW_LENGTH) return { ok: false, code: 'malformed' };
  const key = raw.replace(/[\u200b-\u200d\u2060\ufeff]/g, '').trim();
  if (key === '') return { ok: false, code: 'empty' };
  if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH || !KEY_SHAPE.test(key)) return { ok: false, code: 'malformed' };
  return { ok: true, key };
}

/**
 * The response body as text, read only up to `maxBytes`: an answer that says or turns out to be larger is cancelled
 * and gives null, so a huge or endless answer cannot fill the tab's memory. Falls back to text() when the response
 * has no readable stream.
 * @param {any} res
 * @param {number} maxBytes
 * @returns {Promise<string|null>}
 */
async function readCapped(res, maxBytes) {
  const declared = Number(res?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await res.body?.cancel?.();
    } catch {
      // nothing more to do
    }
    return null;
  }
  const reader = typeof res?.body?.getReader === 'function' ? res.body.getReader() : null;
  if (!reader) return typeof res?.text === 'function' ? res.text() : '';
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value?.byteLength ?? 0;
    if (bytes > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // nothing more to do
      }
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

/** @param {() => Storage|null|undefined} get */
function safeStorage(get) {
  try {
    return get() ?? null;
  } catch {
    return null; // Safari with site data blocked throws on the property access itself
  }
}

/**
 * Create an independent checker (its own in-flight map and rate limit). The module's exported functions use one
 * shared default checker; tests create their own.
 * @param {LicenseDeps} [defaults]
 */
export function createLicenseChecker(defaults = {}) {
  /** @type {Map<string, Promise<LicenseResult>>} */
  const inFlight = new Map();
  /** @type {number[]} */
  let recentChecks = [];
  let blockedUntil = 0;
  let sessionRecheckedFallback = false; // used when sessionStorage is unavailable

  /** @param {LicenseDeps} [opts] */
  function resolve(opts = {}) {
    const o = { ...defaults, ...opts };
    const config = o.config ?? CONFIG;
    return {
      config,
      text: messages(typeof config.brand === 'string' ? config.brand : ''),
      fetchImpl: o.fetch ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null),
      storage: 'storage' in o ? o.storage ?? null : safeStorage(() => globalThis.localStorage),
      session: 'session' in o ? o.session ?? null : safeStorage(() => globalThis.sessionStorage),
      now: o.now ?? (() => Date.now()),
      online:
        o.online ??
        (() => {
          try {
            return !(typeof navigator !== 'undefined' && navigator && navigator.onLine === false);
          } catch {
            return true;
          }
        }),
      timeoutMs: Number.isFinite(o.timeoutMs) && /** @type {number} */ (o.timeoutMs) > 0 ? /** @type {number} */ (o.timeoutMs) : DEFAULT_TIMEOUT_MS,
    };
  }

  /**
   * @param {ReturnType<typeof resolve>} env
   * @param {LicenseFailCode} code
   * @returns {LicenseFail}
   */
  function fail(env, code) {
    return { ok: false, code, message: env.text[code], retry: RETRYABLE.has(code) };
  }

  /**
   * Read the saved licence, or null. Hostile or stale contents are ignored, never trusted.
   * @param {LicenseDeps} [opts]
   * @returns {StoredLicense|null}
   */
  function recall(opts) {
    const env = resolve(opts);
    if (!env.storage) return null;
    try {
      const raw = env.storage.getItem(STORAGE_KEY);
      if (typeof raw !== 'string' || raw.length > 2048) return null;
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || data.v !== 1) return null;
      if (!LICENSE_PROVIDERS.includes(data.provider)) return null;
      const norm = normalizeKey(data.key);
      if (!norm.ok || norm.key !== data.key) return null;
      return { provider: data.provider, key: data.key };
    } catch {
      return null;
    }
  }

  /**
   * Save a validated key. Returns false when the browser will not store it (private mode, blocked site data).
   * @param {ReturnType<typeof resolve>} env
   * @param {"polar"|"gumroad"} provider
   * @param {string} key
   */
  function remember(env, provider, key) {
    if (!env.storage) return false;
    try {
      env.storage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, provider, key }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Remove the saved licence from this browser.
   * @param {LicenseDeps} [opts]
   */
  function forget(opts) {
    const env = resolve(opts);
    try {
      env.storage?.removeItem(STORAGE_KEY);
    } catch {
      // nothing to do: storage is unavailable
    }
    try {
      env.session?.removeItem(SESSION_KEY);
    } catch {
      // nothing to do
    }
    sessionRecheckedFallback = false;
  }

  /** @param {ReturnType<typeof resolve>} env */
  function markRechecked(env) {
    sessionRecheckedFallback = true;
    try {
      env.session?.setItem(SESSION_KEY, '1');
    } catch {
      // the in-memory flag above still covers this page
    }
  }

  /** @param {ReturnType<typeof resolve>} env */
  function wasRechecked(env) {
    if (sessionRecheckedFallback) return true;
    try {
      return env.session?.getItem(SESSION_KEY) === '1';
    } catch {
      return false;
    }
  }

  /**
   * Local brake: no more than MAX_CHECKS_PER_WINDOW checks a minute, and a pause after the provider's 429.
   * @param {ReturnType<typeof resolve>} env
   */
  function throttled(env) {
    const t = env.now();
    if (t < blockedUntil) return true;
    // A clock that went backward must not lock the user out: drop any timestamp in the "future".
    recentChecks = recentChecks.filter((s) => s <= t && t - s < CHECK_WINDOW_MS);
    return recentChecks.length >= MAX_CHECKS_PER_WINDOW;
  }

  /**
   * One request to the provider with a hard time limit. Resolves to {status, body} or to a failure code.
   * @param {ReturnType<typeof resolve>} env
   * @param {string} url
   * @param {object} init
   * @returns {Promise<{status: number, body: unknown} | {code: LicenseFailCode}>}
   */
  async function post(env, url, init) {
    if (!env.fetchImpl) return { code: 'network' };
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timer;
    const timeout = new Promise((resolveTimeout) => {
      timer = setTimeout(() => {
        try {
          controller?.abort();
        } catch {
          // ignore
        }
        resolveTimeout({ code: /** @type {LicenseFailCode} */ ('timeout') });
      }, env.timeoutMs);
    });
    const request = (async () => {
      try {
        const res = await env.fetchImpl(url, {
          ...init,
          // After the caller's options, so nothing can turn these off: no cookies, no referrer, no redirect.
          method: 'POST',
          mode: 'cors',
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          ...(controller ? { signal: controller.signal } : {}),
        });
        const status = res && Number.isInteger(res.status) ? res.status : 0;
        let body = null;
        try {
          const text = await readCapped(res, MAX_RESPONSE_CHARS);
          if (typeof text === 'string' && text.length > 0 && text.length <= MAX_RESPONSE_CHARS) body = JSON.parse(text);
        } catch {
          body = null; // not JSON: judged by status below
        }
        return { status, body };
      } catch (err) {
        if (controller?.signal.aborted) return { code: /** @type {LicenseFailCode} */ ('timeout') };
        void err; // a TypeError here means no answer: offline, DNS, CORS or the CSP blocked it
        return { code: /** @type {LicenseFailCode} */ ('network') };
      }
    })();
    try {
      return /** @type {any} */ (await Promise.race([request, timeout]));
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @param {ReturnType<typeof resolve>} env
   * @param {string} key
   * @returns {Promise<LicenseFailCode|"valid">}
   */
  async function checkPolar(env, key) {
    const organizationId = String(env.config.polarOrganizationId ?? '').trim();
    const out = await post(env, POLAR_VALIDATE_URL, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ key, organization_id: organizationId }),
    });
    if ('code' in out) return out.code;
    const { status, body } = out;
    if (status === 200) {
      if (!body || typeof body !== 'object') return 'provider_error';
      const data = /** @type {Record<string, unknown>} */ (body);
      // Polar answers 200 only for a granted key; revoked, disabled or expired keys come back as 404.
      // These checks are belt and braces, plus the cross-organization guard Polar asks for.
      if (data.status !== 'granted') return 'invalid';
      if (typeof data.organization_id !== 'string' || data.organization_id.toLowerCase() !== organizationId.toLowerCase()) {
        return 'invalid';
      }
      if (data.expires_at != null) {
        const expires = Date.parse(String(data.expires_at));
        if (Number.isFinite(expires) && expires <= env.now()) return 'invalid';
      }
      return 'valid';
    }
    if (status === 404 || status === 400 || status === 422) return 'invalid';
    if (status === 429) return 'rate_limited';
    return 'provider_error';
  }

  /**
   * @param {ReturnType<typeof resolve>} env
   * @param {string} key
   * @returns {Promise<LicenseFailCode|"valid">}
   */
  async function checkGumroad(env, key) {
    const productId = String(env.config.gumroadProductId ?? '').trim();
    // A form body keeps this a CORS "simple" request; Gumroad's documented example posts form fields.
    const form = new URLSearchParams();
    form.set('product_id', productId);
    form.set('license_key', key);
    form.set('increment_uses_count', 'false');
    const out = await post(env, GUMROAD_VERIFY_URL, {
      headers: { Accept: 'application/json' },
      body: form,
    });
    if ('code' in out) return out.code;
    const { status, body } = out;
    if (status === 200) {
      if (!body || typeof body !== 'object') return 'provider_error';
      const data = /** @type {Record<string, any>} */ (body);
      if (data.success !== true) return 'invalid';
      const purchase = data.purchase && typeof data.purchase === 'object' ? data.purchase : null;
      if (purchase) {
        if (typeof purchase.product_id === 'string' && purchase.product_id !== productId) return 'invalid';
        // Gumroad still says success for a refunded purchase; the flags are in the purchase object.
        if (purchase.refunded === true || purchase.chargebacked === true || purchase.disputed === true) return 'refunded';
      }
      // Subscription fields are ignored: the product is a one-time purchase.
      return 'valid';
    }
    if (status === 404) return 'invalid';
    if (status === 429) return 'rate_limited';
    return 'provider_error';
  }

  /**
   * Ask the provider whether `rawKey` is a valid licence for this product. Saves it in this browser when it is.
   * Never throws; never retries on its own.
   * @param {unknown} rawKey
   * @param {LicenseDeps} [opts]
   * @returns {Promise<LicenseResult>}
   */
  async function verify(rawKey, opts) {
    let env;
    try {
      env = resolve(opts);
    } catch {
      return { ok: false, code: 'provider_error', message: messages('')['provider_error'], retry: true };
    }
    try {
      if (!isConfigured(env.config)) return fail(env, 'not_configured');
      const provider = /** @type {"polar"|"gumroad"} */ (env.config.licenseProvider);
      const norm = normalizeKey(rawKey);
      if (!norm.ok) return fail(env, norm.code);
      const key = norm.key;
      const flightKey = `${provider}\n${key}`;
      const pending = inFlight.get(flightKey);
      if (pending) return pending;
      if (!env.online()) return fail(env, 'offline');
      if (throttled(env)) return fail(env, 'rate_limited');
      recentChecks.push(env.now());
      const run = (async () => {
        const verdict = provider === 'polar' ? await checkPolar(env, key) : await checkGumroad(env, key);
        if (verdict === 'rate_limited') blockedUntil = env.now() + RATE_LIMIT_COOLDOWN_MS;
        if (verdict !== 'valid') return fail(env, verdict);
        const stored = remember(env, provider, key);
        markRechecked(env);
        /** @type {LicenseOk} */
        const ok = { ok: true, code: 'valid', provider, key, message: env.text.valid, stored };
        return ok;
      })();
      const guarded = run.catch(() => fail(env, 'provider_error')).finally(() => inFlight.delete(flightKey));
      inFlight.set(flightKey, guarded);
      return guarded;
    } catch {
      return fail(env, 'provider_error');
    }
  }

  /**
   * On page load: is there a saved licence, and is it still good? Re-checks with the provider at most once per
   * browser session. A key the provider now rejects is forgotten. If the provider cannot be reached, the saved key is
   * trusted (it was valid before), so a buyer is never locked out by a network problem.
   * Returns null when there is nothing saved or the app is not on sale. Never throws.
   * @param {LicenseDeps} [opts]
   * @returns {Promise<LicenseResult|null>}
   */
  async function restore(opts) {
    try {
      const env = resolve(opts);
      if (!isConfigured(env.config)) return null;
      const saved = recall(opts);
      if (!saved) return null;
      /** @returns {LicenseOk} */
      const trusted = () => ({
        ok: true,
        code: 'valid',
        provider: saved.provider,
        key: saved.key,
        message: env.text.valid,
        stored: true,
        rechecked: false,
      });
      // Bought through a provider the site no longer uses: it was valid then, and the new provider cannot know it.
      if (saved.provider !== env.config.licenseProvider) return trusted();
      if (wasRechecked(env)) return trusted();
      const result = await verify(saved.key, opts);
      if (result.ok) return { ...result, rechecked: true };
      if (result.code === 'invalid' || result.code === 'refunded') {
        forget(opts);
        return result;
      }
      return trusted();
    } catch {
      return null;
    }
  }

  return { verify, restore, recall, forget };
}

const defaultChecker = createLicenseChecker();

/**
 * Ask the payment provider whether a licence key is valid for this product (see the top of this file).
 * @param {unknown} key
 * @param {LicenseDeps} [options]
 * @returns {Promise<LicenseResult>}
 */
export function verifyLicense(key, options) {
  return defaultChecker.verify(key, options);
}

/**
 * Check the licence saved in this browser, at most once per session. null = nothing saved / not on sale.
 * @param {LicenseDeps} [options]
 * @returns {Promise<LicenseResult|null>}
 */
export function restoreLicense(options) {
  return defaultChecker.restore(options);
}

/**
 * The licence saved in this browser, without asking anyone. null when there is none.
 * @param {LicenseDeps} [options]
 * @returns {StoredLicense|null}
 */
export function recallLicense(options) {
  return defaultChecker.recall(options);
}

/**
 * Remove the saved licence from this browser (a "Remove key" button).
 * @param {LicenseDeps} [options]
 */
export function forgetLicense(options) {
  defaultChecker.forget(options);
}

// Thin wrappers with the names the UI (src/app/ui.js) looks for. verifyLicense already saves a key the provider
// accepted, so storeLicense is only needed by callers that do their own bookkeeping.

/**
 * The saved key as plain text, or null.
 * @param {LicenseDeps} [options]
 * @returns {string|null}
 */
export function getStoredLicense(options) {
  return defaultChecker.recall(options)?.key ?? null;
}

/**
 * Save a key for the current provider. Call it only with a key verifyLicense has just accepted.
 * Returns false when the key is malformed or the browser will not store it. Never throws.
 * @param {unknown} key
 * @param {LicenseDeps} [options]
 * @returns {boolean}
 */
export function storeLicense(key, options) {
  try {
    const norm = normalizeKey(key);
    const o = options ?? {};
    const config = o.config ?? CONFIG;
    const provider = config.licenseProvider;
    if (!norm.ok || !LICENSE_PROVIDERS.includes(/** @type {string} */ (provider))) return false;
    const storage = 'storage' in o ? o.storage ?? null : safeStorage(() => globalThis.localStorage);
    if (!storage) return false;
    storage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, provider, key: norm.key }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Same as forgetLicense.
 * @param {LicenseDeps} [options]
 */
export function clearLicense(options) {
  defaultChecker.forget(options);
}
