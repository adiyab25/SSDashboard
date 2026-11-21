'use client';

import type { OrderDetail, OrderLineView } from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LoaderCircleIcon, PackageCheckIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useAccess } from '@/access/use-access';
import { auditKeys } from '@/audit/audit-api';
import { useLanguage } from '@/i18n/language-provider';
import { useFormat } from '@/i18n/use-format';
import { OrderCloseAwaitingDialog } from './order-close-awaiting-dialog';
import { lineNameOf } from './order-line-name';
import { isStockOutOutOfDate, stockOutErrorKey } from './order-stock-out-errors';
import { orderKeys, restockAwaiting } from './orders-api';

/**
 * One line with pieces expected back on the shelf (spec 0013, AC-27 e, f, g): the item, how many
 * await and since when, "Received on the shelf" (one tap, no scanner; `stock.receive`; puts every
 * awaiting piece of the line back, one idempotency key per tap) and "Close" for pieces that never
 * come back (a `stock.correct` holder closes them; a holder of `stock.receive` alone sends a
 * request to a manager, and the words say so). `can` only hides buttons; the api decides. After an
 * answer the line may be gone, so `onSettled` moves focus to somewhere that still exists.
 */
export function OrderAwaitingLine({
  order,
  line,
  onSettled,
}: {
  order: OrderDetail;
  line: OrderLineView;
  /** Runs after an answer changed the order, to put focus on a control that still exists. */
  onSettled: () => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const access = useAccess();
  const { language } = useLanguage();
  const queryClient = useQueryClient();
  const [closing, setClosing] = useState(false);
  const awaiting = line.awaitingRestockQuantity ?? 0;
  const item = lineNameOf(line, language);
  const canRestock = access.can('stock.receive');
  const mayClose = access.can('stock.correct');
  const canClose = mayClose || canRestock;

  /** Shows the answered order and refreshes every list and history that names it. */
  function accept(answer: OrderDetail) {
    queryClient.setQueryData(orderKeys.detail(order.id), answer);
    void queryClient.invalidateQueries({ queryKey: orderKeys.all });
    void queryClient.invalidateQueries({ queryKey: auditKeys.all });
    onSettled();
  }

  const restock = useMutation({
    mutationFn: () =>
      restockAwaiting(order.id, line.id, { quantity: awaiting }, crypto.randomUUID()),
    onSuccess: (answer) => {
      accept(answer);
      toast.success(t('orders.stockOut.restocked', { quantity: format.quantity(awaiting), item }));
    },
    onError: (error) => {
      if (isStockOutOutOfDate(error)) {
        void queryClient.invalidateQueries({ queryKey: orderKeys.all });
      }
    },
  });

  return (
    <li className="flex flex-col gap-2 py-2">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <bdi dir="auto" className="font-medium">
              {item}
            </bdi>
            {line.skuCode && <LtrText className="text-muted-foreground">{line.skuCode}</LtrText>}
          </span>
          <span className="text-sm text-muted-foreground">
            {t('orders.stockOut.awaitingLine', {
              quantity: format.quantity(awaiting),
              since: line.awaitingRestockSince ? format.dateTime(line.awaitingRestockSince) : '',
            })}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canRestock && (
            <Button
              type="button"
              size="sm"
              disabled={restock.isPending}
              aria-busy={restock.isPending}
              aria-label={t('orders.stockOut.restockLabel', { item })}
              onClick={() => restock.mutate()}
            >
              {restock.isPending ? (
                <LoaderCircleIcon
                  aria-hidden
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                />
              ) : (
                <PackageCheckIcon aria-hidden data-icon="inline-start" />
              )}
              {t('orders.stockOut.restock')}
            </Button>
          )}
          {canClose && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={restock.isPending}
              aria-label={t(
                mayClose ? 'orders.stockOut.closeLabel' : 'orders.stockOut.requestCloseLabel',
                { item },
              )}
              onClick={() => {
                restock.reset();
                setClosing(true);
              }}
            >
              {t(mayClose ? 'orders.stockOut.close' : 'orders.stockOut.requestClose')}
            </Button>
          )}
        </div>
      </div>
      {restock.isError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t(stockOutErrorKey(restock.error))}</AlertDescription>
        </Alert>
      )}
      {closing && (
        <OrderCloseAwaitingDialog
          order={order}
          line={line}
          item={item}
          asRequest={!mayClose}
          onClose={() => setClosing(false)}
          onDone={(answer, quantity) => {
            setClosing(false);
            accept(answer);
            toast.success(
              t(mayClose ? 'orders.stockOut.closed' : 'orders.stockOut.requested', {
                quantity: format.quantity(quantity),
                item,
              }),
            );
          }}
        />
      )}
    </li>
  );
}
