import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from './language-provider';
import { LanguageProbe, readout, resetLanguageState, stubNetwork } from './language-test-utils';

// The Arabic chunk neither loads nor fails, as on a stalled connection.
vi.mock('./locales/ar', () => new Promise(() => {}));

// AC-13: a load that never answers is given up on, so the menu does not wait forever.
describe('a catalog that never answers', () => {
  beforeEach(() => {
    resetLanguageState();
    stubNetwork({ config: { languages: ['en', 'ar'] } });
  });
  afterEach(() => {
    vi.useRealTimers();
    resetLanguageState();
  });

  it('counts as failed after the cap and keeps the current language', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <LanguageProvider>
        <LanguageProbe />
      </LanguageProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    await user.click(screen.getByRole('button', { name: 'choose ar' }));
    expect(readout('failed')).toBe('');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6100);
    });

    expect(readout('failed')).toBe('ar');
    expect(readout('language')).toBe('en');
    expect(document.documentElement.lang).not.toBe('ar');
  });
});
