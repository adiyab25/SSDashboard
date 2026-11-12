import { CORE_LANGUAGES } from '@ssdashboard/i18n';
import { act } from '@testing-library/react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { useLanguage } from './language-provider';
import { useFormat } from './use-format';

// The install settings the mocked provider hands out: null on the "server", loaded on the client.
const settings = vi.hoisted(() => ({ loaded: false }));

vi.mock('./language-provider', () => ({
  useLanguage: (): ReturnType<typeof useLanguage> => ({
    language: 'en',
    direction: 'ltr',
    info: CORE_LANGUAGES.en,
    options: [],
    config: settings.loaded
      ? {
          clientName: 'Acme',
          version: '1.0.0',
          currency: 'EGP',
          timezone: 'Africa/Cairo',
          languages: ['en'],
          defaultLanguage: 'en',
          mailEnabled: false,
        }
      : null,
    configStatus: settings.loaded ? 'ready' : 'loading',
    failedLanguage: null,
    setLanguage: () => Promise.resolve(false),
    clearFailure: () => {},
  }),
}));

function Money() {
  const format = useFormat();
  return (
    <p>
      <span data-testid="money">{format.money('412500.00', 2)}</span>
      <span data-testid="status">{format.status}</span>
    </p>
  );
}

describe('useFormat while hydrating', () => {
  afterEach(() => {
    settings.loaded = false;
    document.body.innerHTML = '';
  });

  // The phone dashboard sample streams in behind the session check, so `/api/config` can answer
  // before that part hydrates. Hydration must still see the server's raw value, then format.
  it('hydrates with the raw value when the settings answered first, then formats', async () => {
    const container = document.createElement('div');
    container.innerHTML = renderToString(<Money />);
    document.body.append(container);
    expect(container.textContent).toBe('412500.00loading');

    settings.loaded = true;
    const onRecoverableError = vi.fn();
    await act(() => {
      hydrateRoot(container, <Money />, { onRecoverableError });
      return Promise.resolve();
    });

    expect(onRecoverableError).not.toHaveBeenCalled();
    const money = container.querySelector('[data-testid="money"]')?.textContent ?? '';
    expect(money.replace(/\s/g, ' ')).toBe('EGP 412,500.00');
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('ready');
  });
});
