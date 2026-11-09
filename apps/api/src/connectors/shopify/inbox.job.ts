import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ShopifyConnectionConfig,
  type ConnectionHealthReason,
  type InboundSubject,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { ChannelsService } from '../../channels/channels.service.js';
import { CustomersError } from '../../customers/customers.errors.js';
import { CustomersService } from '../../customers/customers.service.js';
import { DATABASE } from '../../database/database.module.js';
import { pgArray, type Executor, type Transaction } from '../../database/sql.js';
import type { ChannelActor, ChannelCreateActor } from '../../orders/intake/order-intake.service.js';
import { OrderIntake } from '../../orders/intake/order-intake.service.js';
import { OrderTransactions, type OrderTransaction } from '../../orders/order-transactions.js';
import {
  InvalidOrderInput,
  LineAlreadyMapped,
  OrderLockTimeout,
  OrdersError,
  OrderTransactionNested,
  PaymentMethodLocked,
  VariantUnknown,
} from '../../orders/orders.errors.js';
import { OrderTransitions } from '../../orders/transitions/order-transitions.service.js';
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
  SHOPIFY_CUSTOMER_TOPICS,
  SHOPIFY_ORDER_TOPICS,
} from '../hooks/shopify-hook-payload.js';
import { ConnectorClock } from './connector-clock.js';
import { CONNECTOR_SHOPIFY_RETRY } from './connector-shopify.queue.js';
import {
  mapShopifyCustomer,
  parseShopifyCustomer,
  ShopifyCustomerMappingError,
} from './customer-mapper.js';
import { nextKnownOrderState, planKnownOrder, type KnownOrderPlan } from './known-order-plan.js';
import {
  cancelReasonCodeOf,
  firstActiveFulfillmentOf,
  mapShopifyOrder,
  parseShopifyOrder,
  shopifyOrderName,
  ShopifyOrderMappingError,
  type ShopifyOrder,
  type ShopifyOrderContext,
} from './order-mapper.js';
import { createdOrderState, parseOrderMappingState } from './order-mapping-state.js';
import {
  ShopifyClient,
  ShopifyRejectedError,
  ShopifyTransientError,
  type ShopifyConnectionAccess,
  type ShopifyWarning,
} from './shopify-client.js';
import {
  CUSTOMER_READ,
  CUSTOMER_READ_EXPECTED_COST,
  CUSTOMER_READ_OPERATION,
  ORDER_READ,
  ORDER_READ_OPERATION,
} from './shopify-queries.js';

/** The job name order events and audit actors carry for this job (spec 0013 `system_job`). */
export const INBOX_JOB_NAME = 'connectors.shopify.inbox';

/** Transient read failures on a connection for this long set `degraded` `READS_FAILING` (AC-8). */
export const READS_FAILING_AFTER_MS = 3 * 60 * 60_000;

/** The API version warning the inbox job keeps on the connection while Shopify answers newer. */
const FELL_FORWARD: ShopifyWarning = 'API_VERSION_FELL_FORWARD';

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
  /** When this run first read the event (before the read back), exact to the microsecond. */
  read_started_at: string;
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
  state: unknown;
}

/** The topics whose `received` events of the same subject one read back coalesces (AC-7). */
const COALESCED_TOPICS: Readonly<Partial<Record<InboundSubject, readonly string[]>>> = {
  order: SHOPIFY_ORDER_TOPICS,
  customer: SHOPIFY_CUSTOMER_TOPICS,
};

/** A read back's answer, or how the event ended when the read did not answer. */
type ReadBack = { readonly data: unknown } | { readonly done: InboxOutcome };

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

/**
 * A Shopify order name as `subject_label` keeps it: cleaned of control and direction characters,
 * at most 64 characters (never splitting a pair), never personal; null when nothing is left.
 */
function labelOf(order: ShopifyOrder): string | null {
  return shopifyOrderName(order) || null;
}

/** A Shopify instant the schema checked, as the UTC ISO text bound in SQL (security review L3). */
function isoOf(instant: string): string {
  return new Date(instant).toISOString();
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
  if (error instanceof ShopifyCustomerMappingError) return error.code;
  if (error instanceof CustomersError) return upperCode(error.code);
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
 * The inbox job of spec 0015 tasks 7, 9, and 11 (Inbound processing item 3, AC-5 to AC-15): one
 * verified webhook's `inbound_events` row, run as the `inbox` kind of the `connector-shopify`
 * queue, one job per connection at a time.
 *
 * - It skips unless the event is still `received`. A paused (or otherwise not active) connection
 *   leaves the event `received` and completes: resume is task 16.
 * - `app/uninstalled` (D9) is confirmed first (security review L1: the topic header is not
 *   signed): one token exchange, or a shop read for a legacy token. Only `APP_NOT_INSTALLED`,
 *   `CREDENTIALS_REJECTED`, or `APP_ORGANIZATION_MISMATCH` confirms it: health `failing` with that
 *   code, the event `processed`. Shopify accepting ends the event `ignored`
 *   `uninstall_not_confirmed`; a transient error retries.
 * - An order topic needs a valid connection `config` (else the event fails
 *   `CONNECTION_CONFIG_INVALID`), then reads the order back with `ORDER_READ` through the one
 *   `ShopifyClient`, before any unit of work. A transient error counts an attempt on the event and
 *   throws, so pg-boss retries by `CONNECTOR_SHOPIFY_RETRY` (over 3 h 15 min) and the event stays
 *   `received`. Health turns `degraded` `READS_FAILING` once an event of the connection with a
 *   failed attempt has waited 3 hours since it was received (by `ConnectorClock`), and always when
 *   the last retry fails; the next successful read clears it. After the last retry the event is
 *   left `received` with no job: the scheduled sweep of task 12 sends it again (milestone 1 limit).
 *   A token refusal (`APP_NOT_INSTALLED`, `APP_ORGANIZATION_MISMATCH`, `CREDENTIALS_REJECTED`)
 *   sets health `failing` with its code and leaves the event `received` (the connection carries
 *   the problem; a passed connect check and the sweep recover it); any other refusal fails the
 *   event with its code. A successful read keeps `API_VERSION_FELL_FORWARD` in the connection's
 *   `health_warnings` while Shopify answers with another version, and clears it when they match.
 * - A read back whose order id is not the event's gid fails the event `READ_BACK_MISMATCH`
 *   (security review L2).
 * - Then, inside `OrderTransactions.run` (rerunnable, no provider call), it locks the event and the
 *   order mapping again and decides: a test order is `ignored` `test_order`; a known order (a
 *   mapping exists) is `ignored` `stale` when the snapshot is not newer than `external_version`,
 *   else applied by `applyKnown` (task 9: cancel, late links, the edit with its
 *   `held_write_back_open` and `edit_not_applied` outcomes, first fulfillment, the payment
 *   rederive of lead decision D10); a new order writes its mapping first (`createdOrderState`,
 *   with the creation facts of D10), then `OrderIntake.createFromChannel` (actor
 *   `system_job`, or `import` as the mapper names for a closed order before go live), the
 *   mapping's `local_id`, a live order's cancel or first fulfillment (AC-13), and
 *   `last_order_at`. An empty read back is `ignored` `not_visible`. Every other `received` event
 *   of the same order that arrived before this run's read back is marked `processed` `coalesced`
 *   in the same transaction; a later one waits for its own job (code review m1).
 * - A customer topic (task 11) reads the customer back with `CUSTOMER_READ` and calls
 *   `CustomersService.findOrCreate` (see `customer`), with the same `not_visible`, `stale`,
 *   `coalesced`, and failure rules; no phone is `processed` `no_phone`, writing nothing.
 * - A mapping error or an orders domain error rolls the unit back, and a separate transaction marks
 *   the event `failed` with its upper case code and publishes `InboundEventFailed` in it. Any other
 *   error (a crash) rolls the unit back and throws, leaving the event `received` for the retry.
 *
 * Variant mappings come from `connection_external_ids`; none exist before task 8, so lines stay
 * unmapped and are listed in the mapping's `state.unmappedLines` (the product read before mapping,
 * review M8, waits for task 8; a line whose variant maps later is linked on the next read back).
 * Law 151: it never logs, throws, or stores a name, phone, address, note, or line title; its log
 * lines and output carry ids and codes only.
 */
@Injectable()
export class InboxJob {
  private readonly logger = new Logger('ShopifyInbox');

  /**
   * Takes the database, secrets, the Shopify client, channels, settings, orders (intake and
   * transitions), customers, events, and the clock.
   */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(ConnectionSecrets) private readonly secrets: ConnectionSecrets,
    @Inject(ShopifyClient) private readonly shopify: ShopifyClient,
    @Inject(ChannelsService) private readonly channels: ChannelsService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(OrderTransactions) private readonly orderTransactions: OrderTransactions,
    @Inject(OrderIntake) private readonly intake: OrderIntake,
    @Inject(OrderTransitions) private readonly transitions: OrderTransitions,
    @Inject(CustomersService) private readonly customers: CustomersService,
    @Inject(DomainEvents) private readonly events: DomainEvents,
    @Inject(ConnectorClock) private readonly clock: ConnectorClock,
  ) {}

  /**
   * Runs one inbox event (see the class). `jobId` names the job in the order's actor;
   * `retryCount` is the pg-boss attempt (0 first), so the last retry is known.
   */
  async run(
    data: { connectionId: string; eventId: string },
    jobId: string,
    retryCount = 0,
  ): Promise<InboxOutcome> {
    const event = (
      await this.connection.db.execute<EventRow>(sql`
        SELECT id, connection_id, topic, subject_type, subject_external_id, status,
               to_char(clock_timestamp() AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS read_started_at
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

    const uninstalled = event.topic === SHOPIFY_APP_UNINSTALLED_TOPIC;
    const gid = event.subject_external_id;
    const isOrder = event.subject_type === 'order' && SHOPIFY_ORDER_TOPICS.includes(event.topic);
    const isCustomer =
      event.subject_type === 'customer' && SHOPIFY_CUSTOMER_TOPICS.includes(event.topic);
    if (!uninstalled && (!gid || !(isOrder || isCustomer))) {
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
    if (uninstalled) return this.appUninstalled(event, access, retryCount);
    if (!gid) return { skipped: 'TOPIC_NOT_PROCESSED' };
    if (isCustomer) return this.customer(event, access, gid, retryCount);

    // A config that does not parse would map orders on defaults (code review m6): refused.
    const config = ShopifyConnectionConfig.partial().safeParse(connection.config);
    if (!config.success) return this.fail(event, 'CONNECTION_CONFIG_INVALID', null);

    // The read back, before any unit of work (AC-7): nothing inside the unit calls Shopify.
    const answer = await this.readBack(event, access, retryCount, {
      operationName: ORDER_READ_OPERATION,
      query: ORDER_READ,
      variables: { id: gid },
    });
    if ('done' in answer) return answer.done;
    const readData = answer.data;

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
    // The mapping is keyed on the event's gid, the order on the read id: they must agree (L2).
    if (order.id !== gid) return this.fail(event, 'READ_BACK_MISMATCH', null);

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
      altPhoneAttribute: config.data.altPhoneAttribute ?? null,
      gatewayMethods: config.data.gatewayMethods ?? {},
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

  /**
   * One read back through the `ShopifyClient`, before any unit of work (AC-7, AC-8): its `data`,
   * or how the event ended. A transient error counts an attempt and throws (pg-boss retries); a
   * token refusal sets health `failing` and leaves the event `received` (code review m2); any
   * other refusal fails the event with its code. A success clears `READS_FAILING` and keeps the
   * version warning true.
   */
  private async readBack(
    event: EventRow,
    access: ShopifyConnectionAccess,
    retryCount: number,
    operation: {
      operationName: string;
      query: string;
      variables: Record<string, unknown>;
      expectedCost?: number;
    },
  ): Promise<ReadBack> {
    try {
      const answer = await this.shopify.request(access, operation);
      await this.readSucceeded(access.connectionId, answer.warnings);
      return { data: answer.data };
    } catch (error) {
      if (error instanceof ShopifyTransientError) {
        await this.readFailed(event, retryCount);
        throw error;
      }
      if (error instanceof ShopifyRejectedError) {
        const reason = error.code as ConnectionHealthReason;
        if (TOKEN_REFUSALS.includes(reason)) {
          await this.setHealth(this.connection.db, access.connectionId, 'failing', reason);
          this.logger.warn(
            `inbox event=${event.id} connection=${access.connectionId} skipped=${reason}`,
          );
          return { done: { skipped: reason } };
        }
        return { done: await this.fail(event, error.code, null) };
      }
      throw error;
    }
  }

  /**
   * A `customers/create` or `customers/update` event (task 11, AC-15): reads the customer back
   * with `CUSTOMER_READ`, parses its phone with `EgyptianPhone.parse` at this edge, and calls
   * `CustomersService.findOrCreate(tx, { phone, channelCustomer, name, seenAt })` in one
   * transaction with the event's end. No customer touches an order, so the unit is a plain
   * transaction, not `OrderTransactions.run`. An empty read back is `ignored` `not_visible`; a
   * read back of another customer fails `READ_BACK_MISMATCH`; a read not newer than one an
   * earlier processed event of the customer already applied is `ignored` `stale` (judged by that
   * event's webhook `updated_at`, never later than what its read saw, so only a truly older read
   * is called stale); no phone (absent or not parsing) is `processed` `no_phone` and writes
   * nothing; every other `received` customer event received before this read is `coalesced`.
   * The name and phone pass through memory only (Law 151).
   */
  private async customer(
    event: EventRow,
    access: ShopifyConnectionAccess,
    gid: string,
    retryCount: number,
  ): Promise<InboxOutcome> {
    const answer = await this.readBack(event, access, retryCount, {
      operationName: CUSTOMER_READ_OPERATION,
      query: CUSTOMER_READ,
      variables: { id: gid },
      expectedCost: CUSTOMER_READ_EXPECTED_COST,
    });
    if ('done' in answer) return answer.done;
    const read =
      typeof answer.data === 'object' && answer.data !== null
        ? (answer.data as { customer?: unknown }).customer
        : undefined;
    try {
      if (read === null) {
        return await this.customerUnit(event, (tx) =>
          this.end(tx, event, null, { status: 'ignored', outcome: 'not_visible' }),
        );
      }
      const customer = parseShopifyCustomer(read);
      if (customer.id !== gid) return await this.fail(event, 'READ_BACK_MISMATCH', null);
      const input = mapShopifyCustomer(customer, event.connection_id);
      return await this.customerUnit(event, async (tx) => {
        const { rows } = await tx.execute<{ id: string }>(sql`
          SELECT id FROM inbound_events
          WHERE connection_id = ${event.connection_id}::uuid AND subject_type = 'customer'
            AND subject_external_id = ${gid} AND status = 'processed' AND id <> ${event.id}::uuid
            AND (outcome IS NULL OR outcome = 'no_phone')
            AND subject_version >= ${input.seenAt.toISOString()}::timestamptz
          LIMIT 1`);
        if (rows[0]) return this.end(tx, event, null, { status: 'ignored', outcome: 'stale' });
        if (input.phone === null) {
          return this.end(tx, event, null, { status: 'processed', outcome: 'no_phone' });
        }
        await this.customers.findOrCreate(tx, {
          phone: input.phone,
          channelCustomer: input.channelCustomer,
          name: input.name,
          seenAt: input.seenAt,
        });
        return this.end(tx, event, null, { status: 'processed', outcome: null });
      });
    } catch (error) {
      const code = failureCodeOf(error);
      if (code === null) throw error;
      return this.fail(event, code, null);
    }
  }

  /** Runs `work` in one plain transaction after locking the event again (as `unit`). */
  private async customerUnit(
    event: EventRow,
    work: (tx: Transaction) => Promise<InboxOutcome>,
  ): Promise<InboxOutcome> {
    const outcome = await this.connection.db.transaction(async (tx): Promise<InboxOutcome> => {
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
        SELECT id, local_id, state,
               to_char(external_version AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS external_version
        FROM connection_external_ids
        WHERE connection_id = ${event.connection_id}::uuid AND entity = 'order'
          AND external_id = ${gid}
        FOR UPDATE`)
    ).rows[0];
    if (mapping?.local_id) {
      const applied = mapping.external_version ? Date.parse(mapping.external_version) : -Infinity;
      if (Date.parse(order.updatedAt) <= applied) {
        return this.end(tx, event, label, { status: 'ignored', outcome: 'stale' });
      }
      return this.applyKnown(tx, event, label, mapping, mapping.local_id, order, base, jobId);
    }

    const variantGids = [
      ...new Set(order.lineItems.nodes.flatMap((line) => (line.variant ? [line.variant.id] : []))),
    ];
    const variants = await this.variantMappings(tx, event.connection_id, variantGids);
    const mapped = mapShopifyOrder(order, { ...base, variants });
    // A live order Shopify already cancelled or fulfilled takes its named move right after its
    // creation (AC-13); an imported order's first states already hold it (AC-17).
    const live = mapped.actor === 'system_job' && !mapped.input.firstStates;
    const cancelReasonCode = live && order.cancelledAt !== null ? cancelReasonCodeOf(order) : null;
    const first = live && cancelReasonCode === null ? firstActiveFulfillmentOf(order) : null;

    // The connector's own rows first, then orders (AC-7).
    // Every order created not cancelled remembers the fulfillment its creation read already holds
    // (imported shipped ones too), so a later read holds the applied lines (code re-review R1).
    const delivered = order.cancelledAt === null ? firstActiveFulfillmentOf(order) : null;
    const state = createdOrderState(order, base, mapped.input.lines, mapped, delivered?.id ?? null);
    const row = await tx.execute<{ id: string }>(sql`
      INSERT INTO connection_external_ids (connection_id, entity, external_id, external_version,
                                           state)
      VALUES (${event.connection_id}::uuid, 'order', ${gid}, ${isoOf(order.updatedAt)}::timestamptz,
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
    let outcome: string | null = mapped.flags.includes('gift_tag_not_free')
      ? 'gift_tag_not_free'
      : null;
    if (created.created) {
      const moveActor: ChannelActor = { type: 'system_job', job: INBOX_JOB_NAME, jobId };
      if (cancelReasonCode !== null) {
        const cancel = await this.intake.cancelFromChannel(
          tx,
          created.orderId,
          cancelReasonCode,
          moveActor,
        );
        if (!cancel.applied) outcome = 'cancel_not_applied';
      } else if (first !== null) {
        await this.recordDelivery(tx, created.orderId, first.id, first.createdAt, moveActor);
      }
    }

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
    return this.end(tx, event, label, { status: 'processed', outcome });
  }

  /**
   * A newer read back of a known order (task 9; AC-9, AC-11, AC-13, AC-14, lead decision D10),
   * inside the unit, in this order (the plan is `planKnownOrder`, pure):
   *
   * 1. A Shopify cancel: `cancelFromChannel` with `channel.<reason>`, and nothing else; an answer
   *    that applied nothing (`already_final`, `after_pickup`) is outcome `cancel_not_applied`.
   * 2. Late variant links of `state.unmappedLines` whose variant now maps
   *    (`linkChannelLineVariant`), before the edit, so the link is never seen as a change; a link
   *    that orders refuses as `VariantUnknown` is planned again with that variant unmapped. Task 8
   *    builds the product read that makes new variant mappings; until then none exist.
   * 3. `applyChannelEdit` with the snapshot: every open Shopify line while no fulfillment is active
   *    and on the read where the first one appears (code review m1: the edit came before the
   *    fulfillment froze it; the small window is that a line changed after the fulfillment but
   *    before this first read of it also counts as an edit); afterwards the held lines.
   *    `write_back_open` records the carrier delivery (step 4) and ends the event `ignored`
   *    `held_write_back_open` without coalescing (security review L2): the mapping and its version
   *    stay, so the read back that milestone 3 enqueues when the command syncs or is resolved
   *    applies it (task 13 seam, AC-14). Any other refusal is outcome `edit_not_applied`.
   * 4. The first active fulfillment: `recordCarrierDelivery` with source `shopify_fulfillment` at
   *    its `createdAt` (orders ignores a repeat, and takes the next one after it cleared the
   *    freeze); the mapping remembers it as `deliveryFulfillmentId`.
   * 5. `rederivePaymentMethod` when the config maps a creation gateway differently (D10);
   *    `PaymentMethodLocked` is recorded on the mapping and left (outcome
   *    `payment_method_locked`).
   * 6. The mapping's `external_version` and `state` move to this read.
   *
   * Seams not built here: task 10's `exchange-by-edit.ts` takes the lines added while a
   * fulfillment is active and the refunds (`ChannelRefundRecorded`); task 9a's fulfillment stock
   * out calls `recordChannelStockOut`, `recordChannelFulfillmentCancelled`, and
   * `recordChannelReturn` after step 4.
   */
  private async applyKnown(
    tx: OrderTransaction,
    event: EventRow,
    label: string | null,
    mapping: MappingRow,
    orderId: string,
    order: ShopifyOrder,
    base: Omit<ShopifyOrderContext, 'variants'>,
    jobId: string,
  ): Promise<InboxOutcome> {
    const actor: ChannelActor = { type: 'system_job', job: INBOX_JOB_NAME, jobId };
    const state = parseOrderMappingState(mapping.state);
    const variantGids = [
      ...new Set([
        ...order.lineItems.nodes.flatMap((line) => (line.variant ? [line.variant.id] : [])),
        ...(state.unmappedLines ?? []).flatMap((line) =>
          line.variantGid ? [line.variantGid] : [],
        ),
      ]),
    ];
    const variants = await this.variantMappings(tx, event.connection_id, variantGids);
    let plan: KnownOrderPlan = planKnownOrder(order, { ...base, variants }, state);

    if (plan.cancelReasonCode !== null) {
      const cancel = await this.intake.cancelFromChannel(tx, orderId, plan.cancelReasonCode, actor);
      await this.saveMapping(tx, mapping.id, order.updatedAt, state);
      return this.end(tx, event, label, {
        status: 'processed',
        outcome: cancel.applied ? null : 'cancel_not_applied',
      });
    }

    const linked = new Set<string>();
    const refused = new Set<string>();
    for (const link of plan.links) {
      try {
        await this.intake.linkChannelLineVariant(tx, orderId, link.channelLineId, link.variantId);
        linked.add(link.channelLineId);
      } catch (error) {
        // Already mapped, or no line carries the id any more: nothing left to link.
        if (error instanceof LineAlreadyMapped || error instanceof InvalidOrderInput) {
          linked.add(link.channelLineId);
        } else if (error instanceof VariantUnknown) {
          refused.add(link.variantGid);
        } else {
          throw error;
        }
      }
    }
    if (refused.size > 0) {
      const kept = new Map([...variants].filter(([gid]) => !refused.has(gid)));
      plan = planKnownOrder(order, { ...base, variants: kept }, state);
    }

    let editApplied = false;
    let outcome: string | null = null;
    if (plan.snapshot !== null) {
      const result = await this.intake.applyChannelEdit(tx, orderId, plan.snapshot, actor);
      if (!result.applied && result.why === 'write_back_open') {
        // AC-13 still holds: the delivery fact is recorded (orders raises its own attention for
        // the open command). AC-14: nothing else changes and the version stays.
        // TODO(spec 0015 task 13): when the open command syncs or is resolved, the outbound
        // framework enqueues one read back of the order.
        if (plan.carrierDelivery !== null) {
          const { id, at } = plan.carrierDelivery;
          await this.recordDelivery(tx, orderId, id, at, actor);
        }
        return this.end(
          tx,
          event,
          label,
          { status: 'ignored', outcome: 'held_write_back_open' },
          false,
        );
      }
      editApplied = result.applied;
      if (!result.applied) outcome = 'edit_not_applied';
    }

    if (plan.carrierDelivery !== null) {
      const { id, at } = plan.carrierDelivery;
      await this.recordDelivery(tx, orderId, id, at, actor);
    }

    let paymentLocked = false;
    if (plan.rederive !== null) {
      try {
        await this.intake.rederivePaymentMethod(tx, orderId, plan.rederive, actor);
      } catch (error) {
        if (!(error instanceof PaymentMethodLocked)) throw error;
        paymentLocked = true;
        outcome ??= 'payment_method_locked';
      }
    }

    const next = nextKnownOrderState(state, plan, { editApplied, linked, paymentLocked });
    await this.saveMapping(tx, mapping.id, order.updatedAt, next);
    return this.end(tx, event, label, { status: 'processed', outcome });
  }

  /**
   * Reports a Shopify fulfillment as the carrier delivery (AC-13): `recordCarrierDelivery` with
   * source `shopify_fulfillment` (the fulfillment gid) at its `createdAt`, an ISO instant the
   * schema already checked.
   */
  private async recordDelivery(
    tx: OrderTransaction,
    orderId: string,
    fulfillmentId: string,
    createdAt: string,
    actor: ChannelActor,
  ): Promise<void> {
    await this.transitions.recordCarrierDelivery(
      tx,
      orderId,
      { at: new Date(createdAt), source: { type: 'shopify_fulfillment', id: fulfillmentId } },
      actor,
    );
  }

  /** Moves an order mapping's version and state to an applied read back. */
  private async saveMapping(
    tx: Executor,
    mappingId: string,
    version: string,
    state: Record<string, unknown>,
  ): Promise<void> {
    await tx.execute(sql`
      UPDATE connection_external_ids
      SET external_version = ${isoOf(version)}::timestamptz,
          state = ${JSON.stringify(state)}::jsonb,
          updated_at = now()
      WHERE id = ${mappingId}::uuid`);
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
   * and every other `received` event of the same subject and processed topics received before
   * this run's read back started is `processed` `coalesced` (AC-7). A later event (a change after
   * the read) and other topics (refunds, which wait for their own task) are left alone. A held
   * edit passes `coalesce` false (security review L2): the other events keep their own jobs.
   */
  private async end(
    tx: Executor,
    event: EventRow,
    label: string | null,
    end: EventEnd,
    coalesce = true,
  ): Promise<InboxOutcome> {
    await tx.execute(sql`
      UPDATE inbound_events
      SET status = ${end.status}::inbound_status, outcome = ${end.outcome},
          subject_label = coalesce(${label}, subject_label), processed_at = now()
      WHERE id = ${event.id}::uuid`);
    const topics = COALESCED_TOPICS[event.subject_type];
    if (coalesce && event.subject_external_id && topics) {
      await tx.execute(sql`
        UPDATE inbound_events
        SET status = 'processed', outcome = 'coalesced',
            subject_label = coalesce(${label}, subject_label), processed_at = now()
        WHERE connection_id = ${event.connection_id}::uuid
          AND subject_type = ${event.subject_type}::inbound_subject
          AND subject_external_id = ${event.subject_external_id}
          AND topic = ANY(${pgArray([...topics])}::text[])
          AND received_at <= ${event.read_started_at}::timestamptz
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

  /**
   * `app/uninstalled` (D9), confirmed before health moves (security review L1, see the class):
   * one access check; a token refusal confirms (health `failing` with its code, the event
   * `processed`), Shopify accepting ends the event `ignored` `uninstall_not_confirmed`, any other
   * refusal too, and a transient error counts an attempt and throws for the retry.
   */
  private async appUninstalled(
    event: EventRow,
    access: ShopifyConnectionAccess,
    retryCount: number,
  ): Promise<InboxOutcome> {
    let confirmed: ConnectionHealthReason | null = null;
    try {
      await this.shopify.confirmAccess(access);
    } catch (error) {
      if (error instanceof ShopifyTransientError) {
        await this.readFailed(event, retryCount);
        throw error;
      }
      if (!(error instanceof ShopifyRejectedError)) throw error;
      const reason = error.code as ConnectionHealthReason;
      if (TOKEN_REFUSALS.includes(reason)) confirmed = reason;
    }
    const outcome = await this.connection.db.transaction(async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        UPDATE inbound_events
        SET status = ${confirmed ? 'processed' : 'ignored'}::inbound_status,
            outcome = ${confirmed ? null : 'uninstall_not_confirmed'}, processed_at = now()
        WHERE id = ${event.id}::uuid AND status = 'received' RETURNING id`);
      if (!rows[0]) return { skipped: 'NOT_RECEIVED' } satisfies InboxOutcome;
      if (!confirmed) {
        return { status: 'ignored', code: 'uninstall_not_confirmed' } satisfies InboxOutcome;
      }
      await this.setHealth(tx, event.connection_id, 'failing', confirmed);
      return { status: 'processed', code: null } satisfies InboxOutcome;
    });
    if (confirmed) this.shopify.forgetConnection(event.connection_id);
    this.logger.warn(
      `inbox event=${event.id} connection=${event.connection_id} app_uninstalled=${confirmed ?? 'not_confirmed'}`,
    );
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
   * A transient read failure (AC-8, code review M1): one attempt more on the event, and health
   * `degraded` `READS_FAILING` while health is `ok`, when an event of the connection with a failed
   * attempt was received 3 hours or more ago by `ConnectorClock` (reads have then failed for that
   * long), or when this was the last pg-boss retry (`CONNECTOR_SHOPIFY_RETRY.retryLimit`): the
   * event then stays `received` with no job until the sweep of task 12 sends it again.
   */
  private async readFailed(event: EventRow, retryCount: number): Promise<void> {
    const lastRetry = retryCount >= CONNECTOR_SHOPIFY_RETRY.retryLimit;
    const cutoff = new Date(this.clock.now().getTime() - READS_FAILING_AFTER_MS).toISOString();
    await this.connection.db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE inbound_events SET attempts = attempts + 1
        WHERE id = ${event.id}::uuid AND status = 'received'`);
      await tx.execute(sql`
        UPDATE connections
        SET health = 'degraded', health_reason = 'READS_FAILING', health_changed_at = now(),
            updated_at = now()
        WHERE id = ${event.connection_id}::uuid AND health = 'ok'
          AND (${lastRetry}::boolean
               OR EXISTS (SELECT 1 FROM inbound_events e
                          WHERE e.connection_id = ${event.connection_id}::uuid
                            AND e.status = 'received' AND e.attempts > 0
                            AND e.received_at <= ${cutoff}::timestamptz))`);
    });
    this.logger.warn(
      `inbox event=${event.id} connection=${event.connection_id} read_failed retry=${retryCount}${lastRetry ? ' last_retry=left_received' : ''}`,
    );
  }

  /**
   * A successful read: clears `READS_FAILING` (AC-8), and keeps `API_VERSION_FELL_FORWARD` in the
   * connection's `health_warnings` exactly while the answer carried it (AC-25, code review m3).
   * Writes only when something changes.
   */
  private async readSucceeded(
    connectionId: string,
    warnings: readonly ShopifyWarning[],
  ): Promise<void> {
    const fellForward = warnings.includes(FELL_FORWARD);
    await this.connection.db.execute(sql`
      UPDATE connections
      SET health = 'ok', health_reason = NULL, health_changed_at = now(), updated_at = now()
      WHERE id = ${connectionId}::uuid AND health = 'degraded' AND health_reason = 'READS_FAILING'`);
    await this.connection.db.execute(sql`
      UPDATE connections
      SET health_warnings = CASE WHEN ${fellForward}::boolean
                              THEN array_append(health_warnings, ${FELL_FORWARD}::text)
                              ELSE array_remove(health_warnings, ${FELL_FORWARD}::text) END,
          updated_at = now()
      WHERE id = ${connectionId}::uuid
        AND (${FELL_FORWARD}::text = ANY(health_warnings)) IS DISTINCT FROM ${fellForward}::boolean`);
  }
}
