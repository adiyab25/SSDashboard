import { SetMetadata } from '@nestjs/common';

/** Metadata key of a controller's or handler's module declaration. */
export const REQUIRES_KEY = 'ssdashboard:requires-module';

/**
 * One module declaration: the module every route of a controller belongs to, or the capability
 * it (or one handler) serves.
 */
export type ModuleDeclaration =
  | { readonly kind: 'module'; readonly key: string }
  | { readonly kind: 'capability'; readonly key: string };

function declare(declaration: ModuleDeclaration) {
  return (target: object, propertyKey?: string | symbol, descriptor?: PropertyDescriptor): void => {
    const on = descriptor ? (descriptor.value as object) : target;
    if (Reflect.hasOwnMetadata(REQUIRES_KEY, on)) {
      const name = descriptor ? String(propertyKey) : (target as { name?: string }).name;
      throw new Error(`${name ?? 'A controller'} declares its module more than once`);
    }
    SetMetadata(REQUIRES_KEY, declaration)(on as never);
  };
}

/**
 * Declares the module every route of a controller belongs to (spec 0009, AC-8). Put exactly one
 * of `@RequiresModule` or `@RequiresCapability` on the controller class; a second throws when the
 * class is defined, and `requires-module.spec.ts` fails the build for none or an unknown key. The
 * global `ModuleGate` answers 404 `MODULE_OFF` from it. Never on a handler: a handler may only
 * narrow with `@RequiresCapability` of the same module.
 *
 * @throws Error when the class already declares its module.
 */
export const RequiresModule = (moduleKey: string): ClassDecorator =>
  declare({ kind: 'module', key: moduleKey });

/**
 * Declares the capability a controller (class level), or one handler (narrowing its class's
 * module), serves (spec 0009, AC-8): a controller inside a core module that serves an Operations
 * or Warehouse capability declares that capability. The capability must belong to the class's
 * module (`requires-module.spec.ts`).
 *
 * @throws Error when the class or handler already declares one.
 */
export const RequiresCapability = (capabilityKey: string): ClassDecorator & MethodDecorator =>
  declare({ kind: 'capability', key: capabilityKey });

/** The declaration on a class or a handler itself (never inherited), or undefined. */
export function moduleDeclarationOf(target: unknown): ModuleDeclaration | undefined {
  if (typeof target !== 'function') return undefined;
  const declared: unknown = Reflect.getOwnMetadata(REQUIRES_KEY, target);
  if (!declared || typeof declared !== 'object') return undefined;
  const { kind, key } = declared as { kind?: unknown; key?: unknown };
  if ((kind === 'module' || kind === 'capability') && typeof key === 'string') {
    return { kind, key };
  }
  return undefined;
}

/** The declaration that governs a route: the handler's narrowing, else the class's. */
export function routeDeclarationOf(
  handler: unknown,
  controller: unknown,
): ModuleDeclaration | undefined {
  return moduleDeclarationOf(handler) ?? moduleDeclarationOf(controller);
}
