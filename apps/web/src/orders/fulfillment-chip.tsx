'use client';

import type { FulfillmentState, OrderOutcome } from '@ssdashboard/contracts';
import type { StatusMeaning } from '@ssdashboard/ui/lib/status-meaning';
import { StatusChip } from '@ssdashboard/ui/status/status-chip';
import { useTranslation } from 'react-i18next';

/** The design system's meaning of each fulfillment state: not yet confirmed, moving or done, or failed. */
function meaningOf(state: FulfillmentState): StatusMeaning {
  switch (state) {
    case 'new':
      return 'provisional';
    case 'confirmed':
    case 'packed':
    case 'shipped':
    case 'delivered':
    case 'partially_delivered':
    case 'exchanged':
      return 'confirmed';
    case 'failed_attempt':
    case 'returned_to_origin':
    case 'refused':
    case 'cancelled':
    case 'lost':
      return 'failed';
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}

/**
 * The parcel's state as a `StatusChip` (icon and word), followed by the outcome in words once it
 * is final (spec 0013, AC-4). A cancelled order's outcome only repeats its state, so it is not
 * repeated. Never color alone.
 */
export function FulfillmentChip({
  state,
  outcome,
}: {
  state: FulfillmentState;
  outcome?: OrderOutcome;
}) {
  const { t } = useTranslation();
  const showOutcome = outcome !== undefined && outcome !== 'open' && state !== 'cancelled';
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <StatusChip meaning={meaningOf(state)} label={t(`orders.fulfillment.${state}`)} />
      {showOutcome && (
        <span className="text-xs text-muted-foreground">{t(`orders.outcome.${outcome}`)}</span>
      )}
    </span>
  );
}
