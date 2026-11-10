import { describe, expect, it } from 'vitest';
import {
  classifyKeyword,
  classifyOptOutPhrase,
  normalizeKeyword,
  OPTOUT_KEYWORDS,
} from './keywords.ts';

describe('classifyKeyword', () => {
  it.each([
    'stop',
    'STOP.',
    ' Stop all! ',
    'opt out',
    'OptOut',
    'Unsubscribe',
    'cancel',
    'end',
    'QUIT',
    'revoke',
  ])('treats %j as an opt-out', (body) => expect(classifyKeyword(body)).toBe('optout'));
  it.each(['start', 'Unstop'])('treats %j as an opt-in', (body) =>
    expect(classifyKeyword(body)).toBe('optin'),
  );
  it.each(['help', 'INFO.'])('treats %j as help', (body) =>
    expect(classifyKeyword(body)).toBe('help'),
  );
  it.each(['stopped', 'c', 'L', '', '   '])('leaves %j alone', (body) =>
    expect(classifyKeyword(body)).toBeNull(),
  );
  it('does not treat YES as an opt-in', () => expect(classifyKeyword('yes!')).toBeNull());
  it.each([
    'Stop texting me',
    'please stop',
    'PLEASE STOP!',
    'Remove me',
    'unsubscribe me please',
    'No más',
    'no mas',
    'Pare',
    'baja',
    'Por favor, pare',
    'Dame de baja',
    "don't text me",
    'Take me off the list',
    'no more messages',
  ])('treats the free text %j as an opt-out', (body) =>
    expect(classifyKeyword(body)).toBe('optout'),
  );
  it.each([
    'no',
    'No!',
    'stop by at 5',
    'can you remove me from the 3pm slot',
    'I cannot stop laughing',
    'baja la voz',
    'please',
    'no more than two',
    'yes please stop',
    'texting me is fine',
  ])('leaves the free text %j alone', (body) => expect(classifyKeyword(body)).toBeNull());
  it('tells Spanish from English', () => {
    expect(classifyOptOutPhrase('no más')).toBe('es');
    expect(classifyOptOutPhrase('remove me')).toBe('en');
    expect(classifyOptOutPhrase('hola')).toBeNull();
  });
  it('normalises case, spaces and punctuation', () => {
    expect(normalizeKeyword(' Stop-All. ')).toBe('STOPALL');
    expect(OPTOUT_KEYWORDS).toContain('STOPALL');
  });
});
