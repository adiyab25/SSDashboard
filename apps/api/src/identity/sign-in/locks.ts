/**
 * The advisory lock key behind the "at least one active admin" rule (spec 0005, AC-17).
 * `create-admin` and the staff service both take it with `pg_advisory_xact_lock`, so two
 * changes can never each see another admin and leave none. Distinct from the migrate lock.
 */
export const ADMIN_RULE_LOCK = 727_002;

/**
 * The first key of the per email lock that hands out sign in slots one at a time (spec 0005,
 * AC-3), taken as `pg_advisory_xact_lock(SIGN_IN_SLOT_LOCK, hashtext(email_key))`. The two key
 * form is a separate key space from the single key locks above and in the ledger.
 */
export const SIGN_IN_SLOT_LOCK = 727_003;
