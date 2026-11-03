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

  // Feature 5 (localization) will switch these; until then English, left to right.
  it('declares English and left to right on the document', () => {
    expect(render('page')).toMatch(/^<html lang="en" dir="ltr"/);
  });

  it('exposes both font families as CSS variables on the document', () => {
    expect(render('page')).toMatch(/^<html[^>]* class="plex-sans plex-arabic"/);
  });

  it('sets the stored direction before first paint outside production', () => {
    expect(render('page')).toContain("localStorage.getItem('ss_dir')");
  });

  it('makes the skip link the first element in the body', () => {
    expect(render('page')).toMatch(/<body><a href="#main-content"[^>]*>Skip to main content<\/a>/);
  });

  it('renders the page inside the body', () => {
    expect(render(<p>page content</p>)).toContain('<p>page content</p>');
  });
});
