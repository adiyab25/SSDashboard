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
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useAccess } from '@/access/use-access';
import { auditKeys } from '@/audit/audit-api';
import { CancelOrderDialog } from './cancel-order-dialog';
import { OrderEditDialog } from './order-edit-dialog';
import { isOutOfDate, isStaleAnswer, orderWriteErrorKey } from './order-write-errors';
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
 * decides: `can` only hides buttons). A move sends the `updatedAt` of the order as it was drawn
 * when the person pressed the button, and the edit and cancel dialogs keep the order they opened
 * on, so a refetch behind them never gives old values a fresh token. A stale answer closes the
 * dialog, refetches, and says the order changed; a locked, moved, or missing order refetches too.
 * A Shopify store order the app may not change (409 `EDIT_IN_SHOPIFY` or `CANCEL_IN_SHOPIFY`)
 * shows a calm note to do it in Shopify instead of the button. Each success toasts the order
 * number with its store (AC-3) and shows the answered order. Focus never falls to the page when a
 * control disappears (WCAG 2.4.3): it moves to the first action left, else to `headingRef`.
 */
export function OrderActions({
  order,
  headingRef,
}: {
  order: OrderDetail;
  /** The page's `h1` (with `tabIndex={-1}`), where focus goes when no action is left. */
  headingRef?: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const access = useAccess();
  const queryClient = useQueryClient();
  // The dialog carries the order it opened on; it never follows the live query.
  const [dialog, setDialog] = useState<{ kind: 'edit' | 'cancel'; order: OrderDetail } | null>(
    null,
  );
  const [inShopify, setInShopify] = useState({ edit: false, cancel: false });
  const [failure, setFailure] = useState<MessageKey | null>(null);
  const section = useRef<HTMLElement>(null);
  const refocus = useRef(false);

  // The label is isolated so `MAIN/SO-…` keeps its order inside right to left text.
  const label = `⁦${orderLabelOf(order)}⁩`;
  const active = order.outcome === 'open';
  const beforePickup = active && BEFORE_PICKUP.has(order.fulfillmentState);
  const canConfirm = access.can('orders.confirm');
  const canWork = access.can('fulfillment.work');

  /** Puts focus on the first action left, else on the page heading. */
  function restoreFocus() {
    const first = section.current?.querySelector<HTMLElement>('button:not([disabled])');
    (first ?? headingRef?.current)?.focus();
  }

  /** Shows the answered order and refreshes every list and history that names it. */
  function accept(answer: OrderDetail) {
    refocus.current = true;
    setFailure(null);
    queryClient.setQueryData(orderKeys.detail(order.id), answer);
    void queryClient.invalidateQueries({ queryKey: orderKeys.all });
    void queryClient.invalidateQueries({ queryKey: auditKeys.all });
  }

  /** The page is out of date with the order: load the latest. */
  function refetch() {
    void queryClient.invalidateQueries({ queryKey: orderKeys.all });
  }

  /** The order changed under a dialog: close it, load the latest, and say so. */
  function handleStale() {
    refetch();
    setDialog(null);
    setFailure('orders.actions.stale');
  }

  const move = useMutation({
    mutationFn: ({ which, token }: { which: OrderMove; token: string }) =>
      moveOrder(order.id, which, { expectedUpdatedAt: token }),
    onMutate: () => setFailure(null),
    onSuccess: (answer, { which }) => {
      accept(answer);
      toast.success(t(MOVE_DONE[which], { order: label }));
    },
    onError: (error) => {
      if (isStaleAnswer(error)) handleStale();
      else {
        if (isOutOfDate(error)) refetch();
        setFailure(orderWriteErrorKey(error));
      }
    },
  });

  // After an action the pressed button may be gone: once the answer has changed the order and no
  // move is pending, bring focus back if it fell to the page.
  const { fulfillmentState, outcome, updatedAt } = order;
  useEffect(() => {
    if (!refocus.current || move.isPending) return;
    refocus.current = false;
    const focused = document.activeElement;
    if (focused && focused !== document.body && focused.isConnected) return;
    restoreFocus();
    // restoreFocus only reads refs, so it is left out on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fulfillmentState, outcome, updatedAt, move.isPending]);

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
  const hasBar = shownMoves.length > 0 || showEdit || showCancel || notes.length > 0;

  /** Opens a dialog on the order as drawn now, with no earlier failure left on the page. */
  function openDialog(kind: 'edit' | 'cancel') {
    setFailure(null);
    setDialog({ kind, order });
  }

  const dialogProps = {
    onClose: () => setDialog(null),
    onStale: handleStale,
    onOutOfDate: refetch,
    onRestoreFocus: restoreFocus,
  };

  return (
    <>
      {hasBar && (
        <section
          ref={section}
          aria-label={t('orders.actions.label')}
          className="flex flex-col gap-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            {shownMoves.map(({ id, label: text, icon: Icon }) => {
              const busy = move.isPending && move.variables?.which === id;
              return (
                <Button
                  key={id}
                  type="button"
                  variant={id === 'confirm' ? 'default' : 'outline'}
                  disabled={move.isPending}
                  aria-busy={busy}
                  onClick={() => move.mutate({ which: id, token: order.updatedAt })}
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
              <Button
                type="button"
                variant="outline"
                disabled={move.isPending}
                onClick={() => openDialog('edit')}
              >
                <PencilIcon aria-hidden data-icon="inline-start" />
                {t('orders.actions.edit')}
              </Button>
            )}
            {showCancel && (
              <Button
                type="button"
                variant="outline"
                disabled={move.isPending}
                onClick={() => openDialog('cancel')}
              >
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
        </section>
      )}

      {dialog?.kind === 'edit' && (
        <OrderEditDialog
          order={dialog.order}
          {...dialogProps}
          onEdited={(answer) => {
            accept(answer);
            setDialog(null);
            toast.success(t('orders.actions.edited', { order: label }));
          }}
          onInShopify={() => {
            setInShopify((current) => ({ ...current, edit: true }));
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === 'cancel' && (
        <CancelOrderDialog
          order={dialog.order}
          {...dialogProps}
          onCancelled={(answer) => {
            accept(answer);
            setDialog(null);
            toast.success(t('orders.actions.cancelled', { order: label }));
          }}
          onInShopify={() => {
            setInShopify((current) => ({ ...current, cancel: true }));
            setDialog(null);
          }}
        />
      )}
    </>
  );
}
