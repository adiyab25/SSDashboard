import { readdirSync, readFileSync } from 'node:fs';
import { en, flatten } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
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
    ['a missing label', [{ ...sound, label: 'settings.entries.nope.label' }], 'lacks an English'],
    ['an unknown invalid rule', [{ ...sound, onInvalid: 'ignore' }], 'onInvalid must be'],
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

  it('locks the currency and asks a typed confirmation for the time zone and VAT', () => {
    expect(SETTINGS_REGISTRY.currency.whoMayChange).toBe('nobody');
    expect(SETTINGS_REGISTRY.timezone).toMatchObject({ confirm: 'typed', reason: 'required' });
    expect(SETTINGS_REGISTRY.prices_include_vat).toMatchObject({ confirm: 'typed' });
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
