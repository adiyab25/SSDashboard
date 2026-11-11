import { personActor, type AuditActor, type Permission } from '@ssdashboard/contracts';
import type { AuthenticatedRequest } from '../identity/sign-in/current-staff.js';
import type { Access } from '../platform/access/access.js';

/**
 * The signed in person acting on catalog master data, with their `Access` (spec 0008): the audit
 * entry names the hat that holds the route's permission (`actingHat`). Built only from the
 * session, never from anything the caller sent.
 */
export interface CatalogCaller {
  id: string;
  access: Pick<Access, 'actingHat'>;
}

/** The caller of a staff route, from its session and `Access`. */
export const catalogCallerOf = (request: AuthenticatedRequest, access: Access): CatalogCaller => ({
  id: request.staff.id,
  access,
});

/** The audit actor of a person's catalog action that needs `permission` (spec 0010, AC-3). */
export const catalogActor = (caller: CatalogCaller, permission: Permission): AuditActor =>
  personActor(caller.id, caller.access.actingHat(permission));
