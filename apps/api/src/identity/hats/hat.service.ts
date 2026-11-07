import { Inject, Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import {
  Hat,
  type AccessHolding,
  type AccessRequest,
  type PartnerAccessRequest,
} from '@ssdashboard/contracts';
import { sql, type Database, type DatabaseConnection, type SQL } from '@ssdashboard/db';
import { DATABASE } from '../../database/database.module.js';
import { pgArray, type Transaction } from '../../database/sql.js';
import { HatsChanged } from '../../platform/events/auth-events.js';
import { PartnerAccounts } from '../../partners/partner-accounts.service.js';
import { auditActorOf, type Actor } from '../access/actor.js';
import { IDENTITY_AUDIT, type IdentityAudit } from '../audit-port/identity-audit.js';
import { hatChangeLogLine } from '../sessions/hat-change-log.js';
import { hatChangeEndsSessions, revokeSessions } from '../sessions/revoke-sessions.js';
import {
  audiencesOfHats,
  SESSION_AUDIENCES,
  type SessionAudiences,
} from '../sessions/session-audiences.js';
import { AuthAudit } from '../sign-in/auth-audit.service.js';
import {
  auditActionOf,
  diffHoldings,
  judgeStaffSet,
  normalHolding,
  refuseCostChangeWithoutCost,
  unknownPartnerAccount,
  refuseSelfChange,
  requireReasonForManagerRemoval,
  type HoldingDiff,
} from './access-rules.js';
import { assertAnotherManager, lockAdminRule } from './last-manager.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The person's row and holding as the change reads them, under the row lock. */
interface TargetRow extends Record<string, unknown> {
  banned: boolean;
  /** Whether `users.updated_at` equals the `updatedAt` the caller read before. */
  fresh: boolean;
  hats: string[];
  cost_view: boolean;
  partner_account_id: string | null;
}

/** What a committed change hands to the log line and the event. */
interface Committed {
  before: AccessHolding;
  after: AccessHolding;
  diff: HoldingDiff;
}

const notFound = (noun = 'staff account') =>
  new NotFoundException({ code: 'NOT_FOUND', message: `No such ${noun}` });
const stale = () =>
  new ConflictException({
    code: 'STALE_RECORD',
    message: 'This person changed since you opened them. Reload and try again.',
  });

/** The only holding a partner user has: the partner hat, bound to one account, never cost. */
const partnerHolding = (partnerAccountId: string): AccessHolding => ({
  hats: ['partner'],
  costView: false,
  partnerAccountId,
});

/**
 * Gives and takes hats and the cost grant (spec 0008, AC-7, AC-12, AC-13): the only writer of
 * `hat_assignments` and `permission_grants` outside the migration and `create-admin`'s first
 * manager. A change replaces the person's whole set in one transaction:
 *
 * 1. refuses a change to oneself (409 `SELF_HAT_CHANGE`) and a set no person may hold (422 `NO_HAT`,
 *    `HAT_CONFLICT`, `GRANT_NOT_ALLOWED`) before it opens the transaction;
 * 2. takes `ADMIN_RULE_LOCK` when the new set has no `manager`, then locks the person's `users`
 *    row `FOR UPDATE`, staff only (404 for anyone else), and checks the caller's `updatedAt`
 *    against `users.updated_at` (409 `STALE_RECORD`, nothing changed);
 * 3. needs `cost.view` on the actor to add or remove the cost grant (403 `FORBIDDEN`), a reason to
 *    take `manager` away (422 `REASON_REQUIRED`), and another active manager when it does (409
 *    `LAST_ADMIN`);
 * 4. writes only the hats and grant that change (`granted_by` is the actor), sets
 *    `users.updated_at`, ends the person's sessions through `revokeSessions(userId, tx)` when
 *    `hatChangeEndsSessions` says so (a staff to staff change never does), and writes one audit
 *    entry through the identity audit port, all in that transaction;
 * 5. after the commit, and only then, writes one log line and emits one `HatsChanged`.
 *
 * A partner user's hat is given by `givePartnerAccess` (inside the creating transaction) and moved
 * to another account by `movePartnerUser`, by the same steps with the partner condition, and a
 * consignment partner checked through the partners module's `PartnerAccounts`.
 *
 * It must never write outside the transaction that checked the rules, never decide an audience
 * other than by `audiencesOfHats`, and never put an email, a name or a phone in the log, the event
 * or the audit entry.
 */
@Injectable()
export class HatService {
  private readonly db: Database;

  /**
   * Takes the app database connection, the `SessionAudiences` port (its `staffCondition()` keeps a
   * partner user out of the staff route, its `partnerCondition()` staff out of the partner one),
   * the auth log, the identity audit port, and the partners module's `PartnerAccounts`, which says
   * whether an id is a consignment partner (identity never reads `parties`).
   */
  constructor(
    @Inject(DATABASE) connection: DatabaseConnection,
    @Inject(SESSION_AUDIENCES) private readonly audiences: SessionAudiences,
    private readonly authAudit: AuthAudit,
    @Inject(IDENTITY_AUDIT) private readonly audit: IdentityAudit,
    @Inject(PartnerAccounts)
    private readonly partners: Pick<PartnerAccounts, 'isConsignmentPartner'>,
  ) {
    this.db = connection.db;
  }

  /**
   * Replaces a staff person's hats and cost grant with `change` (`PUT /api/staff/:id/access`).
   * Returns whether anything changed: the same set is no write, no audit entry and no event (the
   * stale check still applies).
   */
  async replaceStaffAccess(id: string, change: AccessRequest, actor: Actor): Promise<boolean> {
    refuseSelfChange(id, actor);
    judgeStaffSet(change.hats, change.costView);
    if (!UUID.test(id)) throw notFound();
    const after = normalHolding({
      hats: change.hats,
      costView: change.costView,
      partnerAccountId: null,
    });

    const committed = await this.db.transaction(async (tx): Promise<Committed | undefined> => {
      // The lock before the row, as every writer of the last manager rule takes them.
      const mayRemoveManager = !after.hats.includes('manager');
      if (mayRemoveManager) await lockAdminRule(tx);
      const target = await this.lockTarget(
        tx,
        id,
        change.updatedAt,
        this.audiences.staffCondition(),
      );
      if (!target) throw notFound();
      if (!target.fresh) throw stale();
      const before = normalHolding({
        hats: target.hats.map((hat) => Hat.parse(hat)),
        costView: target.cost_view,
        partnerAccountId: target.partner_account_id,
      });
      const diff = diffHoldings(before, after);
      if (!diff.changed) return undefined;

      if (diff.costAdded || diff.costRemoved) refuseCostChangeWithoutCost(actor);
      requireReasonForManagerRemoval(diff, change.reason);
      if (diff.removed.includes('manager') && !target.banned) {
        await assertAnotherManager(tx, id, this.audiences.staffCondition());
      }

      await this.write(tx, id, diff, actor.id, after.partnerAccountId);
      const ends = hatChangeEndsSessions(
        { audiences: audiencesOfHats(before.hats), partnerAccountId: before.partnerAccountId },
        { audiences: audiencesOfHats(after.hats), partnerAccountId: after.partnerAccountId },
      );
      if (ends) await revokeSessions(id, tx);
      await this.audit.record(tx, {
        actor: auditActorOf(actor, 'people.manage'),
        action: auditActionOf(diff),
        record: { type: 'user', id },
        before: { ...before },
        after: { ...after },
        ...(change.reason !== undefined && { reason: change.reason }),
        correlationId: this.audit.newCorrelationId(),
      });
      return { before, after, diff };
    });

    if (!committed) return false;
    this.announce(id, actor, committed, change.reason);
    return true;
  }

  /**
   * Gives a person just created by `POST /api/staff` their first hats and cost grant, inside the
   * caller's transaction (the one that inserted the person), with `granted_by` the actor. The set
   * rules and the cost rule apply as on a change; the self rule cannot (the person is new). The
   * caller records the creation (`staff_user.created`, `StaffCreated`) with the holding returned.
   */
  async giveFirstAccess(
    tx: Transaction,
    userId: string,
    hats: readonly Hat[],
    costView: boolean,
    actor: Actor,
  ): Promise<AccessHolding> {
    judgeStaffSet(hats, costView);
    if (costView) refuseCostChangeWithoutCost(actor);
    const holding = normalHolding({ hats: [...hats], costView, partnerAccountId: null });
    await this.write(
      tx,
      userId,
      diffHoldings({ hats: [], costView: false, partnerAccountId: null }, holding),
      actor.id,
      null,
    );
    return holding;
  }

  /**
   * Gives a partner user just created by `POST /api/partner-users` their one hat, `partner`, bound
   * to `partnerAccountId`, inside the caller's transaction (the one that inserted the person),
   * with `granted_by` the actor (spec 0008, AC-9 and AC-15). Refuses an id that is not a
   * consignment partner (422 `UNKNOWN_PARTNER_ACCOUNT`), asked of `PartnerAccounts` in the same
   * transaction. A partner user never gets another hat or the cost grant.
   */
  async givePartnerAccess(
    tx: Transaction,
    userId: string,
    partnerAccountId: string,
    actor: Actor,
  ): Promise<AccessHolding> {
    if (!(await this.partners.isConsignmentPartner(partnerAccountId, tx))) {
      throw unknownPartnerAccount();
    }
    const holding = partnerHolding(partnerAccountId);
    await this.write(
      tx,
      userId,
      diffHoldings({ hats: [], costView: false, partnerAccountId: null }, holding),
      actor.id,
      partnerAccountId,
    );
    return holding;
  }

  /**
   * Binds a partner user to another partner account (`PUT /api/partner-users/:id/access`, spec
   * 0008 AC-12): under the person's `users` row lock (partner users only, 404 for anyone else),
   * the stale check (409 `STALE_RECORD`), a consignment partner only (422
   * `UNKNOWN_PARTNER_ACCOUNT`), the partner row replaced, `users.updated_at` set, every session
   * ended through `revokeSessions(userId, tx)` (spec 0005 AC-33 b) and one audit entry
   * (`hat.revoked`: the old binding is taken), all in one transaction; the log line and
   * `HatsChanged` after the commit. The same account is no write. Returns whether it changed.
   */
  async movePartnerUser(id: string, change: PartnerAccessRequest, actor: Actor): Promise<boolean> {
    refuseSelfChange(id, actor);
    if (!UUID.test(id)) throw notFound('partner login');
    const after = partnerHolding(change.partnerAccountId);

    const committed = await this.db.transaction(async (tx): Promise<Committed | undefined> => {
      const target = await this.lockTarget(
        tx,
        id,
        change.updatedAt,
        this.audiences.partnerCondition(),
      );
      if (!target) throw notFound('partner login');
      if (!target.fresh) throw stale();
      const before = normalHolding({
        hats: target.hats.map((hat) => Hat.parse(hat)),
        costView: target.cost_view,
        partnerAccountId: target.partner_account_id,
      });
      const diff = diffHoldings(before, after);
      if (!diff.changed) return undefined;
      if (!(await this.partners.isConsignmentPartner(change.partnerAccountId, tx))) {
        throw unknownPartnerAccount();
      }

      await this.write(tx, id, diff, actor.id, after.partnerAccountId);
      const ends = hatChangeEndsSessions(
        { audiences: audiencesOfHats(before.hats), partnerAccountId: before.partnerAccountId },
        { audiences: audiencesOfHats(after.hats), partnerAccountId: after.partnerAccountId },
      );
      if (ends) await revokeSessions(id, tx);
      await this.audit.record(tx, {
        actor: auditActorOf(actor, 'people.manage'),
        action: auditActionOf(diff),
        record: { type: 'user', id },
        before: { ...before },
        after: { ...after },
        ...(change.reason !== undefined && { reason: change.reason }),
        correlationId: this.audit.newCorrelationId(),
      });
      return { before, after, diff };
    });

    if (!committed) return false;
    this.announce(id, actor, committed, change.reason);
    return true;
  }

  /**
   * Reads and locks the person's row with their holding and the stale check, only when they are
   * of the kind `only` names (`staffCondition()` or `partnerCondition()`).
   */
  private async lockTarget(
    tx: Transaction,
    id: string,
    updatedAt: string,
    only: SQL,
  ): Promise<TargetRow | undefined> {
    const result = await tx.execute<TargetRow>(
      sql`SELECT banned,
                 updated_at = ${updatedAt}::timestamptz AS fresh,
                 coalesce((SELECT array_agg(h.hat ORDER BY h.hat) FROM hat_assignments h
                            WHERE h.user_id = users.id), '{}') AS hats,
                 EXISTS (SELECT 1 FROM permission_grants g
                          WHERE g.user_id = users.id AND g.permission = 'cost.view') AS cost_view,
                 (SELECT h.partner_account_id FROM hat_assignments h
                   WHERE h.user_id = users.id AND h.hat = 'partner') AS partner_account_id
            FROM users
           WHERE id = ${id}::uuid AND (${only})
             FOR UPDATE OF users`,
    );
    return result.rows[0];
  }

  /**
   * Deletes the hats and grant the change takes, inserts the ones it gives (kept rows keep their
   * `granted_by` and `granted_at`; a `partner` row is bound to `partnerAccountId`), replaces the
   * partner row when the person moves to another account (the app role has no `UPDATE` on the
   * hat tables), and marks the person changed, so the next `updatedAt` differs.
   */
  private async write(
    tx: Transaction,
    userId: string,
    diff: HoldingDiff,
    grantedBy: string,
    partnerAccountId: string | null,
  ): Promise<void> {
    if (diff.accountMoved) {
      await tx.execute(
        sql`DELETE FROM hat_assignments WHERE user_id = ${userId}::uuid AND hat = 'partner'`,
      );
      await tx.execute(
        sql`INSERT INTO hat_assignments (user_id, hat, partner_account_id, granted_by)
            VALUES (${userId}::uuid, 'partner', ${partnerAccountId}::uuid, ${grantedBy}::uuid)`,
      );
    }
    if (diff.removed.length > 0) {
      await tx.execute(
        sql`DELETE FROM hat_assignments
             WHERE user_id = ${userId}::uuid AND hat = ANY(${pgArray(diff.removed)}::text[])`,
      );
    }
    if (diff.added.length > 0) {
      await tx.execute(
        sql`INSERT INTO hat_assignments (user_id, hat, partner_account_id, granted_by)
            SELECT ${userId}::uuid, hat,
                   CASE WHEN hat = 'partner' THEN ${partnerAccountId}::uuid END, ${grantedBy}::uuid
              FROM unnest(${pgArray(diff.added)}::text[]) AS hat`,
      );
    }
    if (diff.costRemoved) {
      await tx.execute(
        sql`DELETE FROM permission_grants
             WHERE user_id = ${userId}::uuid AND permission = 'cost.view'`,
      );
    }
    if (diff.costAdded) {
      await tx.execute(
        sql`INSERT INTO permission_grants (user_id, permission, granted_by)
            VALUES (${userId}::uuid, 'cost.view', ${grantedBy}::uuid)`,
      );
    }
    await tx.execute(sql`UPDATE users SET updated_at = now() WHERE id = ${userId}::uuid`);
  }

  /** The log line and the `HatsChanged` event of a committed change (spec 0008, AC-13). */
  private announce(
    targetId: string,
    actor: Actor,
    committed: Committed,
    reason: string | undefined,
  ): void {
    const context = {
      actorId: actor.id,
      targetId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      at: new Date(),
    };
    const { before, after } = committed;
    this.authAudit.hatsChanged(
      hatChangeLogLine(context, before.hats, after.hats, {
        before,
        after,
        ...(reason !== undefined && { reason }),
      }),
      new HatsChanged(context, before, after, reason ?? null),
    );
  }
}
