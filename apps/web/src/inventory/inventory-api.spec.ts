import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { HOLD_OPEN_ORDERS_PATH, runGateAction } from './inventory-api';

const LOCATION_ID = '50000000-0000-4000-8000-000000000002';

describe('runGateAction (spec 0011 AC-19, spec 0013 AC-26)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => vi.stubGlobal('fetch', fetchMock));
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  const sent = () => {
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return { path, method: init.method, body: JSON.parse(init.body as string) as unknown };
  };

  it('sends the location to hold-open-orders and answers its counts, parsed with the contract', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ linesHeld: 4, linesShort: 1, linesLeft: 0 }, { status: 201 }),
    );

    const answer = await runGateAction(
      { method: 'POST', path: HOLD_OPEN_ORDERS_PATH },
      LOCATION_ID,
    );

    expect(sent()).toEqual({
      path: HOLD_OPEN_ORDERS_PATH,
      method: 'POST',
      body: { locationId: LOCATION_ID },
    });
    expect(answer).toEqual({
      kind: 'held',
      result: { linesHeld: 4, linesShort: 1, linesLeft: 0 },
    });
  });

  it('refuses an answer that is not the contract shape', async () => {
    fetchMock.mockResolvedValue(Response.json({}, { status: 201 }));

    await expect(
      runGateAction({ method: 'POST', path: HOLD_OPEN_ORDERS_PATH }, LOCATION_ID),
    ).rejects.toThrow();
  });

  it('throws the api code when the location cannot hold the orders', async () => {
    fetchMock.mockResolvedValue(Response.json({ code: 'LOCATION_NOT_FOUND' }, { status: 404 }));

    const failure = await runGateAction(
      { method: 'POST', path: HOLD_OPEN_ORDERS_PATH },
      LOCATION_ID,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe('LOCATION_NOT_FOUND');
  });

  it('keeps the empty body and an unread answer for any other route', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    const answer = await runGateAction({ method: 'PUT', path: '/api/other/fix' }, LOCATION_ID);

    expect(sent()).toEqual({ path: '/api/other/fix', method: 'PUT', body: {} });
    expect(answer).toEqual({ kind: 'done' });
  });
});
