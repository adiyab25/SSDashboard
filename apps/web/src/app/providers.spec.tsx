import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, resetApiFetchForTests } from '@/auth/api-fetch';
import { modulesAnswer } from '@/shell/module-fixtures';
import { useModuleStates } from '@/shell/use-module-states';
import { Providers } from './providers';

const api = vi.hoisted(() => ({ getModuleStates: vi.fn() }));
vi.mock('@/shell/module-states-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

/** Subscribes to the module states, as the shell does. */
function Probe() {
  useModuleStates();
  return null;
}

describe('Providers (spec 0009, AC-9)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    resetApiFetchForTests();
    vi.stubGlobal('fetch', fetchMock);
    api.getModuleStates.mockResolvedValue(modulesAnswer());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    api.getModuleStates.mockReset();
  });

  const answer = (status: number, code: string) =>
    new Response(JSON.stringify({ code }), { status });

  it('reads the module states again at once when any api call answers 404 MODULE_OFF', async () => {
    render(
      <Providers>
        <Probe />
      </Providers>,
    );
    await waitFor(() => expect(api.getModuleStates).toHaveBeenCalledTimes(1));

    fetchMock.mockResolvedValueOnce(answer(404, 'MODULE_OFF'));
    await apiFetch('/api/orders');
    await waitFor(() => expect(api.getModuleStates).toHaveBeenCalledTimes(2));

    fetchMock.mockResolvedValueOnce(answer(409, 'MODULE_LIMITED'));
    await apiFetch('/api/orders');
    await waitFor(() => expect(api.getModuleStates).toHaveBeenCalledTimes(3));
  });

  it('shares one running read between a burst of refusals and never aborts it', async () => {
    render(
      <Providers>
        <Probe />
      </Providers>,
    );
    await waitFor(() => expect(api.getModuleStates).toHaveBeenCalledTimes(1));

    // The next read stays pending until the test lets it finish.
    let finish: (value: ReturnType<typeof modulesAnswer>) => void = () => {};
    api.getModuleStates.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    for (let count = 0; count < 3; count += 1) {
      fetchMock.mockResolvedValueOnce(answer(404, 'MODULE_OFF'));
      await apiFetch('/api/orders');
    }
    await waitFor(() => expect(api.getModuleStates).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(api.getModuleStates).toHaveBeenCalledTimes(2);
    const signal = api.getModuleStates.mock.calls[1]?.[0] as AbortSignal;
    expect(signal.aborted).toBe(false);
    finish(modulesAnswer());
  });

  it('does not read them again for any other refusal', async () => {
    render(
      <Providers>
        <Probe />
      </Providers>,
    );
    await waitFor(() => expect(api.getModuleStates).toHaveBeenCalledTimes(1));

    fetchMock.mockResolvedValueOnce(answer(404, 'NOT_FOUND'));
    await apiFetch('/api/orders');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.getModuleStates).toHaveBeenCalledTimes(1);
  });

  it('stops listening when it unmounts', async () => {
    const view = render(
      <Providers>
        <Probe />
      </Providers>,
    );
    await waitFor(() => expect(api.getModuleStates).toHaveBeenCalledTimes(1));
    view.unmount();

    fetchMock.mockResolvedValueOnce(answer(404, 'MODULE_OFF'));
    await apiFetch('/api/orders');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.getModuleStates).toHaveBeenCalledTimes(1);
  });
});
