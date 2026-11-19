import type { ReactNode } from 'react';
import { brandStyle, type FrameBrand } from '../lib/brand-tokens';
import { BrandMark } from './brand-mark';

/** One top navigation entry of the partner frame. */
export type PartnerNavItem = {
  /**
   * A stable unique key for the entry. Optional: without it the key is the href plus the position,
   * so two entries may share an href; pass an id when the list can reorder.
   */
  id?: string;
  /** The link text, already translated. */
  label: string;
  href: string;
  /** True for the page being shown; it gets `aria-current="page"`. */
  current?: boolean;
};

type PartnerFrameProps = {
  /** The brand: name, optional logo, optional accepted accent tokens. */
  brand: FrameBrand;
  /** The partner's own name, shown in the top bar. */
  partnerName: string;
  /** The page title, rendered as the one `h1`, already translated. */
  title: string;
  /** The navigation entries (statements, stock at your location, settlement), in order. */
  navItems: readonly PartnerNavItem[];
  /** The accessible name of the navigation landmark, already translated. */
  navLabel: string;
  /** Optional controls at the end of the top bar, such as the language switch. */
  actions?: ReactNode;
  /** The page content. */
  children: ReactNode;
};

/**
 * The consignment partner frame (AC-18): a top bar with the brand logo and the partner's name,
 * a top navigation of plain links (`aria-current="page"` on the current one), and the page's one
 * `main` (id `main-content`) holding the one `h1`. The brand accent colours only the logo tile; the
 * current link gets the cyan current page tint and a 2px cyan mark at its bottom edge. On a phone
 * the bar wraps and the navigation scrolls inside itself, so the page never scrolls sideways. It
 * must never hold a sidebar, location switcher, or command palette, import `next/*`, or show
 * cost columns (that is the page's job).
 */
export function PartnerFrame({
  brand,
  partnerName,
  title,
  navItems,
  navLabel,
  actions,
  children,
}: PartnerFrameProps) {
  return (
    <div
      data-slot="partner-frame"
      style={brandStyle(brand.tokens)}
      className="min-h-dvh w-full overflow-x-clip bg-background text-foreground"
    >
      <header className="border-b bg-background">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
          <BrandMark brand={brand} />
          <div className="flex min-w-0 items-center gap-3">
            <span className="truncate text-sm text-muted-foreground">{partnerName}</span>
            {actions ? <div className="shrink-0">{actions}</div> : null}
          </div>
        </div>
        <nav aria-label={navLabel} className="mx-auto w-full max-w-5xl overflow-x-auto px-4">
          <ul className="flex w-max min-w-full gap-1">
            {navItems.map((item, index) => (
              <li key={item.id ?? `${item.href}-${index}`}>
                <a
                  href={item.href}
                  aria-current={item.current ? 'page' : undefined}
                  className="focus-ring-inset transition-ui relative flex h-11 items-center rounded-chip px-3 text-sm whitespace-nowrap text-muted-foreground hover:tint-nav hover:text-foreground aria-[current=page]:gradient-current-page aria-[current=page]:font-medium aria-[current=page]:text-foreground aria-[current=page]:before:absolute aria-[current=page]:before:inset-x-3 aria-[current=page]:before:bottom-0 aria-[current=page]:before:h-0.5 aria-[current=page]:before:rounded-full aria-[current=page]:before:gradient-current-marker aria-[current=page]:before:content-['']"
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6 outline-none"
      >
        <h1 className="text-xl font-semibold text-balance">{title}</h1>
        {children}
      </main>
    </div>
  );
}
