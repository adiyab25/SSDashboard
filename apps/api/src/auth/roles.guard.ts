import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { StaffRole } from '@ssdashboard/contracts';
import type { CurrentStaff } from './current-staff.js';
import { ROLES_KEY } from './roles.decorator.js';

/**
 * Runs after the session guard, which has put the signed in person on the request. A route with
 * `@Roles(...)` needs one of those roles; anyone else gets 403 `FORBIDDEN`. Finer permissions
 * replace this in feature 13.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  /** Takes Nest's reflector, which reads the `@Roles(...)` metadata of a route. */
  constructor(private readonly reflector: Reflector) {}

  /**
   * Lets the request through when its route needs no role or the signed in person has one of
   * them; otherwise throws 403 `FORBIDDEN`.
   */
  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<StaffRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const staff = context.switchToHttp().getRequest<{ staff?: CurrentStaff }>().staff;
    if (!staff || !required.includes(staff.role)) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Administrators only' });
    }
    return true;
  }
}
