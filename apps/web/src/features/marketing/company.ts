import { appConfig } from '../../lib/config.ts';

/**
 * The support inbox of whoever runs this install, shown in the app. Empty when none is
 * configured: callers then show no support entry point.
 */
export function supportEmail(): string {
  return appConfig().supportEmail;
}

/**
 * Terms and Privacy pages of whoever runs this install. Either is empty when it is not
 * configured: callers then show no link.
 */
export function legalUrls(): { terms: string; privacy: string } {
  const { termsUrl, privacyUrl } = appConfig();
  return { terms: termsUrl, privacy: privacyUrl };
}
