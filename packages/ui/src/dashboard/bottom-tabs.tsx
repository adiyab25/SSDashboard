import type { ReactNode } from 'react';
import { cn } from 'cn';

/** The most tabs the bar draws; more would not fit a 320px phone with a visible label each. */
export const BOTTOM_TABS_MAX = 4;

type BottomTab = {
  /** The visible, already translated label. Always shown, never icon only. */
  label: string;
  /** The page the tab opens. */
  href: string;
  /** A decorative icon (the bar marks it `aria-hidden`). */
  icon: ReactNode;
  /** True for the page the user is on; sets `aria-current="page"` and the primary fill. */
  current?: boolean;
};

type BottomTabsProps = {
  /** The accessible name of the navigation, already translated ("Main"). */
  label: string;
  /** The tabs in reading order; only the first four are drawn. */
  tabs: BottomTab[];
  className?: string;
};

/**
 * The phone's bottom navigation: a `nav` of at most four equal tabs (Today, Orders, Cash, More),
 * 56px tall, each with an icon and a label that is always visible (AC-20). The current tab is
 * filled with the primary and marked `aria-current="page"`. A fifth tab is dropped, not squeezed
 * in: the bar keeps the first four and the caller must move the rest into its "More" page. It is
 * fixed to the bottom and respects the device safe area, so the page must also render a
 * `BottomTabsSpacer` at the end of its content or the bar covers the last targets; hide both from
 * 768px up with `md:hidden` where the sidebar takes over. It must never show an icon without its label or hold text of
 * its own.
 */
export function BottomTabs({ label, tabs, className }: BottomTabsProps) {
  const shown = tabs.slice(0, BOTTOM_TABS_MAX);
  return (
    <nav
      aria-label={label}
      data-slot="bottom-tabs"
      className={cn(
        'fixed inset-x-0 bottom-0 z-30 border-t bg-background pb-[env(safe-area-inset-bottom)]',
        className,
      )}
    >
      <ul className="flex">
        {shown.map((tab) => (
          <li key={tab.href} className="min-w-0 flex-1">
            <a
              href={tab.href}
              aria-current={tab.current ? 'page' : undefined}
              className={cn(
                'focus-ring-inset flex h-14 flex-col items-center justify-center gap-0.5 px-1 text-xs font-medium [&_svg]:size-5 [&_svg]:shrink-0',
                tab.current
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <span aria-hidden="true" className="flex">
                {tab.icon}
              </span>
              <span className="max-w-full truncate">{tab.label}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
