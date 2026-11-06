import { pageLanguage } from '@/i18n/page-language';
import { ReturnsPage } from '@/portal/returns-page';

/** The public exchange and return portal (`/ar/returns`, `/en/returns`). */
export default async function Page() {
  return <ReturnsPage language={await pageLanguage()} />;
}
