import {
  ConflictException,
  UnprocessableEntityException,
  type HttpException,
} from '@nestjs/common';
import { Hat, type AccessHolding } from '@ssdashboard/contracts';
import { forbidden } from '../../platform/access/permission.guard.js';
import type { Actor } from '../access/actor.js';
import type { IdentityAuditAction } from '../audit-port/identity-audit.js';

const unprocessable = (code: string, message: string): HttpException =>
  new UnprocessableEntityException({ code, message });
const conflict = (code: string, message: string): HttpException =>
  new ConflictException({ code, message });

/**
 * The rules a set of hats and a cost grant must keep whatever the route (spec 0008, State
 * transitions "Valid sets"): at least one hat (422 `NO_HAT`), `partner` alone (422
 * `HAT_CONFLICT`), and never cost with `partner` (422 `GRANT_NOT_ALLOWED`). Pure; throws the
 * answer, returns nothing. The database checks hold the rest (known hats, one row per hat).
 */
export function judgeHoldingSet(hats: readonly Hat[], costView: boolean): void {
  if (hats.length === 0) throw unprocessable('NO_HAT', 'A person needs at least one hat');
  if (hats.includes('partner') && costView) {
    throw unprocessable('GRANT_NOT_ALLOWED', 'A partner user can never see cost');
  }
  if (hats.includes('partner') && hats.length > 1) {
    throw unprocessable('HAT_CONFLICT', 'The partner hat is never worn with another hat');
  }
}

/**
 * The set rules of {@link judgeHoldingSet} plus the staff route's own: `partner` is never given
 * through `/api/staff` (422 `HAT_CONFLICT`); a partner user comes only through
 * `/api/partner-users` (spec 0008, AC-12 and AC-14), and no route moves a person between the staff
 * and partner audiences.
 */
export function judgeStaffSet(hats: readonly Hat[], costView: boolean): void {
  judgeHoldingSet(hats, costView);
  if (hats.includes('partner')) {
    throw unprocessable('HAT_CONFLICT', 'The partner hat is given on the partner logins tab only');
  }
}

/** Nobody changes their own hats or cost grant, either way (spec 0005 AC-33 f, spec 0008 AC-7). */
export function refuseSelfChange(targetId: string, actor: Actor): void {
  if (targetId === actor.id) {
    throw conflict('SELF_HAT_CHANGE', 'You cannot change your own hats or cost access');
  }
}

/**
 * Adding or removing a `cost.view` grant needs the actor to hold `cost.view` (spec 0008 AC-7, gate
 * ruling of 2026-11-06), on every path: 403 `FORBIDDEN`, naming no permission, as the guard does.
 */
export function refuseCostChangeWithoutCost(actor: Actor): void {
  if (!actor.access.has('cost.view')) throw forbidden();
}

/** What a change does to a person's holding, worked out once for the writes, the log and the audit. */
export interface HoldingDiff {
  /** Hats in the new set and not the old, in catalog order. */
  added: Hat[];
  /** Hats in the old set and not the new, in catalog order. */
  removed: Hat[];
  /** The cost grant is given by this change. */
  costAdded: boolean;
  /** The cost grant is taken by this change. */
  costRemoved: boolean;
  /** Anything at all changes. */
  changed: boolean;
}

/** Compares two holdings. Pure; the lists come back in catalog order. */
export function diffHoldings(before: AccessHolding, after: AccessHolding): HoldingDiff {
  const was = new Set(before.hats);
  const now = new Set(after.hats);
  const added = Hat.options.filter((hat) => now.has(hat) && !was.has(hat));
  const removed = Hat.options.filter((hat) => was.has(hat) && !now.has(hat));
  const costAdded = after.costView && !before.costView;
  const costRemoved = before.costView && !after.costView;
  const changed =
    added.length > 0 ||
    removed.length > 0 ||
    costAdded ||
    costRemoved ||
    before.partnerAccountId !== after.partnerAccountId;
  return { added, removed, costAdded, costRemoved, changed };
}

/**
 * The audit action of one access change. Spec 0010 writes one entry per changed record (its AC-1)
 * and spec 0008 AC-13 one entry per change, with the whole holding before and after, so a change
 * is one entry: `hat.revoked` when it takes anything away (a hat or the cost grant), else
 * `hat.granted`. The revoke wins in a mixed change because it carries the stricter reason policy
 * (spec 0010 actions table: required for `hat.revoked` of the manager hat).
 */
export function auditActionOf(diff: HoldingDiff): IdentityAuditAction {
  return diff.removed.length > 0 || diff.costRemoved ? 'hat.revoked' : 'hat.granted';
}

/**
 * Taking the `manager` hat away needs a reason (spec 0010 actions table, `hat.revoked` of the
 * manager hat; gate ruling): 422 `REASON_REQUIRED`.
 */
export function requireReasonForManagerRemoval(
  diff: HoldingDiff,
  reason: string | undefined,
): void {
  if (diff.removed.includes('manager') && !reason) {
    throw unprocessable('REASON_REQUIRED', 'Say why the manager hat is taken away');
  }
}

/** A holding with its hats in catalog order, each once, and only the three named fields. */
export function normalHolding(holding: AccessHolding): AccessHolding {
  const held = new Set(holding.hats);
  return {
    hats: Hat.options.filter((hat) => held.has(hat)),
    costView: holding.costView,
    partnerAccountId: holding.partnerAccountId,
  };
}
