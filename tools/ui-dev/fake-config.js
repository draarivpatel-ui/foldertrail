// Development only: a CONFIG that is "on sale", so the licence panel can be seen. Placeholder values only.
export const CONFIG = Object.freeze({
  brand: 'Foldertrail',
  tagline: 'Your BaseCamp library as GPX files, folders kept.',
  priceDisplay: '$19',
  checkoutUrl: 'https://checkout.example.invalid/foldertrail',
  licenseProvider: 'polar',
  polarOrganizationId: 'dev-placeholder',
  gumroadProductId: '',
  supportEmail: '', // no address yet: the page says so
  version: '0.1.0',
});

export function isConfigured() {
  return true;
}
