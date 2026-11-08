'use client';

import { orderLabelOf, type OrderDetail } from '@ssdashboard/contracts';
import type { MessageKey } from '@ssdashboard/i18n';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  BanIcon,
  CheckIcon,
  LoaderCircleIcon,
  PackageCheckIcon,
  PackageOpenIcon,
  PencilIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useAccess } from '@/access/use-access';
import { auditKeys } from '@/audit/audit-api';
import { CancelOrderDialog } from './cancel-order-dialog';
import { OrderEditDialog } from './order-edit-dialog';
import { isStaleAnswer, orderWriteErrorKey } from './order-write-errors';
import { moveOrder, orderKeys, type OrderMove } from './orders-api';

/** The states in which the courier has not picked the parcel up, so an edit or a cancel is still possible. */
const BEFORE_PICKUP = new Set(['new', 'confirmed', 'packed']);

/** The toast key of each move. */
const MOVE_DONE: Record<OrderMove, MessageKey> = {
  confirm: 'orders.actions.confirmed',
  pack: 'orders.actions.packed',
  unpack: 'orders.actions.unpacked',
};

/**
 * What a person may do with an order from its page (spec 0013, AC-7 to AC-10): Confirm (`new`),
 * Pack and Back to confirmed (`fulfillment.work`), Edit, and Cancel (`orders.confirm`), each shown
 * only to a holder of the permission and only in a state where the api would allow it (it still
 * decides: `can` only hides buttons). Every action sends the `updatedAt` the page showed; a stale
 * answer refetches the order and says it changed. A Shopify store order the app may not change
 * (409 `EDIT_IN_SHOPIFY` or `CANCEL_IN_SHOPIFY`) shows a calm note to do it in Shopify instead of
 * the button. Each success toasts the order number with its store (AC-3) and shows the answered order.
 */
export function OrderActions({ order }: { order: OrderDetail }) {
  const { t } = useTranslation();
  const access = useAccess();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<'edit' | 'cancel' | null>(null);
  const [inShopify, setInShopify] = useState({ edit: false, cancel: false });
  const [failure, setFailure] = useState<MessageKey | null>(null);

  // The label is isolated so `MAIN/SO-…` keeps its order inside right to left text.
  const label = `⁦${orderLabelOf(order)}⁩`;
  const active = order.outcome === 'open';
  const beforePickup = active && BEFORE_PICKUP.has(order.fulfillmentState);
  const canConfirm = access.can('orders.confirm');
  const canWork = access.can('fulfillment.work');

  /** Shows the answered order and refreshes every list and history that names it. */
  function accept(answer: OrderDetail) {
    queryClient.setQueryData(orderKeys.detail(order.id), answer);
    void queryClient.invalidateQueries({ queryKey: orderKeys.all });
    void queryClient.invalidateQueries({ queryKey: auditKeys.all });
  }

  /** The order changed under a dialog: close it, load the latest, and say so. */
  function handleStale() {
    void queryClient.invalidateQueries({ queryKey: orderKeys.all });
    setDialog(null);
    setFailure('orders.actions.stale');
  }

  const move = useMutation({
    mutationFn: (which: OrderMove) =>
      moveOrder(order.id, which, { expectedUpdatedAt: order.updatedAt }),
    onMutate: () => setFailure(null),
    onSuccess: (answer, which) => {
      accept(answer);
      toast.success(t(MOVE_DONE[which], { order: label }));
    },
    onError: (error) => {
      if (isStaleAnswer(error)) handleStale();
      else setFailure(orderWriteErrorKey(error));
    },
  });

  const moves: { id: OrderMove; show: boolean; label: MessageKey; icon: typeof CheckIcon }[] = [
    {
      id: 'confirm',
      show: canConfirm && active && order.fulfillmentState === 'new',
      label: 'orders.actions.confirm',
      icon: CheckIcon,
    },
    {
      id: 'pack',
      show: canWork && active && order.fulfillmentState === 'confirmed',
      label: 'orders.actions.pack',
      icon: PackageCheckIcon,
    },
    {
      id: 'unpack',
      show:
        canWork && active && order.fulfillmentState === 'packed' && !order.carrierDeliveryCreatedAt,
      label: 'orders.actions.unpack',
      icon: PackageOpenIcon,
    },
  ];
  const shownMoves = moves.filter((item) => item.show);
  const editable = beforePickup && canConfirm && !order.carrierDeliveryCreatedAt;
  const cancellable = beforePickup && canConfirm;
  const showEdit = editable && !inShopify.edit;
  const showCancel = cancellable && !inShopify.cancel;
  const notes: MessageKey[] = [];
  if (editable && inShopify.edit) notes.push('orders.actions.editInShopify');
  if (cancellable && inShopify.cancel) notes.push('orders.actions.cancelInShopify');

  if (shownMoves.length === 0 && !showEdit && !showCancel && notes.length === 0) return null;

  return (
    <section aria-label={t('orders.actions.label')} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {shownMoves.map(({ id, label: text, icon: Icon }) => {
          const busy = move.isPending && move.variables === id;
          return (
            <Button
              key={id}
              type="button"
              variant={id === 'confirm' ? 'default' : 'outline'}
              disabled={move.isPending}
              aria-busy={busy}
              onClick={() => move.mutate(id)}
            >
              {busy ? (
                <LoaderCircleIcon
                  aria-hidden
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                />
              ) : (
                <Icon aria-hidden data-icon="inline-start" />
              )}
              {t(text)}
            </Button>
          );
        })}
        {showEdit && (
          <Button type="button" variant="outline" onClick={() => setDialog('edit')}>
            <PencilIcon aria-hidden data-icon="inline-start" />
            {t('orders.actions.edit')}
          </Button>
        )}
        {showCancel && (
          <Button type="button" variant="outline" onClick={() => setDialog('cancel')}>
            <BanIcon aria-hidden data-icon="inline-start" />
            {t('orders.actions.cancel')}
          </Button>
        )}
      </div>

      {failure && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t(failure)}</AlertDescription>
        </Alert>
      )}
      {notes.map((key) => (
        <Alert key={key}>
          <AlertDescription>{t(key)}</AlertDescription>
        </Alert>
      ))}

      {dialog === 'edit' && (
        <OrderEditDialog
          order={order}
          onClose={() => setDialog(null)}
          onEdited={(answer) => {
            accept(answer);
            setDialog(null);
            toast.success(t('orders.actions.edited', { order: label }));
          }}
          onInShopify={() => {
            setInShopify((current) => ({ ...current, edit: true }));
            setDialog(null);
          }}
          onStale={handleStale}
        />
      )}
      {dialog === 'cancel' && (
        <CancelOrderDialog
          order={order}
          onClose={() => setDialog(null)}
          onCancelled={(answer) => {
            accept(answer);
            setDialog(null);
            toast.success(t('orders.actions.cancelled', { order: label }));
          }}
          onInShopify={() => {
            setInShopify((current) => ({ ...current, cancel: true }));
            setDialog(null);
          }}
          onStale={handleStale}
        />
      )}
    </section>
  );
}
