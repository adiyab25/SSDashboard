import { PriceString, SkuCode, type SkuDetail } from '@ssdashboard/contracts';
import { z } from 'zod';
import { ApiError } from '@/api/client';

/** Name and price, built from the contract's field schemas (spec 0006, AC-2). */
export const EditSkuForm = z
  .object({
    nameEn: z.string().trim().max(200),
    nameAr: z.string().trim().max(200),
    price: z.union([z.literal(''), z.string().trim().pipe(PriceString)]),
  })
  .refine((form) => form.nameEn !== '' || form.nameAr !== '', {
    path: ['nameEn'],
    message: 'nameRequired',
  });
/** What the edit form holds while typing. */
export type EditInput = z.input<typeof EditSkuForm>;
/** The edit form after validation. */
export type EditOutput = z.output<typeof EditSkuForm>;

/** The code change form: one SKU code, checked by the contract. */
export const SkuCodeForm = z.object({ code: SkuCode });
/** What the code form holds while typing. */
export type CodeInput = z.input<typeof SkuCodeForm>;
/** The code form after validation. */
export type CodeOutput = z.output<typeof SkuCodeForm>;

/** Api error codes with a message of their own. */
const KNOWN = [
  'STALE_RECORD',
  'CODE_LOCKED',
  'SKU_TAKEN',
  'STOCK_ON_HAND',
  'IN_USE',
  'BUSY',
] as const;
/** An api error code the dialog has its own message for. */
export type KnownCode = (typeof KNOWN)[number];

/** The api error code when the dialog has a message for it, else `generic`. */
export function knownCode(error: unknown): KnownCode | 'generic' {
  return error instanceof ApiError && (KNOWN as readonly string[]).includes(error.code)
    ? (error.code as KnownCode)
    : 'generic';
}

/** The form values for a SKU, with empty strings for missing text and price. */
export const skuEditValuesOf = (sku: SkuDetail): EditInput => ({
  nameEn: sku.name.en ?? '',
  nameAr: sku.name.ar ?? '',
  price: sku.price ?? '',
});

/** The three confirmed actions on a SKU. */
export type SkuLifecycleAction = 'archive' | 'unarchive' | 'delete';

/** The mutation key shared by every write of one SKU, so the dialog can tell one is running. */
export const skuEditMutationKey = (skuId: string) => ['sku-edit', skuId] as const;
