'use client';

import type { TaskListRow } from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import { useInfiniteQuery } from '@tanstack/react-query';
import { CircleCheckIcon, LoaderCircleIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CloseTaskDialog } from './close-task-dialog';
import { TaskRowCard } from './task-row-card';
import { listMyTasks, taskKeys } from './tasks-api';

/**
 * The plain list of My work (spec 0016, AC-5, AC-14): the caller's open tasks in the api's due
 * order, earliest first, in keyset pages with Load more. Loading shows card shaped skeletons, an
 * empty list the design system's empty pattern, a failed first page an inline alert with Try
 * again. The Close dialog opens from a row; when it closes, focus lands on the list if the row
 * is gone. It sorts nothing itself and shows no personal data.
 */
export function MyWorkList({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const [closing, setClosing] = useState<TaskListRow | null>(null);
  const listRegion = useRef<HTMLElement>(null);

  const query = useInfiniteQuery({
    queryKey: taskKeys.mine,
    queryFn: ({ pageParam, signal }) => listMyTasks(pageParam, signal),
    enabled,
    retry: false,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

  const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];

  return (
    <section
      ref={listRegion}
      tabIndex={-1}
      aria-label={t('tasks.list.label')}
      aria-busy={query.isPending}
      className="flex min-w-0 flex-col gap-3 outline-none"
    >
      {query.isError && !query.data ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {t('tasks.list.loadError')}
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              {t('tasks.list.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : query.isPending ? (
        <div className="flex flex-col gap-2" aria-hidden>
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-24 w-full sm:h-20" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border px-4 py-10 text-center">
          <CircleCheckIcon aria-hidden className="size-8 text-muted-foreground" />
          <p className="font-medium">{t('tasks.list.emptyTitle')}</p>
          <p className="max-w-prose text-sm text-muted-foreground">{t('tasks.list.emptyBody')}</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((task) => (
            <TaskRowCard key={task.id} task={task} onClose={setClosing} />
          ))}
        </ul>
      )}

      {query.isFetchNextPageError && (
        <Alert variant="destructive">
          <AlertDescription>{t('tasks.list.loadError')}</AlertDescription>
        </Alert>
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
          {t('tasks.list.loadMore')}
        </Button>
      )}

      {closing && (
        <CloseTaskDialog
          task={closing}
          onDismiss={() => setClosing(null)}
          onRestoreFocus={() => listRegion.current?.focus()}
        />
      )}
    </section>
  );
}
