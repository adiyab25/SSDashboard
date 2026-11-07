'use client';

import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@ssdashboard/ui/components/dialog';
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import { useIsMutating, useQuery } from '@tanstack/react-query';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { getSku, inventoryKeys } from '@/inventory/inventory-api';
import { useReturnFocus } from '@/inventory/use-return-focus';
import { SkuEditBody } from './sku-edit-body';
import { skuEditMutationKey } from './sku-edit-schema';

/** Props of `SkuEditDialog`. */
interface Props {
  skuId: string;
  onClose: () => void;
  /** After a person holding `catalog.manage` deletes the SKU, so the detail page can leave. */
  onDeleted?: () => void;
}

/**
 * Edits one SKU (spec 0006, AC-2, AC-3). Name and price for anyone; the code, archive,
 * unarchive, and delete for people holding `catalog.manage` only (the api enforces it too). `updatedAt` goes back
 * exactly as read, and a stale answer offers a reload.
 */
export function SkuEditDialog({ skuId, onClose, onDeleted }: Props) {
  const { t } = useTranslation();
  const returnFocus = useReturnFocus();
  // The close handler of the archive/delete confirm step while it is open, and for a tick after
  // it closes. Radix orders stacked dialogs by mount order and a re-render can swap them, so this
  // dialog may be handed the Escape meant for the confirm step. It then closes that step instead
  // of itself, which would drop the typed edits.
  const confirmCloseRef = useRef<(() => void) | null>(null);
  const setConfirmClose = (close: (() => void) | null) => {
    confirmCloseRef.current = close;
  };
  const mutating = useIsMutating({ mutationKey: skuEditMutationKey(skuId) }) > 0;
  const query = useQuery({
    queryKey: inventoryKeys.sku(skuId),
    queryFn: ({ signal }) => getSku(skuId, signal),
    // A background refetch must not swap the version under a person who is typing.
    refetchOnWindowFocus: false,
    refetchOnMount: 'always',
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !mutating && !confirmCloseRef.current && onClose()}
    >
      <DialogContent
        closeLabel={t('inventory.skuEdit.close')}
        onCloseAutoFocus={returnFocus}
        onEscapeKeyDown={(event) => {
          if (!confirmCloseRef.current) return;
          event.preventDefault();
          if (!mutating) confirmCloseRef.current();
        }}
        className="sm:max-w-lg"
      >
        {query.data ? (
          <SkuEditBody
            sku={query.data}
            fresh={query.isFetchedAfterMount}
            onConfirmClose={setConfirmClose}
            reload={async () => {
              const result = await query.refetch();
              return result.isError ? undefined : result.data;
            }}
            onClose={onClose}
            onDeleted={onDeleted}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t('inventory.skuDetail.edit')}</DialogTitle>
              <DialogDescription>
                {query.isError ? '' : t('inventory.skuEdit.loading')}
              </DialogDescription>
            </DialogHeader>
            {query.isError ? (
              <Alert variant="destructive" role="alert">
                <AlertDescription className="flex flex-wrap items-center gap-3">
                  {query.error instanceof ApiError && query.error.status === 404
                    ? t('inventory.skuEdit.notFound')
                    : t('inventory.skuEdit.loadError')}
                  <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
                    {t('inventory.retry')}
                  </Button>
                </AlertDescription>
              </Alert>
            ) : (
              <div aria-hidden className="grid gap-3">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
