'use client';

import type { OwnerPolicyView } from '@ssdashboard/contracts';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import { LoaderCircleIcon, LockKeyholeIcon, MapPinOffIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { listOwnerPolicies, ownerPolicyKeys } from './owner-policies-api';
import { OwnerPolicyDialog } from './owner-policy-dialog';
import { OwnerPolicyRow } from './owner-policy-row';

/**
 * The Location owner types section of the settings screen (spec 0009, AC-24, AC-25): it loads
 * `GET /api/inventory/owner-policies` itself (so it has its own loading, error, empty, and no
 * access states and never holds up the other sections), says each row applies to every location
 * of its type with per partner terms in the partner's own agreement (D22), and opens the edit
 * dialog. `enabled` is false until the page knows the person holds `settings.manage`.
 */
export function OwnerPolicySection({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const headingId = useId();
  const query = useQuery({
    queryKey: ownerPolicyKeys.all,
    queryFn: ({ signal }) => listOwnerPolicies(signal),
    enabled,
  });
  const [editing, setEditing] = useState<OwnerPolicyView | null>(null);
  const forbidden = query.error instanceof ApiError && query.error.status === 403;
  const policies = query.data?.policies ?? [];

  let body: React.ReactNode;
  if (forbidden) {
    body = (
      <p className="flex items-center gap-2 rounded-card gradient-card-edge px-4 py-6 text-sm text-muted-foreground">
        <LockKeyholeIcon aria-hidden className="size-4 shrink-0" />
        {t('settings.ownerPolicies.noAccess')}
      </p>
    );
  } else if (query.isError && !query.data) {
    body = (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center gap-3">
          {t('settings.ownerPolicies.loadError')}
          <Button
            size="sm"
            variant="outline"
            aria-disabled={query.isFetching}
            aria-busy={query.isFetching}
            onClick={() => {
              if (!query.isFetching) void query.refetch();
            }}
          >
            {query.isFetching && (
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
  } else if (query.isPending) {
    body = (
      <div aria-busy="true" className="flex flex-col gap-2">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  } else if (policies.length === 0) {
    body = (
      <div className="flex flex-col items-center gap-2 rounded-card gradient-card-edge px-4 py-8 text-center">
        <MapPinOffIcon aria-hidden className="size-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t('settings.ownerPolicies.empty')}</p>
      </div>
    );
  } else {
    body = (
      <ul className="divide-y rounded-card gradient-card-edge">
        {policies.map((policy) => (
          <OwnerPolicyRow key={policy.ownerType} policy={policy} onEdit={setEditing} />
        ))}
      </ul>
    );
  }

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2">
      <h2 id={headingId} className="text-base font-semibold">
        {t('settings.sections.ownerTypes')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('settings.ownerPolicies.description')}</p>
      {body}
      {editing && <OwnerPolicyDialog policy={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}
