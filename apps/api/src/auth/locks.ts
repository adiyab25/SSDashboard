/**
 * The advisory lock key behind the "at least one active admin" rule (spec 0005, AC-17).
 * `create-admin` and the staff service both take it with `pg_advisory_xact_lock`, so two
 * changes can never each see another admin and leave none. Distinct from the migrate lock.
 */
export const ADMIN_RULE_LOCK = 727_002;
