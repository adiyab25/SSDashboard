import { createTranslatorSync, type CoreLanguage } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { OtherLanguageLink } from '@/i18n/other-language-link';

/**
 * Placeholder for the public exchange and return portal (spec 0007, section 2). A server
 * component: the text is rendered on the server in the page's language (spec 0004, AC-16).
 */
export function ReturnsPage({ language }: { language: CoreLanguage }) {
  const { t } = createTranslatorSync(language, { ar });

  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-xl font-semibold">{t('portal.returns.title')}</h1>
      <p className="text-muted-foreground">{t('portal.returns.description')}</p>
      <OtherLanguageLink language={language} path="/returns" />
    </div>
  );
}
