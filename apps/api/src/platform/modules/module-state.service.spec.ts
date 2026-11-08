import { Logger } from '@nestjs/common';
import { defineModule, MODULE_REGISTRY, type BundleFacts } from '@ssdashboard/contracts';
import type { DatabaseConnection } from '@ssdashboard/db';
import { describe, expect, it, vi } from 'vitest';
import type { LicenseService } from '../license/license.service.js';
import { SettingsCache, type StoredSetting } from '../settings/settings-cache.js';
import type { SettingsService } from '../settings/settings.service.js';
import { CapabilityHooks } from './capability-hooks.js';
import { ModuleLimited, ModuleOff } from './module.errors.js';
import { ModuleRegistry } from './module-registry.js';
import { ModuleStateService, UnknownModuleKey } from './module-state.service.js';

const OPS = defineModule({
  key: 'ops',
  bundle: 'operations',
  toggle: true,
  requires: [],
  label: 'modules.platform.label',
  description: 'modules.platform.description',
  capabilities: [
    {
      key: 'ops.finish',
      bundle: 'operations',
      kind: 'write',
      windDown: 'until_closed',
      workOf: [],
      label: 'modules.capabilities.mailSend',
    },
    {
      key: 'ops.queue',
      bundle: 'operations',
      kind: 'write',
      windDown: 'none',
      workOf: [],
      label: 'modules.capabilities.mailSend',
    },
  ],
});

const TOGGLED_AT = '2027-05-01T09:00:00.000000Z';
const active: BundleFacts = { phase: 'active', lapsedAt: null, renewedAt: null };

function setup(options: { enabled?: boolean; openItems?: number | 'throws' } = {}) {
  const registry = new ModuleRegistry([...MODULE_REGISTRY, OPS]);
  const cache = new SettingsCache();
  const bundleFacts = vi.fn(() =>
    Promise.resolve({
      bundles: { warehouse: active, operations: active },
      notices: [],
    }),
  );
  const load = vi.fn((keys: readonly string[]) =>
    Promise.resolve(
      keys.map((key): StoredSetting => ({
        key,
        value: options.enabled ?? true,
        raw: options.enabled ?? true,
        hasRow: options.enabled !== undefined,
        invalid: false,
        updatedAt: options.enabled !== undefined ? TOGGLED_AT : null,
        updatedBy: null,
      })),
    ),
  );
  const hooks = new CapabilityHooks(registry);
  if (options.openItems !== undefined) {
    const count = options.openItems;
    hooks.register('ops.finish', {
      openItems: () =>
        count === 'throws' ? Promise.reject(new Error('count failed')) : Promise.resolve(count),
    });
  }
  const service = new ModuleStateService(
    registry,
    { db: {} } as unknown as DatabaseConnection,
    { load } as unknown as SettingsService,
    { moduleFacts: bundleFacts } as unknown as LicenseService,
    cache,
    hooks,
  );
  return { service, bundleFacts, load, cache };
}

// Spec 0009, AC-7, AC-13: the module state service.
describe('ModuleStateService', () => {
  it('answers an always on key without reading anything', async () => {
    const { service, bundleFacts, load } = setup();
    expect(await service.isOn('platform')).toBe(true);
    expect(await service.isRunnable('mail.send')).toBe(true);
    expect(bundleFacts).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it('keeps one snapshot until the settings cache drops', async () => {
    const { service, bundleFacts, cache } = setup();
    await service.stateOf('ops');
    await service.stateOf('ops.queue');
    expect(bundleFacts).toHaveBeenCalledOnce();
    cache.drop('module.ops.enabled');
    await service.stateOf('ops');
    expect(bundleFacts).toHaveBeenCalledTimes(2);
    await service.stateOf('ops', { fresh: true });
    expect(bundleFacts).toHaveBeenCalledTimes(3);
  });

  it('throws ModuleOff from assertOn and assertMayFinish when toggled off', async () => {
    const { service } = setup({ enabled: false });
    expect(await service.stateOf('ops.queue')).toEqual({
      state: 'read_only',
      reason: 'toggled_off',
      since: TOGGLED_AT,
    });
    await expect(service.assertOn('ops')).rejects.toBeInstanceOf(ModuleOff);
    await expect(
      service.assertMayFinish('ops.finish', '2027-04-01T00:00:00Z'),
    ).rejects.toBeInstanceOf(ModuleOff);
  });

  it('lets a limited capability finish older records and refuses newer ones (AC-28)', async () => {
    const { service } = setup({ enabled: false, openItems: 2 });
    expect(await service.stateOf('ops.finish')).toEqual({
      state: 'limited',
      before: TOGGLED_AT,
      reason: 'toggled_off',
    });
    expect(await service.isRunnable('ops.finish')).toBe(true);
    await expect(
      service.assertMayFinish('ops.finish', '2027-04-30T23:59:59Z'),
    ).resolves.toBeUndefined();
    await expect(service.assertMayFinish('ops.finish', TOGGLED_AT)).rejects.toBeInstanceOf(
      ModuleLimited,
    );
  });

  it('keeps finishing work open when its open items cannot be counted (AC-28)', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service } = setup({ enabled: false, openItems: 'throws' });
    expect(await service.stateOf('ops.finish')).toEqual({
      state: 'limited',
      before: TOGGLED_AT,
      reason: 'toggled_off',
    });
    expect(warn).toHaveBeenCalledWith('Open items of ops.finish could not be counted: Error');
    warn.mockRestore();
  });

  it('never makes a module limited, even while a finishing capability is (code 1)', async () => {
    const { service } = setup({ enabled: false, openItems: 2 });
    expect(await service.stateOf('ops')).toEqual({
      state: 'read_only',
      reason: 'toggled_off',
      since: TOGGLED_AT,
    });
  });

  it('shares one computation among callers at the same generation, notices included', async () => {
    const { service, bundleFacts } = setup();
    await Promise.all([service.states(), service.stateOf('ops'), service.notices()]);
    expect(bundleFacts).toHaveBeenCalledOnce();
    expect(await service.notices()).toEqual([]);
    expect(bundleFacts).toHaveBeenCalledOnce();
  });

  it('compares the record instant with before to the microsecond', async () => {
    const { service } = setup({ enabled: false, openItems: 1 });
    await expect(
      service.assertMayFinish('ops.finish', '2027-05-01T08:59:59.999999Z'),
    ).resolves.toBeUndefined();
    await expect(
      service.assertMayFinish('ops.finish', '2027-05-01T09:00:00.000000Z'),
    ).rejects.toBeInstanceOf(ModuleLimited);
  });

  it('refuses a key the registry does not list', async () => {
    const { service } = setup();
    await expect(service.stateOf('nowhere.thing')).rejects.toBeInstanceOf(UnknownModuleKey);
  });
});
