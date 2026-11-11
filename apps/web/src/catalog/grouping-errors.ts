import type { MessageKey } from '@ssdashboard/i18n';
import type { GroupingKind } from './catalog-api';

/** Every error code the season and product group routes answer (spec 0012, AC-6, AC-7). */
export const GROUPING_ERRORS = [
  'SEASON_CODE_TAKEN',
  'PRODUCT_GROUP_CODE_TAKEN',
  'SEASON_PROTECTED',
  'PRODUCT_GROUP_PROTECTED',
  'STALE_RECORD',
  'IN_USE',
  'INVALID_INPUT',
  'NOT_FOUND',
] as const;

/** One of `GROUPING_ERRORS`, or `generic` for anything else. */
export type GroupingErrorCode = (typeof GROUPING_ERRORS)[number] | 'generic';

/** The message catalog section of a list: `seasons` or `productGroups`. */
export function groupingPrefix(kind: GroupingKind): 'seasons' | 'productGroups' {
  return kind === 'season' ? 'seasons' : 'productGroups';
}

/** The wording of each error code for one list; the code taken and protected codes share a key per list. */
export function groupingErrorKey(kind: GroupingKind, code: GroupingErrorCode): MessageKey {
  const prefix = groupingPrefix(kind);
  switch (code) {
    case 'SEASON_CODE_TAKEN':
    case 'PRODUCT_GROUP_CODE_TAKEN':
      return `catalog.${prefix}.errors.CODE_TAKEN`;
    case 'SEASON_PROTECTED':
    case 'PRODUCT_GROUP_PROTECTED':
      return `catalog.${prefix}.errors.PROTECTED`;
    case 'STALE_RECORD':
    case 'IN_USE':
    case 'INVALID_INPUT':
    case 'NOT_FOUND':
    case 'generic':
      return `catalog.${prefix}.errors.${code}`;
  }
}
