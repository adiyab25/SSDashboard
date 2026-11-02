import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import RootLayout, { metadata } from './layout';

describe('RootLayout', () => {
  it('titles every page SSDashboard', () => {
    expect(metadata.title).toBe('SSDashboard');
  });

  // Feature 5 (localization) will switch these; until then English, left to right.
  it('declares English and left to right on the document', () => {
    const html = renderToStaticMarkup(<RootLayout params={Promise.resolve({})}>page</RootLayout>);

    expect(html).toMatch(/^<html lang="en" dir="ltr">/);
  });

  it('renders the page inside the body', () => {
    const html = renderToStaticMarkup(
      <RootLayout params={Promise.resolve({})}>
        <p>page content</p>
      </RootLayout>,
    );

    expect(html).toContain('<body><p>page content</p></body>');
  });
});
