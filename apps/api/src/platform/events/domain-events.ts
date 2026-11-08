import { Injectable } from '@nestjs/common';
import type { Transaction } from '../../database/sql.js';

/** The class of an event: handlers are registered and found by it. */
export type DomainEventClass<E extends object> = abstract new (...args: never[]) => E;

/**
 * A handler of one event. It receives the publisher's own transaction, so what it writes commits
 * or rolls back with the change that published the event.
 */
export type DomainEventHandler<E extends object> = (
  tx: Transaction,
  event: E,
) => void | Promise<void>;

interface Registered {
  owner: string;
  run: (tx: Transaction, event: object) => void | Promise<void>;
}

/**
 * In transaction domain events (spec 0002 A6, built by spec 0013): a module that changes a fact
 * other modules mirror announces it with `publish(tx, event)` inside its own transaction, and
 * every registered handler runs, one after another in registration order and awaited, before the
 * publisher commits. A handler that throws stops the rest and the error reaches the publisher, so
 * the whole change rolls back: a mirror can never be left stale by a swallowed failure.
 *
 * Handlers register once from `onModuleInit` of the module that owns the projection, naming
 * themselves in `owner`. Registration order follows Nest's module init order, which is fixed by
 * the import graph, so the order is the same in every process. It must never swallow a handler's
 * error, run a handler outside the publisher's transaction, or open a transaction of its own.
 *
 * A handler runs on the publisher's connection, so a database error it catches leaves that
 * transaction aborted (PostgreSQL refuses every later statement): it must not catch one unless it
 * wrapped the statement in a savepoint (`tx.transaction`) and rolled that back. Rethrow instead.
 */
@Injectable()
export class DomainEvents {
  private readonly handlers = new Map<abstract new (...args: never[]) => object, Registered[]>();

  /**
   * Registers `handler` for events of `eventClass`. `owner` names the registering module for
   * diagnostics. The same owner may register more than one handler; they run in registration order.
   */
  on<E extends object>(
    eventClass: DomainEventClass<E>,
    handler: DomainEventHandler<E>,
    owner: string,
  ): void {
    const list = this.handlers.get(eventClass) ?? [];
    list.push({ owner, run: (tx, event) => handler(tx, event as E) });
    this.handlers.set(eventClass, list);
  }

  /**
   * Calls every handler registered for the class of `event` with `tx`, in registration order,
   * awaiting each. Resolves when all have run; rejects with the first handler's error, leaving the
   * later handlers uncalled. An event nobody listens to is a no op. Never commits or rolls back.
   */
  async publish<E extends object>(tx: Transaction, event: E): Promise<void> {
    const list = this.handlers.get(event.constructor as abstract new (...args: never[]) => object);
    if (!list) return;
    for (const handler of list) await handler.run(tx, event);
  }

  /** The owners registered for an event class, in the order they run (for tests and diagnostics). */
  ownersOf(eventClass: DomainEventClass<object>): string[] {
    return (this.handlers.get(eventClass) ?? []).map((handler) => handler.owner);
  }
}
