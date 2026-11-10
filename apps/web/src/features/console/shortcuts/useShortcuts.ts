import { useEffect, useRef } from 'react';
import type { ShortcutCommand } from './config.ts';
import { modShortcutFor, shortcutFor, type ModShortcutCommand } from './dispatch.ts';

/** Runs `onCommand` for console shortcuts; the latest handler is always used. */
export function useShortcuts(enabled: boolean, onCommand: (command: ShortcutCommand) => void) {
  const handler = useRef(onCommand);
  useEffect(() => {
    handler.current = onCommand;
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const command = shortcutFor(event, enabled);
      if (!command) return;
      event.preventDefault();
      handler.current(command);
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [enabled]);
}

/** Runs `onCommand` for modifier shortcuts (Ctrl or Cmd + K); the latest handler is always used. */
export function useModShortcuts(onCommand: (command: ModShortcutCommand) => void) {
  const handler = useRef(onCommand);
  useEffect(() => {
    handler.current = onCommand;
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const command = modShortcutFor(event);
      if (!command) return;
      event.preventDefault();
      handler.current(command);
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
}
