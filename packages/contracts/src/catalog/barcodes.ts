import { normalizeDigits } from '@ssdashboard/i18n';
import { z } from 'zod';

/** A stored barcode: upper case letters, digits, dot, dash, and underscore, up to 64. */
export const BARCODE_CODE_PATTERN = /^[A-Z0-9._-]{1,64}$/;

/**
 * A barcode as typed or scanned (spec 0012, AC-10): trimmed, Arabic digits made Western,
 * uppercased, then checked against `BARCODE_CODE_PATTERN`. The same shaping as the search's
 * barcode branch, so a stored code is always found by a scan.
 */
export const BarcodeCode = z
  .string()
  .transform((value) => normalizeDigits(value.trim()).toUpperCase())
  .pipe(
    z.string().regex(BARCODE_CODE_PATTERN, 'Letters, digits, dot, dash, and underscore, up to 64'),
  );

/**
 * `POST /api/skus/:id/barcodes` (`catalog.edit`): one barcode for the SKU, scanned as one piece
 * (`pc`). A code another SKU (or this one) holds answers 409 `BARCODE_TAKEN` with `skuCode`.
 */
export const AddBarcodeRequest = z.object({ code: BarcodeCode }).strict();
/** What a caller passes for `AddBarcodeRequest`, before defaults and transforms are applied. */
export type AddBarcodeRequest = z.input<typeof AddBarcodeRequest>;
