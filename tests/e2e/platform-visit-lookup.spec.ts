import { createClient } from '@supabase/supabase-js';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, readAs } from './support/accounts.ts';
import { guestJoins } from './support/console.ts';
import { supabaseEnv } from './support/env.ts';
import { signedInOperator } from './support/totp.ts';

// #1136: support finds one visit and reads its timeline only while the owner's grant is live.
// clock-ok: the grant window is an hour from now, which no midnight or rollover can affect.
test.use({ staffUser: null });

const env = supabaseEnv();
const service = createClient(env.url, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** A business with one queue and one waiting guest named so we can prove the name never shows. */
async function businessWithVisit(guestName: string) {
  const { email } = await ownerOfNewBusiness();
  const [[org], [location]] = (await readAs(email, [
    'organizations?select=id',
    'locations?select=id',
  ])) as [[{ id: string }], [{ id: string }]];
  const { data: queue, error } = await service
    .schema('app')
    .from('queues')
    .insert({ org_id: org.id, location_id: location.id, name: 'Walk-ins', ticket_prefix: 'A' })
    .select('id')
    .single();
  if (error) throw error;
  const { error: serviceError } = await service.schema('app').from('services').insert({
    org_id: org.id,
    location_id: location.id,
    queue_id: queue.id,
    name: 'Cut',
    expected_minutes: 15,
  });
  if (serviceError) throw serviceError;
  await guestJoins(guestName, queue.id);
  const { data: visit } = await service
    .schema('app')
    .from('visits')
    .select('id, display_ticket')
    .eq('queue_id', queue.id)
    .single();
  return { orgId: org.id, visit: visit! };
}

test('support sees no visit data without a grant, then reads the timeline under one, then loses it on revoke', async ({
  devices,
}) => {
  test.slow();
  const { staff: operator } = devices;
  const guestName = `Zelda${crypto.randomUUID().slice(0, 6)}`;
  const { orgId, visit } = await businessWithVisit(guestName);
  await signedInOperator(operator);

  // No grant: the page explains how to get one and shows nothing.
  await operator.goto(`/platform/visits?org=${orgId}`);
  await operator.getByRole('button', { name: 'Search' }).click();
  await expect(operator.getByText('No support access to this business')).toBeVisible();
  await expect(operator.getByTestId('hit')).toHaveCount(0);

  // The owner's grant (written with the service role; the RPC is covered by pgTAP).
  const { data: owner } = await service
    .schema('app')
    .from('memberships')
    .select('user_id')
    .eq('org_id', orgId)
    .eq('role', 'owner')
    .single();
  const { data: grant, error } = await service
    .schema('app')
    .from('support_grants')
    .insert({
      org_id: orgId,
      granted_by: owner!.user_id,
      scope: 'read',
      reason: 'Guest says never called',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    })
    .select('id')
    .single();
  if (error) throw error;

  await operator.getByLabel('Ticket number').fill(visit.display_ticket);
  await operator.getByRole('button', { name: 'Search' }).click();
  await expect(operator.getByTestId('hit')).toHaveCount(1);
  await operator.getByRole('button', { name: /Open timeline/ }).click();
  await expect(operator.getByTestId('grant-banner')).toContainText('Guest says never called');
  await expect(operator.getByTestId('event').first()).toContainText('joined');
  await expect(operator.getByTestId('timeline')).not.toContainText(guestName);
  await expectNoSeriousA11yViolations(operator);

  // Both lookups were audited with the grant.
  const { data: audit } = await service
    .schema('app')
    .from('platform_audit')
    .select('action, target')
    .eq('org_id', orgId)
    .in('action', ['support.visit_search', 'support.visit_timeline']);
  expect(audit?.map((a) => a.action).sort()).toEqual([
    'support.visit_search',
    'support.visit_timeline',
  ]);
  expect(
    audit?.every((a) => (a.target as { support_grant_id: string }).support_grant_id === grant.id),
  ).toBe(true);

  // Revoked: the next search is refused.
  await service
    .schema('app')
    .from('support_grants')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', grant.id);
  await operator.getByRole('button', { name: 'Search' }).click();
  await expect(operator.getByText('No support access to this business')).toBeVisible();
});
