import type { MessageKey } from '@ssdashboard/i18n';
import { SKU_CODE_PATTERN } from '../catalog.js';
import { LICENSE_ID_PATTERN } from '../license/license-envelope.js';
import { LOCATION_CODE_PATTERN } from '../locations.js';

/**
 * How an entry of a record type keeps its `reason` (spec 0010, AC-5, security review AS13).
 * `code`: a lower case code only (`ReasonCode`, the shape of spec 0002 S4), never a typed note,
 * because a note about a customer would be personal data kept for the life of the install.
 * `text`: free text, trimmed, with phones and emails masked.
 */
export type AuditReasonForm = 'code' | 'text';

/**
 * One kind of record the audit trail names (spec 0010, review AW2, security reviews AS2, AS13,
 * AS16, AS17). `label` is a key into the English and Arabic catalogs of `@ssdashboard/i18n`,
 * never display text. `personalKeys` are the field names that are personal data in a diff of this
 * record type even though the shared redaction list leaves them alone elsewhere: a changed fields
 * diff carries no marker key, so a customer's bare `name` or `email`, a merge `reason`, or an
 * outbound `payload` would otherwise be stored in clear. Compared like the redaction list (lower
 * case, `_`, `-`, and spaces dropped).
 */
export interface AuditRecordTypeDefinition {
  /** The catalog key of the record type's label, shown on the audit screen. */
  readonly label: MessageKey;
  /** Field names masked in this record type's `before` and `after`, at any depth. */
  readonly personalKeys: readonly string[];
  /** Whether the entry's `reason` is a code or free text (masked). */
  readonly reason: AuditReasonForm;
  /**
   * The shape an entry's `record_label` must have, or `null` when this record type takes no
   * label at all (a customer has no code that is not personal).
   */
  readonly labelPattern: RegExp | null;
  /**
   * True when `labelPattern` is the record's own code contract (`SkuCode`, `LocationCode`, the
   * document number). A label that matches it is trusted, never refused as phone shaped, and a
   * top level `code` field of the diff that matches it is stored as written (security review
   * AS16: a SKU coded `01012345678` is a SKU, not a phone).
   */
  readonly labelIsOwnCode: boolean;
}

/**
 * The shape of a `record_label` for a record type with no code contract of its own (security
 * review AS3): a code or number such as `#1042`, at most 64 characters of letters, digits, and
 * `. _ - / # :`, with no space and no Arabic letter, so a full name or a sentence never fits; a
 * one word Latin name still would, which is why only owning modules set labels, and only from
 * their own codes. The table check `audit_record_label_length` holds the length too.
 */
export const AUDIT_RECORD_LABEL_PATTERN = /^[A-Za-z0-9#._-][A-Za-z0-9._/#:-]{0,63}$/;

/**
 * A stock receipt number as `NumberingService` issues it: the prefix from the
 * `document_prefixes` setting, the year, and the counter padded to 6 digits (`SR-2026-000001`).
 */
export const STOCK_RECEIPT_NUMBER_PATTERN = /^[A-Za-z0-9]{1,16}-[0-9]{4}-[0-9]{6,}$/;

/**
 * Every record type an audit entry may carry. Each registry action's `recordType` must be listed
 * here (the contracts test checks it, with both labels). The customer facing types are listed
 * before any action writes them, so their personal keys are masked and their reasons are codes
 * from the first entry. A new record type is one row here, with its labels, personal keys, reason
 * form, and label shape; never remove one that entries may carry.
 */
export const AUDIT_RECORD_TYPES = {
  stock_receipt: {
    label: 'audit.recordTypes.stockReceipt',
    personalKeys: [],
    reason: 'text',
    labelPattern: STOCK_RECEIPT_NUMBER_PATTERN,
    labelIsOwnCode: true,
  },
  sku: {
    label: 'audit.recordTypes.sku',
    personalKeys: [],
    reason: 'text',
    labelPattern: SKU_CODE_PATTERN,
    labelIsOwnCode: true,
  },
  location: {
    label: 'audit.recordTypes.location',
    personalKeys: [],
    reason: 'text',
    labelPattern: LOCATION_CODE_PATTERN,
    labelIsOwnCode: true,
  },
  user: {
    // A staff or partner login (`users` row), written by identity (`staff_user.*`, `hat.*`, spec
    // 0008): the diffs hold ids, flags, and hat names, the reason is the manager's free text, and
    // there is no label. A person's own name and email are personal if a diff ever carries them.
    label: 'audit.recordTypes.user',
    personalKeys: ['name', 'email'],
    reason: 'text',
    labelPattern: null,
    labelIsOwnCode: false,
  },
  setting: {
    // An install setting (spec 0009, AC-3): the record id is the key's v5 uuid
    // (`settingRecordId`), the label is the key itself (`operating_day_cutoff_hour`), the diff is
    // the stored value before and after, and the reason is the manager's free text. Settings hold
    // the brand's own choices, never a customer's data.
    label: 'audit.recordTypes.setting',
    personalKeys: [],
    reason: 'text',
    labelPattern: AUDIT_RECORD_LABEL_PATTERN,
    labelIsOwnCode: false,
  },
  license: {
    // A recorded license (spec 0009, AC-20): the record id is `licenses.id`, the label is the
    // vendor's license id (`LICENSE_ID_PATTERN`, its own code), the diff holds the license's terms
    // (bundles, expiry dates, key id, source), never its signature. A license carries no personal
    // data.
    label: 'audit.recordTypes.license',
    personalKeys: [],
    reason: 'text',
    labelPattern: LICENSE_ID_PATTERN,
    labelIsOwnCode: true,
  },
  policy: {
    // A location owner type policy row (spec 0009, AC-24): the record id is the owner type's
    // stable uuid, the label the owner type code itself, the diff the policy
    // attributes before and after, and the reason the manager's free text. No personal data.
    label: 'audit.recordTypes.policy',
    personalKeys: [],
    reason: 'text',
    labelPattern: AUDIT_RECORD_LABEL_PATTERN,
    labelIsOwnCode: false,
  },
  order_cost_rule: {
    // A per order cost rule (spec 0009, AC-23): the record id is `order_cost_rules.id`, the label
    // its kind (`cod_fee_percent`), the diff the rule in force before and the new rule, and the
    // reason the manager's free text. No personal data.
    label: 'audit.recordTypes.orderCostRule',
    personalKeys: [],
    reason: 'text',
    labelPattern: AUDIT_RECORD_LABEL_PATTERN,
    labelIsOwnCode: false,
  },
  audit_entry: {
    // An export of the trail (spec 0010, AC-15): the record id is the export's own id, the filter
    // is in `after`, and there is no label.
    label: 'audit.recordTypes.auditEntry',
    personalKeys: [],
    reason: 'text',
    labelPattern: null,
    labelIsOwnCode: false,
  },
  customer: {
    label: 'audit.recordTypes.customer',
    // A customer's name and email, the free text reason of a merge or unmerge, and an external
    // id (a WhatsApp contact id is the phone as bare digits, security review AS18).
    personalKeys: ['name', 'email', 'reason', 'externalid'],
    reason: 'code',
    labelPattern: null,
    labelIsOwnCode: false,
  },
  order: {
    label: 'audit.recordTypes.order',
    // The ship to person and her second phone, bare in the edit operations a diff can carry.
    personalKeys: ['name', 'email', 'phone', 'phonealt', 'address'],
    reason: 'code',
    labelPattern: AUDIT_RECORD_LABEL_PATTERN,
    labelIsOwnCode: false,
  },
  exchange: {
    label: 'audit.recordTypes.exchange',
    personalKeys: ['name', 'email', 'reason'],
    reason: 'code',
    labelPattern: AUDIT_RECORD_LABEL_PATTERN,
    labelIsOwnCode: false,
  },
  outbound_command: {
    label: 'audit.recordTypes.outboundCommand',
    // The carrier request body and its failure text carry the ship to person (spec 0002).
    personalKeys: ['payload', 'failurereason'],
    reason: 'code',
    labelPattern: AUDIT_RECORD_LABEL_PATTERN,
    labelIsOwnCode: false,
  },
} as const satisfies Record<string, AuditRecordTypeDefinition>;

/** A record type the audit trail knows. */
export type AuditRecordType = keyof typeof AUDIT_RECORD_TYPES;

/** The definition of a record type, or undefined for one the audit trail does not know. */
export function auditRecordTypeOf(type: string): AuditRecordTypeDefinition | undefined {
  return Object.hasOwn(AUDIT_RECORD_TYPES, type)
    ? AUDIT_RECORD_TYPES[type as AuditRecordType]
    : undefined;
}
