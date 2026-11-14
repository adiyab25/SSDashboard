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
  'inline-flex h-6 shrink-0 items-center gap-1 rounded-chip border px-2 font-mono text-xs font-normal whitespace-nowrap lowercase [&_svg]:size-3.5 [&_svg]:shrink-0';

/**
 * The text colour for one meaning (full class names so Tailwind finds them). The surface is the
 * control fill for every meaning; only the text and the icon glow carry the colour. Never cyan.
 */
function chipClassName(meaning: StatusMeaning): string {
  switch (meaning) {
    case 'confirmed':
      return 'border-border-strong bg-confirmed-surface text-confirmed [&_svg]:drop-shadow-[0_0_8px_var(--confirmed)]';
    case 'failed':
      return 'border-border-strong bg-failed-surface text-failed [&_svg]:drop-shadow-[0_0_8px_var(--failed)]';
    case 'owed':
      return 'border-border-strong bg-owed-surface text-owed [&_svg]:drop-shadow-[0_0_8px_var(--owed)]';
    case 'provisional':
      return 'border-dashed border-input bg-provisional-surface text-provisional [&_svg]:drop-shadow-[0_0_8px_var(--provisional)]';
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
 * A 24px chip (control fill, 1px strong border, lowercase mono text in the meaning colour, a glowing icon) that shows order or cash state as an icon plus a word, never color alone
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
