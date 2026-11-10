import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { demo } from '../../fixtures/demo.ts';
import { supabaseEnv } from './env.ts';

const env = supabaseEnv();
const service = createClient(env.url, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const created: string[] = [];

/**
 * A queue of its own in the demo location, so parallel specs never call each other's guests.
 * It sorts after the seeded queues, which other specs expect to be selected first.
 */
export async function freshQueue() {
  const name = `E2E ${randomUUID().slice(0, 8)}`;
  const prefix = Array.from({ length: 3 }, () => String.fromCharCode(65 + Math.random() * 26)).join(
    '',
  );
  const { data: queue, error } = await service
    .schema('app')
    .from('queues')
    .insert({
      org_id: demo.orgId,
      location_id: demo.locationId,
      name,
      ticket_prefix: prefix,
      sort_order: 1000,
    })
    .select('id')
    .single();
  if (error) throw error;
  created.push(queue.id as string);
  const { data: svc, error: svcError } = await service
    .schema('app')
    .from('services')
    .insert({
      org_id: demo.orgId,
      location_id: demo.locationId,
      queue_id: queue.id,
      name: 'Trim',
      expected_minutes: 15,
    })
    .select('id')
    .single();
  if (svcError) throw svcError;
  return { id: queue.id as string, serviceId: svc.id as string, name };
}

/** Intake questions on a queue made by `freshQueue` (Q-8). Position follows the order given. */
export async function addIntakeFields(
  queueId: string,
  fields: {
    key: string;
    label: string;
    type?: 'text' | 'select' | 'checkbox' | 'phone' | 'number' | 'date';
    options?: string[];
    required?: boolean;
    visibility?: 'guest' | 'staff_only';
  }[],
) {
  const { error } = await service
    .schema('app')
    .from('intake_fields')
    .insert(
      fields.map((f, position) => ({
        org_id: demo.orgId,
        location_id: demo.locationId,
        queue_id: queueId,
        key: f.key,
        label: f.label,
        type: f.type ?? 'text',
        options: f.options ?? null,
        required: f.required ?? false,
        visibility: f.visibility ?? 'guest',
        position,
      })),
    );
  if (error) throw error;
}

/**
 * Archives the queues this worker's test made, so a long run doesn't leave the demo location
 * with hundreds of queues for the console and join page to list. (Before #566 the join page
 * also joined one channel per queue and went offline past 100.)
 */
export async function archiveFreshQueues() {
  const ids = created.splice(0);
  if (ids.length === 0) return;
  const { error } = await service
    .schema('app')
    .from('queues')
    .update({ archived_at: new Date().toISOString() })
    .in('id', ids);
  if (error) throw error;
}
