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

    it.each(['/design', '/design/'])('answers a real 404 for the development only %s', (path) => {
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

  describe('matcher', () => {
    const matches = (path: string) => new RegExp(`^${config.matcher[0]}$`).test(path);

    it.each(['/', '/design', '/sign-in', '/staff/123'])('runs for the page %s', (path) => {
      expect(matches(path)).toBe(true);
    });

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
