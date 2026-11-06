import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { finishSignIn } from './finish-sign-in';

const ORIGIN = 'https://erp.example.com';
const fetchMock = vi.fn();
const cookie = () => /(?:^|;\s*)ss_lang=([^;]*)/.exec(document.cookie)?.[1];

const ME = {
  id: '0190c0de-0000-7000-8000-000000000001',
  name: 'Sam',
  email: 'sam@example.com',
  role: 'staff',
  phone: null,
  staffCode: null,
  language: null,
  twoFactorEnabled: false,
  mustChangePassword: false,
  home: 'backoffice',
};

const wrongAudience = () =>
  Response.json({ code: 'WRONG_AUDIENCE', message: 'no' }, { status: 403 });

describe('finishSignIn (AC-28, AC-19)', () => {
  beforeEach(() => {
    document.cookie = 'ss_lang=; Path=/; Max-Age=0';
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('lands a staff person on the page they asked for, asking only /api/me', async () => {
    fetchMock.mockResolvedValue(Response.json(ME));

    await expect(finishSignIn('/stock', ORIGIN)).resolves.toBe('/stock');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('sends a staff person who asked for a partner page to /', async () => {
    fetchMock.mockResolvedValue(Response.json(ME));

    await expect(finishSignIn('/en/partner', ORIGIN)).resolves.toBe('/');
  });

  it('asks /api/partner/me after a 403 WRONG_AUDIENCE and lands a partner user on /partner', async () => {
    fetchMock.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/api/me' ? wrongAudience() : Response.json({ ...ME, home: 'partner' }),
      ),
    );

    await expect(finishSignIn(null, ORIGIN)).resolves.toBe('/partner');
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/partner/me', { cache: 'no-store' });
  });

  it('sends a partner user who asked for /stock to /partner, and keeps a partner page', async () => {
    fetchMock.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/api/me' ? wrongAudience() : Response.json({ ...ME, home: 'partner' }),
      ),
    );

    await expect(finishSignIn('/stock', ORIGIN)).resolves.toBe('/partner');
    await expect(finishSignIn('/ar/partner/account', ORIGIN)).resolves.toBe('/ar/partner/account');
  });

  it('applies the saved language of a partner user', async () => {
    fetchMock.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/api/me'
          ? wrongAudience()
          : Response.json({ ...ME, home: 'partner', language: 'ar' }),
      ),
    );

    await finishSignIn(null, ORIGIN);

    expect(cookie()).toBe('ar');
  });

  it('keeps the staff landing when /api/partner/me does not exist yet (404)', async () => {
    fetchMock.mockImplementation((path: string) =>
      Promise.resolve(path === '/api/me' ? wrongAudience() : new Response('{}', { status: 404 })),
    );

    await expect(finishSignIn('/stock', ORIGIN)).resolves.toBe('/stock');
  });

  it('does not ask the partner route for any other failure', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 500 }));

    await expect(finishSignIn(null, ORIGIN)).resolves.toBe('/');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps the staff landing when the call throws', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));

    await expect(finishSignIn('/staff', ORIGIN)).resolves.toBe('/staff');
  });
});
