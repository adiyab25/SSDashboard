import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { audienceOf } from '../audience/audience.decorator.js';
import { Access } from './access.js';
import { declarationsFor } from './permission.decorator.js';

/** What identity's session guard has put on the request: the caller's `Access`. */
interface RequestWithAccess {
  access?: unknown;
}

/** The one answer for a caller who lacks a permission. It never names the permission. */
export const forbidden = (): ForbiddenException =>
  new ForbiddenException({ code: 'FORBIDDEN', message: 'You do not have access to this.' });

/**
 * Deny by default, the second wall (spec 0008, AC-4). Runs after `SessionGuard` (which sets
 * `request.access`) and `AudienceGuard`. On a `staff` or `partner` route it reads the handler's
 * declaration, else the class's: none, or more than one, is 500 `PERMISSION_MISSING` (our bug,
 * which `permission.spec.ts` should have caught); a caller without every declared permission, or
 * without a hat of the route's audience for `@AnyHat()`, is 403 `FORBIDDEN`. `portal`, `hook` and
 * `public` routes carry no permission and are left to the guards before it.
 *
 * It never queries the database and never reads a permission from the request: only the `Access`
 * the session guard built.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  /** Applies the rules above; throws 500 or 403 with a stable code, else lets the request through. */
  canActivate(context: ExecutionContext): boolean {
    const audience = audienceOf(context.getClass());
    if (audience !== 'staff' && audience !== 'partner') return true;

    const declarations = declarationsFor(context.getHandler(), context.getClass());
    const declaration = declarations.length === 1 ? declarations[0] : undefined;
    if (!declaration) {
      throw new InternalServerErrorException({
        code: 'PERMISSION_MISSING',
        message: 'This route declares no permission.',
      });
    }

    const access = context.switchToHttp().getRequest<RequestWithAccess>().access;
    if (!(access instanceof Access)) throw forbidden();
    switch (declaration.kind) {
      case 'any_hat':
        if (!access.wearsHatOf(audience)) throw forbidden();
        return true;
      case 'permissions':
        if (!access.hasAll(declaration.permissions)) throw forbidden();
        return true;
    }
  }
}
