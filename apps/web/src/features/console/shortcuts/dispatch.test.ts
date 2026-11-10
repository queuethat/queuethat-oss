import { describe, expect, it } from 'vitest';
import { modShortcutFor, shortcutFor } from './dispatch.ts';

const press = (key: string, target: Element | null = document.body, extra = {}) =>
  ({ key, target, ...extra }) as Parameters<typeof shortcutFor>[0];

describe('shortcutFor', () => {
  it('maps single keys, case-insensitively', () => {
    expect(shortcutFor(press('n'), true)).toBe('callNext');
    expect(shortcutFor(press('C'), true)).toBe('complete');
    expect(shortcutFor(press('?'), true)).toBe('help');
  });

  it('ignores typing in inputs, textareas and contenteditable', () => {
    for (const html of ['<input>', '<textarea></textarea>', '<div contenteditable="true"></div>']) {
      const host = document.createElement('div');
      host.innerHTML = html;
      expect(shortcutFor(press('n', host.firstElementChild), true)).toBeNull();
    }
  });

  it('ignores keys inside a dialog', () => {
    const host = document.createElement('div');
    host.innerHTML = '<dialog><button>ok</button></dialog>';
    expect(shortcutFor(press('n', host.querySelector('button')), true)).toBeNull();
  });

  it('ignores modified keys and repeats', () => {
    expect(shortcutFor(press('n', document.body, { ctrlKey: true }), true)).toBeNull();
    expect(shortcutFor(press('n', document.body, { repeat: true }), true)).toBeNull();
  });

  it('does nothing when single-key shortcuts are off, except help', () => {
    expect(shortcutFor(press('n'), false)).toBeNull();
    expect(shortcutFor(press('?'), false)).toBe('help');
  });
});

describe('modShortcutFor', () => {
  const mod = (extra = {}, target: Element | null = document.body) =>
    modShortcutFor({ key: 'k', ctrlKey: true, target, ...extra });

  it('maps Ctrl or Cmd + K to goTo, even while typing in a field', () => {
    expect(mod()).toBe('goTo');
    expect(mod({ ctrlKey: false, metaKey: true })).toBe('goTo');
    expect(mod({ key: 'K' })).toBe('goTo');
    const host = document.createElement('div');
    host.innerHTML = '<input>';
    expect(mod({}, host.firstElementChild)).toBe('goTo');
  });

  it('ignores a bare K, other modified keys, alt, repeats and dialogs', () => {
    expect(mod({ ctrlKey: false })).toBeNull();
    expect(mod({ key: 'j' })).toBeNull();
    expect(mod({ altKey: true })).toBeNull();
    expect(mod({ repeat: true })).toBeNull();
    const host = document.createElement('div');
    host.innerHTML = '<dialog><input></dialog>';
    expect(mod({}, host.querySelector('input'))).toBeNull();
  });
});
