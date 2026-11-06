import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { flatten } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { en } from '@ssdashboard/i18n';
import { ReturnsPage } from './returns-page';

const enFlat = flatten(en);
const arFlat = flatten(ar);

function inLanguage(code: 'en' | 'ar') {
  return render(<ReturnsPage language={code} />);
}

describe('ReturnsPage', () => {
  it.each(['title', 'description'])('has an English and an Arabic %s', (field) => {
    expect(enFlat['portal.returns.' + field]).toBeTruthy();
    expect(arFlat['portal.returns.' + field]).toBeTruthy();
  });

  it.each([['en'], ['ar']] as const)(
    'links to the same page in the other language in %s',
    (code) => {
      inLanguage(code);
      const other = code === 'en' ? 'ar' : 'en';

      expect(screen.getByRole('link')).toHaveAttribute('href', `/${other}/returns`);
      expect(screen.getByRole('link')).toHaveAttribute('hreflang', other);
      expect(screen.getByRole('link')).toHaveAttribute('lang', other);
    },
  );

  it.each([['en'], ['ar']] as const)('has exactly one h1 in %s', (code) => {
    inLanguage(code);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      (code === 'en' ? enFlat : arFlat)['portal.returns.title'],
    );
  });
});
