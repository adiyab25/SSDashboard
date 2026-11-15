import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskSummary } from './use-task-summary';

const api = vi.hoisted(() => ({ getTaskSummary: vi.fn() }));
vi.mock('./tasks-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

vi.mock('@/auth/use-me', () => ({
  useMeState: () => ({
    status: 'ready',
    me: { id: 'me', hats: ['support'], permissions: ['tasks.work'] },
  }),
}));

const modules = vi.hoisted((): { tasks: string | null } => ({ tasks: 'on' }));
vi.mock('@/shell/use-module-states', () => ({
  useModuleStates: () => ({
    stateOf: (key: string) =>
      key === 'tasks' && modules.tasks !== null ? { key, state: modules.tasks } : null,
  }),
}));

const visibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
};

beforeEach(() => {
  modules.tasks = 'on';
  vi.useFakeTimers({ shouldAdvanceTime: true });
  api.getTaskSummary.mockResolvedValue({ mine: { open: 1, overdue: 1, dueToday: 0 } });
});

afterEach(() => {
  visibility('visible');
  vi.useRealTimers();
  api.getTaskSummary.mockReset();
});

function renderSummary() {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useTaskSummary(), { wrapper });
}

describe('useTaskSummary (spec 0016, AC-7)', () => {
  it('reads the summary at once and again every minute while the tab is visible', async () => {
    const { result } = renderSummary();
    await waitFor(() => expect(result.current.summary?.mine.overdue).toBe(1));
    expect(api.getTaskSummary).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(api.getTaskSummary).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(api.getTaskSummary).toHaveBeenCalledTimes(3);
  });

  it('does not poll while the tab is hidden', async () => {
    const { result } = renderSummary();
    await waitFor(() => expect(result.current.summary).toBeDefined());
    act(() => visibility('hidden'));

    await act(() => vi.advanceTimersByTimeAsync(180_000));
    expect(api.getTaskSummary).toHaveBeenCalledTimes(1);
  });

  it.each(['off', null])('does not call the api while the tasks module is %s', async (state) => {
    modules.tasks = state;
    renderSummary();

    await act(() => vi.advanceTimersByTimeAsync(180_000));
    expect(api.getTaskSummary).not.toHaveBeenCalled();
  });
});
