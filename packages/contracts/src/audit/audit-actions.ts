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
  /**
   * The reason codes an undo of this action accepts (spec 0010 task 16, security review AS13):
   * required for an undoable action whose record type keeps its reason as a code, because the
   * undone entry is written on the same record and the reason there must be a code too. Unused on
   * a free text record type, where the undo takes typed text.
   */
  readonly undoReasonCodes?: readonly string[];
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
  'hat.granted': {
    module: 'identity',
    recordType: 'user',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.hatGranted',
    proof: 'apps/api/test/identity-audit.e2e-spec.ts',
  },
  'hat.revoked': {
    module: 'identity',
    recordType: 'user',
    // Optional per action; taking the manager hat away needs one (spec 0010 actions table): the
    // hat service passes `reasonRequired: true` for that change and answers 422 REASON_REQUIRED.
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.hatRevoked',
    proof: 'apps/api/test/identity-audit.e2e-spec.ts',
  },
  'staff_user.created': {
    module: 'identity',
    recordType: 'user',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.staffUserCreated',
    proof: 'apps/api/test/identity-audit.e2e-spec.ts',
  },
  'staff_user.disabled': {
    module: 'identity',
    recordType: 'user',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.staffUserDisabled',
    proof: 'apps/api/test/identity-audit.e2e-spec.ts',
  },
  'staff_user.enabled': {
    module: 'identity',
    recordType: 'user',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.staffUserEnabled',
    proof: 'apps/api/test/identity-audit.e2e-spec.ts',
  },
  'staff_user.password_reset': {
    module: 'identity',
    recordType: 'user',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.staffUserPasswordReset',
    proof: 'apps/api/test/identity-audit.e2e-spec.ts',
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

/** Every registered code, for pickers and checks. Undone codes are derived, not listed. */
export const AUDIT_ACTION_CODES = Object.keys(AUDIT_ACTIONS) as AuditActionCode[];

/** Whether a string is a registered action code. Pure; never throws. */
export function isAuditActionCode(code: string): code is AuditActionCode {
  return Object.hasOwn(AUDIT_ACTIONS, code);
}

/**
 * The suffix of an undone code (spec 0010 task 16, security review AS5): the undo of
 * `customer.merged` is recorded as `customer.merged_undone`, which keeps the one dot that
 * `audit_action_format` allows. No registered code may end with it; the registry test checks.
 */
export const AUDIT_UNDONE_SUFFIX = '_undone';

/** The one label every undone entry shows; the screen names the undone action beside it. */
const UNDONE_LABEL: MessageKey = 'audit.actions.actionUndone';

/** An undoable code of the registry (none today). */
export type AuditUndoableActionCode = {
  [Code in AuditActionCode]: (typeof AUDIT_ACTIONS)[Code]['undoable'] extends true ? Code : never;
}[AuditActionCode];

/** The undone code of an undoable code, `<noun>.<verb>_undone` (none today). */
export type AuditUndoneActionCode = `${AuditUndoableActionCode}${typeof AUDIT_UNDONE_SUFFIX}`;

/** The undone code an undo of `code` records. Pure; never checks the registry. */
export function auditUndoneCodeOf(code: string): string {
  return `${code}${AUDIT_UNDONE_SUFFIX}`;
}

/**
 * The definition an undone code derives from its undoable action (spec 0010 task 16): one
 * companion per undoable code, never listed by hand. It is the audit module's (the undo writes
 * it), on the same record type, reason `required` (owner question 3), never automatic, never
 * itself undoable, labelled with the one shared key, with the undo's reason codes when the record
 * type keeps codes, and proven by the undoable action's own proof file, which must name the
 * undone code too.
 */
export function undoneActionOf(action: AuditActionDefinition): AuditActionDefinition {
  return {
    module: 'audit',
    recordType: action.recordType,
    reason: 'required',
    automatic: false,
    undoable: false,
    ...(action.undoReasonCodes ? { reasonCodes: action.undoReasonCodes } : {}),
    label: UNDONE_LABEL,
    proof: action.proof,
  };
}

/**
 * The undoable action an undone code belongs to, or undefined when `code` is not
 * `<undoable code>_undone` in `registry`. Read live, so a row planted in a test counts.
 */
export function auditUndoneParentOf(
  code: string,
  registry: Readonly<Record<string, AuditActionDefinition>> = AUDIT_ACTIONS,
): { code: string; action: AuditActionDefinition } | undefined {
  if (!code.endsWith(AUDIT_UNDONE_SUFFIX)) return undefined;
  const parent = code.slice(0, -AUDIT_UNDONE_SUFFIX.length);
  const action = Object.hasOwn(registry, parent) ? registry[parent] : undefined;
  return action?.undoable ? { code: parent, action } : undefined;
}

/**
 * The registry with every derived undone code added (spec 0010 task 16): what `record` accepts,
 * the screen labels, and the registry test checks. Pure.
 */
export function auditActionsWithUndone(
  registry: Readonly<Record<string, AuditActionDefinition>> = AUDIT_ACTIONS,
): Record<string, AuditActionDefinition> {
  const all: Record<string, AuditActionDefinition> = { ...registry };
  for (const [code, action] of Object.entries(registry)) {
    if (action.undoable) all[auditUndoneCodeOf(code)] = undoneActionOf(action);
  }
  return all;
}

/**
 * The registry entry of a code, the derived one of an undone code, or undefined for an unknown
 * one. Pure; never throws.
 */
export function auditActionOf(code: string): AuditActionDefinition | undefined {
  if (isAuditActionCode(code)) return AUDIT_ACTIONS[code];
  const parent = auditUndoneParentOf(code);
  return parent ? undoneActionOf(parent.action) : undefined;
}
