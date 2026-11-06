import { createFormatter } from '@ssdashboard/i18n';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LanguageProvider, useLanguage } from './language-provider';
import { resetLanguageState, stubNetwork } from './language-probe';
import { useFormat } from './use-format';

function Sample() {
  const format = useFormat();
  const { setLanguage } = useLanguage();
  return (
    <>
      <output aria-label="status">{format.status}</output>
      <output aria-label="money">{format.money('1234.5', 2)}</output>
      <output aria-label="time">{format.time('2026-11-03T22:30:00Z')}</output>
      <output aria-label="number">{format.number('1234.5')}</output>
      <button onClick={() => void setLanguage('ar')}>arabic</button>
    </>
  );
}

const text = (name: string) => screen.getByLabelText(name).textContent ?? '';
const plain = (value: string) => value.replace(/[‎‏؜]/g, '');

// AC-8: the hook follows the active language and the install settings.
describe('useFormat', () => {
  beforeEach(resetLanguageState);
  afterEach(resetLanguageState);

  it('works for plain numbers before config loads, and says money is still loading', () => {
    stubNetwork({ config: 'fail' });

    render(
      <LanguageProvider>
        <Sample />
      </LanguageProvider>,
    );

    expect(text('number')).toBe('1,234.5');
    expect(text('status')).toBe('loading');
    expect(text('money')).toBe('1234.5');
  });

  it('formats money and time with the install settings once config loads', async () => {
    stubNetwork({ config: {} });

    render(
      <LanguageProvider>
        <Sample />
      </LanguageProvider>,
    );

    await waitFor(() => expect(text('status')).toBe('ready'));
    expect(text('money').replace(/\u00a0/g, ' ')).toBe('EGP 1,234.50');
    expect(text('time')).toBe('00:30');
  });

  it('switches to the Arabic clock and money style when the language changes', async () => {
    stubNetwork({ config: {} });
    render(
      <LanguageProvider>
        <Sample />
      </LanguageProvider>,
    );
    await waitFor(() => expect(text('status')).toBe('ready'));

    await userEvent.click(screen.getByRole('button', { name: 'arabic' }));

    await waitFor(() => expect(plain(text('time'))).toBe('12:30 ص'));
    expect(plain(text('money')).replace(/\u00a0/g, ' ')).toBe('1,234.50 ج.م.');
    expect(text('number')).toBe('1,234.5');
  });
});

// AC-19: the web hook and the shared formatter give identical text for EGP.
describe('useFormat parity with createFormatter (AC-19)', () => {
  beforeEach(resetLanguageState);
  afterEach(resetLanguageState);

  const instant = '2026-04-23T22:00:00Z';

  function Everything() {
    const format = useFormat();
    const { setLanguage } = useLanguage();
    return (
      <>
        <output aria-label="status">{format.status}</output>
        <output aria-label="all">
          {JSON.stringify([
            format.number('1234.5'),
            format.quantity(12000),
            format.percent('14.00'),
            format.money('1234.5', 2),
            format.date(instant),
            format.dateNumeric(instant),
            format.dateOnly('2026-04-24'),
            format.time(instant),
            format.dateTime(instant),
          ])}
        </output>
        <button onClick={() => void setLanguage('ar')}>arabic</button>
      </>
    );
  }

  const expected = (language: string) => {
    const f = createFormatter({ language, currency: 'EGP', timezone: 'Africa/Cairo' });
    return JSON.stringify([
      f.number('1234.5'),
      f.quantity(12000),
      f.percent('14.00'),
      f.money('1234.5', 2),
      f.date(instant),
      f.dateNumeric(instant),
      f.dateOnly('2026-04-24'),
      f.time(instant),
      f.dateTime(instant),
    ]);
  };

  it('matches in English and in Arabic', async () => {
    stubNetwork({ config: {} });
    render(
      <LanguageProvider>
        <Everything />
      </LanguageProvider>,
    );
    await waitFor(() => expect(text('status')).toBe('ready'));
    expect(text('all')).toBe(expected('en'));

    await userEvent.click(screen.getByRole('button', { name: 'arabic' }));

    await waitFor(() => expect(text('all')).toBe(expected('ar')));
  });
});
