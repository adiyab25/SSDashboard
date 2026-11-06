import { createTranslatorSync, type Catalog, type CoreLanguage } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { PartnerFrame } from '@ssdashboard/ui/frames/partner-frame';
import { AccountPage } from '@/account/account-page';
import { OtherLanguageLink } from '@/i18n/other-language-link';
import { PartnerAccountStrings } from './partner-account-strings';

/** One group of the Arabic catalog, or an empty one. */
function group(name: string): Catalog {
  const value = ar[name];
  return typeof value === 'object' ? value : {};
}

/**
 * The partner user's own account (spec 0005, AC-28): the same screen staff use, inside the
 * `PartnerFrame` like the partner home, reading and saving through `/api/partner/me`. A server
 * component for the frame and the language link; the details load in the client component, as
 * everywhere. The frame's `title` is the page's one `h1` (so `AccountPage` is drawn `inFrame`),
 * and its navigation is the way back to the partner home.
 */
export function PartnerAccountPage({ language }: { language: CoreLanguage }) {
  const { t } = createTranslatorSync(language, { ar });

  return (
    <PartnerFrame
      brand={{ name: t('shell.clientNameFallback') }}
      partnerName={t('partner.frame.partnerName')}
      title={t('account.title')}
      navLabel={t('partner.nav.label')}
      navItems={[
        { label: t('partner.nav.home'), href: `/${language}/partner` },
        { label: t('partner.home.account'), href: `/${language}/partner/account`, current: true },
      ]}
      actions={<OtherLanguageLink language={language} path="/partner/account" />}
    >
      <PartnerAccountStrings
        language={language}
        catalog={{ account: group('account'), auth: group('auth') }}
      >
        <AccountPage audience="partner" inFrame />
      </PartnerAccountStrings>
    </PartnerFrame>
  );
}
