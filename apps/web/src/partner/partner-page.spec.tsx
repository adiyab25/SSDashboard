import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { flatten } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { en } from '@ssdashboard/i18n';
import { PartnerPage } from './partner-page';

const enFlat = flatten(en);
const arFlat = flatten(ar);

function inLanguage(code: 'en' | 'ar') {
  return render(<PartnerPage language={code} />);
}

describe('PartnerPage', () => {
  it.each(['title', 'description'])('has an English and an Arabic %s', (field) => {
    expect(enFlat['partner.home.' + field]).toBeTruthy();
    expect(arFlat['partner.home.' + field]).toBeTruthy();
  });

  it.each([['en'], ['ar']] as const)(
    'links to the same page in the other language in %s',
    (code) => {
      inLanguage(code);
      const other = code === 'en' ? 'ar' : 'en';

      expect(
        screen.getByRole('link', { name: code === 'en' ? 'العربية' : 'English' }),
      ).toHaveAttribute('href', `/${other}/partner`);
      expect(
        screen.getByRole('link', { name: code === 'en' ? 'العربية' : 'English' }),
      ).toHaveAttribute('hreflang', other);
      expect(
        screen.getByRole('link', { name: code === 'en' ? 'العربية' : 'English' }),
      ).toHaveAttribute('lang', other);
    },
  );

  it.each([['en'], ['ar']] as const)('has exactly one h1 in %s', (code) => {
    inLanguage(code);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      (code === 'en' ? enFlat : arFlat)['partner.home.title'],
    );
  });

  it.each([['en'], ['ar']] as const)(
    'renders inside its frame with one main landmark in %s',
    (code) => {
      const { container } = inLanguage(code);

      expect(screen.getAllByRole('main')).toHaveLength(1);
      expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
      expect(container.querySelector('[data-slot="partner-frame"]')).not.toBeNull();
      expect(container.querySelector('style, [style*="--brand"]')).toBeNull();
    },
  );

  it.each([['en'], ['ar']] as const)(
    'lists only the pages that exist in the navigation in %s',
    (code) => {
      inLanguage(code);
      const nav = within(screen.getByRole('navigation'));

      const flat = code === 'en' ? enFlat : arFlat;
      const home = nav.getByRole('link', { name: flat['partner.nav.home'] });
      const account = nav.getByRole('link', { name: flat['partner.home.account'] });

      expect(nav.getAllByRole('link')).toHaveLength(2);
      expect(home).toHaveAttribute('aria-current', 'page');
      expect(home).toHaveAttribute('href', `/${code}/partner`);
      expect(account).not.toHaveAttribute('aria-current');
      expect(account).toHaveAttribute('href', `/${code}/partner/account`);
    },
  );
});
