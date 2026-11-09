import { z } from 'zod';
import { LocalizedText } from '../localized-text.js';
import { GroupingCode } from './seasons.js';
import { SkuName, UpdatedAt } from './skus.js';

/**
 * One product group (spec 0012, AC-7). `protected` is true for the seeded `MAIN` group, which can
 * be renamed but never archived, deleted, or recoded (409 `PRODUCT_GROUP_PROTECTED`).
 * `updatedAt` is the microsecond UTC string the stale check compares.
 */
export const ProductGroup = z.object({
  id: z.uuid(),
  code: z.string(),
  name: LocalizedText,
  archived: z.boolean(),
  protected: z.boolean(),
  updatedAt: z.string(),
});
/** The validated shape of `ProductGroup`, as the api and web see it after parsing. */
export type ProductGroup = z.infer<typeof ProductGroup>;

/** One page of `GET /api/product-groups`; pass `nextCursor` back as `cursor`, null at the end. */
export const ProductGroupListResponse = z.object({
  items: z.array(ProductGroup),
  nextCursor: z.string().nullable(),
});
/** The validated shape of `ProductGroupListResponse`, as the api and web see it after parsing. */
export type ProductGroupListResponse = z.infer<typeof ProductGroupListResponse>;

/**
 * `POST /api/product-groups` (`catalog.manage`): a unique code (409 `PRODUCT_GROUP_CODE_TAKEN`)
 * and a name in at least one language.
 */
export const CreateProductGroupRequest = z.object({ code: GroupingCode, name: SkuName }).strict();
/** What a caller passes for `CreateProductGroupRequest`, before defaults and transforms are applied. */
export type CreateProductGroupRequest = z.input<typeof CreateProductGroupRequest>;

/**
 * `PATCH /api/product-groups/:id` (`catalog.manage`). Absent fields are left as is; `name`, when
 * sent, replaces both languages. A stale `updatedAt` answers 409 `STALE_RECORD`; a new code for
 * `MAIN` 409 `PRODUCT_GROUP_PROTECTED`.
 */
export const UpdateProductGroupRequest = z
  .object({ updatedAt: UpdatedAt, code: GroupingCode.optional(), name: SkuName.optional() })
  .strict();
/** What a caller passes for `UpdateProductGroupRequest`, before defaults and transforms are applied. */
export type UpdateProductGroupRequest = z.input<typeof UpdateProductGroupRequest>;
