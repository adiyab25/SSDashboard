import type { MessageKey } from '@ssdashboard/i18n';
import {
  ORDER_COLLECTION_REASONS,
  ORDER_CREATED_MANUALLY_REASONS,
  ORDER_EDITED_REASONS,
  ORDER_PARTIAL_DELIVERY_REASONS,
  ORDER_PAYMENT_METHOD_REDERIVED_REASONS,
} from '../orders/order-reasons.js';
import { CustomerUndoRefusalCode } from '../customers/customer-merges.js';
import {
  CustomerDismissReasonCode,
  CustomerFlagReasonCode,
  CustomerMergeReasonCode,
  CustomerPhoneAddedReasonCode,
  CustomerUnflagReasonCode,
  CustomerUnmergeReasonCode,
} from '../customers/customer-reason-codes.js';

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
  /**
   * The refusal codes the owner's undo handler may throw with `UndoNotPossible` (security review
   * AS31): required, and non empty, on an undoable action, each upper snake case with no phone in
   * it (`MERGE_NOT_LATEST`). Only a listed code reaches the 409 answer as `undoCode`; any other
   * refusal is answered as a plain `UNDO_NOT_POSSIBLE`, so a handler can never put a value in
   * the answer. Unused on a final action; the registry test refuses it there.
   */
  readonly undoRefusalCodes?: readonly string[];
  /** The catalog key of the action's label, shown on the audit screen. */
  readonly label: MessageKey;
  /** The repo path of the test that proves the action writes its entry. */
  readonly proof: string;
}

/** The proof test of the orders actions (spec 0013). */
const ORDERS_PROOF = 'apps/api/test/orders-audit.e2e-spec.ts';

/** The proof test of the customers actions (spec 0014). */
const CUSTOMERS_PROOF = 'apps/api/test/customers-audit.e2e-spec.ts';

/** The proof test of the inventory master data actions (SKUs and locations). */
const INVENTORY_PROOF = 'apps/api/test/audit-inventory.e2e-spec.ts';

/** The proof test of the online location actions (spec 0011). */
const ONLINE_STOCK_PROOF = 'apps/api/test/online-stock.e2e-spec.ts';

/** The proof test of the style, variant, and barcode actions (spec 0012). */
const STYLES_PROOF = 'apps/api/test/styles.e2e-spec.ts';

/** The proof test of the season and product group actions (spec 0012). */
const GROUPINGS_PROOF = 'apps/api/test/seasons-groups.e2e-spec.ts';

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
  // Spec 0011 AC-19: the gated actions that decide which location feeds online stock. The label is
  // the location code. The stock confirmation is the gate's "stock counted" fact; moving and
  // stopping need a written reason. Proven by the online stock e2e suite.
  'location.stock_confirmed': {
    module: 'inventory',
    recordType: 'location',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.locationStockConfirmed',
    proof: ONLINE_STOCK_PROOF,
  },
  'location.online_moved': {
    module: 'inventory',
    recordType: 'location',
    reason: 'required',
    automatic: false,
    undoable: false,
    label: 'audit.actions.locationOnlineMoved',
    proof: ONLINE_STOCK_PROOF,
  },
  'location.online_stopped': {
    module: 'inventory',
    recordType: 'location',
    reason: 'required',
    automatic: false,
    undoable: false,
    label: 'audit.actions.locationOnlineStopped',
    proof: ONLINE_STOCK_PROOF,
  },
  // Spec 0009, AC-3: every settings write, module toggle, and step switch. The record id is the
  // setting's stable uuid (`settingRecordId`, from its key) and the label is the key. Optional
  // here: `SettingsService.write` passes `reasonRequired` from the registry entry.
  'setting.changed': {
    module: 'platform',
    recordType: 'setting',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.settingChanged',
    proof: 'apps/api/test/settings.e2e-spec.ts',
  },
  // Spec 0009, AC-20: a verified license recorded for the first time, from the file (actor a
  // `system_job`, the check) or an upload (the manager). The record id is `licenses.id`, the label
  // the vendor's license id. Recorded licenses only add, so there is nothing to undo.
  'license.added': {
    module: 'platform',
    recordType: 'license',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.licenseAdded',
    proof: 'apps/api/test/license.e2e-spec.ts',
  },
  // Spec 0009, AC-24: a holder of `settings.manage` edits a location owner type policy row through
  // `LocationPolicyService.updatePolicy`. The record id is the owner type's stable uuid
  // (`ownerPolicyRecordId`), the label the owner type code, the diff the row before and after.
  'policy.changed': {
    module: 'inventory',
    recordType: 'policy',
    reason: 'required',
    automatic: false,
    undoable: false,
    label: 'audit.actions.policyChanged',
    proof: 'apps/api/test/owner-policies.e2e-spec.ts',
  },
  // Spec 0009, AC-23: a per order cost rule recorded through `CostRulesService.record` (a new
  // append only `order_cost_rules` row; the record id is its id, the label its kind). A rule from a
  // day on or before the inventory lock date is recorded only with the explicit override and its
  // own code (D14), so nobody moves the lock date for a narrow cost fix.
  'cost_rule.recorded': {
    module: 'platform',
    recordType: 'order_cost_rule',
    reason: 'required',
    automatic: false,
    undoable: false,
    label: 'audit.actions.costRuleRecorded',
    proof: 'apps/api/test/cost-rules.e2e-spec.ts',
  },
  'cost_rule.recorded_in_locked_period': {
    module: 'platform',
    recordType: 'order_cost_rule',
    reason: 'required',
    automatic: false,
    undoable: false,
    label: 'audit.actions.costRuleRecordedInLockedPeriod',
    proof: 'apps/api/test/cost-rules.e2e-spec.ts',
  },
  // Spec 0013 (orders): the record id is `orders.id` and the label `<store code>/<order number>`
  // (`ESS/#1001`). Ship to values are masked by the writer and listed in `personal_fields`. State
  // moves are not audited: `order_events` is their history.
  'order.created_manually': {
    module: 'orders',
    recordType: 'order',
    reason: 'optional',
    automatic: false,
    undoable: false,
    reasonCodes: ORDER_CREATED_MANUALLY_REASONS,
    label: 'audit.actions.orderCreatedManually',
    proof: ORDERS_PROOF,
  },
  'order.edited': {
    module: 'orders',
    recordType: 'order',
    reason: 'optional',
    automatic: false,
    undoable: false,
    reasonCodes: ORDER_EDITED_REASONS,
    label: 'audit.actions.orderEdited',
    proof: ORDERS_PROOF,
  },
  'order.partial_delivery_split': {
    module: 'orders',
    recordType: 'order',
    reason: 'optional',
    automatic: false,
    undoable: false,
    reasonCodes: ORDER_PARTIAL_DELIVERY_REASONS,
    label: 'audit.actions.orderPartialDeliverySplit',
    proof: ORDERS_PROOF,
  },
  'order.collection_recorded_manually': {
    module: 'orders',
    recordType: 'order',
    reason: 'required',
    automatic: false,
    undoable: false,
    reasonCodes: ORDER_COLLECTION_REASONS,
    label: 'audit.actions.orderCollectionRecordedManually',
    proof: ORDERS_PROOF,
  },
  'order.payment_method_rederived': {
    module: 'orders',
    recordType: 'order',
    reason: 'optional',
    automatic: false,
    undoable: false,
    reasonCodes: ORDER_PAYMENT_METHOD_REDERIVED_REASONS,
    label: 'audit.actions.orderPaymentMethodRederived',
    proof: ORDERS_PROOF,
  },
  // Spec 0015 AC-1 (task 6): a manager connects a Shopify store. The record id is
  // `connections.id`, the label the store code; the diff holds the label, store code, shop
  // domain, and app owner, never a credential or a token (AC-2).
  'connection.created': {
    module: 'connectors',
    recordType: 'connection',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.connectionCreated',
    proof: 'apps/api/test/shopify-connect.e2e-spec.ts',
  },
  // Spec 0014 milestone 2: the record id is `customers.id` (no label: a customer has no code that
  // is not personal), the reason a code, `before` and `after` ids and codes only. A merge writes
  // one entry per changed customer record under one correlation id; only the merged record's
  // entry carries the undo (`customers.merge_undo` with `{ mergeId }`).
  'customer.merged': {
    module: 'customers',
    recordType: 'customer',
    reason: 'optional',
    automatic: false,
    undoable: true,
    undoHandler: 'customers.merge_undo',
    reasonCodes: CustomerMergeReasonCode.options,
    undoReasonCodes: CustomerUnmergeReasonCode.options,
    undoRefusalCodes: CustomerUndoRefusalCode.options,
    label: 'audit.actions.customerMerged',
    proof: CUSTOMERS_PROOF,
  },
  'customer.unmerged': {
    module: 'customers',
    recordType: 'customer',
    reason: 'required',
    automatic: false,
    undoable: false,
    reasonCodes: CustomerUnmergeReasonCode.options,
    label: 'audit.actions.customerUnmerged',
    proof: CUSTOMERS_PROOF,
  },
  'customer.merge_suggestion_dismissed': {
    module: 'customers',
    recordType: 'customer',
    reason: 'optional',
    automatic: false,
    undoable: false,
    reasonCodes: CustomerDismissReasonCode.options,
    label: 'audit.actions.customerMergeSuggestionDismissed',
    proof: CUSTOMERS_PROOF,
  },
  'customer.phone_added': {
    module: 'customers',
    recordType: 'customer',
    reason: 'optional',
    automatic: false,
    undoable: false,
    reasonCodes: CustomerPhoneAddedReasonCode.options,
    label: 'audit.actions.customerPhoneAdded',
    proof: CUSTOMERS_PROOF,
  },
  // Spec 0014 milestone 3: `before` and `after` carry the flag kind and source only, never the
  // note (Law 151). A clear writes one entry per changed record under one correlation id; an
  // import (`setFlagFromImport`) writes none here, feature 15 writes its own.
  'customer.flagged': {
    module: 'customers',
    recordType: 'customer',
    reason: 'optional',
    automatic: false,
    undoable: false,
    reasonCodes: CustomerFlagReasonCode.options,
    label: 'audit.actions.customerFlagged',
    proof: CUSTOMERS_PROOF,
  },
  'customer.unflagged': {
    module: 'customers',
    recordType: 'customer',
    reason: 'required',
    automatic: false,
    undoable: false,
    reasonCodes: CustomerUnflagReasonCode.options,
    label: 'audit.actions.customerUnflagged',
    proof: CUSTOMERS_PROOF,
  },
  // Spec 0012 milestone 2 (AC-17): style edits, a style's code, a variant added to a style, a
  // SKU's barcodes, and every season and product group write, each a person's action in its own
  // transaction. The record id is the style, SKU, season, or group id; the label its code. A bulk
  // assign writes one `style.edited` per changed style under one correlation id.
  'style.edited': {
    module: 'catalog',
    recordType: 'style',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.styleEdited',
    proof: STYLES_PROOF,
  },
  'style.code_changed': {
    module: 'catalog',
    recordType: 'style',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.styleCodeChanged',
    proof: STYLES_PROOF,
  },
  'style.variant_added': {
    module: 'catalog',
    recordType: 'style',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.styleVariantAdded',
    proof: STYLES_PROOF,
  },
  'sku.barcode_added': {
    module: 'catalog',
    recordType: 'sku',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.skuBarcodeAdded',
    proof: STYLES_PROOF,
  },
  'sku.barcode_removed': {
    module: 'catalog',
    recordType: 'sku',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.skuBarcodeRemoved',
    proof: STYLES_PROOF,
  },
  'season.created': {
    module: 'catalog',
    recordType: 'season',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.seasonCreated',
    proof: GROUPINGS_PROOF,
  },
  'season.edited': {
    module: 'catalog',
    recordType: 'season',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.seasonEdited',
    proof: GROUPINGS_PROOF,
  },
  'season.archived': {
    module: 'catalog',
    recordType: 'season',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.seasonArchived',
    proof: GROUPINGS_PROOF,
  },
  'season.unarchived': {
    module: 'catalog',
    recordType: 'season',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.seasonUnarchived',
    proof: GROUPINGS_PROOF,
  },
  'season.deleted': {
    module: 'catalog',
    recordType: 'season',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.seasonDeleted',
    proof: GROUPINGS_PROOF,
  },
  'product_group.created': {
    module: 'catalog',
    recordType: 'product_group',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.productGroupCreated',
    proof: GROUPINGS_PROOF,
  },
  'product_group.edited': {
    module: 'catalog',
    recordType: 'product_group',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.productGroupEdited',
    proof: GROUPINGS_PROOF,
  },
  'product_group.archived': {
    module: 'catalog',
    recordType: 'product_group',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.productGroupArchived',
    proof: GROUPINGS_PROOF,
  },
  'product_group.unarchived': {
    module: 'catalog',
    recordType: 'product_group',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.productGroupUnarchived',
    proof: GROUPINGS_PROOF,
  },
  'product_group.deleted': {
    module: 'catalog',
    recordType: 'product_group',
    reason: 'optional',
    automatic: false,
    undoable: false,
    label: 'audit.actions.productGroupDeleted',
    proof: GROUPINGS_PROOF,
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

/** An undoable code of the registry (`customer.merged` today). */
export type AuditUndoableActionCode = {
  [Code in AuditActionCode]: (typeof AUDIT_ACTIONS)[Code]['undoable'] extends true ? Code : never;
}[AuditActionCode];

/** The undone code of an undoable code, `<noun>.<verb>_undone` (`customer.merged_undone` today). */
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
