import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_SHOPIFY_QUEUE,
  CONNECTOR_SHOPIFY_RETRY,
  connectionGroup,
  shortestRetryWindowSeconds,
} from './connector-shopify.queue.js';
import { READS_FAILING_AFTER_MS } from './inbox.job.js';

// Code review M1 and m9(c): the retry window outlasts the 3 hour READS_FAILING rule, and jobs of
// one connection never overlap. pg-boss enforces `groupConcurrency` in its fetch query, server
// side, across every worker process; a two worker race is not run here, so this proves the
// options every job of the queue is created and sent with (the e2e checks a job row's group).

describe('the connector-shopify queue', () => {
  it('retries for at least 3 h 15 min with the backoff capped at 15 minutes', () => {
    expect(CONNECTOR_SHOPIFY_QUEUE.options).toMatchObject(CONNECTOR_SHOPIFY_RETRY);
    expect(CONNECTOR_SHOPIFY_RETRY).toMatchObject({ retryBackoff: true, retryDelayMax: 900 });
    const window = shortestRetryWindowSeconds(CONNECTOR_SHOPIFY_RETRY);
    expect(window).toBe(11_730);
    expect(window).toBeGreaterThanOrEqual(3 * 3600 + 15 * 60);
    expect(window * 1000).toBeGreaterThan(READS_FAILING_AFTER_MS);
  });

  it('runs one job per connection at a time: group concurrency 1, each job in its connection group', () => {
    expect(CONNECTOR_SHOPIFY_QUEUE.work).toEqual({ groupConcurrency: 1 });
    expect(connectionGroup('connection-1')).toEqual({
      group: { id: 'connection-1' },
      ...CONNECTOR_SHOPIFY_RETRY,
    });
  });
});
