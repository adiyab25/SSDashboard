import { Inject, Injectable } from '@nestjs/common';
import type {
  CreatePartnerUserRequest,
  CreatePartnerUserResponse,
  PartnerAccessRequest,
  PartnerAccount,
  PartnerUserDetail,
  PartnerUserListQuery,
  PartnerUserListResponse,
  PartnerUserRow,
  ResetStaffPasswordResponse,
  RevokeSessionsResponse,
  UpdatePartnerUserRequest,
} from '@ssdashboard/contracts';
import { sql, type Database, type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../../database/database.module.js';
import { PartnerAccounts } from '../../partners/partner-accounts.service.js';
import {
  PartnerUserCreated,
  PartnerUserDisabled,
  PartnerUserEnabled,
  PartnerUserPasswordReset,
  PartnerUserSessionsRevoked,
  PartnerUserTwoFactorReset,
  PartnerUserUpdated,
} from '../../platform/events/auth-events.js';
import type { Actor } from '../access/actor.js';
import {
  AccountActions,
  statusOf,
  type AccountKind,
  type AccountRowBase,
} from '../accounts/account-actions.js';
import { HatService } from '../hats/hat.service.js';
import { SESSION_AUDIENCES, type SessionAudiences } from '../sessions/session-audiences.js';

interface PartnerUserDbRow extends AccountRowBase {
  name: string;
  email: string;
  /** The account of the person's `partner` hat row. */
  partner_account_id: string;
  /** `users.updated_at` as text to the microsecond, the `updatedAt` of the account move. */
  updated_at_text: string;
  banned: boolean;
  ban_reason: string | null;
  phone: string | null;
  language: string | null;
  two_factor_enabled: boolean;
  /** Raw `execute` rows hand timestamps back as text, so both forms are read. */
  last_sign_in_at: Date | string | null;
  created_at: Date | string;
}

const COLUMNS = sql`id, name, email, banned, ban_reason, phone, language, two_factor_enabled,
  last_sign_in_at, created_at,
  (SELECT h.partner_account_id FROM hat_assignments h
    WHERE h.user_id = users.id AND h.hat = 'partner') AS partner_account_id,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_text`;

const iso = (value: Date | string): string => new Date(value).toISOString();

/**
 * The logins of consignment partners (spec 0008, AC-15), run by a person with `people.manage`
 * under `/api/partner-users`: the spec 0005 invite, reset and lockout mechanics unchanged, through
 * the shared `AccountActions` with the partner {@link AccountKind}. A partner user wears the
 * `partner` hat only, bound to one partner account, never the cost grant and never `manager`;
 * `HatService` writes that hat (on create, and on a move to another account).
 *
 * Partner users only: every read of a person goes through `SessionAudiences.partnerCondition()`,
 * so a staff id is never listed or found here (404 for every action), as a partner user never is
 * on `/api/staff`. Never read `users` here without that condition, and never read `parties`:
 * partner accounts come from the partners module's `PartnerAccounts`.
 */
@Injectable()
export class PartnerUserService {
  private readonly db: Database;
  private readonly kind: AccountKind;

  /**
   * Takes the app database connection, the `SessionAudiences` port that says who is a partner
   * user, the hat service, the shared account mechanics, and `PartnerAccounts`.
   */
  constructor(
    @Inject(DATABASE) connection: DatabaseConnection,
    @Inject(SESSION_AUDIENCES) audiences: SessionAudiences,
    private readonly hats: HatService,
    private readonly accounts: AccountActions,
    @Inject(PartnerAccounts) private readonly partners: Pick<PartnerAccounts, 'list'>,
  ) {
    this.db = connection.db;
    this.kind = {
      noun: 'partner login',
      only: () => audiences.partnerCondition(),
      guardsLastManager: false,
      events: {
        updated: (context) => new PartnerUserUpdated(context),
        disabled: (context, reason) => new PartnerUserDisabled(context, reason),
        enabled: (context) => new PartnerUserEnabled(context),
        passwordReset: (context) => new PartnerUserPasswordReset(context),
        sessionsRevoked: (context) => new PartnerUserSessionsRevoked(context),
        twoFactorReset: (context) => new PartnerUserTwoFactorReset(context),
      },
    };
  }

  /**
   * One keyset page of partner users ordered by name, optionally of one partner account. Throws
   * `InvalidAccountCursorError` for a cursor this endpoint did not issue.
   */
  async list(query: PartnerUserListQuery): Promise<PartnerUserListResponse> {
    const extra =
      query.partnerAccountId === undefined
        ? []
        : [
            sql`EXISTS (SELECT 1 FROM hat_assignments h WHERE h.user_id = users.id
                  AND h.hat = 'partner' AND h.partner_account_id = ${query.partnerAccountId}::uuid)`,
          ];
    const page = await this.accounts.page<PartnerUserDbRow>(this.kind, query, COLUMNS, extra);
    return { rows: page.rows.map((row) => this.toRow(row)), nextCursor: page.nextCursor };
  }

  /** One partner login's detail; 404 `NOT_FOUND` for an unknown id or a staff id. */
  async get(id: string): Promise<PartnerUserDetail> {
    const row = await this.accounts.find<PartnerUserDbRow>(this.db, this.kind, id, COLUMNS);
    if (!row) throw this.accounts.notFound(this.kind);
    return this.toDetail(row);
  }

  /** The partner accounts a login can be bound to: consignment partners, from `PartnerAccounts`. */
  partnerAccounts(): Promise<PartnerAccount[]> {
    return this.partners.list();
  }

  /**
   * Creates a partner login bound to `partnerAccountId` (422 `UNKNOWN_PARTNER_ACCOUNT` when it is
   * not a consignment partner, checked in the creating transaction) and queues an invite when the
   * install sends email, or returns a temporary password to hand over otherwise.
   */
  async create(input: CreatePartnerUserRequest, actor: Actor): Promise<CreatePartnerUserResponse> {
    const { partnerAccountId, ...details } = input;
    const { id, setup } = await this.accounts.create(details, actor, (tx, userId) =>
      this.hats.givePartnerAccess(tx, userId, partnerAccountId, actor),
    );
    const partnerUser = await this.get(id);
    this.accounts.emit(
      new PartnerUserCreated(this.accounts.context(actor, id), partnerUser.partnerAccountId),
    );
    return { partnerUser, setup };
  }

  /** Changes name, contact details or language, and the email while the person is invited. */
  async update(
    id: string,
    input: UpdatePartnerUserRequest,
    actor: Actor,
  ): Promise<PartnerUserDetail> {
    await this.accounts.update(this.kind, id, input, actor);
    return this.get(id);
  }

  /**
   * Binds the partner user to another partner account through `HatService`, which ends their
   * sessions in the same transaction (spec 0005 AC-33 b).
   */
  async move(id: string, change: PartnerAccessRequest, actor: Actor): Promise<PartnerUserDetail> {
    await this.hats.movePartnerUser(id, change, actor);
    return this.get(id);
  }

  /** Disables a partner login, ending its sessions and unused links in the same transaction. */
  async disable(id: string, reason: string | undefined, actor: Actor): Promise<PartnerUserDetail> {
    await this.accounts.disable(this.kind, id, reason, actor);
    return this.get(id);
  }

  /** Re-enables a disabled partner login. */
  async enable(id: string, actor: Actor): Promise<PartnerUserDetail> {
    await this.accounts.enable(this.kind, id, actor);
    return this.get(id);
  }

  /** Resets the password: the old one stops working at once; sessions and older links go. */
  async resetPassword(id: string, actor: Actor): Promise<ResetStaffPasswordResponse> {
    return { setup: await this.accounts.resetPassword(this.kind, id, actor) };
  }

  /** Issues a fresh invite link to a partner login that has never signed in. */
  async resendInvite(id: string, actor: Actor): Promise<{ ok: true }> {
    await this.accounts.resendInvite(this.kind, id, actor);
    return { ok: true };
  }

  /** Signs the partner user out everywhere. */
  async revokeSessions(id: string, actor: Actor): Promise<RevokeSessionsResponse> {
    return { count: await this.accounts.revokeSessions(this.kind, id, actor) };
  }

  /** Turns off the partner user's two factor and ends their sessions. */
  async resetTwoFactor(id: string, actor: Actor): Promise<PartnerUserDetail> {
    await this.accounts.resetTwoFactor(this.kind, id, actor);
    return this.get(id);
  }

  private toRow(row: PartnerUserDbRow): PartnerUserRow {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      partnerAccountId: row.partner_account_id,
      status: statusOf(row),
      lastSignInAt: row.last_sign_in_at ? iso(row.last_sign_in_at) : null,
      twoFactorEnabled: row.two_factor_enabled,
    };
  }

  private toDetail(row: PartnerUserDbRow): PartnerUserDetail {
    return {
      ...this.toRow(row),
      phone: row.phone,
      language: row.language,
      disableReason: row.banned ? row.ban_reason : null,
      createdAt: iso(row.created_at),
      updatedAt: row.updated_at_text,
    };
  }
}
