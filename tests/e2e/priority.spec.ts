import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { guestJoins, openQueue, pickRowAction } from './support/console.ts';
import { supabaseEnv } from './support/env.ts';
import { freshQueue } from './support/queues.ts';

// Q-10 (#228): staff give a waiting guest a priority class and the line reorders on every tablet.

const env = supabaseEnv();
const service = createClient(env.url, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const classIds: string[] = [];

test.afterAll(async () => {
  for (const id of classIds)
    await service.schema('app').from('priority_classes').delete().eq('id', id);
});

test('AC1: staff move a guest ahead with a priority class, and can clear it', async ({
  devices,
}) => {
  const className = `Access ${randomUUID().slice(0, 6)}`;
  const { data: cls, error } = await service
    .schema('app')
    .from('priority_classes')
    .insert({
      org_id: demo.orgId,
      location_id: demo.locationId,
      name: className,
      offset_minutes: 120,
    })
    .select('id')
    .single();
  if (error) throw error;
  classIds.push(cls.id as string);

  const queue = await freshQueue();
  await guestJoins('First Fay', queue.id);
  await guestJoins('Second Sid', queue.id);
  const page = devices.staff;
  await openQueue(page, queue.id);
  const rows = page.getByTestId('section-waiting').getByTestId('visit');
  await expect(rows.first()).toContainText('First Fay');

  await pickRowAction(rows.nth(1), 'Priority');
  const dialog = page.getByRole('dialog', { name: /^Priority for / });
  await dialog.getByLabel('Priority').selectOption({ label: className });
  await expectNoSeriousA11yViolations(page);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);

  await expect(rows.first()).toContainText('Second Sid');
  await expect(rows.first().getByTestId('priority-badge')).toContainText(className);

  await pickRowAction(rows.first(), 'Priority');
  await page
    .getByRole('dialog', { name: /^Priority for / })
    .getByLabel('Priority')
    .selectOption({ label: 'No priority' });
  await page
    .getByRole('dialog', { name: /^Priority for / })
    .getByRole('button', { name: 'Save' })
    .click();
  await expect(rows.first().getByTestId('priority-badge')).toHaveCount(0);
});
