import { createTranslatorSync, type Catalog, type CoreLanguage } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { AccountPage } from '@/account/account-page';
import { OtherLanguageLink } from '@/i18n/other-language-link';
import { PartnerAccountStrings } from './partner-account-strings';

/** One group of the Arabic catalog, or an empty one. */
function group(name: string): Catalog {
  const value = ar[name];
  return typeof value === 'object' ? value : {};
}

/**
 * The partner user's own account (spec 0005, AC-28): the same screen staff use, inside the partner
 * frame, reading and saving through `/api/partner/me`. A server component for the frame and the
 * language link; the details load in the client component, as everywhere. The link to the other
 * language is the language switch here, because the partner frame has no menu.
 */
export function PartnerAccountPage({ language }: { language: CoreLanguage }) {
  const { t } = createTranslatorSync(language, { ar });

  return (
    <PartnerAccountStrings
      language={language}
      catalog={{ account: group('account'), auth: group('auth') }}
    >
      <div className="flex flex-col gap-6">
        <AccountPage audience="partner" />
        <div className="flex flex-wrap gap-4">
          <a
            href={`/${language}/partner`}
            className="w-fit text-sm font-medium underline underline-offset-4"
          >
            {t('partner.home.title')}
          </a>
          <OtherLanguageLink language={language} path="/partner/account" />
        </div>
      </div>
    </PartnerAccountStrings>
  );
}
