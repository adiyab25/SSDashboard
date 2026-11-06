import { MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module.js';
import { IS_PUBLIC } from '../../identity/sign-in/public.decorator.js';
import { AUDIENCE_KEY, audienceOf, type AudienceName } from './audience.decorator.js';

// Fails the build when a controller lacks exactly one valid audience (spec 0007, section 2).
// Controllers come from two directions that cross-check each other: the Nest module graph under
// AppModule (what really serves requests) and every `*.controller.ts` file (so a controller that
// someone forgot to register, or a file that exports none, is noticed too).
const API_SRC = fileURLToPath(new URL('../..', import.meta.url));

/** The first path segments reserved for a non staff audience. */
const PREFIX: Partial<Record<AudienceName, string>> = {
  partner: 'partner',
  portal: 'portal',
  hook: 'hooks',
};

/** A controller class. */
type ControllerClass = abstract new (...args: never[]) => object;

interface Found {
  name: string;
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

async function fromFiles(): Promise<Map<ControllerClass, Found>> {
  const found = new Map<ControllerClass, Found>();
  for (const path of controllerFiles(API_SRC)) {
    const file = relative(API_SRC, path);
    const exports = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
    const here = Object.entries(exports).filter(([, value]) => isController(value));
    expect(here.length, `${file} exports no controller`).toBeGreaterThan(0);
    for (const [name, value] of here) {
      found.set(value as ControllerClass, { name, where: file, target: value as ControllerClass });
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
    // A dynamic module is `{ module, imports?, controllers? }`; its own lists add to the class's.
    const dynamic =
      ref && typeof ref === 'object' && 'module' in ref ? (ref as DynamicLike) : undefined;
    const moduleClass = dynamic ? dynamic.module : ref;
    if (typeof moduleClass !== 'function') return; // a Promise of a module cannot be walked here
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

interface DynamicLike {
  module: unknown;
  imports?: unknown[];
  controllers?: unknown[];
}

async function allControllers(): Promise<Found[]> {
  const files = await fromFiles();
  const registered = fromModuleGraph(AppModule);
  const missing = registered.filter((controller) => !files.has(controller)).map((c) => c.name);
  expect(
    missing,
    `registered controllers not found in any *.controller.ts: ${missing.join(', ')}`,
  ).toEqual([]);
  return [...files.values()];
}

const label = ({ name, where }: Found) => `${name} (${where})`;

describe('controller audiences', () => {
  it('finds the controllers from the module graph and the files', async () => {
    expect(fromModuleGraph(AppModule).length).toBeGreaterThan(0);
    expect((await allControllers()).length).toBeGreaterThan(0);
  });

  it('gives every controller exactly one valid audience', async () => {
    const bad = (await allControllers()).filter(({ target }) => !audienceOf(target)).map(label);

    expect(bad, `controllers without a valid @Audience(...): ${bad.join(', ')}`).toEqual([]);
  });

  it('agrees with @Public(): public audience if and only if public', async () => {
    const disagree = (await allControllers())
      .filter(({ target }) => {
        const isPublic = Reflect.getOwnMetadata(IS_PUBLIC, target) === true;
        return isPublic !== (audienceOf(target) === 'public');
      })
      .map(label);

    expect(disagree, `@Public() and @Audience disagree: ${disagree.join(', ')}`).toEqual([]);
  });

  it('puts @Public() and @Audience on the class, never on a handler', async () => {
    const onHandler: string[] = [];
    for (const found of await allControllers()) {
      const prototype = found.target.prototype as Record<string, unknown>;
      for (const method of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[method];
        if (method === 'constructor' || typeof handler !== 'function') continue;
        if (Reflect.hasMetadata(IS_PUBLIC, handler) || Reflect.hasMetadata(AUDIENCE_KEY, handler)) {
          onHandler.push(`${found.name}.${method}`);
        }
      }
    }

    expect(
      onHandler,
      `handlers with their own audience or @Public(): ${onHandler.join(', ')}`,
    ).toEqual([]);
  });

  it('matches the path prefix to the audience', async () => {
    const wrong: string[] = [];
    const reserved = Object.values(PREFIX);
    for (const found of await allControllers()) {
      const audience = audienceOf(found.target);
      const raw: unknown = Reflect.getMetadata(PATH_METADATA, found.target);
      const paths = (Array.isArray(raw) ? raw : [raw]).map((p) =>
        String(p ?? '').replace(/^\/+/, ''),
      );
      for (const path of paths) {
        const first = path.split('/')[0] ?? '';
        const expected = audience ? PREFIX[audience] : undefined;
        const ok = expected ? first === expected : !reserved.includes(first);
        if (!ok) wrong.push(`${label(found)} audience ${String(audience)} path "${path}"`);
      }
    }

    expect(wrong, `audience and path prefix disagree: ${wrong.join('; ')}`).toEqual([]);
  });
});
