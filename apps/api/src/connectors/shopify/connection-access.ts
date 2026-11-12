import { Inject, Injectable } from '@nestjs/common';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../../database/database.module.js';
import { ConnectionSecrets, CredentialsUnreadable } from '../connections/connection-secrets.js';
import type { ShopifyConnectionAccess } from './shopify-client.js';

/** The connection columns the task 12 jobs read; the ciphertext stays a buffer in memory only. */
export interface LiveConnection {
  readonly id: string;
  readonly status: string;
  readonly storeId: string | null;
  readonly config: unknown;
  /** UTC ISO instants, or null. */
  readonly goLiveAt: string | null;
  readonly ordersSweptThrough: string | null;
  readonly productsSweptThrough: string | null;
}

interface ConnectionRecord extends Record<string, unknown> {
  id: string;
  status: string;
  store_id: string | null;
  shop_domain: string | null;
  credentials_ciphertext: Buffer | null;
  credentials_key_version: number | null;
  config: unknown;
  go_live_at: string | null;
  orders_swept_through: string | null;
  products_swept_through: string | null;
}

/** How opening a connection ended: its access, or why there is none (a code). */
export type OpenedConnection =
  | { readonly connection: LiveConnection; readonly access: ShopifyConnectionAccess }
  | {
      readonly skipped: 'CONNECTION_NOT_LIVE' | 'CONNECTION_INCOMPLETE' | 'CREDENTIALS_UNREADABLE';
    };

/**
 * Opens a Shopify connection for one task 12 job (spec 0015, AC-2): reads the connection, refuses
 * one that is not `active` (paused, restricted, archived, or unknown: `CONNECTION_NOT_LIVE`) or has
 * no shop domain or keys (`CONNECTION_INCOMPLETE`), and opens the sealed credentials through
 * `ConnectionSecrets` (`CREDENTIALS_UNREADABLE` when the keys no longer open; the connect check
 * owns that health code). The opened credentials live in memory only: never a log, a row, an
 * error, or job data. Worker only.
 */
@Injectable()
export class ConnectionAccess {
  /** Takes the database and the secrets. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(ConnectionSecrets) private readonly secrets: ConnectionSecrets,
  ) {}

  /** Opens one connection (see the class). */
  async open(connectionId: string): Promise<OpenedConnection> {
    const iso = (column: string) =>
      sql.raw(
        `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`,
      );
    const { rows } = await this.connection.db.execute<ConnectionRecord>(sql`
      SELECT id, status, store_id, shop_domain, credentials_ciphertext, credentials_key_version,
             config, ${iso('go_live_at')}, ${iso('orders_swept_through')},
             ${iso('products_swept_through')}
      FROM connections WHERE id = ${connectionId}::uuid AND provider = 'shopify'`);
    const row = rows[0];
    if (!row || row.status !== 'active') return { skipped: 'CONNECTION_NOT_LIVE' };
    if (!row.shop_domain || !row.credentials_ciphertext || row.credentials_key_version === null) {
      return { skipped: 'CONNECTION_INCOMPLETE' };
    }
    try {
      const credentials = this.secrets.open(
        { ciphertext: row.credentials_ciphertext, keyVersion: row.credentials_key_version },
        row.id,
      );
      return {
        connection: {
          id: row.id,
          status: row.status,
          storeId: row.store_id,
          config: row.config,
          goLiveAt: row.go_live_at,
          ordersSweptThrough: row.orders_swept_through,
          productsSweptThrough: row.products_swept_through,
        },
        access: { connectionId: row.id, shopDomain: row.shop_domain, credentials },
      };
    } catch (error) {
      if (error instanceof CredentialsUnreadable) return { skipped: 'CREDENTIALS_UNREADABLE' };
      throw error;
    }
  }
}
