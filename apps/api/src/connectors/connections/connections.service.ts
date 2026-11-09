import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  type ConnectionCheckView,
  ConnectionDetail,
  ConnectionHealthReason,
  ConnectionListItem,
  ConnectionWarning,
  personActor,
  ShopifyConnectionConfig,
  type ConnectionListQuery,
  type ConnectionListResponse,
  type ConnectShopifyBody,
  type ConnectShopifyResponse,
  type BackfillBody,
  type SyncRunListQuery,
  type SyncRunListResponse,
  type SyncRunStarted,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection, type SQL } from '@ssdashboard/db';
import { AuditService } from '../../audit/audit.service.js';
import { ChannelsError } from '../../channels/channels.errors.js';
import { ChannelsService } from '../../channels/channels.service.js';
import { DATABASE } from '../../database/database.module.js';
import { pgConstraint, pgErrorCode, type Transaction } from '../../database/sql.js';
import type { Access } from '../../platform/access/access.js';
import { JobSender } from '../../platform/jobs/job-sender.js';
import {
  decodeTimeIdKeyset,
  encodeKeyset,
  InvalidCursorError,
} from '../../platform/keyset-cursor.js';
import { ConnectionsError } from '../connectors.errors.js';
import {
  BACKFILL_JOB_PRIORITY,
  connectionGroup,
  CONNECTOR_SHOPIFY_QUEUE,
  type ShopifyJobData,
} from '../shopify/connector-shopify.queue.js';
import { gatewayKeyOf } from '../shopify/order-mapper.js';
import { SyncRuns } from '../sync-runs/sync-runs.js';
import { ConnectionSecrets, credentialsHint } from './connection-secrets.js';

/** Who asks: the signed in manager and their `Access`, for the audit actor. */
export interface ConnectionCaller {
  /** The person's user id. */
  readonly userId: string;
  /** Their hats and permissions. */
  readonly access: Access;
}

/** The connection columns a view reads: never `credentials_ciphertext` itself. */
interface ConnectionRow extends Record<string, unknown> {
  id: string;
  label: string;
  provider: ConnectionListItem['provider'];
  store_id: string | null;
  status: ConnectionListItem['status'];
  shop_domain: string | null;
  credentials_set: boolean;
  credentials_hint: string | null;
  config: unknown;
  health: ConnectionListItem['health'];
  health_reason: string | null;
  health_warnings: string[];
  health_changed_at: string | null;
  api_version: string | null;
  last_inbound_at: string | null;
  last_order_at: string | null;
  last_sweep_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CheckRow extends Record<string, unknown> {
  id: string;
  status: ConnectionCheckView['status'];
  started_at: string;
  finished_at: string | null;
  error_code: string | null;
  counts: unknown;
}

/** A timestamp column as the api issues it: UTC with microseconds. */
const utc = (column: SQL) =>
  sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const CONNECTION_COLUMNS = sql`
  id, label, provider, store_id, status, shop_domain,
  credentials_ciphertext IS NOT NULL AS credentials_set, credentials_hint, config,
  health, health_reason, health_warnings,
  ${utc(sql`health_changed_at`)} AS health_changed_at, api_version,
  ${utc(sql`last_inbound_at`)} AS last_inbound_at,
  ${utc(sql`last_order_at`)} AS last_order_at,
  ${utc(sql`last_sweep_at`)} AS last_sweep_at,
  ${utc(sql`created_at`)} AS created_at, ${utc(sql`updated_at`)} AS updated_at`;

/** A stored code a newer release may have written: kept only when this release knows it. */
function knownReason(code: string | null): ConnectionHealthReason | null {
  const parsed = ConnectionHealthReason.safeParse(code);
  return parsed.success ? parsed.data : null;
}

function knownWarnings(codes: readonly string[]): ConnectionWarning[] {
  return codes.flatMap((code) => {
    const parsed = ConnectionWarning.safeParse(code);
    return parsed.success ? [parsed.data] : [];
  });
}

function freshnessOf(row: ConnectionRow): ConnectionListItem['freshness'] {
  return {
    lastInboundAt: row.last_inbound_at,
    lastOrderAt: row.last_order_at,
    lastSweepAt: row.last_sweep_at,
  };
}

/** A whole number count from a sync run's `counts`, 0 when absent. */
function countOf(counts: Record<string, unknown>, key: string): number {
  const value = counts[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * The api side of connecting accounts (spec 0015 task 6, AC-1, AC-2): connect a Shopify store,
 * list connections, read one, and ask for a new connect check. The only writer of `connections`
 * in the api; it never calls Shopify (the worker's `connect` job does) and never returns, logs,
 * or audits a credential: the client id and secret are sealed by `ConnectionSecrets` in the
 * connect transaction and the answer carries only "set" and the last 4 characters of the client id.
 */
@Injectable()
export class ConnectionsService {
  /** Takes the database, the channels service, the secrets, the audit trail, and the job sender. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(ChannelsService) private readonly channels: ChannelsService,
    @Inject(ConnectionSecrets) private readonly secrets: ConnectionSecrets,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(JobSender) private readonly jobs: JobSender,
    @Inject(SyncRuns) private readonly runs: SyncRuns,
  ) {}

  /**
   * Connects a Shopify store (AC-1) in one transaction: the store and its channel
   * (`ChannelsService.createShopifyStore`), the connection (status `active`, health `connecting`,
   * the credentials sealed under its new id, the client id's last 4 characters, `config.appOwner`),
   * the audit entry `connection.created`, and the `connect` job, sent through the same
   * transaction. Throws `ConnectionsError` `STORE_CODE_TAKEN` or `SHOP_ALREADY_CONNECTED` (nothing
   * is kept then), or `ChannelsError` for a store input the contract let through.
   */
  async connect(
    body: ConnectShopifyBody,
    caller: ConnectionCaller,
  ): Promise<ConnectShopifyResponse> {
    await this.jobs.prepare(CONNECTOR_SHOPIFY_QUEUE);
    const id = randomUUID();
    const credentials = {
      kind: 'client_credentials' as const,
      clientId: body.clientId,
      clientSecret: body.clientSecret,
    };
    const sealed = this.secrets.seal(credentials, id);
    const config = ShopifyConnectionConfig.parse({ appOwner: body.appOwner });
    const correlationId = this.audit.newCorrelationId();
    try {
      await this.connection.db.transaction(async (tx) => {
        const { storeId } = await this.channels.createShopifyStore(tx, {
          code: body.storeCode,
          name: { en: body.label },
        });
        await tx.execute(sql`
          INSERT INTO connections (id, provider, label, store_id, status, shop_domain,
                                   credentials_ciphertext, credentials_key_version,
                                   credentials_hint, credentials_updated_at, config, health)
          VALUES (${id}::uuid, 'shopify', ${body.label}, ${storeId}::uuid, 'active',
                  ${body.shopDomain}, ${sealed.ciphertext}, ${sealed.keyVersion},
                  ${credentialsHint(credentials)}, now(), ${JSON.stringify(config)}::jsonb,
                  'connecting')`);
        await this.audit.record(tx, {
          actor: personActor(caller.userId, caller.access.actingHat('settings.manage')),
          action: 'connection.created',
          record: { type: 'connection', id, label: body.storeCode },
          after: {
            provider: 'shopify',
            label: body.label,
            storeCode: body.storeCode,
            shopDomain: body.shopDomain,
            appOwner: body.appOwner,
            health: 'connecting',
          },
          correlationId,
        });
        const data: ShopifyJobData = { kind: 'connect', connectionId: id };
        await this.jobs.sendIn(tx, CONNECTOR_SHOPIFY_QUEUE, data, connectionGroup(id));
      });
    } catch (error) {
      throw connectError(error);
    }
    return { id, health: 'connecting' };
  }

  /** One page of connections, newest first, keyed on (created at, id). Never credentials. */
  async list(query: ConnectionListQuery): Promise<ConnectionListResponse> {
    let after: { at: string; id: string } | undefined;
    try {
      after = query.cursor === undefined ? undefined : decodeTimeIdKeyset(query.cursor);
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        throw new ConnectionsError('INVALID_CURSOR', 'The cursor is not one this endpoint issued');
      }
      throw error;
    }
    const where = after
      ? sql`WHERE (created_at, id) < (${after.at}::timestamptz, ${after.id}::uuid)`
      : sql``;
    const { rows } = await this.connection.db.execute<ConnectionRow>(sql`
      SELECT ${CONNECTION_COLUMNS} FROM connections ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ${query.limit + 1}`);
    const page = rows.slice(0, query.limit);
    const storeIds = [...new Set(page.flatMap((row) => (row.store_id ? [row.store_id] : [])))];
    const codes = new Map(
      (await this.channels.stores(storeIds)).map((store) => [store.id, store.code]),
    );
    const last = page.at(-1);
    return {
      items: page.map((row) =>
        ConnectionListItem.parse({
          id: row.id,
          label: row.label,
          provider: row.provider,
          storeCode: row.store_id ? (codes.get(row.store_id) ?? null) : null,
          status: row.status,
          health: row.health,
          healthReason: knownReason(row.health_reason),
          healthWarnings: knownWarnings(row.health_warnings),
          freshness: freshnessOf(row),
        }),
      ),
      nextCursor:
        rows.length > query.limit && last ? encodeKeyset([last.created_at, last.id]) : null,
    };
  }

  /** One connection with its store and last connect check; throws `NOT_FOUND`. Never credentials. */
  async detail(id: string): Promise<ConnectionDetail> {
    const { rows } = await this.connection.db.execute<ConnectionRow>(sql`
      SELECT ${CONNECTION_COLUMNS} FROM connections WHERE id = ${id}::uuid`);
    const row = rows[0];
    if (!row) throw new ConnectionsError('NOT_FOUND', 'No connection has that id');
    const store = row.store_id ? (await this.channels.stores([row.store_id]))[0] : undefined;
    const config = ShopifyConnectionConfig.partial().safeParse(row.config);
    const checks = await this.connection.db.execute<CheckRow>(sql`
      SELECT id, status, ${utc(sql`started_at`)} AS started_at,
             ${utc(sql`finished_at`)} AS finished_at, error_code, counts
      FROM connection_sync_runs
      WHERE connection_id = ${id}::uuid AND kind = 'connect'
      ORDER BY started_at DESC, id DESC
      LIMIT 1`);
    const check = checks.rows[0];
    const counts =
      check && typeof check.counts === 'object' && check.counts !== null
        ? (check.counts as Record<string, unknown>)
        : {};
    const missing = counts['missingScopes'];
    return ConnectionDetail.parse({
      id: row.id,
      label: row.label,
      provider: row.provider,
      status: row.status,
      store: store
        ? { id: store.id, code: store.code, name: store.name, publicName: store.publicName }
        : null,
      shopDomain: row.shop_domain,
      health: row.health,
      healthReason: knownReason(row.health_reason),
      healthWarnings: knownWarnings(row.health_warnings),
      healthChangedAt: row.health_changed_at,
      apiVersion: row.api_version,
      appOwner: config.success ? (config.data.appOwner ?? null) : null,
      shopTimezone: config.success ? (config.data.shopTimezone ?? null) : null,
      credentials: { set: row.credentials_set, clientIdLast4: row.credentials_hint },
      freshness: freshnessOf(row),
      lastCheck: check
        ? {
            runId: check.id,
            status: check.status,
            startedAt: check.started_at,
            finishedAt: check.finished_at,
            errorCode: check.error_code,
            missingScopes: Array.isArray(missing)
              ? missing.filter((handle): handle is string => typeof handle === 'string')
              : [],
            webhookTopicsSubscribed: countOf(counts, 'webhookTopicsSubscribed'),
            locations: countOf(counts, 'locations'),
            onlineLocations: countOf(counts, 'onlineLocations'),
          }
        : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  /**
   * Asks for a new connect check (`POST /api/connections/:id/check`): one `connect` job for the
   * connection, in its group. Health stays as it is until the job decides (`failing` turns `ok`
   * only through a passed check). Throws `NOT_FOUND`, or `CONNECTION_ARCHIVED` for an archived one.
   */
  async check(id: string): Promise<void> {
    await this.jobs.prepare(CONNECTOR_SHOPIFY_QUEUE);
    await this.connection.db.transaction(async (tx) => {
      const { rows } = await tx.execute<{ status: string }>(sql`
        SELECT status FROM connections WHERE id = ${id}::uuid FOR SHARE`);
      const row = rows[0];
      if (!row) throw new ConnectionsError('NOT_FOUND', 'No connection has that id');
      if (row.status === 'archived') {
        throw new ConnectionsError('CONNECTION_ARCHIVED', 'An archived connection is not checked');
      }
      const data: ShopifyJobData = { kind: 'connect', connectionId: id };
      await this.jobs.sendIn(tx, CONNECTOR_SHOPIFY_QUEUE, data, connectionGroup(id));
    });
  }

  /**
   * Starts a gateway scan (`POST /api/connections/:id/gateway-scan`, spec 0015 task 12, AC-17):
   * under the connection's row lock, refuses while a gateway scan of the connection has not
   * finished (`SCAN_RUNNING`), then writes a `gateway_scan` run and sends its first job, in one
   * transaction. Answers the run id. Throws `NOT_FOUND`, `CONNECTION_ARCHIVED`, or `SCAN_RUNNING`.
   */
  async startGatewayScan(id: string): Promise<SyncRunStarted> {
    await this.jobs.prepare(CONNECTOR_SHOPIFY_QUEUE);
    return this.connection.db.transaction(async (tx) => {
      const row = await this.lockConnection(tx, id);
      if (row.status === 'archived') {
        throw new ConnectionsError('CONNECTION_ARCHIVED', 'An archived connection is not scanned');
      }
      if (await this.runs.unfinished(tx, id, ['gateway_scan'])) {
        throw new ConnectionsError('SCAN_RUNNING', 'A gateway scan of this connection is running');
      }
      const runId = await this.runs.start(tx, { connectionId: id, kind: 'gateway_scan' });
      const data: ShopifyJobData = { kind: 'gateway_scan', connectionId: id, runId, step: 0 };
      await this.jobs.sendIn(tx, CONNECTOR_SHOPIFY_QUEUE, data, {
        ...connectionGroup(id),
        priority: BACKFILL_JOB_PRIORITY,
      });
      return { runId };
    });
  }

  /**
   * Starts the first backfill (`POST /api/connections/:id/backfill`, spec 0015 task 12, AC-17):
   * under the connection's row lock, refuses a connection that is not `active` or whose health is
   * not `ok` or `degraded` (`CONNECTION_NOT_READY`), one with an unfinished backfill run
   * (`BACKFILL_RUNNING`), and one whose newest succeeded gateway scan names a gateway with no
   * payment method in `config.gatewayMethods`, or that has no succeeded scan yet
   * (`GATEWAYS_UNMAPPED`, with the unmapped names). Then, in one transaction, it sets `go_live_at`,
   * writes the `backfill_products` run, records `connection.backfill_started` (the go live instant
   * and the run id, never a credential), and sends the run's first job. Answers the run id.
   */
  async startBackfill(
    id: string,
    body: BackfillBody,
    caller: ConnectionCaller,
  ): Promise<SyncRunStarted> {
    await this.jobs.prepare(CONNECTOR_SHOPIFY_QUEUE);
    const correlationId = this.audit.newCorrelationId();
    return this.connection.db.transaction(async (tx) => {
      const row = await this.lockConnection(tx, id);
      if (row.status !== 'active' || (row.health !== 'ok' && row.health !== 'degraded')) {
        throw new ConnectionsError(
          'CONNECTION_NOT_READY',
          'The connection must be active and past its connect check',
        );
      }
      if (await this.runs.unfinished(tx, id, ['backfill_products', 'backfill_orders'])) {
        throw new ConnectionsError('BACKFILL_RUNNING', 'A backfill of this connection is running');
      }
      const scan = await this.runs.lastSucceeded(tx, id, 'gateway_scan');
      const config = ShopifyConnectionConfig.partial().safeParse(row.config);
      const mapped = (config.success ? config.data.gatewayMethods : undefined) ?? {};
      const scanned = Array.isArray(scan?.counts['gatewayNames'])
        ? (scan.counts['gatewayNames'] as unknown[]).filter(
            (name): name is string => typeof name === 'string',
          )
        : [];
      // The scan stored keys (`scannedGatewayNames`); keying again is a no op for them.
      const unmapped = scanned.filter((name) => {
        const key = gatewayKeyOf(name);
        return key !== null && !Object.hasOwn(mapped, key);
      });
      if (!scan || unmapped.length > 0) {
        throw new ConnectionsError(
          'GATEWAYS_UNMAPPED',
          scan
            ? 'Every scanned payment gateway needs a payment method first'
            : 'Scan the payment gateways and map them first',
          unmapped,
        );
      }
      await tx.execute(sql`
        UPDATE connections SET go_live_at = ${body.goLiveAt}::timestamptz, updated_at = now()
        WHERE id = ${id}::uuid`);
      const runId = await this.runs.start(tx, {
        connectionId: id,
        kind: 'backfill_products',
        counts: { goLiveAt: body.goLiveAt },
      });
      const store = row.store_id ? (await this.channels.stores([row.store_id], tx))[0] : undefined;
      await this.audit.record(tx, {
        actor: personActor(caller.userId, caller.access.actingHat('settings.manage')),
        action: 'connection.backfill_started',
        record: { type: 'connection', id, ...(store && { label: store.code }) },
        after: { goLiveAt: body.goLiveAt, runId },
        correlationId,
      });
      const data: ShopifyJobData = { kind: 'backfill', connectionId: id, runId, step: 0 };
      await this.jobs.sendIn(tx, CONNECTOR_SHOPIFY_QUEUE, data, {
        ...connectionGroup(id),
        priority: BACKFILL_JOB_PRIORITY,
      });
      return { runId };
    });
  }

  /** A connection's sync runs, newest first (`GET /api/connections/:id/sync-runs`). */
  async syncRuns(id: string, query: SyncRunListQuery): Promise<SyncRunListResponse> {
    return this.runs.list(id, query);
  }

  /** The connection row under its lock, for the task 12 starts; throws `NOT_FOUND`. */
  private async lockConnection(
    tx: Transaction,
    id: string,
  ): Promise<{ status: string; health: string; config: unknown; store_id: string | null }> {
    const { rows } = await tx.execute<{
      status: string;
      health: string;
      config: unknown;
      store_id: string | null;
    }>(sql`
      SELECT status, health::text AS health, config, store_id
      FROM connections WHERE id = ${id}::uuid AND provider = 'shopify' FOR UPDATE`);
    const row = rows[0];
    if (!row) throw new ConnectionsError('NOT_FOUND', 'No connection has that id');
    return row;
  }
}

/** The connect transaction's refusals as typed errors; anything else passes through. */
function connectError(error: unknown): unknown {
  if (error instanceof ChannelsError && error.code === 'STORE_CODE_TAKEN') {
    return new ConnectionsError('STORE_CODE_TAKEN', 'That store code is already in use');
  }
  if (pgErrorCode(error) === '23505' && pgConstraint(error) === 'connections_shop_domain_unique') {
    return new ConnectionsError(
      'SHOP_ALREADY_CONNECTED',
      'That shop already has a live connection',
    );
  }
  return error;
}
