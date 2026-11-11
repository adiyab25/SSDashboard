'use client';

import type { CustomerProfile } from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
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

/**
 * The suggested flag of the profile header (spec 0014, AC-13): shown only when the customer has no
 * flag and the api sent a `signal` with a `suggestedKind` (it sends none without `orders.view`).
 * It states the counts and, for a holder of `customers.flag`, applies the suggestion in one tap
 * with the reason `suggestion_applied` and the profile's `updatedAt`. When the suggestion no
 * longer holds (422) or the record moved (409) it says so, reloads the profile, and sets nothing.
 */
export function CustomerSignalSuggestion({ profile }: { profile: CustomerProfile }) {
  const { t } = useTranslation();
  const format = useFormat();
  const access = useAccess();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<FlagErrorKey | 'noLongerHolds' | null>(null);
  const signal = profile.signal;
  const kind = signal?.suggestedKind;
  if (!signal || !kind || profile.flag !== null) return null;

  const days = format.number(signal.windowDays);
  const flagName = t(`customers.flag.${kind}`);

  async function apply() {
    if (!kind) return;
    setPending(true);
    setError(null);
    try {
      await setCustomerFlag(profile.id, {
        kind,
        reasonCode: 'suggestion_applied',
        expectedUpdatedAt: profile.updatedAt,
      });
      toast.success(t('customers.flagging.set.saved'));
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.code === 'REASON_INVALID'
          ? 'noLongerHolds'
          : flagErrorKey(failure),
      );
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
          <li>{t('customers.profile.signal.refusals', { count: signal.refusals, days })}</li>
        )}
        {signal.returns > 0 && (
          <li>{t('customers.profile.signal.returns', { count: signal.returns, days })}</li>
        )}
      </ul>
      {access.can('customers.flag') && (
        <div>
          <Button
            type="button"
            size="sm"
            disabled={pending}
            aria-busy={pending}
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
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            {error === 'noLongerHolds' ? t('customers.profile.signal.noLongerHolds') : t(error)}
          </AlertDescription>
        </Alert>
      )}
    </section>
  );
}
