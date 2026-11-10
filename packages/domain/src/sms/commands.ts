/**
 * Two-way SMS commands (N-7). They are checked only after keywords.ts finds no carrier keyword, and
 * the sets must stay disjoint: CANCEL is an opt-out, never "leave the queue". The SQL twin is
 * `private.inbound_command_kind`; the drift test keeps them equal.
 */
import { normalizeKeyword } from './keywords.ts';

export type InboundCommandKind = 'confirm' | 'leave';

export const CONFIRM_COMMANDS = ['C', 'OK', 'COMING'] as const;
export const LEAVE_COMMANDS = ['L', 'LEAVE'] as const;

export function classifyCommand(body: string): InboundCommandKind | null {
  const word = normalizeKeyword(body);
  if ((CONFIRM_COMMANDS as readonly string[]).includes(word)) return 'confirm';
  if ((LEAVE_COMMANDS as readonly string[]).includes(word)) return 'leave';
  return null;
}
