import type { MessageKey } from '@ssdashboard/i18n';

/** Whether an action needs a typed reason (spec 0010, AC-5). */
export type AuditReasonPolicy = 'required' | 'optional';

/**
 * One action code in the registry (spec 0010, AC-10). `label` is a key into the English and
 * Arabic catalogs of `@ssdashboard/i18n` (the parity test there needs both languages), never
 * display text. `proof` is the repo path of the test that shows the action writes its entry.
 */
export interface AuditActionDefinition {
  /** The owning api module, the one that calls `AuditService.record` for this code. */
  readonly module: string;
  /** The `record_type` every entry of this code carries. */
  readonly recordType: string;
  /** `required`: a missing or blank reason throws `AuditReasonRequired`. */
  readonly reason: AuditReasonPolicy;
  /** True when the system decides in place of a person. */
  readonly automatic: boolean;
  /** True when the owning module registers an undo handler for it. */
  readonly undoable: boolean;
  /**
   * The code of the undo handler the owning module registers (milestone 4,
   * `AuditUndoRegistry`). Required exactly when `undoable`; the registry test refuses an undoable
   * code without one.
   */
  readonly undoHandler?: string;
  /**
   * The reason codes this action accepts (security review AS23). Required, and the only codes
   * `AuditService.record` takes, when the action's record type keeps its reason as a code
   * (`AUDIT_RECORD_TYPES`, `reason: 'code'`: customer, order, exchange, outbound command), so a
   * code such as `ahmed_mohamed` or `call_01012345678` can never be stored. Unused on a free text
   * record type; the registry test refuses it there.
   */
  readonly reasonCodes?: readonly string[];
  /** The catalog key of the action's label, shown on the audit screen. */
  readonly label: MessageKey;
  /** The repo path of the test that proves the action writes its entry. */
  readonly proof: string;
}

/** The proof test of the inventory master data actions (SKUs and locations). */
const INVENTORY_PROOF = 'apps/api/test/audit-inventory.e2e-spec.ts';

/**
 * Every audit action code, keyed `module_noun.verb_past` (spec 0010, "Actions"). A later feature
 * adds its code here in the same change that builds the action, with its label keys and its proof
 * test (AC-19). `AuditService.record` refuses any code not in this list (`UnknownAuditAction`).
 * Never remove a code that entries may carry: old entries still need their label.
 */
export const AUDIT_ACTIONS = {
  'stock_receipt.voided': {
    module: 'inventory',
    recordType: 'stock_receipt',
    // ReceiptsService.void relies on this: a blank void reason is refused here, as 422
    // REASON_REQUIRED (spec 0010, AC-5). Keep it required; the void keeps a fallback check.
    reason: 'required',
    automatic: false,
    undoable: false,
    label: 'audit.actions.stockReceiptVoided',
    proof: 'apps/api/test/audit.e2e-spec.ts',
  },
  'audit.exported': {
    module: 'audit',
    recordType: 'audit_entry',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.auditExported',
    proof: 'apps/api/test/audit.e2e-spec.ts',
  },
  'sku.archived': {
    module: 'inventory',
    recordType: 'sku',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.skuArchived',
    proof: INVENTORY_PROOF,
  },
  'sku.unarchived': {
    module: 'inventory',
    recordType: 'sku',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.skuUnarchived',
    proof: INVENTORY_PROOF,
  },
  'sku.code_changed': {
    module: 'inventory',
    recordType: 'sku',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.skuCodeChanged',
    proof: INVENTORY_PROOF,
  },
  'location.edited': {
    module: 'inventory',
    recordType: 'location',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.locationEdited',
    proof: INVENTORY_PROOF,
  },
  'location.archived': {
    module: 'inventory',
    recordType: 'location',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.locationArchived',
    proof: INVENTORY_PROOF,
  },
  'location.unarchived': {
    module: 'inventory',
    recordType: 'location',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.locationUnarchived',
    proof: INVENTORY_PROOF,
  },
} as const satisfies Record<string, AuditActionDefinition>;

/** A code in the registry. */
export type AuditActionCode = keyof typeof AUDIT_ACTIONS;

/** Every registered code, for pickers and checks. */
export const AUDIT_ACTION_CODES = Object.keys(AUDIT_ACTIONS) as AuditActionCode[];

/** Whether a string is a registered action code. Pure; never throws. */
export function isAuditActionCode(code: string): code is AuditActionCode {
  return Object.hasOwn(AUDIT_ACTIONS, code);
}

/** The registry entry of a code, or undefined for an unknown one. */
export function auditActionOf(code: string): AuditActionDefinition | undefined {
  return isAuditActionCode(code) ? AUDIT_ACTIONS[code] : undefined;
}
