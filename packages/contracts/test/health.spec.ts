import { describe, expect, it } from 'vitest';
import { HealthResponse } from '../src/index.js';

describe('HealthResponse', () => {
  it('accepts a healthy response', () => {
    const body = { status: 'ok', version: '0.1.0', database: 'up' };

    expect(HealthResponse.parse(body)).toEqual(body);
  });

  it('accepts a degraded response with the database down', () => {
    const body = { status: 'degraded', version: '0.0.0-dev', database: 'down' };

    expect(HealthResponse.parse(body)).toEqual(body);
  });

  it('drops fields the contract does not declare', () => {
    const parsed = HealthResponse.parse({
      status: 'ok',
      version: '1.0.0',
      database: 'up',
      secret: 'x',
    });

    expect(parsed).not.toHaveProperty('secret');
  });

  it.each([
    ['an unknown status', { status: 'starting', version: '1.0.0', database: 'up' }],
    ['an unknown database state', { status: 'ok', version: '1.0.0', database: 'slow' }],
    ['a missing version', { status: 'ok', database: 'up' }],
    ['a numeric version', { status: 'ok', version: 1, database: 'up' }],
    ['an empty object', {}],
  ])('rejects %s', (_case, body) => {
    expect(HealthResponse.safeParse(body).success).toBe(false);
  });
});
