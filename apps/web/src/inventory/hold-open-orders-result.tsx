'use client';

import type { HoldOpenOrdersResult as HoldOpenOrdersCounts } from '@ssdashboard/contracts';
import { Alert, AlertDescription, AlertTitle } from '@ssdashboard/ui/components/alert';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';

/**
 * What "Hold the open orders here" did on the online gate (spec 0013 AC-26): the lines now held in
 * full, the lines held but short of stock, and the lines still not held at the location, as words
 * and numbers in a polite status region so a screen reader hears them once. It only shows the
 * answer it is given; the dialog runs the action and reads the gate again.
 */
export function HoldOpenOrdersResult({ result }: { result: HoldOpenOrdersCounts }) {
  const { t } = useTranslation();
  const format = useFormat();
  const titleId = useId();
  const rows = [
    { id: 'held', label: t('orders.onlineGate.linesHeld'), value: result.linesHeld },
    { id: 'short', label: t('orders.onlineGate.linesShort'), value: result.linesShort },
    { id: 'left', label: t('orders.onlineGate.linesLeft'), value: result.linesLeft },
  ];
  return (
    <Alert role="status" aria-labelledby={titleId}>
      <AlertTitle id={titleId}>{t('orders.onlineGate.heldTitle')}</AlertTitle>
      <AlertDescription>
        <dl className="grid w-full gap-1 text-sm">
          {rows.map((row) => (
            <div key={row.id} className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="font-medium tabular-nums">{format.number(row.value)}</dd>
            </div>
          ))}
        </dl>
      </AlertDescription>
    </Alert>
  );
}
