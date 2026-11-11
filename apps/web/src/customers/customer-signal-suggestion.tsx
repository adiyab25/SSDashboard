'use client';

import type { CustomerProfile } from '@ssdashboard/contracts';
import { Button } from '@ssdashboard/ui/components/button';
import { useQueryClient } from '@tanstack/react-query';
import { FlagIcon, LoaderCircleIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useAccess } from '@/access/use-access';
import { ApiError } from '@/api/client';
import { refetchAfterWrite } from '@/api/refetch-after-write';
import { useFormat } from '@/i18n/use-format';
import { customerKeys, setCustomerFlag } from './customers-api';
import { flagErrorKey, type FlagErrorKey } from './flag-error-key';

/** The catalog key of why applying the suggestion failed. */
export type SignalFailureKey = FlagErrorKey | 'customers.profile.signal.noLongerHolds';

/**
 * The suggested flag of the profile header (spec 0014, AC-13): shown only when the customer has no
 * flag and the api sent a `signal` with a `suggestedKind` (it sends none without `orders.view`).
 * It states the counts and, for a holder of `customers.flag`, applies the suggestion in one tap
 * with the reason `suggestion_applied` and the profile's `updatedAt`. When the suggestion no
 * longer holds (422) or the record moved (409) it sets nothing and reloads the profile. The
 * outcome is handed to the profile through `onApplied` and `onFailed`, never kept here: the box
 * leaves once the reloaded profile has no suggestion, and the message must stay visible after it.
 */
export function CustomerSignalSuggestion({
  profile,
  onApplied,
  onFailed,
}: {
  profile: CustomerProfile;
  /** Called after the flag was set. */
  onApplied: () => void;
  /** Called with the message key of a failure (also toasted here), and with null when a new try starts. */
  onFailed: (key: SignalFailureKey | null) => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const access = useAccess();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const signal = profile.signal;
  const kind = signal?.suggestedKind;
  if (!signal || !kind || profile.flag !== null) return null;

  const days = t('customers.profile.signal.days', {
    count: signal.windowDays,
    number: format.number(signal.windowDays),
  });
  const flagName = t(`customers.flag.${kind}`);

  async function apply() {
    if (!kind || pending) return;
    setPending(true);
    onFailed(null);
    try {
      await setCustomerFlag(profile.id, {
        kind,
        reasonCode: 'suggestion_applied',
        expectedUpdatedAt: profile.updatedAt,
      });
      toast.success(t('customers.flagging.set.saved'));
      onApplied();
    } catch (failure) {
      const key: SignalFailureKey =
        failure instanceof ApiError && failure.code === 'REASON_INVALID'
          ? 'customers.profile.signal.noLongerHolds'
          : flagErrorKey(failure);
      toast.error(t(key));
      onFailed(key);
    } finally {
      // Success or not, read the profile and the timeline again: the flag, the signal, or the stamp moved.
      await refetchAfterWrite(queryClient, { queryKey: customerKeys.all }).catch(() => undefined);
      setPending(false);
    }
  }

  return (
    <section
      aria-labelledby="customer-signal-title"
      className="mt-2 flex flex-col gap-2 rounded-lg border bg-muted p-3 text-sm"
    >
      <h2 id="customer-signal-title" className="font-semibold">
        {t('customers.profile.signal.title')}
      </h2>
      <p>{t('customers.profile.signal.text', { flag: flagName })}</p>
      <ul className="list-disc ps-5 text-muted-foreground">
        {signal.refusals > 0 && (
          <li>
            {t('customers.profile.signal.refusals', {
              count: signal.refusals,
              number: format.number(signal.refusals),
              days,
            })}
          </li>
        )}
        {signal.returns > 0 && (
          <li>
            {t('customers.profile.signal.returns', {
              count: signal.returns,
              number: format.number(signal.returns),
              days,
            })}
          </li>
        )}
      </ul>
      {access.can('customers.flag') && (
        <div>
          <Button
            type="button"
            size="sm"
            aria-disabled={pending}
            aria-busy={pending}
            className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
            onClick={() => void apply()}
          >
            {pending ? (
              <LoaderCircleIcon
                aria-hidden
                className="animate-spin motion-reduce:animate-none"
                data-icon="inline-start"
              />
            ) : (
              <FlagIcon aria-hidden data-icon="inline-start" />
            )}
            {t('customers.profile.signal.apply', { flag: flagName })}
          </Button>
        </div>
      )}
    </section>
  );
}
