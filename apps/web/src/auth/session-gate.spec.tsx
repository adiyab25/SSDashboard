import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionGate } from './session-gate';

const incoming = new Headers();

vi.mock('next/headers', () => ({ headers: () => Promise.resolve(incoming) }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));

function setRequest(values: Record<string, string>) {
  for (const key of [...incoming.keys()]) incoming.delete(key);
  for (const [key, value] of Object.entries(values)) incoming.set(key, value);
}

describe('SessionGate (AC-7)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('asks the api for the person with the cookie forwarded, and lets the page render', async () => {
    setRequest({ cookie: 'better-auth.session_token=abc', 'x-pathname': '/design' });

    await expect(SessionGate({ children: 'page' })).resolves.toBe('page');

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3001/api/me', {
      headers: { cookie: 'better-auth.session_token=abc' },
      cache: 'no-store',
    });
  });

  it('sends a person without a session to sign in, bringing the page along', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
    setRequest({ 'x-pathname': '/staff?q=sam' });

    await expect(SessionGate({ children: 'page' })).rejects.toThrow(
      'redirect:/sign-in?returnTo=%2Fstaff%3Fq%3Dsam',
    );
  });

  it('sends the home page visitor to plain /sign-in', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
    setRequest({ 'x-pathname': '/' });

    await expect(SessionGate({ children: 'page' })).rejects.toThrow('redirect:/sign-in');
  });

  it.each(['//evil.example', 'https://evil.example', '/\\evil.example'])(
    'never carries an unsafe path (%s) into returnTo',
    async (path) => {
      fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
      setRequest({ 'x-pathname': path });

      await expect(SessionGate({ children: 'page' })).rejects.toThrow('redirect:/sign-in');
      await expect(SessionGate({ children: 'page' })).rejects.not.toThrow('returnTo');
    },
  );

  it('fails loudly when the api cannot answer, rather than showing the page unchecked', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 500 }));
    setRequest({ cookie: 'better-auth.session_token=abc' });

    await expect(SessionGate({ children: 'page' })).rejects.toThrow('answered 500');
  });
});
