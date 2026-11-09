import { Suspense } from 'react';
import { StyleDetailPage } from '@/catalog/styles/style-detail-page';
import { StyleDetailSkeleton } from '@/catalog/styles/style-detail-skeleton';

/** One style. The id is only known at request time, so its reader sits inside Suspense. */
export default function Style() {
  return (
    <Suspense fallback={<StyleDetailSkeleton />}>
      <StyleDetailPage />
    </Suspense>
  );
}
