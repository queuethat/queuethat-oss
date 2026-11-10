import { SHORTCUTS, type ShortcutCommand } from './config.ts';

/** The subset of a keyboard event the dispatcher reads, so tests need no DOM. */
export interface KeyInput {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  target: EventTarget | null;
}

/** Typing in a field, or anything inside a dialog, must never trigger a shortcut. */
export function isTypingContext(target: EventTarget | null): boolean {
  const el = target as Element | null;
  if (!el || typeof el.closest !== 'function') return false;
  if (el.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) {
    return true;
  }
  return !!el.closest('dialog, [role="dialog"], [role="alertdialog"]');
}

/**
 * Maps a key press to a command, or null. Single-key shortcuts are off when the user turned them
 * off (WCAG 2.1.4); modified keys and repeats are never shortcuts. `help` (?) stays available
 * outside typing contexts even when the others are off, so the setting can be found again.
 */
export function shortcutFor(input: KeyInput, enabled: boolean): ShortcutCommand | null {
  if (input.ctrlKey || input.metaKey || input.altKey || input.repeat) return null;
  if (isTypingContext(input.target)) return null;
  const hit = SHORTCUTS.find((s) => s.key === input.key.toLowerCase());
  if (!hit) return null;
  return enabled || hit.command === 'help' ? hit.command : null;
}

/** Shortcuts that need a modifier, so single-key shortcuts being off never affects them. */
export type ModShortcutCommand = 'goTo';

/**
 * Ctrl or Cmd + K opens "Go to…" in the admin area. It works while typing in a field (the usual
 * palette behaviour) but not inside a dialog, so the open palette does not stack another.
 */
export function modShortcutFor(input: KeyInput): ModShortcutCommand | null {
  if (!(input.ctrlKey || input.metaKey) || input.altKey || input.repeat) return null;
  if (input.key.toLowerCase() !== 'k') return null;
  const el = input.target as Element | null;
  if (
    el &&
    typeof el.closest === 'function' &&
    el.closest('dialog, [role="dialog"], [role="alertdialog"]')
  ) {
    return null;
  }
  return 'goTo';
}
