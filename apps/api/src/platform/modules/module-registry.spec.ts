import {
  defineModule,
  defineSetting,
  MODULE_REGISTRY,
  type ModuleDefinition,
  type SettingDefinition,
} from '@ssdashboard/contracts';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { ModuleRegistry, StepSettingInvalid } from './module-registry.js';

// Spec 0009, AC-6, AC-21, task 23: a test's executing step settings keep the step rules.

const gating = (key: string, steps: string[]): ModuleDefinition =>
  defineModule({
    key,
    bundle: 'core',
    toggle: false,
    requires: [],
    label: 'modules.platform.label',
    description: 'modules.platform.description',
    capabilities: [
      {
        key: `${key}.work`,
        bundle: 'operations',
        kind: 'write',
        windDown: 'none',
        workOf: [],
        steps,
        label: 'modules.capabilities.mailSend',
      },
    ],
  });

const step = (over: Partial<SettingDefinition> = {}): SettingDefinition => ({
  ...defineSetting({
    key: 'step.fixture',
    schema: z.boolean(),
    default: false,
    bundle: 'operations',
    group: 'automations',
    whoMayChange: 'settings.manage',
    reason: 'required',
    exposure: 'staff',
    sqlRead: false,
    kind: 'executing_step',
    notifiesCustomer: false,
    label: 'settings.entries.operationsWindDownDays.label',
    description: 'settings.entries.operationsWindDownDays.description',
  }),
  ...over,
});

describe('ModuleRegistry with test step settings', () => {
  it('serves a step listed by exactly one capability', () => {
    const registry = new ModuleRegistry(
      [...MODULE_REGISTRY, gating('gate', ['step.fixture'])],
      [step()],
    );
    expect(registry.settingDefinition('step.fixture')?.kind).toBe('executing_step');
  });

  it('refuses a step that is no executing_step, defaults on, or is listed by none or two', () => {
    const one = [...MODULE_REGISTRY, gating('gate', ['step.fixture'])];
    expect(() => new ModuleRegistry(one, [step({ kind: 'value' })])).toThrow(StepSettingInvalid);
    expect(() => new ModuleRegistry(one, [step({ default: true })])).toThrow(StepSettingInvalid);
    expect(() => new ModuleRegistry(MODULE_REGISTRY, [step()])).toThrow(StepSettingInvalid);
    expect(() => new ModuleRegistry(one, [step({ key: 'timezone' })])).toThrow(StepSettingInvalid);
    const two = [...one, gating('other', ['step.fixture'])];
    expect(() => new ModuleRegistry(two, [step()])).toThrow(StepSettingInvalid);
  });
});
