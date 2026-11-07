import { Inject, Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { Hat, type AccessHolding, type AccessRequest } from '@ssdashboard/contracts';
import { sql, type Database, type DatabaseConnection, type SQL } from '@ssdashboard/db';
import { DATABASE } from '../../database/database.module.js';
import { pgArray, type Transaction } from '../../database/sql.js';
import { HatsChanged } from '../../platform/events/auth-events.js';
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

const notFound = () =>
  new NotFoundException({ code: 'NOT_FOUND', message: 'No such staff account' });

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
 * It must never write outside the transaction that checked the rules, never decide an audience
 * other than by `audiencesOfHats`, and never put an email, a name or a phone in the log, the event
 * or the audit entry.
 */
@Injectable()
export class HatService {
  private readonly db: Database;

  /**
   * Takes the app database connection, the `SessionAudiences` port (its `staffCondition()` keeps a
   * partner user out of the staff route), the auth log, and the identity audit port.
   */
  constructor(
    @Inject(DATABASE) connection: DatabaseConnection,
    @Inject(SESSION_AUDIENCES) private readonly audiences: SessionAudiences,
    private readonly authAudit: AuthAudit,
    @Inject(IDENTITY_AUDIT) private readonly audit: IdentityAudit,
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
      const target = await this.lockTarget(tx, id, change.updatedAt);
      if (!target) throw notFound();
      if (!target.fresh) {
        throw new ConflictException({
          code: 'STALE_RECORD',
          message: 'This person changed since you opened them. Reload and try again.',
        });
      }
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

      await this.write(tx, id, diff, actor.id);
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
        // The registry says `optional` for `hat.revoked`; the manager hat's revoke tightens it, so
        // the audit trail refuses it too, behind `requireReasonForManagerRemoval` above.
        ...(diff.removed.includes('manager') && { reasonRequired: true as const }),
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
    );
    return holding;
  }

  /** Reads and locks the staff person's row with their holding and the stale check. */
  private async lockTarget(
    tx: Transaction,
    id: string,
    updatedAt: string,
  ): Promise<TargetRow | undefined> {
    const staffOnly: SQL = this.audiences.staffCondition();
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
           WHERE id = ${id}::uuid AND (${staffOnly})
             FOR UPDATE OF users`,
    );
    return result.rows[0];
  }

  /**
   * Deletes the hats and grant the change takes, inserts the ones it gives (kept rows keep their
   * `granted_by` and `granted_at`), and marks the person changed, so the next `updatedAt` differs.
   */
  private async write(
    tx: Transaction,
    userId: string,
    diff: HoldingDiff,
    grantedBy: string,
  ): Promise<void> {
    if (diff.removed.length > 0) {
      await tx.execute(
        sql`DELETE FROM hat_assignments
             WHERE user_id = ${userId}::uuid AND hat = ANY(${pgArray(diff.removed)}::text[])`,
      );
    }
    if (diff.added.length > 0) {
      await tx.execute(
        sql`INSERT INTO hat_assignments (user_id, hat, granted_by)
            SELECT ${userId}::uuid, hat, ${grantedBy}::uuid
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
