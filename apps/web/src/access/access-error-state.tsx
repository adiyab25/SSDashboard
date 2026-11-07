'use client';

import type { MessageKey } from '@ssdashboard/i18n';
import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { useTranslation } from 'react-i18next';

interface Props {
  /** The page's own title key, drawn as the page's one `<h1>` so the person knows where they are. */
  titleKey: MessageKey;
  /** Asks `/api/me` again (`useAccess().retry`). */
  onRetry: () => void;
}

/**
 * What a gated back office page shows when the who am I call failed (`useAccess().failed`): the
 * page title as the one `<h1>`, then the design system's inline error (a destructive `Alert`
 * saying what failed in plain words) with a Try again button. Render it instead of the page body
 * so the page never loads forever and still asks the api for no business data. It renders inside
 * the app shell; never use it on a portal or partner page, whose frame draws the `<h1>`. It never
 * decides access: it only says the answer is missing.
 */
export function AccessErrorState({ titleKey, onRetry }: Props) {
  const { t } = useTranslation();

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <h1 className="text-xl font-semibold">{t(titleKey)}</h1>
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center gap-3">
          {t('access.loadError.message')}
          <Button size="sm" variant="outline" onClick={onRetry}>
            {t('access.loadError.retry')}
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}
