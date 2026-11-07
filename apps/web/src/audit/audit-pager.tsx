'use client';

import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import { LoaderCircleIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Load more for a keyset paged audit list, with the focus rules of WCAG 2.4.3: the button stays
 * focused while it loads (`aria-disabled`, not `disabled`), and when the last page arrives focus
 * moves to the "End of the audit trail" line instead of falling to the page. Shows the failure
 * of a next page too. Renders nothing while the first page is loading or when the list is empty.
 */
export function AuditPager({
  rowCount,
  hasNextPage,
  isFetchingNextPage,
  isFetchNextPageError,
  fetchNextPage,
}: {
  rowCount: number;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  fetchNextPage: () => void;
}) {
  const { t } = useTranslation();
  const endRef = useRef<HTMLParagraphElement>(null);
  const wantsEnd = useRef(false);
  const atEnd = !hasNextPage;

  // Load more unmounts on the last page, so focus moves to the end line, not to body.
  useEffect(() => {
    if (wantsEnd.current && atEnd) {
      wantsEnd.current = false;
      endRef.current?.focus();
    }
  }, [atEnd, rowCount]);

  return (
    <>
      {isFetchNextPageError && (
        <Alert variant="destructive">
          <AlertDescription>{t('audit.loadMoreError')}</AlertDescription>
        </Alert>
      )}
      {hasNextPage && (
        <Button
          variant="outline"
          className="self-center"
          aria-disabled={isFetchingNextPage}
          aria-busy={isFetchingNextPage}
          onClick={() => {
            if (isFetchingNextPage) return;
            wantsEnd.current = true;
            fetchNextPage();
          }}
        >
          {isFetchingNextPage && (
            <LoaderCircleIcon
              aria-hidden
              className="animate-spin motion-reduce:animate-none"
              data-icon="inline-start"
            />
          )}
          {t('audit.loadMore')}
        </Button>
      )}
      {atEnd && rowCount > 0 && (
        <p
          ref={endRef}
          tabIndex={-1}
          className="text-center text-sm text-muted-foreground outline-none focus-ring"
        >
          {t('audit.endOfList')}
        </p>
      )}
    </>
  );
}
