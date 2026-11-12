import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../../database/database.module.js';
import { JobSender } from '../../platform/jobs/job-sender.js';
import { ModuleStateService } from '../../platform/modules/module-state.service.js';
import {
  connectionGroup,
  CONNECTOR_SHOPIFY_QUEUE,
  INBOX_JOB_PRIORITY,
  type ShopifyJobData,
} from '../shopify/connector-shopify.queue.js';
import { minimizeShopifyWebhook, topicIsProcessed } from './shopify-hook-payload.js';

/** The capability that owns the Shopify hook route and its queue (spec 0015, settings rows). */
const HOOK_CAPABILITY = 'connectors.shopify.sync';

/** `last_inbound_at` moves at most this often per connection (Inbound processing item 1). */
const LAST_INBOUND_EVERY = sql`interval '30 seconds'`;

/** A verified delivery's headers and parsed body. */
export interface VerifiedShopifyDelivery {
  /** The connection the verifier proved. */
  readonly connectionId: string;
  /** `X-Shopify-Topic`, for example `orders/create`. */
  readonly topic: string;
  /** `X-Shopify-Webhook-Id`, the dedupe key. */
  readonly webhookId: string;
  /** The body, parsed only after the signature passed. */
  readonly body: unknown;
}

/** What recording a delivery did: a new row, or a repeat (or an unknown topic) that added none. */
export type HookRecordOutcome = 'recorded' | 'repeat' | 'unknown_topic';

/**
 * Records one verified Shopify delivery in the durable inbox (spec 0015 AC-5, AC-6): asks
 * `ModuleStateService.acceptsHook` (always `process` for this core capability today; a row is
 * recorded `ignored_unlicensed` when told otherwise), then in one transaction inserts the
 * `inbound_events` row with its minimized payload (dedupe on `X-Shopify-Webhook-Id`,
 * `ON CONFLICT DO NOTHING`) and, for a new row of a topic the inbox processes (the four order
 * topics and `app/uninstalled`, lead decision D9, and the two customer topics, task 11), sends its
 * `inbox` job through the same transaction. Every other topic is recorded and waits `received`
 * for its later task. A paused
 * connection still records (its job leaves the event `received`; resume is task 16).
 * `last_inbound_at` moves at most every 30 seconds per connection.
 *
 * Never stores, logs, or sends in job data any part of the body beyond the minimized payload.
 */
@Injectable()
export class ShopifyHooksService {
  private readonly logger = new Logger('ShopifyHook');

  /** Takes the database, the job sender, and the module states. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(JobSender) private readonly jobs: JobSender,
    @Inject(ModuleStateService) private readonly modules: ModuleStateService,
  ) {}

  /** Records one delivery (see the class); a repeat answers `repeat` and adds nothing. */
  async record(delivery: VerifiedShopifyDelivery): Promise<HookRecordOutcome> {
    const minimized = minimizeShopifyWebhook(delivery.topic, delivery.body);
    if (minimized.subjectType === null) {
      this.logger.warn(`hook connection=${delivery.connectionId} unknown_topic`);
      return 'unknown_topic';
    }
    const decision = await this.modules.acceptsHook(HOOK_CAPABILITY);
    const status = decision === 'process' ? 'received' : 'ignored_unlicensed';
    const sendJob = status === 'received' && topicIsProcessed(delivery.topic);
    if (sendJob) await this.jobs.prepare(CONNECTOR_SHOPIFY_QUEUE);
    return this.connection.db.transaction(async (tx) => {
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO inbound_events (connection_id, source, topic, dedupe_key, subject_type,
                                    subject_external_id, subject_version, payload, status,
                                    processed_at)
        VALUES (${delivery.connectionId}::uuid, 'webhook', ${delivery.topic},
                ${delivery.webhookId}, ${minimized.subjectType}::inbound_subject,
                ${minimized.subjectExternalId}, ${minimized.subjectVersion}::timestamptz,
                ${JSON.stringify(minimized.payload)}::jsonb, ${status}::inbound_status,
                CASE WHEN ${status} = 'received' THEN NULL ELSE now() END)
        ON CONFLICT ON CONSTRAINT inbound_events_dedupe_unique DO NOTHING
        RETURNING id`);
      const eventId = inserted.rows[0]?.id;
      if (!eventId) return 'repeat';
      if (sendJob) {
        const data: ShopifyJobData = {
          kind: 'inbox',
          connectionId: delivery.connectionId,
          eventId,
        };
        await this.jobs.sendIn(tx, CONNECTOR_SHOPIFY_QUEUE, data, {
          ...connectionGroup(delivery.connectionId),
          priority: INBOX_JOB_PRIORITY,
        });
      }
      await tx.execute(sql`
        UPDATE connections SET last_inbound_at = now()
        WHERE id = ${delivery.connectionId}::uuid
          AND (last_inbound_at IS NULL OR last_inbound_at <= now() - ${LAST_INBOUND_EVERY})`);
      return 'recorded';
    });
  }
}
