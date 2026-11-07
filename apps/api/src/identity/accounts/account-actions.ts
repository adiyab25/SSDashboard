import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AccessHolding, StaffSetup, StaffStatus } from '@ssdashboard/contracts';
import { sql, type Database, type DatabaseConnection, type SQL } from '@ssdashboard/db';
import { hashPassword } from 'better-auth/crypto';
import { randomBytes } from 'node:crypto';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { DATABASE } from '../../database/database.module.js';
import type { Transaction } from '../../database/sql.js';
import { MailProducer } from '../../mail/mail-queue.js';
import type { MailKind } from '../../mail/mail-templates.js';
import type { AuthEvent, AuthEventContext } from '../../platform/events/auth-events.js';
import { assertLanguageEnabled } from '../../platform/languages.js';
import { SettingsService } from '../../platform/settings/settings.service.js';
import { auditActorOf, type Actor } from '../access/actor.js';
import {
  IDENTITY_AUDIT,
  type IdentityAudit,
  type IdentityAuditEntry,
} from '../audit-port/identity-audit.js';
import { assertAnotherManager, lockAdminRule } from '../hats/last-manager.js';
import { revokeSessions } from '../sessions/revoke-sessions.js';
import { holdsHat } from '../sessions/session-audiences.js';
import { AuthAudit } from '../sign-in/auth-audit.service.js';
import { emailKey } from '../sign-in/client-info.js';
import {
  deleteTokens,
  deleteTwoFactorChallenges,
  issueToken,
  type Executor,
} from '../sign-in/reset-tokens.js';
import { SignInLockout } from '../sign-in/sign-in-lockout.js';
import { generateTemporaryPassword } from '../sign-in/temporary-password.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The events one kind of account emits for each manager action (spec 0005 AC-23, spec 0008). */
export interface AccountEvents {
  /** Details changed, or a fresh invite was sent. */
  updated(context: AuthEventContext): AuthEvent;
  /** The account was disabled, with the manager's optional reason. */
  disabled(context: AuthEventContext, reason: string | null): AuthEvent;
  /** The account was enabled again. */
  enabled(context: AuthEventContext): AuthEvent;
  /** A manager reset the password. */
  passwordReset(context: AuthEventContext): AuthEvent;
  /** A manager ended every session. */
  sessionsRevoked(context: AuthEventContext): AuthEvent;
  /** A manager turned two factor off and ended every session. */
  twoFactorReset(context: AuthEventContext): AuthEvent;
}

/**
 * What differs between the two kinds of account a manager runs (spec 0008, AC-15): staff on
 * `/api/staff` and partner users on `/api/partner-users`. Everything else, the invites, resets,
 * lockout, sessions and the transaction checked writes, is the same mechanics in
 * {@link AccountActions}.
 */
export interface AccountKind {
  /** Plain words for the 404 message: `staff account`, `partner login`. */
  noun: string;
  /**
   * A SQL condition on `users` (named `users`) that holds exactly for this kind, from the
   * `SessionAudiences` port. Every read of a person puts it in the `WHERE`, so the other kind is
   * never listed or found (404 for every action).
   */
  only(): SQL;
  /**
   * Whether disabling must keep the last active manager (staff). Partner users never wear
   * `manager`, so their kind skips the lock and the count.
   */
  guardsLastManager: boolean;
  /** The events of each action. */
  events: AccountEvents;
}

/** The details a new account is created with. */
export interface NewAccount {
  name: string;
  email: string;
  phone?: string | undefined;
  staffCode?: string | undefined;
  language?: string | undefined;
}

/** The details a manager can change; `null` clears phone, staff code or language. */
export interface AccountDetails {
  name?: string | undefined;
  email?: string | undefined;
  phone?: string | null | undefined;
  staffCode?: string | null | undefined;
  language?: string | null | undefined;
}

/** The keyset page query both lists take. */
export interface AccountPageQuery {
  q?: string | undefined;
  status?: StaffStatus | undefined;
  cursor?: string | undefined;
  limit: number;
}

/** The columns every row a list returns carries for the paging. */
export interface AccountRowBase extends Record<string, unknown> {
  id: string;
  /** `lower(name)` as the database computes it, so a cursor never disagrees with the ordering. */
  name_key: string;
}

/** What the mechanics read of a person under the row lock. */
interface TargetRow extends Record<string, unknown> {
  id: string;
  name: string;
  email: string;
  banned: boolean;
  phone: string | null;
  staff_code: string | null;
  language: string | null;
  /** Raw `execute` rows hand timestamps back as text, so both forms are read. */
  last_sign_in_at: Date | string | null;
  /** Whether the person wears the `manager` hat. */
  manager: boolean;
}

const TARGET_COLUMNS = sql`id, name, email, banned, phone, staff_code, language, last_sign_in_at,
  ${holdsHat('manager')} AS manager`;

/** The cursor does not decode to a page position this endpoint issued. */
export class InvalidAccountCursorError extends Error {
  /** Names no person and no value. */
  constructor() {
    super('The cursor is not one this endpoint issued');
  }
}

/** A page position: the last row's `lower(name)` and id. */
interface Cursor {
  name: string;
  id: string;
}

/** Turns the last row of a page into the opaque cursor for the next one. */
export function encodeAccountCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.name, cursor.id]), 'utf8').toString('base64url');
}

/**
 * Reads a cursor back. Throws `InvalidAccountCursorError` for anything this endpoint did not
 * issue.
 */
export function decodeAccountCursor(value: string): Cursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('shape');
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      const cursor = { name: parsed[0], id: parsed[1] };
      // Node decodes loosely; only a cursor that round trips is one we issued.
      if (encodeAccountCursor(cursor) === value) return cursor;
    }
  } catch {
    // fall through
  }
  throw new InvalidAccountCursorError();
}

/** Escapes `%`, `_` and the escape character, so a search for `50%` finds `50%` and nothing else. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Derives the shown status: disabled when banned, invited when the person never signed in,
 * otherwise active.
 */
export const statusOf = (row: {
  banned: boolean;
  last_sign_in_at: Date | string | null;
}): StaffStatus => (row.banned ? 'disabled' : row.last_sign_in_at === null ? 'invited' : 'active');

/** The pg error code for a unique violation, found through Drizzle's wrapper. */
function uniqueViolation(error: unknown): string | undefined {
  for (let cause: unknown = error; cause; cause = (cause as { cause?: unknown }).cause) {
    const pg = cause as { code?: string; constraint?: string };
    if (pg.code === '23505') return pg.constraint;
  }
  return undefined;
}

const conflict = (code: string, message: string) => new ConflictException({ code, message });

/** A manager resets or signs out someone else from the people page, never themselves. */
const refuseSelf = (id: string, actor: Actor, action: string): void => {
  if (id === actor.id) {
    throw conflict('SELF_ACTION', `You cannot ${action} your own account`);
  }
};

/**
 * The account mechanics a manager uses on both people screens (spec 0005 AC-12 to AC-20, spec
 * 0008 AC-15): the keyset list, creating a person with an invite or a temporary password, editing
 * details, disabling and enabling, resetting the password or two factor, re-inviting, and ending
 * every session. Staff (`StaffService`) and partner users (`PartnerUserService`) call it with
 * their {@link AccountKind}; neither repeats this SQL.
 *
 * Every write locks the person's `users` row with the kind's condition and writes in that same
 * transaction, so a person who stops being of the kind in between is never touched. Disabling a
 * kind that guards the last manager takes `ADMIN_RULE_LOCK` first. Creating, disabling, enabling
 * and resetting a password write one audit entry through the identity audit port in their own
 * transaction (`staff_user.*` for both kinds: the record is the `users` row). Hats are never
 * written here: `HatService` does that, inside `create`'s transaction for a new person.
 *
 * It must never read `users` without the kind's condition, never log or audit an email, a name
 * or a phone, and never queue a mail before its token is committed.
 */
@Injectable()
export class AccountActions {
  private readonly db: Database;

  /**
   * Takes the env (whether mail is on), the app database connection, the settings (enabled
   * languages), the mail producer, the lockout (cleared on a reset), the auth log and the identity
   * audit port.
   */
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DATABASE) connection: DatabaseConnection,
    private readonly settings: SettingsService,
    private readonly producer: MailProducer,
    private readonly lockout: SignInLockout,
    private readonly audit: AuthAudit,
    @Inject(IDENTITY_AUDIT) private readonly trail: IdentityAudit,
  ) {
    this.db = connection.db;
  }

  /** Whether the install sends email (invites and reset links) or hands out temporary passwords. */
  get mailOn(): boolean {
    return this.env.MAIL_DRIVER !== 'none';
  }

  /** The 404 of a kind: an id outside it is simply not found. */
  notFound(kind: AccountKind): NotFoundException {
    return new NotFoundException({ code: 'NOT_FOUND', message: `No such ${kind.noun}` });
  }

  /** Refuses a language the install has not enabled (422 `INVALID_LANGUAGE`). */
  assertLanguage(language: string | null | undefined): Promise<void> {
    return assertLanguageEnabled(this.settings, language ?? undefined);
  }

  /**
   * One keyset page of the kind ordered by name, with the search, the status and the caller's
   * extra filters. `columns` must not select `name_key`: the page adds it. Throws
   * `InvalidAccountCursorError` for a cursor this endpoint did not issue.
   */
  async page<Row extends AccountRowBase>(
    kind: AccountKind,
    query: AccountPageQuery,
    columns: SQL,
    extra: readonly SQL[] = [],
  ): Promise<{ rows: Row[]; nextCursor: string | null }> {
    const filters: SQL[] = [sql`(${kind.only()})`, ...extra];
    if (query.q) {
      const like = `%${escapeLike(query.q)}%`;
      filters.push(
        sql`(lower(name) LIKE lower(${like}) ESCAPE '\\' OR lower(email) LIKE lower(${like}) ESCAPE '\\'
             OR staff_code LIKE upper(${like}) ESCAPE '\\')`,
      );
    }
    if (query.status === 'disabled') filters.push(sql`banned`);
    else if (query.status === 'invited') filters.push(sql`NOT banned AND last_sign_in_at IS NULL`);
    else if (query.status === 'active')
      filters.push(sql`NOT banned AND last_sign_in_at IS NOT NULL`);
    if (query.cursor !== undefined) {
      const after = decodeAccountCursor(query.cursor);
      filters.push(
        sql`(lower(name) COLLATE "C", id) > (${after.name} COLLATE "C", ${after.id}::uuid)`,
      );
    }
    const result = await this.db.execute<Row>(
      sql`SELECT ${columns}, lower(name) AS name_key FROM users
          WHERE ${sql.join(filters, sql` AND `)}
          ORDER BY lower(name) COLLATE "C", id LIMIT ${query.limit + 1}`,
    );
    const rows = result.rows.slice(0, query.limit) as Row[];
    const last = rows.at(-1);
    return {
      rows,
      nextCursor:
        result.rows.length > query.limit && last
          ? encodeAccountCursor({ name: last.name_key, id: last.id })
          : null,
    };
  }

  /**
   * One person of the kind with the caller's columns, or `undefined` (a malformed id, an id of
   * the other kind, or none at all). `forUpdate` locks the row for the caller's transaction.
   */
  async find<Row extends Record<string, unknown>>(
    executor: Pick<Database, 'execute'>,
    kind: AccountKind,
    id: string,
    columns: SQL,
    forUpdate = false,
  ): Promise<Row | undefined> {
    // A malformed id is simply "not found", not a database error.
    if (!UUID.test(id)) return undefined;
    const result = await executor.execute<Row>(
      forUpdate
        ? sql`SELECT ${columns} FROM users WHERE id = ${id}::uuid AND (${kind.only()}) FOR UPDATE`
        : sql`SELECT ${columns} FROM users WHERE id = ${id}::uuid AND (${kind.only()})`,
    );
    return result.rows[0] as Row | undefined;
  }

  /**
   * Creates a person with `giveAccess` writing their first hats in the same transaction
   * (`HatService`), one `credential` account, and an invite (mail on) or a temporary password to
   * hand over (mail off), and records `staff_user.created` with the holding. Returns the new id and
   * the setup; the caller emits its own created event. Throws 409 `EMAIL_TAKEN` or
   * `STAFF_CODE_TAKEN`. The caller judges the access rules before calling, so nothing slow runs
   * for a set that is refused anyway.
   */
  async create(
    input: NewAccount,
    actor: Actor,
    giveAccess: (tx: Transaction, userId: string) => Promise<AccessHolding>,
  ): Promise<{ id: string; setup: StaffSetup }> {
    await this.assertLanguage(input.language);
    // Hashing is slow and must not hold any lock.
    const temporaryPassword = this.mailOn ? undefined : generateTemporaryPassword();
    const passwordHash = await hashPassword(
      temporaryPassword ?? randomBytes(32).toString('base64url'),
    );

    const correlationId = this.trail.newCorrelationId();
    let created: { id: string; tokenId?: string };
    try {
      created = await this.db.transaction(async (tx) => {
        const inserted = await tx.execute<{ id: string }>(
          sql`INSERT INTO users (name, email, phone, staff_code, language, must_change_password)
              VALUES (${input.name}, ${input.email}, ${input.phone ?? null},
                      ${input.staffCode ?? null}, ${input.language ?? null}, ${!this.mailOn})
              RETURNING id`,
        );
        const id = inserted.rows[0]?.id;
        if (id === undefined) throw new Error('Could not create the account');
        const holding = await giveAccess(tx, id);
        // Better Auth's own layout: one `credential` account whose id is the user id.
        await tx.execute(
          sql`INSERT INTO accounts (user_id, provider_id, account_id, password)
              VALUES (${id}::uuid, 'credential', ${id}, ${passwordHash})`,
        );
        const tokenId = await this.replaceInvite(tx, id);
        await this.record(
          tx,
          actor,
          id,
          'staff_user.created',
          { after: { ...holding } },
          correlationId,
        );
        return { id, ...(tokenId && { tokenId }) };
      });
    } catch (error) {
      this.rethrowUnique(error);
      throw error;
    }

    if (created.tokenId) await this.queue(created.id, 'invite', created.tokenId);
    return {
      id: created.id,
      setup: temporaryPassword
        ? { mode: 'temporary_password', temporaryPassword }
        : { mode: 'email' },
    };
  }

  /**
   * Changes name, contact details, staff code or language, and the email while the person is
   * still invited (409 `EMAIL_LOCKED` after). An email change makes the old password unusable,
   * ends the sessions and sends a fresh invite to the new address, as a re-invite would.
   */
  async update(kind: AccountKind, id: string, input: AccountDetails, actor: Actor): Promise<void> {
    if (input.language) await this.assertLanguage(input.language);
    // Hashing is slow and must not hold any lock, so the unusable password an email change needs
    // is made first, and only when the email looks set to change.
    const current =
      input.email === undefined
        ? undefined
        : await this.find<TargetRow>(this.db, kind, id, TARGET_COLUMNS);
    let unusableHash =
      current && input.email !== current.email.toLowerCase()
        ? await hashPassword(randomBytes(32).toString('base64url'))
        : undefined;
    let otherChanged = false;
    let inviteTokenId: string | undefined;

    try {
      await this.db.transaction(async (tx) => {
        const target = await this.find<TargetRow>(tx, kind, id, TARGET_COLUMNS, true);
        if (!target) throw this.notFound(kind);

        const sets: SQL[] = [];
        let emailChanged = false;
        if (input.email !== undefined && input.email !== target.email.toLowerCase()) {
          if (statusOf(target) !== 'invited') {
            throw conflict(
              'EMAIL_LOCKED',
              'The email can only change while the account is invited',
            );
          }
          // Taking over a cost holder's sign in is a way round the cost rule (spec 0008 AC-7).
          await this.refuseCostHolderTakeover(tx, id, actor);
          sets.push(sql`email = ${input.email}`, sql`must_change_password = true`);
          otherChanged = true;
          emailChanged = true;
        }
        const plain: Array<[string, string | null | undefined, string | null]> = [
          ['name', input.name, target.name],
          ['phone', input.phone, target.phone],
          ['staff_code', input.staffCode, target.staff_code],
          ['language', input.language, target.language],
        ];
        for (const [column, next, was] of plain) {
          if (next !== undefined && next !== was) {
            sets.push(sql`${sql.raw(column)} = ${next}`);
            otherChanged = true;
          }
        }
        if (sets.length > 0) {
          await tx.execute(
            sql`UPDATE users SET ${sql.join(sets, sql`, `)}, updated_at = now() WHERE id = ${id}::uuid`,
          );
        }
        if (emailChanged) {
          // Whoever held the old address may have set a password through its link already: that
          // password stops working, with any session, as an admin reset does (AC-18). With mail on
          // a new link goes to the new address, exactly as a re-invite would. With mail off no
          // password is shown here; the admin issues one with Reset password (AC-13).
          unusableHash ??= await hashPassword(randomBytes(32).toString('base64url'));
          await this.replacePassword(tx, id, unusableHash);
          await revokeSessions(id, tx);
          await deleteTwoFactorChallenges(tx, id);
          inviteTokenId = await this.replaceInvite(tx, id);
        }
      });
    } catch (error) {
      this.rethrowUnique(error);
      throw error;
    }

    if (inviteTokenId) await this.queue(id, 'invite', inviteTokenId);
    if (otherChanged) this.emit(kind.events.updated(this.context(actor, id)));
  }

  /**
   * Disables an account, deleting its sessions and unused links in the same transaction. Refuses
   * one's own (409 `SELF_DISABLE`) and, for a kind that guards it, the last active manager (409
   * `LAST_ADMIN`, under `ADMIN_RULE_LOCK` taken before the row lock).
   */
  async disable(
    kind: AccountKind,
    id: string,
    reason: string | undefined,
    actor: Actor,
  ): Promise<void> {
    const correlationId = this.trail.newCorrelationId();
    await this.db.transaction(async (tx) => {
      if (kind.guardsLastManager) await lockAdminRule(tx);
      const target = await this.find<TargetRow>(tx, kind, id, TARGET_COLUMNS, true);
      if (!target) throw this.notFound(kind);
      if (id === actor.id) throw conflict('SELF_DISABLE', 'You cannot disable your own account');
      if (kind.guardsLastManager && target.manager && !target.banned) {
        await assertAnotherManager(tx, id, sql`(${kind.only()})`);
      }

      await tx.execute(
        sql`UPDATE users SET banned = true, ban_reason = ${reason ?? null}, updated_at = now()
             WHERE id = ${id}::uuid`,
      );
      // The same transaction: a disabled person has no live session, and no link that could log them in.
      await revokeSessions(id, tx);
      await deleteTokens(tx, id);
      await this.record(
        tx,
        actor,
        id,
        'staff_user.disabled',
        {
          before: { banned: target.banned },
          after: { banned: true },
          ...(reason !== undefined && { reason }),
        },
        correlationId,
      );
    });
    this.emit(kind.events.disabled(this.context(actor, id), reason ?? null));
  }

  /**
   * Re-enables a disabled account; 404 for an id outside the kind. The check locks the row and the
   * write follows in the same transaction (AC-28).
   */
  async enable(kind: AccountKind, id: string, actor: Actor): Promise<void> {
    const correlationId = this.trail.newCorrelationId();
    await this.db.transaction(async (tx) => {
      const target = await this.find<TargetRow>(tx, kind, id, TARGET_COLUMNS, true);
      if (!target) throw this.notFound(kind);
      await tx.execute(
        sql`UPDATE users SET banned = false, ban_reason = NULL, ban_expires = NULL, updated_at = now()
             WHERE id = ${id}::uuid`,
      );
      await this.record(
        tx,
        actor,
        id,
        'staff_user.enabled',
        { before: { banned: target.banned }, after: { banned: false } },
        correlationId,
      );
    });
    this.emit(kind.events.enabled(this.context(actor, id)));
  }

  /**
   * Admin reset (AC-18). The old password stops working at once: the stored hash is replaced in
   * the same transaction, by a temporary password, or by a random value nobody knows until the
   * person follows the emailed link. Sessions and older links go, and the lockout clears. Never
   * one's own (409 `SELF_ACTION`).
   */
  async resetPassword(kind: AccountKind, id: string, actor: Actor): Promise<StaffSetup> {
    refuseSelf(id, actor, 'reset the password of');
    const temporaryPassword = this.mailOn ? undefined : generateTemporaryPassword();
    const passwordHash = await hashPassword(
      temporaryPassword ?? randomBytes(32).toString('base64url'),
    );

    const correlationId = this.trail.newCorrelationId();
    const done = await this.db.transaction(async (tx) => {
      const target = await this.find<TargetRow>(tx, kind, id, TARGET_COLUMNS, true);
      if (!target) throw this.notFound(kind);
      await this.refuseCostHolderTakeover(tx, id, actor);
      await this.replacePassword(tx, id, passwordHash);
      await tx.execute(
        sql`UPDATE users SET must_change_password = true, updated_at = now() WHERE id = ${id}::uuid`,
      );
      await revokeSessions(id, tx);
      await deleteTwoFactorChallenges(tx, id);
      let tokenId: string | undefined;
      if (this.mailOn) tokenId = (await issueToken(tx, id, 'reset')).tokenId;
      else await deleteTokens(tx, id);
      await this.record(
        tx,
        actor,
        id,
        'staff_user.password_reset',
        {
          after: { mustChangePassword: true, mode: this.mailOn ? 'email' : 'temporary_password' },
        },
        correlationId,
      );
      return { email: target.email, tokenId };
    });

    await this.lockout.reset(emailKey(done.email));
    if (done.tokenId) await this.queue(id, 'reset', done.tokenId);
    this.emit(kind.events.passwordReset(this.context(actor, id)));
    return temporaryPassword
      ? { mode: 'temporary_password', temporaryPassword }
      : { mode: 'email' };
  }

  /**
   * Issues a fresh invite link to an account that has never signed in. Throws 409 `NOT_INVITED`
   * or `MAIL_DISABLED` when that cannot work. The token is issued in the transaction that locked
   * the row; the mail is queued after the commit.
   */
  async resendInvite(kind: AccountKind, id: string, actor: Actor): Promise<void> {
    const tokenId = await this.db.transaction(async (tx) => {
      const target = await this.find<TargetRow>(tx, kind, id, TARGET_COLUMNS, true);
      if (!target) throw this.notFound(kind);
      if (statusOf(target) !== 'invited') {
        throw conflict(
          'NOT_INVITED',
          'Only an account that has not signed in yet can be re-invited',
        );
      }
      if (!this.mailOn) throw conflict('MAIL_DISABLED', 'This install does not send email');
      return (await issueToken(tx, id, 'invite')).tokenId;
    });
    await this.queue(id, 'invite', tokenId);
    this.emit(kind.events.updated(this.context(actor, id)));
  }

  /**
   * Deletes every session of another person through the module's one writer,
   * `revokeSessions(userId, tx)`, in the transaction that locked the row. Never one's own (409
   * `SELF_ACTION`). Returns how many sessions ended.
   */
  async revokeSessions(kind: AccountKind, id: string, actor: Actor): Promise<number> {
    refuseSelf(id, actor, 'sign out every session of');
    const count = await this.db.transaction(async (tx) => {
      if (!(await this.find(tx, kind, id, TARGET_COLUMNS, true))) throw this.notFound(kind);
      return revokeSessions(id, tx);
    });
    this.emit(kind.events.sessionsRevoked(this.context(actor, id)));
    return count;
  }

  /**
   * Turns off someone else's two factor and ends their sessions (AC-20), for a person who lost
   * their phone. Their password is untouched, so they sign in with it and can enroll again.
   */
  async resetTwoFactor(kind: AccountKind, id: string, actor: Actor): Promise<void> {
    refuseSelf(id, actor, 'reset the two factor of');
    await this.db.transaction(async (tx) => {
      if (!(await this.find(tx, kind, id, TARGET_COLUMNS, true))) throw this.notFound(kind);
      await this.refuseCostHolderTakeover(tx, id, actor);
      await tx.execute(sql`DELETE FROM two_factors WHERE user_id = ${id}::uuid`);
      await tx.execute(
        sql`UPDATE users SET two_factor_enabled = false, updated_at = now() WHERE id = ${id}::uuid`,
      );
      await revokeSessions(id, tx);
      await deleteTwoFactorChallenges(tx, id);
    });
    this.emit(kind.events.twoFactorReset(this.context(actor, id)));
  }

  /** Who did it, to whom, from where: the context of every account event. */
  context(actor: Actor, targetId: string): AuthEventContext {
    return {
      actorId: actor.id,
      targetId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      at: new Date(),
    };
  }

  /** Logs the event and emits it, after the change committed; a failing listener never fails it. */
  emit(event: AuthEvent): void {
    this.audit.record(event);
  }

  /**
   * Writes one audit entry for an account action through the identity audit port, inside the
   * action's own transaction (spec 0010 task 10). `detail` holds ids, flags and the reason only:
   * never an email, a name or a phone. The caller makes `correlationId` before it opens the
   * transaction (`AuditService`'s rule, so a retried transaction keeps one id).
   */
  private record(
    tx: Transaction,
    actor: Actor,
    id: string,
    action: IdentityAuditEntry['action'],
    detail: Pick<IdentityAuditEntry, 'before' | 'after' | 'reason'>,
    correlationId: string,
  ): Promise<void> {
    return this.trail.record(tx, {
      actor: auditActorOf(actor, 'people.manage'),
      action,
      record: { type: 'user', id },
      ...detail,
      correlationId,
    });
  }

  /**
   * The cost rule on the actions that let the actor sign in as the target (spec 0008 AC-7, gate
   * ruling of 2026-11-06): only someone who holds `cost.view` may reset the password or two factor
   * of, or change the email of, a person who holds it, else 403 `COST_HOLDER_PROTECTED` (its own code, so
   * the screen can say why; review round 2, r1) and nothing changes.
   * Runs inside the transaction that locked the target's row; an actor with `cost.view` costs no
   * query.
   */
  private async refuseCostHolderTakeover(tx: Transaction, id: string, actor: Actor): Promise<void> {
    if (actor.access.has('cost.view')) return;
    const held = await tx.execute(
      sql`SELECT 1 FROM permission_grants WHERE user_id = ${id}::uuid AND permission = 'cost.view'`,
    );
    if (held.rows.length > 0) {
      throw new ForbiddenException({
        code: 'COST_HOLDER_PROTECTED',
        message: 'Only someone who can see cost can change how this person signs in',
      });
    }
  }

  private rethrowUnique(error: unknown): void {
    const constraint = uniqueViolation(error);
    if (constraint === 'users_email_unique') {
      throw conflict('EMAIL_TAKEN', 'Another account already uses this email');
    }
    if (constraint === 'users_staff_code_unique') {
      throw conflict('STAFF_CODE_TAKEN', 'Another account already uses this staff code');
    }
  }

  /** Sets the stored hash of the person's one `credential` account, making it if it is missing. */
  private async replacePassword(tx: Transaction, id: string, passwordHash: string): Promise<void> {
    await tx.execute(
      sql`INSERT INTO accounts (user_id, provider_id, account_id, password)
          VALUES (${id}::uuid, 'credential', ${id}, ${passwordHash})
          ON CONFLICT (tenant_id, provider_id, account_id) DO UPDATE SET password = excluded.password, updated_at = now()`,
    );
  }

  /**
   * Ends the person's older links and, with mail on, issues a fresh invite token. Returns its id
   * for `queue`, which runs after the commit so the worker reads the committed row.
   */
  private async replaceInvite(executor: Executor, id: string): Promise<string | undefined> {
    if (!this.mailOn) {
      await deleteTokens(executor, id);
      return undefined;
    }
    return (await issueToken(executor, id, 'invite')).tokenId;
  }

  private async queue(userId: string, kind: MailKind, tokenId: string): Promise<void> {
    await this.producer.enqueue({ userId, kind, tokenId });
  }
}
