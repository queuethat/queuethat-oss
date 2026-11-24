// SPDX-License-Identifier: LicenseRef-QueueThat-EE
import type {
  ExtensionAdminPage,
  ExtensionRedirect,
  ExtensionSlots,
} from '@app/extensions/types.ts';
import { withCrmStrings } from './pages.ts';

/** The guest-list tools: import, merging duplicates, tags and notes. Keep this module light. */
export const crmAdminPages: ExtensionAdminPage[] = [
  {
    path: 'guests-import',
    load: () =>
      withCrmStrings(async () => ({
        default: (await import('./import/ImportPage.tsx')).ImportPage,
      })),
  },
  {
    path: 'guests-duplicates',
    load: () =>
      withCrmStrings(async () => ({
        default: (await import('./merge/DuplicatesPage.tsx')).DuplicatesPage,
      })),
  },
];

/** The old addresses of those pages keep working. */
export const crmRedirects: ExtensionRedirect[] = [
  { from: 'guests/import', to: 'guests-import' },
  { from: 'guests/duplicates', to: 'guests-duplicates' },
];

export const crmSlots: ExtensionSlots = {
  'guests.actions': () => withCrmStrings(() => import('./slots/GuestsActions.tsx')),
  'guest.profile': () => withCrmStrings(() => import('./slots/GuestProfile.tsx')),
  'console.guestTags': () => import('./slots/ConsoleGuestTags.tsx'),
};
