'use client';

import type { StopReason } from '@ssdashboard/contracts';
import type { MessageKey } from '@ssdashboard/i18n';
import { Button } from '@ssdashboard/ui/components/button';
import { PowerOffIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { REASON_KEYS } from './module-reason-text';

/** Props of `ModuleNotAvailableState`. */
interface ModuleNotAvailableStateProps {
  /** The page's own title key, drawn as the page's one `<h1>`. */
  titleKey: MessageKey;
  /** Why the module is off, when the api said. */
  reason: StopReason | null;
}

/**
 * What a back office page shows when its module or capability is `off` and the page was opened by
 * its address (spec 0009, AC-9): the page title as the one `<h1>`, an icon, "not available on this
 * install" with the reason in words, and the way back to the overview. It renders inside the app
 * shell instead of the page body, so the page asks the api for nothing. It explains, it does not
 * protect: the api answers 404 `MODULE_OFF` anyway. Never use it on a portal or partner page.
 */
export function ModuleNotAvailableState({ titleKey, reason }: ModuleNotAvailableStateProps) {
  const { t } = useTranslation();

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <h1 className="text-xl font-semibold">{t(titleKey)}</h1>
      <div className="flex flex-col items-center gap-3 rounded-card gradient-card-edge px-4 py-10 text-center">
        <PowerOffIcon aria-hidden className="size-8 text-muted-foreground" />
        <div className="flex flex-col gap-1">
          <p className="font-medium">{t('shell.modules.notAvailable.title')}</p>
          <p className="text-sm text-muted-foreground">
            {t('shell.modules.notAvailable.description')}
            {reason && ` ${t(REASON_KEYS[reason])}`}
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/">{t('access.noAccess.home')}</Link>
        </Button>
      </div>
    </div>
  );
}
