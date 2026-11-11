import { Inject, Injectable } from '@nestjs/common';
import {
  timelineLens,
  type CustomerBrief,
  type CustomerExternalIdKind,
  type CustomerRiskFlag,
  type CustomerRiskFlagSource,
  type CustomerTimelineEntry,
  type CustomerTimelineKind,
  type CustomerTimelineLens,
  type CustomerTimelinePage,
  type PhoneKind,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../../database/database.module.js';
import { pgArray, type Executor } from '../../database/sql.js';
import { StaffDirectory } from '../../identity/staff/staff-directory.js';
import { OrderQueries, type CustomerOrderRow } from '../../orders/reading/order-query.service.js';
import type { Access } from '../../platform/access/access.js';
import { InvalidCursorError } from '../../platform/keyset-cursor.js';
import { briefRows, FLAG_SEVERITY_SQL, utc } from '../customer-briefs.js';
import { CustomersError } from '../customers.errors.js';
import { CustomersService } from '../customers.service.js';
import { ChannelLabels } from './channel-labels.js';
import {
  compareTimeline,
  decodeTimelineCursor,
  encodeTimelineCursor,
  orderCursorAfter,
  type TimelinePosition,
  type TimelineSource,
} from './timeline-cursor.js';

/** What a timeline read asks: the cursor of the last page, the page size, and the kinds wanted. */
export interface TimelineRequest {
  cursor?: string;
  limit: number;
  kinds?: readonly CustomerTimelineKind[];
}

/** One own entry's place, before its details are read. */
interface OwnRow extends Record<string, unknown> {
  source: Exclude<TimelineSource, 'order'>;
  id: string;
  at: string;
  kind: Exclude<CustomerTimelineKind, 'order'>;
}

interface MergeDetailRow extends Record<string, unknown> {
  id: string;
  survivor_id: string;
  merged_id: string;
  reason: string | null;
  actor_id: string;
  undoable: boolean;
}

interface PhoneDetailRow extends Record<string, unknown> {
  id: string;
  phone_e164: string;
  kind: PhoneKind;
  is_primary: boolean;
}

interface ChannelIdDetailRow extends Record<string, unknown> {
  id: string;
  kind: CustomerExternalIdKind;
  external_id: string;
  connection_id: string | null;
  channel_id: string | null;
}

interface FlagDetailRow extends Record<string, unknown> {
  id: string;
  risk_flag: CustomerRiskFlag;
  risk_flag_source: CustomerRiskFlagSource;
  risk_flag_note: string | null;
  risk_flag_set_by: string | null;
}

/** A place in the merged order with how to build its entry. */
type Placed =
  | (TimelinePosition & { from: 'own'; row: OwnRow })
  | (TimelinePosition & { from: 'order'; order: CustomerOrderRow });

/** The details read for one page of own entries, keyed by row id. */
interface OwnDetails {
  merges: Map<string, MergeDetailRow>;
  others: Map<string, CustomerBrief>;
  phones: Map<string, PhoneDetailRow>;
  channelIds: Map<
    string,
    ChannelIdDetailRow & { label: Awaited<ReturnType<ChannelLabels['of']>>[number] }
  >;
  flags: Map<string, FlagDetailRow>;
}

/**
 * The customer timeline of spec 0014 AC-14 and AC-15: the entries of every id of the canonical
 * customer, newest first, merged from this module's own rows (`customer_merges`, the phones at
 * their first seen time, the channel ids at their creation, the current flag) and the orders
 * module's `OrderQueries.forCustomers`, by one total order (`at` descending, source key, id
 * descending). Each source answers at most `limit + 1` entries strictly after the cursor and the
 * service merges and cuts; the order source resumes from its own keyset cursor, derived from the
 * timeline position (`orderCursorAfter`). The viewer's lens (`timelineLens` over
 * `CUSTOMER_TIMELINE_KINDS`) decides which kinds and guarded fields leave the api. Read only; it
 * never names an orders table and never writes.
 */
@Injectable()
export class CustomerTimelineService {
  /** Takes the database and the services the timeline reads through. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    private readonly customers: CustomersService,
    private readonly orders: OrderQueries,
    private readonly labels: ChannelLabels,
    private readonly staff: StaffDirectory,
  ) {}

  /**
   * One page of the timeline of the customer behind `askedId` (a merged id reads its survivor's).
   * Throws `CUSTOMER_NOT_FOUND` for an unknown id and `INVALID_CURSOR` for a cursor this route
   * did not issue. A kind the viewer does not reach is left out, never refused.
   */
  async page(
    askedId: string,
    request: TimelineRequest,
    viewer: Access,
  ): Promise<CustomerTimelinePage> {
    const lens = timelineLens((permission) => viewer.has(permission));
    const wanted = request.kinds ? new Set(request.kinds) : null;
    const kinds = lens.kinds.filter((kind) => wanted === null || wanted.has(kind));
    let position: TimelinePosition | null = null;
    if (request.cursor !== undefined) {
      try {
        position = decodeTimelineCursor(request.cursor);
      } catch (error) {
        if (error instanceof InvalidCursorError) {
          throw new CustomersError('INVALID_CURSOR', 'The cursor is not one this route issued');
        }
        throw error;
      }
    }

    // One snapshot for every source, so a merge that commits between two reads never shows an
    // order of a record whose merge entry is missing, or the other way round.
    const read = await this.connection.db.transaction(
      async (tx) => {
        const canonicalId = await this.customers.canonicalOf(askedId, tx);
        if (canonicalId === null) {
          throw new CustomersError('CUSTOMER_NOT_FOUND', 'No customer has that id');
        }
        const ids = await this.customers.idsOf(canonicalId, tx);
        const ownKinds = kinds.filter((kind) => kind !== 'order');
        const own = await this.ownRows(tx, canonicalId, ids, ownKinds, position, request.limit + 1);
        const orderPage = kinds.includes('order')
          ? await this.orders.forCustomers(
              ids,
              { cursor: orderCursorAfter(position), limit: request.limit },
              tx,
            )
          : { items: [], nextCursor: null };

        const placed: Placed[] = [
          ...own.map((row): Placed => ({
            at: row.at,
            source: row.source,
            id: row.id,
            from: 'own',
            row,
          })),
          ...orderPage.items.map((order): Placed => ({
            at: order.placedAt,
            source: 'order',
            id: order.id,
            from: 'order',
            order,
          })),
        ].sort(compareTimeline);
        const items = placed.slice(0, request.limit);
        const more = placed.length > request.limit || orderPage.nextCursor !== null;
        const details = await this.ownDetails(
          tx,
          canonicalId,
          items.flatMap((item) => (item.from === 'own' ? [item.row] : [])),
        );
        return { canonicalId, items, more, details };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );

    const names = await this.staff.namesByIds([
      ...[...read.details.merges.values()].map((row) => row.actor_id),
      ...[...read.details.flags.values()].flatMap((row) =>
        row.risk_flag_set_by === null ? [] : [row.risk_flag_set_by],
      ),
    ]);
    const last = read.items.at(-1);
    return {
      items: read.items.flatMap((item) =>
        this.entryOf(item, read.canonicalId, read.details, names, lens),
      ),
      nextCursor: read.more && last ? encodeTimelineCursor(last) : null,
    };
  }

  /**
   * At most `limit` own entries of the id set strictly after `position`, in the total order. The
   * flag source is the one record holding the canonical flag (spec 0002's rule).
   */
  private async ownRows(
    db: Executor,
    canonicalId: string,
    ids: readonly string[],
    kinds: readonly CustomerTimelineKind[],
    position: TimelinePosition | null,
    limit: number,
  ): Promise<OwnRow[]> {
    if (kinds.length === 0) return [];
    const idList = pgArray(ids);
    const after = position
      ? sql`AND (e.at < ${position.at}::timestamptz
             OR (e.at = ${position.at}::timestamptz AND e.source COLLATE "C" > ${position.source})
             OR (e.at = ${position.at}::timestamptz AND e.source = ${position.source}
                 AND e.id < ${position.id}::uuid))`
      : sql``;
    const { rows } = await db.execute<OwnRow>(sql`
      WITH flag_row AS (
        SELECT f.id, f.risk_flag_set_at AS at FROM customers f
        WHERE f.id = ANY(${idList}::uuid[]) AND f.risk_flag IS NOT NULL
        ORDER BY (f.id = ${canonicalId}::uuid) DESC,
                 array_position(${FLAG_SEVERITY_SQL}::text[], f.risk_flag::text),
                 f.risk_flag_set_at DESC, f.id
        LIMIT 1
      ), entries AS (
        SELECT 'merge'::text AS source, m.id, m.recorded_at AS at,
               CASE m.action WHEN 'merge' THEN 'merge' ELSE 'unmerge' END AS kind
        FROM customer_merges m
        WHERE m.survivor_id = ANY(${idList}::uuid[]) OR m.merged_id = ANY(${idList}::uuid[])
        UNION ALL
        SELECT 'phone', p.id, p.first_seen_at, 'phone_added'
        FROM customer_phones p WHERE p.customer_id = ANY(${idList}::uuid[])
        UNION ALL
        SELECT 'channel_id', x.id, x.created_at, 'channel_id_added'
        FROM customer_external_ids x WHERE x.customer_id = ANY(${idList}::uuid[])
        UNION ALL
        SELECT 'flag', fr.id, fr.at, 'flag' FROM flag_row fr
      )
      SELECT e.source, e.id, ${utc('e.at')} AS at, e.kind
      FROM entries e
      WHERE e.kind = ANY(${pgArray(kinds)}::text[]) ${after}
      ORDER BY e.at DESC, e.source COLLATE "C", e.id DESC
      LIMIT ${limit}`);
    return rows;
  }

  /** Reads what the own entries of one page show, one query per source. */
  private async ownDetails(
    db: Executor,
    canonicalId: string,
    rows: readonly OwnRow[],
  ): Promise<OwnDetails> {
    const idsOf = (source: OwnRow['source']) =>
      rows.filter((row) => row.source === source).map((row) => row.id);
    const details: OwnDetails = {
      merges: new Map(),
      others: new Map(),
      phones: new Map(),
      channelIds: new Map(),
      flags: new Map(),
    };

    const mergeIds = idsOf('merge');
    if (mergeIds.length > 0) {
      // A merge is undoable by the undo rule: no undo names it, its survivor is canonical, and
      // the merged record still points at the survivor.
      const { rows: merges } = await db.execute<MergeDetailRow>(sql`
        SELECT m.id, m.survivor_id, m.merged_id, m.reason, m.actor_id,
               (m.action = 'merge'
                AND NOT EXISTS (SELECT 1 FROM customer_merges u WHERE u.undoes_merge_id = m.id)
                AND s.merged_into_id IS NULL AND x.merged_into_id = m.survivor_id) AS undoable
        FROM customer_merges m
        JOIN customers s ON s.id = m.survivor_id
        JOIN customers x ON x.id = m.merged_id
        WHERE m.id = ANY(${pgArray(mergeIds)}::uuid[])`);
      for (const merge of merges) details.merges.set(merge.id, merge);
      const otherIds = [...new Set(merges.map((merge) => otherOf(merge, canonicalId).id))];
      for (const brief of await briefRows(db, otherIds)) details.others.set(brief.id, brief);
    }

    const phoneIds = idsOf('phone');
    if (phoneIds.length > 0) {
      const { rows: phones } = await db.execute<PhoneDetailRow>(sql`
        SELECT id, phone_e164, kind, is_primary FROM customer_phones
        WHERE id = ANY(${pgArray(phoneIds)}::uuid[])`);
      for (const phone of phones) details.phones.set(phone.id, phone);
    }

    const channelIdIds = idsOf('channel_id');
    if (channelIdIds.length > 0) {
      const { rows: external } = await db.execute<ChannelIdDetailRow>(sql`
        SELECT id, kind, external_id, connection_id, channel_id FROM customer_external_ids
        WHERE id = ANY(${pgArray(channelIdIds)}::uuid[])`);
      const labels = await this.labels.of(db, external);
      external.forEach((row, index) => {
        const label = labels[index];
        if (label) details.channelIds.set(row.id, { ...row, label });
      });
    }

    const flagIds = idsOf('flag');
    if (flagIds.length > 0) {
      const { rows: flags } = await db.execute<FlagDetailRow>(sql`
        SELECT id, risk_flag, risk_flag_source, risk_flag_note, risk_flag_set_by FROM customers
        WHERE id = ANY(${pgArray(flagIds)}::uuid[]) AND risk_flag IS NOT NULL`);
      for (const flag of flags) details.flags.set(flag.id, flag);
    }
    return details;
  }

  /** The entry of one place, through the viewer's lens; empty when its details are gone. */
  private entryOf(
    item: Placed,
    canonicalId: string,
    details: OwnDetails,
    names: ReadonlyMap<string, string>,
    lens: CustomerTimelineLens,
  ): CustomerTimelineEntry[] {
    if (item.from === 'order') {
      const order = item.order;
      return [
        {
          kind: 'order',
          id: order.id,
          at: order.placedAt,
          storeCode: order.storeCode,
          orderNumber: order.orderNumber,
          fulfillmentState: order.fulfillmentState,
          cashState: order.cashState,
          outcome: order.outcome,
          totalAmount: order.totalAmount,
          paymentMethod: order.paymentMethod,
          refusedReasonCode: order.refusedReasonCode,
        },
      ];
    }
    const { row } = item;
    switch (row.kind) {
      case 'merge':
      case 'unmerge': {
        const merge = details.merges.get(row.id);
        if (!merge) return [];
        const other = otherOf(merge, canonicalId);
        const brief = details.others.get(other.id);
        if (!brief) return [];
        const shared = {
          id: merge.id,
          at: row.at,
          other: brief,
          otherRole: other.role,
          actorName: names.get(merge.actor_id) ?? null,
          reasonCode: merge.reason,
          // The merged record's entries carry the merge and its undo on the audit screen.
          ...(lens.shows(row.kind, 'audit')
            ? { audit: { recordType: 'customer' as const, recordId: merge.merged_id } }
            : {}),
        };
        if (row.kind === 'unmerge') return [{ kind: 'unmerge', ...shared }];
        return [
          {
            kind: 'merge',
            ...shared,
            ...(lens.shows('merge', 'undoable') ? { undoable: merge.undoable } : {}),
          },
        ];
      }
      case 'phone_added': {
        const phone = details.phones.get(row.id);
        if (!phone) return [];
        return [
          {
            kind: 'phone_added',
            id: phone.id,
            at: row.at,
            e164: phone.phone_e164,
            phoneKind: phone.kind,
            isPrimary: phone.is_primary,
          },
        ];
      }
      case 'channel_id_added': {
        const external = details.channelIds.get(row.id);
        if (!external) return [];
        return [
          {
            kind: 'channel_id_added',
            id: external.id,
            at: row.at,
            channelIdKind: external.kind,
            externalId: external.external_id,
            ...external.label,
          },
        ];
      }
      case 'flag': {
        const flag = details.flags.get(row.id);
        if (!flag) return [];
        return [
          {
            kind: 'flag',
            id: flag.id,
            at: row.at,
            flagKind: flag.risk_flag,
            source: flag.risk_flag_source,
            setByName:
              flag.risk_flag_set_by === null ? null : (names.get(flag.risk_flag_set_by) ?? null),
            note: flag.risk_flag_note,
          },
        ];
      }
    }
  }
}

/**
 * The other record of a merge as seen from the customer being read: the survivor when the reader
 * is the record that was merged away (after an undo), else the merged record.
 */
function otherOf(
  merge: Pick<MergeDetailRow, 'survivor_id' | 'merged_id'>,
  canonicalId: string,
): { id: string; role: 'merged' | 'survivor' } {
  return merge.merged_id === canonicalId
    ? { id: merge.survivor_id, role: 'survivor' }
    : { id: merge.merged_id, role: 'merged' };
}
