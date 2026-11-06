import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { flatten } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { PublicRootFrame } from './public-root-frame';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn() }),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

vi.mock('next/font/google', () => ({
  Inter: () => ({ variable: 'font-inter' }),
  Noto_Sans_Arabic: () => ({ variable: 'font-noto-arabic' }),
  JetBrains_Mono: () => ({ variable: 'font-jetbrains-mono' }),
}));

const render = (segment: string | undefined) =>
  renderToStaticMarkup(
    <PublicRootFrame segment={segment}>
      <h1>page</h1>
    </PublicRootFrame>,
  );

describe('PublicRootFrame', () => {
  it.each([
    ['en', 'ltr'],
    ['ar', 'rtl'],
  ])('puts %s and %s on the document, on the server', (lang, dir) => {
    expect(render(lang)).toMatch(new RegExp(`^<html lang="${lang}" dir="${dir}"`));
  });

  it('renders the skip link in the page language, with no head script and no hidden body', () => {
    const html = render('ar');

    expect(html).toContain(`>${flatten(ar)['shell.skipLink']}<`);
    expect(html).not.toContain('ss_lang');
    expect(html).not.toContain('data-i18n');
  });

  it('renders no main landmark: the page frame owns it, and the skip link has its target there', () => {
    const html = render('en');

    expect(html).not.toContain('<main');
    expect(html).toContain('href="#main-content"');
    expect(html).not.toContain('<nav');
    expect(html).not.toContain('<header');
  });

  it.each(['fr', 'EN', '', undefined, '<script>'])('is a 404 for the segment %s', (segment) => {
    expect(() => render(segment)).toThrow('NEXT_NOT_FOUND');
  });
});
