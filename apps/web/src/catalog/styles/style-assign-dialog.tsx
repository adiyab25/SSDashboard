'use client';

import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@ssdashboard/ui/components/dialog';
import { Field, FieldError, FieldLabel } from '@ssdashboard/ui/components/field';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { refetchAfterWrite } from '@/api/refetch-after-write';
import { useLocalizedText } from '@/i18n/use-localized-text';
import { inventoryKeys } from '@/inventory/inventory-api';
import { useReturnFocus } from '@/shared/use-return-focus';
import { assignStyles, catalogKeys } from '../catalog-api';
import { catalogErrorCode, missingStyleIds } from '../catalog-error';
import type { GroupingChoices } from '../use-grouping-choices';

/** Which field the bulk step sets. */
export type AssignMode = 'season' | 'group';

/** One selected style: its id for the api, its code to name it in a message. */
export interface AssignTarget {
  id: string;
  code: string;
}

const KNOWN = ['NOT_FOUND', 'ARCHIVED', 'INVALID_INPUT'] as const;
type Failure = (typeof KNOWN)[number] | 'generic';

const SELECT =
  'h-control w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-base shadow-xs outline-none focus-ring aria-invalid:border-destructive md:text-sm dark:bg-input/30';

/** Props of `StyleAssignDialog`. */
interface Props {
  mode: AssignMode;
  styles: readonly AssignTarget[];
  choices: Pick<GroupingChoices, 'seasons' | 'groups' | 'failed'>;
  /** After the api applied the change, so the list clears its selection. */
  onDone: () => void;
  /** The ids the api did not find, so the list drops them from its selection. */
  onMissing: (ids: string[]) => void;
  onClose: () => void;
}

/**
 * "Set season" or "Set group" for the selected styles (spec 0012, AC-9): one choice (a season,
 * "No season", or a product group) for 1 to 200 styles in one all or nothing step. The api
 * refuses the whole step when a style is gone (`NOT_FOUND`, the codes are named) or the choice
 * is archived; the dialog then says nothing changed. Every answer refreshes the style and SKU
 * lists with `refetchAfterWrite`.
 */
export function StyleAssignDialog({ mode, styles, choices, onDone, onMissing, onClose }: Props) {
  const { t } = useTranslation();
  const text = useLocalizedText();
  const returnFocus = useReturnFocus();
  const queryClient = useQueryClient();
  const [value, setValue] = useState('');
  const [missingChoice, setMissingChoice] = useState(false);
  const [failure, setFailure] = useState<{ code: Failure; codes: string } | null>(null);

  const refresh = () => {
    void refetchAfterWrite(queryClient, { queryKey: catalogKeys.styles });
    void refetchAfterWrite(queryClient, { queryKey: inventoryKeys.skus });
  };

  const mutation = useMutation({
    mutationFn: () =>
      assignStyles({
        styleIds: styles.map((style) => style.id),
        ...(mode === 'season'
          ? { seasonId: value === 'none' ? null : value }
          : { productGroupId: value }),
      }),
    onSuccess: (answer) => {
      refresh();
      toast.success(t('catalog.assign.done', { count: answer.updated }));
      onDone();
      onClose();
    },
    onError: (error) => {
      const code = catalogErrorCode(error, KNOWN);
      const missingIds = missingStyleIds(error);
      const missing = new Set(missingIds);
      const codes = styles
        .filter((style) => missing.has(style.id))
        .map((style) => style.code)
        .join(t('shell.modules.listSeparator'));
      if (code === 'NOT_FOUND') {
        refresh();
        onMissing(missingIds);
      }
      if (code === 'ARCHIVED') {
        void refetchAfterWrite(queryClient, { queryKey: catalogKeys.groupings('season') });
        void refetchAfterWrite(queryClient, { queryKey: catalogKeys.groupings('productGroup') });
      }
      setFailure({ code, codes });
    },
  });

  const pending = mutation.isPending;
  const season = mode === 'season';

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent
        closeLabel={t('catalog.common.close')}
        onCloseAutoFocus={returnFocus}
        className="sm:max-w-md"
      >
        <form
          noValidate
          className="grid gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            setFailure(null);
            if (!value) {
              setMissingChoice(true);
              document.getElementById('style-assign-choice')?.focus();
              return;
            }
            mutation.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {season ? t('catalog.assign.seasonTitle') : t('catalog.assign.groupTitle')}
            </DialogTitle>
            <DialogDescription>
              {season
                ? t('catalog.assign.seasonDescription', { count: styles.length })
                : t('catalog.assign.groupDescription', { count: styles.length })}
            </DialogDescription>
          </DialogHeader>

          {failure && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>
                {failure.code === 'NOT_FOUND'
                  ? failure.codes
                    ? t('catalog.assign.errors.NOT_FOUND', { codes: failure.codes })
                    : t('catalog.assign.errors.NOT_FOUND_UNNAMED')
                  : t(`catalog.assign.errors.${failure.code}`)}
              </AlertDescription>
            </Alert>
          )}
          {choices.failed && (
            <Alert variant="destructive">
              <AlertDescription>{t('catalog.assign.optionsError')}</AlertDescription>
            </Alert>
          )}

          <Field data-invalid={missingChoice}>
            <FieldLabel htmlFor="style-assign-choice">
              {season ? t('catalog.assign.seasonLabel') : t('catalog.assign.groupLabel')}
            </FieldLabel>
            <select
              id="style-assign-choice"
              className={SELECT}
              value={value}
              aria-invalid={missingChoice}
              aria-describedby={missingChoice ? 'style-assign-choice-error' : undefined}
              onChange={(event) => {
                setValue(event.target.value);
                setMissingChoice(false);
              }}
            >
              <option value="">{t('catalog.assign.choose')}</option>
              {season && <option value="none">{t('catalog.common.noSeason')}</option>}
              {(season ? choices.seasons : choices.groups).map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {text(choice.name, choice.code)}
                </option>
              ))}
            </select>
            {missingChoice && (
              <FieldError id="style-assign-choice-error">
                {season ? t('catalog.assign.chooseSeason') : t('catalog.assign.chooseGroup')}
              </FieldError>
            )}
          </Field>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              {t('catalog.common.cancel')}
            </Button>
            <Button type="submit" disabled={pending} aria-busy={pending}>
              {pending && (
                <LoaderCircleIcon
                  aria-hidden
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                />
              )}
              {t('catalog.assign.apply')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
