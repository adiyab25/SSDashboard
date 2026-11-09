import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import { refetchAfterWrite } from './refetch-after-write';

/** A query function whose answers the test hands out one at a time, in call order. */
function scriptedAnswers() {
  const pending: { resolve: (value: string) => void; signal: AbortSignal }[] = [];
  const queryFn = ({ signal }: { signal: AbortSignal }) =>
    new Promise<string>((resolve) => pending.push({ resolve, signal }));
  return { queryFn, pending };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('refetchAfterWrite', () => {
  let client: QueryClient;
  afterEach(() => client.clear());

  // The race behind the master-data.spec.ts:100 flake (2026-11-08): the SKU list's first fetch for
  // a new search left before a save committed and answered with the old name after it. A plain
  // invalidation while that first fetch is in flight joins it instead of asking again, because
  // TanStack only cancels a running fetch for a query that already has data.
  it('a plain invalidation during a first fetch keeps the answer read before the write', async () => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { queryFn, pending } = scriptedAnswers();
    const observer = new QueryObserver(client, { queryKey: ['skus', 'list', 'MDS'], queryFn });
    const stop = observer.subscribe(() => undefined);
    await flush();
    expect(pending).toHaveLength(1);

    const invalidated = client.invalidateQueries({ queryKey: ['skus'] });
    pending[0]?.resolve('before the write');
    await invalidated;
    await flush();

    expect(pending).toHaveLength(1);
    expect(observer.getCurrentResult().data).toBe('before the write');
    stop();
  });

  it('cancels a fetch that left before the write and asks again', async () => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { queryFn, pending } = scriptedAnswers();
    const observer = new QueryObserver(client, { queryKey: ['skus', 'list', 'MDS'], queryFn });
    const stop = observer.subscribe(() => undefined);
    await flush();

    const refreshed = refetchAfterWrite(client, { queryKey: ['skus'] });
    await flush();
    expect(pending[0]?.signal.aborted).toBe(true);
    pending[1]?.resolve('after the write');
    await refreshed;

    expect(pending).toHaveLength(2);
    expect(observer.getCurrentResult().data).toBe('after the write');
    stop();
  });

  it('refetches a query that has data and is idle, as a plain invalidation does', async () => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { queryFn, pending } = scriptedAnswers();
    const observer = new QueryObserver(client, { queryKey: ['skus', 'detail', '1'], queryFn });
    const stop = observer.subscribe(() => undefined);
    await flush();
    pending[0]?.resolve('old');
    await flush();

    const refreshed = refetchAfterWrite(client, { queryKey: ['skus'] });
    await flush();
    pending[1]?.resolve('new');
    await refreshed;

    expect(observer.getCurrentResult().data).toBe('new');
    stop();
  });

  it('marks a query nobody watches as stale without fetching it', async () => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { queryFn, pending } = scriptedAnswers();
    client.setQueryData(['skus', 'list', 'other'], 'cached');
    client.setQueryDefaults(['skus'], { queryFn });

    await refetchAfterWrite(client, { queryKey: ['skus'] });

    expect(pending).toHaveLength(0);
    expect(client.getQueryState(['skus', 'list', 'other'])?.isInvalidated).toBe(true);
  });
});
