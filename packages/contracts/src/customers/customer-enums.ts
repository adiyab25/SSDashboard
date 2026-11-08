import { z } from 'zod';

/** Why a customer is flagged (spec 0014 AC-11). Matches the `customer_risk_flag` database enum, mildest first. */
export const CustomerRiskFlag = z.enum(['returner', 'refuser', 'fake', 'abusive']);
/** One risk flag kind. */
export type CustomerRiskFlag = z.infer<typeof CustomerRiskFlag>;

/** Who set a flag. Matches the `customer_risk_flag_source` database enum. */
export const CustomerRiskFlagSource = z.enum(['blacklist_import', 'manual', 'rule']);
/** One flag source. */
export type CustomerRiskFlagSource = z.infer<typeof CustomerRiskFlagSource>;

/** Which outside system issued a customer id. Matches the `customer_external_id_kind` database enum. */
export const CustomerExternalIdKind = z.enum([
  'shopify_customer',
  'partner_reference',
  'whatsapp_contact',
]);
/** One external id kind. */
export type CustomerExternalIdKind = z.infer<typeof CustomerExternalIdKind>;

/** Why two customers are suggested for a merge. Matches the `merge_suggestion_reason` database enum. */
export const MergeSuggestionReason = z.enum(['channel_id_conflict', 'second_phone_conflict']);
/** One merge suggestion reason. */
export type MergeSuggestionReason = z.infer<typeof MergeSuggestionReason>;

/** Where a merge suggestion stands. Matches the `merge_suggestion_status` database enum. */
export const MergeSuggestionStatus = z.enum(['open', 'applied', 'dismissed']);
/** One merge suggestion status. */
export type MergeSuggestionStatus = z.infer<typeof MergeSuggestionStatus>;

/** What `CustomersService.findOrCreate` did (spec 0014 AC-1). */
export const FindOrCreateOutcome = z.enum([
  'matched',
  'matched_by_channel_id',
  'matched_with_conflict',
  'created',
  'no_phone',
]);
/** One `findOrCreate` outcome. */
export type FindOrCreateOutcome = z.infer<typeof FindOrCreateOutcome>;

/**
 * The flag kinds from most to least severe: the canonical customer shows the most severe flag of
 * its ids when its own row has none (spec 0002, spec 0014 AC-11).
 */
export const CUSTOMER_FLAG_SEVERITY: readonly CustomerRiskFlag[] = [
  'fake',
  'abusive',
  'refuser',
  'returner',
];
