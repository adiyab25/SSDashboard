import { BadRequestException } from '@nestjs/common';
import { LocationListQuery } from '@ssdashboard/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ZodQueryPipe } from '../../platform/zod-query.pipe.js';
import { LocationsController } from './locations.controller.js';
import {
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
  type LocationsService,
} from './locations.service.js';

const pipe = new ZodQueryPipe(LocationListQuery);

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
    expect(pipe.transform({})).toEqual({ limit: 200 });
    expect(pipe.transform({ limit: '5' })).toEqual({ limit: 5 });
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
      .list({ cursor: 'x', limit: 200 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'INVALID_QUERY' });
  });
});
