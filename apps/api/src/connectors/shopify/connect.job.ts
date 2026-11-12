import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ShopifyConnectionConfig,
  type AppOwner,
  type ConnectionHealthReason,
  type ConnectionWarning,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { z } from 'zod';
import { ChannelsService } from '../../channels/channels.service.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { DATABASE } from '../../database/database.module.js';
import { pgArray } from '../../database/sql.js';
import { SettingsService } from '../../platform/settings/settings.service.js';
import {
  ConnectionSecrets,
  CredentialsUnreadable,
  type ConnectionCredentials,
} from '../connections/connection-secrets.js';
import { connectWarnings, decideConnectHealth, missingScopes } from './connect-health.js';
import {
  rejectUserErrors,
  SHOPIFY_API_VERSION,
  ShopifyClient,
  ShopifyClientError,
  ShopifyRejectedError,
  ShopifyTransientError,
  type ShopifyConnectionAccess,
  type ShopifyOperation,
  type ShopifyResponse,
  type ShopifyWarning,
} from './shopify-client.js';
import {
  hookAddress,
  isHttpsAddress,
  SHOPIFY_WEBHOOK_TOPICS,
  topicsToCreate,
} from './shopify-app.js';
import {
  CONNECT_ACCESS_SCOPES,
  CONNECT_ACCESS_SCOPES_OPERATION,
  CONNECT_LATEST_ORDER,
  CONNECT_LATEST_ORDER_OPERATION,
  CONNECT_LOCATIONS,
  CONNECT_LOCATIONS_OPERATION,
  CONNECT_SHOP,
  CONNECT_SHOP_OPERATION,
  WEBHOOK_SUBSCRIPTION_CREATE,
  WEBHOOK_SUBSCRIPTION_CREATE_OPERATION,
  WEBHOOK_SUBSCRIPTIONS,
  WEBHOOK_SUBSCRIPTIONS_OPERATION,
} from './shopify-queries.js';
import { StorableShopifyText } from './storable-text.js';

/** Locations read at connect (one page; Shopify caps an input page at 250). */
export const CONNECT_LOCATIONS_PAGE = 50;

/** Webhook subscriptions read per page, and the most pages read. */
export const WEBHOOK_SUBSCRIPTIONS_PAGE = 50;
const WEBHOOK_SUBSCRIPTIONS_MAX_PAGES = 10;

// The answers the connect job reads, parsed before use. A shape Shopify did not promise is a
// transient `INVALID_RESPONSE` (retried), never a crash with the body in the message.
const ShopAnswer = z.object({
  shop: z.object({
    // Stored verbatim (the store's names, `config.shopTimezone` in `jsonb`): storable text only
    // (security review N4), else the transient `INVALID_RESPONSE`.
    name: StorableShopifyText.pipe(z.string().min(1)),
    currencyCode: z.string().min(1),
    ianaTimezone: StorableShopifyText.pipe(z.string().min(1)),
  }),
});
const ScopesAnswer = z.object({
  currentAppInstallation: z.object({ accessScopes: z.array(z.object({ handle: z.string() })) }),
});
const LocationsAnswer = z.object({
  locations: z.object({
    nodes: z.array(z.object({ id: z.string(), fulfillsOnlineOrders: z.boolean() })),
  }),
});
const LatestOrderAnswer = z.object({
  orders: z.object({
    nodes: z.array(
      z.object({
        shippingAddress: z
          .object({
            name: z.string().nullish(),
            phone: z.string().nullish(),
            address1: z.string().nullish(),
          })
          .nullable(),
      }),
    ),
  }),
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

/** The connection columns the job reads; the ciphertext stays a buffer in memory only. */
interface ConnectionRow extends Record<string, unknown> {
  id: string;
  store_id: string | null;
  shop_domain: string | null;
  status: string;
  credentials_ciphertext: Buffer | null;
  credentials_key_version: number | null;
  config: unknown;
  api_version: string | null;
}

/** How a connect run ended, written to the connection and its sync run in one transaction. */
interface ConnectEnd {
  health: 'ok' | 'degraded' | 'failing';
  reason: ConnectionHealthReason | null;
  /** The connect warnings, plus `API_VERSION_FELL_FORWARD` when any answer of the run carried it. */
  warnings: readonly (ConnectionWarning | ShopifyWarning)[];
  shopName: string | null;
  shopTimezone: string | null;
  apiVersion: string | null;
  counts: Record<string, unknown>;
}

/** What the handler returns as the job's output: codes and counts only. */
export interface ConnectOutcome {
  readonly health?: ConnectEnd['health'];
  readonly reason?: ConnectionHealthReason | null;
  readonly skipped?: string;
}

/** The rejections that end a connect check `failing` with a code of their own (AC-1). */
function rejectionReason(error: ShopifyRejectedError): ConnectionHealthReason {
  const code = error.code;
  if (
    code === 'APP_NOT_INSTALLED' ||
    code === 'APP_ORGANIZATION_MISMATCH' ||
    code === 'CREDENTIALS_REJECTED' ||
    code === 'SHOP_UNAVAILABLE' ||
    code === 'ACCESS_DENIED'
  ) {
    return code;
  }
  return 'CONNECT_REJECTED';
}

/**
 * The `connect` job of spec 0015 task 6 (AC-1, AC-2), the `connect` kind of the
 * `connector-shopify` queue (run by `ConnectorShopifyWorker`, which declares the queue). For one
 * connection it opens the sealed credentials, gets a token, reads the
 * shop, the granted scopes, the locations, and the most recent order, decides the health
 * (`decideConnectHealth`), and when it passes registers the 13 webhook subscriptions (skipping
 * those already pointing at the connection's address). It fills the store's names from the shop
 * name the first time it reaches the shop (`ChannelsService.renameStore`), stores
 * `config.shopTimezone` and `api_version`, sets health `ok`, `degraded` (`WEBHOOKS_MISSING`), or
 * `failing` with one code, and writes a `connect` sync run with counts and cost points. A run whose
 * reads answered in another API version adds `API_VERSION_FELL_FORWARD` to the warnings (AC-25);
 * the warnings are written whole each run, so a run that matches again clears it.
 *
 * A transient Shopify failure marks the run failed with its code and throws, so pg-boss retries
 * with backoff. The job data holds the connection id only; credentials and the token live in
 * memory, never in a log line, an error, the job output, or a row. It never stores the latest
 * order's values: each is reduced to present or not at once.
 */
@Injectable()
export class ConnectJob {
  private readonly logger = new Logger('ShopifyConnect');

  /** Takes the database, env, secrets, Shopify client, channels, and settings. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(ENV) private readonly env: Pick<Env, 'PUBLIC_URL'>,
    @Inject(ConnectionSecrets) private readonly secrets: ConnectionSecrets,
    @Inject(ShopifyClient) private readonly shopify: ShopifyClient,
    @Inject(ChannelsService) private readonly channels: ChannelsService,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  /** Runs the connect check for one connection (see the class comment). */
  async connect(connectionId: string): Promise<ConnectOutcome> {
    const { rows } = await this.connection.db.execute<ConnectionRow>(sql`
      SELECT id, store_id, shop_domain, status, credentials_ciphertext, credentials_key_version,
             config, api_version
      FROM connections WHERE id = ${connectionId}::uuid AND provider = 'shopify'`);
    const row = rows[0];
    if (!row || row.status === 'archived') return { skipped: 'CONNECTION_NOT_LIVE' };
    if (!row.shop_domain || !row.credentials_ciphertext || row.credentials_key_version === null) {
      return { skipped: 'CONNECTION_INCOMPLETE' };
    }
    const config = ShopifyConnectionConfig.partial().safeParse(row.config);
    const appOwner: AppOwner =
      (config.success ? config.data.appOwner : undefined) ?? 'organization';
    const storedTimezone = config.success ? (config.data.shopTimezone ?? null) : null;

    const run = await this.connection.db.execute<{ id: string }>(sql`
      INSERT INTO connection_sync_runs (connection_id, kind, status)
      VALUES (${connectionId}::uuid, 'connect', 'running') RETURNING id`);
    const runId = run.rows[0]?.id as string;
    let cost = 0;
    const clientWarnings = new Set<ShopifyWarning>();
    const call = async (access: ShopifyConnectionAccess, operation: ShopifyOperation) => {
      const answer = await this.shopify.request(access, operation);
      cost += Math.max(0, Math.round(answer.cost?.actualQueryCost ?? 0));
      for (const warning of answer.warnings) clientWarnings.add(warning);
      return answer;
    };

    const install = await this.settings.read(['currency', 'timezone']);
    const tokenFailureWarnings = connectWarnings({
      shopTimezone: storedTimezone ?? install.timezone,
      installTimezone: install.timezone,
      appOwner,
    });

    let credentials: ConnectionCredentials;
    try {
      credentials = this.secrets.open(
        { ciphertext: row.credentials_ciphertext, keyVersion: row.credentials_key_version },
        connectionId,
      );
    } catch (error) {
      if (!(error instanceof CredentialsUnreadable)) throw error;
      return this.finish(row, runId, cost, {
        health: 'failing',
        reason: 'CREDENTIALS_UNREADABLE',
        warnings: tokenFailureWarnings,
        shopName: null,
        shopTimezone: null,
        apiVersion: null,
        counts: {},
      });
    }
    const access: ShopifyConnectionAccess = {
      connectionId,
      shopDomain: row.shop_domain,
      credentials,
    };

    try {
      const end = await this.check(access, call, {
        appOwner,
        installCurrency: install.currency,
        installTimezone: install.timezone,
      });
      // AC-25: an answer in another API version than the pinned one sets the warning; a run whose
      // answers all match clears it (code review m3).
      return await this.finish(row, runId, cost, {
        ...end,
        warnings: [...end.warnings, ...clientWarnings],
      });
    } catch (error) {
      if (error instanceof ShopifyRejectedError) {
        return this.finish(row, runId, cost, {
          health: 'failing',
          reason: rejectionReason(error),
          warnings: tokenFailureWarnings,
          shopName: null,
          shopTimezone: null,
          apiVersion: null,
          counts: {},
        });
      }
      const code = error instanceof ShopifyClientError ? error.code : 'CONNECT_ERROR';
      await this.connection.db.execute(sql`
        UPDATE connection_sync_runs
        SET status = 'failed', finished_at = now(), error_code = ${code}, cost_points = ${cost}
        WHERE id = ${runId}::uuid`);
      this.logger.warn(`connect connection=${connectionId} retry=${code}`);
      // Rethrown so pg-boss retries; a client error carries a code only, anything else is a bug.
      if (error instanceof ShopifyClientError) throw error;
      throw new Error('CONNECT_ERROR', { cause: error });
    }
  }

  /** The reads, the decision, and the subscriptions. Throws the client's typed errors. */
  private async check(
    access: ShopifyConnectionAccess,
    call: (
      access: ShopifyConnectionAccess,
      operation: ShopifyOperation,
    ) => Promise<ShopifyResponse>,
    install: { appOwner: AppOwner; installCurrency: string; installTimezone: string },
  ): Promise<ConnectEnd> {
    const shopAnswer = await call(access, {
      operationName: CONNECT_SHOP_OPERATION,
      query: CONNECT_SHOP,
    });
    const shop = parse(ShopAnswer, shopAnswer.data).shop;
    const apiVersion = shopAnswer.apiVersion ?? SHOPIFY_API_VERSION;
    const scopes = parse(
      ScopesAnswer,
      (
        await call(access, {
          operationName: CONNECT_ACCESS_SCOPES_OPERATION,
          query: CONNECT_ACCESS_SCOPES,
        })
      ).data,
    ).currentAppInstallation.accessScopes.map((scope) => scope.handle);
    const address = hookAddress(this.env.PUBLIC_URL, access.connectionId);
    const base = {
      grantedScopes: scopes,
      latestOrder: null,
      shopCurrency: shop.currencyCode,
      installCurrency: install.installCurrency,
      shopTimezone: shop.ianaTimezone,
      installTimezone: install.installTimezone,
      appOwner: install.appOwner,
      hookAddressIsHttps: isHttpsAddress(address),
    };
    const ended = (
      verdict: ReturnType<typeof decideConnectHealth>,
      counts: Record<string, unknown>,
    ) =>
      ({
        health: verdict.health,
        reason: verdict.reason,
        warnings: verdict.warnings,
        shopName: shop.name,
        shopTimezone: shop.ianaTimezone,
        apiVersion,
        counts: { ...counts, missingScopes: verdict.missingScopes },
      }) satisfies ConnectEnd;

    // Without every scope the later reads may be refused: stop at the scope check.
    if (missingScopes(scopes).length > 0) return ended(decideConnectHealth(base), {});

    const locations = parse(
      LocationsAnswer,
      (
        await call(access, {
          operationName: CONNECT_LOCATIONS_OPERATION,
          query: CONNECT_LOCATIONS,
          variables: { first: CONNECT_LOCATIONS_PAGE },
        })
      ).data,
    ).locations.nodes;
    const latest = parse(
      LatestOrderAnswer,
      (
        await call(access, {
          operationName: CONNECT_LATEST_ORDER_OPERATION,
          query: CONNECT_LATEST_ORDER,
        })
      ).data,
    ).orders.nodes[0];
    // Reduced to present or not here; the values go no further.
    const latestOrder = latest
      ? {
          hasName: present(latest.shippingAddress?.name),
          hasPhone: present(latest.shippingAddress?.phone),
          hasAddress: present(latest.shippingAddress?.address1),
        }
      : null;
    const counts = {
      locations: locations.length,
      onlineLocations: locations.filter((location) => location.fulfillsOnlineOrders).length,
      latestOrderChecked: latestOrder !== null,
    };
    const verdict = decideConnectHealth({ ...base, latestOrder });
    if (verdict.health !== 'ok') return ended(verdict, counts);

    const existing = await this.subscriptions(access, call);
    const missingTopics = topicsToCreate(existing, address);
    let created = 0;
    try {
      for (const topic of missingTopics) {
        const answer = await call(access, {
          operationName: WEBHOOK_SUBSCRIPTION_CREATE_OPERATION,
          query: WEBHOOK_SUBSCRIPTION_CREATE,
          variables: { topic, webhookSubscription: { uri: address, format: 'JSON' } },
        });
        rejectUserErrors(
          parse(SubscriptionCreateAnswer, answer.data).webhookSubscriptionCreate.userErrors,
        );
        created += 1;
      }
    } catch (error) {
      if (!(error instanceof ShopifyRejectedError)) throw error;
      const subscribed = SHOPIFY_WEBHOOK_TOPICS.length - missingTopics.length + created;
      return {
        ...ended(verdict, {
          ...counts,
          webhookTopicsSubscribed: subscribed,
          webhookTopicsCreated: created,
        }),
        health: 'degraded',
        reason: 'WEBHOOKS_MISSING',
      };
    }
    return ended(verdict, {
      ...counts,
      webhookTopicsSubscribed: SHOPIFY_WEBHOOK_TOPICS.length,
      webhookTopicsCreated: created,
    });
  }

  /** Every existing subscription (topic and address), page by page. */
  private async subscriptions(
    access: ShopifyConnectionAccess,
    call: (
      access: ShopifyConnectionAccess,
      operation: ShopifyOperation,
    ) => Promise<ShopifyResponse>,
  ): Promise<{ topic: string; uri: string }[]> {
    const found: { topic: string; uri: string }[] = [];
    let after: string | null = null;
    for (let page = 0; page < WEBHOOK_SUBSCRIPTIONS_MAX_PAGES; page += 1) {
      const answer = await call(access, {
        operationName: WEBHOOK_SUBSCRIPTIONS_OPERATION,
        query: WEBHOOK_SUBSCRIPTIONS,
        variables: { first: WEBHOOK_SUBSCRIPTIONS_PAGE, after },
      });
      const { nodes, pageInfo } = parse(SubscriptionsAnswer, answer.data).webhookSubscriptions;
      for (const node of nodes) if (node.uri) found.push({ topic: node.topic, uri: node.uri });
      if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
      after = pageInfo.endCursor;
    }
    return found;
  }

  /**
   * Writes the end of a run in one transaction: the store's names from the shop name the first
   * time the shop was reached (`api_version` still null), the connection's health, warnings,
   * shop time zone, and API version, and the sync run's status, counts, cost, and error code.
   */
  private async finish(
    row: ConnectionRow,
    runId: string,
    cost: number,
    end: ConnectEnd,
  ): Promise<ConnectOutcome> {
    const runStatus =
      end.health === 'ok' ? 'succeeded' : end.health === 'degraded' ? 'partial' : 'failed';
    const configPatch = end.shopTimezone ? { shopTimezone: end.shopTimezone } : {};
    await this.connection.db.transaction(async (tx) => {
      if (end.shopName && row.api_version === null && row.store_id) {
        const name = { en: end.shopName, ar: end.shopName };
        await this.channels.renameStore(tx, row.store_id, { name, publicName: name });
      }
      await tx.execute(sql`
        UPDATE connections
        SET health_changed_at = CASE
              WHEN health IS DISTINCT FROM ${end.health}::connection_health
                OR health_reason IS DISTINCT FROM ${end.reason}::text THEN now()
              ELSE health_changed_at END,
            health = ${end.health}::connection_health,
            health_reason = ${end.reason}::text,
            health_warnings = ${pgArray([...end.warnings])}::text[],
            api_version = coalesce(${end.apiVersion}::text, api_version),
            config = config || ${JSON.stringify(configPatch)}::jsonb,
            updated_at = now()
        WHERE id = ${row.id}::uuid`);
      await tx.execute(sql`
        UPDATE connection_sync_runs
        SET status = ${runStatus}::sync_run_status, finished_at = now(),
            counts = ${JSON.stringify(end.counts)}::jsonb, cost_points = ${cost},
            error_code = ${end.health === 'ok' ? null : end.reason}
        WHERE id = ${runId}::uuid`);
    });
    this.logger.log(
      `connect connection=${row.id} health=${end.health} reason=${end.reason ?? 'none'} cost=${cost}`,
    );
    return { health: end.health, reason: end.reason };
  }
}

/** Parses an answer; a shape Shopify did not promise is a transient `INVALID_RESPONSE`. */
function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const parsed = schema.safeParse(data);
  // The zod error is dropped on purpose: its issues could quote a value from the answer.
  if (!parsed.success) throw new ShopifyTransientError('INVALID_RESPONSE');
  return parsed.data;
}

/** A value Shopify sent that is not blank. */
function present(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}
