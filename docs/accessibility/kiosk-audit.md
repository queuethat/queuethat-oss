# Kiosk accessibility audit (WCAG 2.1 AA, EN 301 549 terminal clauses)

Status: **draft for sign-off.** Rows marked *automated* are checked by tests on every change.
Rows marked *manual* have not been run on real hardware yet; they need a person with the tablet,
a keyboard or switch device, headphones and a screen reader. Sign-off: The maintainer (not yet given).

| # | Requirement | How it is met | Evidence | Result |
|---|---|---|---|---|
| 1 | WCAG 1.4.3 / 1.4.6 contrast (7:1 in accessibility mode) | High-contrast theme, black/white/yellow | axe `color-contrast` in `kiosk.spec.ts` and `kiosk-a11y.spec.ts` | automated, pass |
| 2 | 1.4.4 resize text to 200% | Accessibility mode doubles root size; layout is rem-based | `kiosk-a11y.spec.ts` AC1 checks size and no sideways overflow | automated, pass |
| 3 | 2.1.1 / 2.1.2 keyboard, no trap | Native controls, logical tab order, Dialog traps focus only while open and returns it | `kiosk-a11y.spec.ts` AC2 (Tab, Space, Enter only) | automated, pass |
| 4 | 2.2.1 timing adjustable | Warning 20 s before the reset; "I need more time" adds 2 minutes; warning also spoken | `kiosk-timeout.spec.ts` AC2, `useIdleReset.test.tsx` | automated, pass |
| 5 | 2.4.7 focus visible | 3 px `:focus-visible` ring, yellow in the mode | axe, visual check | manual |
| 6 | 2.5.5 target size | Kiosk buttons at least 56 px | `kiosk-a11y.spec.ts` AC1 (accessibility button) | automated (one button), manual (rest) |
| 7 | 3.1.1 language of page | `lang` follows the guest's chosen language | axe `html-has-lang` | automated, pass |
| 8 | 4.1.2 name, role, value | Labelled fields, `aria-pressed` toggles | axe | automated, pass |
| 9 | EN 301 549 5.1 / 5.2 closed functionality, audio output | Spoken guidance via Web Speech, plays through the device speaker or headphone jack | `speech.test.ts`, `kiosk-timeout.spec.ts` AC1 | automated (speech call), manual (audible output, voices per device) |
| 10 | EN 301 549 5.5 operable parts, 5.6 locking | No latching controls; mode resets after each guest | `kiosk-a11y.spec.ts` AC1 | automated |
| 11 | EN 301 549 8.3 mounting and reach (hardware) | Not a software matter; venue installs the tablet within reach | n/a | manual, venue |
| 12 | Screen reader (VoiceOver / TalkBack) walk-through of the join | Not yet done | n/a | manual, **open** |

Known gaps: no tactile keypad; spoken guidance depends on the device having a voice for the
chosen language; real-hardware checks (rows 5, 6, 9, 11, 12) are open.
