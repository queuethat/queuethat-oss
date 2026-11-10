// Compile-time check that generated RPC types reach the client (S5, #26). Never executed.
import type { Database } from '@qm/db-types';

type Api = Database['api']['Functions'];

export type CallNextArgs = Api['call_next']['Args'];
export type CallNextReturns = Api['call_next']['Returns'];

const _args: CallNextArgs = {
  p_queue_id: '00000000-0000-0000-0000-000000000000',
  p_counter_id: '00000000-0000-0000-0000-000000000000',
  p_idempotency_key: '00000000-0000-0000-0000-000000000000',
};
// @ts-expect-error p_queue_id must be a string
const _bad: CallNextArgs = { ..._args, p_queue_id: 1 };
export const _allowed: CallNextReturns['allowed_actions'] = ['call', 'start'];
// @ts-expect-error 'teleport' is not a visit action
export const _badAction: CallNextReturns['allowed_actions'] = ['teleport'];
void _args;
void _bad;
