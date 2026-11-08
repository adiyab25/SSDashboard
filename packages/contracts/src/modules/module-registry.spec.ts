import { en, flatten } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { describe, expect, it } from 'vitest';
import { SETTING_DEFINITIONS } from '../settings/registry.js';
import type { SettingDefinition } from '../settings/setting-definition.js';
import { defineModule, type ModuleDefinition } from './module-definition.js';
import { MODULE_REGISTRY } from './module-registry.js';
import {
  capabilityOfStep,
  moduleRegistryIssues,
  type StepSettingFacts,
} from './module-registry-checks.js';
import {
  moduleKeyOfToggle,
  moduleToggleKey,
  moduleToggleSetting,
  moduleToggleSettings,
} from './module-toggles.js';

const SETTINGS: StepSettingFacts[] = (SETTING_DEFINITIONS as readonly SettingDefinition[]).map(
  ({ key, kind, bundle }) => ({ key, kind, bundle }),
);

/** A small sound registry the broken cases change one thing in. */
function base(): ModuleDefinition[] {
  return [
    defineModule({
      key: 'coreone',
      bundle: 'core',
      toggle: false,
      requires: [],
      label: 'modules.platform.label',
      description: 'modules.platform.description',
      capabilities: [
        {
          key: 'coreone.sync',
          bundle: 'core',
          kind: 'read',
          windDown: 'none',
          workOf: [],
          label: 'modules.capabilities.mailSend',
        },
        {
          key: 'coreone.push',
          bundle: 'warehouse',
          kind: 'write',
          windDown: 'none',
          requiresOneOf: ['ops.source'],
          workOf: ['stock.receive'],
          steps: ['step.push'],
          label: 'modules.capabilities.mailSend',
        },
      ],
    }),
    defineModule({
      key: 'ops',
      bundle: 'operations',
      toggle: true,
      requires: ['coreone'],
      label: 'modules.platform.label',
      description: 'modules.platform.description',
      capabilities: [
        {
          key: 'ops.source',
          bundle: 'operations',
          kind: 'read',
          windDown: 'none',
          workOf: [],
          label: 'modules.capabilities.mailSend',
        },
      ],
    }),
  ];
}
const STEP: StepSettingFacts = { key: 'step.push', kind: 'executing_step', bundle: 'warehouse' };

/** `base()` with one module replaced by `change` of it. */
function changed(key: string, change: (m: ModuleDefinition) => ModuleDefinition) {
  return base().map((module) => (module.key === key ? change(module) : module));
}

// Spec 0009, AC-6: the module registry and the rules it keeps.
describe('the module registry (AC-6)', () => {
  it('holds the eight modules of today and the five core job capabilities', () => {
    expect(MODULE_REGISTRY.map((m) => m.key)).toEqual([
      'platform',
      'audit',
      'identity',
      'catalog',
      'inventory',
      'partners',
      'mail',
      'health',
    ]);
    expect(MODULE_REGISTRY.flatMap((m) => m.capabilities.map((c) => c.key))).toEqual([
      'platform.reconcile_modules',
      'platform.license_check',
      'identity.cleanup',
      'inventory.reconcile',
      'mail.send',
    ]);
    for (const module of MODULE_REGISTRY) {
      expect(module, module.key).toMatchObject({ bundle: 'core', toggle: false, requires: [] });
      for (const capability of module.capabilities) {
        expect(capability, capability.key).toMatchObject({ bundle: 'core', windDown: 'none' });
      }
    }
  });

  it('keeps every rule of AC-6', () => {
    expect(moduleRegistryIssues(MODULE_REGISTRY, SETTINGS)).toEqual([]);
  });

  it('labels every module and capability in English and Arabic', () => {
    const english = flatten(en);
    const arabic = flatten(ar);
    const keys = MODULE_REGISTRY.flatMap((m) => [
      m.label,
      m.description,
      ...m.capabilities.map((c) => c.label),
    ]);
    const missing = keys.filter((key) => !english[key] || !arabic[key]);
    expect(missing).toEqual([]);
  });

  it('accepts the sound fixture registry', () => {
    expect(moduleRegistryIssues(base(), [...SETTINGS, STEP])).toEqual([]);
  });

  it.each<[string, ModuleDefinition[], StepSettingFacts[], string]>([
    [
      'a core module with a toggle',
      changed('coreone', (m) => ({ ...m, toggle: true })),
      [STEP],
      'coreone: a core module never has a toggle',
    ],
    [
      'a core module requiring a non core one',
      changed('coreone', (m) => ({ ...m, requires: ['ops'] })),
      [STEP],
      'coreone: a core module requires the non core module ops',
    ],
    [
      'a module requiring an unknown one',
      changed('ops', (m) => ({ ...m, requires: ['nowhere'] })),
      [STEP],
      'ops: requires nowhere, which is not a module',
    ],
    [
      'a requires loop',
      [
        ...changed('ops', (m) => ({ ...m, requires: ['opstwo'] })),
        defineModule({ ...base()[1]!, key: 'opstwo', requires: ['ops'], capabilities: [] }),
      ],
      [STEP],
      'ops: its requires form a loop',
    ],
    [
      'a repeated capability key',
      changed('ops', (m) => ({
        ...m,
        capabilities: [...m.capabilities, { ...m.capabilities[0]! }],
      })),
      [STEP],
      'ops.source: two capabilities share the key',
    ],
    [
      'a capability key outside its module',
      changed('ops', (m) => ({
        ...m,
        capabilities: [...m.capabilities, { ...m.capabilities[0]!, key: 'other.thing' }],
      })),
      [STEP],
      'other.thing: a capability key is <module>.<name> of ops',
    ],
    [
      'an unknown requiresOneOf key',
      changed('coreone', (m) => ({
        ...m,
        capabilities: m.capabilities.map((c) => ({ ...c, requiresOneOf: ['ops.nothing'] })),
      })),
      [STEP],
      'coreone.sync: requiresOneOf names ops.nothing, which is not a capability',
    ],
    [
      'a requiresOneOf loop',
      changed('ops', (m) => ({
        ...m,
        capabilities: m.capabilities.map((c) => ({ ...c, requiresOneOf: ['coreone.push'] })),
      })),
      [STEP],
      'coreone.push: its requiresOneOf form a loop',
    ],
    [
      'a step that is not an executing step setting',
      base(),
      [{ ...STEP, kind: 'value' }],
      'coreone.push: step step.push is not an executing_step setting',
    ],
    [
      'a step of another bundle',
      base(),
      [{ ...STEP, bundle: 'operations' }],
      "coreone.push: step step.push is not in the capability's bundle",
    ],
    [
      'a step listed by two capabilities',
      changed('ops', (m) => ({
        ...m,
        capabilities: m.capabilities.map((c) => ({
          ...c,
          bundle: 'warehouse',
          steps: ['step.push'],
        })),
      })),
      [STEP],
      'step.push: a step is listed by coreone.push and ops.source',
    ],
    [
      'a step listed by no capability',
      base(),
      [STEP, { key: 'step.lonely', kind: 'executing_step', bundle: 'operations' }],
      'step.lonely: an executing step is listed by no capability',
    ],
    [
      'a module key of two words (code review m3, finding 10)',
      changed('ops', (m) => ({ ...m, key: 'ops_two', capabilities: [] })),
      [STEP],
      'ops_two: a module key is one lowercase word',
    ],
    [
      'a capability name with a doubled separator (code review m3, finding 11)',
      changed('ops', (m) => ({
        ...m,
        capabilities: [...m.capabilities, { ...m.capabilities[0]!, key: 'ops.x..y' }],
      })),
      [STEP],
      'ops.x..y: a capability key is <module>.<name> of ops',
    ],
    [
      'a capability name ending in an underscore',
      changed('ops', (m) => ({
        ...m,
        capabilities: [...m.capabilities, { ...m.capabilities[0]!, key: 'ops.stock_' }],
      })),
      [STEP],
      'ops.stock_: a capability key is <module>.<name> of ops',
    ],
  ])('refuses %s', (_case, modules, settings, issue) => {
    expect(moduleRegistryIssues(modules, settings)).toContain(issue);
  });

  it('finds the capability a step gates', () => {
    expect(capabilityOfStep(base(), 'step.push')?.capability.key).toBe('coreone.push');
    expect(capabilityOfStep(base(), 'step.none')).toBeUndefined();
  });
});

// Spec 0009, AC-12: a toggle is the setting module.<key>.enabled of a toggleable module.
describe('module toggles (AC-12)', () => {
  it('derives one boolean setting per toggleable module, default on, reason required', () => {
    const ops = base()[1]!;
    const setting = moduleToggleSetting(ops);
    expect(setting).toMatchObject({
      key: 'module.ops.enabled',
      default: true,
      bundle: 'operations',
      group: 'modules',
      whoMayChange: 'settings.manage',
      reason: 'required',
      exposure: 'staff',
      sqlRead: false,
      kind: 'value',
    });
    expect(setting?.schema.safeParse(false).success).toBe(true);
    expect(setting?.schema.safeParse('false').success).toBe(false);
    expect(moduleToggleSetting(base()[0]!)).toBeUndefined();
    expect(moduleToggleSettings(base()).map((s) => s.key)).toEqual(['module.ops.enabled']);
  });

  it('gives no toggle to any module of today', () => {
    expect(moduleToggleSettings(MODULE_REGISTRY)).toEqual([]);
  });

  it('reads a module key back from its toggle key and nothing else', () => {
    expect(moduleKeyOfToggle(moduleToggleKey('consignment'))).toBe('consignment');
    expect(moduleKeyOfToggle('module.Bad.enabled')).toBeUndefined();
    expect(moduleKeyOfToggle('timezone')).toBeUndefined();
    expect(moduleKeyOfToggle('module.ops.enabled.extra')).toBeUndefined();
    expect(moduleKeyOfToggle('module.two_words.enabled')).toBeUndefined();
  });
});
