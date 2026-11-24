// SPDX-License-Identifier: LicenseRef-QueueThat-EE
// Copyright (c) QueueThat. Licensed under the QueueThat Commercial License (ee/LICENSE).

import { createClient } from '@supabase/supabase-js';
import { demo } from '../../../tests/fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from '../../../tests/e2e/fixtures.ts';
import { supabaseEnv } from '../../../tests/e2e/support/env.ts';

// The custom-domain setup page (3-DOM2, #371), installed by QT_WEB_EXTENSIONS=ee/web/extensions.ts
// (playwright.ee.config.ts). Host routing for guests is in tests/e2e/custom-domain.spec.ts.

function serviceClient() {
  const { serviceRoleKey, url } = supabaseEnv();
  return createClient(url, serviceRoleKey, { auth: { persistSession: false } }).schema('app');
}

test.describe('as an owner', () => {
  test.use({ staffUser: 'owner' });

  test('AC3: adds a domain, shows the DNS records, and the poster follows only once it is verified', async ({
    devices,
  }) => {
    const { staff } = devices;
    const host = `book-${crypto.randomUUID().slice(0, 8)}.example.org`;
    const db = serviceClient();
    try {
      await staff.goto('/admin/x/domains');
      await staff.getByRole('button', { name: 'Add domain' }).click();
      const form = staff.getByRole('dialog', { name: 'Add a custom domain' });
      await form.getByRole('textbox', { name: 'Domain' }).fill(host);
      await expectNoSeriousA11yViolations(staff);
      await form.getByRole('button', { name: 'Add domain' }).click();

      const row = staff.getByTestId('domain').filter({ hasText: host });
      await expect(row).toContainText('Waiting for DNS');
      await expect(row.getByLabel('TXT record name')).toHaveValue(`_queue-verify.${host}`);
      await expect(row.getByLabel('TXT record value')).toHaveValue(/^[0-9a-f]{32}$/);

      await staff.goto('/admin/poster');
      await expect(staff.getByTestId('poster')).toContainText(`/q/${demo.locationSlug}`);
      await expect(staff.getByTestId('poster')).not.toContainText(host);

      await db.from('custom_domains').update({ status: 'verified' }).eq('hostname', host);
      await staff.goto('/admin/poster');
      await expect(staff.getByTestId('poster')).toContainText(
        `https://${host}/q/${demo.locationSlug}`,
      );
    } finally {
      await db.from('custom_domains').delete().eq('hostname', host);
    }
  });

  test('the old /admin/domains address opens the page, as a tab of Developers', async ({
    devices,
  }) => {
    const { staff } = devices;
    await staff.setViewportSize({ width: 1280, height: 900 });
    await staff.goto('/admin/domains');
    await expect(staff).toHaveURL(/\/admin\/x\/domains$/);
    const tabs = staff.getByRole('navigation', { name: 'Developers' });
    await expect(tabs.getByRole('link', { name: 'Custom domains' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});
