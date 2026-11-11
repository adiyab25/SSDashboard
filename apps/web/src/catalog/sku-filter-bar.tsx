'use client';

import type { SkuStatus } from '@ssdashboard/contracts';
import { Button } from '@ssdashboard/ui/components/button';
import { Input } from '@ssdashboard/ui/components/input';
import { useTranslation } from 'react-i18next';
import { useLocalizedText } from '@/i18n/use-localized-text';
import { SkuFilterSelect } from './sku-filter-select';
import type { GroupingChoices } from './use-grouping-choices';

/** The season and group choices the filters offer (the active rows, from the api lists). */
export type SkuFilterOptions = Pick<GroupingChoices, 'seasons' | 'groups'>;

const STATUSES: readonly SkuStatus[] = ['active', 'archived'];

/** The filters the person has set on the SKU list; an empty string means "all". */
export interface SkuFilterValues {
  search: string;
  status: SkuStatus;
  /** A season id, `none`, or empty for all. */
  season: string;
  group: string;
}

/**
 * The SKU list's search box ("Name, SKU or barcode"), season and group filters, and the active or
 * archived switch (spec 0012, AC-3 and AC-4). It holds no state; the page passes the values and
 * the options. It must never fetch the option lists itself.
 */
export function SkuFilterBar({
  values,
  options,
  onChange,
}: {
  values: SkuFilterValues;
  options: SkuFilterOptions;
  onChange: (next: Partial<SkuFilterValues>) => void;
}) {
  const { t } = useTranslation();
  const text = useLocalizedText();

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex min-w-52 flex-1 flex-col gap-1.5 sm:max-w-sm">
        <label htmlFor="sku-search" className="text-sm font-medium">
          {t('inventory.skus.search')}
        </label>
        <Input
          id="sku-search"
          type="search"
          value={values.search}
          autoComplete="off"
          aria-describedby="sku-search-hint"
          onChange={(event) => onChange({ search: event.target.value })}
        />
        <span id="sku-search-hint" className="text-xs text-muted-foreground">
          {t('inventory.skus.searchHint')}
        </span>
      </div>
      <SkuFilterSelect
        id="sku-season-filter"
        label={t('inventory.skus.seasonFilter')}
        value={values.season}
        onChange={(season) => onChange({ season })}
      >
        <option value="">{t('inventory.skus.allSeasons')}</option>
        <option value="none">{t('inventory.skus.noSeason')}</option>
        {options.seasons.map((season) => (
          <option key={season.id} value={season.id}>
            {text(season.name, season.code)}
          </option>
        ))}
      </SkuFilterSelect>
      <SkuFilterSelect
        id="sku-group-filter"
        label={t('inventory.skus.groupFilter')}
        value={values.group}
        onChange={(group) => onChange({ group })}
      >
        <option value="">{t('inventory.skus.allGroups')}</option>
        {options.groups.map((group) => (
          <option key={group.id} value={group.id}>
            {text(group.name, group.code)}
          </option>
        ))}
      </SkuFilterSelect>
      <div role="group" aria-label={t('inventory.skus.filterLabel')} className="flex gap-1">
        {STATUSES.map((value) => (
          <Button
            key={value}
            type="button"
            size="sm"
            variant={values.status === value ? 'secondary' : 'outline'}
            aria-pressed={values.status === value}
            onClick={() => onChange({ status: value })}
          >
            {t(`inventory.skus.${value}`)}
          </Button>
        ))}
      </div>
    </div>
  );
}
