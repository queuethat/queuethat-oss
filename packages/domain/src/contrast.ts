/** WCAG 2.1 AA contrast for normal text. */
export const AA_RATIO = 4.5;

/** WCAG 2.1 AA contrast for UI components and graphical objects (input borders, focus rings). */
export const CONTROL_RATIO = 3;

const HEX = /^#[0-9a-f]{6}$/i;

/** True for `#rrggbb`, the only colour format the database accepts. */
export function isHexColor(value: string): boolean {
  return HEX.test(value);
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of `#rrggbb`. */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

/** WCAG contrast ratio of two `#rrggbb` colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Black or white, whichever reads better on `background`. One of them always reaches 4.5:1. */
export function accessibleTextColor(background: string): '#000000' | '#ffffff' {
  return contrastRatio(background, '#ffffff') >= contrastRatio(background, '#000000')
    ? '#ffffff'
    : '#000000';
}

/** Whether white text on `background` already meets AA, so no text-colour switch is needed. */
export function whiteTextPasses(background: string): boolean {
  return contrastRatio(background, '#ffffff') >= AA_RATIO;
}
