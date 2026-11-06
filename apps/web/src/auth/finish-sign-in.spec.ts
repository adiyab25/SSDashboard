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

  it('lands on the partner home once the api said WRONG_AUDIENCE, even when /api/partner/me fails (404)', async () => {
    fetchMock.mockImplementation((path: string) =>
      Promise.resolve(path === '/api/me' ? wrongAudience() : new Response('{}', { status: 404 })),
    );

    await expect(finishSignIn('/stock', ORIGIN)).resolves.toBe('/partner');
    await expect(finishSignIn(null, ORIGIN)).resolves.toBe('/partner');
  });

  it('lands on the partner home once the api said WRONG_AUDIENCE, even when /api/partner/me throws', async () => {
    fetchMock.mockImplementation((path: string) =>
      path === '/api/me' ? Promise.resolve(wrongAudience()) : Promise.reject(new Error('offline')),
    );

    await expect(finishSignIn('/stock', ORIGIN)).resolves.toBe('/partner');
  });

  it('ignores a 200 from /api/me whose body breaks the contract, landing as staff', async () => {
    fetchMock.mockResolvedValue(Response.json({ id: 'not a person', home: 'partner' }));

    await expect(finishSignIn('/stock', ORIGIN)).resolves.toBe('/stock');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('ignores a 200 from /api/partner/me whose body breaks the contract, landing on the partner home', async () => {
    fetchMock.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/api/me' ? wrongAudience() : Response.json({ ...ME, home: 'nowhere' }),
      ),
    );

    await expect(finishSignIn('/stock', ORIGIN)).resolves.toBe('/partner');
    expect(cookie()).toBeUndefined();
  });

  it('ignores a 200 that is not JSON at all', async () => {
    fetchMock.mockResolvedValue(new Response('<html>', { status: 200 }));

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

  describe('a person who must still change a temporary password (AC-14)', () => {
    it('sends staff to the change password page, carrying the landing', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(Response.json({ ...ME, mustChangePassword: true })),
      );

      await expect(finishSignIn('/staff?q=sam', ORIGIN)).resolves.toBe(
        '/change-password?returnTo=%2Fstaff%3Fq%3Dsam',
      );
      await expect(finishSignIn(null, ORIGIN)).resolves.toBe('/change-password');
    });

    it('sends a partner user to the change password page, carrying the partner landing', async () => {
      fetchMock.mockImplementation((path: string) =>
        Promise.resolve(
          path === '/api/me'
            ? wrongAudience()
            : Response.json({ ...ME, home: 'partner', mustChangePassword: true }),
        ),
      );

      await expect(finishSignIn('/stock', ORIGIN)).resolves.toBe(
        '/change-password?returnTo=%2Fpartner',
      );
      await expect(finishSignIn('/ar/partner/account', ORIGIN)).resolves.toBe(
        '/change-password?returnTo=%2Far%2Fpartner%2Faccount',
      );
    });
  });

  describe('an unsafe returnTo, as the sign in, two factor and forced change forms pass it (AC-7)', () => {
    it.each([
      '/.//evil.example',
      '/%2e//evil.example',
      '/a/..//evil.example',
      '/%2e%2e//evil.example',
    ])('lands staff on / and a partner user on /partner for %s', async (returnTo) => {
      fetchMock.mockResolvedValue(Response.json(ME));
      await expect(finishSignIn(returnTo, ORIGIN)).resolves.toBe('/');

      fetchMock.mockImplementation((path: string) =>
        Promise.resolve(
          path === '/api/me' ? wrongAudience() : Response.json({ ...ME, home: 'partner' }),
        ),
      );
      await expect(finishSignIn(returnTo, ORIGIN)).resolves.toBe('/partner');
    });

    it('never carries an unsafe returnTo into the change password page', async () => {
      fetchMock.mockResolvedValue(Response.json({ ...ME, mustChangePassword: true }));

      await expect(finishSignIn('/stock/..//evil.example/x', ORIGIN)).resolves.toBe(
        '/change-password',
      );
    });
  });
});
