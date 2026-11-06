import {
  type AccessAudience,
  Hat,
  HAT_AUDIENCE,
  Permission,
  permissionsFor,
} from '@ssdashboard/contracts';

/** Raised when an `Access` would hold a hat or a permission outside the catalog. */
export class InvalidAccess extends Error {
  /** Takes the plain words of what is wrong; the message names no person. */
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAccess';
  }
}

/** What an `Access` is built from: the person, their hats, their extra grants, their partner account. */
export interface AccessInput {
  userId: string;
  hats: readonly string[];
  grants: readonly string[];
  partnerAccountId: string | null;
}

/**
 * What the signed in person may do on this request (spec 0008): their hats, their effective
 * permissions (every hat's permissions plus their extra grants, `permissionsFor`), and their
 * partner account. An immutable value object: it validates on construction that every hat and
 * permission is in the catalog of `@ssdashboard/contracts`, and throws `InvalidAccess` otherwise.
 *
 * Identity's session guard builds it from the database on every request and puts it on
 * `request.access`; `PermissionGuard` and the cost serializers read it. It must never be cached
 * across requests, stored in the session or a cookie, or built from anything the caller sent.
 */
export class Access {
  /** The person (`users.id`). */
  readonly userId: string;
  /** The hats the person wears, in catalog order, each once. */
  readonly hats: readonly Hat[];
  /** The effective permissions, sorted, each once. */
  readonly permissions: readonly Permission[];
  /** The partner account of the partner hat, else null. */
  readonly partnerAccountId: string | null;
  private readonly held: ReadonlySet<Permission>;

  /** Validates the input and freezes the result. Throws `InvalidAccess` for an unknown hat or grant. */
  constructor(input: AccessInput) {
    const hats = input.hats.map((hat) => {
      const parsed = Hat.safeParse(hat);
      if (!parsed.success) throw new InvalidAccess('A person holds a hat outside the catalog');
      return parsed.data;
    });
    const grants = input.grants.map((grant) => {
      const parsed = Permission.safeParse(grant);
      if (!parsed.success) throw new InvalidAccess('A person holds a grant outside the catalog');
      return parsed.data;
    });
    const unique = new Set(hats);
    this.userId = input.userId;
    this.hats = Object.freeze(Hat.options.filter((hat) => unique.has(hat)));
    this.permissions = Object.freeze(permissionsFor(this.hats, grants));
    this.held = new Set(this.permissions);
    this.partnerAccountId = input.partnerAccountId;
    Object.freeze(this);
  }

  /** Whether the person holds this permission, through a hat or a grant. */
  has(permission: Permission): boolean {
    return this.held.has(permission);
  }

  /** Whether the person holds every one of these permissions (an empty list is never enough). */
  hasAll(permissions: readonly Permission[]): boolean {
    return permissions.length > 0 && permissions.every((permission) => this.held.has(permission));
  }

  /** Whether one of the person's hats belongs to this audience (what `@AnyHat()` asks). */
  wearsHatOf(audience: AccessAudience): boolean {
    return this.hats.some((hat) => HAT_AUDIENCE[hat] === audience);
  }
}
