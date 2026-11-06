import { createTranslatorSync, type CoreLanguage } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { PartnerFrame } from '@ssdashboard/ui/frames/partner-frame';
import { OtherLanguageLink } from '@/i18n/other-language-link';

/**
 * Placeholder for the consignment partner area (spec 0007, section 2), inside the `PartnerFrame`
 * (spec 0003, AC-18). A server component: the text is rendered on the server in the page's
 * language (spec 0004, AC-16). Only the pages that exist are in the navigation (the home page
 * today; statements, stock and settlement join when they ship). There is no brand settings
 * endpoint or partner session yet, so the frame shows the neutral primary, the install's fallback
 * name, and a generic partner label; it must never call a staff api route.
 */
export function PartnerPage({ language }: { language: CoreLanguage }) {
  const { t } = createTranslatorSync(language, { ar });

  return (
    <PartnerFrame
      brand={{ name: t('shell.clientNameFallback') }}
      partnerName={t('partner.frame.partnerName')}
      title={t('partner.home.title')}
      navLabel={t('partner.nav.label')}
      navItems={[{ label: t('partner.nav.home'), href: `/${language}/partner`, current: true }]}
      actions={<OtherLanguageLink language={language} path="/partner" />}
    >
      <p className="text-muted-foreground">{t('partner.home.description')}</p>
    </PartnerFrame>
  );
}
