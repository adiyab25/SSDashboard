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
import { SyncRuns, type RunPosition, type SyncRunRow } from '../sync-runs/sync-runs.js';
import { ConnectionSecrets, credentialsHint } from './connection-secrets.js';
import { GoLiveClock, goLiveInRange } from './go-live-clock.js';

/**
 * Where a backfill run resumes (lead decision D11, AC-17): its recorded position with the step
 * moved on (a job of the old step is then a duplicate and skipped). A bulk operation Shopify
 * ended (`BULK_*`) or whose result address it refused (`REQUEST_REJECTED`, an expired address)
 * cannot be read again: the run then starts a new bulk read from its first line, and the orders
 * already applied are skipped as `stale` by their mappings' versions. A paged run keeps its page
 * cursor.
 */
export function resumePositionOf(run: Pick<SyncRunRow, 'position' | 'errorCode'>): RunPosition {
  const code = run.errorCode ?? '';
  const bulkGone =
    run.position.mode === 'bulk' && (code.startsWith('BULK_') || code === 'REQUEST_REJECTED');
  return {
    ...run.position,
    step: run.position.step + 1,
    ...(bulkGone && { bulkId: null, line: 0 }),
  };
}

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
    @Inject(GoLiveClock) private readonly goLiveClock: GoLiveClock,
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
   * under the connection's row lock, refuses an archived connection (`CONNECTION_ARCHIVED`), a
   * paused one (`CONNECTION_PAUSED`, QA 3), and one whose gateway scan has not finished
   * (`SCAN_RUNNING`), unless that run is stalled (`RUN_STALLED_AFTER_MS` without moving, code
   * review Major 3): it is then ended `failed` `RUN_STALLED`. Then, in one transaction, it writes
   * a `gateway_scan` run, records `connection.gateway_scan_started` with the run id (security
   * review L7), and sends the run's first job. Answers the run id.
   */
  async startGatewayScan(id: string, caller: ConnectionCaller): Promise<SyncRunStarted> {
    await this.jobs.prepare(CONNECTOR_SHOPIFY_QUEUE);
    const correlationId = this.audit.newCorrelationId();
    return this.connection.db.transaction(async (tx) => {
      const row = await this.lockConnection(tx, id);
      if (row.status === 'archived') {
        throw new ConnectionsError('CONNECTION_ARCHIVED', 'An archived connection is not scanned');
      }
      if (row.status === 'paused') {
        throw new ConnectionsError('CONNECTION_PAUSED', 'A paused connection is not scanned');
      }
      const open = await this.runs.unfinished(tx, id, ['gateway_scan']);
      if (open) {
        if (!(await this.runs.stalled(tx, open))) {
          throw new ConnectionsError(
            'SCAN_RUNNING',
            'A gateway scan of this connection is running',
          );
        }
        await this.runs.finish(tx, open.id, { status: 'failed', errorCode: 'RUN_STALLED' });
      }
      const runId = await this.runs.start(tx, { connectionId: id, kind: 'gateway_scan' });
      await this.audit.record(tx, {
        actor: personActor(caller.userId, caller.access.actingHat('settings.manage')),
        action: 'connection.gateway_scan_started',
        record: { type: 'connection', id, ...(await this.storeLabel(tx, row.store_id)) },
        after: { runId },
        correlationId,
      });
      const data: ShopifyJobData = { kind: 'gateway_scan', connectionId: id, runId, step: 0 };
      await this.jobs.sendIn(tx, CONNECTOR_SHOPIFY_QUEUE, data, {
        ...connectionGroup(id),
        priority: BACKFILL_JOB_PRIORITY,
      });
      return { runId };
    });
  }

  /**
   * Starts, resumes, or redoes the first backfill (`POST /api/connections/:id/backfill`, spec
   * 0015 task 12, AC-17, lead decision D11). Under the connection's row lock it refuses, in this
   * order: a paused connection (`CONNECTION_PAUSED`, QA 3); one that is not `active` or whose
   * health is not `ok` or `degraded` (`CONNECTION_NOT_READY`); one with a backfill run unfinished
   * and not stalled (`BACKFILL_RUNNING`); a `goLiveAt` other than the `go_live_at` already set
   * (`GO_LIVE_ALREADY_SET`: it is set once, by the first start); for a first start, a `goLiveAt`
   * after the database clock plus 5 minutes or before it minus 60 days (`GO_LIVE_OUT_OF_RANGE`,
   * `GoLiveClock`); a newest succeeded gateway scan that dropped names past 100
   * (`GATEWAYS_TOO_MANY`, security review L3); and one that names a gateway with no payment
   * method in `config.gatewayMethods`, or no succeeded scan yet (`GATEWAYS_UNMAPPED`, with the
   * unmapped names). Then, in one transaction: the first start sets `go_live_at`; a newest
   * backfill run that failed, or is stalled, is reopened at its recorded position (the step moves
   * on, so a stray old job is skipped; a bulk operation Shopify ended or refused is read again
   * from a new one), so a resume repeats nothing; otherwise (no run yet, or the last one
   * succeeded) a new `backfill_products` run starts, idempotent by the inbox dedupe keys and the
   * mappings' versions. It records `connection.backfill_started` (the go live instant, the run
   * id, and `resumed`, never a credential) and sends the run's next job. Answers the run id.
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
      if (row.status === 'paused') {
        throw new ConnectionsError('CONNECTION_PAUSED', 'A paused connection is not backfilled');
      }
      if (row.status !== 'active' || (row.health !== 'ok' && row.health !== 'degraded')) {
        throw new ConnectionsError(
          'CONNECTION_NOT_READY',
          'The connection must be active and past its connect check',
        );
      }
      const kinds = ['backfill_products', 'backfill_orders'] as const;
      const open = await this.runs.unfinished(tx, id, kinds);
      if (open && !(await this.runs.stalled(tx, open))) {
        throw new ConnectionsError('BACKFILL_RUNNING', 'A backfill of this connection is running');
      }
      if (row.go_live_at !== null) {
        const { rows } = await tx.execute<{ same: boolean }>(sql`
          SELECT ${row.go_live_at}::timestamptz = ${body.goLiveAt}::timestamptz AS same`);
        if (rows[0]?.same !== true) {
          throw new ConnectionsError(
            'GO_LIVE_ALREADY_SET',
            'The go live instant is set once, by the first backfill',
          );
        }
      } else if (!goLiveInRange(body.goLiveAt, await this.goLiveClock.now(tx))) {
        throw new ConnectionsError(
          'GO_LIVE_OUT_OF_RANGE',
          'The go live instant must be at most 5 minutes ahead and 60 days back',
        );
      }
      const scan = await this.runs.lastSucceeded(tx, id, 'gateway_scan');
      if (scan?.counts['gatewayNamesTruncated'] === true) {
        throw new ConnectionsError(
          'GATEWAYS_TOO_MANY',
          'The gateway scan found more payment gateways than it can list',
        );
      }
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
      if (row.go_live_at === null) {
        await tx.execute(sql`
          UPDATE connections SET go_live_at = ${body.goLiveAt}::timestamptz, updated_at = now()
          WHERE id = ${id}::uuid`);
      }
      const newest = open ?? (await this.runs.newest(tx, id, kinds));
      const resume = newest && (!newest.finished || newest.status === 'failed') ? newest : null;
      let runId: string;
      let step = 0;
      if (resume) {
        const position = resumePositionOf(resume);
        await this.runs.reopen(tx, resume.id, position);
        runId = resume.id;
        step = position.step;
      } else {
        runId = await this.runs.start(tx, {
          connectionId: id,
          kind: 'backfill_products',
          counts: { goLiveAt: body.goLiveAt },
        });
      }
      await this.audit.record(tx, {
        actor: personActor(caller.userId, caller.access.actingHat('settings.manage')),
        action: 'connection.backfill_started',
        record: { type: 'connection', id, ...(await this.storeLabel(tx, row.store_id)) },
        after: { goLiveAt: body.goLiveAt, runId, resumed: resume !== null },
        correlationId,
      });
      const data: ShopifyJobData = { kind: 'backfill', connectionId: id, runId, step };
      await this.jobs.sendIn(tx, CONNECTOR_SHOPIFY_QUEUE, data, {
        ...connectionGroup(id),
        priority: BACKFILL_JOB_PRIORITY,
      });
      return { runId };
    });
  }

  /** The audit record's label: the store code, when the connection has a store. */
  private async storeLabel(tx: Transaction, storeId: string | null): Promise<{ label?: string }> {
    const store = storeId ? (await this.channels.stores([storeId], tx))[0] : undefined;
    return store ? { label: store.code } : {};
  }

  /** A connection's sync runs, newest first (`GET /api/connections/:id/sync-runs`). */
  async syncRuns(id: string, query: SyncRunListQuery): Promise<SyncRunListResponse> {
    return this.runs.list(id, query);
  }

  /** The connection row under its lock, for the task 12 starts; throws `NOT_FOUND`. */
  private async lockConnection(
    tx: Transaction,
    id: string,
  ): Promise<{
    status: string;
    health: string;
    config: unknown;
    store_id: string | null;
    go_live_at: string | null;
  }> {
    const { rows } = await tx.execute<{
      status: string;
      health: string;
      config: unknown;
      store_id: string | null;
      go_live_at: string | null;
    }>(sql`
      SELECT status, health::text AS health, config, store_id,
             to_char(go_live_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS go_live_at
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
