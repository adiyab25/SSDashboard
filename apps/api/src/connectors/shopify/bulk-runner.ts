import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { BulkObjectGrouper, type BulkObject } from './bulk-jsonl.js';
import { ConnectorBudget } from './connector-budget.js';
import { ConnectorClock } from './connector-clock.js';
import {
  ShopifyClient,
  ShopifyTransientError,
  type ShopifyConnectionAccess,
} from './shopify-client.js';
import {
  BULK_OPERATION_EXPECTED_COST,
  BULK_OPERATION_READ,
  BULK_OPERATION_READ_OPERATION,
  BULK_OPERATION_RUN_QUERY,
  BULK_OPERATION_RUN_QUERY_OPERATION,
} from './shopify-queries.js';
import { StorableShopifyId } from './storable-text.js';

/** A code shape safe to keep: upper case letters, digits, and underscores. */
const CODE_SHAPE = /^[A-Z][A-Z0-9_]{0,63}$/;

const RunAnswer = z.object({
  bulkOperationRunQuery: z.object({
    // The operation id is stored in the run's position (`StorableShopifyId`).
    bulkOperation: z.object({ id: StorableShopifyId.max(200) }).nullable(),
    userErrors: z.array(z.object({ code: z.string().nullish() })),
  }),
});

const ReadAnswer = z.object({
  bulkOperation: z
    .object({
      id: z.string(),
      status: z.string(),
      errorCode: z.string().nullish(),
      objectCount: z.union([z.string(), z.number()]).nullish(),
      url: z.string().nullish(),
    })
    .nullable(),
});

/** Where a bulk read stands: its operation (null before it started) and the next JSONL line. */
export interface BulkPosition {
  readonly bulkId: string | null;
  readonly line: number;
}

/**
 * What one bulk chunk did: `wait` (the operation is still running: poll again later), `more` (the
 * chunk's budget ran out mid file: the next chunk starts at `position.line`), `done` (every object
 * was handed over), `refused` (Shopify refused the query, with the user error codes), or `failed`
 * (the operation failed or was cancelled, with its code).
 */
export type BulkStep =
  | { readonly kind: 'wait'; readonly position: BulkPosition }
  | { readonly kind: 'more'; readonly position: BulkPosition }
  | { readonly kind: 'done'; readonly position: BulkPosition }
  | { readonly kind: 'refused'; readonly codes: readonly string[] }
  | { readonly kind: 'failed'; readonly code: string };

/** Parses an answer; a shape Shopify did not promise is a transient `INVALID_RESPONSE`. */
function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const parsed = schema.safeParse(data);
  // The zod error is dropped on purpose: its issues could quote a value from the answer.
  if (!parsed.success) throw new ShopifyTransientError('INVALID_RESPONSE');
  return parsed.data;
}

/** A Shopify code as an upper case code (`ACCESS_DENIED`), or the fallback. */
function codeOf(value: string | null | undefined, fallback: string): string {
  const code = (value ?? '').toUpperCase();
  return CODE_SHAPE.test(code) ? code : fallback;
}

/**
 * Runs one chunk of a Shopify bulk read (spec 0015 AC-17, *Backfill, go live, and sweeps*; the
 * gateway scan and both backfill phases): starts the bulk query when the position has none
 * (`bulkOperationRunQuery`), else reads the operation (`bulkOperation(id:)`), and once it is
 * `COMPLETED` streams its JSONL result from the position's line through `ShopifyClient`, handing
 * each whole object (`BulkObjectGrouper`) to `onObject`. After each object it checks the chunk's
 * budget (`ConnectorBudget`, `ConnectorClock`): out of time, it stops before the next object and
 * answers its first line, so the next chunk resumes there with no object handled twice. At least
 * one object is handled per chunk. The result address is read again by every chunk and never
 * stored, logged, or returned; no line of the file is kept. Shopify errors pass through typed.
 */
@Injectable()
export class BulkRunner {
  /** Takes the Shopify client, the clock, and the chunk budget. */
  constructor(
    @Inject(ShopifyClient) private readonly shopify: ShopifyClient,
    @Inject(ConnectorClock) private readonly clock: ConnectorClock,
    @Inject(ConnectorBudget) private readonly budget: ConnectorBudget,
  ) {}

  /**
   * One chunk (see the class). `cost` collects the points the calls spent. `onObject` runs one
   * object; a throw of it stops the chunk and passes through (the caller's crash path).
   */
  async step(
    access: ShopifyConnectionAccess,
    position: BulkPosition,
    query: string,
    onObject: (object: BulkObject) => Promise<void>,
    cost: { points: number },
  ): Promise<BulkStep> {
    const deadline = this.clock.now().getTime() + this.budget.chunkMillis;
    if (position.bulkId === null) {
      const answer = await this.shopify.request(access, {
        operationName: BULK_OPERATION_RUN_QUERY_OPERATION,
        query: BULK_OPERATION_RUN_QUERY,
        variables: { query },
        expectedCost: BULK_OPERATION_EXPECTED_COST,
      });
      cost.points += answer.cost?.actualQueryCost ?? 0;
      const run = parse(RunAnswer, answer.data).bulkOperationRunQuery;
      if (run.userErrors.length > 0 || !run.bulkOperation) {
        return {
          kind: 'refused',
          codes: run.userErrors.map((error) => codeOf(error.code, 'USER_ERROR')),
        };
      }
      return { kind: 'wait', position: { bulkId: run.bulkOperation.id, line: 0 } };
    }

    const answer = await this.shopify.request(access, {
      operationName: BULK_OPERATION_READ_OPERATION,
      query: BULK_OPERATION_READ,
      variables: { id: position.bulkId },
      expectedCost: BULK_OPERATION_EXPECTED_COST,
    });
    cost.points += answer.cost?.actualQueryCost ?? 0;
    const operation = parse(ReadAnswer, answer.data).bulkOperation;
    if (!operation) return { kind: 'failed', code: 'BULK_OPERATION_NOT_FOUND' };
    switch (operation.status) {
      case 'CREATED':
      case 'RUNNING':
        return { kind: 'wait', position };
      case 'COMPLETED':
        break;
      case 'FAILED':
        return { kind: 'failed', code: codeOf(operation.errorCode, 'BULK_OPERATION_FAILED') };
      default:
        // CANCELED, CANCELING, EXPIRED, or a status this release does not know.
        return { kind: 'failed', code: `BULK_${codeOf(operation.status, 'UNKNOWN')}`.slice(0, 64) };
    }
    if (!operation.url) return { kind: 'done', position };

    const grouper = new BulkObjectGrouper();
    const stop: { at: number | null } = { at: null };
    const ended = await this.shopify.streamBulkResult(
      operation.url,
      position.line,
      async (line, index) => {
        const object = grouper.push(line, index);
        if (!object) return 'next';
        await onObject(object);
        if (this.clock.now().getTime() >= deadline) {
          // The line that began the next object is not consumed: the next chunk starts on it.
          stop.at = index;
          return 'stop';
        }
        return 'next';
      },
    );
    if (!ended.ended && stop.at !== null) {
      return { kind: 'more', position: { bulkId: position.bulkId, line: stop.at } };
    }
    const last = grouper.end();
    if (last) await onObject(last);
    return { kind: 'done', position: { bulkId: position.bulkId, line: ended.lines } };
  }
}
