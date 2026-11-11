import { Inject, Injectable } from '@nestjs/common';
import {
  CUSTOMER_PROFILE_GUARDED_FIELDS,
  type CustomerAbsorbedMerge,
  type CustomerChannelIdView,
  type CustomerFlagView,
  type CustomerPhoneView,
  type CustomerProfile,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../../database/database.module.js';
import { pgArray, type Executor } from '../../database/sql.js';
import { StaffDirectory } from '../../identity/staff/staff-directory.js';
import type { Access } from '../../platform/access/access.js';
import { briefRows, FLAG_SEVERITY_SQL, utc } from '../customer-briefs.js';
import { CustomersError } from '../customers.errors.js';
import { CustomersService } from '../customers.service.js';
import { ChannelLabels } from './channel-labels.js';
import { CustomerRiskSignals } from './customer-risk-signals.js';

interface CanonicalRow extends Record<string, unknown> {
  name: string | null;
  created_at: string;
  updated_at: string;
}

interface PhoneRow extends Record<string, unknown> {
  phone_e164: string;
  kind: CustomerPhoneView['kind'];
  is_primary: boolean;
  first_seen_at: string;
  last_seen_at: string;
}

interface ExternalIdRow extends Record<string, unknown> {
  id: string;
  kind: CustomerChannelIdView['kind'];
  external_id: string;
  connection_id: string | null;
  channel_id: string | null;
  created_at: string;
}

interface FlagRow extends Record<string, unknown> {
  risk_flag: CustomerFlagView['kind'];
  risk_flag_source: CustomerFlagView['source'];
  risk_flag_note: string | null;
  set_at: string;
  risk_flag_set_by: string | null;
}

interface MergeRow extends Record<string, unknown> {
  id: string;
  merged_id: string;
  at: string;
  undoable: boolean;
}

/**
 * Reads one customer's profile (spec 0014 AC-4): the union of phones and channel ids over all the
 * ids of the canonical customer, the live merges she absorbed, and her flag by the canonical rule.
 * A merged id answers its survivor with `resolvedFrom` set. Read only: it must never write, and
 * it reads other modules' data only through their exported services (`ChannelsService` for store
 * and channel labels through `ChannelLabels`, `StaffDirectory` for the name of the person who set a
 * flag, and `OrderQueries.countsForCustomers` for the signal and the order count).
 */
@Injectable()
export class CustomerProfileService {
  /** Takes the database and the services the profile asks. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    private readonly customers: CustomersService,
    private readonly labels: ChannelLabels,
    private readonly signals: CustomerRiskSignals,
    private readonly staff: StaffDirectory,
  ) {}

  /**
   * The profile of the canonical customer behind `askedId`; throws `CUSTOMER_NOT_FOUND` for an
   * unknown id. The returner `signal` and the `orderCount` read order data, so they are added only
   * for a viewer with `orders.view` (`CUSTOMER_PROFILE_GUARDED_FIELDS`, spec 0014 AC-15).
   */
  async profile(askedId: string, viewer: Access): Promise<CustomerProfile> {
    // One snapshot for every read, so a merge that commits half way never shows a phone of the
    // old record beside the id set of the new one, or counts orders of a record it no longer holds.
    const read = await this.connection.db.transaction(
      async (tx) => {
        const profile = await this.readProfile(tx, askedId);
        // Each guarded field asks its own permission, so a later split of the keys holds.
        const showsSignal = viewer.has(CUSTOMER_PROFILE_GUARDED_FIELDS.signal);
        const showsCount = viewer.has(CUSTOMER_PROFILE_GUARDED_FIELDS.orderCount);
        if (!showsSignal && !showsCount) return { ...profile, orders: null };
        const ids = await this.customers.idsOf(profile.profile.id, tx);
        return {
          ...profile,
          orders: {
            ...(showsSignal
              ? { signal: await this.signals.signalOf(ids, profile.flagRow !== undefined, tx) }
              : {}),
            ...(showsCount ? { orderCount: await this.signals.orderCount(ids, tx) } : {}),
          },
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    return {
      ...read.profile,
      flag: await this.flag(read.flagRow),
      ...(read.orders ?? {}),
    };
  }

  private async readProfile(
    db: Executor,
    askedId: string,
  ): Promise<{ profile: Omit<CustomerProfile, 'flag'>; flagRow: FlagRow | undefined }> {
    const canonicalId = await this.customers.canonicalOf(askedId, db);
    if (canonicalId === null) {
      throw new CustomersError('CUSTOMER_NOT_FOUND', 'No customer has that id');
    }
    const ids = await this.customers.idsOf(canonicalId, db);
    const idList = pgArray(ids);

    // `updatedAt` is the greatest stamp over every id of the customer, not the canonical row's
    // alone: a merge stamps the rows it absorbs, so a flag clear made from a profile read before
    // the merge is refused (`STALE_RECORD`) instead of emptying the flag of a record it never saw.
    const [row] = (
      await db.execute<CanonicalRow>(sql`
        SELECT name, ${utc('created_at')} AS created_at,
               (SELECT ${utc('max(m.updated_at)')} FROM customers m
                 WHERE m.id = ANY(${idList}::uuid[])) AS updated_at
        FROM customers WHERE id = ${canonicalId}::uuid`)
    ).rows;
    if (!row) throw new CustomersError('CUSTOMER_NOT_FOUND', 'No customer has that id');

    const phones = (
      await db.execute<PhoneRow>(sql`
        SELECT p.phone_e164, p.kind, p.is_primary,
               ${utc('p.first_seen_at')} AS first_seen_at, ${utc('p.last_seen_at')} AS last_seen_at
        FROM customer_phones p
        WHERE p.customer_id = ANY(${idList}::uuid[])
        ORDER BY p.is_primary DESC, (p.customer_id = ${canonicalId}::uuid) DESC,
                 p.first_seen_at, p.id`)
    ).rows.map((phone): CustomerPhoneView => ({
      e164: phone.phone_e164,
      kind: phone.kind,
      isPrimary: phone.is_primary,
      firstSeenAt: phone.first_seen_at,
      lastSeenAt: phone.last_seen_at,
    }));

    const externalIds = (
      await db.execute<ExternalIdRow>(sql`
        SELECT id, kind, external_id, connection_id, channel_id, ${utc('created_at')} AS created_at
        FROM customer_external_ids
        WHERE customer_id = ANY(${idList}::uuid[])
        ORDER BY created_at, id`)
    ).rows;

    const flagRow = (
      await db.execute<FlagRow>(sql`
        SELECT risk_flag, risk_flag_source, risk_flag_note,
               ${utc('risk_flag_set_at')} AS set_at, risk_flag_set_by
        FROM customers
        WHERE id = ANY(${idList}::uuid[]) AND risk_flag IS NOT NULL
        ORDER BY (id = ${canonicalId}::uuid) DESC,
                 array_position(${FLAG_SEVERITY_SQL}::text[], risk_flag::text),
                 risk_flag_set_at DESC, id
        LIMIT 1`)
    ).rows[0];

    const merges = (
      await db.execute<MergeRow>(sql`
        SELECT m.id, m.merged_id, ${utc('m.recorded_at')} AS at,
               (m.survivor_id = ${canonicalId}::uuid
                AND mc.merged_into_id = ${canonicalId}::uuid) AS undoable
        FROM customer_merges m JOIN customers mc ON mc.id = m.merged_id
        WHERE m.action = 'merge' AND m.survivor_id = ANY(${idList}::uuid[])
          AND NOT EXISTS (SELECT 1 FROM customer_merges u WHERE u.undoes_merge_id = m.id)
        ORDER BY m.recorded_at DESC, m.id DESC`)
    ).rows;

    return {
      profile: {
        id: canonicalId,
        resolvedFrom: askedId === canonicalId ? null : askedId,
        name: row.name,
        phones,
        channelIds: await this.channelIds(db, externalIds),
        merges: await this.absorbed(db, merges),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      flagRow,
    };
  }

  /** Adds the store (Shopify) or channel (partner reference) each id came from. */
  private async channelIds(
    db: Executor,
    rows: readonly ExternalIdRow[],
  ): Promise<CustomerChannelIdView[]> {
    const labels = await this.labels.of(db, rows);
    return rows.map((row, index) => ({
      id: row.id,
      kind: row.kind,
      externalId: row.external_id,
      storeCode: labels[index]?.storeCode ?? null,
      storeName: labels[index]?.storeName ?? null,
      channelCode: labels[index]?.channelCode ?? null,
      channelName: labels[index]?.channelName ?? null,
      createdAt: row.created_at,
    }));
  }

  /** The merged record of each live merge, as a brief. */
  private async absorbed(
    db: Executor,
    rows: readonly MergeRow[],
  ): Promise<CustomerAbsorbedMerge[]> {
    const briefs = new Map(
      (
        await briefRows(
          db,
          rows.map((row) => row.merged_id),
        )
      ).map((brief) => [brief.id, brief]),
    );
    return rows.flatMap((row) => {
      const other = briefs.get(row.merged_id);
      return other ? [{ mergeId: row.id, other, at: row.at, undoable: row.undoable }] : [];
    });
  }

  /** The flag block with the name of the person who set it. */
  private async flag(row: FlagRow | undefined): Promise<CustomerFlagView | null> {
    if (!row) return null;
    const names =
      row.risk_flag_set_by === null
        ? new Map<string, string>()
        : await this.staff.namesByIds([row.risk_flag_set_by]);
    return {
      kind: row.risk_flag,
      source: row.risk_flag_source,
      note: row.risk_flag_note,
      setAt: row.set_at,
      setByName: row.risk_flag_set_by === null ? null : (names.get(row.risk_flag_set_by) ?? null),
    };
  }
}
