import { cn } from 'cn';

/** Pulsing placeholder block shown while content loads. */
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn('pulse-ui rounded-chip bg-muted', className)}
      {...props}
    />
  );
}

export { Skeleton };
