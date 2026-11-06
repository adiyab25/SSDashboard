import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignedIn } from '../../platform/events/auth-events.js';
import { AuthAudit } from './auth-audit.service.js';
import { betterAuthLog, betterAuthLogLine, logAuthRequestFailure } from './auth-logger.js';

const EMAIL = 'sam@example.com';
const HASH = 'a1b2c3d4e5f6a7b8:0f1e2d3c4b5a69788796a5b4c3d2e1f0';

/** Built the way drizzle-orm's `DrizzleQueryError` is: params in the message, pg error as cause. */
function drizzleQueryError(code = '42703'): Error {
  const query = 'select "id" from "users" where "users"."email" = $1';
  const params = [EMAIL, HASH];
  const cause = Object.assign(new Error(`column "email" does not exist (${EMAIL})`), { code });
  const error = new Error(`Failed query: ${query}\nparams: ${params.join(',')}`, { cause });
  return Object.assign(error, { query, params });
}

const textOf = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('betterAuthLogLine', () => {
  it('reduces a failed query, as an error or as text, to its pg code', () => {
    const error = drizzleQueryError();
    const line = betterAuthLogLine(error.name, [error, error.message]);

    expect(line).toBe('Error FailedQueryError: Failed query (pg 42703) Failed query');
    expect(line).not.toContain(EMAIL);
    expect(line).not.toContain(HASH);
  });

  it('keeps plain messages and objects readable', () => {
    expect(betterAuthLogLine('Provider not found', [{ provider: 'x' }])).toBe(
      'Provider not found {"provider":"x"}',
    );
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(betterAuthLogLine('odd', [circular, undefined])).toBe('odd [object Object] undefined');
  });
});

describe('betterAuthLog', () => {
  it('writes each level to the matching Nest logger method, without the params', () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    betterAuthLog('error', 'Error', drizzleQueryError());
    betterAuthLog('warn', 'careful');
    betterAuthLog('debug', 'detail');
    betterAuthLog('info', 'note');

    expect(textOf(error)).toBe('Error FailedQueryError: Failed query (pg 42703)');
    expect(textOf(warn)).toBe('careful');
    expect(textOf(debug)).toBe('detail');
    expect(textOf(log)).toBe('note');
  });
});

describe('logAuthRequestFailure', () => {
  it('logs the route and the pg code only for a failed query', () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    logAuthRequestFailure('POST /sign-in/email', drizzleQueryError('42P01'));

    expect(textOf(error)).toBe(
      'POST /sign-in/email failed: FailedQueryError: Failed query (pg 42P01)',
    );
  });

  it('keeps the stack of any other error', () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const bug = new TypeError('undefined is not a function');

    logAuthRequestFailure('POST /sign-out', bug);

    expect(textOf(error)).toBe(`POST /sign-out failed: ${bug.stack ?? ''}`);
  });
});

describe('AuthAudit listener failures', () => {
  it('logs a listener that failed on a query by its pg code, never the params', () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const events = new EventEmitter2();
    events.on('SignedIn', () => {
      throw drizzleQueryError('23505');
    });
    const context = {
      actorId: 'a',
      targetId: 'a',
      ip: '127.0.0.1',
      userAgent: null,
      at: new Date(),
    };

    expect(() => new AuthAudit(events).record(new SignedIn(context))).not.toThrow();

    const text = textOf(error);
    expect(text).toContain('listener failed: FailedQueryError: Failed query (pg 23505)');
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain(HASH);
  });
});
