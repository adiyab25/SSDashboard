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

/** The fields a sales channel can own that an edit may hit (`FIELD_OWNED_BY_CHANNEL`, spec 0012, AC-15). */
export type ChannelOwnedField =
  'price' | 'name.en' | 'name.ar' | 'tags' | 'barcode' | 'options' | 'generic';

/**
 * Which field a `FIELD_OWNED_BY_CHANNEL` answer names, `generic` when the body names none the
 * screen knows, so the message always says which field is the channel's.
 */
export function channelOwnedField(error: unknown): ChannelOwnedField {
  const field = error instanceof ApiError ? error.body.field : undefined;
  return field === 'price' ||
    field === 'name.en' ||
    field === 'name.ar' ||
    field === 'tags' ||
    field === 'barcode' ||
    field === 'options'
    ? field
    : 'generic';
}

/** The style ids a bulk assign did not find (`NOT_FOUND` with `missingIds`). */
export function missingStyleIds(error: unknown): string[] {
  return error instanceof ApiError ? (error.body.missingIds ?? []) : [];
}
