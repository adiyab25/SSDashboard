import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  personActor,
  type CustomerFlagReasonCode,
  type CustomerRiskFlag,
  type CustomerRiskFlagSource,
  type CustomerSetFlagResponse,
  type CustomerUnflagReasonCode,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { AuditService, type AuditEntryInput } from '../../audit/audit.service.js';
import { DATABASE } from '../../database/database.module.js';
import { pgArray, type Transaction } from '../../database/sql.js';
import { StaffDirectory } from '../../identity/staff/staff-directory.js';
import { utc } from '../customer-briefs.js';
import { nextStampOf } from '../customer-stamp.js';
import { CustomersError } from '../customers.errors.js';
import { CustomersService } from '../customers.service.js';
import { cleanCustomerName } from '../find-or-create/find-or-create.js';

/** The staff person who sets or clears a flag: a `manual` flag names its person. */
export interface FlagActor {
  /** The person's user id (`risk_flag_set_by`). */
  userId: string;
  /** The hat they act under, for the audit entry. */
  hat: string;
}

/** What a person's flag set needs (spec 0014 AC-11). */
export interface SetFlagInput {
  /** The flag kind. */
  kind: CustomerRiskFlag;
  /** The note (personal data, at most 500 characters); null, absent, or blank stores none. */
  note?: string | null;
  /** Why, as a listed code; recorded on the audit entry. */
  reasonCode?: CustomerFlagReasonCode;
  /** The profile's `updatedAt` the person saw; another stamp is `STALE_RECORD`. */
  expectedUpdatedAt: string;
}

/** The returner signal's counts a `suggestion_applied` flag carries into its audit entry's `after`. */
export interface AppliedSuggestion {
  /** The kind the signal suggests now, or null. */
  suggestedKind: CustomerRiskFlag | null;
  refusals: number;
  returns: number;
  windowDays: number;
}

/**
 * Recomputes the returner signal of a customer's id set inside the flag set's transaction, under
 * its locks (spec 0014 AC-13). `flagged` says whether any id of the customer holds a flag. The
 * leaf `CustomerProfileModule` passes it, since only it reads orders.
 */
export type SuggestionCheck = (
  tx: Transaction,
  ids: readonly string[],
  flagged: boolean,
) => Promise<AppliedSuggestion>;

/** What a flag clear needs (spec 0014 AC-11). */
export interface ClearFlagInput {
  /** Why, as a listed code (required). */
  reasonCode: CustomerUnflagReasonCode;
  /** The profile's `updatedAt` the person saw; another stamp is `STALE_RECORD`. */
  expectedUpdatedAt: string;
}

interface CanonicalFlagRow extends Record<string, unknown> {
  merged_into_id: string | null;
  risk_flag: CustomerRiskFlag | null;
  risk_flag_source: CustomerRiskFlagSource | null;
}

/** The locked canonical row, the id set of the customer, and whether her stamp is the one expected. */
interface LockedCustomer {
  row: CanonicalFlagRow;
  ids: string[];
  fresh: boolean;
}

interface FlaggedRow extends Record<string, unknown> {
  id: string;
  risk_flag: CustomerRiskFlag;
  risk_flag_source: CustomerRiskFlagSource;
}

/** The person's copy of the customer is out of date: 409 `STALE_RECORD`. */
const stale = (): CustomersError =>
  new CustomersError('STALE_RECORD', 'This customer changed, open it again');

/**
 * A person sets and clears a customer's risk flag (spec 0014 AC-11), each in one new transaction
 * under the `customer` locks of `CustomersService.lockCustomers` and row locks on the canonical
 * row, then every id merged into her, checking the customer's stamp (the greatest `updated_at`
 * over her ids, as the profile answers it) against the one the person saw (409 `STALE_RECORD`). Set writes a `manual` flag on the canonical row and `customer.flagged`; clear
 * empties the flag on every id of the canonical customer and writes one `customer.unflagged` per
 * changed record under one correlation id.
 *
 * Not exported from the module: other modules flag through `CustomersService` (the import entry
 * point). Audit entries carry the flag kind and source only, never the note; errors are typed and
 * never carry the note, a name, or a phone (Law 151).
 */
@Injectable()
export class CustomerFlags {
  private readonly logger = new Logger('CustomerFlags');

  /** Takes the database, the customers service (locks and id sets), the audit writer, and the staff names. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(CustomersService) private readonly customers: CustomersService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(StaffDirectory) private readonly staff: StaffDirectory,
  ) {}

  /**
   * Sets a `manual` flag on the customer `id` (lower case uuid), which must be canonical: 404
   * `CUSTOMER_NOT_FOUND` for an unknown id, 409 `CUSTOMER_MERGED` for a merged one (open the
   * survivor), 409 `STALE_RECORD` when her stamp moved on. Replaces any flag on her row, writes
   * the person, now, and the note (invisible format characters stripped, trimmed, a blank one
   * stored as none), and records `customer.flagged`. Answers the flag block as the profile reads
   * it and the new `updatedAt` (the profile's stamp after the write).
   *
   * Reason code `suggestion_applied` (AC-13, the one tap apply): accepted only when `suggestion`
   * is given and, recomputed under the locks, the customer has no flag on any id and the signal
   * suggests exactly `kind`; the entry's `after` then also carries `refusals`, `returns`, and
   * `windowDays`. Otherwise 422 `REASON_INVALID`.
   */
  async set(
    id: string,
    input: SetFlagInput,
    actor: FlagActor,
    suggestion?: SuggestionCheck,
  ): Promise<CustomerSetFlagResponse> {
    const correlationId = this.audit.newCorrelationId();
    // The note is cleaned like a name: pasted direction marks could otherwise hide its text.
    const note = cleanCustomerName(input.note ?? null);
    const written = await this.connection.db.transaction(
      async (tx) => {
        const canonicalId = await this.customers.canonicalOf(id, tx);
        if (canonicalId === null) {
          throw new CustomersError('CUSTOMER_NOT_FOUND', 'No customer has that id');
        }
        if (canonicalId !== id) {
          throw new CustomersError('CUSTOMER_MERGED', 'This customer was merged into another one');
        }
        await this.customers.lockCustomers(tx, [id]);
        const { row, ids, fresh } = await this.lockCustomer(tx, id, input.expectedUpdatedAt);
        if (row.merged_into_id !== null) {
          throw new CustomersError('CUSTOMER_MERGED', 'This customer was merged into another one');
        }
        if (!fresh) throw stale();
        const applied =
          input.reasonCode === 'suggestion_applied'
            ? await this.confirmSuggestion(tx, ids, input.kind, suggestion)
            : null;

        const after = (
          await tx.execute<{ set_at: string }>(sql`
            UPDATE customers
            SET risk_flag = ${input.kind}, risk_flag_source = 'manual', risk_flag_note = ${note},
                risk_flag_set_at = now(), risk_flag_set_by = ${actor.userId}::uuid,
                updated_at = ${nextStampOf(ids)}
            WHERE id = ${id}::uuid
            RETURNING ${utc('risk_flag_set_at')} AS set_at`)
        ).rows[0];
        if (after === undefined) throw new Error('The flag update returned no row');
        const stamp = await this.stampOf(tx, ids);

        await this.audit.record(tx, {
          actor: personActor(actor.userId, actor.hat),
          action: 'customer.flagged',
          record: { type: 'customer', id },
          before: { riskFlag: row.risk_flag, riskFlagSource: row.risk_flag_source },
          after: {
            riskFlag: input.kind,
            riskFlagSource: 'manual',
            ...(applied === null
              ? {}
              : {
                  refusals: applied.refusals,
                  returns: applied.returns,
                  windowDays: applied.windowDays,
                }),
          },
          ...(input.reasonCode === undefined ? {} : { reason: input.reasonCode }),
          correlationId,
        });
        return { setAt: after.set_at, updatedAt: stamp };
      },
      { isolationLevel: 'read committed' },
    );
    return {
      flag: {
        kind: input.kind,
        source: 'manual',
        note,
        setAt: written.setAt,
        setByName: await this.nameOf(actor.userId),
      },
      updatedAt: written.updatedAt,
    };
  }

  /**
   * Clears the flag of the canonical customer behind `id` (lower case uuid; a merged id clears
   * its survivor's) on every id that holds one: 404 `CUSTOMER_NOT_FOUND`, 409 `STALE_RECORD` when
   * her stamp (the greatest `updated_at` over her ids) moved on, so a record merged in after the
   * person read the profile is never cleared unseen (or when a merge moved the id while it
   * waited), 409 `NOT_FLAGGED` when no id holds a flag. Bumps the canonical row's `updated_at` and writes one
   * `customer.unflagged` per changed record under one correlation id.
   */
  async clear(id: string, input: ClearFlagInput, actor: FlagActor): Promise<void> {
    const correlationId = this.audit.newCorrelationId();
    await this.connection.db.transaction(
      async (tx) => {
        const canonicalId = await this.customers.canonicalOf(id, tx);
        if (canonicalId === null) {
          throw new CustomersError('CUSTOMER_NOT_FOUND', 'No customer has that id');
        }
        await this.customers.lockCustomers(tx, [canonicalId]);
        // A merge that committed while this call waited moved the customer the person saw.
        if ((await this.customers.canonicalOf(id, tx)) !== canonicalId) throw stale();
        const { row, ids, fresh } = await this.lockCustomer(
          tx,
          canonicalId,
          input.expectedUpdatedAt,
        );
        if (row.merged_into_id !== null || !fresh) throw stale();

        const flagged = (
          await tx.execute<FlaggedRow>(sql`
            SELECT id, risk_flag, risk_flag_source FROM customers
            WHERE id = ANY(${pgArray(ids)}::uuid[]) AND risk_flag IS NOT NULL
            ORDER BY id
            FOR UPDATE`)
        ).rows;
        if (flagged.length === 0) {
          throw new CustomersError('NOT_FLAGGED', 'This customer has no flag');
        }

        await tx.execute(sql`
          UPDATE customers
          SET risk_flag = NULL, risk_flag_source = NULL, risk_flag_note = NULL,
              risk_flag_set_at = NULL, risk_flag_set_by = NULL, updated_at = ${nextStampOf(ids)}
          WHERE id = ANY(${pgArray([...flagged.map((f) => f.id), canonicalId])}::uuid[])`);

        const auditActor = personActor(actor.userId, actor.hat);
        await this.audit.recordMany(
          tx,
          flagged.map((f): AuditEntryInput => ({
            actor: auditActor,
            action: 'customer.unflagged',
            record: { type: 'customer', id: f.id },
            before: { riskFlag: f.risk_flag, riskFlagSource: f.risk_flag_source },
            after: { riskFlag: null, riskFlagSource: null },
            reason: input.reasonCode,
            correlationId,
          })),
        );
      },
      { isolationLevel: 'read committed' },
    );
  }

  /**
   * The signal a `suggestion_applied` set rests on, recomputed under the locks: refused with 422
   * `REASON_INVALID` when no check is given, any id holds a flag, or the signal suggests another
   * kind or none.
   */
  private async confirmSuggestion(
    tx: Transaction,
    ids: readonly string[],
    kind: CustomerRiskFlag,
    suggestion: SuggestionCheck | undefined,
  ): Promise<AppliedSuggestion> {
    const refuse = () =>
      new CustomersError('REASON_INVALID', 'Nothing suggests this flag for this customer now');
    if (suggestion === undefined) throw refuse();
    const flagged =
      (
        await tx.execute<{ flagged: boolean }>(sql`
          SELECT EXISTS (SELECT 1 FROM customers
                          WHERE id = ANY(${pgArray(ids)}::uuid[]) AND risk_flag IS NOT NULL) AS flagged`)
      ).rows[0]?.flagged === true;
    const signal = await suggestion(tx, ids, flagged);
    if (flagged || signal.suggestedKind !== kind) throw refuse();
    return signal;
  }

  /**
   * Locks the canonical row (`FOR UPDATE`), then, when it is still canonical, every id merged into
   * it in id order, and compares the customer's stamp with `expectedUpdatedAt`. Call it under
   * `lockCustomers`, so no merge or undo moves the id set while it reads. A row that is merged by
   * now answers no ids and `fresh: false`: the caller refuses before it touches anything.
   */
  private async lockCustomer(
    tx: Transaction,
    canonicalId: string,
    expectedUpdatedAt: string,
  ): Promise<LockedCustomer> {
    const row = (
      await tx.execute<CanonicalFlagRow>(sql`
        SELECT merged_into_id, risk_flag, risk_flag_source
        FROM customers WHERE id = ${canonicalId}::uuid
        FOR UPDATE`)
    ).rows[0];
    if (row === undefined)
      throw new CustomersError('CUSTOMER_NOT_FOUND', 'No customer has that id');
    if (row.merged_into_id !== null) return { row, ids: [], fresh: false };
    const ids = await this.customers.idsOf(canonicalId, tx);
    await tx.execute(sql`
      SELECT id FROM customers
      WHERE id = ANY(${pgArray(ids)}::uuid[]) AND id <> ${canonicalId}::uuid
      ORDER BY id
      FOR UPDATE`);
    const fresh = (
      await tx.execute<{ fresh: boolean | null }>(sql`
        SELECT (max(updated_at) = ${expectedUpdatedAt}::timestamptz) AS fresh
        FROM customers WHERE id = ANY(${pgArray(ids)}::uuid[])`)
    ).rows[0]?.fresh;
    return { row, ids, fresh: fresh === true };
  }

  /** The customer's stamp: the greatest `updated_at` over `ids`, as the profile answers it. */
  private async stampOf(tx: Transaction, ids: readonly string[]): Promise<string> {
    const stamp = (
      await tx.execute<{ stamp: string | null }>(sql`
        SELECT ${utc('max(updated_at)')} AS stamp
        FROM customers WHERE id = ANY(${pgArray(ids)}::uuid[])`)
    ).rows[0]?.stamp;
    if (stamp === null || stamp === undefined) throw new Error('The customer has no stamp');
    return stamp;
  }

  /**
   * The name of the person who set the flag, read after the commit: a failed lookup answers null
   * (the profile shows the name on its next read) rather than a 500 for a flag that is written.
   */
  private async nameOf(userId: string): Promise<string | null> {
    try {
      return (await this.staff.namesByIds([userId])).get(userId) ?? null;
    } catch (error) {
      const kind = error instanceof Error ? error.name : 'unknown error';
      this.logger.warn(`The staff name lookup after a flag set failed: ${kind}`);
      return null;
    }
  }
}
