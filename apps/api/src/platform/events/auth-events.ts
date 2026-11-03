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

export class SignedIn {
  constructor(readonly context: AuthEventContext) {}
}

export type SignInFailureReason = 'bad_credentials' | 'locked' | 'disabled';

export class SignInFailed {
  constructor(
    readonly context: AuthEventContext,
    readonly reason: SignInFailureReason,
  ) {}
}

/** A lock started: `pair` is one email from one address, `email` is that email from any address. */
export class AccountLocked {
  constructor(
    readonly context: AuthEventContext,
    readonly scope: 'pair' | 'email',
  ) {}
}

/** Someone asked to reset a password. `targetId` is null for an email that matches no account. */
export class PasswordResetRequested {
  constructor(readonly context: AuthEventContext) {}
}

/** A password was set from a reset or invite link. `actorId` and `targetId` are that person. */
export class PasswordResetCompleted {
  constructor(readonly context: AuthEventContext) {}
}

export type AuthEvent =
  SignedIn | SignInFailed | AccountLocked | PasswordResetRequested | PasswordResetCompleted;

/** The event names `@OnEvent` listens for: the class name, past tense. */
export const eventName = (event: AuthEvent): string => event.constructor.name;
