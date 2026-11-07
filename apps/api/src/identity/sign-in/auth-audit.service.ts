import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { describeError } from '../../database/pg-error.js';
import {
  eventName,
  type AuthEvent,
  type AuthEventContext,
  type HatsChanged,
} from '../../platform/events/auth-events.js';
import type { HatChangeLogLine } from '../sessions/hat-change-log.js';

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
        ...('hats' in event ? { hats: event.hats, costView: event.costView } : {}),
        ...('partnerAccountId' in event ? { partnerAccountId: event.partnerAccountId } : {}),
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

  /**
   * Writes the log line of a hat change (spec 0005, AC-33 e), built by `hatChangeLogLine` so it
   * holds ids, address, user agent, time, hat names and, when given, the `before` and `after`
   * holdings and the reason (spec 0008, AC-13), and emits the `HatsChanged` event when one is
   * given. `HatService` calls it once per change, after the commit and never before. It writes
   * only the line's named fields, as `record` does, so an object wider than the line can never
   * log more; the logger's redaction (`ROW_MARKER_RULES` in `packages/config/src/redaction.ts`)
   * then hides the manager's free text `reason` on this line. Never throws: a failing listener is
   * logged by its pg code and the change stands.
   */
  hatsChanged(line: HatChangeLogLine, event?: HatsChanged): void {
    const holding = (value: HatChangeLogLine['before']) =>
      value && {
        hats: value.hats,
        costView: value.costView,
        partnerAccountId: value.partnerAccountId,
      };
    this.logger.log(
      JSON.stringify({
        event: line.event,
        actorId: line.actorId,
        targetId: line.targetId,
        ip: line.ip,
        userAgent: line.userAgent,
        at: line.at,
        hatsAdded: line.hatsAdded,
        hatsRemoved: line.hatsRemoved,
        ...(line.before && { before: holding(line.before) }),
        ...(line.after && { after: holding(line.after) }),
        ...(line.reason !== undefined && { reason: line.reason }),
      }),
    );
    if (!event) return;
    // A listener that throws must never fail a change that has already committed.
    try {
      this.events.emit('HatsChanged', event);
    } catch (error) {
      this.logger.error(`A HatsChanged listener failed: ${describeError(error)}`);
    }
  }

  /**
   * Logs a current password or second factor code that was turned away with no free slot (spec
   * 0005, AC-3) on a route where it is not a sign in: changing the password, the two factor
   * routes, or confirming a first code. AC-23 names no event for this, so it writes only the log
   * line, in the same shape as `record` (ids, address, user agent, time; never the email), and
   * emits nothing. A turned away sign in, or a code for a pending sign in, goes through `record`
   * as `SignInFailed` with reason `locked` instead.
   */
  turnedAway(route: string, context: AuthEventContext, locked: boolean): void {
    this.logger.log(
      JSON.stringify({
        outcome: 'turned_away',
        route,
        actorId: context.actorId,
        targetId: context.targetId,
        ip: context.ip,
        userAgent: context.userAgent,
        at: context.at.toISOString(),
        locked,
      }),
    );
  }
}
