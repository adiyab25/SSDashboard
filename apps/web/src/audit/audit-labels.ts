import { auditActionOf, auditRecordTypeOf, type AuditEntryView } from '@ssdashboard/contracts';
import type { MessageKey } from '@ssdashboard/i18n';

/** The catalog key of each actor kind a system or outside actor shows as. */
export const ACTOR_KIND_KEYS = {
  person: 'audit.actorKinds.person',
  partner_user: 'audit.actorKinds.partnerUser',
  system_job: 'audit.actorKinds.systemJob',
  carrier: 'audit.actorKinds.carrier',
  import: 'audit.actorKinds.import',
  portal_customer: 'audit.actorKinds.portalCustomer',
} as const satisfies Record<AuditEntryView['actor']['kind'], MessageKey>;

/** The label key of an action code from the registry, or undefined for a code it does not know. */
export function actionLabelKey(code: string): MessageKey | undefined {
  return auditActionOf(code)?.label;
}

/** The label key of a record type from the registry, or undefined for a type it does not know. */
export function recordTypeLabelKey(type: string): MessageKey | undefined {
  return auditRecordTypeOf(type)?.label;
}
