'use client';

import type { CatalogRef } from '@ssdashboard/contracts';
import { useQuery } from '@tanstack/react-query';
import { catalogKeys, listGroupingChoices } from './catalog-api';

/** The active seasons and product groups, ordered by code, for the catalog pickers and filters. */
export interface GroupingChoices {
  seasons: CatalogRef[];
  groups: CatalogRef[];
  /** True while either list is still on its way. */
  loading: boolean;
  /** True when either list failed; the picker then offers what it has. */
  failed: boolean;
}

const NONE: CatalogRef[] = [];

/**
 * Loads the season and group choices from `GET /api/seasons` and `GET /api/product-groups`
 * (spec 0012, AC-6 and AC-7): the active rows only, because an archived season or group leaves
 * the pickers and the filters' default list. Pass `enabled: false` until the person may read the
 * catalog, so a page gated on a permission asks the api for nothing. It never derives the
 * choices from the rows a list happened to load.
 */
export function useGroupingChoices(enabled: boolean): GroupingChoices {
  const seasons = useQuery({
    queryKey: catalogKeys.groupingChoices('season'),
    queryFn: ({ signal }) => listGroupingChoices('season', signal),
    enabled,
  });
  const groups = useQuery({
    queryKey: catalogKeys.groupingChoices('productGroup'),
    queryFn: ({ signal }) => listGroupingChoices('productGroup', signal),
    enabled,
  });
  return {
    seasons: seasons.data ?? NONE,
    groups: groups.data ?? NONE,
    loading: seasons.isPending || groups.isPending,
    failed: seasons.isError || groups.isError,
  };
}
