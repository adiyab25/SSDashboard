'use client';

import type { Hat, Permission } from '@ssdashboard/contracts';
import { useMemo } from 'react';
import { useMe } from '@/auth/use-me';

/** What the signed in person may use, as `GET /api/me` (or `/api/partner/me`) answered it. */
export interface Access {
  /** False until the who am I answer is in; `can` is false for everything until then. */
  ready: boolean;
  /** The hats the person wears (spec 0008, AC-1); empty until ready. */
  hats: readonly Hat[];
  /** The effective permissions, hats plus extra grants such as `cost.view`; empty until ready. */
  permissions: readonly Permission[];
  /** True when the person holds `permission`. */
  can(permission: Permission): boolean;
}

const NONE: readonly never[] = [];

/**
 * The signed in person's hats and permissions (spec 0008, AC-11), read from the who am I answer
 * the page already loads once (`useMe`), so it adds no request. `path` is the audience's route:
 * `/api/me` for the back office (the default), `/api/partner/me` on partner pages.
 *
 * It only hides what a person cannot use: it never grants anything, and the api answers 403 to a
 * route whatever the web shows. While the answer is loading, `can` is false, so a page never
 * flashes an action or a cost column it then takes away.
 */
export function useAccess(path?: string): Access {
  const me = useMe(path);
  const hats = me?.hats ?? NONE;
  const permissions = me?.permissions ?? NONE;
  const ready = me !== null;

  return useMemo(() => {
    const held = new Set<Permission>(permissions);
    return { ready, hats, permissions, can: (permission) => held.has(permission) };
  }, [ready, hats, permissions]);
}
