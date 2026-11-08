import { z } from 'zod';

/** Reason codes of a merge (`customer.merged`, spec 0014 audit table). Never a typed note. */
export const CustomerMergeReasonCode = z.enum([
  'same_person',
  'new_number',
  'duplicate_order',
  'suggestion',
]);
/** One merge reason code. */
export type CustomerMergeReasonCode = z.infer<typeof CustomerMergeReasonCode>;

/** Reason codes of an undo (`customer.unmerged`, required) and of the audit screen's undo. */
export const CustomerUnmergeReasonCode = z.enum(['wrong_merge', 'different_people']);
/** One undo reason code. */
export type CustomerUnmergeReasonCode = z.infer<typeof CustomerUnmergeReasonCode>;

/** Reason codes of dismissing a merge suggestion. */
export const CustomerDismissReasonCode = z.enum(['different_people', 'shared_phone']);
/** One dismissal reason code. */
export type CustomerDismissReasonCode = z.infer<typeof CustomerDismissReasonCode>;

/** Reason codes of a second phone added to a customer. */
export const CustomerPhoneAddedReasonCode = z.enum(['confirmed_by_customer']);
/** One phone added reason code. */
export type CustomerPhoneAddedReasonCode = z.infer<typeof CustomerPhoneAddedReasonCode>;

/** Reason codes of setting a flag. */
export const CustomerFlagReasonCode = z.enum([
  'confirmed_fake',
  'repeated_refusals',
  'repeated_returns',
  'abusive_contact',
  'shared_blacklist',
  'suggestion_applied',
]);
/** One flag reason code. */
export type CustomerFlagReasonCode = z.infer<typeof CustomerFlagReasonCode>;

/** Reason codes of clearing a flag (required). */
export const CustomerUnflagReasonCode = z.enum([
  'flag_mistaken',
  'customer_settled',
  'policy_review',
]);
/** One unflag reason code. */
export type CustomerUnflagReasonCode = z.infer<typeof CustomerUnflagReasonCode>;
