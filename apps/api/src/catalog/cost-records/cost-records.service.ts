import { Inject, Injectable } from '@nestjs/common';
import type {
  CostBasis,
  CostRecordListQuery,
  CostRecordListResponse,
  CostRecordRow,
  RecordCostRequest,
  RecordCostResponse,
  StyleVariantCost,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection, type SQL } from '@ssdashboard/db';
import type { z } from 'zod';
import { AuditService } from '../../audit/audit.service.js';
import { DATABASE } from '../../database/database.module.js';
import type { Executor } from '../../database/sql.js';
import { StaffDirectory } from '../../identity/staff/staff-directory.js';
import { decodeTimeIdKeyset, encodeKeyset } from '../../platform/keyset-cursor.js';
import { catalogActor, type CatalogCaller } from '../catalog-caller.js';
import { catalogTransaction } from '../catalog-transaction.js';
import { CatalogError } from '../catalog.service.js';
import { CostService } from '../cost.service.js';

/** One cost record as the list and the add read it back. */
interface CostRecordDbRow extends Record<string, unknown> {
  id: string;
  variant_id: string | null;
  variant_code: string | null;
  season_id: string;
  season_code: string;
  cost_basis: CostBasis;
  unit_cost: string;
  effective_from: string;
  source: string | null;
  recorded_at: string;
  recorded_by: string | null;
}

const RECORD_COLUMNS = sql`
  c.id, c.variant_id, v.sku AS variant_code, c.season_id, s.code AS season_code, c.cost_basis,
  c.unit_cost::text AS unit_cost, to_char(c.effective_from, 'YYYY-MM-DD') AS effective_from,
  c.source, to_char(c.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at,
  c.recorded_by`;

const RECORD_FROM = sql`cost_records c
  JOIN seasons s ON s.id = c.season_id
  LEFT JOIN product_variants v ON v.id = c.variant_id`;

/**
 * A style's cost records (spec 0012, AC-12, AC-13, AC-17): the list, newest recorded first, and
 * adding a record to the style or to one of its variants as an override. The only writer of
 * `cost_records` today; it only ever inserts (the table is append only, a correction is a newer
 * record with the same date). Reads the cost in force through `CostService`, never by its own
 * rule. Never edits or deletes a record, and never stores the reason anywhere but the audit entry.
 */
@Injectable()
export class CostRecordsService {
  /** Takes the app connection, the cost reader, the audit writer, and staff names. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(CostService) private readonly costs: CostService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(StaffDirectory) private readonly staff: StaffDirectory,
  ) {}

  /**
   * One page of the style's records, newest recorded first, keyed by (`recorded_at`, `id`); an
   * unknown style is `NotFound`, a cursor this list never issued `InvalidCursorError`.
   */
  async list(styleId: string, query: CostRecordListQuery): Promise<CostRecordListResponse> {
    const db = this.connection.db;
    const after = query.cursor === undefined ? undefined : decodeTimeIdKeyset(query.cursor);
    await this.styleCode(db, styleId, sql``);
    const { rows } = await db.execute<CostRecordDbRow>(sql`
      SELECT ${RECORD_COLUMNS}
      FROM ${RECORD_FROM}
      WHERE c.product_id = ${styleId}
      ${after ? sql`AND (c.recorded_at, c.id) < (${after.at}::timestamptz, ${after.id}::uuid)` : sql``}
      ORDER BY c.recorded_at DESC, c.id DESC
      LIMIT ${query.limit + 1}`);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: await this.view(page),
      nextCursor:
        rows.length > query.limit && last ? encodeKeyset([last.recorded_at, last.id]) : null,
    };
  }

  /**
   * Adds one record (AC-13) in one catalog transaction with its `cost_record.recorded` entry on
   * the style (AC-17). Unknown style, a variant outside the style, or an unknown season is
   * `NotFound` (any season counts, an archived one too); a record whose `effectiveFrom` is before
   * today's operating day (`ssd_operating_day(now())`) without a reason is `ReasonRequired`, and
   * its entry is written with `reasonRequired: true`. `recorded_by` is the caller; the database
   * stamps `recorded_at`. Answers the new record and every variant's cost in force today.
   */
  async record(
    styleId: string,
    input: z.output<typeof RecordCostRequest>,
    caller: CatalogCaller,
  ): Promise<RecordCostResponse> {
    const correlationId = this.audit.newCorrelationId();
    const { row, variants } = await catalogTransaction(this.connection.db, async (tx) => {
      // FOR KEY SHARE: the style cannot be deleted under the new record (the key it references).
      const styleCode = await this.styleCode(tx, styleId, sql`FOR KEY SHARE`);
      let variantCode: string | null = null;
      if (input.variantId !== undefined) {
        const variant = (
          await tx.execute<{ sku: string }>(sql`
            SELECT sku FROM product_variants
            WHERE id = ${input.variantId} AND product_id = ${styleId}
            FOR KEY SHARE`)
        ).rows[0];
        if (!variant) throw new CatalogError('NotFound', 'This variant is not one of the style');
        variantCode = variant.sku;
      }
      const season = (
        await tx.execute<{ code: string }>(sql`
          SELECT code FROM seasons WHERE id = ${input.seasonId}`)
      ).rows[0];
      if (!season) throw new CatalogError('NotFound', 'Season not found');
      const today = await this.costs.today(tx);
      const backdated = input.effectiveFrom < today;
      if (backdated && !input.reason) {
        throw new CatalogError(
          'ReasonRequired',
          'A cost that applies from before today needs a reason',
        );
      }
      const created = (
        await tx.execute<{ id: string }>(sql`
          INSERT INTO cost_records
            (product_id, variant_id, season_id, cost_basis, unit_cost, effective_from, source,
             recorded_by)
          VALUES (${styleId}, ${input.variantId ?? null}, ${input.seasonId}, ${input.costBasis},
                  ${input.unitCost}, ${input.effectiveFrom}::date, ${input.source ?? null},
                  ${caller.id})
          RETURNING id`)
      ).rows[0];
      if (!created) throw new Error('The cost record insert returned no row');
      const saved = (
        await tx.execute<CostRecordDbRow>(sql`
          SELECT ${RECORD_COLUMNS} FROM ${RECORD_FROM} WHERE c.id = ${created.id}`)
      ).rows[0];
      if (!saved) throw new Error('The new cost record could not be read back');
      await this.audit.record(tx, {
        actor: catalogActor(caller, 'catalog.edit'),
        action: 'cost_record.recorded',
        record: { type: 'style', id: styleId, label: styleCode },
        after: {
          costRecordId: saved.id,
          variantId: saved.variant_id,
          variantCode,
          seasonId: saved.season_id,
          seasonCode: season.code,
          costBasis: saved.cost_basis,
          unitCost: saved.unit_cost,
          effectiveFrom: saved.effective_from,
          source: saved.source,
        },
        ...(input.reason !== undefined && { reason: input.reason }),
        ...(backdated && { reasonRequired: true as const }),
        correlationId,
      });
      return { row: saved, variants: await this.variantCosts(tx, styleId, today) };
    });
    const [record] = await this.view([row]);
    if (!record) throw new Error('The new cost record has no view');
    return { record, variants };
  }

  /** Every variant of the style, by code (archived ones included), with its cost on `day`. */
  private async variantCosts(
    executor: Executor,
    styleId: string,
    day: string,
  ): Promise<StyleVariantCost[]> {
    const { rows } = await executor.execute<{ id: string; sku: string }>(sql`
      SELECT id, sku FROM product_variants
      WHERE product_id = ${styleId}
      ORDER BY sku COLLATE "C"`);
    const costs = await this.costs.costForMany(
      rows.map((row) => row.id),
      day,
      executor,
    );
    return rows.map((row) => ({
      id: row.id,
      code: row.sku,
      cost: costs.get(row.id) ?? { status: 'not_set' },
    }));
  }

  /** The style's code, or `NotFound`; `lock` is an optional row lock clause. */
  private async styleCode(executor: Executor, styleId: string, lock: SQL): Promise<string> {
    const style = (
      await executor.execute<{ style_code: string }>(sql`
        SELECT style_code FROM products WHERE id = ${styleId} ${lock}`)
    ).rows[0];
    if (!style) throw new CatalogError('NotFound', 'Style not found');
    return style.style_code;
  }

  /** The answer rows, with the recording person's name from the staff directory. */
  private async view(rows: readonly CostRecordDbRow[]): Promise<CostRecordRow[]> {
    const names = await this.staff.namesByIds(
      rows.flatMap((row) => (row.recorded_by ? [row.recorded_by] : [])),
    );
    return rows.map((row) => ({
      id: row.id,
      variant:
        row.variant_id && row.variant_code ? { id: row.variant_id, code: row.variant_code } : null,
      season: { id: row.season_id, code: row.season_code },
      costBasis: row.cost_basis,
      unitCost: row.unit_cost,
      effectiveFrom: row.effective_from,
      source: row.source,
      recordedAt: row.recorded_at,
      recordedBy: row.recorded_by
        ? { id: row.recorded_by, name: names.get(row.recorded_by) ?? null }
        : null,
    }));
  }
}
