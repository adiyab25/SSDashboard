import { pageLanguage } from '@/i18n/page-language';
import { PartnerAccountPage } from '@/partner/partner-account-page';

/** The partner user's own account (`/en/partner/account`, `/ar/partner/account`). */
export default async function Page() {
  return <PartnerAccountPage language={await pageLanguage()} />;
}
