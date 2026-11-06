import { Check, ClockFading, Coins, X } from 'lucide-react';
import { cn } from 'cn';
import type { StatusMeaning } from '../lib/status-meaning';

type StatusChipProps = {
  /** Which of the four meaning roles to draw. */
  meaning: StatusMeaning;
  /** The word shown beside the icon, already translated by the app. Required and non empty. */
  label: string;
  className?: string;
};

const BASE =
  'inline-flex h-6 shrink-0 items-center gap-1 rounded-sm px-2 text-xs font-medium whitespace-nowrap [&_svg]:size-3.5 [&_svg]:shrink-0';

/** The tinted surface and text classes for one meaning (full class names so Tailwind finds them). */
function chipClassName(meaning: StatusMeaning): string {
  switch (meaning) {
    case 'confirmed':
      return 'bg-confirmed-surface text-confirmed';
    case 'failed':
      return 'bg-failed-surface text-failed';
    case 'owed':
      return 'bg-owed-surface text-owed';
    case 'provisional':
      return 'border border-dashed border-input bg-provisional-surface text-provisional';
    default: {
      const unreachable: never = meaning;
      return unreachable;
    }
  }
}

/** The decorative icon for one meaning: check, cross, coin, and a fading clock for provisional. */
function chipIcon(meaning: StatusMeaning) {
  switch (meaning) {
    case 'confirmed':
      return <Check aria-hidden="true" />;
    case 'failed':
      return <X aria-hidden="true" />;
    case 'owed':
      return <Coins aria-hidden="true" />;
    case 'provisional':
      return <ClockFading aria-hidden="true" />;
    default: {
      const unreachable: never = meaning;
      return unreachable;
    }
  }
}

/**
 * A 24px tinted chip that shows order or cash state as an icon plus a word, never color alone
 * (AC-16). The icon is decorative; the word carries the meaning. A blank or whitespace only label
 * renders nothing, so a chip can never appear as a bare colored pill; callers must pass the
 * translated word. It must never hold text of its own, take a brand accent, or mix meanings.
 */
export function StatusChip({ meaning, label, className }: StatusChipProps) {
  if (label.trim() === '') {
    return null;
  }
  return (
    <span
      data-slot="status-chip"
      data-meaning={meaning}
      className={cn(BASE, chipClassName(meaning), className)}
    >
      {chipIcon(meaning)}
      {label}
    </span>
  );
}
