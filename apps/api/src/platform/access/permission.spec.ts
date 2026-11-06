import { Controller, Get, Post } from '@nestjs/common';
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Permission as PermissionName, PERMISSIONS } from '@ssdashboard/contracts';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module.js';
import { Audience, audienceOf } from '../audience/audience.decorator.js';
import { AnyHat, declarationsFor, declarationsOn, Permission } from './permission.decorator.js';

// Spec 0008, AC-4: fails the build when a staff or partner handler resolves to no permission
// declaration or to two, when a declared permission is not in the catalog or belongs to the other
// audience, or when a portal, hook or public controller declares any. It walks the controllers the
// way `audience.spec.ts` does: the Nest module graph under AppModule and every `*.controller.ts`.
const API_SRC = fileURLToPath(new URL('../..', import.meta.url));

/** A controller class. */
type ControllerClass = abstract new (...args: never[]) => object;

interface Found {
  name: string;
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

async function fromFiles(): Promise<Map<ControllerClass, Found>> {
  const found = new Map<ControllerClass, Found>();
  for (const path of controllerFiles(API_SRC)) {
    const file = relative(API_SRC, path);
    const exports = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(exports)) {
      if (isController(value)) found.set(value, { name: `${name} (${file})`, target: value });
    }
  }
  return found;
}

/** Walks `imports` from a module, following dynamic modules and forward references. */
function fromModuleGraph(root: unknown): ControllerClass[] {
  const seen = new Set<unknown>();
  const controllers = new Set<ControllerClass>();
  const visit = (entry: unknown): void => {
    let ref = entry;
    if (ref && typeof ref === 'object' && 'forwardRef' in ref) {
      ref = (ref as { forwardRef: () => unknown }).forwardRef();
    }
    const dynamic =
      ref && typeof ref === 'object' && 'module' in ref
        ? (ref as { module: unknown; imports?: unknown[]; controllers?: unknown[] })
        : undefined;
    const moduleClass = dynamic ? dynamic.module : ref;
    if (typeof moduleClass !== 'function') return;
    const key = dynamic ?? moduleClass;
    if (seen.has(key)) return;
    seen.add(key);
    const lists = [
      (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, moduleClass) ?? []) as unknown[],
      dynamic?.controllers ?? [],
    ].flat();
    for (const controller of lists) if (isController(controller)) controllers.add(controller);
    const imports = [
      (Reflect.getMetadata(MODULE_METADATA.IMPORTS, moduleClass) ?? []) as unknown[],
      dynamic?.imports ?? [],
    ].flat();
    for (const imported of imports) visit(imported);
  };
  visit(root);
  return [...controllers];
}

async function allControllers(): Promise<Found[]> {
  const files = await fromFiles();
  const missing = fromModuleGraph(AppModule)
    .filter((controller) => !files.has(controller))
    .map((controller) => controller.name);
  expect(missing, `registered controllers in no *.controller.ts: ${missing.join(', ')}`).toEqual(
    [],
  );
  return [...files.values()];
}

/** The route handlers a controller class defines itself: methods Nest maps to an HTTP method. */
function handlersOf(target: ControllerClass): Array<{ method: string; handler: object }> {
  const prototype = target.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(prototype)
    .filter((method) => method !== 'constructor')
    .map((method) => ({ method, handler: prototype[method] }))
    .filter(
      (entry): entry is { method: string; handler: object } =>
        typeof entry.handler === 'function' && Reflect.hasMetadata(METHOD_METADATA, entry.handler),
    );
}

/** Every AC-4 problem of one controller, in plain words naming the handler. */
function permissionProblems({ name, target }: Found): string[] {
  const audience = audienceOf(target);
  const handlers = handlersOf(target);
  const problems: string[] = [];

  if (audience !== 'staff' && audience !== 'partner') {
    if (declarationsOn(target).length > 0) {
      problems.push(`${name}: a ${String(audience)} controller declares a permission`);
    }
    for (const { method, handler } of handlers) {
      if (declarationsOn(handler).length > 0) {
        problems.push(`${name}.${method}: a ${String(audience)} controller declares a permission`);
      }
    }
    return problems;
  }

  for (const { method, handler } of handlers) {
    const where = `${name}.${method}`;
    const declarations = declarationsFor(handler, target);
    if (declarations.length === 0) problems.push(`${where}: no permission declaration`);
    if (declarations.length > 1) {
      problems.push(`${where}: ${declarations.length} permission declarations, needs exactly one`);
    }
    for (const declaration of declarations) {
      if (declaration.kind !== 'permissions') continue;
      if (declaration.permissions.length === 0) problems.push(`${where}: an empty @Permission()`);
      for (const permission of declaration.permissions) {
        const known = PermissionName.safeParse(permission);
        if (!known.success) {
          problems.push(`${where}: "${permission}" is not in the permission catalog`);
        } else if (PERMISSIONS[known.data].audience !== audience) {
          problems.push(`${where}: "${permission}" belongs to the other audience`);
        }
      }
    }
  }
  return problems;
}

// Planted controllers: never registered in AppModule, and never in a `*.controller.ts` file.
@Audience('staff')
@Controller('planted-missing')
class MissingDeclaration {
  @Get()
  read(): string {
    return 'open';
  }
}

@Audience('staff')
@Controller('planted-two')
class TwoDeclarations {
  @Permission('stock.view')
  @AnyHat()
  @Get()
  read(): string {
    return 'two';
  }
}

@Audience('staff')
@Controller('planted-unknown')
class UnknownPermission {
  @Permission('stock.everything' as PermissionName)
  @Get()
  read(): string {
    return 'unknown';
  }
}

@Audience('staff')
@Controller('planted-other-audience')
class OtherAudience {
  @Permission('partner.view_own')
  @Get()
  read(): string {
    return 'partner only';
  }
}

@Audience('partner')
@Controller('partner/planted')
class PartnerWithStaffPermission {
  @Permission('stock.view')
  @Get()
  read(): string {
    return 'staff only';
  }
}

@Audience('public')
@Controller('planted-public')
class PublicWithPermission {
  @Permission('stock.view')
  @Get()
  read(): string {
    return 'public';
  }
}

@Audience('hook')
@Permission('stock.receive')
@Controller('hooks/planted')
class HookWithClassPermission {
  @Post()
  receive(): string {
    return 'hook';
  }
}

@Audience('portal')
@Controller('portal/planted')
class PortalWithAnyHat {
  @AnyHat()
  @Get()
  read(): string {
    return 'portal';
  }
}

@Audience('staff')
@Permission('stock.view')
@Controller('planted-good')
class ClassDeclarationWithOverride {
  @Get()
  read(): string {
    return 'class';
  }

  @Permission('stock.correct', 'cost.view')
  @Post()
  write(): string {
    return 'handler';
  }
}

const planted = (target: ControllerClass): Found => ({ name: target.name, target });

describe('route permissions (spec 0008, AC-4)', () => {
  it('finds the controllers from the module graph and the files', async () => {
    expect((await allControllers()).length).toBeGreaterThan(0);
  });

  it('gives every staff and partner handler exactly one valid declaration, and none elsewhere', async () => {
    const problems = (await allControllers()).flatMap(permissionProblems);

    expect(problems, problems.join('\n')).toEqual([]);
  });

  describe('fails a planted controller', () => {
    it.each([
      [MissingDeclaration, 'MissingDeclaration.read: no permission declaration'],
      [TwoDeclarations, 'TwoDeclarations.read: 2 permission declarations, needs exactly one'],
      [
        UnknownPermission,
        'UnknownPermission.read: "stock.everything" is not in the permission catalog',
      ],
      [OtherAudience, 'OtherAudience.read: "partner.view_own" belongs to the other audience'],
      [
        PartnerWithStaffPermission,
        'PartnerWithStaffPermission.read: "stock.view" belongs to the other audience',
      ],
      [
        PublicWithPermission,
        'PublicWithPermission.read: a public controller declares a permission',
      ],
      [HookWithClassPermission, 'HookWithClassPermission: a hook controller declares a permission'],
      [PortalWithAnyHat, 'PortalWithAnyHat.read: a portal controller declares a permission'],
    ] as const)('%o', (target, problem) => {
      expect(permissionProblems(planted(target))).toEqual([problem]);
    });
  });

  it('accepts a class declaration that a handler replaces with its own', () => {
    expect(permissionProblems(planted(ClassDeclarationWithOverride))).toEqual([]);
    const handler = (name: string): unknown =>
      Object.getOwnPropertyDescriptor(ClassDeclarationWithOverride.prototype, name)?.value;
    expect(declarationsFor(handler('write'), ClassDeclarationWithOverride)).toEqual([
      { kind: 'permissions', permissions: ['stock.correct', 'cost.view'] },
    ]);
    expect(declarationsFor(handler('read'), ClassDeclarationWithOverride)).toEqual([
      { kind: 'permissions', permissions: ['stock.view'] },
    ]);
  });
});
