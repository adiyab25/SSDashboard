import { Inject, Injectable } from '@nestjs/common';
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
import { MICRO_UTC } from '../customer-briefs.js';
import { CustomersError } from '../customers.errors.js';
import { CustomersService } from '../customers.service.js';

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

/** What a flag clear needs (spec 0014 AC-11). */
export interface ClearFlagInput {
  /** Why, as a listed code (required). */
  reasonCode: CustomerUnflagReasonCode;
  /** The profile's `updatedAt` the person saw; another stamp is `STALE_RECORD`. */
  expectedUpdatedAt: string;
}

interface CanonicalFlagRow extends Record<string, unknown> {
  merged_into_id: string | null;
  fresh: boolean;
  risk_flag: CustomerRiskFlag | null;
  risk_flag_source: CustomerRiskFlagSource | null;
}

interface FlaggedRow extends Record<string, unknown> {
  id: string;
  risk_flag: CustomerRiskFlag;
  risk_flag_source: CustomerRiskFlagSource;
}

/** The person's copy of the customer is out of date: 409 `STALE_RECORD`. */
const stale = (): CustomersError =>
  new CustomersError('STALE_RECORD', 'This customer changed, open it again');

const utc = (column: string) => sql.raw(`to_char(${column} AT TIME ZONE 'UTC', ${MICRO_UTC})`);

/**
 * A person sets and clears a customer's risk flag (spec 0014 AC-11), each in one new transaction
 * under the `customer` locks of `CustomersService.lockCustomers` and a row lock on the canonical
 * row, checking the canonical row's `updated_at` against the stamp the person saw (409
 * `STALE_RECORD`). Set writes a `manual` flag on the canonical row and `customer.flagged`; clear
 * empties the flag on every id of the canonical customer and writes one `customer.unflagged` per
 * changed record under one correlation id.
 *
 * Not exported from the module: other modules flag through `CustomersService` (the import entry
 * point). Audit entries carry the flag kind and source only, never the note; errors are typed and
 * never carry the note, a name, or a phone (Law 151).
 */
@Injectable()
export class CustomerFlags {
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
   * survivor), 409 `STALE_RECORD` when her `updated_at` moved on. Replaces any flag on her row,
   * writes the person, now, and the note, and records `customer.flagged`. Answers the flag block
   * as the profile reads it and the new `updatedAt`.
   */
  async set(id: string, input: SetFlagInput, actor: FlagActor): Promise<CustomerSetFlagResponse> {
    const correlationId = this.audit.newCorrelationId();
    const note = input.note?.trim() ? input.note.trim() : null;
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
        const row = await this.lockRow(tx, id, input.expectedUpdatedAt);
        if (row.merged_into_id !== null) {
          throw new CustomersError('CUSTOMER_MERGED', 'This customer was merged into another one');
        }
        if (!row.fresh) throw stale();

        const after = (
          await tx.execute<{ set_at: string; updated_at: string }>(sql`
            UPDATE customers
            SET risk_flag = ${input.kind}, risk_flag_source = 'manual', risk_flag_note = ${note},
                risk_flag_set_at = now(), risk_flag_set_by = ${actor.userId}::uuid,
                updated_at = now()
            WHERE id = ${id}::uuid
            RETURNING ${utc('risk_flag_set_at')} AS set_at, ${utc('updated_at')} AS updated_at`)
        ).rows[0];
        if (after === undefined) throw new Error('The flag update returned no row');

        await this.audit.record(tx, {
          actor: personActor(actor.userId, actor.hat),
          action: 'customer.flagged',
          record: { type: 'customer', id },
          before: { riskFlag: row.risk_flag, riskFlagSource: row.risk_flag_source },
          after: { riskFlag: input.kind, riskFlagSource: 'manual' },
          ...(input.reasonCode === undefined ? {} : { reason: input.reasonCode }),
          correlationId,
        });
        return after;
      },
      { isolationLevel: 'read committed' },
    );
    const names = await this.staff.namesByIds([actor.userId]);
    return {
      flag: {
        kind: input.kind,
        source: 'manual',
        note,
        setAt: written.set_at,
        setByName: names.get(actor.userId) ?? null,
      },
      updatedAt: written.updated_at,
    };
  }

  /**
   * Clears the flag of the canonical customer behind `id` (lower case uuid; a merged id clears
   * its survivor's) on every id that holds one: 404 `CUSTOMER_NOT_FOUND`, 409 `STALE_RECORD` when
   * the canonical row's `updated_at` moved on (or a merge moved the id while it waited), 409
   * `NOT_FLAGGED` when no id holds a flag. Bumps the canonical row's `updated_at` and writes one
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
        const row = await this.lockRow(tx, canonicalId, input.expectedUpdatedAt);
        if (row.merged_into_id !== null || !row.fresh) throw stale();

        const ids = await this.customers.idsOf(canonicalId, tx);
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
              risk_flag_set_at = NULL, risk_flag_set_by = NULL, updated_at = now()
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

  /** Locks the customer row and reads its pointer, its flag, and whether its stamp is `expected`. */
  private async lockRow(
    tx: Transaction,
    id: string,
    expectedUpdatedAt: string,
  ): Promise<CanonicalFlagRow> {
    const row = (
      await tx.execute<CanonicalFlagRow>(sql`
        SELECT merged_into_id, (updated_at = ${expectedUpdatedAt}::timestamptz) AS fresh,
               risk_flag, risk_flag_source
        FROM customers WHERE id = ${id}::uuid
        FOR UPDATE`)
    ).rows[0];
    if (row === undefined)
      throw new CustomersError('CUSTOMER_NOT_FOUND', 'No customer has that id');
    return row;
  }
}
