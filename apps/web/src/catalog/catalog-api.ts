import {
  AssignStylesResponse,
  ProductGroup,
  ProductGroupListResponse,
  Season,
  SeasonListResponse,
  SkuDetail,
  StyleDetail,
  StyleListResponse,
  type AddBarcodeRequest,
  type AddVariantRequest,
  type AssignStylesRequest,
  type ChangeStyleCodeRequest,
  type CreateSeasonRequest,
  type GroupingListStatus,
  type SeasonFilter,
  type SkuStatus,
  type UpdateSeasonRequest,
  type UpdateStyleRequest,
} from '@ssdashboard/contracts';
import { apiRequest } from '@/api/client';

/** What the style list asks for (spec 0012, AC-8); an empty `q` and an absent filter are not sent. */
export interface StyleListFilters {
  q: string;
  status: SkuStatus;
  /** A season id, or `none` for styles with no season. */
  seasonId?: SeasonFilter;
  productGroupId?: string;
}

/** The two flat catalog lists that share one screen shape: seasons and product groups. */
export type GroupingKind = 'season' | 'productGroup';

/** One row of either list. */
export type GroupingRow = Season | ProductGroup;

/** One page of either list. */
export interface GroupingPage {
  items: GroupingRow[];
  nextCursor: string | null;
}

/**
 * Query keys of the catalog screens, so a write refreshes exactly what it changed. Every key
 * starts with its list's root (`styles`, `seasons`, `product-groups`); pass the root to
 * `refetchAfterWrite` after a write.
 */
export const catalogKeys = {
  styles: ['styles'] as const,
  /** One filtered style list. */
  styleList: (filters: StyleListFilters) =>
    [
      'styles',
      'list',
      filters.q,
      filters.status,
      filters.seasonId,
      filters.productGroupId,
    ] as const,
  /** One style's detail. */
  style: (id: string) => ['styles', 'detail', id] as const,
  /** The root of the seasons or the product groups queries. */
  groupings: (kind: GroupingKind) =>
    kind === 'season' ? (['seasons'] as const) : (['product-groups'] as const),
  /** One status page set of the seasons or product groups list. */
  groupingList: (kind: GroupingKind, status: GroupingListStatus) =>
    [...catalogKeys.groupings(kind), 'list', status] as const,
  /** Every active row of a list, for the pickers and filters. */
  groupingChoices: (kind: GroupingKind) => [...catalogKeys.groupings(kind), 'choices'] as const,
};

const noContent = { parse: (): void => undefined };
const stylePath = (id: string) => `/api/styles/${encodeURIComponent(id)}`;
const basePath = (kind: GroupingKind) =>
  kind === 'season' ? '/api/seasons' : '/api/product-groups';
const rowPath = (kind: GroupingKind, id: string) => `${basePath(kind)}/${encodeURIComponent(id)}`;
const rowSchema = (kind: GroupingKind) => (kind === 'season' ? Season : ProductGroup);

/** The style list: search, season (or `none`), group, and status filters, 50 a page (AC-8). */
export function listStyles(
  filters: StyleListFilters,
  cursor: string | undefined,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ limit: '50', status: filters.status });
  if (filters.q.trim()) params.set('q', filters.q.trim());
  if (filters.seasonId) params.set('seasonId', filters.seasonId);
  if (filters.productGroupId) params.set('productGroupId', filters.productGroupId);
  if (cursor) params.set('cursor', cursor);
  return apiRequest('GET', `/api/styles?${params}`, StyleListResponse, { signal });
}

/** One style with its options and variants, and the `updatedAt` an edit must send back. */
export const getStyle = (id: string, signal?: AbortSignal) =>
  apiRequest('GET', stylePath(id), StyleDetail, { signal });

/** Edits a style's name, description, season, group, or tags (AC-9, `catalog.edit`). */
export const updateStyle = (id: string, body: UpdateStyleRequest) =>
  apiRequest('PATCH', stylePath(id), StyleDetail, { body });

/** Gives 1 to 200 styles one season, one group, or both, all or nothing (AC-9). */
export const assignStyles = (body: AssignStylesRequest) =>
  apiRequest('POST', '/api/styles/assign', AssignStylesResponse, { body });

/** Changes a style code (AC-9, `catalog.manage`). */
export const changeStyleCode = (id: string, body: ChangeStyleCodeRequest) =>
  apiRequest('PATCH', `${stylePath(id)}/code`, StyleDetail, { body });

/** Adds a variant to a style; answers the new SKU (AC-10). */
export const addVariant = (styleId: string, body: AddVariantRequest) =>
  apiRequest('POST', `${stylePath(styleId)}/variants`, SkuDetail, { body });

/** Adds a barcode to a SKU; answers the SKU with its barcodes (AC-10). */
export const addBarcode = (skuId: string, body: AddBarcodeRequest) =>
  apiRequest('POST', `/api/skus/${encodeURIComponent(skuId)}/barcodes`, SkuDetail, { body });

/** Removes one barcode from a SKU (AC-10). */
export const removeBarcode = (skuId: string, barcodeId: string) =>
  apiRequest(
    'DELETE',
    `/api/skus/${encodeURIComponent(skuId)}/barcodes/${encodeURIComponent(barcodeId)}`,
    noContent,
  );

/** One page of seasons or product groups (AC-6, AC-7). */
export function listGroupings(
  kind: GroupingKind,
  status: GroupingListStatus,
  cursor: string | undefined,
  signal?: AbortSignal,
): Promise<GroupingPage> {
  const params = new URLSearchParams({ limit: '100', status });
  if (cursor) params.set('cursor', cursor);
  const schema = kind === 'season' ? SeasonListResponse : ProductGroupListResponse;
  return apiRequest('GET', `${basePath(kind)}?${params}`, schema, { signal });
}

/** The most pages `listGroupingChoices` reads: 2,000 rows, far past any brand's seasons. */
const MAX_CHOICE_PAGES = 20;

/**
 * Every active season or product group, ordered by code, for a picker or a filter. An archived
 * row leaves the pickers (AC-6), so it is never offered here.
 */
export async function listGroupingChoices(
  kind: GroupingKind,
  signal?: AbortSignal,
): Promise<GroupingRow[]> {
  const rows: GroupingRow[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CHOICE_PAGES; page += 1) {
    const answer = await listGroupings(kind, 'active', cursor, signal);
    rows.push(...answer.items);
    if (!answer.nextCursor) break;
    cursor = answer.nextCursor;
  }
  return rows;
}

/** Creates a season or a product group (`catalog.manage`). Dates are sent for seasons only. */
export const createGrouping = (kind: GroupingKind, body: CreateSeasonRequest) =>
  apiRequest<GroupingRow>('POST', basePath(kind), rowSchema(kind), {
    body: kind === 'season' ? body : { code: body.code, name: body.name },
  });

/** Edits a season or a product group with the stale check; dates are sent for seasons only. */
export function updateGrouping(kind: GroupingKind, id: string, body: UpdateSeasonRequest) {
  const { startsOn, endsOn, ...rest } = body;
  return apiRequest<GroupingRow>('PATCH', rowPath(kind, id), rowSchema(kind), {
    body:
      kind === 'season'
        ? {
            ...rest,
            ...(startsOn !== undefined && { startsOn }),
            ...(endsOn !== undefined && { endsOn }),
          }
        : rest,
  });
}

/** Archives or unarchives a season or a product group. */
export const setGroupingArchived = (kind: GroupingKind, id: string, archived: boolean) =>
  apiRequest<GroupingRow>(
    'POST',
    `${rowPath(kind, id)}/${archived ? 'archive' : 'unarchive'}`,
    rowSchema(kind),
  );

/** Deletes a season or a product group no style or cost record uses. */
export const deleteGrouping = (kind: GroupingKind, id: string) =>
  apiRequest('DELETE', rowPath(kind, id), noContent);
