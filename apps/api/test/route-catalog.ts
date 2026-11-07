import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  declarationsFor,
  type PermissionDeclaration,
} from '../src/platform/access/permission.decorator.js';
import { audienceOf, type AudienceName } from '../src/platform/audience/audience.decorator.js';

/** A controller class. */
export type ControllerClass = abstract new (...args: never[]) => object;

/** One route as the Nest metadata declares it. */
export interface RouteEntry {
  /** The controller class that serves it. */
  controller: ControllerClass;
  /** The handler's method name on the controller. */
  handlerName: string;
  /** The handler function, which carries the handler metadata. */
  handler: object;
  /** `GET`, `POST`, `PUT`, `PATCH`, `DELETE` and so on. */
  method: string;
  /** The path under the global `/api` prefix, with its `:params`, for example `/staff/:id`. */
  path: string;
  /** The controller's `@Audience`, or `undefined` when it has none. */
  audience: AudienceName | undefined;
  /** The permission declarations that govern the handler (its own, else the class's). */
  declarations: readonly PermissionDeclaration[];
}

function isController(value: unknown): value is ControllerClass {
  return typeof value === 'function' && Reflect.hasMetadata(PATH_METADATA, value);
}

/**
 * Every controller registered under a root module, walking `imports` (dynamic modules and forward
 * references included) the way Nest builds its module graph. Reads metadata only: no module is
 * instantiated and no database is touched.
 */
export function controllersOf(root: unknown): ControllerClass[] {
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

const pathsOf = (holder: object): string[] => {
  const raw: unknown = Reflect.getMetadata(PATH_METADATA, holder);
  return (Array.isArray(raw) ? raw : [raw]).map((value) => String(value ?? ''));
};

const joinPath = (...parts: string[]): string => {
  const joined = `/${parts.join('/')}`.replace(/\/+/g, '/').replace(/\/$/, '');
  return joined === '' ? '/' : joined;
};

/**
 * Every route of one controller: each handler on its prototype chain that carries an HTTP method
 * (an override replaces the method it shadows), once per controller path and handler path.
 */
export function routesOf(controller: ControllerClass): RouteEntry[] {
  const prototype = controller.prototype as Record<string, unknown>;
  const names = new Set<string>();
  for (
    let level: object | null = prototype;
    level !== null && level !== Object.prototype;
    level = Object.getPrototypeOf(level) as object | null
  ) {
    for (const name of Object.getOwnPropertyNames(level)) names.add(name);
  }
  const audience = audienceOf(controller);
  return [...names]
    .filter((name) => name !== 'constructor')
    .flatMap((handlerName) => {
      const handler = prototype[handlerName];
      if (typeof handler !== 'function' || !Reflect.hasMetadata(METHOD_METADATA, handler)) {
        return [];
      }
      const method =
        RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod] ?? 'UNKNOWN';
      const declarations = declarationsFor(handler, controller);
      return pathsOf(controller).flatMap((base) =>
        pathsOf(handler).map((own) => ({
          controller,
          handlerName,
          handler,
          method,
          path: joinPath(base, own),
          audience,
          declarations,
        })),
      );
    });
}

/** Every route served under a root module (see {@link controllersOf} and {@link routesOf}). */
export function routeCatalog(root: unknown): RouteEntry[] {
  return controllersOf(root).flatMap(routesOf);
}
