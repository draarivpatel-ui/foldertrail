// Tests for src/config.js and src/app/license.js. No network: every request goes to a fake fetch, and a trap
// replaces globalThis.fetch BEFORE the module is imported, so an accidental real request fails instead of
// reaching the internet (and importing the module is shown to send nothing). All keys and ids are made up.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const trapCalls = [];
globalThis.fetch = async (input) => {
  trapCalls.push(String(input));
  throw new TypeError('network is disabled in tests');
};

const { CONFIG, isConfigured } = await import('../src/config.js');
const lic = await import('../src/app/license.js');
const {
  createLicenseChecker,
  verifyLicense,
  normalizeKey,
  POLAR_VALIDATE_URL,
  GUMROAD_VERIFY_URL,
  LICENSE_ORIGINS,
  STORAGE_KEY,
  SESSION_KEY,
  MAX_CHECKS_PER_WINDOW,
  CHECK_WINDOW_MS,
} = lic;
const importTimeCalls = trapCalls.length;

const ORG = '00000000-0000-4000-8000-00000000f01d';
const PRODUCT = 'TestProd-AbC_123==';
const KEY = 'FOLDERTRAIL-TEST-1111-2222-3333';
const POLAR = Object.freeze({ ...CONFIG, checkoutUrl: 'https://checkout.example.test/foldertrail', licenseProvider: 'polar', polarOrganizationId: ORG });
const GUMROAD = Object.freeze({ ...CONFIG, checkoutUrl: 'https://checkout.example.test/l/ft', licenseProvider: 'gumroad', gumroadProductId: PRODUCT });
const INVALID_MSG = "That key isn't valid for Foldertrail. Check that you copied the whole key.";
const NETWORK_MSG = "Couldn't reach the payment provider — check your connection and try again.";

/** Every URL any fake fetch was asked for, across all tests. */
const allRequestedUrls = [];

class MemStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}
class BrokenStorage {
  getItem() { throw new Error('SecurityError'); }
  setItem() { throw new Error('QuotaExceededError'); }
  removeItem() { throw new Error('SecurityError'); }
}

/** A response the way fetch returns one: a status and a text() body. */
const reply = (status, body) => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

/**
 * A fake fetch. `responder` gets (url, init, callIndex) and returns a response, throws, or returns a promise.
 * @param {(url: string, init: any, i: number) => any} responder
 */
function fakeFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    allRequestedUrls.push(String(url));
    return responder(String(url), init, calls.length - 1);
  };
  fn.calls = calls;
  return fn;
}

const polarGranted = (over = {}) => ({
  id: '00000000-0000-4000-8000-0000000000a1',
  created_at: '2026-01-01T00:00:00Z',
  modified_at: null,
  organization_id: ORG,
  customer_id: '00000000-0000-4000-8000-0000000000c1',
  customer: { email: 'buyer@example.test', name: 'Test Buyer' },
  benefit_id: '00000000-0000-4000-8000-0000000000b1',
  key: KEY,
  display_key: '****-3333',
  status: 'granted',
  limit_activations: null,
  usage: 0,
  limit_usage: null,
  validations: 1,
  last_validated_at: null,
  expires_at: null,
  activation: null,
  ...over,
});

const gumroadOk = (purchase = {}) => ({
  success: true,
  uses: 0,
  purchase: {
    seller_id: 'seller-test', product_id: PRODUCT, product_name: 'Foldertrail', email: 'buyer@example.test', price: 1900,
    currency: 'usd', license_key: KEY, refunded: false, disputed: false, chargebacked: false,
    subscription_cancelled_at: null, subscription_ended_at: null, subscription_failed_at: null, ...purchase,
  },
});

/** A fresh checker with in-memory storage and a fixed clock. */
function setup(config, responder, extra = {}) {
  const fetch = fakeFetch(responder);
  const storage = new MemStorage();
  const session = new MemStorage();
  let t = 1_790_000_000_000;
  const deps = { config, fetch, storage, session, now: () => t, online: () => true, timeoutMs: 1000, ...extra };
  const checker = createLicenseChecker(deps);
  return { checker, fetch, storage, session, deps, tick: (ms) => { t += ms; }, setNow: (v) => { t = v; }, now: () => t };
}

// ---------------------------------------------------------------------------------------------------------------
// config.js

test('CONFIG has exactly the shared shape, is frozen, and is not configured while placeholders are empty', () => {
  assert.deepEqual(Object.keys(CONFIG).sort(), ['brand', 'checkoutUrl', 'gumroadProductId', 'licenseProvider', 'polarOrganizationId',
    'priceDisplay', 'supportEmail', 'tagline', 'version'].sort());
  assert.equal(CONFIG.brand, 'Foldertrail');
  assert.equal(CONFIG.priceDisplay, '$19');
  assert.equal(CONFIG.version, '0.1.0');
  assert.ok(['polar', 'gumroad'].includes(CONFIG.licenseProvider));
  assert.equal(typeof CONFIG.tagline, 'string');
  assert.ok(CONFIG.tagline.length > 0 && CONFIG.tagline.length < 120);
  assert.ok(!/garmin|basecamp/i.test(CONFIG.brand), 'the brand never contains Garmin or BaseCamp (B29)');
  assert.ok(Object.isFrozen(CONFIG));
  assert.equal(isConfigured(), false);
  assert.equal(isConfigured(CONFIG), false);
});

test('isConfigured needs an https checkout link and a well-formed id for the chosen provider', () => {
  assert.equal(isConfigured(POLAR), true);
  assert.equal(isConfigured(GUMROAD), true);
  assert.equal(isConfigured({ ...POLAR, checkoutUrl: '' }), false);
  assert.equal(isConfigured({ ...POLAR, checkoutUrl: 'http://checkout.example.test/x' }), false, 'plain http');
  assert.equal(isConfigured({ ...POLAR, checkoutUrl: 'not a url' }), false);
  assert.equal(isConfigured({ ...POLAR, checkoutUrl: 'javascript:alert(1)' }), false);
  assert.equal(isConfigured({ ...POLAR, polarOrganizationId: '' }), false);
  assert.equal(isConfigured({ ...POLAR, polarOrganizationId: 'my-org-slug' }), false, 'Polar wants the UUID, not the slug');
  assert.equal(isConfigured({ ...POLAR, polarOrganizationId: ` ${ORG.toUpperCase()} ` }), true);
  assert.equal(isConfigured({ ...GUMROAD, gumroadProductId: '' }), false);
  assert.equal(isConfigured({ ...GUMROAD, gumroadProductId: 'has space' }), false);
  assert.equal(isConfigured({ ...POLAR, licenseProvider: 'lemonsqueezy' }), false);
  assert.equal(isConfigured({ ...GUMROAD, licenseProvider: 'polar' }), false, 'the id must belong to the chosen provider');
  assert.equal(isConfigured(null), false);
  assert.equal(isConfigured(/** @type {any} */ ('x')), false);
  const hostile = { get checkoutUrl() { throw new Error('boom'); } };
  assert.equal(isConfigured(/** @type {any} */ (hostile)), false, 'never throws');
});

// ---------------------------------------------------------------------------------------------------------------
// license.js basics

test('importing the module sends nothing, and it only knows the two provider origins', () => {
  assert.equal(importTimeCalls, 0);
  assert.deepEqual([...LICENSE_ORIGINS], ['https://api.polar.sh', 'https://api.gumroad.com']);
  assert.equal(new URL(POLAR_VALIDATE_URL).origin, 'https://api.polar.sh');
  assert.equal(new URL(POLAR_VALIDATE_URL).pathname, '/v1/customer-portal/license-keys/validate');
  assert.equal(new URL(GUMROAD_VERIFY_URL).origin, 'https://api.gumroad.com');
  assert.equal(new URL(GUMROAD_VERIFY_URL).pathname, '/v2/licenses/verify');
});

test('normalizeKey trims the ends and refuses anything that cannot be a key', () => {
  assert.deepEqual(normalizeKey(`  ${KEY}\n`), { ok: true, key: KEY });
  assert.deepEqual(normalizeKey(`\u200b${KEY}\ufeff\r\n`), { ok: true, key: KEY });
  assert.equal(normalizeKey('85DB562A-C11D4B06-A2335A6B-8C079166').ok, true, 'the shape of a Gumroad key');
  assert.equal(normalizeKey('FOLDERTRAIL_00000000-0000-4000-8000-000000000000').ok, true, 'the shape of a Polar key');
  for (const v of ['', '   \n\t', '\u200b', undefined, null, 42, {}, ['k']]) {
    assert.deepEqual(normalizeKey(v), { ok: false, code: 'empty' }, String(v));
  }
  const notKeys = [
    'ключ-1234-5678-9012-3456', 'key\u0000xxxxxxxxxxxxxxxxx', 'a'.repeat(257), 'x'.repeat(5_000_000),
    'short-key', 'buyer@example.test', 'buyer.name@example-mail.test', 'ABCD-1234-EFGH\n5678-IJKL-9012',
    'ABCD 1234 EFGH 5678 IJKL', 'Dear support, my name is Test Buyer', 'https://checkout.example.test/x',
  ];
  for (const v of notKeys) assert.equal(normalizeKey(v).code, 'malformed', v.slice(0, 30));
  assert.equal(normalizeKey('a'.repeat(256)).ok, true);
  assert.equal(normalizeKey('a'.repeat(16)).ok, true);
  assert.equal(normalizeKey('a'.repeat(15)).code, 'malformed');
});

test('not on sale yet: no request, a plain message, and nothing stored', async () => {
  const s = setup(CONFIG, () => reply(200, polarGranted()));
  const r = await s.checker.verify(KEY);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_configured');
  assert.equal(r.retry, false);
  assert.match(r.message, /^Foldertrail isn't on sale yet/);
  assert.equal(s.fetch.calls.length, 0);
  assert.equal(s.storage.map.size, 0);
});

test('an empty or malformed key is refused before any request', async () => {
  const s = setup(POLAR, () => reply(200, polarGranted()));
  assert.equal((await s.checker.verify('   ')).code, 'empty');
  assert.equal((await s.checker.verify('Dear support, my name is Test Buyer and I live at 1 Example Road')).code, 'malformed');
  assert.equal((await s.checker.verify('buyer@example.test')).code, 'malformed', 'an email address is never sent');
  assert.equal((await s.checker.verify('y'.repeat(1_000_000))).code, 'malformed');
  assert.equal(s.fetch.calls.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// Polar

test('Polar: a granted key unlocks; only the key and the organization id are sent, without cookies or referrer', async () => {
  const s = setup(POLAR, () => reply(200, polarGranted()));
  const r = await s.checker.verify(`  ${KEY} \n`);
  assert.equal(r.ok, true);
  assert.equal(r.code, 'valid');
  assert.equal(r.provider, 'polar');
  assert.equal(r.key, KEY);
  assert.equal(r.stored, true);
  assert.equal(s.fetch.calls.length, 1);
  const { url, init } = s.fetch.calls[0];
  assert.equal(url, POLAR_VALIDATE_URL);
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.equal(init.redirect, 'error');
  assert.equal(init.cache, 'no-store');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.ok(init.signal, 'the request can be aborted');
  assert.deepEqual(JSON.parse(init.body), { key: KEY, organization_id: ORG });
  // Stored: the key and which provider checked it, never the email, a time or anything else Polar returned
  // (the privacy page says the key is the only thing kept; security audit 2026-10-06).
  const saved = JSON.parse(s.storage.getItem(STORAGE_KEY));
  assert.deepEqual(saved, { v: 1, provider: 'polar', key: KEY });
  assert.ok(![...s.storage.map.values()].join('').includes('example.test'));
});

test('Polar: 404 (unknown, revoked, disabled or expired key) says the key is not valid and stores nothing', async () => {
  const s = setup(POLAR, () => reply(404, { error: 'ResourceNotFound', detail: 'License key not found' }));
  const r = await s.checker.verify(KEY);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'invalid');
  assert.equal(r.message, INVALID_MSG);
  assert.equal(r.retry, false);
  assert.ok(!r.message.includes(KEY), 'the key is never echoed');
  assert.equal(s.storage.map.size, 0);
});

test('Polar: a 200 that is not a granted key for OUR organization is refused', async () => {
  const cases = [
    [polarGranted({ organization_id: '00000000-0000-4000-8000-0000000000ff' }), 'invalid'],
    [polarGranted({ organization_id: undefined }), 'invalid'],
    [polarGranted({ status: 'revoked' }), 'invalid'],
    [polarGranted({ status: 'disabled' }), 'invalid'],
    [polarGranted({ expires_at: '2020-01-01T00:00:00Z' }), 'invalid'],
    [polarGranted({ expires_at: '2099-01-01T00:00:00Z' }), 'valid'],
    [polarGranted({ expires_at: 'not a date' }), 'valid'],
    ['<html>gateway</html>', 'provider_error'],
    ['', 'provider_error'],
    ['null', 'provider_error'],
    ['x'.repeat(300 * 1024), 'provider_error'],
  ];
  for (const [body, want] of cases) {
    const s = setup(POLAR, () => reply(200, body));
    const r = await s.checker.verify(KEY);
    assert.equal(r.code, want, typeof body === 'string' ? body.slice(0, 30) : JSON.stringify(body).slice(0, 120));
  }
});

test('Polar: an organization id typed in capitals still matches', async () => {
  const s = setup({ ...POLAR, polarOrganizationId: ORG.toUpperCase() }, () => reply(200, polarGranted()));
  assert.equal((await s.checker.verify(KEY)).ok, true);
  assert.equal(JSON.parse(s.fetch.calls[0].init.body).organization_id, ORG.toUpperCase());
});

test('Polar: HTTP statuses map to plain outcomes', async () => {
  const cases = [[400, 'invalid'], [422, 'invalid'], [401, 'provider_error'], [403, 'provider_error'], [500, 'provider_error'],
    [502, 'provider_error'], [503, 'provider_error'], [429, 'rate_limited'], [302, 'provider_error']];
  for (const [status, want] of cases) {
    const s = setup(POLAR, () => reply(status, { detail: 'x' }));
    const r = await s.checker.verify(KEY);
    assert.equal(r.code, want, `HTTP ${status}`);
    assert.equal(r.retry, want !== 'invalid', `retry for HTTP ${status}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Gumroad

test('Gumroad: a valid key unlocks; a form body with product_id, license_key and increment_uses_count=false', async () => {
  const s = setup(GUMROAD, () => reply(200, gumroadOk()));
  const r = await s.checker.verify(KEY);
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'gumroad');
  const { url, init } = s.fetch.calls[0];
  assert.equal(url, GUMROAD_VERIFY_URL);
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'omit');
  assert.ok(init.body instanceof URLSearchParams);
  assert.deepEqual([...init.body.entries()], [['product_id', PRODUCT], ['license_key', KEY], ['increment_uses_count', 'false']]);
  const headerNames = Object.keys(init.headers ?? {}).map((h) => h.toLowerCase());
  assert.ok(!headerNames.includes('content-type'), 'the browser sets the form type itself: a CORS simple request');
  assert.deepEqual(JSON.parse(s.storage.getItem(STORAGE_KEY)).provider, 'gumroad');
});

test('Gumroad: refunded, charged-back or disputed purchases do not unlock', async () => {
  for (const flag of ['refunded', 'chargebacked', 'disputed']) {
    const s = setup(GUMROAD, () => reply(200, gumroadOk({ [flag]: true })));
    const r = await s.checker.verify(KEY);
    assert.equal(r.code, 'refunded', flag);
    assert.equal(r.retry, false);
    assert.match(r.message, /refunded or disputed/);
    assert.equal(s.storage.map.size, 0);
  }
});

test('Gumroad: other answers', async () => {
  const cases = [
    [404, { success: false, message: 'That license does not exist for the provided product.' }, 'invalid'],
    [404, { success: false, message: 'This license key has been disabled.' }, 'invalid'],
    [200, { success: false }, 'invalid'],
    [200, gumroadOk({ product_id: 'SomeOtherProduct' }), 'invalid'],
    [200, { success: true, uses: 0 }, 'valid'],
    [200, 'not json', 'provider_error'],
    [500, { success: false, message: 'The product_id parameter is required' }, 'provider_error'],
    [429, {}, 'rate_limited'],
  ];
  for (const [status, body, want] of cases) {
    const s = setup(GUMROAD, () => reply(status, body));
    assert.equal((await s.checker.verify(KEY)).code, want, `${status} ${JSON.stringify(body).slice(0, 60)}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Network trouble

test('no connection: the plain message, a retry hint, and nothing stored', async () => {
  const s = setup(POLAR, () => { throw new TypeError('Failed to fetch'); });
  const r = await s.checker.verify(KEY);
  assert.equal(r.code, 'network');
  assert.equal(r.message, NETWORK_MSG);
  assert.equal(r.retry, true);
  assert.equal(s.storage.map.size, 0);
});

test('offline: no request is attempted', async () => {
  const s = setup(POLAR, () => reply(200, polarGranted()), { online: () => false });
  const r = await s.checker.verify(KEY);
  assert.equal(r.code, 'offline');
  assert.match(r.message, /offline/);
  assert.equal(s.fetch.calls.length, 0);
});

test('a provider that never answers times out, and the request is aborted', async () => {
  let signal;
  const s = setup(POLAR, (_u, init) => { signal = init.signal; return new Promise(() => {}); }, { timeoutMs: 30 });
  const r = await s.checker.verify(KEY);
  assert.equal(r.code, 'timeout');
  assert.equal(r.retry, true);
  assert.equal(signal.aborted, true);
});

test('a body that never finishes also times out', async () => {
  const s = setup(POLAR, () => ({ status: 200, text: () => new Promise(() => {}) }), { timeoutMs: 30 });
  assert.equal((await s.checker.verify(KEY)).code, 'timeout');
});

test('a fetch that rejects with AbortError after our timeout is a timeout, not a network error', async () => {
  const s = setup(POLAR, (_u, init) => new Promise((_res, rej) => {
    init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
  }), { timeoutMs: 20 });
  assert.equal((await s.checker.verify(KEY)).code, 'timeout');
});

test('hostile responses never throw past the module', async () => {
  const responders = [
    () => null,
    () => undefined,
    () => ({}),
    () => ({ status: 'two hundred' }),
    () => ({ status: 200, text: () => { throw new Error('boom'); } }),
    () => ({ status: 200, text: async () => 42 }),
    () => { throw 'a string, not an Error'; },
    () => Promise.reject(null),
  ];
  for (const responder of responders) {
    const s = setup(POLAR, responder);
    const r = await s.checker.verify(KEY);
    assert.equal(r.ok, false);
    assert.ok(['provider_error', 'network'].includes(r.code), String(responder));
    assert.equal(typeof r.message, 'string');
  }
});

// Security audit (2026-10-06): an answer is read only up to a size cap, never whole first and measured after.

/** A response whose body is a stream of `chunks` pieces of `size` bytes, and whose text() reads that same stream. */
function streamed(status, { chunks, size = 65536, json = null, contentLength = null }) {
  const enc = new TextEncoder();
  const piece = enc.encode('x'.repeat(size));
  const state = { pulled: 0, cancelled: false };
  let sent = false;
  const reader = {
    async read() {
      if (state.cancelled) return { done: true, value: undefined };
      if (json !== null) {
        if (sent) return { done: true, value: undefined };
        sent = true;
        state.pulled++;
        return { done: false, value: enc.encode(JSON.stringify(json)) };
      }
      if (state.pulled >= chunks) return { done: true, value: undefined };
      state.pulled++;
      return { done: false, value: piece };
    },
    async cancel() { state.cancelled = true; },
    releaseLock() {},
  };
  const res = {
    status,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-length' && contentLength !== null ? String(contentLength) : null) },
    body: { getReader: () => reader },
    async text() {
      const dec = new TextDecoder();
      let out = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return out;
        out += dec.decode(value, { stream: true });
      }
    },
  };
  return { res, state };
}

test('a huge answer is not read whole: reading stops at the size cap and the stream is cancelled', async () => {
  const big = streamed(200, { chunks: 640 }); // 40 MiB if read to the end
  const s = setup(POLAR, () => big.res);
  const r = await s.checker.verify(KEY);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'provider_error');
  assert.ok(big.state.pulled <= 8, `read ${big.state.pulled} pieces of 64 KiB; the cap is 256 KiB`);
  assert.equal(big.state.cancelled, true, 'the rest of the body is cancelled, not drained');
});

test('an answer that announces a huge Content-Length is not read at all', async () => {
  const big = streamed(200, { chunks: 640, contentLength: 640 * 65536 });
  const s = setup(POLAR, () => big.res);
  assert.equal((await s.checker.verify(KEY)).code, 'provider_error');
  assert.equal(big.state.pulled, 0);
});

test('a normal answer read through the stream still unlocks', async () => {
  const ok = streamed(200, { json: polarGranted() });
  const s = setup(POLAR, () => ok.res);
  const r = await s.checker.verify(KEY);
  assert.equal(r.ok, true);
  assert.equal(r.code, 'valid');
});

// ---------------------------------------------------------------------------------------------------------------
// No retry storms

test('identical checks in flight share one request', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const s = setup(POLAR, async () => { await gate; return reply(200, polarGranted()); });
  const a = s.checker.verify(KEY);
  const b = s.checker.verify(` ${KEY}`);
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(s.fetch.calls.length, 1);
  assert.equal(ra.ok, true);
  assert.deepEqual(ra, rb);
  // once settled, a new check makes a new request
  await s.checker.verify(KEY);
  assert.equal(s.fetch.calls.length, 2);
});

test(`at most ${MAX_CHECKS_PER_WINDOW} checks a minute; a clock that goes backward does not lock anyone out`, async () => {
  const s = setup(POLAR, () => reply(404, {}));
  for (let k = 0; k < MAX_CHECKS_PER_WINDOW; k++) {
    assert.equal((await s.checker.verify(`${KEY}-${k}`)).code, 'invalid');
    s.tick(1000);
  }
  const blocked = await s.checker.verify(`${KEY}-x`);
  assert.equal(blocked.code, 'rate_limited');
  assert.match(blocked.message, /Too many tries/);
  assert.equal(s.fetch.calls.length, MAX_CHECKS_PER_WINDOW);
  s.tick(CHECK_WINDOW_MS);
  assert.equal((await s.checker.verify(`${KEY}-y`)).code, 'invalid', 'allowed again a minute later');
  // the user's clock jumps back a day: earlier timestamps are now "in the future" and must not count
  s.tick(-86_400_000);
  assert.equal((await s.checker.verify(`${KEY}-z`)).code, 'invalid');
});

test('after the provider says 429, no request is sent until the cool-down ends', async () => {
  const s = setup(POLAR, (_u, _i, n) => (n === 0 ? reply(429, {}) : reply(200, polarGranted())));
  assert.equal((await s.checker.verify(KEY)).code, 'rate_limited');
  assert.equal((await s.checker.verify(KEY)).code, 'rate_limited');
  assert.equal(s.fetch.calls.length, 1);
  s.tick(61_000);
  assert.equal((await s.checker.verify(KEY)).ok, true);
  assert.equal(s.fetch.calls.length, 2);
});

// ---------------------------------------------------------------------------------------------------------------
// Storage

test('works without storage, and when storage throws', async () => {
  for (const storage of [null, new BrokenStorage()]) {
    const s = setup(POLAR, () => reply(200, polarGranted()), { storage, session: storage });
    const r = await s.checker.verify(KEY);
    assert.equal(r.ok, true);
    assert.equal(r.stored, false);
    assert.equal(s.checker.recall(), null);
    assert.doesNotThrow(() => s.checker.forget());
    assert.equal(await s.checker.restore(), null);
  }
});

test('recall ignores anything in storage that is not a well-formed saved licence', () => {
  const bad = ['', 'not json', 'null', '[]', '{}', JSON.stringify({ v: 2, provider: 'polar', key: KEY }),
    JSON.stringify({ v: 1, provider: 'stripe', key: KEY }), JSON.stringify({ v: 1, provider: 'polar', key: 'has space' }),
    JSON.stringify({ v: 1, provider: 'polar', key: 42 }), JSON.stringify({ v: 1, provider: 'polar', key: 'k'.repeat(3000) })];
  for (const raw of bad) {
    const storage = new MemStorage();
    storage.setItem(STORAGE_KEY, raw);
    const c = createLicenseChecker({ config: POLAR, storage, session: null });
    assert.equal(c.recall(), null, raw.slice(0, 40));
  }
  const storage = new MemStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, provider: 'polar', key: KEY, validatedAt: 5 }));
  assert.deepEqual(createLicenseChecker({ config: POLAR, storage }).recall(), { provider: 'polar', key: KEY }, 'an older entry with a time still works');
});

test('forget removes the saved licence and the session mark', async () => {
  const s = setup(POLAR, () => reply(200, polarGranted()));
  await s.checker.verify(KEY);
  assert.ok(s.storage.getItem(STORAGE_KEY));
  assert.equal(s.session.getItem(SESSION_KEY), '1');
  s.checker.forget();
  assert.equal(s.storage.getItem(STORAGE_KEY), null);
  assert.equal(s.session.getItem(SESSION_KEY), null);
  assert.equal(s.checker.recall(), null);
});

// ---------------------------------------------------------------------------------------------------------------
// restore (page load)

test('restore: nothing saved, or not on sale, gives null without a request', async () => {
  const s = setup(POLAR, () => reply(200, polarGranted()));
  assert.equal(await s.checker.restore(), null);
  s.storage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, provider: 'polar', key: KEY, validatedAt: 1 }));
  assert.equal(await s.checker.restore({ config: CONFIG }), null);
  assert.equal(s.fetch.calls.length, 0);
});

test('restore: re-checks the saved key once per session', async () => {
  const s = setup(POLAR, () => reply(200, polarGranted()));
  s.storage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, provider: 'polar', key: KEY, validatedAt: 1 }));
  const first = await s.checker.restore();
  assert.equal(first.ok, true);
  assert.equal(first.rechecked, true);
  const second = await s.checker.restore();
  assert.equal(second.ok, true);
  assert.equal(second.rechecked, false);
  assert.equal(s.fetch.calls.length, 1);
  // a new browser session (fresh sessionStorage and a fresh page) re-checks again
  const next = createLicenseChecker({ ...s.deps, session: new MemStorage() });
  assert.equal((await next.restore()).rechecked, true);
  assert.equal(s.fetch.calls.length, 2);
});

test('restore: a key the provider now rejects is forgotten', async () => {
  for (const [config, body, status, code] of [[POLAR, {}, 404, 'invalid'], [GUMROAD, gumroadOk({ refunded: true }), 200, 'refunded']]) {
    const s = setup(config, () => reply(status, body));
    s.storage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, provider: config.licenseProvider, key: KEY, validatedAt: 1 }));
    const r = await s.checker.restore();
    assert.equal(r.ok, false);
    assert.equal(r.code, code);
    assert.equal(s.storage.getItem(STORAGE_KEY), null);
  }
});

test('restore: network trouble never locks out a buyer whose key was valid before', async () => {
  for (const responder of [() => { throw new TypeError('offline'); }, () => reply(503, {}), () => new Promise(() => {})]) {
    const s = setup(POLAR, responder, { timeoutMs: 20 });
    s.storage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, provider: 'polar', key: KEY, validatedAt: 1 }));
    const r = await s.checker.restore();
    assert.equal(r.ok, true);
    assert.equal(r.rechecked, false);
    assert.ok(s.storage.getItem(STORAGE_KEY), 'kept');
  }
});

test('restore: a key bought through the other provider is trusted without a request', async () => {
  const s = setup(POLAR, () => reply(404, {}));
  s.storage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, provider: 'gumroad', key: KEY, validatedAt: 1 }));
  const r = await s.checker.restore();
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'gumroad');
  assert.equal(s.fetch.calls.length, 0);
});

test('the UI-facing helpers: getStoredLicense, storeLicense, clearLicense', () => {
  const storage = new MemStorage();
  const session = new MemStorage();
  const o = { config: POLAR, storage, session, now: () => 7 };
  assert.equal(lic.getStoredLicense(o), null);
  assert.equal(lic.storeLicense(` ${KEY}\n`, o), true);
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)), { v: 1, provider: 'polar', key: KEY });
  assert.equal(lic.getStoredLicense(o), KEY);
  assert.equal(lic.storeLicense('buyer@example.test', o), false, 'never stores something that is not a key');
  assert.equal(lic.storeLicense(KEY, { ...o, config: { ...POLAR, licenseProvider: 'other' } }), false);
  assert.equal(lic.storeLicense(KEY, { ...o, storage: new BrokenStorage() }), false);
  assert.equal(lic.storeLicense(KEY, { ...o, storage: null }), false);
  session.setItem(SESSION_KEY, '1');
  lic.clearLicense(o);
  assert.equal(lic.getStoredLicense(o), null);
  assert.equal(session.getItem(SESSION_KEY), null);
  assert.doesNotThrow(() => lic.clearLicense({ storage: new BrokenStorage(), session: new BrokenStorage() }));
  assert.equal(lic.getStoredLicense({ storage: new BrokenStorage() }), null);
});

// ---------------------------------------------------------------------------------------------------------------
// The default (browser) path, and the overall network footprint

test('the exported verifyLicense uses the global fetch (here: the test trap) and reports no connection', async () => {
  const before = trapCalls.length;
  const r = await verifyLicense(KEY, { config: POLAR, storage: null, session: null });
  assert.equal(r.code, 'network');
  assert.equal(trapCalls.length, before + 1);
  assert.equal(trapCalls[trapCalls.length - 1], POLAR_VALIDATE_URL);
});

test('across every test, only the two provider endpoints were ever requested', () => {
  assert.ok(allRequestedUrls.length > 0);
  for (const url of [...allRequestedUrls, ...trapCalls]) {
    assert.ok(url === POLAR_VALIDATE_URL || url === GUMROAD_VERIFY_URL, url);
  }
});
