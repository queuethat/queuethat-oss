import { appConfig } from '../../lib/config.ts';

/**
 * The support inbox of whoever runs this install, shown in the app. Empty when a self-hosted
 * install has not set one: callers then show no support entry point.
 */
export function supportEmail(): string {
  return appConfig().supportEmail;
}

/**
 * Terms and Privacy pages of whoever runs this install. The hosted service keeps them on its
 * marketing site (Stripe and Twilio forms reference those URLs). Either is empty when a
 * self-hosted install has not set it: callers then show no link.
 */
export function legalUrls(): { terms: string; privacy: string } {
  const { termsUrl, privacyUrl } = appConfig();
  return { terms: termsUrl, privacy: privacyUrl };
}
