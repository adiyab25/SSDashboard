/** Metadata key that marks a "who am I" handler. */
export const WHO_AM_I_KEY = 'ssdashboard:who-am-i';

/**
 * Marks the one "who am I" handler of an audience, `GET /api/me` for staff and
 * `GET /api/partner/me` for partner users: the only route a person with a temporary password may
 * call (spec 0005, AC-14). `SessionGuard` reads this mark on the handler that will run, never the
 * URL, so a route registered with a matching path elsewhere can never let a temporary password
 * through (security review L3 of spec 0005 milestone 3).
 *
 * Put it on a `GET` handler that answers only the caller's own `MeResponse`, and nowhere else:
 * `who-am-i.spec.ts` fails for any other handler.
 */
export const WhoAmI = (): MethodDecorator => (_target, _key, descriptor) => {
  Reflect.defineMetadata(WHO_AM_I_KEY, true, descriptor.value as object);
};

/** Whether this handler function carries `@WhoAmI()` itself (never inherited from elsewhere). */
export function isWhoAmI(handler: unknown): boolean {
  if (typeof handler !== 'function') return false;
  return Reflect.getOwnMetadata(WHO_AM_I_KEY, handler) === true;
}
