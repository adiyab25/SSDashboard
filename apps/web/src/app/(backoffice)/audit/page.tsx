import { Suspense } from 'react';
import { AuditPage } from '@/audit/audit-page';
import { AuditPageSkeleton } from '@/audit/audit-page-skeleton';

/**
 * The audit trail (admins); it loads in a client component. The filters are read from the URL
 * query on the client, so the reader sits inside Suspense, with the heading and a skeleton table
 * as its fallback.
 */
export default function Audit() {
  return (
    <Suspense fallback={<AuditPageSkeleton />}>
      <AuditPage />
    </Suspense>
  );
}
