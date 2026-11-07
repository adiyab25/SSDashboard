import { createI18n } from '@ssdashboard/i18n';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import { PeopleTabs, type PeopleTab } from './people-tabs';

function Harness() {
  const [tab, setTab] = useState<PeopleTab>('staff');
  return <PeopleTabs tab={tab} onTabChange={setTab} />;
}

describe('PeopleTabs (spec 0008, AC-15, AC-18)', () => {
  it('names the two tabs, selects Staff first, and keeps one tab stop', () => {
    render(<Harness />);

    expect(screen.getByRole('tablist', { name: 'People' })).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Staff' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Staff' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Partner logins' })).toHaveAttribute('tabindex', '-1');
  });

  it('moves with the arrow keys, Home and End, and a click', async () => {
    render(<Harness />);
    await userEvent.tab();
    expect(screen.getByRole('tab', { name: 'Staff' })).toHaveFocus();

    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Partner logins' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Partner logins' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await userEvent.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Staff' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Partner logins' })).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Staff' })).toHaveFocus();

    await userEvent.click(screen.getByRole('tab', { name: 'Partner logins' }));
    expect(screen.getByRole('tab', { name: 'Partner logins' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('gives each tab its own panel id', () => {
    render(<Harness />);

    const controls = screen.getAllByRole('tab').map((tab) => tab.getAttribute('aria-controls'));
    expect(controls).toEqual(['people-panel-staff', 'people-panel-partners']);
  });

  it('flips the arrows in right to left: the arrow toward the end goes to the next tab (review r15)', async () => {
    render(
      <I18nextProvider i18n={createI18n({ language: 'ar' })}>
        <Harness />
      </I18nextProvider>,
    );
    const [staff, partners] = screen.getAllByRole('tab');
    await userEvent.tab();
    expect(staff).toHaveFocus();

    await userEvent.keyboard('{ArrowLeft}');
    expect(partners).toHaveFocus();
    expect(partners).toHaveAttribute('aria-selected', 'true');

    await userEvent.keyboard('{ArrowRight}');
    expect(staff).toHaveFocus();
    expect(staff).toHaveAttribute('aria-selected', 'true');
  });
});
