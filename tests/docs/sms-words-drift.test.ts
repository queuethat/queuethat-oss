// The SQL word lists (private.inbound_keyword_kind, private.inbound_command_kind) must equal the domain sets.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CONFIRM_COMMANDS, LEAVE_COMMANDS } from '../../packages/domain/src/sms/commands.ts';
import {
  HELP_KEYWORDS,
  OPTIN_KEYWORDS,
  OPTOUT_KEYWORDS,
  OPTOUT_PHRASES_EN,
  OPTOUT_PHRASES_ES,
} from '../../packages/domain/src/sms/keywords.ts';

const dir = join(import.meta.dirname, '../../supabase/migrations');

/** The body of the newest migration that defines `fn`. */
function latest(fn: string): string {
  const files = readdirSync(dir).filter((f) => readFileSync(join(dir, f), 'utf8').includes(`function ${fn}`));
  return readFileSync(join(dir, files.sort().at(-1)!), 'utf8');
}
const words = (sql: string, kind: string) =>
  [...(sql.match(new RegExp(`'${kind}'\\s*::?\\s*text\\s*,\\s*array\\[([^\\]]*)\\]`))?.[1].matchAll(/'([A-Z0-9]+)'/g) ?? [])]
    .map((m) => m[1]).sort();

it('SQL keyword sets equal the domain sets', () => {
  const sql = latest('private.inbound_keyword_kind');
  expect(words(sql, 'optout')).toEqual([...OPTOUT_KEYWORDS].sort());
  expect(words(sql, 'optin')).toEqual([...OPTIN_KEYWORDS].sort());
  expect(words(sql, 'help')).toEqual([...HELP_KEYWORDS].sort());
});

it('SQL command sets equal the domain sets', () => {
  const sql = latest('private.inbound_command_kind');
  expect(words(sql, 'confirm')).toEqual([...CONFIRM_COMMANDS].sort());
  expect(words(sql, 'leave')).toEqual([...LEAVE_COMMANDS].sort());
});

it('SQL free-text opt-out phrases equal the domain sets', () => {
  const sql = latest('private.inbound_optout_phrase');
  const phrases = [...(sql.match(/any \(array\[([^\]]*)\]\)/)?.[1].matchAll(/'([a-z0-9 ]+)'/g) ?? [])].map((m) => m[1]).sort();
  expect(phrases).toEqual([...OPTOUT_PHRASES_EN, ...OPTOUT_PHRASES_ES].sort());
});
