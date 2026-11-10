import { describe, expect, it, vi } from 'vitest';
import { createSpeech, spokenName } from './speech.ts';

class FakeUtterance {
  lang = '';
  constructor(public text: string) {}
}

function setup() {
  const spoken: FakeUtterance[] = [];
  const synth = {
    speak: vi.fn((u: FakeUtterance) => spoken.push(u)),
    cancel: vi.fn(),
  };
  const speech = createSpeech(synth, FakeUtterance as unknown as typeof SpeechSynthesisUtterance);
  return { spoken, synth, speech };
}

describe('createSpeech', () => {
  it('speaks the text in the given language', () => {
    const { spoken, speech } = setup();
    speech.say('Front desk', 'fr');
    expect(spoken.map((u) => [u.text, u.lang])).toEqual([['Front desk', 'fr']]);
  });

  it('cuts off the previous phrase so guidance never lags behind focus', () => {
    const { synth, speech } = setup();
    speech.say('one', 'en');
    speech.say('two', 'en');
    expect(synth.cancel).toHaveBeenCalledTimes(2);
    expect(synth.speak).toHaveBeenCalledTimes(2);
  });

  it('ignores empty text and works without speech support', () => {
    const { synth, speech } = setup();
    speech.say('  ', 'en');
    expect(synth.speak).not.toHaveBeenCalled();
    expect(() => createSpeech(undefined, undefined).say('hi', 'en')).not.toThrow();
  });
});

describe('spokenName', () => {
  it('prefers aria-label, then the field label, then the text', () => {
    document.body.innerHTML =
      '<button id="a" aria-label="Start">x</button><label for="n">First name</label><input id="n"/><button id="b"> Get my   ticket </button>';
    expect(spokenName(document.getElementById('a')!)).toBe('Start');
    expect(spokenName(document.getElementById('n')!)).toBe('First name');
    expect(spokenName(document.getElementById('b')!)).toBe('Get my ticket');
  });

  it('adds the chosen option of a select', () => {
    document.body.innerHTML =
      '<label for="s">Service</label><select id="s"><option>Haircut</option><option selected>Beard trim</option></select>';
    expect(spokenName(document.getElementById('s')!)).toBe('Service, Beard trim');
  });
});
