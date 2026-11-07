import { isValidTimeZone } from '@ssdashboard/i18n';
import { z } from 'zod';
import { defineSetting } from './setting-definition.js';

/** A language code: two or three lowercase letters. */
const LanguageCode = z.string().regex(/^[a-z]{2,3}$/);

/**
 * The document types that take a number from `NumberingService`, each with the prefix the
 * baseline seeds. Every type must keep a prefix, or the next document of that type cannot be
 * numbered (review R3).
 */
export const DOCUMENT_PREFIX_DEFAULTS = {
  PO: 'PO',
  GRN: 'GRN',
  SO: 'SO',
  SHP: 'SHP',
  RMA: 'RMA',
  TRF: 'TRF',
  ADJ: 'ADJ',
  CNT: 'CNT',
  MO: 'MO',
  stock_receipt: 'SR',
} as const;

/** A document type that takes a number. */
export type DocumentType = keyof typeof DOCUMENT_PREFIX_DEFAULTS;

/**
 * One document prefix: 1 to 8 capital letters or digits, so it can never start a spreadsheet
 * formula (`=`, `+`) in an export or grow without bound (security review S2).
 */
export const DocumentPrefix = z
  .string()
  .regex(/^[A-Z0-9]{1,8}$/, 'Use 1 to 8 capital letters or digits');

/**
 * The stored shape of `document_prefixes`: exactly the known document types, each with a prefix,
 * no two types sharing one (two types with one prefix would issue the same number twice).
 */
export const DocumentPrefixes = z
  .strictObject(
    Object.fromEntries(
      Object.keys(DOCUMENT_PREFIX_DEFAULTS).map((type) => [type, DocumentPrefix]),
    ) as Record<DocumentType, typeof DocumentPrefix>,
  )
  .superRefine((prefixes, context) => {
    const seen = new Map<string, string>();
    for (const [type, prefix] of Object.entries(prefixes)) {
      const other = seen.get(prefix);
      if (other !== undefined) {
        context.addIssue({
          code: 'custom',
          path: [type],
          message: `The prefix is already used by ${other}`,
        });
      }
      seen.set(prefix, type);
    }
  });

/**
 * The Brand section of the settings registry (spec 0009, AC-1, AC-25): the keys spec 0002 and
 * spec 0004 seeded, moved here unchanged, plus `operating_day_cutoff_hour`. A key here keeps its
 * stored shape forever; a change of shape is a new key and a data move.
 */
export const BRAND_SETTINGS = [
  defineSetting({
    key: 'currency',
    schema: z.string().regex(/^[A-Z]{3}$/),
    default: 'EGP',
    bundle: 'core',
    group: 'brand',
    // Set at provisioning: no money column carries a currency, so changing it would restate
    // every amount.
    whoMayChange: 'nobody',
    reason: 'optional',
    exposure: 'public_config',
    sqlRead: false,
    kind: 'value',
    label: 'settings.entries.currency.label',
    description: 'settings.entries.currency.description',
  }),
  defineSetting({
    key: 'timezone',
    schema: z.string().refine(isValidTimeZone, 'Not a time zone name'),
    default: 'Africa/Cairo',
    bundle: 'core',
    group: 'brand',
    whoMayChange: 'settings.manage',
    reason: 'required',
    exposure: 'public_config',
    sqlRead: true,
    kind: 'value',
    label: 'settings.entries.timezone.label',
    description: 'settings.entries.timezone.description',
    warning: 'settings.warnings.timezone',
    confirm: 'typed',
  }),
  defineSetting({
    key: 'prices_include_vat',
    schema: z.boolean(),
    default: true,
    bundle: 'core',
    group: 'brand',
    whoMayChange: 'settings.manage',
    reason: 'required',
    exposure: 'staff',
    sqlRead: false,
    kind: 'value',
    label: 'settings.entries.pricesIncludeVat.label',
    description: 'settings.entries.pricesIncludeVat.description',
    warning: 'settings.warnings.pricesIncludeVat',
    confirm: 'typed',
  }),
  defineSetting({
    key: 'inventory_lock_date',
    /**
     * `YYYY-MM-DD`; a posting's operating day (its `timezone` date with
     * `operating_day_cutoff_hour`, stamped by the database) must be after it (review R5).
     */
    schema: z.iso.date().nullable(),
    default: null,
    bundle: 'core',
    group: 'brand',
    whoMayChange: 'settings.manage',
    reason: 'required',
    exposure: 'staff',
    sqlRead: false,
    kind: 'value',
    // A corrupt lock date must stop postings, never read as "nothing locked" (security S1).
    onInvalid: 'refuse',
    label: 'settings.entries.inventoryLockDate.label',
    description: 'settings.entries.inventoryLockDate.description',
  }),
  defineSetting({
    key: 'document_prefixes',
    schema: DocumentPrefixes,
    default: { ...DOCUMENT_PREFIX_DEFAULTS },
    // A corrupt row must stop numbering, never fall back to the defaults: those could issue a
    // number another document already carries under the prefix in force (review R18).
    onInvalid: 'refuse',
    bundle: 'core',
    group: 'brand',
    whoMayChange: 'settings.manage',
    reason: 'optional',
    exposure: 'staff',
    sqlRead: false,
    kind: 'value',
    label: 'settings.entries.documentPrefixes.label',
    description: 'settings.entries.documentPrefixes.description',
  }),
  defineSetting({
    key: 'languages',
    /**
     * Enabled language codes in switcher order; at least one, no repeats. A write may only enable
     * languages that ship a catalog (`settingWriteIssues`); a read keeps any well formed code, so
     * a client language set up outside the screen stays readable.
     */
    schema: z
      .array(LanguageCode)
      .min(1)
      .refine((codes) => new Set(codes).size === codes.length, 'Languages must not repeat'),
    default: ['en', 'ar'],
    bundle: 'core',
    group: 'brand',
    whoMayChange: 'settings.manage',
    reason: 'optional',
    exposure: 'public_config',
    sqlRead: false,
    kind: 'value',
    label: 'settings.entries.languages.label',
    description: 'settings.entries.languages.description',
  }),
  defineSetting({
    key: 'default_language',
    /** The language a first visit opens in; the config endpoint checks it is in `languages`. */
    schema: LanguageCode,
    default: 'en',
    bundle: 'core',
    group: 'brand',
    whoMayChange: 'settings.manage',
    reason: 'optional',
    exposure: 'public_config',
    sqlRead: false,
    kind: 'value',
    label: 'settings.entries.defaultLanguage.label',
    description: 'settings.entries.defaultLanguage.description',
  }),
  defineSetting({
    key: 'operating_day_cutoff_hour',
    /** Hour (0 to 23) before which an instant still belongs to the previous operating day (A3). */
    schema: z.number().int().min(0).max(23),
    default: 0,
    bundle: 'core',
    group: 'brand',
    whoMayChange: 'settings.manage',
    reason: 'required',
    exposure: 'staff',
    sqlRead: true,
    kind: 'value',
    label: 'settings.entries.operatingDayCutoffHour.label',
    description: 'settings.entries.operatingDayCutoffHour.description',
    warning: 'settings.warnings.operatingDayCutoffHour',
  }),
] as const;
