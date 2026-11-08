import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_SEARCH_LIMIT,
  CUSTOMER_SEARCH_WINDOW_MS,
  CustomerSearchThrottle,
} from './customer-search-throttle.js';

describe('CustomerSearchThrottle', () => {
  it('names the owner facing defaults: 30 searches a minute', () => {
    expect(CUSTOMER_SEARCH_LIMIT).toBe(30);
    expect(CUSTOMER_SEARCH_WINDOW_MS).toBe(60_000);
  });

  it('lets a person search up to the limit and refuses the next call with the seconds to wait', () => {
    let now = 1_000_000;
    const throttle = new CustomerSearchThrottle(3, 60_000, () => now);

    for (let call = 0; call < 3; call += 1) {
      expect(throttle.take('person-a')).toEqual({ allowed: true });
      now += 1_000;
    }

    expect(throttle.take('person-a')).toEqual({ allowed: false, retryAfterSeconds: 57 });
  });

  it('slides: the window frees a call as the oldest one ages out, and a refused call is not counted', () => {
    let now = 0;
    const throttle = new CustomerSearchThrottle(2, 60_000, () => now);
    throttle.take('a');
    now = 30_000;
    throttle.take('a');
    now = 59_999;
    expect(throttle.take('a').allowed).toBe(false);
    expect(throttle.take('a').allowed).toBe(false);

    now = 60_001;
    expect(throttle.take('a')).toEqual({ allowed: true });
    now = 60_002;
    expect(throttle.take('a').allowed).toBe(false);
    now = 90_001;
    expect(throttle.take('a')).toEqual({ allowed: true });
  });

  it('keeps one window per person', () => {
    const throttle = new CustomerSearchThrottle(1, 60_000, () => 5);

    expect(throttle.take('a').allowed).toBe(true);
    expect(throttle.take('b').allowed).toBe(true);
    expect(throttle.take('a').allowed).toBe(false);
  });

  it('always asks for at least one second', () => {
    let now = 0;
    const throttle = new CustomerSearchThrottle(1, 1_000, () => now);
    throttle.take('a');
    now = 999;

    expect(throttle.take('a')).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });
});
