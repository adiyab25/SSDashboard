import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import { flatten } from '@ssdashboard/i18n';
import { createI18n } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { en } from '@ssdashboard/i18n';
import { ReturnsPage } from './returns-page';

const enFlat = flatten(en);
const arFlat = flatten(ar);

function inLanguage(code: 'en' | 'ar') {
  const i18n = createI18n();
  i18n.addResourceBundle('ar', 'translation', ar);
  void i18n.changeLanguage(code);
  return render(
    <I18nextProvider i18n={i18n}>
      <ReturnsPage />
    </I18nextProvider>,
  );
}

describe('ReturnsPage', () => {
  it.each(['title', 'description'])('has an English and an Arabic %s', (field) => {
    expect(enFlat['portal.returns.' + field]).toBeTruthy();
    expect(arFlat['portal.returns.' + field]).toBeTruthy();
  });

  it.each([['en'], ['ar']] as const)('has exactly one h1 in %s', (code) => {
    inLanguage(code);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      (code === 'en' ? enFlat : arFlat)['portal.returns.title'],
    );
  });
});
