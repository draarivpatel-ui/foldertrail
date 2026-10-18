// Shared configuration: the brand, the price shown on the page, and the payment provider's PUBLIC ids.
// The maintainer fills in the empty strings before launch. Nothing here is secret: an
// organization id or a product id is meant to be public, and this file is served to every visitor.
// Until the placeholders are filled, isConfigured() is false and the app shows "not on sale yet: preview only".

/**
 * @typedef {object} Config
 * @property {string} brand              the product name shown everywhere (never contains "Garmin" or "BaseCamp", B29)
 * @property {string} tagline            one plain sentence under the brand
 * @property {string} priceDisplay       the price as shown on the page; the real price is set at the payment provider
 * @property {string} checkoutUrl        the provider's hosted checkout page (https), "" until the maintainer sets it
 * @property {"polar"|"gumroad"} licenseProvider  which provider checks licence keys (Polar first, Gumroad fallback, B24)
 * @property {string} polarOrganizationId  Polar organization id (a UUID), "" until set
 * @property {string} gumroadProductId   Gumroad product id, "" until set
 * @property {string} supportEmail       where buyers write for help, "" until set
 * @property {string} version            the app version, shown in the report and the diagnostic dump
 */

/** @type {Readonly<Config>} */
export const CONFIG = Object.freeze({
  brand: 'Foldertrail',
  tagline: 'Your Garmin BaseCamp library as GPX files, in the folders you made.',
  priceDisplay: '$19',
  checkoutUrl: '',
  licenseProvider: 'polar',
  polarOrganizationId: '',
  gumroadProductId: '',
  supportEmail: '',
  version: '0.1.0',
});

/** Polar documents organization_id as a UUID (format uuid4); any version digit is accepted here. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Gumroad product ids look like "32-nPAicqbLj8B_WswVlMw==" (its API docs); accept any short id without spaces. */
const GUMROAD_ID = /^[\x21-\x7e]{1,100}$/;

/**
 * True only when everything needed to sell is filled in and well formed: an https checkout link and the id for the
 * selected provider. While it is false the page must show "not on sale yet: preview only", never a broken buy button.
 * Never throws.
 * @param {Partial<Config>} [config]
 * @returns {boolean}
 */
export function isConfigured(config = CONFIG) {
  try {
    if (!config || typeof config !== 'object') return false;
    const { checkoutUrl, licenseProvider, polarOrganizationId, gumroadProductId } = config;
    if (typeof checkoutUrl !== 'string' || checkoutUrl.trim() === '') return false;
    let url;
    try {
      url = new URL(checkoutUrl.trim());
    } catch {
      return false;
    }
    if (url.protocol !== 'https:') return false;
    if (licenseProvider === 'polar') {
      return typeof polarOrganizationId === 'string' && UUID.test(polarOrganizationId.trim());
    }
    if (licenseProvider === 'gumroad') {
      return typeof gumroadProductId === 'string' && GUMROAD_ID.test(gumroadProductId.trim());
    }
    return false;
  } catch {
    return false;
  }
}
