'use client';

import type { MessageKey } from '@ssdashboard/i18n';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import type { OffImpact } from '@ssdashboard/contracts';
import { LoaderCircleIcon } from 'lucide-react';
import { useFormat } from '@/i18n/use-format';

/** Props of `ModuleOffImpact`. */
interface ModuleOffImpactProps {
  /** The answer of `GET /api/settings/:key/off-impact`, or undefined while it is not in. */
  impact: OffImpact | undefined;
  loading: boolean;
  failed: boolean;
  /** True when the api said the impact cannot be worked out now (503 `OFF_IMPACT_UNAVAILABLE`). */
  unavailable?: boolean;
  retrying: boolean;
  onRetry: () => void;
}

/**
 * The impact part of the off dialog (spec 0009, AC-30), shown before the reason is asked: the
 * waiting commands that will fail, the work in flight that can still be finished, and what each
 * partner holds (the value only when the api sent it, which it does for `cost.view`). It states
 * nothing the api did not send, shows a loading and a failed state, and when nothing is affected
 * says so in words. Never decides whether the switch may be turned off.
 */
export function ModuleOffImpact({
  impact,
  loading,
  failed,
  unavailable = false,
  retrying,
  onRetry,
}: ModuleOffImpactProps) {
  const { t, i18n } = useTranslation();
  const format = useFormat();
  const word = (group: 'kinds' | 'areas', code: string) => {
    const key = `settings.modules.impact.${group}.${code}`;
    return i18n.exists(key) ? t(key as MessageKey) : <LtrText>{code}</LtrText>;
  };

  if (failed) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription className="flex flex-wrap items-center gap-3">
          {t(
            unavailable
              ? 'settings.modules.impact.unavailable'
              : 'settings.modules.impact.loadError',
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-disabled={retrying}
            aria-busy={retrying}
            onClick={() => {
              if (!retrying) onRetry();
            }}
          >
            {retrying && (
              <LoaderCircleIcon
                aria-hidden
                className="animate-spin motion-reduce:animate-none"
                data-icon="inline-start"
              />
            )}
            {t('settings.retry')}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (loading || !impact) {
    return (
      <div aria-busy="true" className="flex flex-col gap-2">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  const nothing =
    impact.waitingCommands.length === 0 &&
    impact.inFlight.length === 0 &&
    impact.partnerStock.length === 0;

  return (
    <div className="flex flex-col gap-4 text-sm">
      {nothing && <p className="text-muted-foreground">{t('settings.modules.impact.nothing')}</p>}

      {impact.waitingCommands.length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="font-semibold">{t('settings.modules.impact.waitingHeading')}</h3>
          <p className="text-muted-foreground">{t('settings.modules.impact.waitingHint')}</p>
          <ul className="divide-y rounded-md border">
            {impact.waitingCommands.map((item) => (
              <li key={item.kind} className="flex justify-between gap-3 px-3 py-1.5">
                <span>{word('kinds', item.kind)}</span>
                <span className="font-medium">{format.quantity(item.count)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {impact.inFlight.length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="font-semibold">{t('settings.modules.impact.inFlightHeading')}</h3>
          <p className="text-muted-foreground">{t('settings.modules.impact.inFlightHint')}</p>
          <ul className="divide-y rounded-md border">
            {impact.inFlight.map((item) => (
              <li key={item.area} className="flex justify-between gap-3 px-3 py-1.5">
                <span>{word('areas', item.area)}</span>
                <span className="font-medium">{format.quantity(item.count)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {impact.partnerStock.length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="font-semibold">{t('settings.modules.impact.partnerHeading')}</h3>
          <p className="text-muted-foreground">{t('settings.modules.impact.partnerHint')}</p>
          <ul className="divide-y rounded-md border">
            {impact.partnerStock.map((partner) => (
              <li key={partner.partnerId} className="flex flex-col gap-0.5 px-3 py-1.5">
                <span className="font-medium">{partner.partnerName}</span>
                <span>
                  {t('settings.modules.impact.partnerPieces', {
                    count: partner.pieces,
                    pieces: format.quantity(partner.pieces),
                  })}
                  {partner.totalValue !== undefined && (
                    <>
                      {' '}
                      {t('settings.modules.impact.partnerValue', {
                        value: format.money(partner.totalValue, 2),
                      })}
                    </>
                  )}
                </span>
                <span className="text-muted-foreground">
                  {partner.lastConfirmedSalesDay === null ? (
                    t('settings.modules.impact.noConfirmedDay')
                  ) : (
                    <>
                      {t('settings.modules.impact.confirmedDay', {
                        date: format.dateOnly(partner.lastConfirmedSalesDay),
                      })}
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
