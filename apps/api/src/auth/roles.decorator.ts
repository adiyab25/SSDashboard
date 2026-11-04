import { SetMetadata } from '@nestjs/common';
import type { StaffRole } from '@ssdashboard/contracts';

export const ROLES_KEY = 'roles';

/** Limits a route or controller to these roles (spec 0005, AC-15). No decorator means any signed in person. */
export const Roles = (...roles: StaffRole[]) => SetMetadata(ROLES_KEY, roles);
