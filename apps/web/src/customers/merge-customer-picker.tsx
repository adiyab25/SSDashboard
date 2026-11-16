'use client';

import { CUSTOMER_SEARCH_RATE_LIMITED } from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { Input } from '@ssdashboard/ui/components/input';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import { SearchIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { classifyCustomerSearch } from './customer-search-input';
import { CustomerFlagBadge } from './customer-flag-badge';
import { customerKeys, searchCustomers } from './customers-api';

interface Props {
  /** Which of the two customers this finds: `first` or `second`; it names the form and its field. */
  slot: 'first' | 'second';
  /** False until the person's access is known and allowed: nothing is searched before. */
  enabled: boolean;
  /** Called with the id of the customer the person chose. */
  onPick: (customerId: string) => void;
}

/** What was searched: component state only, never in the address (spec 0014, AC-3). */
interface Submitted {
  kind: 'phone' | 'name';
  text: string;
}

/**
 * Finds one customer for the merge page by phone (in any form) or by a piece of the name (spec
 * 0014, AC-7). It posts the search like the customers screen does, so nothing personal reaches
 * the address; the first 25 matches are listed as buttons and choosing one calls `onPick`. A
 * wrong or missing answer reads as a translated message.
 */
export function MergeCustomerPicker({ slot, enabled, onPick }: Props) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');
  const [submitted, setSubmitted] = useState<Submitted | null>(null);
  const [inputError, setInputError] = useState<'nameTooShort' | 'nameTooLong' | null>(null);

  const query = useQuery({
    queryKey: [...customerKeys.all, 'picker', submitted?.kind, submitted?.text] as const,
    queryFn: ({ signal }) =>
      searchCustomers(
        submitted?.kind === 'phone'
          ? { phone: submitted.text }
          : { nameContains: submitted?.text ?? '' },
        undefined,
        signal,
      ),
    enabled: enabled && submitted !== null,
    retry: false,
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const input = classifyCustomerSearch(typed);
    switch (input.kind) {
      case 'empty':
        setInputError(null);
        return;
      case 'name-too-short':
        setInputError('nameTooShort');
        return;
      case 'name-too-long':
        setInputError('nameTooLong');
        return;
      case 'phone':
      case 'name':
        setInputError(null);
        if (submitted?.kind === input.kind && submitted.text === input.text) {
          void query.refetch();
        } else {
          setSubmitted({ kind: input.kind, text: input.text });
        }
        return;
    }
  };

  const failure = query.error instanceof ApiError ? query.error : null;
  const errorKey =
    inputError ??
    (failure?.status === 429 || failure?.code === CUSTOMER_SEARCH_RATE_LIMITED
      ? 'rateLimited'
      : failure?.code === 'INVALID_PHONE'
        ? 'invalidPhone'
        : null);
  const fieldId = `merge-picker-${slot}`;
  const items = query.data?.items ?? [];

  return (
    <div className="flex flex-col gap-3">
      <form
        role="search"
        aria-label={t(`customers.merge.slot.${slot}`)}
        onSubmit={onSubmit}
        noValidate
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-48 flex-1 flex-col gap-1.5">
            <label htmlFor={fieldId} className="text-sm font-medium">
              {t('customers.merge.picker.label')}
            </label>
            <Input
              id={fieldId}
              type="search"
              value={typed}
              autoComplete="off"
              aria-invalid={errorKey !== null}
              aria-describedby={errorKey ? `${fieldId}-hint ${fieldId}-error` : `${fieldId}-hint`}
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
          <Button type="submit" variant="secondary">
            <SearchIcon aria-hidden data-icon="inline-start" />
            {t('customers.merge.picker.submit')}
          </Button>
        </div>
        <span id={`${fieldId}-hint`} className="mt-1.5 block text-xs text-muted-foreground">
          {t('customers.merge.picker.hint')}
        </span>
      </form>

      {errorKey && (
        <p id={`${fieldId}-error`} role="alert" className="text-sm text-destructive">
          {t(`customers.merge.picker.${errorKey}`)}
        </p>
      )}

      <p role="status" className="sr-only">
        {query.isFetching ? t('customers.merge.picker.searching') : ''}
      </p>

      {submitted !== null && query.isPending && query.fetchStatus !== 'idle' && (
        <div className="flex flex-col gap-2" aria-busy aria-hidden>
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      )}

      {query.isError && !errorKey && (
        <Alert variant="destructive">
          <AlertDescription>{t('customers.merge.picker.loadError')}</AlertDescription>
        </Alert>
      )}

      {query.data &&
        (items.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('customers.merge.picker.noMatch')}
          </p>
        ) : (
          <ul aria-label={t('customers.merge.picker.resultsLabel')} className="flex flex-col gap-1">
            {items.map((customer) => (
              <li key={customer.id}>
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto w-full justify-start gap-3 py-2 text-start"
                  onClick={() => onPick(customer.id)}
                >
                  <bdi dir="auto" className="font-medium">
                    {customer.name ?? t('customers.unnamed')}
                  </bdi>
                  {customer.primaryPhone && <LtrText>{customer.primaryPhone}</LtrText>}
                  <CustomerFlagBadge kind={customer.flagKind} />
                </Button>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}
