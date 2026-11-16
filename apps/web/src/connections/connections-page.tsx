'use client';

import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import { useInfiniteQuery } from '@tanstack/react-query';
import { LoaderCircleIcon, PlugZapIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { AccessErrorState } from '@/access/access-error-state';
import { NoAccessState } from '@/access/no-access-state';
import { useAccess } from '@/access/use-access';
import { ConnectionListTable } from './connection-list-table';
import { connectionKeys, listConnections } from './connections-api';

/**
 * The Connections page at `/connections` (spec 0015, AC-27): each connection's name, store code,
 * provider, status, and health with its reason and warnings in words, and the action that connects
 * a Shopify store. Opened by its address without `settings.manage` it shows the no access state
 * and asks the api for nothing; the api enforces the permission too. It never shows a secret.
 */
export function ConnectionsPage() {
  const access = useAccess();
  const allowed = access.can('settings.manage');
  const { t } = useTranslation();

  const query = useInfiniteQuery({
    queryKey: connectionKeys.list,
    queryFn: ({ pageParam, signal }) => listConnections(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: allowed,
  });

  if (access.failed) {
    return <AccessErrorState titleKey="connections.title" onRetry={access.retry} />;
  }
  if (access.ready && !allowed) return <NoAccessState titleKey="connections.title" />;

  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
  const loading = !access.ready || query.isPending;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">{t('connections.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('connections.description')}</p>
        </div>
        <Button asChild>
          <Link href="/connections/new">
            <PlugZapIcon aria-hidden data-icon="inline-start" />
            {t('connections.newConnection')}
          </Link>
        </Button>
      </div>

      {query.isError && !query.data ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {t('connections.loadError')}
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              {t('connections.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : loading ? (
        <div className="flex flex-col gap-2" aria-busy>
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-row w-full" aria-hidden />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-1 rounded-card gradient-card-edge px-4 py-10 text-center">
          <p className="font-medium">{t('connections.emptyTitle')}</p>
          <p className="text-sm text-muted-foreground">{t('connections.emptyBody')}</p>
        </div>
      ) : (
        <ConnectionListTable rows={rows} />
      )}

      {query.hasNextPage && (
        <Button
          variant="outline"
          className="self-center"
          disabled={query.isFetchingNextPage}
          aria-busy={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage && (
            <LoaderCircleIcon
              aria-hidden
              className="animate-spin motion-reduce:animate-none"
              data-icon="inline-start"
            />
          )}
          {t('connections.loadMore')}
        </Button>
      )}
    </div>
  );
}
