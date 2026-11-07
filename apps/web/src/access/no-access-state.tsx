'use client';

import type { MessageKey } from '@ssdashboard/i18n';
import { Button } from '@ssdashboard/ui/components/button';
import { LockKeyholeIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';

interface Props {
  /** The page's own title key, drawn as the page's one `<h1>` so the person knows where they are. */
  titleKey: MessageKey;
}

/**
 * What a back office page shows when it is opened by its address without the permission it
 * needs (spec 0008, AC-11): the page title as the one `<h1>`, then the empty pattern of the design
 * system (an icon, one sentence, the way out to the overview). Render it instead of the page body,
 * so no business data is asked for. It renders inside the app shell; never use it on a portal or
 * partner page, whose frame draws the `<h1>`. It explains, it does not protect: the api still
 * answers 403.
 */
export function NoAccessState({ titleKey }: Props) {
  const { t } = useTranslation();

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <h1 className="text-xl font-semibold">{t(titleKey)}</h1>
      <div className="flex flex-col items-center gap-3 rounded-lg border px-4 py-10 text-center">
        <LockKeyholeIcon aria-hidden className="size-8 text-muted-foreground" />
        <div className="flex flex-col gap-1">
          <p className="font-medium">{t('access.noAccess.title')}</p>
          <p className="text-sm text-muted-foreground">{t('access.noAccess.description')}</p>
        </div>
        <Button asChild variant="outline">
          <Link href="/">{t('access.noAccess.home')}</Link>
        </Button>
      </div>
    </div>
  );
}
