import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigForTests } from './client-config';

const fetchMock = vi.fn<typeof fetch>();

const config = {
  clientName: 'Acme',
  version: '1.0.0',
  currency: 'EGP',
  timezone: 'Africa/Cairo',
  languages: ['en', 'ar'],
  defaultLanguage: 'ar',
  mailEnabled: true,
};

beforeEach(() => {
  resetConfigForTests();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

// AC-4
describe('loadConfig', () => {
  it('reads the install settings once and shares the answer', async () => {
    fetchMock.mockResolvedValue(Response.json(config));

    const [first, second] = await Promise.all([loadConfig(), loadConfig()]);

    expect(first).toEqual(config);
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fills the language defaults when an older api sends only the name and version', async () => {
    fetchMock.mockResolvedValue(Response.json({ clientName: 'Acme', version: '1.0.0' }));

    await expect(loadConfig()).resolves.toMatchObject({
      languages: ['en'],
      defaultLanguage: 'en',
      // An older api that does not know about mail is treated as having none.
      mailEnabled: false,
    });
  });

  it('does not cache a failure: the next call asks the api again', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 500 }));
    fetchMock.mockResolvedValueOnce(Response.json(config));

    await expect(loadConfig()).resolves.toBeNull();
    await expect(loadConfig()).resolves.toEqual(config);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('answers null for a network error or an answer of the wrong shape', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    await expect(loadConfig()).resolves.toBeNull();

    fetchMock.mockResolvedValueOnce(Response.json({ clientName: 1 }));
    await expect(loadConfig()).resolves.toBeNull();
  });
});
