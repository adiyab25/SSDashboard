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
  staff?: unknown;
  // Later waves add `partner` (a partner hat bound to one partner account) and `portal`
  // (a sealed token) here, and one line each in `callerAudience`.
}

/**
 * The audience the caller proved, or `undefined` when none. Today only a staff session exists.
 *
 * Adding partner or portal identities is not only a line here: `SessionGuard` still demands a
 * staff session for every non public audience, so it would answer 401 before this guard runs.
 * When partner, portal or hook routes land, make `SessionGuard` audience aware first (staff and
 * partner sessions, a portal sealed token, a hook signature with no Origin check), have each
 * identity set its own request property, then return its audience here. Never reach for
 * `@Public()` to get around it.
 */
function callerAudience(request: IdentifiedRequest): AudienceName | undefined {
  if (request.staff) return 'staff';
  return undefined;
}

/**
 * Deny by default (spec 0007, section 2). Runs after the session guard, which has put the
 * caller's identity on the request. A controller without a valid audience answers 500
 * `AUDIENCE_MISSING` (our bug, not the caller's, and the build test should have caught it);
 * a caller whose audience differs from the route's answers 403 `WRONG_AUDIENCE`; a `public`
 * route is open to all.
 *
 * `SessionGuard` runs first and still requires a staff session on every non public route, so
 * today an anonymous call to any non public route is a 401 from it, not from here.
 *
 * It must never infer an audience from the URL, never let a route without one through, and
 * never say in its answer what the correct audience would be.
 */
@Injectable()
export class AudienceGuard implements CanActivate {
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
