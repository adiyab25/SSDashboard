import { readdirSync, readFileSync } from 'node:fs';
import { en, flatten } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AUDIT_RECORD_LABEL_PATTERN } from '../audit/audit-record-types.js';
import { ConfigResponse } from '../platform.js';
import { CONFIG_RESPONSE_FIELDS, PUBLIC_CONFIG_FIELDS } from './public-config.js';
import { SETTING_DEFINITIONS, SETTINGS_REGISTRY, isSettingKey } from './registry.js';
import { DOCUMENT_PREFIX_DEFAULTS, DocumentPrefixes } from './brand-settings.js';
import { SettingInvalidRule, type SettingDefinition } from './setting-definition.js';

const MIGRATIONS = new URL('../../../db/migrations/', import.meta.url);

/** The keys the migrations seed into `settings` (every `INSERT INTO "settings"` statement). */
function seededSettingKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql'))) {
    const text = readFileSync(new URL(file, MIGRATIONS), 'utf8');
    for (const statement of text.matchAll(/INSERT INTO "?settings"?[^;]*?;/gs)) {
      for (const row of statement[0].matchAll(/\(\s*'([a-z0-9_.]+)'\s*,/g)) {
        if (row[1]) keys.add(row[1]);
      }
    }
  }
  return keys;
}

/** The parts of Zod's internal definition the free text walk reads. */
interface ZodDefinitionView {
  type?: string;
  format?: string;
  checks?: { _zod?: { def?: { check?: string; format?: string } } }[];
  shape?: Record<string, unknown>;
  keyType?: unknown;
  valueType?: unknown;
  element?: unknown;
  innerType?: unknown;
  in?: unknown;
  out?: unknown;
  options?: unknown[];
  left?: unknown;
  right?: unknown;
}

/** The internal definition of a Zod schema, or undefined for anything else. */
function definitionOf(schema: unknown): ZodDefinitionView | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  return (schema as { _zod?: { def?: ZodDefinitionView } })._zod?.def;
}

/**
 * The string formats that hold no free text: identifiers and calendar values with a fixed
 * shape. Never `url`, `email`, or the case and substring checks (`lowercase`, `includes`,
 * `starts_with`, ...), which any sentence can pass.
 */
const SHAPED_STRING_FORMATS: ReadonlySet<string> = new Set([
  'uuid',
  'guid',
  'date',
  'datetime',
  'time',
  'duration',
]);

/** Schema types that can hold no text at all. */
const TEXTLESS_TYPES: ReadonlySet<string> = new Set([
  'number',
  'int',
  'bigint',
  'boolean',
  'enum',
  'literal',
  'null',
]);

/**
 * The paths inside a setting's schema where free text could be stored, failing closed: a string
 * counts as shaped only with a `regex` check or a format from `SHAPED_STRING_FORMATS`; objects,
 * records (keys included), arrays, unions, intersections, pipes, and the wrapping types are
 * walked; numbers, booleans, enums, literals, and null hold no text; any other type (`unknown`,
 * `any`, `json`, `transform`, ...) is a problem. Spec 0009 Follow-up (security review of the
 * settings audit record, finding 1): `audit_entries` keeps every setting value for ever and masks
 * only phone and email shapes, so no setting may take unpatterned text.
 */
function freeTextPaths(schema: unknown, path = 'value'): string[] {
  const definition = definitionOf(schema);
  if (!definition) return [`${path} (not a schema)`];
  const type = definition.type ?? 'unknown';
  if (TEXTLESS_TYPES.has(type)) return [];
  switch (type) {
    case 'string': {
      const shaped =
        (definition.format !== undefined && SHAPED_STRING_FORMATS.has(definition.format)) ||
        (definition.checks ?? []).some(
          (check) =>
            check._zod?.def?.check === 'string_format' && check._zod.def.format === 'regex',
        );
      return shaped ? [] : [path];
    }
    case 'object':
      return Object.entries(definition.shape ?? {}).flatMap(([key, inner]) =>
        freeTextPaths(inner, `${path}.${key}`),
      );
    case 'record':
      return [
        ...freeTextPaths(definition.keyType, `${path}[key]`),
        ...freeTextPaths(definition.valueType, `${path}[value]`),
      ];
    case 'array':
      return freeTextPaths(definition.element, `${path}[]`);
    case 'nullable':
    case 'optional':
    case 'default':
    case 'readonly':
    case 'catch':
    case 'nonoptional':
      return freeTextPaths(definition.innerType, path);
    case 'pipe':
      return [...freeTextPaths(definition.in, path), ...freeTextPaths(definition.out, path)];
    case 'union':
      return (definition.options ?? []).flatMap((option) => freeTextPaths(option, path));
    case 'intersection':
      return [...freeTextPaths(definition.left, path), ...freeTextPaths(definition.right, path)];
    default:
      return [`${path} (a ${type} schema)`];
  }
}

interface RegistryFacts {
  seeded: ReadonlySet<string>;
  labelled: (key: string) => boolean;
}

/**
 * Every rule of spec 0009 AC-1 the registry must keep, as plain sentences; an empty list means
 * the registry is sound. Kept here so the rule can be run on a broken registry too.
 */
function registryProblems(entries: readonly SettingDefinition[], facts: RegistryFacts): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.key)) problems.push(`${entry.key}: two entries share the key`);
    seen.add(entry.key);
    if (!/^[a-z][a-z0-9_.]*$/.test(entry.key)) problems.push(`${entry.key}: not a snake_case key`);
    // The key is the audit label of every write; a longer one would fail each write.
    if (!AUDIT_RECORD_LABEL_PATTERN.test(entry.key)) {
      problems.push(`${entry.key}: not a valid audit label (at most 64 characters)`);
    }
    if (!entry.schema.safeParse(entry.default).success) {
      problems.push(`${entry.key}: the default fails its own schema`);
    }
    if (entry.sqlRead && !facts.seeded.has(entry.key)) {
      problems.push(`${entry.key}: read by SQL but has no seed row`);
    }
    if (entry.kind === 'executing_step') {
      if (entry.default !== false) problems.push(`${entry.key}: a step must default to false`);
      if (entry.notifiesCustomer === undefined) {
        problems.push(`${entry.key}: a step must say whether it notifies the customer`);
      }
    }
    if (entry.onInvalid !== undefined && !SettingInvalidRule.safeParse(entry.onInvalid).success) {
      problems.push(`${entry.key}: onInvalid must be default or refuse`);
    }
    for (const where of freeTextPaths(entry.schema)) {
      problems.push(`${entry.key}: free text at ${where} (give it a pattern or an enum)`);
    }
    for (const key of [entry.label, entry.description, entry.warning]) {
      if (key !== undefined && !facts.labelled(key)) {
        problems.push(`${entry.key}: ${key} lacks an English or Arabic text`);
      }
    }
  }
  return problems;
}

const english = flatten(en);
const arabic = flatten(ar);
const facts: RegistryFacts = {
  seeded: seededSettingKeys(),
  labelled: (key) => Boolean(english[key]) && Boolean(arabic[key]),
};
const entries = SETTING_DEFINITIONS as readonly SettingDefinition[];

describe('the settings registry (spec 0009, AC-1)', () => {
  it('keeps every rule', () => {
    expect(registryProblems(entries, facts)).toEqual([]);
  });

  it('finds the seed rows of the keys SQL reads', () => {
    expect(facts.seeded).toContain('timezone');
    expect(facts.seeded).toContain('operating_day_cutoff_hour');
  });

  const sound = SETTINGS_REGISTRY.operations_wind_down_days as SettingDefinition;

  it.each([
    ['a repeated key', [sound, sound], 'two entries share the key'],
    ['a default failing its schema', [{ ...sound, default: 5 }], 'the default fails'],
    ['a SQL read key with no seed', [{ ...sound, sqlRead: true }], 'has no seed row'],
    [
      'a step defaulting to true',
      [
        {
          ...sound,
          kind: 'executing_step',
          schema: z.boolean(),
          default: true,
          notifiesCustomer: false,
        },
      ],
      'must default to false',
    ],
    [
      'a step without notifiesCustomer',
      [{ ...sound, kind: 'executing_step', schema: z.boolean(), default: false }],
      'notifies the customer',
    ],
    ['a key too long for an audit label', [{ ...sound, key: 'a'.repeat(65) }], 'audit label'],
    ['a missing label', [{ ...sound, label: 'settings.entries.nope.label' }], 'lacks an English'],
    ['an unknown invalid rule', [{ ...sound, onInvalid: 'ignore' }], 'onInvalid must be'],
    ['free text', [{ ...sound, schema: z.string(), default: 'x' }], 'free text at value'],
    [
      'free text deep in a map',
      [{ ...sound, schema: z.record(z.uuid(), z.array(z.string().max(5))), default: {} }],
      'free text at value[value][]',
    ],
    [
      'a free text map key',
      [{ ...sound, schema: z.record(z.string().trim(), z.number()), default: {} }],
      'free text at value[key]',
    ],
    ['an unknown value', [{ ...sound, schema: z.unknown(), default: 1 }], 'free text at value'],
    [
      'a lowercase string',
      [{ ...sound, schema: z.string().lowercase(), default: 'x' }],
      'free text at value',
    ],
    ['a url', [{ ...sound, schema: z.url(), default: 'https://x.test' }], 'free text at value'],
    [
      'an unknown map value',
      [{ ...sound, schema: z.record(z.uuid(), z.unknown()), default: {} }],
      'free text at value[value]',
    ],
  ] as const)('fails on %s', (_name, broken, problem) => {
    const problems = registryProblems(broken as unknown as SettingDefinition[], facts);
    expect(problems.join('\n')).toContain(problem);
  });

  it('knows its keys and nothing else', () => {
    expect(isSettingKey('timezone')).toBe(true);
    expect(isSettingKey('constructor')).toBe(false);
    expect(isSettingKey('nope')).toBe(false);
  });

  it('holds the policy knobs with their ranges (AC-22)', () => {
    const days = SETTINGS_REGISTRY.operations_wind_down_days.schema;
    expect(days.safeParse(59).success).toBe(false);
    expect(days.safeParse(365).success).toBe(true);
    expect(days.safeParse(366).success).toBe(false);
    const pickup = SETTINGS_REGISTRY.operations_wind_down_pickup_days.schema;
    expect(pickup.safeParse(14).success).toBe(true);
    expect(pickup.safeParse(15).success).toBe(false);
    const cutoff = SETTINGS_REGISTRY.operating_day_cutoff_hour.schema;
    expect(cutoff.safeParse(23).success).toBe(true);
    expect(cutoff.safeParse(24).success).toBe(false);
    expect(cutoff.safeParse(1.5).success).toBe(false);
  });

  // Security review S1: a setting that guards the ledger refuses a corrupt row on business reads.
  // Review R18: so do the document prefixes, and nothing else.
  it('fails closed on a corrupt lock date or document prefixes, and nowhere else', () => {
    expect(SETTINGS_REGISTRY.inventory_lock_date.onInvalid).toBe('refuse');
    expect(SETTINGS_REGISTRY.document_prefixes.onInvalid).toBe('refuse');
    const refusing = entries.filter((entry) => entry.onInvalid === 'refuse').map((e) => e.key);
    expect(refusing.sort()).toEqual(['document_prefixes', 'inventory_lock_date']);
  });

  // Review R3, security review S2: every document type keeps one short, distinct prefix.
  it('holds a prefix for every document type, short, capital, and distinct', () => {
    expect(DocumentPrefixes.safeParse(DOCUMENT_PREFIX_DEFAULTS).success).toBe(true);
    const { stock_receipt: _dropped, ...missing } = DOCUMENT_PREFIX_DEFAULTS;
    expect(DocumentPrefixes.safeParse(missing).success).toBe(false);
    expect(DocumentPrefixes.safeParse({ ...DOCUMENT_PREFIX_DEFAULTS, EXTRA: 'X' }).success).toBe(
      false,
    );
    for (const prefix of ['', 'po', '=SUM', 'ABCDEFGHI', 'P O']) {
      expect(DocumentPrefixes.safeParse({ ...DOCUMENT_PREFIX_DEFAULTS, PO: prefix }).success).toBe(
        false,
      );
    }
    const shared = DocumentPrefixes.safeParse({ ...DOCUMENT_PREFIX_DEFAULTS, SO: 'PO' });
    expect(shared.success).toBe(false);
    expect(shared.error?.issues[0]?.path).toEqual(['SO']);
  });

  it('locks the currency and asks a typed confirmation for the time zone, VAT, and the sales tax rate', () => {
    expect(SETTINGS_REGISTRY.currency.whoMayChange).toBe('nobody');
    expect(SETTINGS_REGISTRY.timezone).toMatchObject({ confirm: 'typed', reason: 'required' });
    expect(SETTINGS_REGISTRY.prices_include_vat).toMatchObject({ confirm: 'typed' });
    expect(SETTINGS_REGISTRY.sales_tax_rate).toMatchObject({
      confirm: 'typed',
      reason: 'required',
    });
  });
});

// Spec 0009, AC-31: the rows specs 0012 to 0015 request, exactly as spec 0009's table gives them.
describe('the requested rows (AC-31)', () => {
  const facts = (key: keyof typeof SETTINGS_REGISTRY) => {
    const entry = SETTINGS_REGISTRY[key] as SettingDefinition;
    return {
      bundle: entry.bundle,
      group: entry.group,
      default: entry.default,
      reason: entry.reason,
      exposure: entry.exposure,
      whoMayChange: entry.whoMayChange,
      sqlRead: entry.sqlRead,
      kind: entry.kind,
      warning: entry.warning !== undefined,
      confirm: entry.confirm,
      onInvalid: entry.onInvalid,
    };
  };
  const row = {
    whoMayChange: 'settings.manage',
    sqlRead: false,
    kind: 'value',
    exposure: 'staff',
    confirm: undefined,
    onInvalid: undefined,
  };

  it.each([
    [
      'customer_risk_signal',
      'core',
      'policies',
      { windowDays: 180, refusalsToSuggest: 2, returnsToSuggest: 2 },
      'optional',
      false,
    ],
    ['catalog.source_store_id', 'core', 'catalog', null, 'optional', false],
    ['catalog.store_product_groups', 'core', 'catalog', {}, 'required', true],
    ['catalog.new_style_season', 'core', 'catalog', null, 'optional', false],
    ['shopify_gift_tags', 'core', 'policies', {}, 'optional', false],
    ['shopify_stock_safety_buffer', 'warehouse', 'policies', 0, 'required', true],
  ] as const)('holds %s as the table gives it', (key, bundle, group, value, reason, warning) => {
    expect(facts(key)).toEqual({ ...row, bundle, group, default: value, reason, warning });
  });

  // The seventh row landed with spec 0013 (PR 43); milestone 5 only checks it against the table.
  it('holds sales_tax_rate as the table gives it, read only here', () => {
    expect(facts('sales_tax_rate')).toEqual({
      ...row,
      bundle: 'core',
      group: 'brand',
      default: '14.00',
      reason: 'required',
      warning: true,
      confirm: 'typed',
    });
    const rate = SETTINGS_REGISTRY.sales_tax_rate.schema;
    expect(rate.safeParse('0.00').success).toBe(true);
    expect(rate.safeParse('100.00').success).toBe(true);
    expect(rate.safeParse('100.01').success).toBe(false);
  });

  it('holds each value schema to its range', () => {
    const risk = SETTINGS_REGISTRY.customer_risk_signal.schema;
    const sound = { windowDays: 30, refusalsToSuggest: 1, returnsToSuggest: 20 };
    expect(risk.safeParse(sound).success).toBe(true);
    expect(risk.safeParse({ ...sound, windowDays: 29 }).success).toBe(false);
    expect(risk.safeParse({ ...sound, windowDays: 731 }).success).toBe(false);
    expect(risk.safeParse({ ...sound, refusalsToSuggest: 0 }).success).toBe(false);
    expect(risk.safeParse({ ...sound, returnsToSuggest: 21 }).success).toBe(false);
    expect(risk.safeParse({ ...sound, windowDays: 90.5 }).success).toBe(false);
    expect(risk.safeParse({ ...sound, extra: 1 }).success).toBe(false);

    const store = '01937f3a-0000-7000-8000-000000000001';
    const source = SETTINGS_REGISTRY['catalog.source_store_id'].schema;
    expect(source.safeParse(store).success).toBe(true);
    expect(source.safeParse('MAIN').success).toBe(false);
    const groups = SETTINGS_REGISTRY['catalog.store_product_groups'].schema;
    expect(groups.safeParse({ [store]: 'MAIN' }).success).toBe(true);
    expect(groups.safeParse({ [store]: 'main' }).success).toBe(false);
    expect(groups.safeParse({ MAIN: 'MAIN' }).success).toBe(false);
    const season = SETTINGS_REGISTRY['catalog.new_style_season'].schema;
    expect(season.safeParse('SS27').success).toBe(true);
    expect(season.safeParse('X'.repeat(17)).success).toBe(false);

    const buffer = SETTINGS_REGISTRY.shopify_stock_safety_buffer.schema;
    expect(buffer.safeParse(1000).success).toBe(true);
    expect(buffer.safeParse(1001).success).toBe(false);
    expect(buffer.safeParse(-1).success).toBe(false);
    expect(buffer.safeParse(1.5).success).toBe(false);
  });

  it('takes a Shopify gift tag with a letter of any script, never digits alone, at most 20', () => {
    const tags = SETTINGS_REGISTRY.shopify_gift_tags.schema;
    expect(tags.safeParse({ gift: 'gift', 'PR 2026': 'pr_seeding', هدية: 'gift' }).success).toBe(
      true,
    );
    expect(tags.safeParse({ 'collab:x/y_z.1-2': 'influencer' }).success).toBe(true);
    expect(tags.safeParse({ ['x'.repeat(40)]: 'gift' }).success).toBe(true);
    for (const tag of ['01012345678', '', 'x'.repeat(41), 'gift!', 'a\nb']) {
      expect(tags.safeParse({ [tag]: 'gift' }).success, tag).toBe(false);
    }
    expect(tags.safeParse({ gift: 'Ahmed Mohamed' }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`tag${i}`, 'gift']));
    expect(tags.safeParse(many).success).toBe(false);
  });

  it('keeps the time zone list after giving its name a shape', () => {
    const zone = SETTINGS_REGISTRY.timezone.schema;
    for (const name of ['Africa/Cairo', 'UTC', 'Etc/GMT+3', 'America/Argentina/Buenos_Aires']) {
      expect(zone.safeParse(name).success, name).toBe(true);
    }
    expect(zone.safeParse('Mars/Olympus').success).toBe(false);
    expect(zone.safeParse('Africa Cairo').success).toBe(false);
  });
});

// Spec 0009, AC-5: the public endpoint serves the spec 0004 fields and the public entries only.
describe('the public config', () => {
  it('maps exactly the public_config entries', () => {
    const publicKeys = entries
      .filter((entry) => entry.exposure === 'public_config')
      .map((entry) => entry.key)
      .sort();
    expect(Object.keys(PUBLIC_CONFIG_FIELDS).sort()).toEqual(publicKeys);
  });

  it('answers exactly the spec 0004 key set', () => {
    expect([...ConfigResponse.keyof().options].sort()).toEqual([...CONFIG_RESPONSE_FIELDS].sort());
    for (const field of Object.values(PUBLIC_CONFIG_FIELDS)) {
      expect(CONFIG_RESPONSE_FIELDS).toContain(field);
    }
  });
});
