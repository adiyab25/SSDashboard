'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { StyleTags, type CatalogRef, type StyleDetail } from '@ssdashboard/contracts';
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
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@ssdashboard/ui/components/field';
import { Input } from '@ssdashboard/ui/components/input';
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import { Textarea } from '@ssdashboard/ui/components/textarea';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { refetchAfterWrite } from '@/api/refetch-after-write';
import { useLocalizedText } from '@/i18n/use-localized-text';
import { inventoryKeys } from '@/inventory/inventory-api';
import { useReturnFocus } from '@/shared/use-return-focus';
import { catalogKeys, updateStyle } from '../catalog-api';
import { catalogErrorCode, channelOwnedField, type ChannelOwnedField } from '../catalog-error';
import { FromChannelBadge } from '../from-channel-badge';
import { useGroupingChoices } from '../use-grouping-choices';
import { SELECT_CLASS } from '@/shared/select-class';

/** Splits the tags box on commas (Latin or Arabic) and drops empty pieces. */
const splitTags = (value: string) =>
  value
    .split(/[,،]/)
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');

/** The form, built from the contract's tag schema (spec 0012, AC-9). */
const StyleEditForm = z
  .object({
    nameEn: z.string().trim().max(200),
    nameAr: z.string().trim().max(200),
    descriptionEn: z.string().trim().max(2000),
    descriptionAr: z.string().trim().max(2000),
    seasonId: z.string(),
    productGroupId: z.string().min(1),
    tags: z.string().transform(splitTags).pipe(StyleTags),
  })
  .refine((form) => form.nameEn !== '' || form.nameAr !== '', {
    path: ['nameEn'],
    message: 'nameRequired',
  });
type FormInput = z.input<typeof StyleEditForm>;
type FormOutput = z.output<typeof StyleEditForm>;

const valuesOf = (style: StyleDetail): FormInput => ({
  nameEn: style.name.en ?? '',
  nameAr: style.name.ar ?? '',
  descriptionEn: style.description?.en ?? '',
  descriptionAr: style.description?.ar ?? '',
  seasonId: style.season?.id ?? '',
  productGroupId: style.productGroup.id,
  tags: style.tags.join(', '),
});

const KNOWN = [
  'STALE_RECORD',
  'ARCHIVED',
  'INVALID_INPUT',
  'NOT_FOUND',
  'FIELD_OWNED_BY_CHANNEL',
] as const;
type Failure = (typeof KNOWN)[number] | 'generic';

/** The active choices, plus the style's own one when it is not among them (it is archived). */
function withCurrent(choices: CatalogRef[], current: CatalogRef | null) {
  return !current || choices.some((choice) => choice.id === current.id)
    ? { choices, archived: null }
    : { choices, archived: current };
}

/** Props of `StyleEditDialog`. */
interface Props {
  style: StyleDetail;
  /** Reads the style again; undefined when that failed. */
  reload: () => Promise<StyleDetail | undefined>;
  onClose: () => void;
}

/**
 * Edits a style's name, description, season, product group, and tags (spec 0012, AC-9,
 * `catalog.edit`). It sends `updatedAt` exactly as read and only the fields that changed; a stale
 * answer offers a reload. The pickers offer the active seasons and groups; a style already on an
 * archived one keeps it as a labelled choice, and choosing another archived one is refused by the
 * api (`ARCHIVED`). The pickers render only once the choices have loaded, so a native select never
 * falls back to its first option and saves a season the person did not pick. A save refreshes the style, the style list, and the SKU list.
 * While the style is linked to a sales channel, the name in the channel's language and the tags
 * are read only with "From Shopify" (AC-15, AC-18); the other name language, the descriptions,
 * season, and group stay editable, and a `FIELD_OWNED_BY_CHANNEL` answer names its field.
 */
export function StyleEditDialog({ style, reload, onClose }: Props) {
  const { t } = useTranslation();
  const text = useLocalizedText();
  const returnFocus = useReturnFocus();
  const queryClient = useQueryClient();
  const groupings = useGroupingChoices(true);
  const [current, setCurrent] = useState(style);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [ownedField, setOwnedField] = useState<ChannelOwnedField>('generic');
  const [reloading, setReloading] = useState(false);
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(StyleEditForm),
    mode: 'onTouched',
    defaultValues: valuesOf(style),
  });
  const { errors } = form.formState;

  const mutation = useMutation({
    mutationFn: (values: FormOutput) => {
      const before = valuesOf(current);
      const nameChanged = values.nameEn !== before.nameEn || values.nameAr !== before.nameAr;
      const descriptionChanged =
        values.descriptionEn !== before.descriptionEn ||
        values.descriptionAr !== before.descriptionAr;
      const tagsChanged = values.tags.join('\n') !== current.tags.join('\n');
      return updateStyle(current.id, {
        updatedAt: current.updatedAt,
        ...(nameChanged && { name: { en: values.nameEn, ar: values.nameAr } }),
        ...(descriptionChanged && {
          description:
            values.descriptionEn === '' && values.descriptionAr === ''
              ? null
              : { en: values.descriptionEn, ar: values.descriptionAr },
        }),
        ...(values.seasonId !== before.seasonId && { seasonId: values.seasonId || null }),
        ...(values.productGroupId !== before.productGroupId && {
          productGroupId: values.productGroupId,
        }),
        ...(tagsChanged && { tags: values.tags }),
      });
    },
    onSuccess: (next) => {
      queryClient.setQueryData(catalogKeys.style(next.id), next);
      void refetchAfterWrite(queryClient, { queryKey: catalogKeys.styles });
      void refetchAfterWrite(queryClient, { queryKey: inventoryKeys.skus });
      toast.success(t('catalog.styleEdit.saved', { code: next.code }));
      onClose();
    },
    onError: (error) => {
      const code = catalogErrorCode(error, KNOWN);
      if (code === 'ARCHIVED') {
        void refetchAfterWrite(queryClient, { queryKey: catalogKeys.groupings('season') });
        void refetchAfterWrite(queryClient, { queryKey: catalogKeys.groupings('productGroup') });
      }
      setOwnedField(channelOwnedField(error));
      setFailure(code);
    },
  });

  const reloadLatest = async () => {
    setReloading(true);
    try {
      const latest = await reload();
      if (latest) {
        setCurrent(latest);
        form.reset(valuesOf(latest));
        mutation.reset();
        setFailure(null);
      }
    } finally {
      setReloading(false);
    }
  };

  const seasons = withCurrent(groupings.seasons, current.season);
  const groups = withCurrent(groupings.groups, current.productGroup);
  const pending = mutation.isPending;
  const nameEnOwned = current.channelNameLanguage === 'en';
  const nameArOwned = current.channelNameLanguage === 'ar';

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent
        closeLabel={t('catalog.common.close')}
        onCloseAutoFocus={returnFocus}
        className="sm:max-w-lg"
      >
        <form
          noValidate
          className="grid gap-6"
          onSubmit={(event) => {
            setFailure(null);
            void form.handleSubmit((values) => mutation.mutate(values))(event);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('catalog.styleEdit.title', { code: current.code })}</DialogTitle>
            <DialogDescription>{t('catalog.styleEdit.description')}</DialogDescription>
          </DialogHeader>

          {failure && (
            <Alert variant="destructive" role="alert">
              <AlertDescription className="flex flex-wrap items-center gap-3">
                {failure === 'FIELD_OWNED_BY_CHANNEL'
                  ? t(`catalog.channel.owned.${ownedField}`)
                  : t(`catalog.styleEdit.errors.${failure}`)}
                {failure === 'STALE_RECORD' && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={reloading}
                    onClick={() => void reloadLatest()}
                  >
                    {t('catalog.common.reload')}
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          )}
          {groupings.failed && (
            <Alert variant="destructive">
              <AlertDescription>{t('catalog.styleEdit.optionsError')}</AlertDescription>
            </Alert>
          )}

          <FieldGroup className="gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.nameEn}>
                <FieldLabel htmlFor="style-edit-name-en">
                  {t('catalog.styleEdit.nameEn')}
                  {nameEnOwned && <FromChannelBadge />}
                </FieldLabel>
                <Input
                  id="style-edit-name-en"
                  lang="en"
                  dir="ltr"
                  autoComplete="off"
                  readOnly={nameEnOwned}
                  className="read-only:bg-muted"
                  aria-invalid={!!errors.nameEn}
                  aria-describedby={
                    errors.nameEn ? 'style-edit-name-error' : 'style-edit-name-hint'
                  }
                  {...form.register('nameEn')}
                />
              </Field>
              <Field data-invalid={!!errors.nameEn}>
                <FieldLabel htmlFor="style-edit-name-ar">
                  {t('catalog.styleEdit.nameAr')}
                  {nameArOwned && <FromChannelBadge />}
                </FieldLabel>
                <Input
                  id="style-edit-name-ar"
                  lang="ar"
                  dir="rtl"
                  autoComplete="off"
                  readOnly={nameArOwned}
                  className="read-only:bg-muted"
                  aria-invalid={!!errors.nameEn}
                  aria-describedby={
                    errors.nameEn ? 'style-edit-name-error' : 'style-edit-name-hint'
                  }
                  {...form.register('nameAr')}
                />
              </Field>
            </div>
            {errors.nameEn ? (
              <FieldError id="style-edit-name-error" className="-mt-2">
                {t('catalog.styleEdit.nameRequired')}
              </FieldError>
            ) : (
              <FieldDescription id="style-edit-name-hint" className="-mt-2">
                {t('catalog.styleEdit.nameHint')}
              </FieldDescription>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.descriptionEn}>
                <FieldLabel htmlFor="style-edit-description-en">
                  {t('catalog.styleEdit.descriptionEn')}
                  <span className="font-normal text-muted-foreground">
                    ({t('catalog.common.optional')})
                  </span>
                </FieldLabel>
                <Textarea
                  id="style-edit-description-en"
                  lang="en"
                  dir="ltr"
                  aria-invalid={!!errors.descriptionEn}
                  aria-describedby={
                    errors.descriptionEn ? 'style-edit-description-error' : undefined
                  }
                  {...form.register('descriptionEn')}
                />
              </Field>
              <Field data-invalid={!!errors.descriptionAr}>
                <FieldLabel htmlFor="style-edit-description-ar">
                  {t('catalog.styleEdit.descriptionAr')}
                  <span className="font-normal text-muted-foreground">
                    ({t('catalog.common.optional')})
                  </span>
                </FieldLabel>
                <Textarea
                  id="style-edit-description-ar"
                  lang="ar"
                  dir="rtl"
                  aria-invalid={!!errors.descriptionAr}
                  aria-describedby={
                    errors.descriptionAr ? 'style-edit-description-error' : undefined
                  }
                  {...form.register('descriptionAr')}
                />
              </Field>
            </div>
            {(errors.descriptionEn || errors.descriptionAr) && (
              <FieldError id="style-edit-description-error" className="-mt-2">
                {t('catalog.styleEdit.descriptionInvalid')}
              </FieldError>
            )}

            {groupings.loading ? (
              <div aria-hidden className="grid gap-4 sm:grid-cols-2">
                <Skeleton className="h-control w-full" />
                <Skeleton className="h-control w-full" />
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="style-edit-season">
                    {t('catalog.styleEdit.season')}
                  </FieldLabel>
                  <select
                    id="style-edit-season"
                    className={SELECT_CLASS}
                    {...form.register('seasonId')}
                  >
                    <option value="">{t('catalog.common.noSeason')}</option>
                    {seasons.archived && (
                      <option value={seasons.archived.id}>
                        {groupings.failed
                          ? text(seasons.archived.name, seasons.archived.code)
                          : t('catalog.common.archivedChoice', {
                              name: text(seasons.archived.name, seasons.archived.code),
                            })}
                      </option>
                    )}
                    {seasons.choices.map((season) => (
                      <option key={season.id} value={season.id}>
                        {text(season.name, season.code)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="style-edit-group">{t('catalog.styleEdit.group')}</FieldLabel>
                  <select
                    id="style-edit-group"
                    className={SELECT_CLASS}
                    {...form.register('productGroupId')}
                  >
                    {groups.archived && (
                      <option value={groups.archived.id}>
                        {groupings.failed
                          ? text(groups.archived.name, groups.archived.code)
                          : t('catalog.common.archivedChoice', {
                              name: text(groups.archived.name, groups.archived.code),
                            })}
                      </option>
                    )}
                    {groups.choices.map((group) => (
                      <option key={group.id} value={group.id}>
                        {text(group.name, group.code)}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            )}

            <Field data-invalid={!!errors.tags}>
              <FieldLabel htmlFor="style-edit-tags">
                {t('catalog.styleEdit.tags')}
                <span className="font-normal text-muted-foreground">
                  ({t('catalog.common.optional')})
                </span>
                {current.channelLinked && <FromChannelBadge />}
              </FieldLabel>
              <Input
                id="style-edit-tags"
                autoComplete="off"
                readOnly={current.channelLinked}
                className="read-only:bg-muted"
                aria-invalid={!!errors.tags}
                aria-describedby={errors.tags ? 'style-edit-tags-error' : 'style-edit-tags-hint'}
                {...form.register('tags')}
              />
              {errors.tags ? (
                <FieldError id="style-edit-tags-error">
                  {t('catalog.styleEdit.tagsInvalid')}
                </FieldError>
              ) : (
                <FieldDescription id="style-edit-tags-hint">
                  {t('catalog.styleEdit.tagsHint')}
                </FieldDescription>
              )}
            </Field>
          </FieldGroup>

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
              {t('catalog.styleEdit.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
