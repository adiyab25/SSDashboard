import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { maskPhones } from '@ssdashboard/config/redaction';
import {
  CreateStockReceiptRequest,
  Money,
  mulDivRound,
  UnitCost,
  type LocalizedText,
  type StockReceiptDetail,
  type StockReceiptLineError,
  type StockReceiptListQuery,
  type StockReceiptListResponse,
  type StockReceiptSummary,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection, type SQL } from '@ssdashboard/db';
import type { z } from 'zod';
import { AuditService } from '../../audit/audit.service.js';
import { CatalogService, escapeLike } from '../../catalog/catalog.service.js';
import { DATABASE } from '../../database/database.module.js';
import type { Access } from '../../platform/access/access.js';
import { pgArray, type Executor } from '../../database/sql.js';
import { decodeTimeIdKeyset, encodeKeyset } from '../../platform/keyset-cursor.js';
import { NumberingService } from '../../platform/numbering.service.js';
import { SettingsService } from '../../platform/settings.service.js';
import { StaffDirectory } from '../../identity/staff/staff-directory.js';
import { LedgerError } from '../ledger/ledger.errors.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { receiptLineId } from './line-id.js';

type CreateInput = z.output<typeof CreateStockReceiptRequest>;

/** `quantity × unitCost` may not pass this, in cents (AC-5). */
const MAX_LINE_TOTAL_CENTS = 999_999_999_999n;

const ISO_UTC = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

/**
 * The receipt rules a caller can break: missing, replayed key with a different body or by
 * another person, bad lines or location, future date, already voided, or a void that would take
 * stock below zero.
 */
export type ReceiptErrorCode =
  | 'NotFound'
  | 'IdempotencyConflict'
  | 'InvalidLines'
  | 'InvalidLocation'
  | 'FutureDate'
  | 'AlreadyVoided'
  | 'InsufficientStock'
  | 'ReasonRequired';

/** A receipt rule the caller broke; the controller maps `code` to an HTTP answer. */
export class ReceiptError extends Error {
  /**
   * Takes the stable `code`, a message safe to show, the per line errors, and for
   * `InsufficientStock` the SKUs a void would take below zero.
   */
  constructor(
    readonly code: ReceiptErrorCode,
    message: string,
    readonly lineErrors: StockReceiptLineError[] = [],
    /** `InsufficientStock` only: the SKUs a void would take below zero. */
    readonly skuIds: string[] = [],
  ) {
    super(message);
    this.name = 'ReceiptError';
  }
}

/**
 * Who is asking: the posting user, what they may see (cost fields need `cost.view`, AC-11), and
 * the hat a void's audit entry names (`actingHat`).
 */
export interface ReceiptCaller {
  id: string;
  access: Pick<Access, 'has' | 'actingHat'>;
}

/** A stored receipt with every field, before the cost serializer. */
interface StoredReceipt {
  id: string;
  requestHash: string;
  detail: StockReceiptDetail;
}

/**
 * SHA-256 of the canonical request (spec 0006, Value sourcing): fields in a fixed order, absent
 * ones as null, lines in input order with `unitCost` at 4 decimals.
 */
export function receiptRequestHash(input: CreateInput): string {
  const canonical = JSON.stringify([
    input.locationId,
    input.receiptDate ?? null,
    input.reference ?? null,
    input.note ?? null,
    input.lines.map((line) => [line.skuId, line.quantity, UnitCost.of(line.unitCost).toString()]),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Removes the cost fields (`COST_FIELD_KEYS`) for a caller without `cost.view` (AC-11, spec 0008
 * AC-6). One serializer for every receipt answer, replays included.
 */
export function serializeReceipt(
  detail: StockReceiptDetail,
  access: Pick<Access, 'has'>,
): StockReceiptDetail {
  if (access.has('cost.view')) return detail;
  const { referenceValue: _value, ...rest } = detail;
  return {
    ...rest,
    lines: detail.lines.map(({ unitCost: _cost, lineTotal: _total, ...line }) => line),
  };
}

/**
 * Stock receipts (spec 0006): a numbered document posted through the ledger in one transaction.
 * This service writes only `stock_receipts` and `stock_receipt_lines`, only inside the ledger's
 * `within` callback, and moves stock only through `LedgerService`.
 */
@Injectable()
export class ReceiptsService {
  private readonly logger = new Logger('StockReceipts');

  /**
   * Takes the app database connection, the ledger, catalog, numbering, settings, and audit
   * services, and the staff directory.
   */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(StaffDirectory) private readonly staff: StaffDirectory,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * Posts a receipt whose id is the caller's idempotency key (AC-5, AC-6). Returns the stored
   * receipt and whether this call created it.
   */
  async post(
    id: string,
    input: CreateInput,
    caller: ReceiptCaller,
  ): Promise<{ receipt: StockReceiptDetail; created: boolean }> {
    const hash = receiptRequestHash(input);

    // Step 1: a receipt with this id already exists.
    const existing = await this.find(this.connection.db, id);
    if (existing) return { receipt: this.replayOf(existing, hash, caller), created: false };

    await this.checkLocation(input.locationId);
    const skus = await this.checkLines(input);
    const effectiveAt = await this.effectiveAt(input.receiptDate);

    const lines = input.lines.map((line, index) => {
      const position = index + 1;
      const unitCost = UnitCost.of(line.unitCost);
      return {
        id: receiptLineId(id, position),
        position,
        variantId: line.skuId,
        uomId: skus.get(line.skuId) ?? '',
        quantity: line.quantity,
        unitCost: unitCost.toString(),
        lineTotal: unitCost.times(line.quantity).toString(),
      };
    });

    const outcome = await this.ledger.post(
      {
        idempotencyKey: `stock_receipt:${id}`,
        sourceType: 'stock_receipt',
        sourceId: id,
        effectiveAt,
        postedBy: caller.id,
        lines: lines.map((line) => ({
          variantId: line.variantId,
          locationId: input.locationId,
          quantity: line.quantity,
          unitCost: line.unitCost,
          sourceLineId: line.id,
        })),
      },
      {
        // Everything in here reruns on the ledger's deadlock retry, so it keeps no state.
        within: async (tx, result) => {
          // The number is issued after all stock work: its counter row stays locked until
          // commit, and only the receipt's own two inserts follow it.
          const number = await this.numbering.next(
            tx,
            'stock_receipt',
            new Date(result.effectiveAt),
          );
          await tx.execute(sql`
            INSERT INTO stock_receipts (id, request_hash, number, location_id, effective_at,
                                        reference, note, movement_group_id, posted_by)
            VALUES (${id}, ${hash}, ${number}, ${input.locationId},
                    ${result.effectiveAt}::timestamptz, ${input.reference ?? null},
                    ${input.note ?? null}, ${result.groupId}, ${caller.id})`);
          await tx.execute(sql`
            INSERT INTO stock_receipt_lines (id, receipt_id, position, variant_id, uom_id,
                                             quantity, unit_cost, line_total)
            SELECT l.id, ${id}, l.position, l.variant_id, l.uom_id, l.quantity, l.unit_cost,
                   l.line_total
            FROM unnest(
              ${pgArray(lines.map((l) => l.id))}::uuid[],
              ${pgArray(lines.map((l) => l.position))}::int[],
              ${pgArray(lines.map((l) => l.variantId))}::uuid[],
              ${pgArray(lines.map((l) => l.uomId))}::uuid[],
              ${pgArray(lines.map((l) => l.quantity))}::int[],
              ${pgArray(lines.map((l) => l.unitCost))}::numeric[],
              ${pgArray(lines.map((l) => l.lineTotal))}::numeric[]
            ) AS l(id, position, variant_id, uom_id, quantity, unit_cost, line_total)`);
        },
      },
    );

    const stored = await this.find(this.connection.db, id);
    if (!stored) throw new Error(`Receipt ${id} was posted but cannot be read back`);
    // Step 2: a concurrent first request with this key won the race.
    if (outcome.replayed) return { receipt: this.replayOf(stored, hash, caller), created: false };

    this.logger.log({
      event: 'stock_receipt.posted',
      receiptId: id,
      number: stored.detail.number,
      locationId: input.locationId,
      lineCount: lines.length,
      userId: caller.id,
    });
    return { receipt: serializeReceipt(stored.detail, caller.access), created: true };
  }

  /** One receipt through the caller's serializer, or `NotFound`. */
  async get(id: string, caller: ReceiptCaller): Promise<StockReceiptDetail> {
    const stored = await this.find(this.connection.db, id);
    if (!stored) throw new ReceiptError('NotFound', 'Stock receipt not found');
    return serializeReceipt(stored.detail, caller.access);
  }

  /**
   * Receipts newest first (`effective_at`, then id), 50 a page, optionally for one location and
   * matching `q` in the number or reference, ignoring case (AC-12).
   */
  async list(query: StockReceiptListQuery): Promise<StockReceiptListResponse> {
    const filters: SQL[] = [];
    if (query.locationId) filters.push(sql`r.location_id = ${query.locationId}`);
    if (query.q) {
      const pattern = `%${escapeLike(query.q)}%`;
      filters.push(sql`(r.number ILIKE ${pattern} OR r.reference ILIKE ${pattern})`);
    }
    if (query.cursor) {
      const after = decodeTimeIdKeyset(query.cursor);
      filters.push(sql`(r.effective_at, r.id) < (${after.at}::timestamptz, ${after.id}::uuid)`);
    }
    const where = filters.length ? sql`WHERE ${sql.join(filters, sql` AND `)}` : sql``;
    const { rows } = await this.connection.db.execute<{
      id: string;
      number: string;
      status: 'posted' | 'voided';
      location_id: string;
      location_code: string;
      location_name: LocalizedText;
      effective_at: string;
      reference: string | null;
      line_count: number;
      posted_by: string;
    }>(sql`
      SELECT r.id, r.number, r.status, r.location_id, l.code AS location_code,
             l.name AS location_name,
             to_char(r.effective_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS effective_at,
             r.reference, r.posted_by,
             (SELECT count(*)::int FROM stock_receipt_lines sl WHERE sl.receipt_id = r.id)
               AS line_count
      FROM stock_receipts r JOIN locations l ON l.id = r.location_id
      ${where}
      ORDER BY r.effective_at DESC, r.id DESC
      LIMIT ${query.limit + 1}`);
    const page = rows.slice(0, query.limit);
    const names = await this.staff.namesByIds(page.map((row) => row.posted_by));
    const last = page.at(-1);
    return {
      items: page.map((row): StockReceiptSummary => ({
        id: row.id,
        number: row.number,
        status: row.status,
        location: {
          id: row.location_id,
          code: row.location_code,
          name: { en: row.location_name.en, ar: row.location_name.ar },
        },
        effectiveAt: row.effective_at,
        reference: row.reference,
        lineCount: row.line_count,
        postedBy: { id: row.posted_by, name: names.get(row.posted_by) ?? '' },
      })),
      nextCursor:
        rows.length > query.limit && last ? encodeKeyset([last.effective_at, last.id]) : null,
    };
  }

  /**
   * Voids a posted receipt with a ledger reversal dated now (AC-8). The value removed follows the
   * ledger's average cost rules. Two voids at once: the second waits on the reversal's
   * idempotency key, then finds the receipt voided and answers `AlreadyVoided`. The void writes
   * its `stock_receipt.voided` audit entry in the same transaction (spec 0010, AC-2, AC-11): a
   * blank reason throws `AuditReasonRequired` and rolls the whole void back.
   */
  async void(id: string, reason: string, caller: ReceiptCaller): Promise<StockReceiptDetail> {
    const current = (
      await this.connection.db.execute<{ status: 'posted' | 'voided'; group_id: string }>(
        sql`SELECT status, movement_group_id AS group_id FROM stock_receipts WHERE id = ${id}`,
      )
    ).rows[0];
    if (!current) throw new ReceiptError('NotFound', 'Stock receipt not found');
    if (current.status === 'voided') {
      throw new ReceiptError('AlreadyVoided', 'This receipt is already voided');
    }

    // One business action, one id, reused if the ledger retries the transaction.
    const correlationId = this.audit.newCorrelationId();
    let outcome;
    try {
      outcome = await this.ledger.reverse(
        {
          groupId: current.group_id,
          idempotencyKey: `stock_receipt_void:${id}`,
          postedBy: caller.id,
          reasonCode: 'stock_receipt_void',
        },
        {
          // Reruns whole on the ledger's deadlock retry; it keeps no state.
          within: async (tx, result) => {
            const locked = (
              await tx.execute<{ status: 'posted' | 'voided'; number: string }>(
                sql`SELECT status, number FROM stock_receipts WHERE id = ${id} FOR UPDATE`,
              )
            ).rows[0];
            if (!locked || locked.status !== 'posted') {
              throw new ReceiptError('AlreadyVoided', 'This receipt is already voided');
            }
            // Recorded before the update, so a missing reason fails on the audit policy (422)
            // rather than on the void_reason check; either way the void rolls back whole.
            await this.audit.record(tx, {
              actor: {
                kind: 'person',
                userId: caller.id,
                hat: caller.access.actingHat('stock.correct'),
              },
              action: 'stock_receipt.voided',
              record: { type: 'stock_receipt', id, label: locked.number },
              before: { status: 'posted' },
              after: { status: 'voided' },
              reason,
              correlationId,
            });
            // The registry makes the reason required, so record refused a blank one above. If
            // that policy is ever loosened, the void still needs one (review AR6): same 422.
            const kept = maskPhones(reason.trim());
            if (!kept) throw new ReceiptError('ReasonRequired', 'A reason is required to void');
            // The stored void reason masks phones like the audit entry (security review AS6).
            await tx.execute(sql`
              UPDATE stock_receipts
              SET status = 'voided', voided_at = now(), voided_by = ${caller.id},
                  void_reason = ${kept}, void_group_id = ${result.groupId}, updated_at = now()
              WHERE id = ${id}`);
          },
        },
      );
    } catch (error) {
      if (error instanceof LedgerError && error.code === 'InsufficientStock') {
        throw new ReceiptError(
          'InsufficientStock',
          'Some of this stock has already left, so the receipt cannot be voided',
          [],
          await this.shortSkus(id),
        );
      }
      if (error instanceof LedgerError && error.code === 'AlreadyReversed') {
        throw new ReceiptError('AlreadyVoided', 'This receipt is already voided');
      }
      throw error;
    }
    // A concurrent void with the same key won: this call changed nothing.
    if (outcome.replayed) throw new ReceiptError('AlreadyVoided', 'This receipt is already voided');

    this.logger.log({
      event: 'stock_receipt.voided',
      receiptId: id,
      userId: caller.id,
    });
    return this.get(id, caller);
  }

  /** Receipt numbers by receipt id, for movement history links. Unknown ids are left out. */
  async numbersByIds(ids: readonly string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const { rows } = await this.connection.db.execute<{ id: string; number: string }>(sql`
      SELECT id, number FROM stock_receipts WHERE id = ANY(${pgArray([...new Set(ids)])}::uuid[])`);
    return new Map(rows.map((row) => [row.id, row.number]));
  }

  /** The receipt's SKUs whose on hand at its location is below the line's quantity now. */
  private async shortSkus(id: string): Promise<string[]> {
    const { rows } = await this.connection.db.execute<{ variant_id: string }>(sql`
      SELECT l.variant_id
      FROM stock_receipt_lines l
      JOIN stock_receipts r ON r.id = l.receipt_id
      WHERE l.receipt_id = ${id}
        AND coalesce((SELECT sum(s.on_hand) FROM stock_levels s
                      WHERE s.variant_id = l.variant_id AND s.location_id = r.location_id), 0)
            < l.quantity
      ORDER BY l.position`);
    return rows.map((row) => row.variant_id);
  }

  /**
   * The answer to a key that already holds a receipt. Only the person who posted it gets a
   * replay; anyone else gets `IdempotencyConflict` whatever the body, before the hash is compared,
   * so the answer never tells a caller without `cost.view` whether a guessed unit cost was right
   * (spec 0008 security review M1).
   */
  private replayOf(stored: StoredReceipt, hash: string, caller: ReceiptCaller) {
    if (stored.detail.postedBy.id !== caller.id || stored.requestHash !== hash) {
      throw new ReceiptError(
        'IdempotencyConflict',
        'This idempotency key was already used for a different receipt',
      );
    }
    return serializeReceipt(stored.detail, caller.access);
  }

  /** One active warehouse or shop; the ledger alone would accept transit and scrap. */
  private async checkLocation(locationId: string): Promise<void> {
    const { rows } = await this.connection.db.execute<{ ok: boolean }>(sql`
      SELECT kind IN ('warehouse', 'shop') AND archived_at IS NULL AS ok
      FROM locations WHERE id = ${locationId}`);
    if (!rows[0]?.ok) {
      throw new ReceiptError('InvalidLocation', 'Choose an active warehouse or shop');
    }
  }

  /** Every line fault at once, with indexes (AC-7). Returns each SKU's base unit. */
  private async checkLines(input: CreateInput): Promise<Map<string, string>> {
    const checks = await this.catalog.checkStockable(input.lines.map((line) => line.skuId));
    const faults: StockReceiptLineError[] = [];
    const seen = new Set<string>();
    const units = new Map<string, string>();
    input.lines.forEach((line, index) => {
      const check = checks.get(line.skuId);
      if (!check || check.fault === 'UNKNOWN_SKU') {
        faults.push({ index, code: 'UNKNOWN_SKU' });
      } else if (check.fault) {
        faults.push({ index, code: check.fault });
      } else {
        units.set(line.skuId, check.sku.baseUomId);
      }
      if (seen.has(line.skuId)) faults.push({ index, code: 'DUPLICATE_SKU' });
      seen.add(line.skuId);
      const cents = mulDivRound(UnitCost.of(line.unitCost).scaled, BigInt(line.quantity), 100n);
      if (cents > MAX_LINE_TOTAL_CENTS) faults.push({ index, code: 'LINE_TOTAL_TOO_LARGE' });
    });
    if (faults.length) {
      throw new ReceiptError('InvalidLines', 'Some lines cannot be received', faults);
    }
    return units;
  }

  /**
   * The posting date (spec 0006, Value sourcing): absent or today in the install time zone
   * leaves the ledger's default (now); an earlier day is 12:00 that day in that zone, computed
   * in SQL so daylight saving is right; a later day is `FutureDate`.
   */
  private async effectiveAt(receiptDate: string | undefined): Promise<Date | undefined> {
    if (!receiptDate) return undefined;
    const { timezone } = await this.settings.read(['timezone']);
    const { rows } = await this.connection.db.execute<{
      day: 'past' | 'today' | 'future';
      at: string;
    }>(sql`
      SELECT CASE WHEN d > today THEN 'future' WHEN d = today THEN 'today' ELSE 'past' END AS day,
             to_char(((d + time '12:00') AT TIME ZONE ${timezone}) AT TIME ZONE 'UTC', ${ISO_UTC}) AS at
      FROM (SELECT ${receiptDate}::date AS d, (now() AT TIME ZONE ${timezone})::date AS today) s`);
    const row = rows[0];
    if (!row) throw new Error('The date query returned no row');
    if (row.day === 'future') {
      throw new ReceiptError('FutureDate', 'A receipt cannot be dated in the future');
    }
    return row.day === 'today' ? undefined : new Date(row.at);
  }

  /** The stored receipt with every field, or null. */
  private async find(executor: Executor, id: string): Promise<StoredReceipt | null> {
    const receipt = (
      await executor.execute<{
        id: string;
        request_hash: string;
        number: string;
        status: 'posted' | 'voided';
        location_id: string;
        location_code: string;
        location_name: LocalizedText;
        effective_at: string;
        created_at: string;
        reference: string | null;
        note: string | null;
        posted_by: string;
        voided_at: string | null;
        voided_by: string | null;
        void_reason: string | null;
      }>(sql`
        SELECT r.id, r.request_hash, r.number, r.status, r.location_id,
               l.code AS location_code, l.name AS location_name,
               to_char(r.effective_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS effective_at,
               to_char(r.created_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS created_at,
               r.reference, r.note, r.posted_by,
               to_char(r.voided_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS voided_at,
               r.voided_by, r.void_reason
        FROM stock_receipts r JOIN locations l ON l.id = r.location_id
        WHERE r.id = ${id}`)
    ).rows[0];
    if (!receipt) return null;
    const lines = await executor.execute<{
      id: string;
      position: number;
      variant_id: string;
      quantity: number;
      unit_cost: string;
      line_total: string;
    }>(sql`
      SELECT id, position, variant_id, quantity, unit_cost, line_total
      FROM stock_receipt_lines WHERE receipt_id = ${id} ORDER BY position`);
    const skus = await this.catalog.getSkus(lines.rows.map((line) => line.variant_id));
    const people = [receipt.posted_by, ...(receipt.voided_by ? [receipt.voided_by] : [])];
    const names = await this.staff.namesByIds(people);
    const person = (userId: string) => ({ id: userId, name: names.get(userId) ?? '' });

    const referenceValue = lines.rows.reduce(
      (sum, line) => sum.plus(Money.of(line.line_total)),
      Money.zero,
    );
    return {
      id: receipt.id,
      requestHash: receipt.request_hash,
      detail: {
        id: receipt.id,
        number: receipt.number,
        status: receipt.status,
        location: {
          id: receipt.location_id,
          code: receipt.location_code,
          name: { en: receipt.location_name.en, ar: receipt.location_name.ar },
        },
        effectiveAt: receipt.effective_at,
        reference: receipt.reference,
        note: receipt.note,
        postedBy: person(receipt.posted_by),
        postedAt: receipt.created_at,
        lines: lines.rows.map((line) => {
          const sku = skus.get(line.variant_id);
          return {
            id: line.id,
            position: line.position,
            sku: { id: line.variant_id, code: sku?.code ?? '', name: sku?.name ?? {} },
            quantity: line.quantity,
            unitCost: line.unit_cost,
            lineTotal: line.line_total,
          };
        }),
        totalQuantity: lines.rows.reduce((sum, line) => sum + line.quantity, 0),
        referenceValue: referenceValue.toString(),
        void:
          receipt.voided_at && receipt.voided_by && receipt.void_reason
            ? {
                voidedAt: receipt.voided_at,
                voidedBy: person(receipt.voided_by),
                reason: receipt.void_reason,
              }
            : null,
      },
    };
  }
}
