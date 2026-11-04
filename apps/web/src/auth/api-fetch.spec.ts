import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, resetApiFetchForTests } from './api-fetch';

const assign = vi.fn();

function atPage(pathname: string, search = '') {
  vi.stubGlobal('location', { pathname, search, assign });
}

describe('apiFetch (AC-5)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    resetApiFetchForTests();
    vi.stubGlobal('fetch', fetchMock);
    atPage('/staff', '?q=sam');
  });

  afterEach(() => {
    assign.mockReset();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('sends the person to sign in on a 401, bringing the page they were on', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));

    const response = await apiFetch('/api/locations');

    expect(response.status).toBe(401);
    expect(assign).toHaveBeenCalledExactlyOnceWith('/sign-in?returnTo=%2Fstaff%3Fq%3Dsam');
  });

  it('starts only one redirect when several calls fail together', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response('{}', { status: 401 })));

    await Promise.all([apiFetch('/api/me'), apiFetch('/api/locations')]);

    expect(assign).toHaveBeenCalledOnce();
  });

  it.each([200, 403, 404, 500])('leaves a %s alone', async (status) => {
    fetchMock.mockResolvedValue(new Response('{}', { status }));

    await apiFetch('/api/me');

    expect(assign).not.toHaveBeenCalled();
  });

  it('sends a 403 PASSWORD_CHANGE_REQUIRED to change the password, bringing the page along (AC-14)', async () => {
    atPage('/staff', '?q=sam');
    fetchMock.mockResolvedValue(
      Response.json({ code: 'PASSWORD_CHANGE_REQUIRED' }, { status: 403 }),
    );

    const response = await apiFetch('/api/staff');

    expect(response.status).toBe(403);
    expect(assign).toHaveBeenCalledExactlyOnceWith('/change-password?returnTo=%2Fstaff%3Fq%3Dsam');
  });

  it('leaves any other 403 alone', async () => {
    atPage('/staff');
    fetchMock.mockResolvedValue(Response.json({ code: 'FORBIDDEN' }, { status: 403 }));

    await apiFetch('/api/staff');

    expect(assign).not.toHaveBeenCalled();
  });

  it.each(['/sign-in', '/forgot-password', '/reset-password', '/two-factor', '/change-password'])(
    'does not redirect from %s, a screen outside the shell',
    async (path) => {
      atPage(path);
      fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));

      await apiFetch('/api/me');

      expect(assign).not.toHaveBeenCalled();
    },
  );
});
