import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { LocationListQuery } from '@ssdashboard/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ZodQueryPipe } from '../../platform/zod-query.pipe.js';
import type { AuthenticatedRequest } from '../../auth/current-staff.js';
import { LocationsController, locationHttpError } from './locations.controller.js';
import {
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
  LocationError,
  type LocationErrorCode,
  type LocationsService,
} from './locations.service.js';

const pipe = new ZodQueryPipe(LocationListQuery);

const as = (role: 'admin' | 'staff') => ({ staff: { role } }) as unknown as AuthenticatedRequest;

function errorCode(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    if (error instanceof BadRequestException) return (error.getResponse() as { code: string }).code;
    throw error;
  }
  throw new Error('expected a 400');
}

describe('the locations query', () => {
  it('defaults the page size to 200 and turns limit into a number', () => {
    expect(pipe.transform({})).toEqual({ status: 'active', limit: 200 });
    expect(pipe.transform({ limit: '5' })).toEqual({ status: 'active', limit: 5 });
  });

  it.each([['0'], ['201'], ['1.5'], ['ten']])('rejects limit=%s with INVALID_QUERY', (limit) => {
    expect(errorCode(() => pipe.transform({ limit }))).toBe('INVALID_QUERY');
  });
});

describe('location cursors', () => {
  it('round trip any code, including non ASCII ones', () => {
    for (const code of ['WH-01', 'SR 2', 'مخزن-1'])
      expect(decodeCursor(encodeCursor(code))).toBe(code);
  });

  it.each([['not base64!'], ['A'], ['AAA=']])('reject %s', (cursor) => {
    expect(() => decodeCursor(cursor)).toThrow(InvalidCursorError);
  });
});

describe('LocationsController', () => {
  it('answers 400 INVALID_QUERY for a cursor that does not decode', async () => {
    const service = {
      listWorkLocations: vi.fn(() => Promise.reject(new InvalidCursorError())),
    } as unknown as LocationsService;
    const controller = new LocationsController(service);

    const error: unknown = await controller
      .list({ status: 'active', cursor: 'x', limit: 200 }, as('staff'))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'INVALID_QUERY' });
  });
});

describe('the archived location list', () => {
  it('is admin only (AC-15)', async () => {
    const listWorkLocations = vi.fn(() => Promise.resolve({ items: [], nextCursor: null }));
    const controller = new LocationsController({
      listWorkLocations,
    } as unknown as LocationsService);

    const error: unknown = await controller
      .list({ status: 'archived', limit: 200 }, as('staff'))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(listWorkLocations).not.toHaveBeenCalled();

    await expect(controller.list({ status: 'archived', limit: 200 }, as('admin'))).resolves.toEqual(
      { items: [], nextCursor: null },
    );
  });
});

describe('locationHttpError', () => {
  it.each<[LocationErrorCode, unknown, string]>([
    ['NotFound', NotFoundException, 'NOT_FOUND'],
    ['CodeTaken', ConflictException, 'LOCATION_CODE_TAKEN'],
    ['Stale', ConflictException, 'STALE_RECORD'],
    ['CodeLocked', ConflictException, 'CODE_LOCKED'],
    ['StockOnHand', ConflictException, 'STOCK_ON_HAND'],
    ['InUse', ConflictException, 'IN_USE'],
  ])('maps %s to its stable code', (code, type, answer) => {
    const mapped = locationHttpError(new LocationError(code, 'x'));
    expect(mapped).toBeInstanceOf(type);
    expect((mapped as ConflictException).getResponse()).toMatchObject({ code: answer });
  });
});
