import type { StatusMeaning } from './status-meaning';

/**
 * The classes for a decorative colored edge on the start side of a table row or card, one per
 * meaning (provisional is dashed, like every provisional boundary). It is decorative only: the
 * `StatusChip` in the row always repeats the meaning with an icon and a word, and the default
 * Daftar table (option B) does not use the stripe. Apply it to a cell or a wrapper, not to a `tr`
 * with collapsed borders. It must never be the only carrier of a status.
 */
export function rowStripeClassName(meaning: StatusMeaning): string {
  switch (meaning) {
    case 'confirmed':
      return 'border-s-4 border-s-confirmed';
    case 'failed':
      return 'border-s-4 border-s-failed';
    case 'owed':
      return 'border-s-4 border-s-owed';
    case 'provisional':
      return 'border-s-4 border-dashed border-s-input';
    default: {
      const unreachable: never = meaning;
      return unreachable;
    }
  }
}
