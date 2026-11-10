---
name: QueueThat
description: Porcelain and ink with one lagoon accent; a calm service counter where only a called guest is loud.
colors:
  ink: '#15171c'
  ink-hover: '#2b2f38'
  porcelain: '#f6f6f2'
  surface: '#ffffff'
  stone: '#e8e8e1'
  stone-hover: '#dcdcd3'
  lagoon: '#0e5e55'
  lagoon-hover: '#0a4a43'
  signal-red: '#b42318'
  signal-red-hover: '#912018'
  slate-text: '#4b5160'
  hairline: '#d9dad3'
  control-edge: '#868b96'
  waiting-soft: '#e3eef6'
  waiting-strong: '#1d4e73'
  waiting-edge: '#3b7ca8'
  called-soft: '#fbefc9'
  called-strong: '#6b3f00'
  called-edge: '#a35f00'
  serving-soft: '#ddefe6'
  serving-strong: '#14532d'
  serving-edge: '#2e8b57'
  no-show-soft: '#fbe4e1'
  no-show-strong: '#912018'
  no-show-edge: '#c0392b'
  cancelled-soft: '#ecece6'
  cancelled-strong: '#33363f'
  cancelled-edge: '#868b96'
  night-page: '#0b0d12'
  night-surface: '#14171f'
  night-ink: '#eceef2'
  night-lagoon: '#5fc4b2'
  contrast-yellow: '#ffd400'
typography:
  display:
    fontFamily: 'Geist Mono, ui-monospace, monospace'
    fontSize: '4rem'
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: '-0.03em'
  headline:
    fontFamily: 'Geist, system-ui, sans-serif'
    fontSize: '1.75rem'
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: '-0.02em'
  title:
    fontFamily: 'Geist, system-ui, sans-serif'
    fontSize: '1.125rem'
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: 'Geist, system-ui, sans-serif'
    fontSize: '1rem'
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: 'Geist, system-ui, sans-serif'
    fontSize: '0.875rem'
    fontWeight: 600
    lineHeight: 1.4
rounded:
  sm: '6px'
  control: '10px'
  card: '16px'
  xl: '24px'
  full: '9999px'
spacing:
  unit: '4px'
  sm: '8px'
  md: '16px'
  lg: '24px'
  target: '48px'
  target-big: '56px'
components:
  button-primary:
    backgroundColor: '{colors.ink}'
    textColor: '{colors.porcelain}'
    rounded: '{rounded.control}'
    height: '48px'
    padding: '0 16px'
  button-primary-hover:
    backgroundColor: '{colors.ink-hover}'
  button-secondary:
    backgroundColor: '{colors.stone}'
    textColor: '{colors.ink}'
    rounded: '{rounded.control}'
    height: '48px'
    padding: '0 16px'
  button-secondary-hover:
    backgroundColor: '{colors.stone-hover}'
  button-accent:
    backgroundColor: '{colors.lagoon}'
    textColor: '{colors.surface}'
    rounded: '{rounded.control}'
    height: '48px'
    padding: '0 16px'
  button-accent-hover:
    backgroundColor: '{colors.lagoon-hover}'
  button-destructive:
    backgroundColor: '{colors.signal-red}'
    textColor: '{colors.surface}'
    rounded: '{rounded.control}'
    height: '48px'
    padding: '0 16px'
  button-destructive-hover:
    backgroundColor: '{colors.signal-red-hover}'
  button-big:
    backgroundColor: '{colors.ink}'
    textColor: '{colors.porcelain}'
    rounded: '{rounded.control}'
    height: '56px'
    padding: '0 24px'
  card:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink}'
    rounded: '{rounded.card}'
    padding: '16px'
  badge-waiting:
    backgroundColor: '{colors.waiting-soft}'
    textColor: '{colors.waiting-strong}'
    rounded: '{rounded.full}'
    padding: '2px 10px'
  badge-called:
    backgroundColor: '{colors.called-soft}'
    textColor: '{colors.called-strong}'
    rounded: '{rounded.full}'
    padding: '2px 10px'
  input:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink}'
    rounded: '{rounded.control}'
    height: '48px'
    padding: '0 12px'
---

# Design System: QueueThat

> **Status: shipped on `development`.** These are QueueThat design tokens v2 ("Porcelain & Ink"), live in `packages/ui/src/theme.css` with self-hosted Geist and Geist Mono. The favicon, touch icon and PWA icons are the mark (`packages/ui/src/Mark.tsx`: an ink square, a porcelain Q ring and a lagoon dot). Remaining drift: a few screens use raw `bg-white` or `bg-black`. Branches cut before the v2 merge (for example `vercel-config`) still carry the old slate and blue palette.

## Overview

**Creative North Star: "The Quiet Counter"**

A well-run service counter: clear surfaces, plain words, a queue that is easy to read from across the room. Porcelain and ink do the work, one lagoon accent marks the few places that mean "go", and nothing raises its voice except the single thing that needs a person right now, a guest being called.

The system serves a guest on a phone, a staff member mid-conversation on a tablet, an owner at a desk, and a TV across a waiting room. Density stays low, targets stay large, and every state carries a text label and a shape mark as well as a color. Ticket numbers and counts are set in mono so they read as objects, not prose.

**Key Characteristics:**

- Flat and bordered; depth appears only for toasts and dialogs.
- Ink is the primary action color; lagoon is reserved for check-in, links and focus.
- One loud moment: the called state (amber, 2px edge, 5:1 text).
- Three themes: Light (default), Dark, High contrast (kiosk).
- 48 px minimum targets, 56 px for staff console and kiosk.
- No icons beyond the select chevron; Unicode (`×`, `→`, `·`) and text labels instead.

## Colors

A porcelain page, white cards, ink type and one cool green accent, with a separate vocabulary of five queue-state colors.

### Primary

- **Ink** (#15171c): Primary buttons, body text, headlines. Hover steps to #2b2f38.
- **Lagoon** (#0e5e55): Accent for Check in, links and the focus ring. Hover #0a4a43. Text on it is white.

### Secondary

- **Stone** (#e8e8e1): Secondary buttons and quiet fills. Hover #dcdcd3.
- **Signal Red** (#b42318): Destructive actions and errors. Hover #912018.

### Neutral

- **Porcelain** (#f6f6f2): Page background; also the text color on ink buttons.
- **Surface** (#ffffff): Cards, dialogs, inputs.
- **Slate Text** (#4b5160): Muted and hint text.
- **Hairline** (#d9dad3): Card and divider borders.
- **Control Edge** (#868b96): Borders of inputs, selects and checkboxes; at least 3:1 against surface.

### Queue States

Each state has a soft background, a strong text color and an edge, plus a shape mark and a text label.

- **Waiting** (soft #e3eef6, strong #1d4e73, edge #3b7ca8): ring mark.
- **Called** (soft #fbefc9, strong #6b3f00, edge #a35f00): triangle mark; the loudest element on any screen.
- **Serving** (soft #ddefe6, strong #14532d, edge #2e8b57): dot mark.
- **No-show** (soft #fbe4e1, strong #912018, edge #c0392b): × mark.
- **Cancelled** (soft #ecece6, strong #33363f, edge #868b96): dash mark.

### Dark and High contrast

Dark swaps to a night page (#0b0d12), night surface (#14171f), light ink (#eceef2) and a lighter lagoon (#5fc4b2). High contrast (kiosk option, `data-theme="high-contrast"`) is black, white and yellow (#ffd400) with white borders.

### Named Rules

**The One Loud Moment Rule.** Only the called state may use the amber edge and takeover. Everything else stays in ink, porcelain and stone.

**The Never Color Alone Rule.** Every state, badge and banner carries a text label, and each queue state a distinct shape mark.

**The Lagoon Is Rare Rule.** Lagoon marks check-in, links and focus. It is not a decorative or background color.

## Typography

**Display and UI Font:** Geist (with system-ui, sans-serif)
**Mono Font:** Geist Mono (with ui-monospace, monospace)

**Character:** Geist is plain and legible at small sizes. Geist Mono carries tickets and counts, which makes numbers feel like printed tags. No serif.

### Hierarchy

- **Display** (600, 4rem, 1.1, -0.03em, mono): Ticket numbers such as `A012`.
- **Headline** (600, 1.75rem, -0.02em): Page titles.
- **Title** (600, 1.125rem): Section titles, card titles.
- **Body** (400, 1rem, 1.5): Default text; keep line length near 65 to 75ch.
- **Label** (600, 0.875rem): Badges, field labels, hints.

The scale is 12, 14, 16, 18, 22, 28, 36 and 64 px. 48 and 36 px sizes remain only for the TV board.

### Named Rules

**The Sentence Case Rule.** Buttons, titles and labels are sentence case; no Title Case, no all caps.

**The Numbers Are Objects Rule.** Tickets, counts and times are set in Geist Mono.

## Layout

A 4 px grid. Guest screens are a single column no wider than 32rem with no navigation. The staff console is tablet-first from 768 to 1280 px with an 80rem maximum. Admin content tops out at 64rem. Display and kiosk screens are full-bleed with no chrome. Hit targets are 48 px everywhere and 56 px on the staff console and kiosk.

## Elevation & Depth

Flat by default. Cards use a 1 px hairline border and no shadow. Two shadow levels exist, and only for things that float over the page.

### Shadow Vocabulary

- **Raised** (`box-shadow: 0 1px 2px rgb(21 23 28 / 0.06), 0 2px 8px rgb(21 23 28 / 0.08)`): Toasts. These values are proposed; the token sheet names the level only.
- **Overlay** (`box-shadow: 0 12px 32px rgb(21 23 28 / 0.18), 0 2px 6px rgb(21 23 28 / 0.1)`): Dialogs, over a black 50% backdrop.

### Named Rules

**The Flat At Rest Rule.** A surface has no shadow until it floats over another.

## Shapes

Gently rounded and plain. Radii are 6 px (checkbox, small), 10 px (buttons, inputs, tabs), 16 px (cards, dialogs, panels, toasts), 24 px (extra large) and fully round for pills and badges. Borders are 1 px; the called card uses a 2 px edge.

## Components

### Buttons

- **Shape:** Gently rounded (10 px), at least 48 px tall, 16 px horizontal padding, semibold.
- **Primary:** Ink fill, porcelain text. Hover steps to #2b2f38.
- **Secondary:** Stone fill, ink text.
- **Accent:** Lagoon fill, white text; used for Check in.
- **Destructive:** Signal red fill, white text.
- **Big:** 56 px tall and full width for the staff console and kiosk.
- **States:** Color transitions only (120 ms), no press scale; disabled at 60% opacity; a loading button shows a spinner and a screen-reader label.

### Cards / Containers

- **Corner Style:** 16 px.
- **Background:** Surface with a 1 px hairline border.
- **Shadow Strategy:** None at rest.
- **Internal Padding:** 16 px.
- **Called variant:** 2 px called-edge border and called-soft fill.

### Inputs / Fields

- **Style:** Surface fill, 1 px control-edge border, 10 px radius, 48 px tall.
- **Focus:** 3 px lagoon ring with a 2 px offset (`:focus-visible`).
- **Labels:** Always visible; optional fields say so in the label. Placeholders are never labels.

### Badges

- **Style:** Fully round pill, 2px by 10px padding, semibold 14 px, soft background with strong text.
- **Use:** Visit status via the five queue-state tones; tone badges for info, success, warning and danger.

### Dialogs and Confirmations

- **Style:** 16 px radius, overlay shadow, black 50% backdrop.
- **Copy:** A question title, a consequence body, and button labels that restate the choice ("Yes, leave" / "Stay in line").

### Toasts

- **Style:** 16 px radius, raised shadow, `×` dismiss; carries an Undo where an action can be reversed.

## Do's and Don'ts

### Do:

- **Do** use ink for primary actions and reserve lagoon for check-in, links and focus.
- **Do** give every state a text label and a shape mark as well as a color.
- **Do** keep targets at 48 px or more, and 56 px on the staff console and kiosk.
- **Do** set ticket numbers and counts in Geist Mono.
- **Do** use sentence case, contractions and plain, specific copy ("Couldn't join. Check your connection and try again.").
- **Do** use `ConfirmDestructive` or offer undo for destructive actions.

### Don't:

- **Don't** use gradients, textures, illustrations or emoji.
- **Don't** use exclamation marks or marketing voice inside the product.
- **Don't** add shadows to cards at rest.
- **Don't** introduce icons; use text labels first and flag the need if one is unavoidable.
- **Don't** use the called amber anywhere but the called state.
- **Don't** use raw palette classes such as `bg-white` or `bg-black`; use the semantic tokens.
