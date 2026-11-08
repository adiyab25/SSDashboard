'use client';

import type { OrderDetail } from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { AlertTriangleIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';

/** The command kinds the catalogs name; any other kind is shown as its code. */
const KNOWN_KINDS = ['shopify.order_edit', 'shopify.order_cancel'] as const;

/** True for a command kind the catalogs name. */
function isKnownKind(value: string): value is (typeof KNOWN_KINDS)[number] {
  return (KNOWN_KINDS as readonly string[]).includes(value);
}

/**
 * "Edit not synced, hold" on the order page (spec 0013, AC-12): says that a change has not reached
 * the sales channel, then lists each open write back command with its state (waiting or failed),
 * when it was queued, and the provider's error code when it failed. The code is shown as it is,
 * left to right, and never any provider text. Draws nothing when no command is open. It is a
 * status message, not an alert: the order is usable, the packer is just refused until it syncs.
 */
export function OrderHoldBlock({ order }: { order: OrderDetail }) {
  const { t } = useTranslation();
  const format = useFormat();
  if (order.writeBackState === 'none') return null;
  const commands = order.writeBackCommands ?? [];

  return (
    <Alert role="status">
      <AlertTriangleIcon aria-hidden />
      <AlertDescription className="flex flex-col gap-2">
        <span>
          {t(
            order.writeBackState === 'failed'
              ? 'orders.detail.holdFailed'
              : 'orders.detail.holdWaiting',
          )}
        </span>
        {commands.length > 0 && (
          <ul aria-label={t('orders.hold.commands')} className="flex flex-col gap-1">
            {commands.map((command) => (
              <li key={command.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="font-medium">
                  {isKnownKind(command.kind) ? (
                    t(`orders.hold.kind.${command.kind}`)
                  ) : (
                    <LtrText>{command.kind}</LtrText>
                  )}
                </span>
                <span>{t(`orders.hold.state.${command.syncState}`)}</span>
                {command.failureReason && (
                  <span>
                    {t('orders.hold.reason')}: <LtrText>{command.failureReason}</LtrText>
                  </span>
                )}
                <span className="text-muted-foreground">
                  {t('orders.hold.queued', { when: format.dateTime(command.queuedAt) })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </AlertDescription>
    </Alert>
  );
}
