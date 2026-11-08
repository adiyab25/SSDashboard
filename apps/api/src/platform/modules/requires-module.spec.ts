import { MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module.js';
import { defineModule, MODULE_REGISTRY } from '@ssdashboard/contracts';
import { ModuleRegistry } from './module-registry.js';
import {
  moduleDeclarationOf,
  RequiresCapability,
  RequiresModule,
  REQUIRES_KEY,
  type ModuleDeclaration,
} from './requires-module.decorator.js';

// Fails the build when a controller lacks exactly one valid module declaration (spec 0009, AC-8),
// the same shape as `audience.spec.ts`: controllers come from every `*.controller.ts` file and
// from the Nest module graph under AppModule, which must agree.
const API_SRC = fileURLToPath(new URL('../..', import.meta.url));
const REGISTRY = new ModuleRegistry();

/** A controller class. */
type ControllerClass = abstract new (...args: never[]) => object;

interface Found {
  name: string;
  /** The path under `src/`, whose first folder is the module the controller lives in. */
  where: string;
  target: ControllerClass;
}

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'dist') return [];
    if (statSync(path).isDirectory()) return controllerFiles(path);
    return name.endsWith('.controller.ts') ? [path] : [];
  });
}

function isController(value: unknown): value is ControllerClass {
  return typeof value === 'function' && Reflect.hasMetadata(PATH_METADATA, value);
}

async function fromFiles(): Promise<Found[]> {
  const found: Found[] = [];
  for (const path of controllerFiles(API_SRC)) {
    const where = relative(API_SRC, path).split(sep).join('/');
    const exports = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(exports)) {
      if (isController(value)) found.push({ name, where, target: value });
    }
  }
  return found;
}

/** Every controller registered under a module, following imports and dynamic modules. */
function fromModuleGraph(root: unknown): Set<unknown> {
  const seen = new Set<unknown>();
  const controllers = new Set<unknown>();
  const visit = (entry: unknown): void => {
    const dynamic =
      entry && typeof entry === 'object' && 'module' in entry
        ? (entry as { module: unknown; imports?: unknown[]; controllers?: unknown[] })
        : undefined;
    const moduleClass = dynamic ? dynamic.module : entry;
    if (typeof moduleClass !== 'function' || seen.has(dynamic ?? moduleClass)) return;
    seen.add(dynamic ?? moduleClass);
    for (const controller of [
      ...((Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, moduleClass) ?? []) as unknown[]),
      ...(dynamic?.controllers ?? []),
    ]) {
      controllers.add(controller);
    }
    for (const imported of [
      ...((Reflect.getMetadata(MODULE_METADATA.IMPORTS, moduleClass) ?? []) as unknown[]),
      ...(dynamic?.imports ?? []),
    ]) {
      visit(imported);
    }
  };
  visit(root);
  return controllers;
}

/** The module a declaration belongs to, or undefined when the registry does not list its key. */
function moduleOf(
  declaration: ModuleDeclaration,
  registry: ModuleRegistry = REGISTRY,
): string | undefined {
  return declaration.kind === 'module'
    ? registry.module(declaration.key)?.key
    : registry.capability(declaration.key)?.module.key;
}

/** Every handler of a controller with its own declaration. */
function handlerDeclarations(target: ControllerClass): [string, ModuleDeclaration][] {
  const prototype = target.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(prototype).flatMap((method) => {
    const declaration =
      method === 'constructor' ? undefined : moduleDeclarationOf(prototype[method]);
    return declaration ? [[method, declaration] as [string, ModuleDeclaration]] : [];
  });
}

/** Every rule of AC-8 a controller breaks, as plain sentences. */
function problemsOf({ name, where, target }: Found, registry: ModuleRegistry = REGISTRY): string[] {
  const label = `${name} (${where})`;
  const declaration = moduleDeclarationOf(target);
  if (!declaration) return [`${label} has no @RequiresModule or @RequiresCapability`];
  const module = moduleOf(declaration, registry);
  if (!module)
    return [`${label} names ${declaration.key}, which the module registry does not list`];
  const problems: string[] = [];
  const folder = where.split('/')[0];
  if (module !== folder) {
    problems.push(`${label} names ${declaration.key} of module ${module}, but lives in ${folder}`);
  }
  for (const [method, narrowing] of handlerDeclarations(target)) {
    if (narrowing.kind !== 'capability') {
      problems.push(
        `${name}.${method} declares a module; a handler may only narrow to a capability`,
      );
    } else if (moduleOf(narrowing, registry) !== module) {
      problems.push(`${name}.${method} narrows to ${narrowing.key}, not a capability of ${module}`);
    } else if (
      !registry.alwaysOn(declaration.key) &&
      (registry.alwaysOn(narrowing.key) ||
        registry.capability(narrowing.key)?.capability.bundle === 'core')
    ) {
      // A handler narrowing replaces the class's declaration, so a core capability inside a
      // licensed or toggleable class would keep that handler open while the class is off
      // (security review m3, finding 3).
      problems.push(
        `${name}.${method} narrows to ${narrowing.key}, a core capability inside a class that is not always on`,
      );
    } else if (
      !registry.alwaysOn(declaration.key) &&
      registry.capability(narrowing.key)?.capability.bundle !== bundleOf(declaration, registry)
    ) {
      // An Operations class with a Warehouse handler would keep that handler open on a lapse or
      // a toggle of the class's own plan (security re-review m3, R3).
      problems.push(
        `${name}.${method} narrows to ${narrowing.key}, a capability of another bundle than its class`,
      );
    }
  }
  return problems;
}

/** The bundle a declaration answers to: its capability's, or its module's. */
function bundleOf(declaration: ModuleDeclaration, registry: ModuleRegistry): string | undefined {
  return declaration.kind === 'capability'
    ? registry.capability(declaration.key)?.capability.bundle
    : registry.module(declaration.key)?.bundle;
}

describe('controller module declarations (AC-8)', () => {
  it('finds the controllers from the files and the module graph alike', async () => {
    const files = await fromFiles();
    const registered = fromModuleGraph(AppModule);
    expect(files.length).toBeGreaterThan(0);
    const unregistered = [...registered].filter(
      (controller) => isController(controller) && !files.some((f) => f.target === controller),
    );
    expect(unregistered).toEqual([]);
  });

  it('gives every controller exactly one known declaration of its own module', async () => {
    const problems = (await fromFiles()).flatMap((found) => problemsOf(found));
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('refuses a second declaration on one class when it is defined', () => {
    expect(() => {
      @RequiresModule('platform')
      @RequiresCapability('platform.license_check')
      class Twice {}
      return Twice;
    }).toThrow(/more than once/);
  });

  it('finds each rule broken by a hand made controller', () => {
    class Bare {}
    @RequiresModule('nowhere')
    class Unknown {}
    @RequiresCapability('mail.send')
    class Elsewhere {}
    class Narrowing {
      handle(): void {}
    }
    Reflect.defineMetadata(REQUIRES_KEY, { kind: 'module', key: 'platform' }, Narrowing);
    RequiresCapability('mail.send')(
      Narrowing.prototype,
      'handle',
      Object.getOwnPropertyDescriptor(Narrowing.prototype, 'handle') as PropertyDescriptor,
    );
    const at = (target: unknown, name: string): Found => ({
      name,
      where: 'platform/x.controller.ts',
      target: target as ControllerClass,
    });

    expect(problemsOf(at(Bare, 'Bare'))).toEqual([
      'Bare (platform/x.controller.ts) has no @RequiresModule or @RequiresCapability',
    ]);
    expect(problemsOf(at(Unknown, 'Unknown'))).toEqual([
      'Unknown (platform/x.controller.ts) names nowhere, which the module registry does not list',
    ]);
    expect(problemsOf(at(Elsewhere, 'Elsewhere'))).toEqual([
      'Elsewhere (platform/x.controller.ts) names mail.send of module mail, but lives in platform',
    ]);
    expect(problemsOf(at(Narrowing, 'Narrowing'))).toEqual([
      'Narrowing.handle narrows to mail.send, not a capability of platform',
    ]);
  });

  it('refuses a handler that narrows to a core capability inside a class that is not always on', () => {
    const registry = new ModuleRegistry([
      ...MODULE_REGISTRY,
      defineModule({
        key: 'extra',
        bundle: 'operations',
        toggle: true,
        requires: [],
        label: 'modules.platform.label',
        description: 'modules.platform.description',
        capabilities: [
          {
            key: 'extra.core_part',
            bundle: 'core',
            kind: 'read',
            windDown: 'none',
            workOf: [],
            label: 'modules.capabilities.mailSend',
          },
          {
            key: 'extra.finish',
            bundle: 'operations',
            kind: 'write',
            windDown: 'until_closed',
            workOf: [],
            label: 'modules.capabilities.mailSend',
          },
          {
            key: 'extra.stock',
            bundle: 'warehouse',
            kind: 'write',
            windDown: 'none',
            workOf: [],
            label: 'modules.capabilities.mailSend',
          },
        ],
      }),
    ]);
    class Widening {
      core(): void {}
      finish(): void {}
      stock(): void {}
    }
    Reflect.defineMetadata(REQUIRES_KEY, { kind: 'module', key: 'extra' }, Widening);
    for (const [method, capability] of [
      ['core', 'extra.core_part'],
      ['finish', 'extra.finish'],
      ['stock', 'extra.stock'],
    ] as const) {
      RequiresCapability(capability)(
        Widening.prototype,
        method,
        Object.getOwnPropertyDescriptor(Widening.prototype, method) as PropertyDescriptor,
      );
    }
    const found: Found = {
      name: 'Widening',
      where: 'extra/widening.controller.ts',
      target: Widening,
    };

    expect(problemsOf(found, registry)).toEqual([
      'Widening.core narrows to extra.core_part, a core capability inside a class that is not always on',
      'Widening.stock narrows to extra.stock, a capability of another bundle than its class',
    ]);
  });
});
