/**
 * The four meaning roles that show order and cash state (spec 0003, AC-16): confirmed, failed
 * delivery, cash owed, and not yet confirmed. Each maps to a color role token, an icon, and a
 * word chosen by the caller. It must never gain a fifth value without a new token in `globals.css`
 * and a row in DESIGN.md.
 */
export type StatusMeaning = 'confirmed' | 'failed' | 'owed' | 'provisional';

/** Every meaning, in the order DESIGN.md lists them; for tests and galleries that cover all four. */
export const STATUS_MEANINGS: readonly StatusMeaning[] = [
  'confirmed',
  'failed',
  'owed',
  'provisional',
];
