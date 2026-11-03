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

export type AuthEvent = SignedIn | SignInFailed | AccountLocked;

/** The event names `@OnEvent` listens for: the class name, past tense. */
export const eventName = (event: AuthEvent): string => event.constructor.name;
