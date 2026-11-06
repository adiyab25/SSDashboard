import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateStaffRequest,
  CreateStaffResponse,
  ResetStaffPasswordResponse,
  RevokeSessionsResponse,
  StaffDetail,
  StaffListQuery,
  StaffListResponse,
  StaffRow,
  StaffSetup,
  StaffStatus,
  UpdateStaffRequest,
} from '@ssdashboard/contracts';
import { StaffRole } from '@ssdashboard/contracts';
import { sql, type Database, type DatabaseConnection, type SQL } from '@ssdashboard/db';
import { hashPassword } from 'better-auth/crypto';
import { randomBytes } from 'node:crypto';
import { AuthAudit } from '../sign-in/auth-audit.service.js';
import { emailKey } from '../sign-in/client-info.js';
import { ADMIN_RULE_LOCK } from '../sign-in/locks.js';
import {
  deleteTokens,
  deleteTwoFactorChallenges,
  issueToken,
  type Executor,
} from '../sign-in/reset-tokens.js';
import { SESSION_AUDIENCES, type SessionAudiences } from '../sessions/session-audiences.js';
import { SignInLockout } from '../sign-in/sign-in-lockout.js';
import { generateTemporaryPassword } from '../sign-in/temporary-password.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { DATABASE } from '../../database/database.module.js';
import { MailProducer } from '../../mail/mail-queue.js';
import type { MailKind } from '../../mail/mail-templates.js';
import {
  StaffCreated,
  StaffDisabled,
  StaffEnabled,
  StaffPasswordReset,
  StaffRoleChanged,
  StaffSessionsRevoked,
  StaffTwoFactorReset,
  StaffUpdated,
  type AuthEvent,
  type AuthEventContext,
} from '../../platform/events/auth-events.js';
import { assertLanguageEnabled } from '../../platform/languages.js';
import { SettingsService } from '../../platform/settings.service.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Who is making the change, and from where. The controller reads it from the request. */
export interface Actor {
  id: string;
  ip: string;
  userAgent: string | null;
}

interface UserRow extends Record<string, unknown> {
  id: string;
  name: string;
  email: string;
  role: string;
  banned: boolean;
  ban_reason: string | null;
  phone: string | null;
  staff_code: string | null;
  language: string | null;
  two_factor_enabled: boolean;
  /** Raw `execute` rows hand timestamps back as text, so both forms are read. */
  last_sign_in_at: Date | string | null;
  created_at: Date | string;
  /** `lower(name)` as the database computes it, so a cursor never disagrees with the ordering. */
  name_key: string;
}

const COLUMNS = sql.raw(
  'id, name, email, role, banned, ban_reason, phone, staff_code, language, two_factor_enabled, last_sign_in_at, created_at, lower(name) AS name_key',
);

/** The cursor does not decode to a page position this endpoint issued. */
export class InvalidStaffCursorError extends Error {
  constructor() {
    super('The cursor is not one this endpoint issued');
  }
}

interface Cursor {
  name: string;
  id: string;
}

/** Turns the last row of a page into the opaque cursor for the next one. */
export function encodeStaffCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.name, cursor.id]), 'utf8').toString('base64url');
}

/**
 * Reads a cursor back. Throws `InvalidStaffCursorError` for anything this endpoint did not
 * issue.
 */
export function decodeStaffCursor(value: string): Cursor {
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
      if (encodeStaffCursor(cursor) === value) return cursor;
    }
  } catch {
    // fall through
  }
  throw new InvalidStaffCursorError();
}

/** Escapes `%`, `_` and the escape character, so a search for `50%` finds `50%` and nothing else. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

const iso = (value: Date | string): string => new Date(value).toISOString();

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
const notFound = () =>
  new NotFoundException({ code: 'NOT_FOUND', message: 'No such staff account' });
/** An admin resets or signs out someone else from the staff page, never themselves (no password check there). */
const refuseSelf = (id: string, actor: Actor, action: string): void => {
  if (id === actor.id) {
    throw conflict('SELF_ACTION', `You cannot ${action} your own account from the staff page`);
  }
};

/**
 * Staff administration (spec 0005, AC-12 to AC-18). Every change that could remove the last
 * active admin runs in one transaction under `ADMIN_RULE_LOCK`, the lock `create-admin` takes
 * too. Better Auth still owns password hashing and the sign in ban check; the rest is our SQL.
 *
 * Staff only (AC-28): every read of a person goes through `SessionAudiences.staffCondition()`,
 * so a partner user is never listed, found (404 for every action), counted as an admin, or made
 * one. Never read `users` here without that condition.
 */
@Injectable()
export class StaffService {
  private readonly db: Database;

  /**
   * Takes the env, the app database connection, the mail producer, lockout and audit services,
   * and the `SessionAudiences` port that says who is staff.
   */
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DATABASE) connection: DatabaseConnection,
    private readonly settings: SettingsService,
    private readonly producer: MailProducer,
    private readonly lockout: SignInLockout,
    private readonly audit: AuthAudit,
    @Inject(SESSION_AUDIENCES) private readonly audiences: SessionAudiences,
  ) {
    this.db = connection.db;
  }

  /** The condition that keeps every query to staff people (AC-28). */
  private get staffOnly(): SQL {
    return sql`(${this.audiences.staffCondition()})`;
  }

  private get mailOn(): boolean {
    return this.env.MAIL_DRIVER !== 'none';
  }

  /**
   * One keyset page of staff ordered by name, with the optional search and filters of the query.
   */
  async list(query: StaffListQuery): Promise<StaffListResponse> {
    const filters = [this.staffOnly];
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
      const after = decodeStaffCursor(query.cursor);
      filters.push(
        sql`(lower(name) COLLATE "C", id) > (${after.name} COLLATE "C", ${after.id}::uuid)`,
      );
    }
    const result = await this.db.execute<UserRow>(
      sql`SELECT ${COLUMNS} FROM users WHERE ${sql.join(filters, sql` AND `)}
          ORDER BY lower(name) COLLATE "C", id LIMIT ${query.limit + 1}`,
    );
    const page = result.rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      rows: page.map((row) => this.toRow(row)),
      nextCursor:
        result.rows.length > query.limit && last
          ? encodeStaffCursor({ name: last.name_key, id: last.id })
          : null,
    };
  }

  /** One account's detail; throws 404 `NOT_FOUND` for an unknown id. */
  async get(id: string): Promise<StaffDetail> {
    const row = await this.find(this.db, id);
    if (!row) throw notFound();
    return this.toDetail(row);
  }

  /**
   * Creates an account and queues an invite when the install sends email, or returns a temporary
   * password to hand over otherwise.
   */
  async create(input: CreateStaffRequest, actor: Actor): Promise<CreateStaffResponse> {
    await this.assertLanguage(input.language);
    // Hashing is slow and must not hold any lock.
    const temporaryPassword = this.mailOn ? undefined : generateTemporaryPassword();
    const passwordHash = await hashPassword(
      temporaryPassword ?? randomBytes(32).toString('base64url'),
    );

    let created: { id: string; tokenId?: string };
    try {
      created = await this.db.transaction(async (tx) => {
        const inserted = await tx.execute<{ id: string }>(
          sql`INSERT INTO users (name, email, role, phone, staff_code, language, must_change_password)
              VALUES (${input.name}, ${input.email}, ${input.role}, ${input.phone ?? null},
                      ${input.staffCode ?? null}, ${input.language ?? null}, ${!this.mailOn})
              RETURNING id`,
        );
        const id = inserted.rows[0]?.id;
        if (id === undefined) throw new Error('Could not create the staff account');
        // Better Auth's own layout: one `credential` account whose id is the user id.
        await tx.execute(
          sql`INSERT INTO accounts (user_id, provider_id, account_id, password)
              VALUES (${id}::uuid, 'credential', ${id}, ${passwordHash})`,
        );
        const tokenId = await this.replaceInvite(tx, id);
        return { id, ...(tokenId && { tokenId }) };
      });
    } catch (error) {
      this.rethrowUnique(error);
      throw error;
    }

    if (created.tokenId) await this.queue(created.id, 'invite', created.tokenId);
    this.emit(new StaffCreated(this.context(actor, created.id)));
    const staff = await this.get(created.id);
    const setup: StaffSetup = temporaryPassword
      ? { mode: 'temporary_password', temporaryPassword }
      : { mode: 'email' };
    return { staff, setup };
  }

  /**
   * Changes name, contact details, language or role. Refuses a change that would remove the last
   * active admin, and emits a role changed event when the role moved.
   */
  async update(id: string, input: UpdateStaffRequest, actor: Actor): Promise<StaffDetail> {
    if (input.language) await this.assertLanguage(input.language);
    // Hashing is slow and must not hold any lock, so the unusable password an email change needs
    // is made first, and only when the email looks set to change.
    const current = input.email === undefined ? undefined : await this.find(this.db, id);
    let unusableHash =
      current && input.email !== current.email.toLowerCase()
        ? await hashPassword(randomBytes(32).toString('base64url'))
        : undefined;
    let roleChanged = false;
    let otherChanged = false;
    let inviteTokenId: string | undefined;

    try {
      await this.db.transaction(async (tx) => {
        await this.lock(tx);
        const target = await this.find(tx, id, true);
        if (!target) throw notFound();

        const sets: SQL[] = [];
        let emailChanged = false;
        if (input.email !== undefined && input.email !== target.email.toLowerCase()) {
          if (statusOf(target) !== 'invited') {
            throw conflict(
              'EMAIL_LOCKED',
              'The email can only change while the account is invited',
            );
          }
          sets.push(sql`email = ${input.email}`, sql`must_change_password = true`);
          otherChanged = true;
          emailChanged = true;
        }
        if (input.role !== undefined && input.role !== target.role) {
          if (target.role === 'admin' && !target.banned) await this.assertAnotherAdmin(tx, id);
          sets.push(sql`role = ${input.role}`);
          roleChanged = true;
        }
        const plain: Array<[string, string | null | undefined, string | null]> = [
          ['name', input.name, target.name],
          ['phone', input.phone, target.phone],
          ['staff_code', input.staffCode, target.staff_code],
          ['language', input.language, target.language],
        ];
        for (const [column, next, current] of plain) {
          if (next !== undefined && next !== current) {
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
          await tx.execute(sql`DELETE FROM sessions WHERE user_id = ${id}::uuid`);
          await deleteTwoFactorChallenges(tx, id);
          inviteTokenId = await this.replaceInvite(tx, id);
        }
      });
    } catch (error) {
      this.rethrowUnique(error);
      throw error;
    }

    if (inviteTokenId) await this.queue(id, 'invite', inviteTokenId);
    if (roleChanged) {
      const detail = await this.get(id);
      this.emit(new StaffRoleChanged(this.context(actor, id), detail.role));
    }
    if (otherChanged) this.emit(new StaffUpdated(this.context(actor, id)));
    return this.get(id);
  }

  /**
   * Disables an account, deleting its sessions and unused links in the same transaction. Refuses
   * to disable the last active admin.
   */
  async disable(id: string, reason: string | undefined, actor: Actor): Promise<StaffDetail> {
    await this.db.transaction(async (tx) => {
      await this.lock(tx);
      const target = await this.find(tx, id, true);
      if (!target) throw notFound();
      if (id === actor.id) throw conflict('SELF_DISABLE', 'You cannot disable your own account');
      if (target.role === 'admin' && !target.banned) await this.assertAnotherAdmin(tx, id);

      await tx.execute(
        sql`UPDATE users SET banned = true, ban_reason = ${reason ?? null}, updated_at = now()
             WHERE id = ${id}::uuid`,
      );
      // The same transaction: a disabled person has no live session, and no link that could log them in.
      await tx.execute(sql`DELETE FROM sessions WHERE user_id = ${id}::uuid`);
      await deleteTokens(tx, id);
    });
    this.emit(new StaffDisabled(this.context(actor, id), reason ?? null));
    return this.get(id);
  }

  /** Re-enables a disabled account; 404 for an unknown id. */
  async enable(id: string, actor: Actor): Promise<StaffDetail> {
    if (!(await this.find(this.db, id))) throw notFound();
    const result = await this.db.execute(
      sql`UPDATE users SET banned = false, ban_reason = NULL, ban_expires = NULL, updated_at = now()
           WHERE id = ${id}::uuid`,
    );
    if ((result.rowCount ?? 0) === 0) throw notFound();
    this.emit(new StaffEnabled(this.context(actor, id)));
    return this.get(id);
  }

  /**
   * Admin reset (AC-18). The old password stops working at once: the stored hash is replaced in
   * the same transaction, by a temporary password, or by a random value nobody knows until the
   * person follows the emailed link. Sessions and older links go, and the lockout clears.
   */
  async resetPassword(id: string, actor: Actor): Promise<ResetStaffPasswordResponse> {
    refuseSelf(id, actor, 'reset the password of');
    const temporaryPassword = this.mailOn ? undefined : generateTemporaryPassword();
    const passwordHash = await hashPassword(
      temporaryPassword ?? randomBytes(32).toString('base64url'),
    );

    const done = await this.db.transaction(async (tx) => {
      const target = await this.find(tx, id, true);
      if (!target) throw notFound();
      await this.replacePassword(tx, id, passwordHash);
      await tx.execute(
        sql`UPDATE users SET must_change_password = true, updated_at = now() WHERE id = ${id}::uuid`,
      );
      await tx.execute(sql`DELETE FROM sessions WHERE user_id = ${id}::uuid`);
      await deleteTwoFactorChallenges(tx, id);
      let tokenId: string | undefined;
      if (this.mailOn) tokenId = (await issueToken(tx, id, 'reset')).tokenId;
      else await deleteTokens(tx, id);
      return { email: target.email, tokenId };
    });

    await this.lockout.reset(emailKey(done.email));
    if (done.tokenId) await this.queue(id, 'reset', done.tokenId);
    this.emit(new StaffPasswordReset(this.context(actor, id)));
    return {
      setup: temporaryPassword
        ? { mode: 'temporary_password', temporaryPassword }
        : { mode: 'email' },
    };
  }

  /**
   * Issues a fresh invite link to an account that has never signed in. Throws 409 `NOT_INVITED`
   * or `MAIL_DISABLED` when that cannot work.
   */
  async resendInvite(id: string, actor: Actor): Promise<{ ok: true }> {
    const target = await this.find(this.db, id);
    if (!target) throw notFound();
    if (statusOf(target) !== 'invited') {
      throw conflict('NOT_INVITED', 'Only an account that has not signed in yet can be re-invited');
    }
    if (!this.mailOn) throw conflict('MAIL_DISABLED', 'This install does not send email');
    const { tokenId } = await issueToken(this.db, id, 'invite');
    await this.queue(id, 'invite', tokenId);
    this.emit(new StaffUpdated(this.context(actor, id)));
    return { ok: true };
  }

  /**
   * Deletes every session of another person. Throws 409 `SELF_ACTION` when the admin targets
   * themselves.
   */
  async revokeSessions(id: string, actor: Actor): Promise<RevokeSessionsResponse> {
    refuseSelf(id, actor, 'sign out every session of');
    const target = await this.find(this.db, id);
    if (!target) throw notFound();
    const result = await this.db.execute(sql`DELETE FROM sessions WHERE user_id = ${id}::uuid`);
    this.emit(new StaffSessionsRevoked(this.context(actor, id)));
    return { count: result.rowCount ?? 0 };
  }

  /**
   * Turns off someone else's two factor and ends their sessions (AC-20), for a person who lost
   * their phone. Their password is untouched, so they sign in with it and can enroll again.
   */
  async resetTwoFactor(id: string, actor: Actor): Promise<StaffDetail> {
    refuseSelf(id, actor, 'reset the two factor of');
    await this.db.transaction(async (tx) => {
      const target = await this.find(tx, id, true);
      if (!target) throw notFound();
      await tx.execute(sql`DELETE FROM two_factors WHERE user_id = ${id}::uuid`);
      await tx.execute(
        sql`UPDATE users SET two_factor_enabled = false, updated_at = now() WHERE id = ${id}::uuid`,
      );
      await tx.execute(sql`DELETE FROM sessions WHERE user_id = ${id}::uuid`);
      await deleteTwoFactorChallenges(tx, id);
    });
    this.emit(new StaffTwoFactorReset(this.context(actor, id)));
    return this.get(id);
  }

  // ---- helpers ----

  private async find(executor: Pick<Database, 'execute'>, id: string, forUpdate = false) {
    // A malformed id is simply "not found", not a database error.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      return undefined;
    const result = await executor.execute<UserRow>(
      forUpdate
        ? sql`SELECT ${COLUMNS} FROM users WHERE id = ${id}::uuid AND ${this.staffOnly} FOR UPDATE`
        : sql`SELECT ${COLUMNS} FROM users WHERE id = ${id}::uuid AND ${this.staffOnly}`,
    );
    return result.rows[0];
  }

  /** Every change that could leave no active admin takes this lock first (AC-17). */
  private async lock(tx: Tx): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADMIN_RULE_LOCK})`);
  }

  /**
   * An active admin is a staff admin who is not disabled; one who has not signed in yet still
   * counts. A partner user never counts, whatever their row says (AC-28).
   */
  private async assertAnotherAdmin(tx: Tx, exceptId: string): Promise<void> {
    const others = await tx.execute(
      sql`SELECT 1 FROM users
          WHERE role = 'admin' AND NOT banned AND id <> ${exceptId}::uuid AND ${this.staffOnly}
          LIMIT 1`,
    );
    if (others.rows.length === 0) {
      throw conflict('LAST_ADMIN', 'There must always be at least one active administrator');
    }
  }

  private assertLanguage(language: string | undefined): Promise<void> {
    return assertLanguageEnabled(this.settings, language);
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
  private async replacePassword(tx: Tx, id: string, passwordHash: string): Promise<void> {
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

  private context(actor: Actor, targetId: string): AuthEventContext {
    return {
      actorId: actor.id,
      targetId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      at: new Date(),
    };
  }

  private emit(event: AuthEvent): void {
    this.audit.record(event);
  }

  private toRow(row: UserRow): StaffRow {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      role: StaffRole.catch('staff').parse(row.role),
      status: statusOf(row),
      lastSignInAt: row.last_sign_in_at ? iso(row.last_sign_in_at) : null,
      twoFactorEnabled: row.two_factor_enabled,
    };
  }

  private toDetail(row: UserRow): StaffDetail {
    return {
      ...this.toRow(row),
      phone: row.phone,
      staffCode: row.staff_code,
      language: row.language,
      disableReason: row.banned ? row.ban_reason : null,
      createdAt: iso(row.created_at),
    };
  }
}
