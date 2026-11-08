'use client';

import type { LocationDetail, LocationStatus } from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Badge } from '@ssdashboard/ui/components/badge';
import { Button } from '@ssdashboard/ui/components/button';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@ssdashboard/ui/components/table';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { LoaderCircleIcon, MapPinPlusIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@/api/client';
import { useLocalizedText } from '@/i18n/use-localized-text';
import { useLocationSwitcher } from '@/shell/current-location-provider';
import { ConfirmActionDialog } from './confirm-action-dialog';
import { deleteLocation, inventoryKeys, listLocations, setLocationArchived } from './inventory-api';
import { LocationEditDialog } from './location-edit-dialog';
import { NewLocationDialog } from './new-location-dialog';

/** The table columns, in order. */
const COLUMNS = ['code', 'name', 'type', 'status', 'actions'] as const;
/** The status filter choices. */
const STATUSES: readonly LocationStatus[] = ['active', 'archived'];

/** The confirmed actions on a location. */
type Action = 'archive' | 'unarchive' | 'delete';

/** Api error codes with a message of their own. */
const KNOWN = [
  'STOCK_ON_HAND',
  'IN_USE',
  'BUSY',
  // Unarchive after the type's policy changed (spec 0009, AC-24): a new location instead.
  'OWNER_POLICY_CHANGED_SINCE_ARCHIVE',
] as const;
/** An api error code the page has its own message for. */
type KnownCode = (typeof KNOWN)[number];

/** The api error code when the page has a message for it, else `generic`. */
function errorCode(error: unknown): KnownCode | 'generic' {
  return error instanceof ApiError && (KNOWN as readonly string[]).includes(error.code)
    ? (error.code as KnownCode)
    : 'generic';
}

/** The locations table with its filter, dialogs, and archive, unarchive and delete confirmations. */
export function LocationsView({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const text = useLocalizedText();
  const queryClient = useQueryClient();
  const { retry: reloadSwitcher } = useLocationSwitcher();
  const [status, setStatus] = useState<LocationStatus>('active');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<LocationDetail | null>(null);
  const [confirm, setConfirm] = useState<{ action: Action; location: LocationDetail } | null>(null);

  const query = useInfiniteQuery({
    queryKey: inventoryKeys.locationList(status),
    queryFn: ({ pageParam, signal }) => listLocations(status, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled,
  });
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
  const loading = query.isPending;

  const act = useMutation({
    mutationFn: ({ action, location }: { action: Action; location: LocationDetail }) =>
      action === 'delete'
        ? deleteLocation(location.id)
        : setLocationArchived(location.id, action === 'archive').then(() => undefined),
    onSuccess: (_result, { action, location }) => {
      reloadSwitcher();
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.locations });
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.stockAll });
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.receiptsRoot });
      const done = {
        archive: 'inventory.locations.archivedDone',
        unarchive: 'inventory.locations.unarchivedDone',
        delete: 'inventory.locations.deletedDone',
      } as const;
      toast.success(t(done[action], { code: location.code }));
      setConfirm(null);
    },
  });

  const reloadOne = async (id: string) => {
    const result = await query.refetch();
    return result.data?.pages.flatMap((page) => page.items).find((row) => row.id === id);
  };

  const open = (action: Action, location: LocationDetail) => {
    act.reset();
    setConfirm({ action, location });
  };

  const copy = (action: Action, code: string) => ({
    title: t(`inventory.locations.${action}Title`, { code }),
    description: t(`inventory.locations.${action}Description`),
    label: t(`inventory.locations.${action}`),
  });

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">{t('inventory.locations.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('inventory.locations.description')}</p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <MapPinPlusIcon aria-hidden data-icon="inline-start" />
          {t('inventory.locations.newLocation')}
        </Button>
      </div>

      <div role="group" aria-label={t('inventory.locations.filterLabel')} className="flex gap-1">
        {STATUSES.map((value) => (
          <Button
            key={value}
            type="button"
            size="sm"
            variant={status === value ? 'secondary' : 'outline'}
            aria-pressed={status === value}
            onClick={() => setStatus(value)}
          >
            {t(`inventory.locations.${value}`)}
          </Button>
        ))}
      </div>

      {query.isError && !query.data ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {t('inventory.locations.loadError')}
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              {t('inventory.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <div className="relative overflow-hidden rounded-lg border">
          <Table aria-label={t('inventory.locations.tableLabel')} aria-busy={loading}>
            <TableHeader className="sticky top-0 bg-muted">
              <TableRow className="h-row-header hover:bg-muted">
                {COLUMNS.map((column) => (
                  <TableHead key={column} scope="col" className="px-3 text-start font-medium">
                    {t(`inventory.locations.columns.${column}`)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading &&
                Array.from({ length: 4 }, (_, index) => (
                  <TableRow key={index} className="h-row" aria-hidden>
                    <TableCell colSpan={COLUMNS.length} className="px-3">
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  </TableRow>
                ))}
              {!loading && rows.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={COLUMNS.length}
                    className="px-3 py-10 text-center text-sm text-muted-foreground"
                  >
                    {status === 'archived'
                      ? t('inventory.locations.emptyArchived')
                      : `${t('inventory.locations.emptyTitle')}. ${t('inventory.locations.emptyBody')}`}
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                rows.map((row) => (
                  <TableRow key={row.id} className="h-row hover:bg-muted">
                    <TableCell className="px-3 font-medium">
                      <LtrText>{row.code}</LtrText>
                    </TableCell>
                    <TableCell className="px-3">{text(row.name, row.code)}</TableCell>
                    <TableCell className="px-3">{t(`inventory.location.${row.kind}`)}</TableCell>
                    <TableCell className="px-3">
                      <Badge variant={row.archived ? 'outline' : 'secondary'}>
                        {row.archived
                          ? t('inventory.locations.archivedBadge')
                          : t('inventory.locations.activeBadge')}
                      </Badge>
                    </TableCell>
                    <TableCell className="px-3">
                      <div className="flex flex-wrap gap-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label={t('inventory.locations.editLabel', { code: row.code })}
                          onClick={() => setEditing(row)}
                        >
                          {t('inventory.locations.edit')}
                        </Button>
                        {row.archived ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            aria-label={t('inventory.locations.unarchiveLabel', {
                              code: row.code,
                            })}
                            onClick={() => open('unarchive', row)}
                          >
                            {t('inventory.locations.unarchive')}
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            aria-label={t('inventory.locations.archiveLabel', { code: row.code })}
                            onClick={() => open('archive', row)}
                          >
                            {t('inventory.locations.archive')}
                          </Button>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="text-destructive"
                          aria-label={t('inventory.locations.deleteLabel', { code: row.code })}
                          onClick={() => open('delete', row)}
                        >
                          {t('inventory.locations.delete')}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>
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
          {t('inventory.loadMore')}
        </Button>
      )}

      {creating && <NewLocationDialog onClose={() => setCreating(false)} />}
      {editing && (
        <LocationEditDialog
          key={editing.id}
          location={editing}
          onReload={() => reloadOne(editing.id)}
          onClose={() => setEditing(null)}
        />
      )}
      {confirm && (
        <ConfirmActionDialog
          title={copy(confirm.action, confirm.location.code).title}
          description={copy(confirm.action, confirm.location.code).description}
          confirmLabel={copy(confirm.action, confirm.location.code).label}
          destructive={confirm.action === 'delete'}
          pending={act.isPending}
          error={act.error ? t(`inventory.locations.errors.${errorCode(act.error)}`) : null}
          onConfirm={() => act.mutate(confirm)}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
