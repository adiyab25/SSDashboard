import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { modulesAnswer, stateView } from './module-fixtures';
import { useModuleStates } from './use-module-states';

const api = vi.hoisted(() => ({ getModuleStates: vi.fn() }));
vi.mock('./module-states-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('useModuleStates (spec 0009, AC-9)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.getModuleStates.mockResolvedValue(
      modulesAnswer({ modules: [stateView({ key: 'inventory', state: 'off', reason: 'lapsed' })] }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    focusManager.setFocused(undefined);
    api.getModuleStates.mockReset();
  });

  it('is unknown until the answer is in, then reads a state by key', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useModuleStates(), { wrapper: wrapper(client) });
    expect(result.current.ready).toBe(false);
    expect(result.current.stateOf('inventory')).toBeNull();

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.stateOf('inventory')?.state).toBe('off');
    expect(result.current.stateOf('catalog')).toBeNull();
  });

  it('reads again every 60 seconds, and not before', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useModuleStates(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(api.getModuleStates).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_000);
    });
    expect(api.getModuleStates).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(() => expect(api.getModuleStates).toHaveBeenCalledTimes(2));
  });

  it('reads again when the window regains focus, even while the answer is fresh', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useModuleStates(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(api.getModuleStates).toHaveBeenCalledTimes(1);

    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(api.getModuleStates).toHaveBeenCalledTimes(2));
  });
});
