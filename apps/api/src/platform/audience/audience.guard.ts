import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { audienceOf, type AudienceName } from './audience.decorator.js';

/** What the earlier guards have put on the request about who is calling. */
interface IdentifiedRequest {
  /** A staff session, set by identity's `SessionGuard` on `staff` routes only. */
  staff?: unknown;
  /** A partner user's session, set by identity's `SessionGuard` on `partner` routes only. */
  partner?: unknown;
  /** A verified hook delivery's proof, set only by the connectors hook verifier (`mountHooks`). */
  hook?: unknown;
  // A later wave adds `portal` (a sealed token) here, and one line in `callerAudience`.
}

/**
 * The audience the caller proved, or `undefined` when none: a staff session (`request.staff`) or
 * a partner user's session (`request.partner`), each put there only by identity's audience aware
 * `SessionGuard` (spec 0005, AC-29), which sets one or the other, never both.
 *
 * A hook caller proves itself by signature: the connectors hook verifier (spec 0015 AC-4, run by
 * `mountHooks` before any guard) sets `request.hook` only for a verified delivery. Portal callers
 * prove nothing yet, so their routes are denied; when a portal sealed token lands, its own check
 * sets its own request property and returns its audience here. Never reach for `@Public()` to get around it.
 */
function callerAudience(request: IdentifiedRequest): AudienceName | undefined {
  if (request.staff) return 'staff';
  if (request.partner) return 'partner';
  if (request.hook) return 'hook';
  return undefined;
}

/**
 * Deny by default (spec 0007, section 2). Runs after the session guard, which has put the
 * caller's identity on the request. A controller without a valid audience answers 500
 * `AUDIENCE_MISSING` (our bug, not the caller's, and the build test should have caught it);
 * a caller whose audience differs from the route's answers 403 `WRONG_AUDIENCE`; a `public`
 * route is open to all.
 *
 * `SessionGuard` runs first. On `staff` and `partner` routes it demands a live session of that
 * audience, so an anonymous call there is a 401 from it, not from here. On `portal` and `hook`
 * routes it no longer reads anything and lets every request through: a hook route passes here
 * only with the verifier's `request.hook` (an unverified hook call never gets this far: the
 * verifier answers 401 first), and a portal route, until it gets its own proof (a sealed token),
 * is blocked only here. Never let a portal or hook route "just pass" here.
 *
 * It must never infer an audience from the URL, never let a route without one through, and
 * never say in its answer what the correct audience would be.
 */
@Injectable()
export class AudienceGuard implements CanActivate {
  /**
   * Throws 500 `AUDIENCE_MISSING` for a controller with no audience, lets a public one through,
   * and otherwise throws 403 `WRONG_AUDIENCE` unless the caller's audience matches.
   */
  canActivate(context: ExecutionContext): boolean {
    const audience = audienceOf(context.getClass());
    if (!audience) {
      throw new InternalServerErrorException({
        code: 'AUDIENCE_MISSING',
        message: 'This route has no audience.',
      });
    }
    if (audience === 'public') return true;

    const request = context.switchToHttp().getRequest<IdentifiedRequest>();
    if (callerAudience(request) !== audience) {
      throw new ForbiddenException({ code: 'WRONG_AUDIENCE', message: 'Not allowed here.' });
    }
    return true;
  }
}
