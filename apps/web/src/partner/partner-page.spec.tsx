import { render, screen } from '@testing-library/react';
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

      expect(screen.getByRole('link')).toHaveAttribute('href', `/${other}/partner`);
      expect(screen.getByRole('link')).toHaveAttribute('hreflang', other);
      expect(screen.getByRole('link')).toHaveAttribute('lang', other);
    },
  );

  it.each([['en'], ['ar']] as const)('has exactly one h1 in %s', (code) => {
    inLanguage(code);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      (code === 'en' ? enFlat : arFlat)['partner.home.title'],
    );
  });
});
