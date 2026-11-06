import { auditActionOf, type AuditEntryView } from '@ssdashboard/contracts';
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

/**
 * The catalog key of each record type the audit screen knows. A later feature adds its record
 * type here with its label keys; an unknown type is shown as its code.
 */
const RECORD_TYPE_KEYS: Readonly<Record<string, MessageKey>> = {
  stock_receipt: 'audit.recordTypes.stockReceipt',
};

/** The label key of an action code from the registry, or undefined for a code it does not know. */
export function actionLabelKey(code: string): MessageKey | undefined {
  return auditActionOf(code)?.label;
}

/** The label key of a record type, or undefined for a type the screen does not know. */
export function recordTypeLabelKey(type: string): MessageKey | undefined {
  return RECORD_TYPE_KEYS[type];
}
