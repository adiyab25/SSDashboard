import type { ReactNode } from 'react';
import { cn } from 'cn';
import { rowStripeClassName } from '../lib/row-stripe';

type MetricSplit = {
  /** The already translated name of the part, such as "Bosta". */
  label: string;
  /** The already formatted number or money for that part. */
  value: ReactNode;
};

type MetricCardProps = Omit<React.ComponentProps<'a'>, 'children' | 'href'> & {
  /** The already translated name of the number, such as "Cash owed to you". */
  label: string;
  /** The number itself, already formatted by the app. A provisional card expects a `ProvisionalValue`. */
  value: ReactNode;
  /** One short line under the number, already translated (optional). */
  detail?: string;
  /** Parts that add up to the number, shown under it (such as Bosta and partners). */
  split?: MetricSplit[];
  /** The drill down page. The whole card is this one link; there is no other target inside. */
  href: string;
  /** True for a number that is not confirmed yet: a dashed card with no fill. */
  provisional?: boolean;
  /** `owed` adds the decorative start edge in the owed role; the label and chip still say it. */
  emphasis?: 'owed';
  /** `lg` is the big first number; `md` fits two cards side by side on a phone. */
  size?: 'lg' | 'md';
};

/**
 * One number on the phone first dashboard, drawn as a single link to its drill down page (AC-20).
 * The label comes first, then the number in a large tabular figure, then an optional detail line
 * and split. A provisional card is dashed (`border-dashed border-input`, no fill) and expects the
 * value to be a `ProvisionalValue`, so the `≈` and the hidden word come from that part. The card
 * is never a hover reveal, always shows its focus ring, and is at least 44px tall on touch. It
 * must never nest another link or button, format numbers itself, or carry text of its own.
 */
export function MetricCard({
  label,
  value,
  detail,
  split,
  href,
  provisional = false,
  emphasis,
  size = 'md',
  className,
  ...rest
}: MetricCardProps) {
  return (
    <a
      {...rest}
      href={href}
      data-slot="metric-card"
      data-provisional={provisional ? '' : undefined}
      className={cn(
        'focus-ring block min-h-touch rounded-lg border p-4 text-card-foreground transition-colors hover:bg-muted/50',
        provisional ? 'border-dashed border-input bg-transparent' : 'border-border bg-card',
        emphasis === 'owed' && rowStripeClassName('owed'),
        className,
      )}
    >
      <span className="block text-sm text-muted-foreground">{label}</span>
      <span
        className={cn(
          'mt-1 block font-semibold tabular-nums',
          size === 'lg' ? 'text-3xl' : 'text-2xl',
        )}
      >
        {value}
      </span>
      {detail ? <span className="mt-1 block text-xs text-muted-foreground">{detail}</span> : null}
      {split && split.length > 0 ? (
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t pt-3 text-sm">
          {split.map((part) => (
            <div key={part.label} className="flex items-baseline gap-2">
              <dt className="text-muted-foreground">{part.label}</dt>
              <dd className="font-medium tabular-nums">{part.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </a>
  );
}
