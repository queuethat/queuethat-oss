import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AA_RATIO, CONTROL_RATIO, contrastRatio } from './contrast.ts';

// DS-2: every colour pair in packages/ui/src/theme.css is measured, so a token edit that drops
// below WCAG AA fails `pnpm test`. The CSS is parsed as text; nothing here is duplicated by hand.
const CSS = readFileSync(new URL('../../ui/src/theme.css', import.meta.url), 'utf8');

type Tokens = Record<string, string>;

/** The `{ ... }` body that follows the first occurrence of `selector`, nested braces included. */
function blockAfter(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`theme.css has no block "${selector}"`);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unclosed block "${selector}"`);
}

function colours(block: string): Tokens {
  const out: Tokens = {};
  for (const m of block.matchAll(/--color-([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
    out[m[1] as string] = (m[2] as string).toLowerCase();
  }
  return out;
}

const light = colours(blockAfter(CSS, '@theme {'));
const dark = colours(blockAfter(CSS, ":root[data-theme='dark'] {"));
const systemDark = colours(blockAfter(CSS, ":root:not([data-theme='light']) {"));
const highContrast = colours(blockAfter(CSS, ":root[data-theme='high-contrast'] {"));

const TONES = ['neutral', 'info', 'success', 'warning', 'danger'];
const STATES = ['waiting', 'called', 'serving', 'no-show', 'cancelled'];

interface Pair {
  name: string;
  fg: string;
  bg: string;
  min: number;
}

/** Every fg/bg pairing a component can produce, with the ratio it must reach. */
function pairsFor(): Pair[] {
  const pairs: Pair[] = [];
  for (const bg of ['bg', 'surface']) {
    pairs.push({ name: `fg on ${bg}`, fg: 'fg', bg, min: AA_RATIO });
    pairs.push({ name: `muted on ${bg}`, fg: 'muted', bg, min: AA_RATIO });
    pairs.push({ name: `accent text on ${bg}`, fg: 'accent', bg, min: AA_RATIO });
    pairs.push({ name: `border-control on ${bg}`, fg: 'border-control', bg, min: CONTROL_RATIO });
    pairs.push({ name: `focus ring on ${bg}`, fg: 'focus', bg, min: CONTROL_RATIO });
  }
  for (const f of ['primary', 'secondary', 'accent', 'danger']) {
    pairs.push({ name: `on-${f} on ${f}`, fg: `on-${f}`, bg: f, min: AA_RATIO });
  }
  for (const t of TONES) {
    pairs.push({
      name: `${t}-strong on ${t}-soft`,
      fg: `${t}-strong`,
      bg: `${t}-soft`,
      min: AA_RATIO,
    });
  }
  for (const s of STATES) {
    pairs.push({
      name: `state-${s} text`,
      fg: `state-${s}-strong`,
      bg: `state-${s}-soft`,
      min: AA_RATIO,
    });
    pairs.push({
      name: `state-${s} edge on surface`,
      fg: `state-${s}-edge`,
      bg: 'surface',
      min: CONTROL_RATIO,
    });
  }
  return pairs;
}

/** The pairs that miss their minimum, as readable strings. Empty means the theme passes. */
function failures(theme: Tokens): string[] {
  return pairsFor().flatMap((p) => {
    const fg = theme[p.fg];
    const bg = theme[p.bg];
    if (!fg || !bg) return [`${p.name}: token missing`];
    const ratio = contrastRatio(fg, bg);
    return ratio >= p.min ? [] : [`${p.name}: ${ratio.toFixed(2)}:1 < ${p.min}:1 (${fg} on ${bg})`];
  });
}

describe('theme.css contrast (DS-2)', () => {
  it.each([
    ['light', light],
    ['dark', dark],
    ['high-contrast', highContrast],
  ] as const)('%s: every text pair is 4.5:1 and every control and edge is 3:1', (_n, theme) => {
    expect(failures(theme)).toEqual([]);
  });

  it('the system-dark block repeats the explicit dark block exactly', () => {
    expect(systemDark).toEqual(dark);
  });

  it('every theme defines the same tokens', () => {
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
    expect(Object.keys(highContrast).sort()).toEqual(Object.keys(light).sort());
  });

  it('fails when a token drops below its threshold', () => {
    expect(failures({ ...light, 'border-control': '#c8c8c0' })).toEqual([
      expect.stringContaining('border-control on bg'),
      expect.stringContaining('border-control on surface'),
    ]);
    expect(failures({ ...light, muted: '#9a9a9a' })).toHaveLength(2);
    expect(failures({ ...dark, 'state-called-edge': '#3a2f12' })).toEqual([
      expect.stringContaining('state-called edge'),
    ]);
  });
});
