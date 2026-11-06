import { notFound } from 'next/navigation';
import { pageLanguage } from '@/i18n/page-language';

/** Development only: the portal frame with the sample brand, shown inside `/design`; production answers 404. */
export default async function Page() {
  if (process.env.NODE_ENV === 'production') notFound();
  const { PortalFramePreview } = await import('@/design/portal-frame-preview');
  return <PortalFramePreview language={await pageLanguage()} sample="brand" />;
}
