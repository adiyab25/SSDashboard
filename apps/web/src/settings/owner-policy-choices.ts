import {
  RefundBy,
  SaleRecordedAt,
  SettlementOwnerType,
  TaxDocument,
  type OwnerPolicyField,
  type OwnerPolicyFields,
} from '@ssdashboard/contracts';
import type { MessageKey } from '@ssdashboard/i18n';

/**
 * The fields of a location owner type policy in the order the screen asks them (spec 0009,
 * AC-24): who owns the stock and when the sale counts first (the locked terms), then refunds and
 * online selling.
 */
export const OWNER_POLICY_FIELD_ORDER: readonly OwnerPolicyField[] = [
  'stockOwnedByBrand',
  'handoverIsSale',
  'saleRecordedAt',
  'taxDocument',
  'settlementOwnerType',
  'endCustomerRefundBy',
  'defectivePieceRefundBy',
  'canSellOnline',
];

/** The answer of `settlementOwnerType` when nobody settles (`null` in the row). */
const NOBODY = 'none';

/** The catalog key of a field's question. */
export function fieldLabelKey(field: OwnerPolicyField): MessageKey {
  return `settings.ownerPolicies.fields.${field}`;
}

/**
 * The answers a field offers, as the radio values the screen uses: `yes` and `no` for a switch,
 * else the contract enum's values (`none` for a settlement owner of null). Pure.
 */
export function choicesOf(field: OwnerPolicyField): readonly string[] {
  switch (field) {
    case 'stockOwnedByBrand':
    case 'handoverIsSale':
    case 'canSellOnline':
      return ['yes', 'no'];
    case 'saleRecordedAt':
      return SaleRecordedAt.options;
    case 'endCustomerRefundBy':
    case 'defectivePieceRefundBy':
      return RefundBy.options;
    case 'taxDocument':
      return TaxDocument.options;
    case 'settlementOwnerType':
      return [...SettlementOwnerType.options, NOBODY];
  }
}

/** The radio value a row's field holds now. Pure. */
export function choiceOf(fields: OwnerPolicyFields, field: OwnerPolicyField): string {
  switch (field) {
    case 'stockOwnedByBrand':
    case 'handoverIsSale':
    case 'canSellOnline':
      return fields[field] ? 'yes' : 'no';
    case 'settlementOwnerType':
      return fields.settlementOwnerType ?? NOBODY;
    case 'saleRecordedAt':
    case 'endCustomerRefundBy':
    case 'defectivePieceRefundBy':
    case 'taxDocument':
      return fields[field];
  }
}

/**
 * The fields with one answer changed. An answer the field does not offer leaves the fields as
 * they are (it never guesses); the api judges the whole row anyway. Pure.
 */
export function withChoice(
  fields: OwnerPolicyFields,
  field: OwnerPolicyField,
  choice: string,
): OwnerPolicyFields {
  switch (field) {
    case 'stockOwnedByBrand':
    case 'handoverIsSale':
    case 'canSellOnline':
      return { ...fields, [field]: choice === 'yes' };
    case 'saleRecordedAt': {
      const parsed = SaleRecordedAt.safeParse(choice);
      return parsed.success ? { ...fields, saleRecordedAt: parsed.data } : fields;
    }
    case 'endCustomerRefundBy':
    case 'defectivePieceRefundBy': {
      const parsed = RefundBy.safeParse(choice);
      return parsed.success ? { ...fields, [field]: parsed.data } : fields;
    }
    case 'taxDocument': {
      const parsed = TaxDocument.safeParse(choice);
      return parsed.success ? { ...fields, taxDocument: parsed.data } : fields;
    }
    case 'settlementOwnerType': {
      if (choice === NOBODY) return { ...fields, settlementOwnerType: null };
      const parsed = SettlementOwnerType.safeParse(choice);
      return parsed.success ? { ...fields, settlementOwnerType: parsed.data } : fields;
    }
  }
}

/** The catalog key of one answer of a field, in the person's language. */
export function choiceLabelKey(field: OwnerPolicyField, choice: string): MessageKey {
  switch (field) {
    case 'stockOwnedByBrand':
    case 'handoverIsSale':
    case 'canSellOnline':
      return choice === 'yes' ? 'settings.values.yes' : 'settings.values.no';
    case 'saleRecordedAt':
      return `settings.ownerPolicies.saleRecordedAt.${SaleRecordedAt.catch('at_shipment').parse(choice)}`;
    case 'endCustomerRefundBy':
    case 'defectivePieceRefundBy':
      return `settings.ownerPolicies.refundBy.${RefundBy.catch('brand').parse(choice)}`;
    case 'taxDocument':
      return `settings.ownerPolicies.taxDocument.${TaxDocument.catch('b2c_electronic_receipt').parse(choice)}`;
    case 'settlementOwnerType':
      return choice === NOBODY
        ? 'settings.ownerPolicies.settlementOwnerType.none'
        : `settings.ownerPolicies.settlementOwnerType.${SettlementOwnerType.catch('carrier').parse(choice)}`;
  }
}

/** Only the policy fields of a row, as `PUT` takes them (the row view carries more). Pure. */
export function policyFieldsOf(row: OwnerPolicyFields): OwnerPolicyFields {
  return {
    stockOwnedByBrand: row.stockOwnedByBrand,
    handoverIsSale: row.handoverIsSale,
    saleRecordedAt: row.saleRecordedAt,
    endCustomerRefundBy: row.endCustomerRefundBy,
    defectivePieceRefundBy: row.defectivePieceRefundBy,
    taxDocument: row.taxDocument,
    settlementOwnerType: row.settlementOwnerType,
    canSellOnline: row.canSellOnline,
  };
}
