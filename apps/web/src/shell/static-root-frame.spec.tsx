import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AppShell } from '@/shell/app-shell';
import { CurrentLocationProvider } from '@/shell/current-location-provider';
import { rootMetadata } from './root-metadata';
import { StaticRootFrame } from './static-root-frame';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('next/font/local', () => ({
  default: (options: { variable: string }) => ({ variable: options.variable.slice(2) }),
}));

const render = (children: React.ReactNode) =>
  renderToStaticMarkup(<StaticRootFrame>{children}</StaticRootFrame>);

describe('StaticRootFrame', () => {
  it('titles every page SSDashboard', () => {
    expect(rootMetadata.title).toBe('SSDashboard');
  });

  // The server markup is always English left to right; the saved language is applied after hydration.
  it('declares English and left to right on the document', () => {
    expect(render('page')).toMatch(/^<html lang="en" dir="ltr"/);
  });

  it('exposes both font families as CSS variables on the document', () => {
    expect(render('page')).toMatch(
      /^<html[^>]* class="font-inter font-noto-arabic font-jetbrains-mono"/,
    );
  });

  it('sets the saved language and direction before first paint, in every build', () => {
    const html = render('page');

    expect(html).toContain('ss_lang');
    expect(html).toContain('data-i18n');
    expect(html).not.toContain('ss_dir');
  });

  it('puts the skip link before the navigation and the page', () => {
    // The shell lives in the (backoffice) layout; the skip link stays here, ahead of every route group.
    const html = render(
      <CurrentLocationProvider>
        <AppShell>
          <h1>page</h1>
        </AppShell>
      </CurrentLocationProvider>,
    );
    const skip = html.indexOf('<a href="#main-content"');

    expect(html).toMatch(/<a href="#main-content"[^>]*>Skip to main content<\/a>/);
    expect(skip).toBeGreaterThan(-1);
    expect(skip).toBeLessThan(html.indexOf('<header'));
    expect(skip).toBeLessThan(html.indexOf('<main'));
  });

  it('does not draw the app shell itself, so the sign in screens stay outside it', () => {
    const html = render(<p>sign in</p>);

    expect(html).not.toContain('<header');
    expect(html).not.toContain('<nav');
  });

  it('renders the page inside the body', () => {
    expect(render(<p>page content</p>)).toContain('<p>page content</p>');
  });

  // Bug found in milestone 3 verify: without the Activity boundary the whole shell hydrated in the
  // root's slow pass and early typing was lost. renderToString (React 19.3) marks an Activity as
  // `<!--&-->` ... `<!--/&-->`; renderToStaticMarkup writes nothing, so it cannot show it.
  it('wraps the page in an Activity boundary so it hydrates as its own unit', () => {
    const html = renderToString(
      <StaticRootFrame>
        <p>page content</p>
      </StaticRootFrame>,
    );

    expect(html).toContain('<!--&--><p>page content</p><!--/&-->');
  });
});
