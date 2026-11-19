import type { ReactNode } from 'react';
import { brandStyle, type FrameBrand } from '../lib/brand-tokens';
import { BrandMark } from './brand-mark';

type PortalFrameProps = {
  /** The brand: name, optional logo, optional accepted accent tokens. */
  brand: FrameBrand;
  /** The page title, rendered as the one `h1`, already translated. */
  title: string;
  /** The language switch, an app specific control; rendered at the end of the header. */
  languageSwitch?: ReactNode;
  /** An optional back link, rendered above the title; links are app specific. */
  backLink?: ReactNode;
  /** The page content, one column. */
  children: ReactNode;
};

/**
 * The customer facing portal frame (AC-18): a 6px brand top rule, a header with the logo tile,
 * brand name and language switch, then one centred 20rem column holding an optional back link,
 * the `h1`, and the page. It renders the page's one `main` (id `main-content`, so a skip link can
 * target it) and the one `h1`. When `brand.tokens` is set it puts `--brand` and
 * `--brand-foreground` on its root; the accent colours only the tile, the rule, and the main
 * button the app draws with `<Button variant="brand">`. It must never hold a sidebar, command
 * palette, or staff navigation, import `next/*`, or let the accent reach status, text, links, or
 * the focus ring.
 */
export function PortalFrame({
  brand,
  title,
  languageSwitch,
  backLink,
  children,
}: PortalFrameProps) {
  return (
    <div
      data-slot="portal-frame"
      style={brandStyle(brand.tokens)}
      className="min-h-dvh w-full overflow-x-clip bg-background text-foreground"
    >
      <div aria-hidden="true" className="h-1.5 w-full bg-brand" />
      <header className="mx-auto flex w-full max-w-88 items-center justify-between gap-3 px-4 py-4">
        <BrandMark brand={brand} />
        {languageSwitch ? <div className="shrink-0">{languageSwitch}</div> : null}
      </header>
      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto flex w-full max-w-88 flex-col gap-4 px-4 pb-10 outline-none"
      >
        {backLink ? <div>{backLink}</div> : null}
        <h1 className="text-xl font-semibold text-balance">{title}</h1>
        {children}
      </main>
    </div>
  );
}
