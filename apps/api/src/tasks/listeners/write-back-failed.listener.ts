import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  OutboundCommandFailed,
  OutboundCommandResolved,
  OutboundCommandSynced,
} from '../../connectors/connectors.events.js';
import type { Transaction } from '../../database/sql.js';
import { DomainEvents } from '../../platform/events/domain-events.js';
import { TasksService } from '../tasks.service.js';

/** The dedupe key of the failed write back task of one command (spec 0016 AC-8). */
export function failedKeyOf(commandId: string): string {
  return `outbound_command_failed:${commandId}`;
}

/**
 * The subject key of a sync task: the command kind and the failure code, lower case, in the key
 * shape (`^[a-z0-9:_.-]{1,120}$`), so the stopped commands rule can count by it later. Anything
 * outside the shape becomes `_`; a failure with no code reads `unknown`.
 */
export function subjectKeyOf(kind: string, failureCode: string | null): string {
  return `${kind}:${failureCode ?? 'unknown'}`
    .toLowerCase()
    .replace(/[^a-z0-9:_.-]/g, '_')
    .slice(0, 120);
}

/**
 * Turns the outbound command events into the `sync.write_back_failed` task (spec 0016 AC-8, the
 * first real thread): `OutboundCommandFailed` opens it on the command's linked record, dedupe key
 * `outbound_command_failed:<command id>`, owner hat operations, due now, assigned to the person
 * who queued the command when the event names one and she is active and holds `orders.confirm`
 * (review B1; else it waits unassigned in the queue); `OutboundCommandSynced` and
 * `OutboundCommandResolved` close it with the system outcomes `synced` and `resolved`. Every
 * handler runs in the publisher's transaction and never catches an error, so if a task cannot be
 * opened the command's failure rolls back with it: a failure never exists without its task. It
 * carries ids and codes only, never the command's payload.
 */
@Injectable()
export class WriteBackFailedListener implements OnModuleInit {
  /** Takes the events service and the tasks service. */
  constructor(
    private readonly events: DomainEvents,
    private readonly tasks: TasksService,
  ) {}

  /** Registers the three handlers. */
  onModuleInit(): void {
    this.events.on(OutboundCommandFailed, (tx, event) => this.failed(tx, event), 'tasks');
    this.events.on(OutboundCommandSynced, (tx, event) => this.closed(tx, event, 'synced'), 'tasks');
    this.events.on(
      OutboundCommandResolved,
      (tx, event) => this.closed(tx, event, 'resolved'),
      'tasks',
    );
  }

  /** Opens (or finds) the task of a failed command. */
  async failed(tx: Transaction, event: OutboundCommandFailed): Promise<void> {
    const editor = event.queuedByUserId;
    const assignable =
      editor !== null && (await this.tasks.eligibleFor('sync.write_back_failed', tx)).has(editor);
    await this.tasks.open(tx, {
      type: 'sync.write_back_failed',
      linked: { type: event.linkedType, id: event.linkedId },
      subjectKey: subjectKeyOf(event.kind, event.failureCode),
      dedupeKey: failedKeyOf(event.commandId),
      ...(assignable && editor !== null ? { assigneeId: editor } : {}),
      by: { kind: 'system_job' },
    });
  }

  /** Closes the task of a command that landed or was resolved; nothing when none is open. */
  async closed(
    tx: Transaction,
    event: OutboundCommandSynced | OutboundCommandResolved,
    outcome: 'synced' | 'resolved',
  ): Promise<void> {
    await this.tasks.closeByKey(tx, failedKeyOf(event.commandId), {
      outcome,
      by: { kind: 'system_job' },
    });
  }
}
