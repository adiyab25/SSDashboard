'use client';

import type { CatalogRef, SkuSummary } from '@ssdashboard/contracts';
import { useState } from 'react';

/** The seasons and product groups the SKU list has met so far, ordered by code. */
export interface SkuFilterOptions {
  seasons: CatalogRef[];
  groups: CatalogRef[];
}

const EMPTY: SkuFilterOptions = { seasons: [], groups: [] };

/** Adds the refs not yet known; returns the same array when nothing is new. */
function merge(known: CatalogRef[], found: (CatalogRef | null)[]): CatalogRef[] {
  const additions = new Map<string, CatalogRef>();
  for (const ref of found) {
    if (ref && !known.some((entry) => entry.id === ref.id)) additions.set(ref.id, ref);
  }
  if (additions.size === 0) return known;
  return [...known, ...additions.values()].sort((a, b) =>
    a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
  );
}

/**
 * The season and group choices for the SKU list filters, collected from every row the list has
 * loaded. Spec 0012 brings the `/api/seasons` and `/api/product-groups` lists in milestone 2;
 * until a list source exists the filters offer what the rows show, and keep an option after a
 * filter narrows the rows so the person can switch it back. It must never call an endpoint that
 * does not exist, and an option it has not met is simply not offered yet.
 */
export function useSkuFilterOptions(rows: readonly SkuSummary[]): SkuFilterOptions {
  const [options, setOptions] = useState<SkuFilterOptions>(EMPTY);
  const seasons = merge(
    options.seasons,
    rows.map((row) => row.season),
  );
  const groups = merge(
    options.groups,
    rows.map((row) => row.productGroup),
  );
  // Adjusting state while rendering (not in an effect): React re-renders at once with the new
  // options, and `merge` returns the same arrays when nothing is new, so it settles.
  if (seasons !== options.seasons || groups !== options.groups) setOptions({ seasons, groups });
  return { seasons, groups };
}
