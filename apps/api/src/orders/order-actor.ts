import {
  carrierActor,
  personActor,
  systemJobActor,
  type AuditActor,
  type OrderActorType,
} from '@ssdashboard/contracts';

/**
 * Who moves an order (spec 0013, Write paths): a person (with the hat they act under, for the
 * audit trail), the carrier's connection, a system job, or an import run. The shapes match
 * `order_events.actor_type` and the spec 0010 actors.
 */
export type OrderActor =
  | { type: 'person'; userId: string; hat: string }
  | { type: 'carrier'; connectionId: string }
  | { type: 'system_job'; job: string; jobId: string }
  | { type: 'import'; runId: string };

/** The `order_events.actor_type` of an actor. */
export function actorTypeOf(actor: OrderActor): OrderActorType {
  return actor.type;
}

/** The `order_events.actor_id` of an actor: the person's user id, else null. */
export function actorIdOf(actor: OrderActor): string | null {
  return actor.type === 'person' ? actor.userId : null;
}

/**
 * The spec 0010 audit actor of a person, a system job, or a carrier (the carrier's connection id
 * names it: the partial delivery split a carrier reports writes `order.partial_delivery_split`,
 * spec 0013 AC-16). An import writes no audit entry here and throws.
 */
export function auditActorOf(actor: OrderActor): AuditActor {
  switch (actor.type) {
    case 'person':
      return personActor(actor.userId, actor.hat);
    case 'system_job':
      return systemJobActor(actor.job, actor.jobId);
    case 'carrier':
      return carrierActor(actor.connectionId);
    case 'import':
      throw new Error(
        `An order audit entry is written for a person, a system job, or a carrier, not an ${actor.type}`,
      );
  }
}
