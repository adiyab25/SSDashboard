'use client';

import type { SkuStatus } from '@ssdashboard/contracts';
import { Button } from '@ssdashboard/ui/components/button';
import { Input } from '@ssdashboard/ui/components/input';
import { useTranslation } from 'react-i18next';
import { useLocalizedText } from '@/i18n/use-localized-text';
import { SkuFilterSelect } from '../sku-filter-select';
import type { GroupingChoices } from '../use-grouping-choices';

const STATUSES: readonly SkuStatus[] = ['active', 'archived'];

/** The filters the person has set on the style list; an empty string means "all". */
export interface StyleFilterValues {
  search: string;
  status: SkuStatus;
  /** A season id, `none`, or empty for all. */
  season: string;
  group: string;
}

/**
 * The style list's search box, season filter (with "No season"), group filter, and the active or
 * archived switch (spec 0012, AC-8). It holds no state; the page passes the values and the
 * choices. It must never fetch the choices itself.
 */
export function StyleFilterBar({
  values,
  choices,
  onChange,
}: {
  values: StyleFilterValues;
  choices: Pick<GroupingChoices, 'seasons' | 'groups'>;
  onChange: (next: Partial<StyleFilterValues>) => void;
}) {
  const { t } = useTranslation();
  const text = useLocalizedText();

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex min-w-52 flex-1 flex-col gap-1.5 sm:max-w-sm">
        <label htmlFor="style-search" className="text-sm font-medium">
          {t('catalog.styles.search')}
        </label>
        <Input
          id="style-search"
          type="search"
          value={values.search}
          autoComplete="off"
          aria-describedby="style-search-hint"
          onChange={(event) => onChange({ search: event.target.value })}
        />
        <span id="style-search-hint" className="text-xs text-muted-foreground">
          {t('catalog.styles.searchHint')}
        </span>
      </div>
      <SkuFilterSelect
        id="style-season-filter"
        label={t('catalog.styles.seasonFilter')}
        value={values.season}
        onChange={(season) => onChange({ season })}
      >
        <option value="">{t('catalog.styles.allSeasons')}</option>
        <option value="none">{t('catalog.common.noSeason')}</option>
        {choices.seasons.map((season) => (
          <option key={season.id} value={season.id}>
            {text(season.name, season.code)}
          </option>
        ))}
      </SkuFilterSelect>
      <SkuFilterSelect
        id="style-group-filter"
        label={t('catalog.styles.groupFilter')}
        value={values.group}
        onChange={(group) => onChange({ group })}
      >
        <option value="">{t('catalog.styles.allGroups')}</option>
        {choices.groups.map((group) => (
          <option key={group.id} value={group.id}>
            {text(group.name, group.code)}
          </option>
        ))}
      </SkuFilterSelect>
      <div role="group" aria-label={t('catalog.styles.filterLabel')} className="flex gap-1">
        {STATUSES.map((value) => (
          <Button
            key={value}
            type="button"
            size="sm"
            variant={values.status === value ? 'secondary' : 'outline'}
            aria-pressed={values.status === value}
            onClick={() => onChange({ status: value })}
          >
            {t(`catalog.styles.${value}`)}
          </Button>
        ))}
      </div>
    </div>
  );
}
