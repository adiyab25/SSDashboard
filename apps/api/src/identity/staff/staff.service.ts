import { Inject, Injectable } from '@nestjs/common';
import {
  StaffHat,
  type CreateStaffRequest,
  type CreateStaffResponse,
  type ResetStaffPasswordResponse,
  type RevokeSessionsResponse,
  type StaffDetail,
  type StaffListQuery,
  type StaffListResponse,
  type StaffRow,
  type UpdateStaffRequest,
} from '@ssdashboard/contracts';
import { sql, type Database, type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../../database/database.module.js';
import {
  StaffCreated,
  StaffDisabled,
  StaffEnabled,
  StaffPasswordReset,
  StaffSessionsRevoked,
  StaffTwoFactorReset,
  StaffUpdated,
} from '../../platform/events/auth-events.js';
import type { Actor } from '../access/actor.js';
import {
  AccountActions,
  statusOf,
  type AccountKind,
  type AccountRowBase,
} from '../accounts/account-actions.js';
import { judgeStaffSet, refuseCostChangeWithoutCost } from '../hats/access-rules.js';
import { HatService } from '../hats/hat.service.js';
import {
  holdsHat,
  SESSION_AUDIENCES,
  type SessionAudiences,
} from '../sessions/session-audiences.js';

interface UserRow extends AccountRowBase {
  name: string;
  email: string;
  /** The person's hats, read with the row. */
  hats: string[];
  /** Whether the person holds the `cost.view` grant, read with the row. */
  cost_view: boolean;
  /** `users.updated_at` as text to the microsecond, the `updatedAt` of the access change. */
  updated_at_text: string;
  banned: boolean;
  ban_reason: string | null;
  phone: string | null;
  staff_code: string | null;
  language: string | null;
  two_factor_enabled: boolean;
  /** Raw `execute` rows hand timestamps back as text, so both forms are read. */
  last_sign_in_at: Date | string | null;
  created_at: Date | string;
}

const COLUMNS = sql`id, name, email, banned, ban_reason, phone, staff_code, language,
  two_factor_enabled, last_sign_in_at, created_at,
  coalesce((SELECT array_agg(h.hat) FROM hat_assignments h WHERE h.user_id = users.id), '{}') AS hats,
  EXISTS (SELECT 1 FROM permission_grants g
           WHERE g.user_id = users.id AND g.permission = 'cost.view') AS cost_view,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_text`;

/** The person's staff hats in catalog order (a staff row never holds `partner`). */
const staffHatsOf = (row: { hats: readonly string[] }): StaffHat[] => {
  const held = new Set(row.hats);
  return StaffHat.options.filter((hat) => held.has(hat));
};

const iso = (value: Date | string): string => new Date(value).toISOString();

/**
 * Staff administration (spec 0005, AC-12 to AC-18). The account mechanics (invites, resets,
 * lockout, sessions, the transaction checked writes and their audit entries) are the shared
 * `AccountActions`, run with the staff {@link AccountKind}: staff only, the last manager guarded
 * on disable. Hats and the cost grant are written only by `HatService` (spec 0008): a new person's
 * first set inside `create`'s transaction, every later change through `PUT /api/staff/:id/access`.
 *
 * Staff only (AC-28): every read of a person goes through `SessionAudiences.staffCondition()`,
 * so a partner user is never listed, found (404 for every action), counted as an admin, or made
 * one. Never read `users` here without that condition.
 */
@Injectable()
export class StaffService {
  private readonly db: Database;
  private readonly kind: AccountKind;

  /**
   * Takes the app database connection, the `SessionAudiences` port that says who is staff, the
   * hat service that writes a new person's first hats, and the shared account mechanics.
   */
  constructor(
    @Inject(DATABASE) connection: DatabaseConnection,
    @Inject(SESSION_AUDIENCES) audiences: SessionAudiences,
    private readonly hats: HatService,
    private readonly accounts: AccountActions,
  ) {
    this.db = connection.db;
    this.kind = {
      noun: 'staff account',
      only: () => audiences.staffCondition(),
      guardsLastManager: true,
      events: {
        updated: (context) => new StaffUpdated(context),
        disabled: (context, reason) => new StaffDisabled(context, reason),
        enabled: (context) => new StaffEnabled(context),
        passwordReset: (context) => new StaffPasswordReset(context),
        sessionsRevoked: (context) => new StaffSessionsRevoked(context),
        twoFactorReset: (context) => new StaffTwoFactorReset(context),
      },
    };
  }

  /**
   * One keyset page of staff ordered by name, with the optional search and filters of the query.
   * Throws `InvalidAccountCursorError` for a cursor this endpoint did not issue.
   */
  async list(query: StaffListQuery): Promise<StaffListResponse> {
    const extra = query.hat === undefined ? [] : [holdsHat(query.hat)];
    const page = await this.accounts.page<UserRow>(this.kind, query, COLUMNS, extra);
    return { rows: page.rows.map((row) => this.toRow(row)), nextCursor: page.nextCursor };
  }

  /** One account's detail; throws 404 `NOT_FOUND` for an unknown id. */
  async get(id: string): Promise<StaffDetail> {
    const row = await this.accounts.find<UserRow>(this.db, this.kind, id, COLUMNS);
    if (!row) throw this.accounts.notFound(this.kind);
    return this.toDetail(row);
  }

  /**
   * Creates an account and queues an invite when the install sends email, or returns a temporary
   * password to hand over otherwise.
   */
  async create(input: CreateStaffRequest, actor: Actor): Promise<CreateStaffResponse> {
    // The access rules first: nothing slow runs for a set that is refused anyway.
    judgeStaffSet(input.hats, input.costView);
    if (input.costView) refuseCostChangeWithoutCost(actor);
    const { id, setup } = await this.accounts.create(input, actor, (tx, userId) =>
      this.hats.giveFirstAccess(tx, userId, input.hats, input.costView, actor),
    );
    const staff = await this.get(id);
    this.accounts.emit(
      new StaffCreated(this.accounts.context(actor, id), staff.hats, staff.costView),
    );
    return { staff, setup };
  }

  /**
   * Changes name, contact details or language, and the email while the person is still invited.
   * Hats and the cost grant are not here: they change only through `HatService`
   * (`PUT /api/staff/:id/access`).
   */
  async update(id: string, input: UpdateStaffRequest, actor: Actor): Promise<StaffDetail> {
    await this.accounts.update(this.kind, id, input, actor);
    return this.get(id);
  }

  /**
   * Disables an account, deleting its sessions and unused links in the same transaction. Refuses
   * to disable the last active manager.
   */
  async disable(id: string, reason: string | undefined, actor: Actor): Promise<StaffDetail> {
    await this.accounts.disable(this.kind, id, reason, actor);
    return this.get(id);
  }

  /** Re-enables a disabled account; 404 for an unknown id. */
  async enable(id: string, actor: Actor): Promise<StaffDetail> {
    await this.accounts.enable(this.kind, id, actor);
    return this.get(id);
  }

  /** Admin reset (AC-18): the old password stops working at once; sessions and older links go. */
  async resetPassword(id: string, actor: Actor): Promise<ResetStaffPasswordResponse> {
    return { setup: await this.accounts.resetPassword(this.kind, id, actor) };
  }

  /** Issues a fresh invite link to an account that has never signed in. */
  async resendInvite(id: string, actor: Actor): Promise<{ ok: true }> {
    await this.accounts.resendInvite(this.kind, id, actor);
    return { ok: true };
  }

  /** Deletes every session of another person (`POST /api/staff/:id/revoke-sessions`). */
  async revokeSessions(id: string, actor: Actor): Promise<RevokeSessionsResponse> {
    return { count: await this.accounts.revokeSessions(this.kind, id, actor) };
  }

  /** Turns off someone else's two factor and ends their sessions (AC-20). */
  async resetTwoFactor(id: string, actor: Actor): Promise<StaffDetail> {
    await this.accounts.resetTwoFactor(this.kind, id, actor);
    return this.get(id);
  }

  private toRow(row: UserRow): StaffRow {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      hats: staffHatsOf(row),
      costView: row.cost_view,
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
      updatedAt: row.updated_at_text,
    };
  }
}
