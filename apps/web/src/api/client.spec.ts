import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiRequest } from './client';

const fetcher = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/auth/api-fetch', () => fetcher);

const refuse = (body: unknown) =>
  fetcher.apiFetch.mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 422,
      headers: { 'content-type': 'application/json' },
    }),
  );

async function failure(): Promise<ApiError> {
  const error: unknown = await apiRequest('GET', '/api/x', z.unknown()).catch((e: unknown) => e);
  if (!(error instanceof ApiError)) throw new Error('expected an ApiError');
  return error;
}

afterEach(() => fetcher.apiFetch.mockReset());

describe('apiRequest error bodies', () => {
  it('keeps the stable code and the well formed schema issues', async () => {
    refuse({
      code: 'SETTING_INVALID',
      issues: [
        { path: 'PO', message: 'Use 1 to 8 capital letters or digits' },
        { path: '', message: 'Languages must not repeat' },
      ],
    });
    const error = await failure();
    expect(error.code).toBe('SETTING_INVALID');
    expect(error.body.issues).toEqual([
      { path: 'PO', message: 'Use 1 to 8 capital letters or digits' },
      { path: '', message: 'Languages must not repeat' },
    ]);
  });

  it('drops a malformed issue and reads a missing or non string path as empty', async () => {
    refuse({
      code: 'SETTING_INVALID',
      issues: [
        null,
        'text',
        { path: 'PO' },
        { message: 'No path' },
        { path: 3, message: 'Number' },
      ],
    });
    const error = await failure();
    expect(error.body.issues).toEqual([
      { path: '', message: 'No path' },
      { path: '', message: 'Number' },
    ]);
  });

  it('has no issues when the body carries none or a non list', async () => {
    refuse({ code: 'STALE_SETTING' });
    expect((await failure()).body.issues).toBeUndefined();
    refuse({ code: 'SETTING_INVALID', issues: 'nope' });
    expect((await failure()).body.issues).toBeUndefined();
  });

  it('keeps the outcome of a refused license and drops one that is not text', async () => {
    refuse({ code: 'LICENSE_INVALID', outcome: 'bad_signature' });
    const refused = await failure();
    expect(refused.code).toBe('LICENSE_INVALID');
    expect(refused.body.outcome).toBe('bad_signature');
    refuse({ code: 'LICENSE_INVALID', outcome: 7 });
    expect((await failure()).body.outcome).toBeUndefined();
    refuse({ code: 'LICENSE_TOO_LARGE' });
    expect((await failure()).body.outcome).toBeUndefined();
  });
});
