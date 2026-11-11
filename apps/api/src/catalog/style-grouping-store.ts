import type { AuditActionCode, GroupingListQuery, LocalizedText } from '@ssdashboard/contracts';
import { sql, type DatabaseConnection, type SQL } from '@ssdashboard/db';
import type { AuditService, JsonObject } from '../audit/audit.service.js';
import { isStillReferenced, pgConstraint, type Executor } from '../database/sql.js';
import { decodeKeyset, encodeKeyset } from '../platform/keyset-cursor.js';
import { catalogActor, type CatalogCaller } from './catalog-caller.js';
import { catalogTransaction } from './catalog-transaction.js';
import { CatalogError, type CatalogErrorCode } from './catalog.service.js';
import { codePrefixOf, escapeLike, ISO_UTC, searchWords } from './search/sku-list-sql.js';

/**
 * What differs between the two ways a brand groups its styles (spec 0012, AC-6 and AC-7):
 * seasons (with optional dates, the seeded `CORE` protected) and product groups (no dates, the
 * seeded `MAIN` protected). Everything else (code rules, stale check, archive, delete only while
 * unreferenced, audit) is the same, so one store serves both.
 */
export interface GroupingKind {
  table: 'seasons' | 'product_groups';
  recordType: 'season' | 'product_group';
  /** The noun in messages: `Season`, `Product group`. */
  noun: string;
  /** The seeded row that can be renamed but never archived, deleted, or recoded. */
  protectedCode: string;
  codeTaken: CatalogErrorCode;
  protectedError: CatalogErrorCode;
  /** The unique constraint on (`tenant_id`, `code`). */
  codeConstraint: string;
  hasDates: boolean;
  actions: Record<'created' | 'edited' | 'archived' | 'unarchived' | 'deleted', AuditActionCode>;
}

/** One season or product group as the store reads it (`startsOn` and `endsOn` null without dates). */
export interface GroupingRow {
  id: string;
  code: string;
  name: LocalizedText;
  startsOn: string | null;
  endsOn: string | null;
  archived: boolean;
  protected: boolean;
  updatedAt: string;
}

/** What a create carries: the shaped code, the name, and dates for a season. */
export interface GroupingCreate {
  code: string;
  name: LocalizedText;
  startsOn?: string | null;
  endsOn?: string | null;
}

/** What an edit carries: the stale check value and only the fields to change. */
export interface GroupingUpdate {
  updatedAt: string;
  code?: string;
  name?: LocalizedText;
  startsOn?: string | null;
  endsOn?: string | null;
}

interface StoredRow extends Record<string, unknown> {
  id: string;
  code: string;
  name: LocalizedText;
  starts_on: string | null;
  ends_on: string | null;
  archived: boolean;
  updated_at: string;
}

/** A name as stored and compared: both languages, absent ones as null. */
const nameOf = (name: LocalizedText): { en: string | null; ar: string | null } => ({
  en: name.en ?? null,
  ar: name.ar ?? null,
});

/** A name as written to the `jsonb` column: only the languages it has (never a null language). */
const storedName = (name: LocalizedText): string =>
  JSON.stringify({
    ...(name.en ? { en: name.en } : {}),
    ...(name.ar ? { ar: name.ar } : {}),
  });

const sameName = (a: LocalizedText, b: LocalizedText) =>
  JSON.stringify(nameOf(a)) === JSON.stringify(nameOf(b));

/**
 * The rules of seasons and product groups (spec 0012, AC-6, AC-7, AC-17), for one `GroupingKind`.
 * Every write runs in its own READ COMMITTED `catalogTransaction` (run again once on a deadlock),
 * locks the row `FOR UPDATE`, and records its audit entry there; a change that changes nothing
 * writes nothing. It never touches styles or cost records: a style takes a season or group
 * through `CatalogService.assignableGrouping`, which reads it `FOR SHARE` so an archive waits
 * for that style write (and the reverse).
 */
export class StyleGroupingStore {
  /** Takes the app connection, the audit writer, and the kind of grouping it serves. */
  constructor(
    private readonly connection: DatabaseConnection,
    private readonly audit: AuditService,
    private readonly kind: GroupingKind,
  ) {}

  /**
   * A page ordered by code (`COLLATE "C"`, keyset on the code). `q` matches a code prefix, or
   * every normalized word of q inside the normalized names (`ssd_search_normalize`, in SQL).
   */
  async list(
    query: GroupingListQuery,
  ): Promise<{ items: GroupingRow[]; nextCursor: string | null }> {
    const db = this.connection.db;
    const filters: SQL[] = [];
    if (query.status === 'active') filters.push(sql`archived_at IS NULL`);
    if (query.status === 'archived') filters.push(sql`archived_at IS NOT NULL`);
    if (query.cursor) {
      const [after] = decodeKeyset(query.cursor, 1);
      filters.push(sql`code COLLATE "C" > ${after} COLLATE "C"`);
    }
    if (query.q) {
      const words = await searchWords(db, query.q);
      const matches: SQL[] = [sql`code COLLATE "C" LIKE ${codePrefixOf(query.q)}`];
      if (words.length) {
        const document = sql`ssd_search_normalize(concat_ws(' ', name ->> 'en', name ->> 'ar'))`;
        matches.push(
          sql`(${sql.join(
            words.map((word) => sql`${document} LIKE ${`%${escapeLike(word)}%`}`),
            sql` AND `,
          )})`,
        );
      }
      filters.push(sql`(${sql.join(matches, sql` OR `)})`);
    }
    const { rows } = await db.execute<StoredRow>(sql`
      SELECT ${this.columns()} FROM ${sql.identifier(this.kind.table)}
      ${filters.length ? sql`WHERE ${sql.join(filters, sql` AND `)}` : sql``}
      ORDER BY code COLLATE "C"
      LIMIT ${query.limit + 1}`);
    const page = rows.slice(0, query.limit).map((row) => this.toRow(row));
    const last = page.at(-1);
    return {
      items: page,
      nextCursor: rows.length > query.limit && last ? encodeKeyset([last.code]) : null,
    };
  }

  /** Adds one, recording `<kind>.created`. A code already used is the kind's `codeTaken`. */
  async create(input: GroupingCreate, caller: CatalogCaller): Promise<GroupingRow> {
    const correlationId = this.audit.newCorrelationId();
    try {
      return await catalogTransaction(this.connection.db, async (tx) => {
        const dates = this.kind.hasDates ? sql`, starts_on, ends_on` : sql``;
        const dateValues = this.kind.hasDates
          ? sql`, ${input.startsOn ?? null}::date, ${input.endsOn ?? null}::date`
          : sql``;
        const { rows } = await tx.execute<StoredRow>(sql`
          INSERT INTO ${sql.identifier(this.kind.table)} (code, name${dates})
          VALUES (${input.code}, ${storedName(input.name)}::jsonb${dateValues})
          RETURNING ${this.columns()}`);
        const row = this.toRow(this.must(rows[0]));
        await this.audit.record(tx, {
          actor: catalogActor(caller, 'catalog.manage'),
          action: this.kind.actions.created,
          record: { type: this.kind.recordType, id: row.id, label: row.code },
          after: this.snapshot(row),
          correlationId,
        });
        return row;
      });
    } catch (error) {
      throw this.codeClash(error, input.code);
    }
  }

  /**
   * Edits code, name, and (seasons) dates with the stale check (`Stale`). Recoding the protected
   * row is the kind's `protectedError`; dates that end before they start, with the stored ones,
   * are `InvalidInput`. Records `<kind>.edited` with the changed fields only.
   */
  async update(id: string, input: GroupingUpdate, caller: CatalogCaller): Promise<GroupingRow> {
    const correlationId = this.audit.newCorrelationId();
    try {
      return await catalogTransaction(this.connection.db, async (tx) => {
        const current = await this.lock(tx, id);
        if (current.updatedAt !== input.updatedAt) {
          throw new CatalogError(
            'Stale',
            `Someone else changed this ${this.kind.noun.toLowerCase()}. Reload and try again.`,
          );
        }
        if (input.code !== undefined && input.code !== current.code && current.protected) {
          throw new CatalogError(
            this.kind.protectedError,
            `The ${current.code} ${this.kind.noun.toLowerCase()} keeps its code`,
          );
        }
        const before: JsonObject = {};
        const after: JsonObject = {};
        const sets: SQL[] = [];
        if (input.code !== undefined && input.code !== current.code) {
          before.code = current.code;
          after.code = input.code;
          sets.push(sql`code = ${input.code}`);
        }
        if (input.name !== undefined && !sameName(input.name, current.name)) {
          before.name = nameOf(current.name);
          after.name = nameOf(input.name);
          sets.push(sql`name = ${storedName(input.name)}::jsonb`);
        }
        if (this.kind.hasDates) {
          const startsOn = input.startsOn === undefined ? current.startsOn : input.startsOn;
          const endsOn = input.endsOn === undefined ? current.endsOn : input.endsOn;
          if (startsOn && endsOn && startsOn > endsOn) {
            throw new CatalogError('InvalidInput', 'The end date is before the start date');
          }
          if (startsOn !== current.startsOn) {
            before.startsOn = current.startsOn;
            after.startsOn = startsOn;
            sets.push(sql`starts_on = ${startsOn}::date`);
          }
          if (endsOn !== current.endsOn) {
            before.endsOn = current.endsOn;
            after.endsOn = endsOn;
            sets.push(sql`ends_on = ${endsOn}::date`);
          }
        }
        if (!sets.length) return current;
        const { rows } = await tx.execute<StoredRow>(sql`
          UPDATE ${sql.identifier(this.kind.table)}
          SET ${sql.join(sets, sql`, `)}, updated_at = now()
          WHERE id = ${id}
          RETURNING ${this.columns()}`);
        const row = this.toRow(this.must(rows[0]));
        await this.audit.record(tx, {
          actor: catalogActor(caller, 'catalog.manage'),
          action: this.kind.actions.edited,
          record: { type: this.kind.recordType, id, label: row.code },
          before,
          after,
          correlationId,
        });
        return row;
      });
    } catch (error) {
      throw this.codeClash(error, input.code);
    }
  }

  /**
   * Archives or unarchives one, recording `<kind>.archived` or `<kind>.unarchived` when it
   * changed. Archiving the protected row is the kind's `protectedError`. An archived one stays on
   * the styles and cost records that hold it; only new assignments refuse it.
   */
  async setArchived(id: string, archived: boolean, caller: CatalogCaller): Promise<GroupingRow> {
    const correlationId = this.audit.newCorrelationId();
    return catalogTransaction(this.connection.db, async (tx) => {
      const current = await this.lock(tx, id);
      if (archived && current.protected) {
        throw new CatalogError(
          this.kind.protectedError,
          `The ${current.code} ${this.kind.noun.toLowerCase()} cannot be archived`,
        );
      }
      if (current.archived === archived) return current;
      const { rows } = await tx.execute<StoredRow>(sql`
        UPDATE ${sql.identifier(this.kind.table)}
        SET archived_at = ${archived ? sql`now()` : sql`NULL`}, updated_at = now()
        WHERE id = ${id}
        RETURNING ${this.columns()}`);
      const row = this.toRow(this.must(rows[0]));
      await this.audit.record(tx, {
        actor: catalogActor(caller, 'catalog.manage'),
        action: archived ? this.kind.actions.archived : this.kind.actions.unarchived,
        record: { type: this.kind.recordType, id, label: row.code },
        before: { archived: !archived },
        after: { archived },
        correlationId,
      });
      return row;
    });
  }

  /**
   * Deletes one while no style or cost record references it (`InUse` otherwise, from the
   * restricting foreign keys), recording `<kind>.deleted` with what it was. The protected row is
   * the kind's `protectedError`.
   */
  async remove(id: string, caller: CatalogCaller): Promise<void> {
    const correlationId = this.audit.newCorrelationId();
    try {
      await catalogTransaction(this.connection.db, async (tx) => {
        const current = await this.lock(tx, id);
        if (current.protected) {
          throw new CatalogError(
            this.kind.protectedError,
            `The ${current.code} ${this.kind.noun.toLowerCase()} cannot be deleted`,
          );
        }
        await tx.execute(sql`DELETE FROM ${sql.identifier(this.kind.table)} WHERE id = ${id}`);
        await this.audit.record(tx, {
          actor: catalogActor(caller, 'catalog.manage'),
          action: this.kind.actions.deleted,
          record: { type: this.kind.recordType, id, label: current.code },
          before: this.snapshot(current),
          correlationId,
        });
      });
    } catch (error) {
      if (isStillReferenced(error)) {
        throw new CatalogError(
          'InUse',
          `This ${this.kind.noun.toLowerCase()} is used by styles or cost records. Archive it instead.`,
        );
      }
      throw error;
    }
  }

  private columns(): SQL {
    const dates = this.kind.hasDates
      ? sql`to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on`
      : sql`NULL::text AS starts_on, NULL::text AS ends_on`;
    return sql`id, code, name, ${dates}, archived_at IS NOT NULL AS archived,
      to_char(updated_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS updated_at`;
  }

  private async lock(tx: Executor, id: string): Promise<GroupingRow> {
    const { rows } = await tx.execute<StoredRow>(sql`
      SELECT ${this.columns()} FROM ${sql.identifier(this.kind.table)}
      WHERE id = ${id} FOR UPDATE`);
    const row = rows[0];
    if (!row) throw new CatalogError('NotFound', `${this.kind.noun} not found`);
    return this.toRow(row);
  }

  private toRow(row: StoredRow): GroupingRow {
    return {
      id: row.id,
      code: row.code,
      name: { en: row.name.en ?? undefined, ar: row.name.ar ?? undefined },
      startsOn: row.starts_on,
      endsOn: row.ends_on,
      archived: row.archived,
      protected: row.code === this.kind.protectedCode,
      updatedAt: row.updated_at,
    };
  }

  /** The fields a created or deleted entry shows. */
  private snapshot(row: GroupingRow): JsonObject {
    return {
      code: row.code,
      name: nameOf(row.name),
      ...(this.kind.hasDates ? { startsOn: row.startsOn, endsOn: row.endsOn } : {}),
    };
  }

  private must(row: StoredRow | undefined): StoredRow {
    if (!row) throw new Error(`The ${this.kind.table} write returned no row`);
    return row;
  }

  private codeClash(error: unknown, code: string | undefined): unknown {
    if (pgConstraint(error) === this.kind.codeConstraint) {
      return new CatalogError(this.kind.codeTaken, `Code ${code ?? ''} is already in use`);
    }
    if (pgConstraint(error) === 'seasons_dates_in_order') {
      return new CatalogError('InvalidInput', 'The end date is before the start date');
    }
    return error;
  }
}
