import { BARCODE_CODE_PATTERN, SKU_CODE_PATTERN } from '@ssdashboard/contracts';
import { normalizeDigits } from '@ssdashboard/i18n';

/**
 * The first key of the one transaction advisory lock `CatalogChannelSync.applyProduct` takes,
 * as `pg_advisory_xact_lock(CATALOG_CHANNEL_STYLE_LOCK, hashtext(channelStyleLockKey(handle)))`
 * (spec 0012, channel rule 1). The two key form is its own key space, apart from the single key
 * locks of the ledger and identity and from the customers' keys (727_010 to 727_012). Two calls
 * for the same handle (two stores' webhooks for one product) queue; calls for other handles never
 * wait on it. A `hashtext` collision between two handles only makes them queue, never changes a
 * result. One handle lock per call; the SKU locks of `CATALOG_CHANNEL_SKU_LOCK` follow it, only
 * for the codes the call may create (a per row lock ran out of shared memory on a large posting,
 * packages/db AGENTS.md, so a call that only updates takes none).
 */
export const CATALOG_CHANNEL_STYLE_LOCK = 727_020;

/** The longest style code part taken from a handle, before a `-2`, `-3` clash suffix. */
export const STYLE_CODE_FROM_HANDLE_LENGTH = 60;

/**
 * The text hashed into the second lock key: `catalog.channel_style:` plus the handle trimmed and
 * lowercased (Shopify handles are lowercase; the lowering keeps a hand typed one in the same
 * queue). Passed to SQL as a bound parameter, never concatenated into a statement. Pure.
 */
export function channelStyleLockKey(handle: string): string {
  return `catalog.channel_style:${asciiLower(handle.trim())}`;
}

/**
 * The first key of the second set of advisory locks `applyProduct` takes (lead ruling
 * 2026-11-11): one per SKU code the call may create, after the handle lock, in sorted order, as
 * `pg_advisory_xact_lock(CATALOG_CHANNEL_SKU_LOCK, hashtext(channelSkuLockKey(code)))`. Two
 * products under different handles (two stores naming one product differently) that bring the
 * same new SKU queue here, and the later one resolves the SKU as existing, so one product never
 * splits across two styles. Its own key space beside `CATALOG_CHANNEL_STYLE_LOCK`.
 */
export const CATALOG_CHANNEL_SKU_LOCK = 727_021;

/** The text hashed into a SKU lock's second key: `catalog.channel_sku:` plus the matched code. Pure. */
export function channelSkuLockKey(code: string): string {
  return `catalog.channel_sku:${code}`;
}

/** Whether a text holds only printable ASCII (U+0020 to U+007E). Pure. */
export function isPrintableAscii(text: string): boolean {
  return /^[\x20-\x7E]*$/.test(text);
}

/**
 * ASCII letters lowercased, every other character kept as it is: Unicode case mapping folds
 * distinct characters into one (`'ſ'` to `S`, `'ı'` to `I`, security review L2), so only ASCII
 * is case mapped.
 */
const asciiLower = (text: string) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/** ASCII letters uppercased, every other character kept (see `asciiLower`). */
const asciiUpper = (text: string) => text.replace(/[a-z]/g, (letter) => letter.toUpperCase());

/** The longest style code the code pattern allows (`SKU_CODE_PATTERN`). */
const MAX_STYLE_CODE_LENGTH = 64;

/**
 * The code of a style first created from a channel product (owner decision Q-12.1, channel
 * rule 3): the handle with ASCII letters uppercased, every character outside `[A-Z0-9._-]`
 * (every non ASCII one included, security review L2) turned into `-`, cut to 60 characters. A
 * handle left with no letter or digit (an Arabic handle) takes `fallback` instead, the first
 * resolved SKU code shaped the same way (Igris decision 2026-11-11, recorded in Q-12.1).
 * `attempt` 2, 3, and so on append `-2`, `-3` after a clash, cutting the base so the code stays
 * within 64 characters (security review L5): it always matches the SKU code pattern. Pure.
 */
export function styleCodeFromHandle(handle: string, attempt = 1, fallback = ''): string {
  const shape = (text: string) => asciiUpper(text.trim()).replace(/[^A-Z0-9._-]/g, '-');
  let base = shape(handle);
  if (!/[A-Z0-9]/.test(base)) base = shape(fallback);
  if (!/[A-Z0-9]/.test(base)) base = 'STYLE';
  const suffix = attempt > 1 ? `-${attempt}` : '';
  const room = Math.min(STYLE_CODE_FROM_HANDLE_LENGTH, MAX_STYLE_CODE_LENGTH - suffix.length);
  return `${base.slice(0, room)}${suffix}`;
}

/**
 * The name language a channel title writes (spec 0012, field ownership): `ar` when the title holds
 * an Arabic letter, else `en`. Arabic digits alone do not count. Pure.
 */
export function nameLanguageOf(text: string): 'en' | 'ar' {
  return /(?=\p{L})\p{Script=Arabic}/u.test(text) ? 'ar' : 'en';
}

/**
 * A channel SKU as the catalog matches it (AC-14): trimmed and uppercased (ASCII only), or null
 * when blank.
 * Never checks the pattern; `isValidSku` does. Pure.
 */
export function channelSkuOf(sku: string | null): string | null {
  const code = sku?.trim() ?? '';
  if (!code.length) return null;
  // A non ASCII SKU is returned as sent, so it fails the pattern (`invalid_sku`) and never
  // folds onto another code by Unicode case mapping (security review L2).
  return isPrintableAscii(code) ? asciiUpper(code) : code;
}

/** Whether a matched channel SKU fits the stored code pattern (`SKU_CODE_PATTERN`). Pure. */
export function isValidSku(code: string): boolean {
  return SKU_CODE_PATTERN.test(code);
}

/** What `channelBarcodeOf` answers for a channel barcode that fails the barcode pattern. */
export const INVALID_BARCODE = Symbol('invalid channel barcode');

/**
 * The channel barcode as stored: shaped like `BarcodeCode` (trimmed, Western digits, uppercased),
 * `null` when the channel sends none, or `INVALID_BARCODE` when it fails `BARCODE_CODE_PATTERN`
 * (then it is not applied and the variant answers `barcode_conflict`). Pure.
 */
export function channelBarcodeOf(barcode: string | null): string | null | typeof INVALID_BARCODE {
  if (barcode === null || barcode.trim() === '') return null;
  const digits = normalizeDigits(barcode.trim());
  // ASCII only before uppercasing (security review L2): `'ſ'` must not become `S`.
  if (!isPrintableAscii(digits)) return INVALID_BARCODE;
  const code = asciiUpper(digits);
  return BARCODE_CODE_PATTERN.test(code) ? code : INVALID_BARCODE;
}

/**
 * An amount as PostgreSQL prints a `numeric(14,2)` (`250.50`), so a channel price compares with
 * the stored text without a float: `250`, `250.5`, and `0250.50` all give `250.50`. Pure.
 */
export function moneyText(value: string | null): string | null {
  if (value === null) return null;
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  return `${negative ? '-' : ''}${BigInt(whole).toString()}.${fraction.padEnd(2, '0')}`;
}

/**
 * A variant's `option_values` (position to value index) as one comparable string, keys sorted,
 * since `jsonb` equality ignores key order. Pure.
 */
export function optionValuesKey(values: Readonly<Record<string, number>>): string {
  return JSON.stringify(
    Object.keys(values)
      .sort()
      .map((position) => [position, values[position]]),
  );
}
