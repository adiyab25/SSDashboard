import { notFound } from 'next/navigation';
import { pageLanguage } from '@/i18n/page-language';

/** Development only: the partner frame with sample tabs, shown inside `/design`; production answers 404. */
export default async function Page() {
  if (process.env.NODE_ENV === 'production') notFound();
  const { PartnerFramePreview } = await import('@/design/partner-frame-preview');
  return <PartnerFramePreview language={await pageLanguage()} />;
}
