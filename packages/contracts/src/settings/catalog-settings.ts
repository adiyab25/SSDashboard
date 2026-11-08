import { z } from 'zod';
import { defineSetting } from './setting-definition.js';

/**
 * A product group or season code as spec 0012 shapes it: 1 to 16 capital letters, digits, dot,
 * dash, or underscore (the same shape as a location code).
 */
export const CATALOG_CODE_PATTERN = /^[A-Z0-9._-]{1,16}$/;

/** One product group or season code. */
const CatalogCode = z
  .string()
  .regex(CATALOG_CODE_PATTERN, 'Letters, digits, dot, dash, and underscore, up to 16');

/**
 * The Catalog section of the settings registry (spec 0009, AC-25, AC-31, *Rows requested by specs
 * 0012 to 0015*): the three keys spec 0012 requests, exactly as spec 0009's table gives them.
 * Nothing reads them until spec 0012's build does; the screen shows them with their value and
 * default, and edits them by picker only once the list a picker needs has a route.
 */
export const CATALOG_SETTINGS = [
  defineSetting({
    key: 'catalog.source_store_id',
    // The store whose products seed the catalog, or none.
    schema: z.uuid().nullable(),
    default: null,
    bundle: 'core',
    group: 'catalog',
    whoMayChange: 'settings.manage',
    reason: 'optional',
    exposure: 'staff',
    sqlRead: false,
    kind: 'value',
    label: 'settings.entries.catalogSourceStoreId.label',
    description: 'settings.entries.catalogSourceStoreId.description',
  }),
  defineSetting({
    key: 'catalog.store_product_groups',
    // Store id to the product group its new styles get, which decides their accounting export
    // code; so a change needs a reason (wave 1 review W17).
    schema: z.record(z.uuid(), CatalogCode),
    default: {},
    bundle: 'core',
    group: 'catalog',
    whoMayChange: 'settings.manage',
    reason: 'required',
    exposure: 'staff',
    sqlRead: false,
    kind: 'value',
    label: 'settings.entries.catalogStoreProductGroups.label',
    description: 'settings.entries.catalogStoreProductGroups.description',
    warning: 'settings.warnings.catalogStoreProductGroups',
  }),
  defineSetting({
    key: 'catalog.new_style_season',
    // The season a newly created style gets, or none.
    schema: CatalogCode.nullable(),
    default: null,
    bundle: 'core',
    group: 'catalog',
    whoMayChange: 'settings.manage',
    reason: 'optional',
    exposure: 'staff',
    sqlRead: false,
    kind: 'value',
    label: 'settings.entries.catalogNewStyleSeason.label',
    description: 'settings.entries.catalogNewStyleSeason.description',
  }),
] as const;
