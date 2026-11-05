import { SetMetadata } from '@nestjs/common';

/** Metadata key under which a controller's audience is stored. */
export const AUDIENCE_KEY = 'ssdashboard:audience';

/**
 * Every kind of caller the api serves (spec 0007, section 2). The path prefix follows the
 * audience: `staff` is `/api/*`, `partner` is `/api/partner/*`, `portal` is `/api/portal/*`,
 * `hook` is `/api/hooks/*`, `public` is `/api/health` and `/api/config`.
 */
export const AUDIENCES = ['staff', 'partner', 'portal', 'hook', 'public'] as const;

/** One of {@link AUDIENCES}. */
export type AudienceName = (typeof AUDIENCES)[number];

/**
 * Declares who may call every route of a controller. Put it on the controller class, exactly
 * once: a second `@Audience` on the same class throws when the class is defined, and
 * `audience.spec.ts` fails the build for a controller with none or with a bad value.
 * `@Audience('public')` is what makes the session guard let a route through, so the audience is
 * the one source of truth for "needs no session" (`@Public()` must agree, and the spec checks it).
 *
 * Never use it on a handler to widen a controller: only the class is read, and the spec fails
 * if a handler carries one, so one controller never serves two kinds of caller.
 *
 * @throws Error when the class already has its own audience.
 */
export const Audience =
  (audience: AudienceName): ClassDecorator =>
  (target) => {
    if (Reflect.hasOwnMetadata(AUDIENCE_KEY, target)) {
      throw new Error(`${target.name} declares more than one @Audience`);
    }
    SetMetadata(AUDIENCE_KEY, audience)(target);
  };

/**
 * The audience a class declares itself, or `undefined` when it has none or the value is not a
 * known audience. Reads the class's own metadata only, so a subclass of a public controller never
 * inherits `'public'`. It must never look at methods or at the URL.
 */
export function audienceOf(target: unknown): AudienceName | undefined {
  if (typeof target !== 'function') return undefined;
  const declared: unknown = Reflect.getOwnMetadata(AUDIENCE_KEY, target);
  return AUDIENCES.find((candidate) => candidate === declared);
}
