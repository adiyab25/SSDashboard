import { cn } from 'cn';

type ProvisionalValueProps = {
  /** The already formatted number or money, such as "1,240 EGP". */
  value: string;
  /** The screen reader word for "provisional", already translated. */
  provisionalLabel: string;
  className?: string;
};

/**
 * A value that is not yet confirmed (AC-17): a leading `≈` inside a `bdi` so it stays first in
 * right to left, a dashed boundary on a transparent surface, `tabular-nums`, and a visually
 * hidden label for screen readers. The `≈` is decorative to them because the label already says
 * it. It must never use a solid border or fill, and never format the value itself (the app does).
 */
export function ProvisionalValue({ value, provisionalLabel, className }: ProvisionalValueProps) {
  return (
    <span
      data-slot="provisional-value"
      className={cn(
        'inline-flex items-baseline rounded-chip border border-dashed border-input bg-provisional-surface px-1.5 text-muted-foreground tabular-nums',
        className,
      )}
    >
      <bdi>
        <span aria-hidden="true" className="me-1">
          ≈
        </span>
        {value}
      </bdi>
      <span className="sr-only">{provisionalLabel}</span>
    </span>
  );
}
