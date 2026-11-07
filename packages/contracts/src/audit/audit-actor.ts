import { z } from 'zod';

/**
 * The six kinds of actor an audit entry can name (spec 0010, AC-3). The same list is the
 * `audit_actor_kind` check of `audit_entries`; keep both in step in one change.
 */
export const AuditActorKind = z.enum([
  'person',
  'partner_user',
  'system_job',
  'carrier',
  'import',
  'portal_customer',
]);
/** One actor kind. */
export type AuditActorKind = z.infer<typeof AuditActorKind>;

/**
 * Who acted (spec 0010, "Who acts, and how a module writes"): a staff person under a hat, a
 * partner user for a partner account, a scheduled job, a carrier connection, an import run, or a
 * customer through a signed link. Built by server code from the session, the job, the connection,
 * or the verified link, never from a request body. The table check `audit_actor_shape` refuses
 * any other shape.
 */
export const AuditActor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('person'), userId: z.uuid(), hat: z.string().min(1).max(64) }),
  z.object({
    kind: z.literal('partner_user'),
    userId: z.uuid(),
    partnerAccountId: z.string().min(1).max(200),
  }),
  z.object({ kind: z.literal('system_job'), name: z.string().min(1).max(200), jobId: z.uuid() }),
  z.object({ kind: z.literal('carrier'), connectionCode: z.string().min(1).max(200) }),
  z.object({ kind: z.literal('import'), runId: z.string().min(1).max(200) }),
  z.object({ kind: z.literal('portal_customer'), customerId: z.string().min(1).max(200) }),
]);
/** One actor, as the audit module's writer takes it. */
export type AuditActor = z.infer<typeof AuditActor>;

/**
 * A staff person acting under a hat (spec 0010, AC-3), built from the session. Validates the
 * shape and throws a `ZodError` on a malformed id or an empty hat, so a wrong actor fails in the
 * caller's code, before the table check.
 */
export function personActor(userId: string, hat: string): AuditActor {
  return AuditActor.parse({ kind: 'person', userId, hat });
}

/** A partner user acting for the partner account on their own hat row (spec 0008, AC-9). */
export function partnerUserActor(userId: string, partnerAccountId: string): AuditActor {
  return AuditActor.parse({ kind: 'partner_user', userId, partnerAccountId });
}

/** A scheduled or queued job: its name and its pg-boss job id. */
export function systemJobActor(name: string, jobId: string): AuditActor {
  return AuditActor.parse({ kind: 'system_job', name, jobId });
}

/** A carrier acting through its connection (for example a Bosta status feed). */
export function carrierActor(connectionCode: string): AuditActor {
  return AuditActor.parse({ kind: 'carrier', connectionCode });
}

/** An import run (a file or a connector backfill). */
export function importActor(runId: string): AuditActor {
  return AuditActor.parse({ kind: 'import', runId });
}

/** A customer acting through a verified signed link (the portal). */
export function portalCustomerActor(customerId: string): AuditActor {
  return AuditActor.parse({ kind: 'portal_customer', customerId });
}
