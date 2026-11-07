import { Inject, Injectable } from '@nestjs/common';
import type { LocalizedText } from '@ssdashboard/contracts';
import { sql, type DatabaseConnection, type schema } from '@ssdashboard/db';
import { DATABASE } from '../database/database.module.js';
import { pgArray, type Executor, type Transaction } from '../database/sql.js';
import { ChannelsError } from './channels.errors.js';
import type { ConnectionStoreSource } from './connection-store-source.js';

/** What kind of store: one per Shopify connection, or an internal store. Matches `stores.kind`. */
export type StoreKind = (typeof schema.storeKind.enumValues)[number];

/** How an order arrived (the `channel_kind` enum, which the database schema owns). Matches `channels.kind`. */
export type ChannelKind = (typeof schema.channelKind.enumValues)[number];

/** A store as other modules may see it. */
export interface StoreView {
  /** The store's id. */
  id: string;
  /** The store code, unique per install (`MAIN`, a Shopify store's code). */
  code: string;
  /** The store's name for staff. */
  name: LocalizedText;
  /** The name the customer portal shows when a phone and order number match in two stores. */
  publicName: LocalizedText;
  /** Internal or Shopify. */
  kind: StoreKind;
  /** True once archived (still readable: orders keep pointing at what they were made in). */
  archived: boolean;
}

/** A channel as other modules may see it. */
export interface ChannelView {
  /** The channel's id. */
  id: string;
  /** The channel code, unique per install (`manual`, a Shopify store's code). */
  code: string;
  /** The channel's name. */
  name: LocalizedText;
  /** How orders on this channel arrive. */
  kind: ChannelKind;
  /** The store an order on this channel goes to when nothing else decides it. */
  defaultStoreId: string | null;
  /** True once archived. */
  archived: boolean;
}

/** The label of the store a connection belongs to (spec 0015, used by the customer profile). */
export interface StoreLabel {
  /** The connection's id. */
  connectionId: string;
  /** The connection's store. */
  storeId: string;
  /** The store code. */
  storeCode: string;
  /** The store's name in both languages. */
  storeName: LocalizedText;
}

/** What `createShopifyStore` needs. */
export interface CreateShopifyStoreInput {
  /** The store code; also the code of the store's own channel. */
  code: string;
  /** The store's name; also the channel's name. At least one language. */
  name: LocalizedText;
  /** The portal name; defaults to `name`. */
  publicName?: LocalizedText;
}

/** The ids `createShopifyStore` made. */
export interface CreatedShopifyStore {
  /** The new store (kind `shopify`). */
  storeId: string;
  /** Its own channel (kind `shopify`, default store this store). */
  channelId: string;
}

interface StoreRow extends Record<string, unknown> {
  id: string;
  code: string;
  name: LocalizedText;
  public_name: LocalizedText;
  kind: StoreKind;
  archived: boolean;
}

interface ChannelRow extends Record<string, unknown> {
  id: string;
  code: string;
  name: LocalizedText;
  kind: ChannelKind;
  default_store_id: string | null;
  archived: boolean;
}

/** The shape of a store code: upper case letters and digits, with `_` and `-` inside, at most 32 characters. */
const STORE_CODE = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;

/** Trims both languages and keeps only `en` and `ar`; a name with neither throws `INVALID_STORE_INPUT`. */
function cleanName(name: LocalizedText, what: string): LocalizedText {
  const cleaned: LocalizedText = {};
  const en = typeof name.en === 'string' ? name.en.trim() : '';
  const ar = typeof name.ar === 'string' ? name.ar.trim() : '';
  if (en !== '') cleaned.en = en;
  if (ar !== '') cleaned.ar = ar;
  if (en === '' && ar === '') {
    throw new ChannelsError('INVALID_STORE_INPUT', `${what} needs a name in at least one language`);
  }
  return cleaned;
}

function codeTaken(code: string): ChannelsError {
  return new ChannelsError('STORE_CODE_TAKEN', `The store code ${code} is already in use`);
}

function toStoreView(row: StoreRow): StoreView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    publicName: row.public_name,
    kind: row.kind,
    archived: row.archived,
  };
}

function toChannelView(row: ChannelRow): ChannelView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    defaultStoreId: row.default_store_id,
    archived: row.archived,
  };
}

/** Orders by store code, then connection id, byte wise like `COLLATE "C"`. */
function compareLabels(a: StoreLabel, b: StoreLabel): number {
  if (a.storeCode !== b.storeCode) return a.storeCode < b.storeCode ? -1 : 1;
  if (a.connectionId !== b.connectionId) return a.connectionId < b.connectionId ? -1 : 1;
  return 0;
}

/**
 * The stores (where an order is numbered and priced) and channels (how it arrived) of the brand
 * (spec 0015 task 2, spec 0002 orders child). It is the only module that reads or writes `stores`
 * and `channels`: orders (spec 0013), the customer profile (spec 0014) and connectors ask here by
 * id, never by table.
 *
 * Lists never return an archived store or channel, but `stores(ids)` and `channels(ids)` do answer
 * archived ones, because an order keeps pointing at what it was made in. The only writes are
 * `createShopifyStore` and `renameStore`, for the connectors module, inside the caller's
 * transaction. It must never
 * write a connection, never delete a store or channel, and never read `connections` (connectors
 * registers a `ConnectionStoreSource` for that).
 */
@Injectable()
export class ChannelsService {
  private connectionStores: ConnectionStoreSource | undefined;

  /** Takes the app database connection. */
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /**
   * Lets the connectors module say which store a connection belongs to, so
   * `storeLabelsByConnection` can answer without reading `connections`. Called once, from the
   * registering module's `onModuleInit`; a second registration throws
   * `CONNECTION_STORES_ALREADY_REGISTERED`.
   */
  registerConnectionStores(source: ConnectionStoreSource): void {
    if (this.connectionStores) {
      throw new ChannelsError(
        'CONNECTION_STORES_ALREADY_REGISTERED',
        'A connection store source is already registered',
      );
    }
    this.connectionStores = source;
  }

  /**
   * The stores with these ids, archived ones included, ordered by code. Unknown ids are left out.
   * Pass the caller's transaction to read in its snapshot.
   */
  async stores(
    ids: readonly string[],
    executor: Executor = this.connection.db,
  ): Promise<StoreView[]> {
    if (ids.length === 0) return [];
    const { rows } = await executor.execute<StoreRow>(sql`
      SELECT id, code, name, public_name, kind, archived_at IS NOT NULL AS archived
      FROM stores
      WHERE id = ANY(${pgArray(ids)}::uuid[])
      ORDER BY code COLLATE "C", id`);
    return rows.map(toStoreView);
  }

  /**
   * The channels with these ids, archived ones included, ordered by code, with their default
   * store. Unknown ids are left out.
   */
  async channels(
    ids: readonly string[],
    executor: Executor = this.connection.db,
  ): Promise<ChannelView[]> {
    if (ids.length === 0) return [];
    const { rows } = await executor.execute<ChannelRow>(sql`
      SELECT id, code, name, kind, default_store_id, archived_at IS NOT NULL AS archived
      FROM channels
      WHERE id = ANY(${pgArray(ids)}::uuid[])
      ORDER BY code COLLATE "C", id`);
    return rows.map(toChannelView);
  }

  /** The stores that are not archived (of one kind when asked), ordered by code, for forms. */
  async listStores(
    filter: { kind?: StoreKind } = {},
    executor: Executor = this.connection.db,
  ): Promise<StoreView[]> {
    const kind = filter.kind ? sql`AND kind = ${filter.kind}::store_kind` : sql``;
    const { rows } = await executor.execute<StoreRow>(sql`
      SELECT id, code, name, public_name, kind, false AS archived
      FROM stores
      WHERE archived_at IS NULL ${kind}
      ORDER BY code COLLATE "C", id`);
    return rows.map(toStoreView);
  }

  /**
   * The channels that are not archived (of the given kinds when asked; an empty list of kinds
   * answers nothing), ordered by code, for forms.
   */
  async listChannels(
    filter: { kinds?: readonly ChannelKind[] } = {},
    executor: Executor = this.connection.db,
  ): Promise<ChannelView[]> {
    if (filter.kinds && filter.kinds.length === 0) return [];
    const kinds = filter.kinds
      ? sql`AND kind = ANY(${pgArray(filter.kinds)}::channel_kind[])`
      : sql``;
    const { rows } = await executor.execute<ChannelRow>(sql`
      SELECT id, code, name, kind, default_store_id, false AS archived
      FROM channels
      WHERE archived_at IS NULL ${kinds}
      ORDER BY code COLLATE "C", id`);
    return rows.map(toChannelView);
  }

  /**
   * For each given connection id that has a store, one label (connection id, store id, store
   * code, store name), ordered by store code then connection id (a connection no one knows is left
   * out). The store of a connection comes from the connectors module's registered source, so this
   * module never reads `connections`; without a registered source it throws
   * `CONNECTION_STORES_NOT_REGISTERED` rather than answer an empty list that looks true.
   */
  async storeLabelsByConnection(
    connectionIds: readonly string[],
    executor: Executor = this.connection.db,
  ): Promise<StoreLabel[]> {
    if (connectionIds.length === 0) return [];
    const source = this.connectionStores;
    if (!source) {
      throw new ChannelsError(
        'CONNECTION_STORES_NOT_REGISTERED',
        'The connectors module has not registered its connection store source',
      );
    }
    const requested = new Set(connectionIds);
    const bound = (await source.storeIdsByConnection(connectionIds, executor)).filter((row) =>
      requested.has(row.connectionId),
    );
    const stores = new Map(
      (await this.stores([...new Set(bound.map((row) => row.storeId))], executor)).map((store) => [
        store.id,
        store,
      ]),
    );
    const labels: StoreLabel[] = [];
    for (const row of bound) {
      const store = stores.get(row.storeId);
      if (store) {
        labels.push({
          connectionId: row.connectionId,
          storeId: store.id,
          storeCode: store.code,
          storeName: store.name,
        });
      }
    }
    return labels.sort(compareLabels);
  }

  /**
   * Creates a Shopify store and its own channel in the caller's transaction (spec 0015 AC-1): the
   * store has kind `shopify`; the channel has kind `shopify`, the same code, the same name, and
   * this store as its default. Only the connectors module calls it, from the connect route's
   * transaction together with the connection insert.
   *
   * A code already used by any store or any channel throws `STORE_CODE_TAKEN` (codes are unique
   * per table, and a Shopify store's channel shares its store's code). Both inserts skip a clash
   * instead of failing, so a refusal leaves the transaction usable, but the caller must still
   * roll back: a half made store is never kept. A code that is not 1 to 32 upper case letters, digits, `_` or `-`, or a name with no
   * language, throws `INVALID_STORE_INPUT`. Names are trimmed and only `en` and `ar` are stored.
   */
  async createShopifyStore(
    tx: Transaction,
    input: CreateShopifyStoreInput,
  ): Promise<CreatedShopifyStore> {
    const code = input.code.trim();
    if (!STORE_CODE.test(code)) {
      throw new ChannelsError(
        'INVALID_STORE_INPUT',
        'A store code is 1 to 32 upper case letters, digits, underscores or hyphens, starting with a letter or digit',
      );
    }
    const name = cleanName(input.name, 'A store');
    const publicName = cleanName(input.publicName ?? input.name, 'A store public name');

    const store = await tx.execute<{ id: string }>(sql`
      INSERT INTO stores (code, name, public_name, kind)
      VALUES (${code}, ${JSON.stringify(name)}::jsonb, ${JSON.stringify(publicName)}::jsonb, 'shopify')
      ON CONFLICT ON CONSTRAINT stores_code_unique DO NOTHING
      RETURNING id`);
    const storeId = store.rows[0]?.id;
    if (!storeId) throw codeTaken(code);

    const channel = await tx.execute<{ id: string }>(sql`
      INSERT INTO channels (code, name, kind, default_store_id)
      VALUES (${code}, ${JSON.stringify(name)}::jsonb, 'shopify', ${storeId}::uuid)
      ON CONFLICT ON CONSTRAINT channels_code_unique DO NOTHING
      RETURNING id`);
    const channelId = channel.rows[0]?.id;
    if (!channelId) throw codeTaken(code);

    return { storeId, channelId };
  }

  /**
   * Sets the names of a Shopify store in the caller's transaction (spec 0015 AC-1: the connect job
   * fills the names from the shop name, editable after). `publicName` defaults to `name`; the
   * store's own channel (same code, kind `shopify`) takes the same name, as at creation. Same name
   * rules as `createShopifyStore`. An unknown store, or one that is not a Shopify store (the
   * internal `MAIN` is never renamed here), throws `STORE_NOT_FOUND`. The code never changes.
   */
  async renameStore(
    tx: Transaction,
    storeId: string,
    names: { name: LocalizedText; publicName?: LocalizedText },
  ): Promise<void> {
    const name = cleanName(names.name, 'A store');
    const publicName = cleanName(names.publicName ?? names.name, 'A store public name');
    const updated = await tx.execute<{ code: string }>(sql`
      UPDATE stores
      SET name = ${JSON.stringify(name)}::jsonb,
          public_name = ${JSON.stringify(publicName)}::jsonb,
          updated_at = now()
      WHERE id = ${storeId}::uuid AND kind = 'shopify'
      RETURNING code`);
    const code = updated.rows[0]?.code;
    if (code === undefined) {
      throw new ChannelsError('STORE_NOT_FOUND', 'No Shopify store has that id');
    }
    await tx.execute(sql`
      UPDATE channels
      SET name = ${JSON.stringify(name)}::jsonb, updated_at = now()
      WHERE code = ${code} AND kind = 'shopify' AND default_store_id = ${storeId}::uuid`);
  }
}
