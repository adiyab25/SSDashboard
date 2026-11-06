import { Clock } from 'lucide-react';
import { cn } from 'cn';

type FreshnessStripProps = {
  /** The whole sentence, composed and translated by the caller. */
  text: string;
  className?: string;
};

/**
 * The quiet strip under every dashboard and report header that says how fresh the numbers are,
 * for example "Confirmed through 4 Nov, today is provisional". It is a muted band with a
 * decorative clock. It must never compose the sentence itself, and never carry a meaning color.
 */
export function FreshnessStrip({ text, className }: FreshnessStripProps) {
  return (
    <p
      data-slot="freshness-strip"
      className={cn(
        'flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground',
        className,
      )}
    >
      <Clock aria-hidden="true" className="size-3.5 shrink-0" />
      <span>{text}</span>
    </p>
  );
}
