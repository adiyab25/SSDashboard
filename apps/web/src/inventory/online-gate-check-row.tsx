'use client';

import type { OnlineGateCheck } from '@ssdashboard/contracts';
import type { MessageKey } from '@ssdashboard/i18n';
import { Badge } from '@ssdashboard/ui/components/badge';
import { Button } from '@ssdashboard/ui/components/button';
import { CircleCheckIcon, CircleXIcon, LoaderCircleIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';

/** The api routes a check may point to: `/api/` and plain path characters, no query, no host. */
const ACTION_PATH = /^\/api\/[A-Za-z0-9/_-]+$/;

/**
 * One check of the online gate (spec 0011 AC-19): its label from the message key the api sent,
 * passed or not passed with an icon and words (never colour alone), the count it looked at, and,
 * when it failed and carries an action whose path is a plain `/api/...` route, a button that runs
 * the action (any other path draws no action, never a link out). It runs nothing itself: the dialog owns the action and the re read.
 */
export function OnlineGateCheckRow({
  check,
  running,
  onRun,
}: {
  check: OnlineGateCheck;
  running: boolean;
  onRun: (action: NonNullable<OnlineGateCheck['action']>) => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const action = check.passed ? undefined : check.action;
  // Only an api route of plain path characters runs; anything else draws no action at all.
  const runnable = action !== undefined && ACTION_PATH.test(action.path);

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-border-strong px-3 py-2">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center gap-2 text-sm font-medium">
          {check.passed ? (
            <CircleCheckIcon aria-hidden className="size-4 shrink-0" />
          ) : (
            <CircleXIcon aria-hidden className="size-4 shrink-0 text-destructive" />
          )}
          {t(check.label as MessageKey)}
        </span>
        <span className="text-xs text-muted-foreground">
          {t('inventory.onlineGate.checkCount', { value: format.number(check.count) })}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Badge variant={check.passed ? 'secondary' : 'destructive'}>
          {check.passed ? t('inventory.onlineGate.passed') : t('inventory.onlineGate.failed')}
        </Badge>
        {action && runnable && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={running}
            aria-busy={running}
            onClick={() => onRun(action)}
          >
            {running && (
              <LoaderCircleIcon
                aria-hidden
                className="animate-spin motion-reduce:animate-none"
                data-icon="inline-start"
              />
            )}
            {t(action.label as MessageKey)}
          </Button>
        )}
      </div>
    </li>
  );
}
