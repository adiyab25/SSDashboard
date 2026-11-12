import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConnectionHealthReason } from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { z } from 'zod';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { DATABASE } from '../../database/database.module.js';
import { pgArray, type Executor } from '../../database/sql.js';
import type { ChannelActor } from '../../orders/intake/order-intake.service.js';
import { OrderTransactions } from '../../orders/order-transactions.js';
import { OrderLockTimeout, OrderTransactionNested } from '../../orders/orders.errors.js';
import { JobSender } from '../../platform/jobs/job-sender.js';
import { SyncRuns } from '../sync-runs/sync-runs.js';
import { missingScopes } from './connect-health.js';
import { ConnectionAccess } from './connection-access.js';
import {
  connectionGroup,
  CONNECTOR_SHOPIFY_QUEUE,
  type ShopifyJobData,
} from './connector-shopify.queue.js';
import { ExchangeByEdit } from './exchange-by-edit.js';
import { orderErrorCodeOf } from './error-codes.js';
import {
  hookAddress,
  isHttpsAddress,
  SHOPIFY_WEBHOOK_TOPICS,
  topicsToCreate,
} from './shopify-app.js';
import {
  rejectUserErrors,
  ShopifyClient,
  ShopifyClientError,
  ShopifyRejectedError,
  ShopifyTransientError,
  type ShopifyOperation,
} from './shopify-client.js';
import {
  CONNECT_ACCESS_SCOPES,
  CONNECT_ACCESS_SCOPES_OPERATION,
  WEBHOOK_SUBSCRIPTION_CREATE,
  WEBHOOK_SUBSCRIPTION_CREATE_OPERATION,
  WEBHOOK_SUBSCRIPTIONS,
  WEBHOOK_SUBSCRIPTIONS_OPERATION,
} from './shopify-queries.js';

/** The job name the hourly check's actor carries (spec 0013 `system_job`). */
export const HOURLY_CHECK_JOB_NAME = 'connectors.shopify.hourly_check';

/** Webhook subscriptions read per page by the hourly check (spec 0015: `webhookSubscriptions(first: 100)`). */
export const HOURLY_SUBSCRIPTIONS_PAGE = 100;
const HOURLY_SUBSCRIPTIONS_MAX_PAGES = 10;

const ScopesAnswer = z.object({
  currentAppInstallation: z.object({ accessScopes: z.array(z.object({ handle: z.string() })) }),
});
const SubscriptionsAnswer = z.object({
  webhookSubscriptions: z.object({
    nodes: z.array(z.object({ topic: z.string(), uri: z.string().nullish() })),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
  }),
});
const SubscriptionCreateAnswer = z.object({
  webhookSubscriptionCreate: z.object({ userErrors: z.array(z.unknown()) }),
});

/** Parses an answer; a shape Shopify did not promise is a transient `INVALID_RESPONSE`. */
function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ShopifyTransientError('INVALID_RESPONSE');
  return parsed.data;
}

/** The degraded codes the hourly check owns: it sets them, moves between them, and clears them. */
const HOURLY_CODES: readonly ConnectionHealthReason[] = ['SCOPES_MISSING', 'WEBHOOKS_MISSING'];

/** The stable code of a waiting replacement refused for good, or null for anything else. */
function refusalCodeOf(error: unknown): string | null {
  if (error instanceof OrderLockTimeout || error instanceof OrderTransactionNested) return null;
  return orderErrorCodeOf(error);
}

/** How one hourly check ended: codes and counts only. */
export interface HourlyCheckOutcome {
  readonly skipped?: string;
  readonly status?: 'succeeded' | 'failed';
  readonly code?: string | null;
  readonly missingScopes?: readonly string[];
  readonly created?: number;
  readonly replacementsCreated?: number;
}

/**
 * The code a run ends with when the check stops on an error that is not Shopify's (code review
 * Major 3): an orders or mapping domain code, else `INTERNAL_ERROR`.
 */
function internalCodeOf(error: unknown): string {
  return orderErrorCodeOf(error) ?? 'INTERNAL_ERROR';
}

/**
 * The hourly check of spec 0015 task 12 (AC-3, AC-12, AC-18; *Backfill, go live, and sweeps*),
 * run by the `connector-shopify` worker:
 *
 * - `tick` (the `shopify-hourly-check` schedule) sends one `hourly_check` job per live connection
 *   (active, past the connect check, its first backfill started: `go_live_at` set; before that the
 *   connect check, run again from the screen, covers the same ground).
 * - `check` writes an `hourly_check` sync run and, for one connection: compares the granted scopes
 *   (`currentAppInstallation.accessScopes`) with `SHOPIFY_REQUIRED_SCOPES` of the running release
 *   and sets health `degraded` `SCOPES_MISSING` with the missing handles in the run's counts (from
 *   `ok`, or updating an earlier `SCOPES_MISSING`; cleared once granted), AC-3; lists the webhook
 *   subscriptions (`webhookSubscriptions(first: 100)`) and creates every missing (topic, address)
 *   pair for the connection's address, never deleting a subscription (another app's or an old
 *   address's), a refused one setting `degraded` `WEBHOOKS_MISSING` from `ok` (cleared when every
 *   topic is subscribed again), AC-18; and tries the waiting replacement orders of AC-12 through
 *   the one call site of task 10's `ExchangeByEdit.retryWaitingReplacements`, one
 *   `OrderTransactions.run` unit per waiting mapping with a `system_job` actor: a replacement
 *   whose original is now delivered (or partially delivered, or refused) is created, the others
 *   keep waiting, and one mapping refused by orders (or unreadable) is counted and left, never
 *   failing the check.
 * - A Shopify error ends the run `failed` with its code and is not retried: the next hour checks
 *   again. Any other error (a lock timeout, a database failure) also ends the run `failed`, with
 *   the domain code or `INTERNAL_ERROR`, and is thrown for pg-boss to retry: a run is never left
 *   `running` (code review Major 3).
 * - Health: only one degraded code is kept at a time, and the hourly codes never overwrite
 *   another one. `SCOPES_MISSING` is set as soon as the scopes are read; at the end the run's
 *   verdict is applied in one statement: `SCOPES_MISSING` when a scope is missing, else
 *   `WEBHOOKS_MISSING` when a registration was refused, else `ok`, moving between the two hourly
 *   codes, so clearing one never hides the other found in the same run (QA 4).
 * - A waiting replacement whose original is cancelled is dropped and counted
 *   (`replacementsDropped`).
 *
 * `ChannelFulfillmentPartialStale` (AC-28) is task 9a's, not here.
 */
@Injectable()
export class HourlyCheckJob {
  private readonly logger = new Logger('ShopifyHourlyCheck');

  /** Takes the database, env, access, client, job sender, runs, orders units, and the exchange. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(ENV) private readonly env: Pick<Env, 'PUBLIC_URL'>,
    @Inject(ConnectionAccess) private readonly access: ConnectionAccess,
    @Inject(ShopifyClient) private readonly shopify: ShopifyClient,
    @Inject(JobSender) private readonly jobs: JobSender,
    @Inject(SyncRuns) private readonly runs: SyncRuns,
    @Inject(OrderTransactions) private readonly orderTransactions: OrderTransactions,
    @Inject(ExchangeByEdit) private readonly exchange: ExchangeByEdit,
  ) {}

  /** The scheduled fan out: one `hourly_check` job per live connection. */
  async tick(): Promise<{ readonly connections: number }> {
    const { rows } = await this.connection.db.execute<{ id: string }>(sql`
      SELECT id FROM connections
      WHERE provider = 'shopify' AND status = 'active' AND health IN ('ok', 'degraded')
        AND go_live_at IS NOT NULL
      ORDER BY created_at, id`);
    if (rows.length > 0) await this.jobs.prepare(CONNECTOR_SHOPIFY_QUEUE);
    for (const row of rows) {
      const data: ShopifyJobData = { kind: 'hourly_check', connectionId: row.id };
      await this.jobs.send(CONNECTOR_SHOPIFY_QUEUE, data, {
        ...connectionGroup(row.id),
        singletonKey: `hourly_check:${row.id}`,
        singletonSeconds: 3_000,
      });
    }
    return { connections: rows.length };
  }

  /** Checks one connection (see the class), as the `hourly_check` job. */
  async check(connectionId: string, jobId: string): Promise<HourlyCheckOutcome> {
    const opened = await this.access.open(connectionId);
    if ('skipped' in opened) return { skipped: opened.skipped };
    const access = opened.access;
    const runId = await this.runs.start(this.connection.db, {
      connectionId,
      kind: 'hourly_check',
    });
    const cost = { points: 0 };
    const call = async (operation: ShopifyOperation) => {
      const answer = await this.shopify.request(access, operation);
      cost.points += answer.cost?.actualQueryCost ?? 0;
      return answer.data;
    };
    try {
      const granted = parse(
        ScopesAnswer,
        await call({
          operationName: CONNECT_ACCESS_SCOPES_OPERATION,
          query: CONNECT_ACCESS_SCOPES,
        }),
      ).currentAppInstallation.accessScopes.map((scope) => scope.handle);
      const missing = missingScopes(granted);
      // Recorded at once, so a later Shopify error of this run does not lose it.
      if (missing.length > 0) {
        await this.markHealth(this.connection.db, connectionId, 'SCOPES_MISSING');
      }

      const existing = await this.subscriptions(call);
      const address = hookAddress(this.env.PUBLIC_URL, connectionId);
      const missingTopics = topicsToCreate(existing, address);
      // A non https address cannot be registered (the connect check's `PUBLIC_URL_NOT_HTTPS`).
      const toCreate = isHttpsAddress(address) ? missingTopics : [];
      let created = 0;
      let refused = false;
      for (const topic of toCreate) {
        try {
          const data = await call({
            operationName: WEBHOOK_SUBSCRIPTION_CREATE_OPERATION,
            query: WEBHOOK_SUBSCRIPTION_CREATE,
            variables: { topic, webhookSubscription: { uri: address, format: 'JSON' } },
          });
          rejectUserErrors(
            parse(SubscriptionCreateAnswer, data).webhookSubscriptionCreate.userErrors,
          );
          created += 1;
        } catch (error) {
          if (!(error instanceof ShopifyRejectedError)) throw error;
          refused = true;
        }
      }
      const subscribed = SHOPIFY_WEBHOOK_TOPICS.length - missingTopics.length + created;
      await this.markHealth(
        this.connection.db,
        connectionId,
        missing.length > 0 ? 'SCOPES_MISSING' : refused ? 'WEBHOOKS_MISSING' : null,
      );

      const waiting = await this.retryWaitingReplacements(connectionId, jobId);
      await this.runs.finish(this.connection.db, runId, {
        status: 'succeeded',
        cost: cost.points,
        counts: {
          missingScopes: missing,
          webhookTopicsSubscribed: subscribed,
          webhookTopicsCreated: created,
          webhooksRefused: refused,
          addressIsHttps: isHttpsAddress(address),
          waitingReplacements: waiting.tried,
          replacementsCreated: waiting.created,
          replacementsStillWaiting: waiting.waiting,
          replacementsRefused: waiting.refused,
          replacementsDropped: waiting.dropped,
        },
      });
      this.logger.log(
        `hourly connection=${connectionId} missing_scopes=${missing.length} created=${created} refused=${refused} replacements_created=${waiting.created} replacements_waiting=${waiting.waiting}`,
      );
      return {
        status: 'succeeded',
        missingScopes: missing,
        created,
        replacementsCreated: waiting.created,
      };
    } catch (error) {
      const code = error instanceof ShopifyClientError ? error.code : internalCodeOf(error);
      await this.runs.finish(this.connection.db, runId, {
        status: 'failed',
        cost: cost.points,
        errorCode: code,
      });
      this.logger.warn(`hourly connection=${connectionId} failed=${code}`);
      if (!(error instanceof ShopifyClientError)) throw error;
      return { status: 'failed', code };
    }
  }

  /** Every existing subscription (topic and address), 100 a page. */
  private async subscriptions(
    call: (operation: ShopifyOperation) => Promise<unknown>,
  ): Promise<{ topic: string; uri: string }[]> {
    const found: { topic: string; uri: string }[] = [];
    let after: string | null = null;
    for (let page = 0; page < HOURLY_SUBSCRIPTIONS_MAX_PAGES; page += 1) {
      const data = await call({
        operationName: WEBHOOK_SUBSCRIPTIONS_OPERATION,
        query: WEBHOOK_SUBSCRIPTIONS,
        variables: { first: HOURLY_SUBSCRIPTIONS_PAGE, after },
      });
      const { nodes, pageInfo } = parse(SubscriptionsAnswer, data).webhookSubscriptions;
      for (const node of nodes) if (node.uri) found.push({ topic: node.topic, uri: node.uri });
      if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
      after = pageInfo.endCursor;
    }
    return found;
  }

  /**
   * Applies the run's health verdict (AC-3, AC-18, QA 4): `reason` set as the degraded code from
   * `ok` or from the other hourly code, or, with null, an hourly code cleared back to `ok`. Any
   * other health or code (a connect check's, `SWEEP_LATE`, `READS_FAILING`) is never touched. The
   * change time moves only when the code changes.
   */
  private async markHealth(
    executor: Executor,
    connectionId: string,
    reason: ConnectionHealthReason | null,
  ): Promise<void> {
    const owned = pgArray([...HOURLY_CODES]);
    if (reason !== null) {
      await executor.execute(sql`
        UPDATE connections
        SET health = 'degraded', health_reason = ${reason},
            health_changed_at = CASE WHEN health_reason IS DISTINCT FROM ${reason}::text
                                     THEN now() ELSE health_changed_at END,
            updated_at = now()
        WHERE id = ${connectionId}::uuid
          AND (health = 'ok'
               OR (health = 'degraded' AND health_reason = ANY(${owned}::text[])))
          AND health_reason IS DISTINCT FROM ${reason}::text`);
      return;
    }
    await executor.execute(sql`
      UPDATE connections
      SET health = 'ok', health_reason = NULL, health_changed_at = now(), updated_at = now()
      WHERE id = ${connectionId}::uuid AND health = 'degraded'
        AND health_reason = ANY(${owned}::text[])`);
  }

  /**
   * The one call site of the waiting replacements (AC-12): every order mapping of the connection
   * holding `pendingReplacementLines`, each through `ExchangeByEdit.retryWaitingReplacements` in
   * its own `OrderTransactions.run` unit with the hourly check's `system_job` actor. A mapping
   * refused with a mapping or orders domain error (for example a variant archived since) is
   * counted under `refused` with its code logged, and the others still run; a lock timeout is
   * thrown, so the job retries. Answers the counts.
   */
  private async retryWaitingReplacements(
    connectionId: string,
    jobId: string,
  ): Promise<{
    tried: number;
    created: number;
    waiting: number;
    refused: number;
    dropped: number;
  }> {
    const { rows } = await this.connection.db.execute<{ id: string }>(sql`
      SELECT id FROM connection_external_ids
      WHERE connection_id = ${connectionId}::uuid AND entity = 'order'
        AND state ? 'pendingReplacementLines'
      ORDER BY id`);
    const actor: ChannelActor = { type: 'system_job', job: HOURLY_CHECK_JOB_NAME, jobId };
    const counts = { tried: rows.length, created: 0, waiting: 0, refused: 0, dropped: 0 };
    for (const row of rows) {
      try {
        const result = await this.orderTransactions.run((tx) =>
          this.exchange.retryWaitingReplacements(tx, connectionId, row.id, actor),
        );
        if (result.status === 'created') counts.created += 1;
        else if (result.status === 'waiting') counts.waiting += 1;
        else if (result.status === 'dropped') counts.dropped += 1;
      } catch (error) {
        const code = refusalCodeOf(error);
        if (code === null) throw error;
        counts.refused += 1;
        this.logger.warn(`hourly connection=${connectionId} mapping=${row.id} replacement=${code}`);
      }
    }
    return counts;
  }
}
