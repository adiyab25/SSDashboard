import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  OutboundCommandFailed,
  OutboundCommandQueued,
  OutboundCommandResolved,
  OutboundCommandSynced,
} from '../../connectors/connectors.events.js';
import { ConnectorsService, type OpenCommand } from '../../connectors/connectors.service.js';
import type { Transaction } from '../../database/sql.js';
import { DomainEvents } from '../../platform/events/domain-events.js';
import { OrderWriter } from '../writer/order-writer.js';

/** An order's write back state as its open commands give it (spec 0013 AC-12). */
export function writeBackStateOf(open: readonly OpenCommand[]): 'none' | 'waiting' | 'failed' {
  if (open.some((command) => command.syncState === 'failed')) return 'failed';
  return open.length > 0 ? 'waiting' : 'none';
}

/** The events of a command that is about one record. */
type CommandEvent =
  OutboundCommandQueued | OutboundCommandSynced | OutboundCommandFailed | OutboundCommandResolved;

/**
 * Keeps `orders.write_back_state` equal to the order's open outbound commands (spec 0013 AC-12,
 * spec 0002 A6): on each of the four `OutboundCommand*` events it recomputes the state from
 * `ConnectorsService.openCommandsFor('order', id, tx)` (`failed` if any failed, else `waiting` if
 * any waits, else `none`) under the order row lock (`OrderWriter.projectWriteBackState` locks
 * before the read, so parallel command changes serialize) and writes it through `OrderWriter` in
 * the publisher's transaction. It
 * ignores a command whose `linkedType` is not `order`, never trusts the event alone (it reads the
 * commands again), and never catches an error: a failure rolls the command change back.
 */
@Injectable()
export class WriteBackProjection implements OnModuleInit {
  /** Takes the events service, the connectors reads, and the order writer. */
  constructor(
    private readonly events: DomainEvents,
    private readonly connectors: ConnectorsService,
    private readonly writer: OrderWriter,
  ) {}

  /** Registers the handler on the four outbound command events. */
  onModuleInit(): void {
    const handle = (tx: Transaction, event: CommandEvent) => this.project(tx, event);
    this.events.on(OutboundCommandQueued, handle, 'orders');
    this.events.on(OutboundCommandSynced, handle, 'orders');
    this.events.on(OutboundCommandFailed, handle, 'orders');
    this.events.on(OutboundCommandResolved, handle, 'orders');
  }

  /** Recomputes and writes the write back state of the event's order; ignores other records. */
  async project(tx: Transaction, event: CommandEvent): Promise<void> {
    if (event.linkedType !== 'order') return;
    const orderId = event.linkedId;
    // The writer locks the order row first, then this reads the commands, then it writes.
    await this.writer.projectWriteBackState(tx, orderId, async () =>
      writeBackStateOf(await this.connectors.openCommandsFor('order', orderId, tx)),
    );
  }
}
