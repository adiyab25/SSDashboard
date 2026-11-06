import { pageLanguage } from '@/i18n/page-language';
import { PartnerPage } from '@/partner/partner-page';

/** The consignment partner page (`/ar/partner`, `/en/partner`). */
export default async function Page() {
  return <PartnerPage language={await pageLanguage()} />;
}
