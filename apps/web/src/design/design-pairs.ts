import type { ContrastPairSpec } from './contrast-pair';

/**
 * The text and control pairs of spec 0025, "Measured contrast, text and controls". Text needs
 * 4.5:1; control boundaries and the focus ring 3:1 (WCAG 2.2 AA). "Control fill" is `muted`. Three
 * pairs of that table are not here because the rule forbids them: in light, a link, the owed text,
 * and the confirmed text never sit on `accent` (AC-5). They are shown with the light accent choice
 * (`ACCENT_OPTION_A_PAIRS`), where they are labelled as expected to fail.
 */
export const TEXT_AND_CONTROL_PAIRS: readonly ContrastPairSpec[] = [
  { fg: 'foreground', bg: 'background', min: 4.5 },
  { fg: 'foreground', bg: 'card', min: 4.5 },
  { fg: 'foreground', bg: 'muted', min: 4.5 },
  { fg: 'foreground', bg: 'accent', min: 4.5 },
  { fg: 'foreground', bg: 'sidebar', min: 4.5 },
  { fg: 'foreground', bg: 'popover', min: 4.5 },
  { fg: 'muted-foreground', bg: 'background', min: 4.5 },
  { fg: 'muted-foreground', bg: 'card', min: 4.5 },
  { fg: 'muted-foreground', bg: 'muted', min: 4.5 },
  { fg: 'muted-foreground', bg: 'accent', min: 4.5 },
  { fg: 'muted-foreground', bg: 'sidebar', min: 4.5 },
  { fg: 'primary', bg: 'background', min: 4.5 },
  { fg: 'primary', bg: 'card', min: 4.5 },
  { fg: 'primary-foreground', bg: 'primary', min: 4.5 },
  { fg: 'confirmed', bg: 'background', min: 4.5 },
  { fg: 'confirmed', bg: 'card', min: 4.5 },
  { fg: 'confirmed', bg: 'confirmed-surface', min: 4.5 },
  { fg: 'owed', bg: 'background', min: 4.5 },
  { fg: 'owed', bg: 'card', min: 4.5 },
  { fg: 'owed', bg: 'owed-surface', min: 4.5 },
  { fg: 'failed', bg: 'background', min: 4.5 },
  { fg: 'failed', bg: 'card', min: 4.5 },
  { fg: 'failed', bg: 'failed-surface', min: 4.5 },
  { fg: 'provisional', bg: 'card', min: 4.5 },
  { fg: 'destructive', bg: 'destructive-surface', min: 4.5 },
  { fg: 'foreground', bg: 'destructive-surface', min: 4.5 },
  { fg: 'destructive', bg: 'accent', min: 4.5 },
  { fg: 'success-foreground', bg: 'success', min: 4.5 },
  { fg: 'warning-foreground', bg: 'warning', min: 4.5 },
  { fg: 'destructive-foreground', bg: 'destructive', min: 4.5 },
  // The toast is inverted: `background` text on a `foreground` fill.
  { fg: 'background', bg: 'foreground', min: 4.5, id: 'toast-text' },
  { fg: 'ring', bg: 'background', min: 3 },
  { fg: 'ring', bg: 'card', min: 3 },
  { fg: 'ring', bg: 'muted', min: 3 },
  { fg: 'ring', bg: 'sidebar', min: 3 },
  { fg: 'ring', bg: 'accent', min: 3 },
  { fg: 'input', bg: 'background', min: 3 },
  { fg: 'input', bg: 'card', min: 3 },
  { fg: 'input', bg: 'muted', min: 3 },
  { fg: 'input', bg: 'sidebar', min: 3 },
  // The selected segment border against the `card` track (AC-9).
  { fg: 'input', bg: 'card', min: 3, id: 'segmented-border' },
  { fg: 'destructive', bg: 'background', min: 3, id: 'error-boundary' },
  { fg: 'destructive', bg: 'destructive-surface', min: 3, id: 'error-toast-border' },
  { fg: 'primary-edge', bg: 'background', min: 3 },
  { fg: 'primary-edge', bg: 'card', min: 3 },
];

/**
 * Tints are translucent, so each one is measured painted over the surface it sits on (the card
 * or the sidebar), with the text that really appears on it (spec 0025, "Gradient stops behind or
 * inside text"). The selected row and the current page tints are measured at their strongest
 * stop, which is the start edge.
 */
export const TINT_PAIRS: readonly ContrastPairSpec[] = [
  {
    fg: 'foreground',
    bg: 'stops-selected-row@0',
    over: 'card',
    min: 4.5,
    id: 'selected-row-foreground',
  },
  { fg: 'primary', bg: 'stops-selected-row@0', over: 'card', min: 4.5, id: 'selected-row-link' },
  { fg: 'warning', bg: 'stops-selected-row@0', over: 'card', min: 4.5, id: 'selected-row-owed' },
  {
    fg: 'muted-foreground',
    bg: 'stops-selected-row@0',
    over: 'card',
    min: 4.5,
    id: 'selected-row-muted',
  },
  {
    fg: 'foreground',
    bg: 'stops-current-page@0',
    over: 'sidebar',
    min: 4.5,
    id: 'current-page-foreground',
  },
  { fg: 'stops-marker@0', bg: 'sidebar', min: 3, id: 'marker-start' },
  { fg: 'stops-marker@1', bg: 'sidebar', min: 3, id: 'marker-end' },
  { fg: 'muted-foreground', bg: 'tint-nav', over: 'sidebar', min: 4.5, id: 'nav-hover-muted' },
  { fg: 'muted-foreground', bg: 'tint-row', over: 'card', min: 4.5, id: 'row-hover-muted' },
  { fg: 'warning', bg: 'tint-row', over: 'card', min: 4.5, id: 'row-hover-owed' },
  { fg: 'foreground', bg: 'tint-row', over: 'card', min: 4.5, id: 'row-hover-foreground' },
];

/** The gradient variables whose every stop sits behind text or is text, and how each is measured. */
export const STOP_GROUPS = [
  // The main button: `primary-foreground` text on every stop of the blend, 4.5:1.
  { name: 'primary', variable: 'stops-primary', kind: 'behind-text' },
  // The hero tile: `primary-foreground` text on every stop, 4.5:1.
  { name: 'hero', variable: 'stops-hero', kind: 'behind-text' },
  // The h1 fill: each stop is large text, 3:1 on the page and on a card.
  { name: 'heading', variable: 'stops-heading', kind: 'is-text' },
] as const;

/** The candidate for the light accent (option B of spec 0025, AC-17); not a token. */
export const CANDIDATE_ACCENT = '#E9EEF4';

/**
 * Option A of the light accent choice, the current rule: `accent` (`#DCE5EE`) carries only
 * `foreground` and `muted-foreground` text (the first two pass); the next three show why a link,
 * the confirmed text, and the owed text are refused there and are expected to fail. Row hover is
 * the ink tint, where the link and the owed text pass.
 */
export const ACCENT_OPTION_A_PAIRS: readonly ContrastPairSpec[] = [
  { fg: 'foreground', bg: 'accent', min: 4.5, id: 'a-foreground', prefix: 'compare' },
  { fg: 'muted-foreground', bg: 'accent', min: 4.5, id: 'a-muted', prefix: 'compare' },
  { fg: 'primary', bg: 'accent', min: 4.5, id: 'a-link', prefix: 'compare' },
  { fg: 'confirmed', bg: 'accent', min: 4.5, id: 'a-confirmed', prefix: 'compare' },
  { fg: 'owed', bg: 'accent', min: 4.5, id: 'a-owed', prefix: 'compare' },
  { fg: 'primary', bg: 'tint-row', over: 'card', min: 4.5, id: 'a-hover-link', prefix: 'compare' },
  { fg: 'owed', bg: 'tint-row', over: 'card', min: 4.5, id: 'a-hover-owed', prefix: 'compare' },
];

/** Option B: `accent` lightened to the candidate, which would let a link and status text sit on it. */
export const ACCENT_OPTION_B_PAIRS: readonly ContrastPairSpec[] = [
  { fg: 'foreground', bg: CANDIDATE_ACCENT, min: 4.5, id: 'b-foreground', prefix: 'compare' },
  { fg: 'muted-foreground', bg: CANDIDATE_ACCENT, min: 4.5, id: 'b-muted', prefix: 'compare' },
  { fg: 'primary', bg: CANDIDATE_ACCENT, min: 4.5, id: 'b-link', prefix: 'compare' },
  { fg: 'confirmed', bg: CANDIDATE_ACCENT, min: 4.5, id: 'b-confirmed', prefix: 'compare' },
  { fg: 'owed', bg: CANDIDATE_ACCENT, min: 4.5, id: 'b-owed', prefix: 'compare' },
  { fg: 'failed', bg: CANDIDATE_ACCENT, min: 4.5, id: 'b-failed', prefix: 'compare' },
];
