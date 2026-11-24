// SPDX-License-Identifier: LicenseRef-QueueThat-EE
import type { ExtensionSlots } from '@app/extensions/types.ts';

/** Desk payments: ask a guest to pay at the counter, and show the pay QR. Keep this module light. */
export const paymentsSlots: ExtensionSlots = {
  'console.payments.request': async () => ({
    default: (await import('./RequestPayment.tsx')).RequestPayment,
  }),
  'console.payments.payCode': async () => ({
    default: (await import('./PayCodeQr.tsx')).PayCodeQr,
  }),
};
