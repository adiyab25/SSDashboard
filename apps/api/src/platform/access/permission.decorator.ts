import type { Permission as PermissionName } from '@ssdashboard/contracts';

/** Metadata key under which a handler's or a controller's permission declarations are stored. */
export const PERMISSION_KEY = 'ssdashboard:permission';

/**
 * One permission declaration (spec 0008, AC-4): the permissions a route needs, all of them, or
 * "any person whose hats allow this audience".
 */
export type PermissionDeclaration =
  { kind: 'permissions'; permissions: readonly PermissionName[] } | { kind: 'any_hat' };

function declare(declaration: PermissionDeclaration): ClassDecorator & MethodDecorator {
  return (target: object, _key?: string | symbol, descriptor?: PropertyDescriptor) => {
    // A method declaration is stored on the handler function, a class one on the class.
    const holder: object = descriptor ? (descriptor.value as object) : target;
    const existing = declarationsOn(holder);
    Reflect.defineMetadata(PERMISSION_KEY, [...existing, declaration], holder);
  };
}

/**
 * Declares the permissions a route needs, all of them (spec 0008, AC-4 and Decision "all listed
 * permissions required"): `@Permission('settings.manage', 'cost.view')` needs both. On a handler
 * it replaces the class declaration. Use exactly one declaration per handler, `@Permission` or
 * `@AnyHat`; `permission.spec.ts` fails the build otherwise, and `PermissionGuard` answers 500
 * `PERMISSION_MISSING`. Never put it on a `portal`, `hook` or `public` controller.
 */
export const Permission = (...permissions: PermissionName[]): ClassDecorator & MethodDecorator =>
  declare({ kind: 'permissions', permissions });

/**
 * Declares a route open to any signed in person whose hats allow the controller's audience, the
 * "who am I" routes (`GET` and `PATCH /api/me`). It needs no permission, so use it only where
 * every person of the audience must reach the route.
 */
export const AnyHat = (): ClassDecorator & MethodDecorator => declare({ kind: 'any_hat' });

/** The declarations stored directly on one handler function or class, in the order applied. */
export function declarationsOn(holder: unknown): readonly PermissionDeclaration[] {
  if ((typeof holder !== 'function' && typeof holder !== 'object') || holder === null) return [];
  const found: unknown = Reflect.getOwnMetadata(PERMISSION_KEY, holder);
  return Array.isArray(found) ? (found as PermissionDeclaration[]) : [];
}

/**
 * The declarations that govern a handler: its own when it has any, else the class's (a handler
 * declaration replaces the class one). A route is well declared only when this holds exactly one.
 * Reads own metadata only, so a subclass never inherits a declaration.
 */
export function declarationsFor(
  handler: unknown,
  controller: unknown,
): readonly PermissionDeclaration[] {
  const own = declarationsOn(handler);
  return own.length > 0 ? own : declarationsOn(controller);
}
