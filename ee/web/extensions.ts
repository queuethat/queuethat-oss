// SPDX-License-Identifier: LicenseRef-QueueThat-EE
// Copyright (c) QueueThat. Source-available under ee/LICENSE.
import type { WebExtensions } from '../../apps/web/src/extensions/types.ts';
import { reportLocale, reportPages, reportRedirects } from './reports/extension.ts';
import './types.ts';

/**
 * Everything `ee/` adds to the web app. Build with `QT_WEB_EXTENSIONS=ee/web/extensions.ts`. Each
 * feature folder exports its own pages, redirects and strings; list them here and nowhere else.
 */
export const extensions: WebExtensions = {
  adminPages: [...reportPages],
  banners: [],
  redirects: [...reportRedirects],
  localeOverrides: async (lng, ns) => reportLocale(lng, ns),
};
