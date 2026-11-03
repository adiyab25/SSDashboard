import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import RootLayout, { metadata } from './layout';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('next/font/google', () => ({
  IBM_Plex_Sans: () => ({ variable: 'plex-sans' }),
  IBM_Plex_Sans_Arabic: () => ({ variable: 'plex-arabic' }),
}));

const render = (children: React.ReactNode) =>
  renderToStaticMarkup(<RootLayout params={Promise.resolve({})}>{children}</RootLayout>);

describe('RootLayout', () => {
  it('titles every page SSDashboard', () => {
    expect(metadata.title).toBe('SSDashboard');
  });

  // The server markup is always English left to right; the saved language is applied after hydration.
  it('declares English and left to right on the document', () => {
    expect(render('page')).toMatch(/^<html lang="en" dir="ltr"/);
  });

  it('exposes both font families as CSS variables on the document', () => {
    expect(render('page')).toMatch(/^<html[^>]* class="plex-sans plex-arabic"/);
  });

  it('sets the saved language and direction before first paint, in every build', () => {
    const html = render('page');

    expect(html).toContain('ss_lang');
    expect(html).toContain('data-i18n');
    expect(html).not.toContain('ss_dir');
  });

  it('puts the skip link before the navigation and the page', () => {
    const html = render('page');
    const skip = html.indexOf('<a href="#main-content"');

    expect(html).toMatch(/<a href="#main-content"[^>]*>Skip to main content<\/a>/);
    expect(skip).toBeGreaterThan(-1);
    expect(skip).toBeLessThan(html.indexOf('<header'));
    expect(skip).toBeLessThan(html.indexOf('<main'));
  });

  it('renders the page inside the body', () => {
    expect(render(<p>page content</p>)).toContain('<p>page content</p>');
  });
});
