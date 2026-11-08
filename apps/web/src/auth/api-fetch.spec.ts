import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, onModuleRefusal, resetApiFetchForTests } from './api-fetch';

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

describe('onModuleRefusal (spec 0009, AC-9)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    resetApiFetchForTests();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  const answer = (status: number, code: string) =>
    new Response(JSON.stringify({ code }), { status });

  it('tells the listener on 404 MODULE_OFF and on 409 MODULE_LIMITED, and returns the response', async () => {
    const listener = vi.fn();
    const stop = onModuleRefusal(listener);
    fetchMock.mockResolvedValueOnce(answer(404, 'MODULE_OFF'));
    const first = await apiFetch('/api/orders');
    fetchMock.mockResolvedValueOnce(answer(409, 'MODULE_LIMITED'));
    await apiFetch('/api/orders');

    expect(first.status).toBe(404);
    expect(await first.json()).toEqual({ code: 'MODULE_OFF' });
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });

  it('ignores other 404 and 409 answers, and a listener that has stopped', async () => {
    const listener = vi.fn();
    const stop = onModuleRefusal(listener);
    fetchMock.mockResolvedValueOnce(answer(404, 'NOT_FOUND'));
    await apiFetch('/api/x');
    fetchMock.mockResolvedValueOnce(answer(409, 'STALE_SETTING'));
    await apiFetch('/api/x');
    stop();
    fetchMock.mockResolvedValueOnce(answer(404, 'MODULE_OFF'));
    await apiFetch('/api/x');

    expect(listener).not.toHaveBeenCalled();
  });
});
