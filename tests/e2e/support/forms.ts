import { restAs } from './accounts.ts';

/**
 * Publishes a library form in the owner's location and attaches it to queues or services, through
 * the same admin RPCs the app uses (F5). `fields` use the canonical field vocabulary.
 */
export async function attachForm(
  ownerEmail: string,
  where: {
    orgId: string;
    locationId: string;
    targetIds: string[];
    channel?: 'any' | 'walk_in' | 'booking';
  },
  fields: Record<string, unknown>[],
  name = 'E2E form',
) {
  const call = async (fn: string, body: Record<string, unknown>) => {
    const response = await restAs(ownerEmail, `rpc/${fn}`, {
      method: 'POST',
      headers: { 'content-profile': 'api' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${fn}: ${await response.text()}`);
    return response.json();
  };
  const formId = (await call('save_form_draft', {
    p_org_id: where.orgId,
    p_location_id: where.locationId,
    p_form_id: null,
    p_name: name,
    p_purpose_text: null,
    p_retention_days: null,
    p_fields: fields,
  })) as string;
  await call('publish_form_version', { p_org_id: where.orgId, p_form_id: formId });
  await call('attach_form', {
    p_org_id: where.orgId,
    p_form_id: formId,
    p_target_ids: where.targetIds,
    p_channel: where.channel ?? 'any',
  });
  return formId;
}
