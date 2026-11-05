/** Who did it, to whom, from where. Every auth event carries this (spec 0005, AC-23). */
export interface AuthEventContext {
  /** The person acting; null when nobody is signed in (a failed sign in). */
  actorId: string | null;
  /** The account acted on; null for an email that matches no account. */
  targetId: string | null;
  ip: string;
  userAgent: string | null;
  at: Date;
}

/** A person signed in. */
export class SignedIn {
  /** Takes the context shared by every auth event. */
  constructor(readonly context: AuthEventContext) {}
}

/** Why a sign in failed: wrong credentials, a lock in force, or a disabled account. */
export type SignInFailureReason = 'bad_credentials' | 'locked' | 'disabled';

/**
 * A sign in failed. The caller sees one identical answer whatever the reason; only this event
 * records it.
 */
export class SignInFailed {
  /** Takes the shared context and the failure reason. */
  constructor(
    readonly context: AuthEventContext,
    readonly reason: SignInFailureReason,
  ) {}
}

/** A lock started: `pair` is one email from one address, `email` is that email from any address. */
export class AccountLocked {
  /** Takes the shared context and which counter locked. */
  constructor(
    readonly context: AuthEventContext,
    readonly scope: 'pair' | 'email',
  ) {}
}

/** Someone asked to reset a password. `targetId` is null for an email that matches no account. */
export class PasswordResetRequested {
  /** Takes the shared context. */
  constructor(readonly context: AuthEventContext) {}
}

/** A password was set from a reset or invite link. `actorId` and `targetId` are that person. */
export class PasswordResetCompleted {
  /** Takes the shared context. */
  constructor(readonly context: AuthEventContext) {}
}

/** A signed in person changed their own password. */
export class PasswordChanged {
  /** Takes the shared context. */
  constructor(readonly context: AuthEventContext) {}
}

/** A person finished turning on two factor sign in (their first code was confirmed). */
export class TwoFactorEnabled {
  /** Takes the shared context. */
  constructor(readonly context: AuthEventContext) {}
}

/** A person turned off their own two factor sign in. */
export class TwoFactorDisabled {
  /** Takes the shared context. */
  constructor(readonly context: AuthEventContext) {}
}

/** An admin turned off someone else's two factor and ended their sessions. */
export class StaffTwoFactorReset {
  /** Takes the shared context. */
  constructor(readonly context: AuthEventContext) {}
}

/** An admin created an account. `targetId` is the new account. */
export class StaffCreated {
  /** Takes the shared context. */
  constructor(readonly context: AuthEventContext) {}
}

/** An admin changed a person's details, other than their role. */
export class StaffUpdated {
  /** Takes the shared context. */
  constructor(readonly context: AuthEventContext) {}
}

/** An admin changed a person's role. `reason` carries the new role. */
export class StaffRoleChanged {
  /** Takes the shared context and the new role. */
  constructor(
    readonly context: AuthEventContext,
    readonly reason: string,
  ) {}
}

/** `reason` is what the admin wrote, when they wrote one. */
export class StaffDisabled {
  /** Takes the shared context and the admin's optional reason. */
  constructor(
    readonly context: AuthEventContext,
    readonly reason: string | null,
  ) {}
}

/** An admin re-enabled a disabled account. */
export class StaffEnabled {
  /** Takes the shared context. */
  constructor(readonly context: AuthEventContext) {}
}

/** An admin reset someone else's password (by email or with a temporary password). */
export class StaffPasswordReset {
  /** Takes the shared context. */
  constructor(readonly context: AuthEventContext) {}
}

/** An admin signed someone out everywhere by ending all their sessions. */
export class StaffSessionsRevoked {
  /** Takes the shared context. */
  constructor(readonly context: AuthEventContext) {}
}

/** Every auth event the audit service can record. A `switch` over it must name each one. */
export type AuthEvent =
  | SignedIn
  | SignInFailed
  | AccountLocked
  | PasswordResetRequested
  | PasswordResetCompleted
  | PasswordChanged
  | TwoFactorEnabled
  | TwoFactorDisabled
  | StaffTwoFactorReset
  | StaffCreated
  | StaffUpdated
  | StaffRoleChanged
  | StaffDisabled
  | StaffEnabled
  | StaffPasswordReset
  | StaffSessionsRevoked;

/** The event names `@OnEvent` listens for: the class name, past tense. */
export const eventName = (event: AuthEvent): string => event.constructor.name;
