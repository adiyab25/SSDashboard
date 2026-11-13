'use client';

import { orderLabelOf, taskTypeOf, type TaskListRow } from '@ssdashboard/contracts';
import type { MessageKey } from '@ssdashboard/i18n';
import { Badge } from '@ssdashboard/ui/components/badge';
import { Button } from '@ssdashboard/ui/components/button';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { ClockIcon, InfoIcon, TriangleAlertIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';

/**
 * One task of My work (spec 0016, AC-14), a card that stays one row on a wide screen and stacks
 * at 360 CSS pixels: the type label, the record it points at (a link when the api gives a path, plain text when it does not; labelled with an order's
 * number and store, never a phone or a name), the due time in the brand's time zone (never the
 * device's), who holds it, an overdue marker with an icon and a word (never color alone), and
 * the Close action. A task only the system closes shows the reason instead of a button. It never
 * shows a note or any personal data: the row carries none.
 */
export function TaskRowCard({
  task,
  onClose,
}: {
  task: TaskListRow;
  /** Opens the close dialog for this task. */
  onClose: (task: TaskListRow) => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const definition = taskTypeOf(task.type);
  const typeLabel = definition ? t(definition.label) : t('tasks.row.unknownType');
  const kindLabel = t(`tasks.linkKinds.${task.link.kind}` satisfies MessageKey);
  const record = task.link.label
    ? orderLabelOf({ ...task.link.label, orderNumber: task.link.label.number })
    : null;
  const closable = task.allowedOutcomes.length > 0;

  return (
    <li className="flex flex-col gap-3 rounded-lg border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium">{typeLabel}</p>
          {task.overdue && (
            <Badge variant="destructive">
              <TriangleAlertIcon aria-hidden data-icon="inline-start" />
              {t('tasks.row.overdue')}
            </Badge>
          )}
        </div>
        <p className="text-sm">
          {task.link.path === null ? (
            <span className="inline-flex min-h-6 items-center gap-1">
              {kindLabel}
              {record && <LtrText>{record}</LtrText>}
            </span>
          ) : (
            <Link
              href={task.link.path}
              className="inline-flex min-h-6 items-center gap-1 text-primary underline-offset-4 hover:underline"
            >
              {kindLabel}
              {record && <LtrText>{record}</LtrText>}
            </Link>
          )}
        </p>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <ClockIcon aria-hidden className="size-4 shrink-0" />
            {task.dueAt
              ? t('tasks.row.due', { when: format.dateTime(task.dueAt) })
              : t('tasks.row.noDue')}
          </span>
          <span>
            {task.ownerName
              ? t('tasks.row.heldBy', { name: task.ownerName })
              : t('tasks.row.queue', {
                  hat: t(`access.hats.${task.ownerHat}.name` satisfies MessageKey),
                })}
          </span>
        </p>
      </div>
      {closable ? (
        <Button
          type="button"
          variant="outline"
          className="self-start sm:self-center"
          aria-label={t('tasks.row.closeLabel', { task: typeLabel })}
          onClick={() => onClose(task)}
        >
          {t('tasks.row.close')}
        </Button>
      ) : (
        <p className="flex max-w-prose items-start gap-1.5 text-sm text-muted-foreground sm:max-w-xs">
          <InfoIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          {t('tasks.row.closesByItself')}
        </p>
      )}
    </li>
  );
}
