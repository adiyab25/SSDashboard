import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODULE_REGISTRY,
  moduleRegistryIssues,
  SETTING_DEFINITIONS,
  type SettingDefinition,
} from '@ssdashboard/contracts';
import { describe, expect, it } from 'vitest';

// Spec 0009, AC-6: a registry module is a folder `src/<key>/` holding `<key>.module.ts`, and every
// such folder (other than the infrastructure folders) has a registry row. A row lands with its
// code, never before.
const API_SRC = fileURLToPath(new URL('../..', import.meta.url));
/** Folders that hold a Nest module but are infrastructure, not business modules. */
const INFRASTRUCTURE = new Set(['config', 'database']);

/** Every folder of `src/` that holds `<folder>.module.ts`. */
function moduleFolders(): string[] {
  return readdirSync(API_SRC).filter(
    (name) =>
      statSync(join(API_SRC, name)).isDirectory() &&
      existsSync(join(API_SRC, name, `${name}.module.ts`)),
  );
}

describe('the module registry against the module folders (AC-6)', () => {
  it('has a folder holding <key>.module.ts for every registry module', () => {
    const missing = MODULE_REGISTRY.map((m) => m.key).filter(
      (key) => !existsSync(join(API_SRC, key, `${key}.module.ts`)),
    );
    expect(missing).toEqual([]);
  });

  it('has a registry row for every module folder but the infrastructure ones', () => {
    const keys = new Set(MODULE_REGISTRY.map((m) => m.key));
    const unlisted = moduleFolders().filter((name) => !INFRASTRUCTURE.has(name) && !keys.has(name));
    expect(unlisted).toEqual([]);
  });

  it('keeps every rule of AC-6 with the settings registry it names steps from', () => {
    const settings = (SETTING_DEFINITIONS as readonly SettingDefinition[]).map(
      ({ key, kind, bundle }) => ({ key, kind, bundle }),
    );
    expect(moduleRegistryIssues(MODULE_REGISTRY, settings)).toEqual([]);
  });
});
