import { describe, expect, it } from 'vitest';
import { CONFIRM_COMMANDS, LEAVE_COMMANDS, classifyCommand } from './commands.ts';
import { HELP_KEYWORDS, OPTIN_KEYWORDS, OPTOUT_KEYWORDS, classifyKeyword } from './keywords.ts';

describe('classifyCommand', () => {
  it.each(['c', 'C.', ' ok ', 'Coming!'])('treats %j as confirm', (b) =>
    expect(classifyCommand(b)).toBe('confirm'),
  );
  it.each(['l', 'L!', 'leave'])('treats %j as leave', (b) =>
    expect(classifyCommand(b)).toBe('leave'),
  );
  it.each(['cancel', 'stop', 'maybe', '', 'c u soon'])('ignores %j', (b) =>
    expect(classifyCommand(b)).toBeNull(),
  );
});

it('AC3: commands and carrier keywords are disjoint', () => {
  const keywords = new Set<string>([...OPTOUT_KEYWORDS, ...OPTIN_KEYWORDS, ...HELP_KEYWORDS]);
  for (const c of [...CONFIRM_COMMANDS, ...LEAVE_COMMANDS]) {
    expect(keywords.has(c)).toBe(false);
    expect(classifyKeyword(c)).toBeNull();
  }
});
