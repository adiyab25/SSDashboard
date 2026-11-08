import { HttpException, Logger } from '@nestjs/common';
import type { CustomerSearchRequest } from '@ssdashboard/contracts';
import type { Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type { AuthenticatedRequest } from '../../identity/sign-in/current-staff.js';
import { CustomerSearchController } from './customer-search.controller.js';
import type { CustomerSearchService } from './customer-search.service.js';
import { CustomerSearchThrottle } from './customer-search-throttle.js';

const PERSON = '0192f0e0-0000-7000-8000-000000000001';
const request = { staff: { id: PERSON } } as AuthenticatedRequest;
const body = { phone: '01001234567', limit: 25 } as z.output<typeof CustomerSearchRequest>;

function setup(limit: number) {
  const search = { search: vi.fn().mockResolvedValue({ items: [], nextCursor: null }) };
  const headers: Record<string, string> = {};
  const response = {
    setHeader: (name: string, value: string) => (headers[name] = value),
  } as unknown as Response;
  const controller = new CustomerSearchController(
    search as unknown as CustomerSearchService,
    new CustomerSearchThrottle(limit, 60_000, () => 0),
  );
  return { controller, headers, response, search };
}

describe('CustomerSearchController', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sets Cache-Control no-store and logs one line without the typed phone', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { controller, headers, response } = setup(5);

    await controller.find(body, request, response);

    expect(headers['Cache-Control']).toBe('no-store');
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toBe(`search person=${PERSON} mode=phone results=0 paged=false`);
    expect(line).not.toContain('1001234567');
  });

  it('refuses past the limit with 429, Retry-After and no-store, logging one warning with the person id only', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { controller, headers, response, search } = setup(1);
    await controller.find(body, request, response);

    const refused = await controller.find(body, request, response).catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(HttpException);
    expect((refused as HttpException).getStatus()).toBe(429);
    expect((refused as HttpException).getResponse()).toMatchObject({ code: 'SEARCH_RATE_LIMITED' });
    expect(headers['Retry-After']).toBe('60');
    expect(headers['Cache-Control']).toBe('no-store');
    expect(search.search).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toBe(`search refused person=${PERSON} reason=rate_limited`);
    expect(line).not.toContain('1001234567');
  });
});
