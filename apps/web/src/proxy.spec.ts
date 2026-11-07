import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config, proxy } from './proxy';

const seenByPage = (response: Response, name: string) =>
  response.headers.get(`x-middleware-request-${name}`);

describe('proxy', () => {
  it('passes the requested path and query to the server components', () => {
    const response = proxy(new NextRequest('http://localhost:3000/staff?q=sam'));

    expect(seenByPage(response, 'x-pathname')).toBe('/staff?q=sam');
  });

  it('overwrites an x-pathname header the browser sent', () => {
    const response = proxy(
      new NextRequest('http://localhost:3000/design', {
        headers: { 'x-pathname': '//evil.example' },
      }),
    );

    expect(seenByPage(response, 'x-pathname')).toBe('/design');
  });

  it('keeps the headers the page already had, such as the cookie', () => {
    const response = proxy(
      new NextRequest('http://localhost:3000/', { headers: { cookie: 'a=b' } }),
    );

    expect(seenByPage(response, 'cookie')).toBe('a=b');
  });

  describe('in production', () => {
    afterEach(() => vi.unstubAllEnvs());

    it.each([
      '/design',
      '/design/',
      '/design/phone-dashboard',
      '/en/returns/preview/brand',
      '/ar/returns/preview/rejected',
      '/ar/partner/preview',
      '/returns/preview/brand',
    ])('answers a real 404 for the development only %s', (path) => {
      vi.stubEnv('NODE_ENV', 'production');

      const response = proxy(new NextRequest(`http://localhost:3000${path}`));

      expect(response.status).toBe(404);
      expect(response.headers.get('x-middleware-rewrite')).toBe('http://localhost:3000/_not-found');
    });

    it.each(['/', '/designs', '/staff'])('leaves %s alone', (path) => {
      vi.stubEnv('NODE_ENV', 'production');

      const response = proxy(new NextRequest(`http://localhost:3000${path}`));

      expect(response.status).toBe(200);
      expect(seenByPage(response, 'x-pathname')).toBe(path);
    });
  });

  describe('portal and partner language (spec 0004, AC-16)', () => {
    const open = (path: string, headers: Record<string, string> = {}) =>
      proxy(new NextRequest(`http://localhost:3000${path}`, { headers }));
    const location = (response: Response) => response.headers.get('location');

    it.each(['/returns', '/partner', '/returns/', '/partner/anything'])(
      'redirects the unprefixed %s with 307',
      (path) => {
        const response = open(path);

        expect(response.status).toBe(307);
        expect(location(response)).toBe(`http://localhost:3000/ar${path}`);
      },
    );

    it.each(['/ar/returns/preview/brand', '/ar/partner/preview'])(
      'does not write the language cookie for the development only preview %s',
      (path) => {
        const response = open(path);

        expect(response.status).toBe(200);
        expect(response.headers.get('set-cookie')).toBeNull();
      },
    );

    it('forbids caching the language redirect', () => {
      expect(open('/returns').headers.get('cache-control')).toBe('private, no-store');
    });

    it('keeps the query on the redirect', () => {
      expect(location(open('/returns?order=12&x=%D8%B3'))).toBe(
        'http://localhost:3000/ar/returns?order=12&x=%D8%B3',
      );
    });

    it('chooses the cookie first, even against the browser language', () => {
      const response = open('/returns', {
        cookie: 'ss_lang=en',
        'accept-language': 'ar-EG,ar;q=0.9',
      });

      expect(location(response)).toBe('http://localhost:3000/en/returns');
    });

    it('chooses Arabic from the cookie', () => {
      expect(location(open('/partner', { cookie: 'ss_lang=ar', 'accept-language': 'en' }))).toBe(
        'http://localhost:3000/ar/partner',
      );
    });

    it.each(['fr', 'xx', 'de'])(
      'sends the client language cookie %j to English, ignoring the browser',
      (value) => {
        const response = open('/returns', {
          cookie: `ss_lang=${value}`,
          'accept-language': 'ar-EG',
        });

        expect(location(response)).toBe('http://localhost:3000/en/returns');
      },
    );

    it.each(['', 'EN', 'ar-EG', 'FR!', 'english'])(
      'ignores the invalid cookie value %j and asks the browser',
      (value) => {
        const response = open('/returns', {
          cookie: `ss_lang=${value}`,
          'accept-language': 'en-GB',
        });

        expect(location(response)).toBe('http://localhost:3000/en/returns');
      },
    );

    it.each([
      ['ar-EG,ar;q=0.9', 'ar'],
      ['en-US,en;q=0.9,ar;q=0.8', 'en'],
      ['fr-FR,fr;q=0.9,ar;q=0.5,en;q=0.4', 'ar'],
      ['en;q=0.3,ar;q=0.7', 'ar'],
      ['ar;q=0,en;q=0.1', 'en'],
      ['fr, de;q=0.8, EN', 'en'],
      ['en;q=oops, ar', 'ar'],
      ['ar,en', 'ar'],
      ['en,ar', 'en'],
    ])('reads Accept-Language %j as %s', (header, language) => {
      expect(location(open('/returns', { 'accept-language': header }))).toBe(
        `http://localhost:3000/${language}/returns`,
      );
    });

    it.each(['fr,de;q=0.8', '*', '', 'zh-CN'])(
      'falls back to Arabic when Accept-Language is %j',
      (header) => {
        expect(location(open('/returns', { 'accept-language': header }))).toBe(
          'http://localhost:3000/ar/returns',
        );
      },
    );

    it('falls back to Arabic with no cookie and no header', () => {
      expect(location(open('/partner'))).toBe('http://localhost:3000/ar/partner');
    });

    it.each(['/en/returns', '/ar/returns', '/ar/partner', '/en/partner'])(
      'serves %s and refreshes the language cookie',
      (path) => {
        const response = open(path);
        const cookie = response.headers.get('set-cookie') ?? '';

        expect(response.status).toBe(200);
        expect(location(response)).toBeNull();
        expect(seenByPage(response, 'x-pathname')).toBe(path);
        expect(cookie).toContain(`ss_lang=${path.slice(1, 3)}`);
        expect(cookie).toContain('Path=/');
        expect(cookie).toContain('Max-Age=31536000');
        expect(cookie).toMatch(/SameSite=lax/i);
        expect(cookie).not.toMatch(/HttpOnly|Secure/i);
      },
    );

    it('never overwrites a client language cookie on a served page', () => {
      const response = open('/ar/returns', { cookie: 'ss_lang=fr' });

      expect(response.status).toBe(200);
      expect(response.headers.get('set-cookie')).toBeNull();
    });

    it.each([undefined, 'ss_lang=en', 'ss_lang=ar'])(
      'sets ar on /ar/returns when the cookie is %s',
      (cookie) => {
        const response = open('/ar/returns', cookie ? { cookie } : {});

        expect(response.headers.get('set-cookie')).toContain('ss_lang=ar');
      },
    );

    it('marks the cookie Secure on https, direct or behind the edge', () => {
      const direct = proxy(new NextRequest('https://shop.example/ar/returns'));
      const behind = open('/en/returns', { 'x-forwarded-proto': 'https' });

      expect(direct.headers.get('set-cookie')).toMatch(/Secure/);
      expect(behind.headers.get('set-cookie')).toMatch(/Secure/);
    });

    it.each([
      '/fr/returns',
      '/xx/partner',
      '/EN/returns',
      '/fr/partner/x',
      '/english/returns',
      '/en-US/partner',
      '/account/returns',
      '/e1/partner',
    ])('answers a real 404 for the unserved language in %s, with no cookie', (path) => {
      const response = open(path);

      expect(response.status).toBe(404);
      expect(response.headers.get('x-middleware-rewrite')).toBe('http://localhost:3000/_not-found');
      expect(response.headers.get('set-cookie')).toBeNull();
    });

    it.each([
      '/',
      '/staff',
      '/sign-in',
      '/skus/partner',
      '/stock-receipts/returns',
      '/design',
      '/account',
    ])(
      'never redirects, refuses, or sets a cookie on the back office or sign in path %s',
      (path) => {
        const response = open(path);

        expect(response.status).toBe(200);
        expect(response.headers.get('set-cookie')).toBeNull();
        expect(seenByPage(response, 'x-pathname')).toBe(path);
      },
    );
  });

  describe('matcher', () => {
    const matches = (path: string) => new RegExp(`^${config.matcher[0]}$`).test(path);

    it.each(['/', '/design', '/sign-in', '/staff/123', '/returns', '/ar/partner'])(
      'runs for the page %s',
      (path) => {
        expect(matches(path)).toBe(true);
      },
    );

    it.each([
      '/api/me',
      '/api/auth/sign-in/email',
      '/_next/static/chunk.js',
      '/locales/ar.json',
      '/favicon.ico',
    ])('skips %s', (path) => {
      expect(matches(path)).toBe(false);
    });
  });
});
