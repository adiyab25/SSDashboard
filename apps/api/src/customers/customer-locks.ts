/**
 * The first key of the per phone lock `findOrCreate` takes, as
 * `pg_advisory_xact_lock(CUSTOMER_PHONE_LOCK, hashtext(phone_e164))` (spec 0014, locks and
 * concurrency). It serializes every call that names one phone, so two calls never both create it.
 * The two key form is a separate key space from the single key locks of the ledger and identity.
 */
export const CUSTOMER_PHONE_LOCK = 727_010;
// Every writer of `customer_phones` takes this lock first (`findOrCreate` and `addPhone`): a writer
// that skips it can make `findOrCreate` fail on a unique key.

/**
 * The first key of the per channel id lock `findOrCreate` takes after the phone lock, as
 * `pg_advisory_xact_lock(CUSTOMER_EXTERNAL_ID_LOCK, hashtext(kind || issuer || external id))`. Always
 * taken second, so two calls can never wait on each other in a circle.
 */
export const CUSTOMER_EXTERNAL_ID_LOCK = 727_011;

/**
 * The first key of the per customer lock a merge, an undo, and (feature 28) a credit write take
 * over the whole id set of a canonical customer, as
 * `pg_advisory_xact_lock(CUSTOMER_LOCK, hashtext(customer_id))` (spec 0002, namespace `customer`).
 */
export const CUSTOMER_LOCK = 727_012;
