import { cn } from 'cn';

/**
 * Empty space as tall as the fixed `BottomTabs` bar: 56px plus the device safe area plus a 16px
 * gap. Render it as the last child of a phone page's content so the bar never covers a target
 * (the last "Needs you" row stays tappable and axe `target-size` stays clean). It is hidden from
 * assistive technology and takes `md:hidden` through `className` where the bar is hidden. It
 * must never hold content or be left out of a page that renders `BottomTabs`.
 */
export function BottomTabsSpacer({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      data-slot="bottom-tabs-spacer"
      className={cn('h-[calc(3.5rem+env(safe-area-inset-bottom)+1rem)]', className)}
    />
  );
}
