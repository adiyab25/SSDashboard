# 0002 child: the settlement primitive

Part of the [2026-11-05 amendment of spec 0002](index.md#amendment-2026-11-05). Satisfies **AC-25**. Sources: final plan sections 6.2, 6.13, 7.4, 7.5 (`docs/positioning/2026-11-05-egypt-order-operations-layer.md`); spec 0007 section 1 (carrier accounts, the store carried onto every settlement line) and section 3 (third party money confirmed only after period close); reference brand notes section 2 (confirmed ranges, revoked with a reason, never deleted).

## Summary

One mechanism settles money with every third party that holds some of it: the carrier (Bosta remits cash minus fees and refunds), a consignment partner (owes for what sold, is credited for defective returns, charged for missing pieces), and later a payment gateway. Each settlement account has periods, external statements, and lines; lines are matched to orders, and anything unmatched carries a reason. A period is closed with evidence and can be revoked with a reason, and nothing is ever deleted.

**Built here versus later.** This feature migrates the six tables with every check, exclusion, and trigger, and builds two pure functions in `packages/contracts/src/settlement/`: `lineMatchState` (a line's state from its match rows) and `settlementPeriodStatus` (a period's status from its events). Importing, matching, and the reconciliation screen are feature 22 (carrier) and 43 (partner); period close with evidence is feature 23. Test scenarios tagged with a feature number are proven by that feature's tests.

## Tables

**Settlement module.** Every table also has `tenant_id`. ★ migrated by this feature.

| Table | Fields | Constraints and indexes |
|---|---|---|
| ★ `settlement_accounts` | `id`, `code text`, `name jsonb`, `owner_type` enum (`carrier`, `consignment_partner`, `gateway`), `owner_connection_id fk connections null` (carrier and gateway: the connected account), `owner_party_id fk parties null` (consignment partner), `archived_at`, timestamps | unique (`tenant_id`, `code`); check carrier or gateway ⇒ `owner_connection_id` set and `owner_party_id` null; check partner ⇒ the reverse; partial unique (`tenant_id`, `owner_connection_id`) and (`tenant_id`, `owner_party_id`) where not archived (one live account per owner) |
| ★ `settlement_periods` | `id`, `account_id fk`, `starts_on date`, `ends_on date`, `status` enum (`open`, `closed`) default `open`, timestamps | check `starts_on <= ends_on`; `EXCLUDE USING gist (account_id WITH =, daterange(starts_on, ends_on, '[]') WITH &&)` (periods of one account never overlap; needs `btree_gist`); index (`account_id`, `starts_on desc`) |
| ★ `settlement_period_events` (append only) | `id`, `period_id fk`, `action` enum (`closed`, `revoked`), `evidence jsonb null` (closed: the statement total, the matched total, the statement checksum, and whether it closed by a person or by exact evidence), `reason text null` (revoked: required), `actor_type` enum (`person`, `rule`), `actor_id fk users null`, `recorded_at` | index (`period_id`, `recorded_at`); check `reason` set when `action = 'revoked'` |
| ★ `settlement_statements` (append only) | `id`, `account_id fk`, `period_id fk null`, `kind` enum (`carrier_file`, `carrier_api`, `partner_file`, `partner_upload`, `partner_api`, `count`), `external_reference text` (a cash cycle id, a file name, a partner's statement number), `object_key text null` and `sha256 text null` (an uploaded file in object storage), `statement_total numeric(14,2) null` (the third party's own total, the evidence), `deposited_amount numeric(14,2) null`, `deposited_on date null`, `supersedes_statement_id fk null` (self), `imported_by fk users null`, `received_at` | unique (`tenant_id`, `account_id`, `external_reference`, `sha256`) `NULLS NOT DISTINCT`; unique (`supersedes_statement_id`); index (`account_id`, `received_at desc`) |
| ★ `settlement_lines` (append only) | `id`, `account_id fk`, `statement_id fk`, `period_id fk null`, `line_kind` enum (below), `amount numeric(14,2)` (signed: positive is owed to the brand by the account owner), `external_line_ref text` (the third party's line identity, the dedupe key), `occurred_on date`, `tracking_number text null`, `business_reference text null`, `store_id fk null` (B1), `partner_code text null`, `partner_text text null`, `quantity int null`, `unit_price numeric(14,2) null` (partner lines: consignment price) | unique (`tenant_id`, `account_id`, `external_line_ref`); index (`tracking_number`); index (`statement_id`); index (`period_id`); index (`account_id`, `occurred_on`) |
| ★ `settlement_line_matches` (append only) | `id`, `line_id fk`, `result` enum (`matched`, `unmatched`, `cleared`), `order_id fk null`, `order_line_id fk null`, `variant_id fk null` (partner lines, from channel code mapping at match time), `reason_code text null` (unmatched: required), `matched_by_type` enum (`rule`, `person`), `matched_by fk users null`, `rule_code text null`, `supersedes_match_id fk null` (self), `recorded_at` | unique (`supersedes_match_id`); index (`line_id`, `recorded_at desc`); index (`order_id`); check `result = 'matched'` ⇒ `order_id` or `variant_id` set; check `result = 'unmatched'` ⇒ `reason_code` set |

`line_kind` values: carrier `cod_collected` (+), `cod_fee` (−), `shipping_fee` (−), `fee_vat` (−), `customer_refund` (−, a cash refund the courier handed to a customer); partner `consignment_sale` (+, quantity times consignment price), `defective_return_credit` (−), `missing_piece_charge` (+), `partner_payment` (−, money the partner paid); any owner `adjustment` (+ or −, with the statement's own wording in `partner_text`).

## Rules

- **Lines are the third party's facts.** They are stored as the statement gives them and never edited. A corrected statement is a new statement with `supersedes_statement_id`; its lines carry new `external_line_ref` values or the importer refuses the duplicates (`DuplicateLine`), and the superseded statement's lines are cleared by `cleared` match rows that point at the reason.
- **Matching is history.** A line's current state is its latest `settlement_line_matches` row (a line with none is `unmatched`, reason `not_yet_matched`). Matching again, unmatching, or clearing adds a row that supersedes the previous one; nothing is updated. Rules match exact evidence (for example tracking number and amount) and record `rule_code`; a person matches the rest. Reason codes for unmatched lines start with `not_yet_matched`, `no_order_for_tracking`, `amount_differs`, `store_unknown`, `unmapped_product`, `duplicate_line`, `outside_period`; features 22 and 43 may add codes.
- **The store on a carrier line** (B1): from the carrier account's store binding when it has one; otherwise from the delivery the tracking number names, read through the orders module's exported service, never its table (its `store_id`, which feature 19 sets from the business reference or the Shopify store name, spec 0007 section 1). A carrier line whose store cannot be found is `unmatched` with `store_unknown`.
- **Effects on orders** go through events: a match on a `cod_collected` or deposit carrying line emits `SettlementLineMatched` with the order and amount; the orders module moves its cash state ([orders child](0002-orders.md#cash-state-machine)). A revoked match emits `SettlementMatchRevoked` and the order steps back.
- **Period close.** A period closes when every line in it has a latest match row of `matched` or `cleared`, and its evidence agrees (feature 23 sets the evidence rules, for example the statement total equal to the matched total). Closing writes a `closed` event and sets `status = 'closed'` in the same transaction; a revoke writes a `revoked` event with a reason and sets `open`. The period row is never deleted, and `status` is always the latest event's result (a test rebuilds it from the events). Importing a statement into a closed period is refused without an admin's written reason (feature 23).
- **Partner periods** follow the partner's agreed cadence (feature 43); carrier periods are whatever range the brand settles (a cash cycle week or a month).
- **Gateway** accounts exist in the enum and the owner check now, so adding them later is rows and an adapter, not a migration.
- Which settlement owner type a location's sales settle through is a question for `LocationPolicyService` ([catalog and locations child](0002-catalog-locations.md#locations-and-the-owner-type-policy)), never a comparison in settlement code.

## Value sourcing

| Action | Value | Source |
|---|---|---|
| import carrier statement | lines | the carrier file or the per delivery cash cycle read (feature 22); amounts from the single delivery read, never a list pass (spec 0007 section 1) |
| import | `external_line_ref` | the carrier's cash cycle id plus tracking number plus line kind; the partner's statement line number (features 22, 43) |
| import | `store_id` | account binding, else the delivery's store (above) |
| import | `period_id` | the account's period whose range holds `occurred_on`; null if none exists yet |
| match | order | `tracking_number` to the delivery's order (feature 19), or `business_reference` |
| match (partner) | variant | channel code mapping of `partner_code` (feature 40) at match time |
| any read | line state | the latest match row |
| any read | period status | the latest period event (stored copy in `status`) |
| close | evidence | statement total, matched total, checksum |

## Critical test scenarios

- `settlementPeriodStatus` (a pure function in `packages/contracts/src/settlement/`) rebuilds `open` or `closed` from a period's events, and `lineMatchState` gives a line's state from its match rows (none means `unmatched`, `not_yet_matched`), verifies **AC-25**.
- An account with owner type `carrier` and a party fails its check; two overlapping periods for one account fail the exclusion; two accounts may share dates, verifies **AC-25**.
- A line imported twice with the same `external_line_ref` fails the unique key; `UPDATE` and `DELETE` on lines, matches, statements, and period events fail for the app role and the owner, verifies **AC-25**, **AC-33**.
- (feature 22) Match, then unmatch with a reason, then match again: three rows, the latest wins, nothing updated; a line with no match row reads `unmatched` with `not_yet_matched`, verifies **AC-25**.
- (feature 23) Close a period, revoke it with a reason, close it again: three events, `status` matches a rebuild from events; revoking without a reason fails, verifies **AC-25**.
- (feature 22) An unbound Bosta account with lines for two stores: each line carries its delivery's store, verifies **AC-25** (B1).
