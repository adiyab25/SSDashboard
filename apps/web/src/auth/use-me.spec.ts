import type { MeResponse } from '@ssdashboard/contracts';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApiFetchForTests } from './api-fetch';
import { loadMe, resetMeForTests, setMe, useMeState } from './use-me';

const STAFF: MeResponse = {
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
const PARTNER: MeResponse = { ...STAFF, name: 'Mona', home: 'partner' };

const fetchMock = vi.fn<(path: string) => Promise<Response>>();

describe('loadMe and useMeState (review finding 6)', () => {
  beforeEach(() => {
    resetMeForTests();
    resetApiFetchForTests();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation((path) =>
      Promise.resolve(Response.json(path === '/api/partner/me' ? PARTNER : STAFF)),
    );
  });
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('loads each path separately and caches each one', async () => {
    await expect(loadMe('/api/me')).resolves.toEqual(STAFF);
    await expect(loadMe('/api/partner/me')).resolves.toEqual(PARTNER);
    await expect(loadMe('/api/me')).resolves.toEqual(STAFF);
    await expect(loadMe('/api/partner/me')).resolves.toEqual(PARTNER);

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/me', '/api/partner/me']);
  });

  it('defaults to the staff path', async () => {
    await expect(loadMe()).resolves.toEqual(STAFF);
    expect(fetchMock).toHaveBeenCalledWith('/api/me', { cache: 'no-store' });
  });

  it('replaces only the answer of the path setMe names', async () => {
    await loadMe('/api/me');
    setMe({ ...PARTNER, name: 'Mona A' }, '/api/partner/me');

    await expect(loadMe('/api/partner/me')).resolves.toMatchObject({ name: 'Mona A' });
    await expect(loadMe('/api/me')).resolves.toEqual(STAFF);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not cache a failure, and treats an answer that breaks the contract as one', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 404 }));
    await expect(loadMe('/api/partner/me')).resolves.toBeNull();

    fetchMock.mockResolvedValueOnce(Response.json({ id: 'not a person' }));
    await expect(loadMe('/api/partner/me')).resolves.toBeNull();

    await expect(loadMe('/api/partner/me')).resolves.toEqual(PARTNER);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('tells a failed load from one still running', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 404 }));
    const { result } = renderHook(() => useMeState('/api/partner/me'));

    expect(result.current).toEqual({ status: 'loading' });
    await waitFor(() => expect(result.current).toEqual({ status: 'failed' }));
  });

  it('reports the person once loaded', async () => {
    const { result } = renderHook(() => useMeState('/api/partner/me'));

    await waitFor(() => expect(result.current).toEqual({ status: 'ready', me: PARTNER }));
  });
});
