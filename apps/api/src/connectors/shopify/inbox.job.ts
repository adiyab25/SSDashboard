import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ShopifyConnectionConfig,
  type ConnectionHealthReason,
  type InboundSubject,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { ChannelsService } from '../../channels/channels.service.js';
import { DATABASE } from '../../database/database.module.js';
import { pgArray, type Executor } from '../../database/sql.js';
import type { ChannelCreateActor } from '../../orders/intake/order-intake.service.js';
import { OrderIntake } from '../../orders/intake/order-intake.service.js';
import { OrderTransactions, type OrderTransaction } from '../../orders/order-transactions.js';
import {
  OrderLockTimeout,
  OrdersError,
  OrderTransactionNested,
} from '../../orders/orders.errors.js';
import { DomainEvents } from '../../platform/events/domain-events.js';
import { SettingsService } from '../../platform/settings/settings.service.js';
import {
  ConnectionSecrets,
  CredentialsUnreadable,
  type ConnectionCredentials,
} from '../connections/connection-secrets.js';
import { InboundEventFailed } from '../connectors.events.js';
import {
  SHOPIFY_APP_UNINSTALLED_TOPIC,
  SHOPIFY_ORDER_TOPICS,
} from '../hooks/shopify-hook-payload.js';
import {
  mapShopifyOrder,
  parseShopifyOrder,
  ShopifyOrderMappingError,
  type ShopifyOrder,
  type ShopifyOrderContext,
} from './order-mapper.js';
import {
  ShopifyClient,
  ShopifyRejectedError,
  ShopifyTransientError,
  type ShopifyConnectionAccess,
} from './shopify-client.js';
import { ORDER_READ, ORDER_READ_OPERATION } from './shopify-queries.js';

/** The job name order events and audit actors carry for this job (spec 0013 `system_job`). */
export const INBOX_JOB_NAME = 'connectors.shopify.inbox';

/** Transient read failures on a connection for this long set `degraded` `READS_FAILING` (AC-8). */
const READS_FAILING_AFTER = sql`interval '3 hours'`;

/** The token refusals that end a connection `failing` with their own code (as the connect job). */
const TOKEN_REFUSALS: readonly ConnectionHealthReason[] = [
  'APP_NOT_INSTALLED',
  'APP_ORGANIZATION_MISMATCH',
  'CREDENTIALS_REJECTED',
];

/** The inbox event columns the job reads. */
interface EventRow extends Record<string, unknown> {
  id: string;
  connection_id: string;
  topic: string;
  subject_type: InboundSubject;
  subject_external_id: string | null;
  status: string;
}

/** The connection columns the job reads; the ciphertext stays a buffer in memory only. */
interface ConnectionRow extends Record<string, unknown> {
  id: string;
  status: string;
  store_id: string | null;
  shop_domain: string | null;
  credentials_ciphertext: Buffer | null;
  credentials_key_version: number | null;
  config: unknown;
  go_live_at: string | null;
}

/** The order mapping row, read under its row lock inside the unit of work. */
interface MappingRow extends Record<string, unknown> {
  id: string;
  local_id: string | null;
  external_version: string | null;
}

/** How one inbox job ended: codes only, the job's output (never a read value). */
export interface InboxOutcome {
  /** Why nothing was done; the event keeps its status. */
  readonly skipped?: string;
  /** The status the event ended in. */
  readonly status?: 'processed' | 'ignored' | 'failed';
  /** Its outcome or failure code. */
  readonly code?: string | null;
}

/** The final status, outcome, and label the unit of work gives the event. */
interface EventEnd {
  readonly status: 'processed' | 'ignored';
  readonly outcome: string | null;
}

/** A Shopify order name as `subject_label` keeps it: at most 64 characters, never personal. */
function labelOf(order: ShopifyOrder): string {
  return order.name.trim().slice(0, 64);
}

/** `OrderNumberTaken` as the inbox's upper case failure code `ORDER_NUMBER_TAKEN`. */
export function upperCode(code: string): string {
  return code
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .toUpperCase()
    .slice(0, 64);
}

/** A domain error the inbox records as `failed` with a code; anything else is retried or a bug. */
function failureCodeOf(error: unknown): string | null {
  if (error instanceof ShopifyOrderMappingError) return error.code;
  if (error instanceof OrderLockTimeout || error instanceof OrderTransactionNested) return null;
  if (error instanceof OrdersError) return upperCode(error.code);
  return null;
}

/** Whether a read order lacks a ship to name, phone, or address line (the protected data check). */
function lacksProtectedData(order: ShopifyOrder): boolean {
  const address = order.shippingAddress;
  const present = (value: string | null | undefined) =>
    typeof value === 'string' && value.trim() !== '';
  return !present(address?.name) || !present(address?.phone) || !present(address?.address1);
}

/**
 * The inbox job of spec 0015 task 7 (Inbound processing item 3, AC-5 to AC-9): one verified
 * webhook's `inbound_events` row, run as the `inbox` kind of the `connector-shopify` queue, one
 * job per connection at a time.
 *
 * - It skips unless the event is still `received`. A paused (or otherwise not active) connection
 *   leaves the event `received` and completes: resume is task 16.
 * - `app/uninstalled` sets health `failing` with `APP_NOT_INSTALLED` (D9).
 * - An order topic reads the order back with `ORDER_READ` through the one `ShopifyClient`, before
 *   any unit of work. A transient error counts an attempt on the event and throws, so pg-boss
 *   retries with backoff and the event stays `received`; once an event of the connection has
 *   waited unread for 3 hours, health turns `degraded` with `READS_FAILING`, cleared by the next
 *   successful read. A token refusal ends the connection `failing` with its code.
 * - Then, inside `OrderTransactions.run` (rerunnable, no provider call), it locks the event and the
 *   order mapping again and decides: a test order is `ignored` `test_order`; a known order (a
 *   mapping exists) is `ignored` `stale` when the snapshot is not newer than `external_version`,
 *   else `ignored` `update_deferred` changing nothing and leaving `external_version` as it was
 *   (lead decision D1: task 9 applies edits, cancels, and fulfillment); a new order writes its
 *   mapping first (`appliedLineIds`, `unmappedLines`, `discountCodes`, `unmappedGateways`), then
 *   `OrderIntake.createFromChannel` (actor `system_job`, or `import` as the mapper names for a
 *   closed order before go live), the mapping's `local_id`, and `last_order_at`. An empty read
 *   back is `ignored` `not_visible`. Every other `received` event of the same order is marked
 *   `processed` `coalesced` in the same transaction.
 * - A mapping error or an orders domain error rolls the unit back, and a separate transaction marks
 *   the event `failed` with its upper case code and publishes `InboundEventFailed` in it.
 *
 * Variant mappings come from `connection_external_ids`; none exist before task 8, so lines stay
 * unmapped and are listed in the mapping's `state.unmappedLines` (the product read before mapping,
 * review M8, waits for task 8). Law 151: it never logs, throws, or stores a name, phone, address,
 * note, or line title; its log lines and output carry ids and codes only.
 */
@Injectable()
export class InboxJob {
  private readonly logger = new Logger('ShopifyInbox');

  /** Takes the database, secrets, the Shopify client, channels, settings, orders, and events. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(ConnectionSecrets) private readonly secrets: ConnectionSecrets,
    @Inject(ShopifyClient) private readonly shopify: ShopifyClient,
    @Inject(ChannelsService) private readonly channels: ChannelsService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(OrderTransactions) private readonly orderTransactions: OrderTransactions,
    @Inject(OrderIntake) private readonly intake: OrderIntake,
    @Inject(DomainEvents) private readonly events: DomainEvents,
  ) {}

  /** Runs one inbox event (see the class). `jobId` names the job in the order's actor. */
  async run(data: { connectionId: string; eventId: string }, jobId: string): Promise<InboxOutcome> {
    const event = (
      await this.connection.db.execute<EventRow>(sql`
        SELECT id, connection_id, topic, subject_type, subject_external_id, status
        FROM inbound_events
        WHERE id = ${data.eventId}::uuid AND connection_id = ${data.connectionId}::uuid`)
    ).rows[0];
    if (!event || event.status !== 'received') return { skipped: 'NOT_RECEIVED' };
    const connection = (
      await this.connection.db.execute<ConnectionRow>(sql`
        SELECT id, status, store_id, shop_domain, credentials_ciphertext,
               credentials_key_version, config,
               to_char(go_live_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS go_live_at
        FROM connections WHERE id = ${data.connectionId}::uuid AND provider = 'shopify'`)
    ).rows[0];
    if (!connection) return { skipped: 'CONNECTION_NOT_LIVE' };
    // Paused: recorded, left `received`; resume (task 16) sends the work again.
    if (connection.status === 'paused') return { skipped: 'CONNECTION_PAUSED' };
    if (connection.status !== 'active') return { skipped: 'CONNECTION_NOT_LIVE' };

    if (event.topic === SHOPIFY_APP_UNINSTALLED_TOPIC) return this.appUninstalled(event);
    const gid = event.subject_external_id;
    if (event.subject_type !== 'order' || !gid || !SHOPIFY_ORDER_TOPICS.includes(event.topic)) {
      return { skipped: 'TOPIC_NOT_PROCESSED' };
    }
    if (
      !connection.store_id ||
      !connection.shop_domain ||
      !connection.credentials_ciphertext ||
      connection.credentials_key_version === null
    ) {
      return { skipped: 'CONNECTION_INCOMPLETE' };
    }

    let credentials: ConnectionCredentials;
    try {
      credentials = this.secrets.open(
        {
          ciphertext: connection.credentials_ciphertext,
          keyVersion: connection.credentials_key_version,
        },
        connection.id,
      );
    } catch (error) {
      if (!(error instanceof CredentialsUnreadable)) throw error;
      // Left `received`: once the keys are typed again, the sweep (task 12) finds it.
      await this.setHealth(this.connection.db, connection.id, 'failing', 'CREDENTIALS_UNREADABLE');
      this.logger.warn(
        `inbox event=${event.id} connection=${connection.id} skipped=CREDENTIALS_UNREADABLE`,
      );
      return { skipped: 'CREDENTIALS_UNREADABLE' };
    }
    const access: ShopifyConnectionAccess = {
      connectionId: connection.id,
      shopDomain: connection.shop_domain,
      credentials,
    };

    // The read back, before any unit of work (AC-7): nothing inside the unit calls Shopify.
    let readData: unknown;
    try {
      const answer = await this.shopify.request(access, {
        operationName: ORDER_READ_OPERATION,
        query: ORDER_READ,
        variables: { id: gid },
      });
      readData = answer.data;
    } catch (error) {
      if (error instanceof ShopifyTransientError) {
        await this.readFailed(event);
        this.logger.warn(`inbox event=${event.id} connection=${connection.id} retry=${error.code}`);
        throw error;
      }
      if (error instanceof ShopifyRejectedError) {
        const reason = error.code as ConnectionHealthReason;
        if (TOKEN_REFUSALS.includes(reason)) {
          await this.setHealth(this.connection.db, connection.id, 'failing', reason);
        }
        return this.fail(event, error.code, null);
      }
      throw error;
    }
    await this.readSucceeded(connection.id);

    const read =
      typeof readData === 'object' && readData !== null
        ? (readData as { order?: unknown }).order
        : undefined;
    if (read === null) {
      return this.unit(event, async (tx) =>
        this.end(tx, event, null, { status: 'ignored', outcome: 'not_visible' }),
      );
    }
    let order: ShopifyOrder;
    try {
      order = parseShopifyOrder(read);
    } catch (error) {
      if (!(error instanceof ShopifyOrderMappingError)) throw error;
      return this.fail(event, error.code, null);
    }

    const config = ShopifyConnectionConfig.partial().safeParse(connection.config);
    const settings = await this.settings.read(['sales_tax_rate', 'shopify_gift_tags']);
    const storeId = connection.store_id;
    const channel = (await this.channels.listChannels({ kinds: ['shopify'] })).find(
      (candidate) => candidate.defaultStoreId === storeId,
    );
    const base: Omit<ShopifyOrderContext, 'variants'> = {
      storeId,
      // A store without its own channel cannot take orders: the contract refuses an empty id.
      channelId: channel?.id ?? '',
      connectionId: connection.id,
      altPhoneAttribute: config.success ? (config.data.altPhoneAttribute ?? null) : null,
      gatewayMethods: config.success ? (config.data.gatewayMethods ?? {}) : {},
      giftTags: settings.shopify_gift_tags,
      goLiveAt: connection.go_live_at,
      defaultTaxRate: settings.sales_tax_rate,
    };

    try {
      return await this.unit(event, (tx) => this.apply(tx, event, gid, order, base, jobId));
    } catch (error) {
      const code = failureCodeOf(error);
      if (code === null) throw error;
      return this.fail(event, code, labelOf(order));
    }
  }

  /** Runs `work` in one order unit of work, mapping a skipped event to its outcome. */
  private async unit(
    event: EventRow,
    work: (tx: OrderTransaction) => Promise<InboxOutcome>,
  ): Promise<InboxOutcome> {
    const outcome = await this.orderTransactions.run(async (tx): Promise<InboxOutcome> => {
      // Lock the event again: another job of the same event, or a coalesce, may have closed it.
      const { rows } = await tx.execute<{ status: string }>(sql`
        SELECT status FROM inbound_events WHERE id = ${event.id}::uuid FOR UPDATE`);
      if (rows[0]?.status !== 'received') return { skipped: 'NOT_RECEIVED' };
      return work(tx);
    });
    this.logger.log(
      `inbox event=${event.id} connection=${event.connection_id} status=${outcome.status ?? 'skipped'} code=${outcome.code ?? outcome.skipped ?? 'none'}`,
    );
    return outcome;
  }

  /** The body of the unit for a read order (see the class): rerunnable, no provider call. */
  private async apply(
    tx: OrderTransaction,
    event: EventRow,
    gid: string,
    order: ShopifyOrder,
    base: Omit<ShopifyOrderContext, 'variants'>,
    jobId: string,
  ): Promise<InboxOutcome> {
    const label = labelOf(order);
    if (order.test) return this.end(tx, event, label, { status: 'ignored', outcome: 'test_order' });

    const mapping = (
      await tx.execute<MappingRow>(sql`
        SELECT id, local_id,
               to_char(external_version AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS external_version
        FROM connection_external_ids
        WHERE connection_id = ${event.connection_id}::uuid AND entity = 'order'
          AND external_id = ${gid}
        FOR UPDATE`)
    ).rows[0];
    if (mapping?.local_id) {
      const applied = mapping.external_version ? Date.parse(mapping.external_version) : -Infinity;
      // D1: a newer snapshot of a known order changes nothing until task 9, and the version stays.
      const outcome = Date.parse(order.updatedAt) <= applied ? 'stale' : 'update_deferred';
      return this.end(tx, event, label, { status: 'ignored', outcome });
    }

    const variantGids = [
      ...new Set(order.lineItems.nodes.flatMap((line) => (line.variant ? [line.variant.id] : []))),
    ];
    const variants = await this.variantMappings(tx, event.connection_id, variantGids);
    const mapped = mapShopifyOrder(order, { ...base, variants });

    // The connector's own rows first, then orders (AC-7).
    const state: Record<string, unknown> = {
      appliedLineIds: mapped.input.lines.map((line) => line.channelLineId),
      discountCodes: mapped.discountCodes,
      unmappedGateways: mapped.unmappedGateways,
    };
    if (mapped.unmappedLines.length > 0) state['unmappedLines'] = mapped.unmappedLines;
    const row = await tx.execute<{ id: string }>(sql`
      INSERT INTO connection_external_ids (connection_id, entity, external_id, external_version,
                                           state)
      VALUES (${event.connection_id}::uuid, 'order', ${gid}, ${order.updatedAt}::timestamptz,
              ${JSON.stringify(state)}::jsonb)
      ON CONFLICT ON CONSTRAINT connection_external_ids_unique DO UPDATE
        SET external_version = EXCLUDED.external_version, state = EXCLUDED.state,
            updated_at = now()
      RETURNING id`);
    const mappingId = row.rows[0]?.id as string;

    const actor: ChannelCreateActor =
      mapped.actor === 'import'
        ? { type: 'import', runId: event.id }
        : { type: 'system_job', job: INBOX_JOB_NAME, jobId };
    const created = await this.intake.createFromChannel(tx, mapped.input, actor);
    await tx.execute(sql`
      UPDATE connection_external_ids SET local_id = ${created.orderId}::uuid, updated_at = now()
      WHERE id = ${mappingId}::uuid`);

    // The protected data check of a connection whose connect check saw no order (spec 0015,
    // *Shopify app*): the first order applied, before `last_order_at` is set.
    if (lacksProtectedData(order)) {
      await tx.execute(sql`
        UPDATE connections
        SET health = 'degraded', health_reason = 'PROTECTED_DATA_MISSING',
            health_changed_at = now(), updated_at = now()
        WHERE id = ${event.connection_id}::uuid AND health = 'ok' AND last_order_at IS NULL
          AND (SELECT r.counts->>'latestOrderChecked' FROM connection_sync_runs r
               WHERE r.connection_id = ${event.connection_id}::uuid AND r.kind = 'connect'
                 AND r.finished_at IS NOT NULL
               ORDER BY r.started_at DESC, r.id DESC LIMIT 1) = 'false'`);
    }
    await tx.execute(sql`
      UPDATE connections SET last_order_at = now() WHERE id = ${event.connection_id}::uuid`);
    const outcome = mapped.flags.includes('gift_tag_not_free') ? 'gift_tag_not_free' : null;
    return this.end(tx, event, label, { status: 'processed', outcome });
  }

  /** The variant mappings of the given Shopify variant gids that resolve to an app variant. */
  private async variantMappings(
    tx: Executor,
    connectionId: string,
    gids: readonly string[],
  ): Promise<Map<string, string>> {
    if (gids.length === 0) return new Map();
    const { rows } = await tx.execute<{ external_id: string; local_id: string }>(sql`
      SELECT external_id, local_id FROM connection_external_ids
      WHERE connection_id = ${connectionId}::uuid AND entity = 'variant'
        AND external_id = ANY(${pgArray([...gids])}::text[])
        AND local_id IS NOT NULL AND removed_at IS NULL`);
    return new Map(rows.map((row) => [row.external_id, row.local_id]));
  }

  /**
   * Ends the event and coalesces: the event takes its status, outcome, label, and processed time,
   * and every other `received` event of the same order is `processed` `coalesced` (AC-7).
   */
  private async end(
    tx: Executor,
    event: EventRow,
    label: string | null,
    end: EventEnd,
  ): Promise<InboxOutcome> {
    await tx.execute(sql`
      UPDATE inbound_events
      SET status = ${end.status}::inbound_status, outcome = ${end.outcome},
          subject_label = coalesce(${label}, subject_label), processed_at = now()
      WHERE id = ${event.id}::uuid`);
    if (event.subject_external_id) {
      await tx.execute(sql`
        UPDATE inbound_events
        SET status = 'processed', outcome = 'coalesced',
            subject_label = coalesce(${label}, subject_label), processed_at = now()
        WHERE connection_id = ${event.connection_id}::uuid AND subject_type = 'order'
          AND subject_external_id = ${event.subject_external_id}
          AND status = 'received' AND id <> ${event.id}::uuid`);
    }
    return { status: end.status, code: end.outcome };
  }

  /**
   * Marks the event `failed` with its code and publishes `InboundEventFailed`, in one transaction
   * of its own (the domain writes already rolled back). Only a `received` event moves.
   */
  private async fail(event: EventRow, code: string, label: string | null): Promise<InboxOutcome> {
    const moved = await this.connection.db.transaction(async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        UPDATE inbound_events
        SET status = 'failed', failure_code = ${code},
            subject_label = coalesce(${label}, subject_label), processed_at = now()
        WHERE id = ${event.id}::uuid AND status = 'received'
        RETURNING id`);
      if (!rows[0]) return false;
      await this.events.publish(
        tx,
        new InboundEventFailed(
          event.connection_id,
          event.id,
          event.subject_type,
          event.subject_external_id,
          label,
          code,
        ),
      );
      return true;
    });
    this.logger.warn(
      `inbox event=${event.id} connection=${event.connection_id} failed=${code}${moved ? '' : ' (already closed)'}`,
    );
    return moved ? { status: 'failed', code } : { skipped: 'NOT_RECEIVED' };
  }

  /** `app/uninstalled` (D9): health `failing` `APP_NOT_INSTALLED`, the event `processed`. */
  private async appUninstalled(event: EventRow): Promise<InboxOutcome> {
    const outcome = await this.connection.db.transaction(async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        UPDATE inbound_events SET status = 'processed', processed_at = now()
        WHERE id = ${event.id}::uuid AND status = 'received' RETURNING id`);
      if (!rows[0]) return { skipped: 'NOT_RECEIVED' } satisfies InboxOutcome;
      await this.setHealth(tx, event.connection_id, 'failing', 'APP_NOT_INSTALLED');
      return { status: 'processed', code: null } satisfies InboxOutcome;
    });
    this.shopify.forgetConnection(event.connection_id);
    this.logger.warn(`inbox event=${event.id} connection=${event.connection_id} app_uninstalled`);
    return outcome;
  }

  /** Sets a connection's health and reason, stamping the change time only when it moved. */
  private async setHealth(
    executor: Executor,
    connectionId: string,
    health: 'ok' | 'degraded' | 'failing',
    reason: ConnectionHealthReason | null,
  ): Promise<void> {
    await executor.execute(sql`
      UPDATE connections
      SET health_changed_at = CASE
            WHEN health IS DISTINCT FROM ${health}::connection_health
              OR health_reason IS DISTINCT FROM ${reason}::text THEN now()
            ELSE health_changed_at END,
          health = ${health}::connection_health, health_reason = ${reason}::text,
          updated_at = now()
      WHERE id = ${connectionId}::uuid`);
  }

  /**
   * A transient read failure (AC-8): one attempt more on the event, and health `degraded`
   * `READS_FAILING` once an event of the connection has waited unread for 3 hours with at least
   * one failed attempt (reads have then failed for that long), while health is `ok`.
   */
  private async readFailed(event: EventRow): Promise<void> {
    await this.connection.db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE inbound_events SET attempts = attempts + 1
        WHERE id = ${event.id}::uuid AND status = 'received'`);
      await tx.execute(sql`
        UPDATE connections
        SET health = 'degraded', health_reason = 'READS_FAILING', health_changed_at = now(),
            updated_at = now()
        WHERE id = ${event.connection_id}::uuid AND health = 'ok'
          AND EXISTS (SELECT 1 FROM inbound_events e
                      WHERE e.connection_id = ${event.connection_id}::uuid
                        AND e.status = 'received' AND e.attempts > 0
                        AND e.received_at <= now() - ${READS_FAILING_AFTER})`);
    });
  }

  /** A successful read clears `READS_FAILING` (AC-8). */
  private async readSucceeded(connectionId: string): Promise<void> {
    await this.connection.db.execute(sql`
      UPDATE connections
      SET health = 'ok', health_reason = NULL, health_changed_at = now(), updated_at = now()
      WHERE id = ${connectionId}::uuid AND health = 'degraded' AND health_reason = 'READS_FAILING'`);
  }
}
