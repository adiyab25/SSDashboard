'use client';

import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { catalogKeys, getStyle } from '../catalog-api';
import { StyleDetailSkeleton } from './style-detail-skeleton';
import { StyleView } from './style-view';

/** Loads one style by the id in the address, with its loading, not found, and error states. */
export function StyleDetailView({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const query = useQuery({
    queryKey: catalogKeys.style(id),
    queryFn: ({ signal }) => getStyle(id, signal),
    enabled,
  });

  if (query.isPending) return <StyleDetailSkeleton />;
  if (query.isError && !query.data) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold">{t('catalog.styles.title')}</h1>
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {notFound ? t('catalog.style.notFound') : t('catalog.style.loadError')}
            {!notFound && (
              <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
                {t('catalog.common.retry')}
              </Button>
            )}
            <Button asChild size="sm" variant="outline">
              <Link href="/styles">{t('catalog.style.back')}</Link>
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  return (
    <StyleView
      style={query.data}
      reload={async () => {
        const result = await query.refetch();
        return result.isError ? undefined : result.data;
      }}
    />
  );
}
