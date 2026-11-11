'use client';

import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon, GitMergeIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccess } from '@/access/use-access';
import { ApiError } from '@/api/client';
import { useFormat } from '@/i18n/use-format';
import { CustomerChannelIdsSection } from './customer-channel-ids-section';
import { CustomerDetailSkeleton } from './customer-detail-skeleton';
import { CustomerFlagActions } from './customer-flag-actions';
import { CustomerFlagBadge } from './customer-flag-badge';
import { CustomerFlagSection } from './customer-flag-section';
import { CustomerMergesSection } from './customer-merges-section';
import { CustomerPhonesSection } from './customer-phones-section';
import { CustomerSignalSuggestion } from './customer-signal-suggestion';
import { CustomerTimelineSection } from './customer-timeline-section';
import { customerKeys, getCustomer } from './customers-api';
import { mergePageHref } from './merge-page-href';

/**
 * One customer (spec 0014, AC-4, AC-18): the header with the name and flag, every phone, every
 * channel id with its store, and the records merged in. Asked for a merged id, the api answers the
 * surviving customer with `resolvedFrom`: the address is replaced with the survivor's and a notice
 * says the record was merged. No phone is ever put in the address.
 */
export function CustomerDetailView({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const format = useFormat();
  const queryClient = useQueryClient();
  const access = useAccess();
  const { id } = useParams<{ id: string }>();
  const [mergedNotice, setMergedNotice] = useState(false);
  const query = useQuery({
    queryKey: customerKeys.profile(id),
    queryFn: ({ signal }) => getCustomer(id, signal),
    enabled,
  });
  const profile = query.data;

  // Remember the merged notice for as long as the page stays open (adjusting state while rendering).
  if (profile?.resolvedFrom && !mergedNotice) setMergedNotice(true);

  const survivor = profile?.resolvedFrom ? profile : null;
  useEffect(() => {
    if (!survivor) return;
    // The new address asks for the survivor's id: answer that key from what we have, so the
    // page does not reload (the notice is kept in state, so it stays).
    queryClient.setQueryData(customerKeys.profile(survivor.id), {
      ...survivor,
      resolvedFrom: null,
    });
    // Replace the address with the survivor's, keeping history clean (spec 0014, AC-4).
    window.history.replaceState(window.history.state, '', `/customers/${survivor.id}`);
  }, [survivor, queryClient]);

  if (query.isError && !profile) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold">{t('customers.profile.title')}</h1>
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {notFound ? t('customers.profile.notFound') : t('customers.profile.loadError')}
            {!notFound && (
              <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
                {t('customers.profile.retry')}
              </Button>
            )}
            <Button asChild size="sm" variant="outline">
              <Link href="/customers">{t('customers.profile.back')}</Link>
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!profile) return <CustomerDetailSkeleton />;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/customers">
          <ArrowLeftIcon aria-hidden className="rtl:rotate-180" data-icon="inline-start" />
          {t('customers.profile.back')}
        </Link>
      </Button>

      {(mergedNotice || profile.resolvedFrom) && (
        <Alert role="status">
          <AlertDescription>{t('customers.profile.merged')}</AlertDescription>
        </Alert>
      )}

      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">
            <bdi dir="auto">{profile.name ?? t('customers.unnamed')}</bdi>
          </h1>
          <CustomerFlagBadge kind={profile.flag?.kind ?? null} />
        </div>
        <p className="text-sm text-muted-foreground">
          {t('customers.profile.since', { date: format.date(profile.createdAt) })}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {access.can('customers.merge') && (
            <Button asChild size="sm" variant="outline">
              <Link href={mergePageHref(profile.id)}>
                <GitMergeIcon aria-hidden data-icon="inline-start" />
                {t('customers.profile.merges.mergeWith')}
              </Link>
            </Button>
          )}
          {access.can('customers.flag') && <CustomerFlagActions profile={profile} />}
        </div>
        <CustomerSignalSuggestion profile={profile} />
      </header>

      <CustomerFlagSection flag={profile.flag} />

      <CustomerPhonesSection phones={profile.phones} />
      <CustomerChannelIdsSection ids={profile.channelIds} />
      <CustomerMergesSection merges={profile.merges} />
      <CustomerTimelineSection customerId={profile.id} />
    </div>
  );
}
