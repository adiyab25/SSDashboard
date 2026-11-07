import type { Permission } from '@ssdashboard/contracts';
import { Access } from '../../platform/access/access.js';
import { forbidden } from '../../platform/access/permission.guard.js';
import type { IdentityAuditActor } from '../audit-port/identity-audit.js';
import { clientIp, userAgent } from '../sign-in/client-info.js';
import type { AuthenticatedRequest } from '../sign-in/current-staff.js';

/**
 * Who is making a change on a staff route, and from where: the person's id, the client address
 * and user agent (spec 0005, AC-23), and their `Access` as the session guard read it on this
 * request. The access decides the cost rule of spec 0008 AC-7 (adding or removing `cost.view`
 * needs the actor to hold it) and the hat the audit entry names. Never built from the body.
 */
export interface Actor {
  id: string;
  ip: string;
  userAgent: string | null;
  access: Access;
}

/**
 * The actor of a staff request. Throws the guard's 403 `FORBIDDEN` when the session guard set no
 * `Access`, so a route that somehow skipped it fails closed.
 */
export function actorOf(request: AuthenticatedRequest): Actor {
  const access = (request as AuthenticatedRequest & { access?: unknown }).access;
  if (!(access instanceof Access)) throw forbidden();
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers.set(name, value);
  }
  return { id: request.staff.id, ip: clientIp(headers), userAgent: userAgent(headers), access };
}

/**
 * The actor of an audit entry in spec 0010's person shape: the user and the first of their hats
 * (catalog order) that holds the permission the route needs, `manager` for `people.manage` today.
 * Falls back to the first hat they wear, which the route's permission guard makes unreachable.
 */
export function auditActorOf(actor: Actor, permission: Permission): IdentityAuditActor {
  return { kind: 'person', userId: actor.id, hat: actor.access.actingHat(permission) };
}
