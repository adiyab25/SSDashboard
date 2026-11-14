'use client';

import type { GroupingListStatus } from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Badge } from '@ssdashboard/ui/components/badge';
import { Button } from '@ssdashboard/ui/components/button';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import { CollapsingTable } from '@ssdashboard/ui/dashboard/collapsing-table';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarRangeIcon, LayersIcon, LoaderCircleIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { refetchAfterWrite } from '@/api/refetch-after-write';
import { useFormat } from '@/i18n/use-format';
import { useLocalizedText } from '@/i18n/use-localized-text';
import { inventoryKeys } from '@/inventory/inventory-api';
import { ConfirmActionDialog } from '@/inventory/confirm-action-dialog';
import {
  catalogKeys,
  deleteGrouping,
  listGroupings,
  setGroupingArchived,
  type GroupingKind,
  type GroupingRow,
} from './catalog-api';
import { catalogErrorCode } from './catalog-error';
import { GroupingDialog } from './grouping-dialog';
import { GROUPING_ERRORS, groupingErrorKey, groupingPrefix } from './grouping-errors';

/** The most pages a reload reads to find a row that changed status (100 rows each). */
const MAX_RELOAD_PAGES = 20;

const STATUSES: readonly GroupingListStatus[] = ['active', 'archived', 'all'];

/** The confirmed actions on a row. */
type Action = 'archive' | 'unarchive' | 'delete';

/**
 * The seasons or product groups list (spec 0012, AC-6, AC-7, AC-18): an active, archived, or all
 * switch, then code, name, dates (seasons), and status, with create, edit, archive, unarchive,
 * and delete for people holding `catalog.manage` (the page gate). A protected row (`CORE`,
 * `MAIN`) shows why it cannot be archived or deleted instead of those buttons. Below 640px the
 * table becomes cards. Every write refreshes the lists, the pickers, and the style and SKU lists
 * that show the names, with `refetchAfterWrite`.
 */
export function GroupingListView({ kind, enabled }: { kind: GroupingKind; enabled: boolean }) {
  const { t } = useTranslation();
  const text = useLocalizedText();
  const format = useFormat();
  const queryClient = useQueryClient();
  const prefix = groupingPrefix(kind);
  const [status, setStatus] = useState<GroupingListStatus>('active');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<GroupingRow | null>(null);
  const [confirm, setConfirm] = useState<{ action: Action; row: GroupingRow } | null>(null);

  const query = useInfiniteQuery({
    queryKey: catalogKeys.groupingList(kind, status),
    queryFn: ({ pageParam, signal }) => listGroupings(kind, status, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled,
  });
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];

  const refreshAfterWrite = () => {
    void refetchAfterWrite(queryClient, { queryKey: catalogKeys.groupings(kind) });
    void refetchAfterWrite(queryClient, { queryKey: catalogKeys.styles });
    void refetchAfterWrite(queryClient, { queryKey: inventoryKeys.skus });
  };

  const act = useMutation({
    mutationFn: ({ action, row }: { action: Action; row: GroupingRow }) =>
      action === 'delete'
        ? deleteGrouping(kind, row.id)
        : setGroupingArchived(kind, row.id, action === 'archive').then(() => undefined),
    onSuccess: (_result, { action, row }) => {
      refreshAfterWrite();
      const done = {
        archive: `catalog.${prefix}.archivedDone`,
        unarchive: `catalog.${prefix}.unarchivedDone`,
        delete: `catalog.${prefix}.deletedDone`,
      } as const;
      toast.success(t(done[action], { code: row.code }));
      setConfirm(null);
    },
  });

  const reloadOne = async (id: string) => {
    const result = await query.refetch();
    const inList = result.data?.pages.flatMap((page) => page.items).find((row) => row.id === id);
    if (inList || status === 'all') return inList;
    // The row may have moved to another status (archived or unarchived meanwhile): look in all.
    let cursor: string | undefined;
    for (let page = 0; page < MAX_RELOAD_PAGES; page += 1) {
      const answer = await listGroupings(kind, 'all', cursor);
      const found = answer.items.find((row) => row.id === id);
      if (found || !answer.nextCursor) return found;
      cursor = answer.nextCursor;
    }
    return undefined;
  };

  const open = (action: Action, row: GroupingRow) => {
    act.reset();
    setConfirm({ action, row });
  };

  const datesOf = (row: GroupingRow) => {
    if (!('startsOn' in row)) return null;
    const start = row.startsOn ? format.dateOnly(row.startsOn) : null;
    const end = row.endsOn ? format.dateOnly(row.endsOn) : null;
    if (start && end) return t('catalog.grouping.dateRange', { start, end });
    if (start) return t('catalog.grouping.dateFrom', { start });
    if (end) return t('catalog.grouping.dateUntil', { end });
    return <span className="text-muted-foreground">{t('catalog.grouping.noDates')}</span>;
  };

  const columns = [
    {
      id: 'code',
      header: t('catalog.grouping.columns.code'),
      title: true,
      cell: (row: GroupingRow) => (
        <span className="flex flex-wrap items-center gap-2 font-medium">
          <LtrText>{row.code}</LtrText>
          {row.protected && <Badge variant="outline">{t('catalog.grouping.protectedBadge')}</Badge>}
        </span>
      ),
    },
    {
      id: 'name',
      header: t('catalog.grouping.columns.name'),
      cell: (row: GroupingRow) => text(row.name, row.code),
    },
    ...(kind === 'season'
      ? [{ id: 'dates', header: t('catalog.grouping.columns.dates'), cell: datesOf }]
      : []),
    {
      id: 'status',
      header: t('catalog.grouping.columns.status'),
      cell: (row: GroupingRow) => (
        <Badge variant={row.archived ? 'outline' : 'secondary'}>
          {row.archived ? t('catalog.common.archivedBadge') : t('catalog.common.activeBadge')}
        </Badge>
      ),
    },
    {
      id: 'actions',
      header: t('catalog.grouping.columns.actions'),
      cell: (row: GroupingRow) => (
        <div className="flex flex-col items-end gap-1 sm:items-start">
          <div className="flex flex-wrap justify-end gap-1 sm:justify-start">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={t(`catalog.${prefix}.editLabel`, { code: row.code })}
              onClick={() => setEditing(row)}
            >
              {t('catalog.grouping.edit')}
            </Button>
            {!row.protected &&
              (row.archived ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={t(`catalog.${prefix}.unarchiveLabel`, { code: row.code })}
                  onClick={() => open('unarchive', row)}
                >
                  {t('catalog.grouping.unarchive')}
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={t(`catalog.${prefix}.archiveLabel`, { code: row.code })}
                  onClick={() => open('archive', row)}
                >
                  {t('catalog.grouping.archive')}
                </Button>
              ))}
            {!row.protected && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-destructive"
                aria-label={t(`catalog.${prefix}.deleteLabel`, { code: row.code })}
                onClick={() => open('delete', row)}
              >
                {t('catalog.grouping.delete')}
              </Button>
            )}
          </div>
          {row.protected && (
            <p className="max-w-64 text-xs text-muted-foreground">
              {t(`catalog.${prefix}.protectedNote`)}
            </p>
          )}
        </div>
      ),
    },
  ];

  const EmptyIcon = kind === 'season' ? CalendarRangeIcon : LayersIcon;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">{t(`catalog.${prefix}.title`)}</h1>
          <p className="text-sm text-muted-foreground">{t(`catalog.${prefix}.description`)}</p>
        </div>
        <Button disabled={!enabled} onClick={() => setCreating(true)}>
          <PlusIcon aria-hidden data-icon="inline-start" />
          {t(`catalog.${prefix}.newItem`)}
        </Button>
      </div>

      <div role="group" aria-label={t('catalog.grouping.filterLabel')} className="flex gap-1">
        {STATUSES.map((value) => (
          <Button
            key={value}
            type="button"
            size="sm"
            variant={status === value ? 'secondary' : 'outline'}
            aria-pressed={status === value}
            onClick={() => setStatus(value)}
          >
            {t(`catalog.grouping.${value}`)}
          </Button>
        ))}
      </div>

      {query.isError && !query.data ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {t(`catalog.${prefix}.loadError`)}
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              {t('catalog.common.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : query.isPending ? (
        <div
          aria-busy
          className="flex flex-col gap-2 sm:gap-0 sm:rounded-card sm:gradient-card-edge"
        >
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="flex h-row items-center px-3" aria-hidden>
              <Skeleton className="h-4 w-full" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-card gradient-card-edge px-4 py-10 text-center">
          <EmptyIcon aria-hidden className="size-8 text-muted-foreground" />
          {status === 'archived' ? (
            <p className="text-sm text-muted-foreground">{t(`catalog.${prefix}.emptyArchived`)}</p>
          ) : (
            <>
              <p className="font-medium">{t(`catalog.${prefix}.emptyTitle`)}</p>
              <p className="text-sm text-muted-foreground">{t(`catalog.${prefix}.emptyBody`)}</p>
            </>
          )}
        </div>
      ) : (
        <CollapsingTable
          caption={t(`catalog.${prefix}.tableLabel`)}
          columns={columns}
          rows={rows}
          getRowKey={(row) => row.id}
          className="sm:overflow-hidden sm:rounded-card sm:gradient-card-edge"
        />
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
          {t('catalog.common.loadMore')}
        </Button>
      )}

      {creating && (
        <GroupingDialog
          kind={kind}
          onSaved={refreshAfterWrite}
          onClose={() => setCreating(false)}
        />
      )}
      {editing && (
        <GroupingDialog
          key={editing.id}
          kind={kind}
          row={editing}
          onReload={() => reloadOne(editing.id)}
          onSaved={refreshAfterWrite}
          onClose={() => setEditing(null)}
        />
      )}
      {confirm && (
        <ConfirmActionDialog
          title={t(`catalog.${prefix}.${confirm.action}Title`, { code: confirm.row.code })}
          description={t(`catalog.${prefix}.${confirm.action}Description`)}
          confirmLabel={t(`catalog.grouping.${confirm.action}`)}
          destructive={confirm.action === 'delete'}
          pending={act.isPending}
          error={
            act.error
              ? t(groupingErrorKey(kind, catalogErrorCode(act.error, GROUPING_ERRORS)))
              : null
          }
          onConfirm={() => act.mutate(confirm)}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
