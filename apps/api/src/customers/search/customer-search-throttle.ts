import { Injectable } from '@nestjs/common';

/**
 * How many searches one person may run in one {@link CUSTOMER_SEARCH_WINDOW_MS}. Customer search
 * returns names and phones, so a stolen session must not be able to walk the whole customer list
 * at machine speed; 30 a minute is far above what a support agent types. The owner changes the
 * number here.
 */
export const CUSTOMER_SEARCH_LIMIT = 30;

/** The length of the sliding window of {@link CUSTOMER_SEARCH_LIMIT}, in milliseconds. */
export const CUSTOMER_SEARCH_WINDOW_MS = 60_000;

/** Above this many people in the map, a call also drops the people whose window has emptied. */
const SWEEP_ABOVE = 500;

/** The answer of {@link CustomerSearchThrottle.take}. */
export type ThrottleAnswer = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * A per person sliding window over `POST /api/customers/search` (security review M1): a person's
 * call is refused while the person already made {@link CUSTOMER_SEARCH_LIMIT} calls in the last
 * {@link CUSTOMER_SEARCH_WINDOW_MS}. The windows live in this process only, which is right while
 * one api process serves a client (spec 0007); a second process would need a shared store.
 *
 * It keeps person ids and call times, never a phone, a name, or a query. A refused call is not
 * counted, so waiting out `retryAfterSeconds` always works.
 */
@Injectable()
export class CustomerSearchThrottle {
  private readonly calls = new Map<string, number[]>();

  /** Takes the limit, the window, and a clock; the defaults are the named constants and the real clock. */
  constructor(
    private readonly limit: number = CUSTOMER_SEARCH_LIMIT,
    private readonly windowMs: number = CUSTOMER_SEARCH_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one call of `personId` and says whether it may go on. */
  take(personId: string): ThrottleAnswer {
    const now = this.now();
    const recent = (this.calls.get(personId) ?? []).filter((at) => at > now - this.windowMs);
    if (recent.length >= this.limit) {
      this.calls.set(personId, recent);
      const oldest = recent[0] ?? now;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)),
      };
    }
    recent.push(now);
    this.calls.set(personId, recent);
    if (this.calls.size > SWEEP_ABOVE) this.sweep(now);
    return { allowed: true };
  }

  private sweep(now: number): void {
    for (const [personId, times] of this.calls) {
      if (times.every((at) => at <= now - this.windowMs)) this.calls.delete(personId);
    }
  }
}
