import { createI18n } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import { NoAccessState } from './no-access-state';

describe('NoAccessState (spec 0008, AC-11)', () => {
  it('draws the page title as the one h1, says there is no access, and offers the overview', () => {
    render(<NoAccessState titleKey="staff.title" />);

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Staff');
    expect(screen.getByText('You do not have access to this page')).toBeVisible();
    expect(screen.getByText(/Ask a manager to add the hat or permission you need/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Go to the overview' })).toHaveAttribute('href', '/');
  });

  it('reads in Arabic too', () => {
    const i18n = createI18n({ language: 'ar', catalogs: { ar } });
    render(
      <I18nextProvider i18n={i18n}>
        <NoAccessState titleKey="staff.title" />
      </I18nextProvider>,
    );

    expect(screen.getByText('ليست لديك صلاحية الوصول إلى هذه الصفحة')).toBeVisible();
    expect(screen.getByRole('link', { name: 'الانتقال إلى النظرة العامة' })).toBeVisible();
  });
});
