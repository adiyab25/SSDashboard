'use client';

import { useTranslation } from 'react-i18next';
import { AuditEntriesTable } from './audit-entries-table';

/**
 * What the `/audit` route shows while the page reads its URL query: the page's one `h1` and the
 * skeleton table, so `main` is never without its heading (a screen reader lands on the page, not
 * on an empty region). It replaces itself with `AuditPage`, which draws the same heading.
 */
export function AuditPageSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <h1 className="text-xl font-semibold">{t('audit.title')}</h1>
      <AuditEntriesTable rows={[]} loading />
    </div>
  );
}
