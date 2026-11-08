import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODULE_REGISTRY,
  moduleRegistryIssues,
  SETTING_DEFINITIONS,
  type SettingDefinition,
} from '@ssdashboard/contracts';
import { afterAll, describe, expect, it } from 'vitest';

// Spec 0009, AC-6: a registry module is a folder `src/<key>/` holding `<key>.module.ts`, and every
// such folder (other than the infrastructure folders) has a registry row. A row lands with its
// code, never before.
const API_SRC = fileURLToPath(new URL('../..', import.meta.url));
/** Folders that hold a Nest module but are infrastructure, not business modules. */
const INFRASTRUCTURE = new Set(['config', 'database']);

/** Every folder of `root` that holds `<folder>.module.ts`. */
function moduleFolders(root: string): string[] {
  return readdirSync(root).filter(
    (name) =>
      statSync(join(root, name)).isDirectory() && existsSync(join(root, name, `${name}.module.ts`)),
  );
}

/** The registry module keys that have no folder `root/<key>/` holding `<key>.module.ts`. */
function modulesWithoutFolder(root: string, keys: readonly string[]): string[] {
  return keys.filter((key) => !existsSync(join(root, key, `${key}.module.ts`)));
}

/** The module folders of `root`, infrastructure aside, that have no registry row. */
function foldersWithoutRow(root: string, keys: readonly string[]): string[] {
  const listed = new Set(keys);
  return moduleFolders(root).filter((name) => !INFRASTRUCTURE.has(name) && !listed.has(name));
}

const REGISTRY_KEYS = MODULE_REGISTRY.map((m) => m.key);

describe('the module registry against the module folders (AC-6)', () => {
  it('has a folder holding <key>.module.ts for every registry module', () => {
    expect(modulesWithoutFolder(API_SRC, REGISTRY_KEYS)).toEqual([]);
  });

  it('has a registry row for every module folder but the infrastructure ones', () => {
    expect(foldersWithoutRow(API_SRC, REGISTRY_KEYS)).toEqual([]);
  });

  it('keeps every rule of AC-6 with the settings registry it names steps from', () => {
    const settings = (SETTING_DEFINITIONS as readonly SettingDefinition[]).map(
      ({ key, kind, bundle }) => ({ key, kind, bundle }),
    );
    expect(moduleRegistryIssues(MODULE_REGISTRY, settings)).toEqual([]);
  });
});

// The same two checks on a fixture source tree, so a broken registry is proven to fail them
// (verify run 2026-11-08, finding 4: only the real registry was checked, never a broken one).
describe('the folder checks on a fixture source tree (AC-6)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ssd-module-folders-'));
  const addFolder = (name: string, withModuleFile: boolean) => {
    mkdirSync(join(root, name));
    if (withModuleFile) writeFileSync(join(root, name, `${name}.module.ts`), '');
  };
  addFolder('platform', true);
  addFolder('config', true);
  addFolder('stray', true);
  addFolder('halfbuilt', false);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('names a registry module that has no folder', () => {
    expect(modulesWithoutFolder(root, ['platform', 'nowhere'])).toEqual(['nowhere']);
  });

  it('names a registry module whose folder lacks <key>.module.ts', () => {
    expect(modulesWithoutFolder(root, ['platform', 'halfbuilt'])).toEqual(['halfbuilt']);
  });

  it('names a module folder with no registry row, and never an infrastructure folder', () => {
    expect(foldersWithoutRow(root, ['platform'])).toEqual(['stray']);
  });

  it('finds nothing once every module has its folder and every folder its row', () => {
    expect(modulesWithoutFolder(root, ['platform', 'stray'])).toEqual([]);
    expect(foldersWithoutRow(root, ['platform', 'stray'])).toEqual([]);
  });
});
