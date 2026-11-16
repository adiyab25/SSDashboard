'use client';

import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { RadioGroup } from '@ssdashboard/ui/components/radio-group';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftIcon, ArrowLeftRightIcon, InfoIcon, LoaderCircleIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { customerKeys, getCustomer } from './customers-api';
import { MergeCustomerCard } from './merge-customer-card';
import { MergeCustomerPicker } from './merge-customer-picker';
import { mergeErrorKey, type MergeErrorKey } from './merge-error-key';
import { useMergeActions } from './use-merge-actions';

type Slot = 'first' | 'second';

const SLOTS: readonly Slot[] = ['first', 'second'];

/** The refusals that mean the suggestion is spent or not for this pair, never the pair itself. */
const SUGGESTION_ERRORS: ReadonlySet<MergeErrorKey> = new Set<MergeErrorKey>([
  'customers.merge.errors.SUGGESTION_CLOSED',
  'customers.merge.errors.SUGGESTION_NOT_FOUND',
  'customers.merge.errors.SUGGESTION_MISMATCH',
]);

/** A query string value that is a customer id, else null: anything else is ignored. */
function idParam(value: string | null): string | null {
  const parsed = z.uuid().safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Loads one slot's customer when it holds an id. */
function useSlotCustomer(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: customerKeys.profile(id ?? ''),
    queryFn: ({ signal }) => getCustomer(id ?? '', signal),
    enabled: enabled && id !== null,
    retry: false,
  });
}

/**
 * The fast merge screen (spec 0014, AC-7, AC-9): two slots, each filled from `?a=` and `?b=` (and
 * `?s=` for the suggestion they came from) or by finding a customer by phone, then the two records
 * side by side with the older one preselected as the record to keep, a Swap, and one Merge button.
 * Merging goes through `useMergeActions` (toast with Undo) and opens the survivor's profile. Only
 * ids are in the address. Choosing another customer drops the suggestion, so it can never be
 * applied to a pair it was not made for.
 */
export function MergeView({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const router = useRouter();
  const params = useSearchParams();
  const actions = useMergeActions();
  const [ids, setIds] = useState<Record<Slot, string | null>>({
    first: idParam(params.get('a')),
    second: idParam(params.get('b')),
  });
  const [suggestionId, setSuggestionId] = useState<string | null>(idParam(params.get('s')));
  const [chosenKeep, setChosenKeep] = useState<Slot | null>(null);
  const [justPicked, setJustPicked] = useState<Slot | null>(null);
  const [merging, setMerging] = useState(false);
  const [failure, setFailure] = useState<MergeErrorKey | null>(null);
  const [merged, setMerged] = useState(false);
  const [suggestionDropped, setSuggestionDropped] = useState(false);

  const first = useSlotCustomer(ids.first, enabled);
  const second = useSlotCustomer(ids.second, enabled);
  const profiles = { first: first.data ?? null, second: second.data ?? null };
  const ready = profiles.first !== null && profiles.second !== null;
  const same = ready && !merged && profiles.first?.id === profiles.second?.id;

  // The older record is the default one to keep; the first slot wins a tie.
  const olderSlot: Slot | null =
    profiles.first && profiles.second
      ? Date.parse(profiles.second.createdAt) < Date.parse(profiles.first.createdAt)
        ? 'second'
        : 'first'
      : null;
  const keep: Slot = chosenKeep ?? olderSlot ?? 'first';

  function setSlot(slot: Slot, id: string | null) {
    setIds((current) => ({ ...current, [slot]: id }));
    setChosenKeep(null);
    setSuggestionId(null);
    setSuggestionDropped(false);
    setFailure(null);
    setJustPicked(id === null ? null : slot);
  }

  async function merge() {
    const survivor = profiles[keep];
    const merged = profiles[keep === 'first' ? 'second' : 'first'];
    if (!survivor || !merged || same) return;
    setMerging(true);
    setFailure(null);
    try {
      await actions.merge({
        survivorId: survivor.id,
        mergedId: merged.id,
        ...(suggestionId && { reasonCode: 'suggestion' as const, suggestionId }),
      });
      // Stay busy and ignore the refetch of the merged record: the page is leaving.
      setMerged(true);
      router.push(`/customers/${survivor.id}`);
    } catch (error) {
      const key = mergeErrorKey(error);
      if (SUGGESTION_ERRORS.has(key)) {
        // The suggestion can never apply again: drop it (and its reason) and keep the pair.
        setSuggestionId(null);
        setSuggestionDropped(true);
        setFailure(null);
      } else {
        setFailure(key);
      }
      setMerging(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/customers">
          <ArrowLeftIcon aria-hidden className="rtl:rotate-180" data-icon="inline-start" />
          {t('customers.merge.back')}
        </Link>
      </Button>

      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{t('customers.merge.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('customers.merge.description')}</p>
      </div>

      <RadioGroup
        value={keep}
        onValueChange={(value) => setChosenKeep(value === 'second' ? 'second' : 'first')}
        aria-label={t('customers.merge.compare.survivorLabel')}
        className="grid gap-4 md:grid-cols-2"
      >
        {SLOTS.map((slot) => {
          const id = ids[slot];
          const query = slot === 'first' ? first : second;
          return id === null ? (
            <section
              key={slot}
              aria-labelledby={`merge-slot-${slot}`}
              className="flex min-w-0 flex-col gap-3 rounded-card gradient-card-edge p-4"
            >
              <h2 id={`merge-slot-${slot}`} className="text-sm font-semibold text-muted-foreground">
                {t(`customers.merge.slot.${slot}`)}
              </h2>
              <MergeCustomerPicker
                slot={slot}
                enabled={enabled}
                onPick={(picked) => setSlot(slot, picked)}
              />
            </section>
          ) : (
            <MergeCustomerCard
              key={slot}
              slot={slot}
              profile={query.data ?? null}
              loading={query.isPending}
              failed={query.isError}
              older={olderSlot === slot}
              selectable={ready}
              focusOnMount={justPicked === slot}
              onChange={() => setSlot(slot, null)}
            />
          );
        })}
      </RadioGroup>

      {same && (
        <Alert role="alert" className="text-muted-foreground">
          <InfoIcon aria-hidden />
          <AlertDescription>{t('customers.merge.compare.same')}</AlertDescription>
        </Alert>
      )}

      {ready && !same && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{t('customers.merge.compare.summary')}</p>
          {failure && (
            <p role="alert" className="text-sm text-destructive">
              {t(failure)}
            </p>
          )}
          {suggestionDropped && (
            <p role="alert" className="text-sm text-destructive">
              {t('customers.merge.suggestionDropped')}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              disabled={merging}
              aria-busy={merging}
              onClick={() => void merge()}
            >
              {merging && (
                <LoaderCircleIcon
                  aria-hidden
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                />
              )}
              {merging ? t('customers.merge.merging') : t('customers.merge.submit')}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={merging}
              onClick={() => setChosenKeep(keep === 'first' ? 'second' : 'first')}
            >
              <ArrowLeftRightIcon aria-hidden data-icon="inline-start" />
              {t('customers.merge.compare.swap')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
