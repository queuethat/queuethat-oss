import { useEffect, useState } from 'react';

/**
 * The kiosk's accessibility mode (D-9): high-contrast colours (7:1 text, see theme.css) and text at
 * 200%. It belongs to the guest at the screen, so it is not remembered: the kiosk's reset after
 * a guest leaves or goes idle turns it off (`startOver` calls `setOn(false)`).
 */
export function useAccessibilityMode(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return;
    const root = document.documentElement;
    const before = root.dataset.theme;
    root.dataset.theme = 'high-contrast';
    root.dataset.kioskText = 'large';
    return () => {
      if (before === undefined) delete root.dataset.theme;
      else root.dataset.theme = before;
      delete root.dataset.kioskText;
    };
  }, [on]);
  return [on, setOn];
}
