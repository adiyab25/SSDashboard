import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { describeError } from '../database/pg-error.js';
import { eventName, type AuthEvent } from '../platform/events/auth-events.js';

/**
 * One structured log line and one domain event for every sign in outcome (spec 0005, AC-23).
 * The line names the actor, the target, the address and the user agent, and nothing else
 * personal: no password, no token, no link, and no email text.
 */
@Injectable()
export class AuthAudit {
  private readonly logger = new Logger('Auth');

  /** Takes the event emitter that carries sign in events to any other module listening. */
  constructor(private readonly events: EventEmitter2) {}

  /**
   * Logs the outcome and emits it as a domain event. Never throws: a failing listener is logged
   * by its pg code and the sign in carries on.
   */
  record(event: AuthEvent): void {
    const { context } = event;
    this.logger.log(
      JSON.stringify({
        event: eventName(event),
        actorId: context.actorId,
        targetId: context.targetId,
        ip: context.ip,
        userAgent: context.userAgent,
        at: context.at.toISOString(),
        ...('reason' in event ? { reason: event.reason } : {}),
        ...('scope' in event ? { scope: event.scope } : {}),
      }),
    );
    // A listener that throws must never fail a sign in.
    try {
      this.events.emit(eventName(event), event);
    } catch (error) {
      // A listener that queried the database may throw a failed query: its pg code only.
      this.logger.error(`A ${eventName(event)} listener failed: ${describeError(error)}`);
    }
  }
}
