import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { createDatabase, type DatabaseConnection } from '@ssdashboard/db';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { SettingsCache } from './settings-cache.js';

/** The channel every committed settings change notifies, with the key as payload (AC-3). */
export const PLATFORM_CHANGED_CHANNEL = 'ssd_platform_changed';

/** The `application_name` of the listening connection, so an operator can find it. */
export const PLATFORM_LISTENER_NAME = 'ssd_platform_changes';

/** How the listener waits between reconnect tries: `firstMs`, doubling up to `maxMs`. */
export interface ListenerRetry {
  firstMs: number;
  maxMs: number;
}

/**
 * The injection token of the reconnect delays. Production uses `DEFAULT_LISTENER_RETRY`; a test
 * overrides it to keep one process's listener down long enough to prove the cache lifetime.
 */
export const LISTENER_RETRY = Symbol('LISTENER_RETRY');

/** Half a second, doubling up to 15 seconds. */
export const DEFAULT_LISTENER_RETRY: ListenerRetry = { firstMs: 500, maxMs: 15_000 };

/** Idle time before the first TCP keepalive probe on the listening connection (review R4). */
export const LISTENER_KEEPALIVE_DELAY_MS = 10_000;

/** How long one connect try may take before it fails, so boot never hangs on it (review R5). */
export const LISTENER_CONNECT_TIMEOUT_MS = 5_000;

/** The parts of a `pg` connection the listener uses. */
interface ListenConnection {
  query(text: string): Promise<unknown>;
  on(event: 'notification', listener: (message: { payload?: string }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  release(destroy?: boolean): void;
}

/**
 * Keeps one dedicated connection that runs `LISTEN ssd_platform_changed` in the api and in the
 * worker (spec 0009, AC-4). Each notification drops that key from `SettingsCache` (every key
 * when the payload is empty), so a committed change is read within moments; a rolled back change
 * never notifies. The connection turns on TCP keepalive with a 10 second idle delay (review R4):
 * after 10 seconds without traffic the operating system starts probing the peer, and when its own
 * probe count runs out unanswered (minutes, by the OS defaults) the socket errors, which this
 * listener treats as a lost connection; a half open socket is therefore detected, though not
 * within seconds. A 5 second connect timeout keeps boot from hanging (R5). When the connection is lost it reconnects
 * by itself with a doubling delay (`LISTENER_RETRY`, 0.5 s up to 15 s) and drops the whole cache
 * once back, since notifications sent meanwhile were missed; until then the 30 second cache
 * lifetime bounds staleness. It never logs a payload.
 */
@Injectable()
export class PlatformChangesListener implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('PlatformChanges');
  private pool: DatabaseConnection['pool'] | undefined;
  private connection: ListenConnection | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private failures = 0;
  private stopping = false;

  /** Takes the env for the database URL, the cache it keeps fresh, and the reconnect delays. */
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(SettingsCache) private readonly cache: SettingsCache,
    @Inject(LISTENER_RETRY) private readonly retryDelays: ListenerRetry,
  ) {}

  /** True while the listening connection is up. */
  get listening(): boolean {
    return this.connection !== undefined;
  }

  /**
   * Opens the listening connection. A database that cannot be reached is not fatal: the listener
   * keeps retrying in the background and reads stay bounded by the cache lifetime.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.connect();
  }

  /** Stops retrying and closes the connection and its pool. */
  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.retryTimer);
    this.connection?.release(true);
    this.connection = undefined;
    await this.pool?.end().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    if (this.stopping) return;
    // One connection of its own: a pooled query connection would drop the LISTEN on release.
    this.pool ??= createDatabase(this.env.DATABASE_URL, {
      max: 1,
      keepAlive: true,
      keepAliveInitialDelayMillis: LISTENER_KEEPALIVE_DELAY_MS,
      connectionTimeoutMillis: LISTENER_CONNECT_TIMEOUT_MS,
    }).pool;
    let connection: ListenConnection | undefined;
    try {
      connection = await this.pool.connect();
      connection.on('error', () => this.lost(connection));
      connection.on('end', () => this.lost(connection));
      connection.on('notification', (message) => this.cache.drop(message.payload || undefined));
      await connection.query(`SET application_name = '${PLATFORM_LISTENER_NAME}'`);
      await connection.query(`LISTEN ${PLATFORM_CHANGED_CHANNEL}`);
    } catch (error) {
      connection?.release(true);
      this.retry(`could not listen: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (this.stopping) {
      connection.release(true);
      return;
    }
    this.connection = connection;
    if (this.failures > 0) this.logger.log('Listening for platform changes again');
    this.failures = 0;
    // Anything that changed while no connection listened was missed.
    this.cache.drop();
  }

  private lost(connection: ListenConnection | undefined): void {
    if (this.stopping || connection === undefined || this.connection !== connection) return;
    this.connection = undefined;
    try {
      connection.release(true);
    } catch {
      // the connection is already gone
    }
    this.retry('the listening connection was lost');
  }

  private retry(why: string): void {
    if (this.stopping || this.retryTimer !== undefined) return;
    const { firstMs, maxMs } = this.retryDelays;
    const delay = Math.min(maxMs, firstMs * 2 ** this.failures);
    this.failures += 1;
    this.logger.warn(`Platform changes listener: ${why}; trying again in ${delay} ms`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.connect();
    }, delay);
    this.retryTimer.unref();
  }
}
