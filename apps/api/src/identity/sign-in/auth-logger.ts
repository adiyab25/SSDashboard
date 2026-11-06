import { Logger } from '@nestjs/common';
import type { BetterAuthOptions } from 'better-auth';
import { describeError } from '../../database/pg-error.js';

type BetterAuthLog = NonNullable<NonNullable<BetterAuthOptions['logger']>['log']>;
type Level = Parameters<BetterAuthLog>[0];

const logger = new Logger('BetterAuth');

/** One argument as text: errors through `describeError`, so a failed query shows its pg code only. */
function argText(arg: unknown): string {
  if (arg instanceof Error || typeof arg === 'string') return describeError(arg, true);
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

/** The text Better Auth's log line becomes: message and arguments, every error made safe. */
export function betterAuthLogLine(message: string, args: readonly unknown[]): string {
  return [message, ...args].map(argText).join(' ');
}

/**
 * Better Auth's `logger.log`. Its default prints the arguments as they are, and a failed Drizzle
 * query carries the params (emails, password hashes) in its message. This prints them through
 * the Nest logger with every failed query reduced to `Failed query (pg <code>)`.
 */
export const betterAuthLog: BetterAuthLog = (level: Level, message: string, ...args: unknown[]) => {
  const line = betterAuthLogLine(message, args);
  if (level === 'error') logger.error(line);
  else if (level === 'warn') logger.warn(line);
  else if (level === 'debug') logger.debug(line);
  else logger.log(line);
};

const httpLogger = new Logger('Auth');

/**
 * A Better Auth request that failed with an error Better Auth did not turn into an answer (a
 * failed query, a bug). `onAPIError.throw` sends those here rather than to better-call, which
 * would print the raw error. Logged safely, answered with a bare 500 like better-call's own.
 */
export function logAuthRequestFailure(route: string, error: unknown): void {
  httpLogger.error(`${route} failed: ${describeError(error, true)}`);
}
