import { ApiError } from '@/api/client';

/**
 * The api's stable error code when the screen has its own wording for it, else `generic`. Each
 * catalog dialog passes the codes its route answers, so every one gets a message of its own and
 * an unknown code never shows raw.
 */
export function catalogErrorCode<Code extends string>(
  error: unknown,
  known: readonly Code[],
): Code | 'generic' {
  return error instanceof ApiError && (known as readonly string[]).includes(error.code)
    ? (error.code as Code)
    : 'generic';
}

/** The SKU code a `BARCODE_TAKEN` answer names, when the api sent one. */
export function barcodeHolder(error: unknown): string | undefined {
  return error instanceof ApiError ? error.body.skuCode : undefined;
}

/** The style ids a bulk assign did not find (`NOT_FOUND` with `missingIds`). */
export function missingStyleIds(error: unknown): string[] {
  return error instanceof ApiError ? (error.body.missingIds ?? []) : [];
}
