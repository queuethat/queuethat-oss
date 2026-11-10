/** What a shortcut asks the console to do; the console decides whether it is allowed (S-10). */
export type ShortcutCommand =
  | 'callNext'
  | 'selectNext'
  | 'selectPrevious'
  | 'start'
  | 'complete'
  | 'recall'
  | 'noShow'
  | 'remove'
  | 'undo'
  | 'addGuest'
  | 'search'
  | 'help';

/** The one map the dispatcher and the help overlay both read. */
export const SHORTCUTS: readonly { key: string; command: ShortcutCommand }[] = [
  { key: 'n', command: 'callNext' },
  { key: 'j', command: 'selectNext' },
  { key: 'k', command: 'selectPrevious' },
  { key: 's', command: 'start' },
  { key: 'c', command: 'complete' },
  { key: 'r', command: 'recall' },
  { key: 'x', command: 'noShow' },
  { key: 'd', command: 'remove' },
  { key: 'u', command: 'undo' },
  { key: 'a', command: 'addGuest' },
  { key: '/', command: 'search' },
  { key: '?', command: 'help' },
];
