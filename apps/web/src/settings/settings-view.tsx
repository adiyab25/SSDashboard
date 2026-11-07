'use client';

import type { SettingEntryView, SettingGroup } from '@ssdashboard/contracts';
import type { MessageKey } from '@ssdashboard/i18n';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NoAccessState } from '@/access/no-access-state';
import { ApiError } from '@/api/client';
import { LicenseSection } from './license-section';
import { SettingChangeDialog } from './setting-change-dialog';
import { SettingSection } from './setting-section';
import { listSettings, settingsKeys } from './settings-api';

/** The settings groups this milestone shows, in order; the license section sits between them. */
const SECTIONS: readonly { group: SettingGroup; titleKey: MessageKey }[] = [
  { group: 'brand', titleKey: 'settings.sections.brand' },
  { group: 'policies', titleKey: 'settings.sections.policies' },
];

/**
 * The settings body (spec 0009, AC-25): the Brand and Policies sections from `GET /api/settings`
 * and the change dialog, with the Modules and license section between them (it loads its own
 * data, so it shows even while the list loads or fails). `enabled` is false until the page knows the person holds
 * `settings.manage`, so nothing is requested early; if the api still answers 403 the shared no
 * access state shows instead of a broken list.
 */
export function SettingsView({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: settingsKeys.all,
    queryFn: ({ signal }) => listSettings(signal),
    enabled,
  });
  const [editing, setEditing] = useState<SettingEntryView | null>(null);
  const entries = query.data?.entries ?? [];
  const forbidden = query.error instanceof ApiError && query.error.status === 403;

  if (forbidden) return <NoAccessState titleKey="settings.title" />;

  const sectionOf = (group: SettingGroup) => {
    const found = SECTIONS.find((section) => section.group === group);
    const inGroup = entries.filter((entry) => entry.group === group);
    return found === undefined || inGroup.length === 0 ? null : (
      <SettingSection
        key={group}
        titleKey={found.titleKey}
        entries={inGroup}
        onChange={setEditing}
      />
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{t('settings.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('settings.description')}</p>
      </div>

      {query.isError && !query.data ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {t('settings.loadError')}
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
      ) : query.isPending ? (
        <div aria-busy="true" className="flex flex-col gap-3">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        sectionOf('brand')
      )}

      <LicenseSection enabled={enabled} />
      {query.data && sectionOf('policies')}

      {editing && <SettingChangeDialog entry={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
