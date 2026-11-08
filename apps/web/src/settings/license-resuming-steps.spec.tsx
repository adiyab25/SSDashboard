import { createI18n } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import { LicenseResumingSteps } from './license-resuming-steps';

describe('LicenseResumingSteps (AC-19)', () => {
  it('draws nothing for no steps', () => {
    const { container } = render(<LicenseResumingSteps steps={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names each step and says it acts only on new events', () => {
    render(<LicenseResumingSteps steps={['currency', 'step.unknown_in_this_build']} />);
    expect(screen.getByText('These steps will start working again:')).toBeVisible();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('step.unknown_in_this_build')).toBeVisible();
    expect(screen.getByText(/They act only on new events/)).toBeVisible();
  });

  it('words steps waiting for a renewal in the license section', () => {
    render(<LicenseResumingSteps steps={['currency']} waiting />);
    expect(
      screen.getByText(/resume when the license is renewed, acting only on new events/),
    ).toBeVisible();
    expect(screen.queryByText(/They act only on new events/)).toBeNull();
  });

  it('is worded in Arabic', () => {
    const i18n = createI18n({ language: 'ar', catalogs: { ar } });
    render(
      <I18nextProvider i18n={i18n}>
        <LicenseResumingSteps steps={['currency']} />
      </I18nextProvider>,
    );
    expect(screen.getByText('ستعود هذه الخطوات إلى العمل:')).toBeVisible();
    expect(screen.getByText(/الأحداث الجديدة فقط/)).toBeVisible();
  });
});
