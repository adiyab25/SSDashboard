import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ChangeSkuCodeRequest, SkuListQuery, UpdateSkuRequest } from '@ssdashboard/contracts';
import { describe, expect, it } from 'vitest';
import { InvalidCursorError } from '../platform/keyset-cursor.js';
import { catalogHttpError } from './catalog.controller.js';
import { CatalogError, escapeLike, type CatalogErrorCode } from './catalog.service.js';

const BACKSLASH = String.fromCharCode(92);

describe('escapeLike', () => {
  it.each([
    ['100%', `100${BACKSLASH}%`],
    ['A_B', `A${BACKSLASH}_B`],
    [`back${BACKSLASH}slash`, `back${BACKSLASH}${BACKSLASH}slash`],
    ['plain', 'plain'],
  ])('makes %s match itself', (input, escaped) => {
    expect(escapeLike(input)).toBe(escaped);
  });
});

describe('catalogHttpError', () => {
  it.each<[CatalogErrorCode, unknown, string]>([
    ['SkuTaken', ConflictException, 'SKU_TAKEN'],
    ['NotFound', NotFoundException, 'NOT_FOUND'],
    ['Stale', ConflictException, 'STALE_RECORD'],
    ['InUse', ConflictException, 'IN_USE'],
  ])('maps %s to its stable code', (code, type, answer) => {
    const mapped = catalogHttpError(new CatalogError(code, 'x'));
    expect(mapped).toBeInstanceOf(type);
    expect((mapped as ConflictException).getResponse()).toMatchObject({ code: answer });
  });

  it('answers 400 INVALID_QUERY for a bad cursor', () => {
    const mapped = catalogHttpError(new InvalidCursorError());
    expect(mapped).toBeInstanceOf(BadRequestException);
    expect((mapped as BadRequestException).getResponse()).toMatchObject({ code: 'INVALID_QUERY' });
  });
});

describe('the SKU contracts', () => {
  it('list active SKUs 50 a page by default, archived ones on request (AC-13)', () => {
    expect(SkuListQuery.parse({})).toEqual({ status: 'active', limit: 50 });
    expect(SkuListQuery.parse({ status: 'archived', limit: '20' })).toEqual({
      status: 'archived',
      limit: 20,
    });
    expect(SkuListQuery.safeParse({ limit: '51' }).success).toBe(false);
  });

  it('need updatedAt on every edit and keep an absent price apart from a cleared one (AC-2)', () => {
    expect(UpdateSkuRequest.safeParse({ price: '1.00' }).success).toBe(false);
    expect(UpdateSkuRequest.parse({ updatedAt: 't' })).toEqual({ updatedAt: 't' });
    expect(UpdateSkuRequest.parse({ updatedAt: 't', price: null })).toEqual({
      updatedAt: 't',
      price: null,
    });
    expect(UpdateSkuRequest.safeParse({ updatedAt: 't', price: '-1.00' }).success).toBe(false);
  });

  it('uppercase and check a new code', () => {
    expect(ChangeSkuCodeRequest.parse({ updatedAt: 't', sku: ' tee-1 ' }).sku).toBe('TEE-1');
    expect(ChangeSkuCodeRequest.safeParse({ updatedAt: 't', sku: 'a b' }).success).toBe(false);
  });
});
