# 0023. Metric dictionary and phone dashboard: one typed dictionary in contracts, read at request time through the owning modules' read services, shown on a phone first Today page

**Date**: 2026-11-13 (domain review folded in the same day: domain-metric-dictionary (kept private), see [Domain review applied](#domain-review-applied))
**Status**: Proposed (ratified: the owner answered every question in [Owner decisions](#owner-decisions) on 2026-11-13; every recommendation ratified)
**Scope feature**: 24, Metric dictionary and phone dashboard (Beta), in [Slice 1a: confirmation to cash](../../scope/confirmation-to-cash.md)
**Depends on**: [spec 0013](../0013-orders-state-machines/index.md) (built milestones 1 to 3: `OrderQueries`, the two state machines, `orders.outcome`, the `operating_day` column, the order list filters); [spec 0015](../0015-shopify-connector/index.md) (`ChannelEditNetted`, connection health and freshness); [spec 0016](../0016-tasks-my-work-inbox/index.md) (`TaskQueries.counts`, "refunds owed" and "refunds owed (unrecorded)"); [spec 0017](../0017-confirmation-queue/index.md) (`ConfirmationQueries.metrics`); [spec 0018](../0018-bosta-connector-mirror-mode/index.md) (`CarrierDeliveries`, freshness); [spec 0019](../0019-delivery-failures-returned-to-origin/index.md) (`DeliveryOutcomeReads`, the returned to origin rate of its AC-18, `ManualHandovers`); [spec 0020](../0020-settlement-bosta-reconciliation/index.md) (`CarrierSettlementReads`, remitted means credited in the Bosta wallet, provisional money of its AC-22); feature 23, period close (spec 0022, being written in parallel: the confirmed day read of [Contracts with other specs](#contracts-with-other-specs)); [spec 0003](../0003-design-system-ui-foundation/index.md) and [`packages/ui/DESIGN.md`](../../../packages/ui/DESIGN.md) (built: `MetricCard`, `NeedsYouList`, `BottomTabs`, `CollapsingTable`, `FreshnessStrip`, `ProvisionalValue`).
**Consumed by**: [spec 0024](../0024-daily-report/index.md) (feature 25, the daily report), which reads every figure through this spec's `MetricReader`; feature 39 (exchange dashboard) and feature 47 onwards (campaign profit), which add metrics to the same dictionary.

## Summary

Every number the owner sees is defined once, in one typed list (the metric dictionary) that says what the number counts, which day it is counted on, whether it is money as collected or after fees, and which module's read service supplies it. The dashboard and the daily report both read through one service in a new `reporting` module, so they can never disagree, and the module owns no business tables: it asks orders, confirmation, deliveries, settlement, tasks, and credit for their own figures at the moment of reading. The owner's first screen is a phone page in Arabic or English that shows the four agreed numbers first, then what is in the pipe right now, yesterday by store, where failed deliveries come from by governorate and product, and what needs them; today's numbers say they are live and past days say whether they are confirmed. Each returned piece lands in exactly one kind (order edit, cancellation, exchange, real return, failed delivery), and a figure never sits beside another of a different day basis without its basis printed in its label.

## Requirements

**User stories**:

- As the owner, I want to open one page on my phone each morning and see the cash owed to me, how many orders were confirmed yesterday, how many deliveries fail, how today is going, and what is in the pipe, so that I know whether the business is healthy without asking anyone.
- As the owner, I want every number to say which day it counts and whether it is confirmed, live, or provisional, so that I never act on a number that will change under me without knowing.
- As the owner, I want returns split into real returns, cancellations, order edits, exchanges, and failed deliveries, so that the return rate is not inflated by cancelled orders the way Shopify's is.
- As an operations manager, I want the same figures by store, by day, by governorate, and by product, and a tap from any count to the orders behind it, so that I can find and fix where failed deliveries and cancellations come from.
- As the media buyer, I want order counts, confirmations, and order value by placed day for my campaigns, without the brand's cash, so that I can judge my ads.
- As the owner, I want a page that explains each figure in plain words in my language, so that the team and I mean the same thing by "delivered" or "credited by Bosta".

**Acceptance criteria**:

*The dictionary*

- **AC-1** (one definition per figure): every figure shown by the dashboard pages or the daily report is a row of `METRICS` in `packages/contracts/src/reporting/metric-dictionary.ts` with: `key` (`<area>.<name>`, for example `orders.confirmed`), `family` (`marketing`, `operations`, `sales`, or `cash`), `unit` (`count`, `money`, `rate`), `money` (`gross` as the customer paid, including VAT, or `net` after the carrier's fees and their VAT; money metrics only), `basis` (the day it is counted on: `placed_day`, `confirmed_day`, `cancel_day`, `shipped_day`, `returning_day`, `delivered_day`, `lost_day`, `received_day`, `deposit_day`, `cashed_out_day`, `placed_cohort`, `delivered_cohort`, `shipped_window`, or `as_of_instant`), `dataClass` (`own_records` or `third_party_money`, spec 0007 section 3), `readableWith` (the permissions that may read it, AC-20), `source` (the read service and call that supplies it, from [Metric definitions](#metric-definitions)), `excludes`, `groupBy` (the cuts it supports: `store`, `day`, `governorate`, `city`, `style`, `variant`, `agent`, `reason`, `courier`, `campaign`), `drillTo` (the filtered list a count opens, AC-14), and its label (which carries the basis in words, AC-4), short label, and definition as `packages/i18n` keys `reporting.metrics.<key>.*` in English and Arabic. A parity test fails on a metric without both languages, a metric whose `source` names no implemented reader, or a reader with no metric.
- **AC-2** (one reader): `MetricReader.read(keys, query, access)` in `apps/api/src/reporting/` is the only way any page, endpoint, or job reads a figure. It answers one `MetricValue` per key and group with the value, the state of AC-3, the basis, the operating day range it covers, `asOf` (the instant it was read), and for a rate its numerator, denominator, open share, and the flags of AC-11. No controller, page, or job computes a figure itself; a `no-restricted-imports` rule in the api ESLint config refuses an import of another module's read service anywhere in `apps/api/src/reporting/` outside `readers/`.
- **AC-3** (the state of a number, spec 0007 M4, DESIGN.md AC-17): every `MetricValue` carries exactly one `state`: `live` (it covers today's operating day, or it is an `as_of_instant` figure of own records), `provisional` (a closed day or range not yet confirmed for its `dataClass`, or a placed day figure not yet mature, AC-6), `confirmed` (every day of the range is confirmed for its `dataClass` by feature 23's read and, for a placed day figure, mature), or `not_available` (its source is not built yet in this install, or its module is off, with a reason key). A range that mixes confirmed and unconfirmed days answers `provisional` with `confirmedPart` and `provisionalPart` beside the total. An unknown is never answered as zero and never left out: a `not_available` figure has a `null` value and its reason, and the pages print the reason text in its place. `live` and `provisional` are both drawn with the dashed provisional boundary and the leading `≈` of DESIGN.md AC-17; the hidden and visible word says "live" or "provisional", so the two never look like a confirmed number.
- **AC-4** (no figure without its basis, final plan 6.14): every metric's label carries its basis in words ("Order value, by order day", "Credited by Bosta yesterday", "Should come from yesterday's deliveries"), so in Arabic at 320px the basis is part of the label, never a separate chip. Two figures of different `family` or `money` are never added, subtracted, or divided into one figure (`isCombinable` in the dictionary, checked by a contract test over every derived metric), and no line or card puts two figures of different bases side by side with "versus" or a difference between them. A component test renders every dashboard card and report line and fails if a figure is drawn without its metric label.
- **AC-5** (Cairo time and the operating day): every day in a query and an answer is an operating day: a reader uses the owning table's stamped `operating_day` column where one exists and `ssd_operating_day` (the install `timezone`, default `Africa/Cairo`, and `operating_day_cutoff_hour`) otherwise; "today" is `ssd_operating_day(now())` read from the database, never from the browser clock; no code adds 24 hours. A carrier fact counts on the day of its own event time (`occurred_at`), not the day it was recorded. A test reads yesterday and today across the real Cairo daylight saving dates of the release year (spec 0007 m7) and with a cutoff hour of 3.

*The figures (defined in [Metric definitions](#metric-definitions))*

- **AC-6** (the order flow, owner decisions Q-24.1, Q-24.2, Q-24.12, Q-24.15): for a day or range and optionally a store, the reader answers: orders placed and order value by placed day (one population: sale orders received, confirmed duplicates and `reopened_from` orders left out, with the reopened order's value standing for its original's); orders confirmed; orders cancelled, split into before and after confirmation and by reason group; and the parcel counts shipped, delivered (partly delivered inside it and shown), turned back, and lost, which count every parcel of every type (sale, exchange replacement, gifted) with the split by type shown, so "shipped yesterday" matches Bosta's pickups and the airway bill stack. Order value by placed day is the insights 11 definition (lines gross after discounts, including VAT, before shipping, refunds not subtracted) with orders cancelled before shipping shown apart as "cancelled before shipping", so count and value are the same orders; it stays `provisional` until every order of the day has shipped or been cancelled, or `placed_value_maturity_days` (default 3) have passed. Gifted orders are counted in `orders.gifted` and left out of placed, value, and every rate (spec 0002); a line quantity left unshipped by "Post what Shopify fulfilled" counts neither as sold nor in cash expected (spec 0013 Follow-up).
- **AC-7** (each piece in exactly one return kind, final plan 6.14, insights 8): `returns.split` answers, for a range, pieces with their value in five kinds, by this precedence, so each piece lands in one kind and the five sum to the pieces counted: (1) a line in a Shopify edit pair netted by spec 0015 (`ChannelEditNetted`) lands in no kind and is not counted as sold either; (2) a line removed by a person's or the channel's edit while the order went on is an **order edit removal**, split into size swap, out of stock, and customer asked; (3) lines of an order cancelled before shipping are **cancelled**; (4) a piece that came back (`returned`) or was refused (`returned_to_origin` with `size_swap`) on an order with a linked replacement is **exchanged**, counting only the pieces that came back, never the kept lines; (5) any other `returned` piece is a **real return**, counted on the day it is received; (6) any other `returned_to_origin` or `lost` piece is a **failed delivery**. Pieces on their way back (a customer return pickup not yet received) are shown beside the split, not in it. A test sums the kinds over a mixed fixture.
- **AC-8** (cash, owner decision Q-24.14): cash figures never set yesterday's deliveries against money credited for earlier ones. The dictionary holds: `cash.expected` (gross COD the couriers should hand over for deliveries that ended on the day, Bosta from spec 0020 and manual couriers from spec 0019, per courier and store), `cash.carrier_fees` (the carrier's fees and their VAT on those deliveries), `cash.credited` ("credited by Bosta" into the Bosta wallet, spec 0020 AC-16, net, on the deposit day; "received from the courier" for manual couriers), `cash.cashed_out` (wallet to bank on the cash out day, and "cashed out, not yet seen in bank", spec 0020 AC-32), and on `/reports/cash` the cohort view spec 0020 hands over: for deliveries that ended on a day, expected, credited so far, and still owed. Every cash figure is `provisional` until feature 23 closes its period. `sales.delivered_value` (merchandise value of orders delivered on the day, whatever the payment, before shipping) is a `sales` metric, not cash, and the cash page shows it only with the bridge "delivered value plus shipping charged, less prepaid and credit, equals cash expected at the door".
- **AC-9** (cash owed to you): `cash.owed_to_you` is the money collected for the brand and not yet in its bank, as of the instant of reading, gross, with its parts: per Bosta connection, collected and not yet credited plus the wallet balance not yet cashed out (`CarrierSettlementReads.owedByCarrier`), with a negative wallet shown as its own negative line, never silently netted; manual couriers owed (`ManualHandovers.cashSummary`); card gateway payouts `not_available` (reason `gateway_payouts_not_built`); and partners `not_available` (reason `partner_settlement_not_built`) until feature 43. The total's label says what it leaves out ("not counting partners" while that part is `not_available`). Under a store filter, only the parts that carry a store (collected and not yet credited, per delivery) are split; the wallet and cash out parts of an account shared by several stores show as one line "held for all stores, not split", with the account's name, and a test sums the stores plus the unsplit line to the all stores total (spec 0020 AC-15).
- **AC-10** (owed back to customers): `refunds.owed` (spec 0016's one definition: refund records approved or in transit and not confirmed or cancelled, summed by method, with the oldest age) and `refunds.owed_unrecorded` (the count of open `refund.unrecorded_payout` tasks from `TaskQueries.counts`, a count never an amount) are shown side by side while the second is above zero; `exchanges.owed` (owner decision Q-24.10) counts replacements a customer is waiting for: `exchange_replacement` orders not yet delivered, plus size swaps requested on a refusal with no replacement made yet.
- **AC-11** (rates with their honesty flags, owner decision Q-24.13): every rate answers its numerator, denominator, and open count; a group with more than 20 percent of its orders still open is flagged `not_settled`, and a group with fewer than 10 ended orders `few_orders`, as spec 0019 AC-18 defines. The failed delivery rate is spec 0019's order rate, adopted unchanged (size swaps out of both terms, lost shown apart, gifted left out), on the shipped cohort over the last `failed_rate_window_days` operating days (default 30, owner decision Q-24.3; every label that names the window takes it from the setting), with cuts governorate, city, style (piece rate), variant (piece rate), carrier, refusal reason, campaign, and the confirming agent. `returns.real_rate` is a delivered cohort rate: pieces delivered in the window that ended `real_return_maturity_days` ago (default 14), and those same pieces' real returns to date, with the open share; real returns in a week are shown as a count only, never as a percentage of that week's deliveries.
- **AC-12** (confirmation works): `confirmation.rate` and `confirmation.median_minutes_to_confirm` come from `ConfirmationQueries.metrics` (spec 0017 AC-24), which leaves out exchange replacements as this spec does (requested of spec 0017, so the queue's strip and the Today card agree); the agent cut adds, per confirming agent, the delivered and failed delivery rate of the orders that agent confirmed.
- **AC-13** (the placed day cohort, owner decision Q-24.16): `orders.outcome_cohort` answers, for orders placed in a range, how many are now open, kept, cancelled before shipping, failed delivery, refunded, and partly refunded, from `orders.outcome` (spec 0002, the derived outcome), with the open share; `/reports/orders` shows it by placed day beside the event day counts, so the team can follow last week's orders to their end.

*The pages*

- **AC-14** (the Today page): `/today` in the `(backoffice)` frame, one `<h1>` (the brand name), built to DESIGN.md's phone first dashboard (360 by 800, works from 320, no sideways scroll from 320 to 430px), draws top to bottom: the `FreshnessStrip` with two dates ("Orders confirmed through <day>; Bosta money confirmed through <day>; today is live"); the store switcher (All stores, then each store, kept in the URL as `?store=<code>`); the four numbers of spec 0003 owner answer 2: the full width "Cash owed to you" card with its split, two half cards "Confirmed yesterday" and "Failed deliveries, last <window> days", the dashed "Today so far" card (orders placed, confirmed, shipped, and delivered so far today, `live`); then a "Right now" block (`as_of_instant`: orders waiting to confirm with the oldest age, confirmed and not yet shipped with how many are held or short, parcels with the couriers and their COD, parcels on their way back); a "Yesterday" block where each row is its own figure with its basis in the label (orders placed, confirmed, cancelled, parcels shipped, delivered, turned back, "Should come from yesterday's deliveries", "Credited by Bosta yesterday"); a "Where deliveries fail" block (the five governorates and the five styles with the most failed deliveries in the window, ranked by count, each with its rate and flags); the "Returns, split" block of AC-7 for the last 30 days; the `NeedsYouList` of AC-16; and `BottomTabs` (Today, Orders, Cash, More) with its spacer. Cards show whole pounds; drill downs show piasters. The order of the four numbers and of the Yesterday block is the order of the daily report (spec 0024).
- **AC-15** (drill downs, down to the orders): every card and block row is one link: "Cash owed to you" and the cash rows open `/reports/cash` (owed by courier and partner, then expected, fees, credited, and cashed out by day and store, the deliveries cohort view, a `CollapsingTable`); "Confirmed yesterday", "Today so far", the Right now rows, and the Yesterday order rows open `/reports/orders` (the order flow of AC-6 by day for a range of at most 92 days and a store, with its cancellation reasons, the cohort of AC-13, and the confirmation figures of AC-12); the failed delivery card and the Where deliveries fail rows open spec 0019's `/delivery-outcomes` with the matching cut; the returns block opens `/reports/returns` (AC-7 by day and by style). On every report page, a count opens the order list (`/orders`, spec 0013) filtered to exactly the orders it counts (its `drillTo`: store, day on the metric's basis, state, outcome, type, reason); a count whose filter the list does not offer yet shows no link rather than a wrong one. Each report page has a day range picker in operating days, the store switcher, the freshness strip, and its `HelpPanel`.
- **AC-16** (Needs you): the list reads, for the signed in person's hats, at most five rows most urgent first: failed and late write backs (`TaskQueries.counts` for `sync.*`); overdue tasks of the person's hats, and for the manager hat also tasks waiting with no owner and escalated tasks; refunds owed (unrecorded) above zero; Bosta deliveries whose cash cycle is overdue (spec 0018's `cash_cycle_overdue` count); a connection whose health is failing or that needs a sign in or a new app approval, including "Shopify is not being updated" when the stock push has stopped (spec 0011); open stock discrepancies (spec 0011); an Operations license expiry warning (30, 14, 7 days); and a daily report that failed to send (spec 0024). Each row is one sentence with a count and a link; with more, one "N more" link to `/my-work`.
- **AC-17** (live and fresh): the Today page and the report pages read again every 60 seconds while visible and when the page becomes visible again; the strip names "today is live, updated <n> minutes ago"; when any connection's freshness is in warning (spec 0015 AC-18, spec 0018 AC-23) the strip adds "Shopify last checked <n> minutes ago" or the Bosta equivalent in the warning role, so a stale live number never looks current.
- **AC-18** (what each figure means): `/reports/definitions` lists every metric of the dictionary in the reader's language with its label, definition, basis, gross or net, what it leaves out, and its state rule; every report page header has a `HelpPanel` with the definitions of the figures on that page, from the same keys (DESIGN.md AC-21). The definition is reached from the page header, never from inside a card.
- **AC-19** (both languages, both directions): every label, reason, basis, and sentence comes from `packages/i18n` in English and Arabic; numbers use Western digits with `tabular-nums` (DESIGN.md); amounts carry `EGP` and money labels say "including VAT" in the definitions; codes sit in `LtrText`; the pages pass axe in both directions at 360 by 800 with touch and at desk width, and every target is at least 44 by 44px.
- **AC-20** (landing): the manager hat lands on `/today` after sign in, on a phone and at a desk (spec 0016 owner question 3, "the manager keeps the current home until feature 24"); other hats with `reports.view` reach it from the nav; a media buyer reaches `/reports/orders` from the nav; support and warehouse see neither.

*Access, scale, and the module*

- **AC-21** (who sees what, owner decision Q-24.4): each metric's `readableWith` decides, never its family. `reports.view` (operations and manager hats, as built in `packages/contracts/src/access.ts`) reads every metric. `campaigns.view` alone (the media buyer) reads the `marketing` metrics plus orders placed, confirmed, cancelled, the confirmation rate, the placed day cohort, and the failed delivery rate grouped by `campaign` (spec 0019 AC-18), on `/reports/orders`; no cash, sales, owed, or store total figure. Asking for a metric outside `readableWith` answers 403 `METRIC_FORBIDDEN`. No answer carries a customer name, phone, address, or note (Law 151); no figure in slice 1a carries cost or margin, so `cost.view` gates nothing here yet.
- **AC-22** (the module and the lapse, owner decision Q-24.6): a `reporting` module in the registry (`packages/contracts/src/modules/`), bundle `operations`, toggle on, requiring `orders`, with the capability `reporting.dashboard` (`kind: 'read'`, `windDown: 'pre_lapse'`); every controller carries `@Audience('staff')` and `@RequiresCapability('reporting.dashboard')`. While the Operations plan is in its wind down the pages stay readable and show the wind down banner; after the wind down ends or with the module off, the pages answer the module gate's refusal and the nav hides them. A metric whose source module is off answers `not_available` with reason `module_off`, never an error page.
- **AC-23** (scale): with the spec 0002 scale data (150,000 orders, 750,000 settlement lines) and spec 0019's outcome rows, `GET /api/reporting/today` answers in under 800 ms and a 92 day `/api/reporting/metrics` read for one store in under 2 seconds, both at the 95th percentile, in the api scale suite; an owner read service that misses its share of the budget gets an index or a read change in its own module, never a copy table in `reporting` (owner decision Q-24.11).

## Decision

**Chosen option**: Option 1: a typed dictionary in contracts and a `reporting` module that reads each figure at request time from the owning modules' exported read services.

The metric dictionary is data in `packages/contracts/src/reporting/` (keys, family, gross or net, basis, data class, permissions, source, exclusions, cuts, drill filters, label keys); `apps/api/src/reporting/` has one `MetricReader` with one small reader per area that calls the owning module's exported read, applies the state rule from feature 23's confirmed day read, and returns `MetricValue`s; the Today page and the report pages are client components that call `/api/reporting/*` and draw the existing dashboard parts of `@ssdashboard/ui`. Runner up: a reporting owned projection (one fact row per order and day built from domain events), rejected because specs 0019 and 0020 already keep their own projections for exactly these figures, and a second copy would drift from them, which is the failure the real brand lived through (insights section 7, "Numbers contradicted each other").

**Implementation skills**: `nestjs-best-practices` (`.claude/skills/nestjs-best-practices/`) · `nextjs-app-router-patterns` (`.claude/skills/nextjs-app-router-patterns/`) · `tanstack-query` (`.claude/skills/tanstack-query/`) · `shadcn` (`.claude/skills/shadcn/`) · `playwright-best-practices` (`.claude/skills/playwright-best-practices/`)

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

### Where things live

- `packages/contracts/src/reporting/metric-dictionary.ts`: `METRICS` (the rows of AC-1), `MetricKey`, `MetricFamily`, `MetricBasis`, `MetricDataClass`, `MetricState`, `isCombinable(a, b)`; `metric-value.ts`: the Zod schemas `MetricValue`, `MetricQuery`, `TodayAnswer`, `ReportPageAnswer`; `returns-split.ts`: the return kinds, their precedence, and the pure classifier over line facts; `cancel-reason-groups.ts`: `CANCEL_REASON_GROUPS`; their specs beside them, including the parity test of AC-1.
- `packages/i18n/src/locales/en.ts` and `ar.ts`: `reporting.metrics.<key>.{label,short,definition,excludes}`, `reporting.states.*`, `reporting.notAvailable.*`, `reporting.today.*`, `reporting.needsYou.*`, `help.reports.*`.
- `apps/api/src/reporting/`: `reporting.module.ts`; `metric-reader.ts` (`MetricReader`); `readers/<area>.reader.ts` (one file per area: `orders`, `pipeline`, `confirmation`, `deliveries`, `cash`, `sales`, `refunds`, `exchanges`, `returns`, `tasks`, `automation`), each the only place its metrics are computed; `metric-state.ts` (the pure state rule of AC-3); `today.controller.ts`, `metrics.controller.ts`, `definitions.controller.ts`; `needs-you.ts`; `README.md` (Owns, Never touches, How to test, Governing spec, Decisions).
- `apps/web/src/reporting/`: `today-page.tsx`, `orders-report.tsx`, `cash-report.tsx`, `returns-report.tsx`, `definitions-page.tsx`, `store-switcher.tsx`, `day-range-picker.tsx`, `use-metrics.ts` (TanStack Query, 60 second refetch while visible), `README.md`; routes `apps/web/src/app/(backoffice)/today/page.tsx` and `.../reports/{orders,cash,returns,definitions}/page.tsx` (server components render only the frame and the session check).
- `apps/api/eslint.config.js`: the `no-restricted-imports` block of AC-2, scoped to `src/reporting/**` except `src/reporting/readers/**`.

### Data model

None. The reporting module owns no table in this spec (spec 0024 adds `daily_report_runs`). Every figure is read at request time from the module that owns its facts; the settings below are registry rows. This is the point of the design: there is nothing in `reporting` that could disagree with the order page, the delivery outcomes page, or the settlement page.

### Metric definitions

The dictionary at the start. "Orders" means orders of type `sale` unless the row says otherwise; "parcels" means every order that left the warehouse, of any type. Every day is an operating day. Money is in EGP, including VAT.

| Key | Family | Basis | Class | Definition | Leaves out | Source |
|---|---|---|---|---|---|---|
| `orders.placed` | operations | placed day | own | sale orders received on the day | gifted; exchange replacements (Q-24.1); confirmed duplicates (Q-24.2); `reopened_from` orders (their original was counted) | `OrderQueries.dayFigures` (requested) |
| `orders.placed_value` | marketing | placed day | own | lines gross after discounts, before shipping, refunds not subtracted, for the same orders; orders cancelled before shipping shown apart; provisional until mature (AC-6) | as above, a reopened order's value standing for its original | `OrderQueries.dayFigures` |
| `orders.gifted` | marketing | placed day | own | gifted orders and the retail value given away | none | `OrderQueries.dayFigures` |
| `orders.confirmed` | operations | confirmed day | own | sale orders whose `confirmed_at` falls on the day, whoever confirmed them | gifted, duplicates, replacements | `ConfirmationQueries.metrics` |
| `orders.cancelled` | operations | cancel day | own | sale orders cancelled on the day, before or after confirmation, by `CANCEL_REASON_GROUPS`: customer cancelled, no answer, fake, duplicate, wrong details, out of stock, channel cancel, carrier terminated, size swap undone, reopened, other | gifted | `OrderQueries.dayFigures` |
| `orders.outcome_cohort` | operations | placed cohort | own | orders placed in the range by today's outcome (open, kept, cancelled before shipping, failed delivery, refunded, partly refunded) | gifted, replacements, duplicates | `OrderQueries.outcomeFigures` (requested) |
| `pipeline.awaiting_confirmation` | operations | as of instant | own | orders `new`, oldest age | gifted | `ConfirmationQueries` lane counts (spec 0017) |
| `pipeline.confirmed_not_shipped` | operations | as of instant | own | orders `confirmed` or `packed`, of which held or short | none | `OrderQueries.pipelineCounts` (requested) |
| `pipeline.with_courier` | operations | as of instant | own | parcels shipped and not ended, with their COD, per courier | none | `DeliveryOutcomeReads.openCounts` (requested) |
| `pipeline.coming_back` | operations | as of instant | own | parcels turned back and not yet received, and customer return pickups on their way | none | `DeliveryOutcomeReads.openCounts` |
| `parcels.shipped` | operations | shipped day | own | parcels whose shipment day is the day, split by type | none (types shown) | `DeliveryOutcomeReads.dayCounts` (requested) |
| `parcels.delivered` | operations | delivered day | own | parcels that ended delivered or partly delivered on the day | none (types shown) | `DeliveryOutcomeReads.dayCounts` |
| `parcels.turned_back` | operations | returning day | own | parcels turned back to the brand on the day (the flip), refused ones included; a later arrival is not counted again (Q-24.7) | size swaps shown apart | `DeliveryOutcomeReads.dayCounts` |
| `parcels.lost` | operations | lost day | own | parcels that ended lost on the day | none | `DeliveryOutcomeReads.dayCounts` |
| `exchanges.replacements_created` | operations | placed day | own | exchange replacement orders created on the day | none | `OrderQueries.dayFigures` |
| `exchanges.owed` | operations | as of instant | own | replacements not yet delivered, plus refusals with a size swap requested and no replacement | none | `OrderQueries.openReplacements` and `DeliveryOutcomeReads.sizeSwapsWithoutReplacement` (requested) |
| `returns.split` | operations | each kind's day | own | pieces with value in the kinds and precedence of AC-7: edit removal (edit day), cancelled (cancel day), exchanged (received or refused day), real return (received day), failed delivery (returning or lost day) | gifted; netted pairs | `OrderQueries.lineChangeFigures` (requested) and `DeliveryOutcomeReads.dayCounts` pieces without size swaps |
| `returns.real_rate` | operations | delivered cohort | own | AC-11 | gifted | `OrderQueries.lineChangeFigures` over the cohort |
| `deliveries.failed_rate` | operations | shipped window | own | spec 0019 AC-18's order rate; style and variant use its piece rate | gifted, size swaps | `DeliveryOutcomeReads.rates` |
| `confirmation.rate`, `confirmation.median_minutes_to_confirm` | operations | confirmed day | own | spec 0017 AC-24 | gifted, duplicates, replacements | `ConfirmationQueries.metrics` |
| `sales.delivered_value` | sales | delivered day | own | merchandise value (lines gross) of parcels delivered on the day, any payment, before shipping | gifted | `OrderQueries.deliveredValue` (requested, by the delivery day `DeliveryOutcomeReads` answers) |
| `cash.expected` | cash, gross | delivered day | third party | COD collected at the door for deliveries ended on the day, per courier and store | gifted, fully prepaid | `CarrierSettlementReads.cashExpectedVersusRemitted`, `ManualHandovers.cashSummary` |
| `cash.carrier_fees` | cash, gross | delivered day | third party | carrier fees and their VAT on those deliveries | none | `CarrierSettlementReads` (period totals by final state day) |
| `cash.credited` | cash, net | deposit day | third party | credited by Bosta into the wallet; received from manual couriers | none | as above |
| `cash.cashed_out` | cash, net | cashed out day | third party | wallet cash outs to the bank, and cashed out not yet seen in bank | none | `CarrierSettlementReads.cashOutReceipts` |
| `cash.owed_to_you` | cash, gross | as of instant | third party | AC-9 | none | `CarrierSettlementReads.owedByCarrier`, `ManualHandovers.cashSummary`; gateways and partners `not_available` |
| `refunds.owed` | cash, gross | as of instant | own | spec 0016's definition, by method, oldest age | none | the credit module's refunds read; `not_available` until it exists |
| `refunds.owed_unrecorded` | operations | as of instant | own | count of open `refund.unrecorded_payout` tasks | none | `TaskQueries.counts` |

Rules every reader keeps: a figure is counted on exactly one basis day; a reader never reads another module's table; a count that needs a fact a module does not answer is a requested read in that module (below), never a join from here.

### State rule

`metricState(range, metric, today, confirmedThrough, maturity)` in `metric-state.ts` is pure: `live` when the range is only today or the metric is an own records `as_of_instant` figure; `confirmed` when every day of the range is on or before `confirmedThrough[dataClass]` for the scope (store for own records, settlement account for third party money) and, for a placed day value, mature; `provisional` otherwise, with the split into confirmed and provisional parts done by asking the reader twice. Third party `as_of_instant` figures are `provisional` unless every period they read is closed. `not_available` comes from the reader, never from the rule. A fact that arrives late for a confirmed day is feature 23's to handle (it reopens the day or records the late fact on it); the rule only reads the result.

### API surface

All routes `@Audience('staff')`, `@RequiresCapability('reporting.dashboard')`; permission per metric (`readableWith`, AC-21).

| Endpoint | Method | Key inputs | Key outputs | Permission | Key errors |
|---|---|---|---|---|---|
| `/api/reporting/today` | GET | `store?` (store code) | `TodayAnswer`: `today`, `confirmedThrough` (per class), `freshness[]`, `owed` (total and parts), `confirmedYesterday`, `failedRate`, `todaySoFar`, `rightNow[]`, `yesterday[]`, `failWorst` (governorates, styles), `returnsSplit`, `needsYou` (rows, total), each figure a `MetricValue` with its `drillTo` | `reports.view` | 400 `INVALID_QUERY`, 404 `STORE_NOT_FOUND` |
| `/api/reporting/metrics` | GET | `keys[]` (at most 20), `dayFrom`, `dayTo` (at most 92 days, 366 for rates), `store?`, `groupBy?` | `MetricValue[]` per key and group | per metric | 400 `INVALID_QUERY`, `RANGE_TOO_LONG`, `GROUP_NOT_SUPPORTED`; 403 `METRIC_FORBIDDEN` |
| `/api/reporting/definitions` | GET | none | the dictionary rows the caller may read | `reports.view` or `campaigns.view` | none |

The labels are rendered by the web from the keys; the api answers no prose except reason codes.

### Value sourcing

| Action | Value produced or displayed | Source |
|---|---|---|
| any read | today's operating day | `SELECT ssd_operating_day(now())` (install `timezone`, `operating_day_cutoff_hour`, spec 0007 section 10) |
| any read | the confirmed through day per data class and scope | feature 23's `ConfirmedDays.confirmedThrough` (requested of spec 0022); until it exists every closed day is `provisional` |
| any read | the store list and codes | `ChannelsService` (built) |
| every figure | value, numerator, denominator, open count | the source column of [Metric definitions](#metric-definitions) |
| every figure | label with basis, definition, exclusions, gross or net | `METRICS` row and its `reporting.metrics.<key>.*` keys |
| every count | its drill filter | `METRICS.drillTo`, mapped to spec 0013's `OrderListQuery` (with the event day filters requested below) |
| `orders.cancelled` | reason group, before or after confirmation | `CANCEL_REASON_GROUPS` over spec 0013 and 0017 cancel reason codes (a code with no group fails a parity test); `confirmed_at` set or not |
| `orders.placed_value` | maturity | setting `placed_value_maturity_days`; the day's orders' fulfillment states from `OrderQueries.dayFigures` |
| `returns.split` | the kind of each piece | `returns-split.ts` over line facts from `lineChangeFigures` (line state, netted flag, edit origin and reason, replacement link per returned quantity) |
| `returns.real_rate` | the cohort window | setting `real_return_maturity_days` and the rate window |
| `deliveries.failed_rate` | the window | setting `failed_rate_window_days` |
| flags | `not_settled`, `few_orders` thresholds | spec 0019 AC-18, answered by `DeliveryOutcomeReads.rates` |
| `failWorst` | which five governorates and styles | `DeliveryOutcomeReads.rates` grouped by `governorate` and `style`, sorted by failed count, the rate beside |
| `cash.owed_to_you` | parts and the store split | one per live Bosta settlement account (`CarrierSettlementReads.owedByCarrier`, its store split from per delivery amounts, the wallet part unsplit), one per manual courier kind (`ManualHandovers.cashSummary`), gateway and partner lines `not_available` |
| `needsYou` | rows | `TaskQueries.counts(now, …)` for the person's hats (unowned and escalated for the manager); `CarrierDeliveries` attention counts; `ConnectorsService.freshness` health; spec 0011's stock push state and discrepancy count (`OnlineStockService`, requested count); `LicenseService` expiry; spec 0024's `DailyReportRuns.lastFailed` |
| freshness | last sweep and last change per connection | `ConnectorsService.freshness` (spec 0015 AC-18, spec 0018 AC-23) |
| the page | the signed in person's hats and permissions | the session (spec 0008) |
| the page | language and direction | the user's saved language (spec 0004) |
| amounts | currency and rounding | `currency` setting (EGP), `Money` (2 decimals, as built); cards round to whole pounds |

### Requested reads from other modules (each owner builds its own; none reads a table across modules)

| Owner | Read | Answers |
|---|---|---|
| orders (spec 0013) | `OrderQueries.dayFigures({ dayFrom, dayTo, storeId? }, groupBy)` | per day: sale orders placed (duplicates and `reopened_from` left out), placed value (cancelled before shipping apart), how many of the day's orders are still unshipped and uncancelled, cancelled by reason code and before or after confirmation, gifted count and retail value, replacements created |
| orders | `OrderQueries.lineChangeFigures({ dayFrom, dayTo, storeId?, groupBy })` | per piece fact: line state and day, netted (from `ChannelEditNetted`, which orders records on the lines), edit origin and reason, and the replacement link per returned or refused quantity |
| orders | `OrderQueries.outcomeFigures({ placedFrom, placedTo, storeId? })` | orders placed in the range by `outcome` |
| orders | `OrderQueries.pipelineCounts({ storeId? })`, `OrderQueries.openReplacements({ storeId? })`, `OrderQueries.deliveredValue({ orderIds })` | counts of `new`, `confirmed`, `packed` (held, short); replacements not yet delivered; lines gross of given orders |
| orders | `OrderListQuery` gains `confirmedDay`, `cancelledDay`, `reason`, `type` filters (the list already has store, states, outcome, and placed day) | the drill downs of AC-15 |
| deliveries (spec 0019) | `DeliveryOutcomeReads.dayCounts`, `openCounts`, `sizeSwapsWithoutReplacement` | per day: shipped, delivered, partly delivered, turned back, lost, by type, with pieces (size swap pieces apart); now: with courier (COD per courier), coming back; size swaps with no replacement |
| confirmation (spec 0017) | `ConfirmationQueries.metrics` leaves out exchange replacements; lane counts with the oldest age | AC-12 and `pipeline.awaiting_confirmation` |
| tasks (spec 0016) | the `exchange_made_in_shopify` outcome links the replacement order (`relatedOrder`) when its number is entered | so an exchange made in Shopify is counted as an exchange, not a sale (Q-24.1) |
| period close (spec 0022) | `ConfirmedDays.confirmedThrough({ dataClass, scope })` | the last operating day confirmed for own records per store and for third party money per settlement account, and whether a range holds a revoked day |
| connectors (specs 0015, 0018) | `ConnectorsService.freshness()` | per connection: kind, label, health, reason code, last change, last successful sweep, warning flag |
| inventory (spec 0011) | a count of open stock discrepancies and the stock push state | the Needs you rows |

### Settings (rows for spec 0009's registry; Operations bundle, group Reports, `settings.manage`, reason optional)

| Key | Default | Allowed |
|---|---|---|
| `failed_rate_window_days` | 30 | integer 7 to 90 |
| `real_return_maturity_days` | 14 | integer 7 to 60 |
| `placed_value_maturity_days` | 3 | integer 1 to 14 |

`operating_day_cutoff_hour` (built) gains a line in its warning: changing it after go live moves the day of new records only; stamped days of older records stay, so figures across the change date are not comparable.

### Contracts with other specs

- **Feature 23 (spec 0022)**: this spec asks it to own the confirmation of own records days as well as third party money periods (owner decision Q-24.5), and to export `ConfirmedDays.confirmedThrough`, so "confirmed" has one owner. Reporting never writes a confirmation and never decides one.
- **Spec 0019**: feature 24 adopts the order and piece rates of AC-18, the size swap rule, returning from the flip, and adds the confirming agent cut, as its Follow-up asks; `/delivery-outcomes` stays spec 0019's page and is the failed delivery drill down.
- **Spec 0020**: the totals grouped by the delivery's final state day and the Other couriers view it hands to feature 24 (*Later than slice 1a*) are served by `/reports/cash` reading `CarrierSettlementReads` and `ManualHandovers`; the settlement pages stay spec 0020's.
- **Spec 0016**: the manager's landing page becomes `/today` (owner question 3); "refunds owed" and "refunds owed (unrecorded)" are read as that spec defines them.
- **Spec 0013**: its Follow-up for feature 24 is taken: line states are read with the fulfillment state, gifted is left out, a `reopened_from` order counts as the sale, and an unshipped quantity counts neither as sold nor as cash expected. Its loss at `unit_cost` for closed awaiting quantities waits for cost figures (Follow-up).
- **Spec 0024**: reads every figure through `MetricReader` in the worker and draws its lines in the order of AC-14.

### Key invariants

- A figure is defined only in `METRICS` and computed only in its reader; the parity test and the import rule of AC-2 hold it.
- Reporting owns no table and writes nothing (spec 0024's run table aside).
- An unknown is `not_available` or `provisional` with its value, never zero (spec 0007 M4).
- Each piece lands in at most one return kind, and the kinds sum to the pieces counted.
- Two figures of different bases, families, or gross and net are never combined or set against each other on one line.
- No answer from `reporting` holds personal data.

### Security model

Staff audience only; per metric permissions (AC-21); the tenant comes from the install (one stack per brand). Answers are aggregates with no personal data, so nothing new reaches logs; the reader passes the person's `Access` to owners whose reads filter by permission. No write route, so no audit entry.

### Configuration required

No new environment variable or credential.

### Critical test scenarios

- Thread: three sale orders placed yesterday in Cairo (one at 23:50 local on a daylight saving change day), one gifted, one duplicate, one reopened from a cancelled one; `/today` shows 3 placed yesterday marked provisional before feature 23 confirms and confirmed after (value confirmed only once mature), the gifted one only in gifted, verifies **AC-1**, **AC-3**, **AC-5**, **AC-6**, **AC-14**.
- Returns over one fixture: a netted Shopify edit pair, a size change by edit, a cancelled order, a kept two of three with the third swapped and its pickup received, a refusal with a size swap, a returned to origin parcel, and a piece returned after delivery with no replacement: each piece in one kind, the kinds sum to the pieces, only the last a real return, verifies **AC-7**.
- A slow week after a busy one: the real return rate stays under 100 percent and is flagged not settled for the recent cohort, verifies **AC-11**.
- Cash: yesterday's deliveries of 48,200 gross and Bosta's credit of 12,900 net for last week show on two rows with their own labels and no "versus"; one Bosta account for two stores: the store filter shows the wallet as "held for all stores, not split", and stores plus the unsplit line equal the total, verifies **AC-4**, **AC-8**, **AC-9**.
- A source not built (credit refunds) shows "not available yet" in both languages, never 0; a module toggled off answers `module_off`, verifies **AC-3**, **AC-9**, **AC-10**, **AC-22**.
- A media buyer reads orders placed, value, and the campaign failed rate, and gets 403 `METRIC_FORBIDDEN` for `cash.expected`; a support agent opening `/today` gets the permission refusal, verifies **AC-21**.
- Tapping "Cancelled yesterday: 7" opens `/orders` with exactly those 7 orders, verifies **AC-15**.
- At 360 by 800 and at 320 in Arabic: no sideways scroll, targets at least 44px, axe clean, every label carries its basis, verifies **AC-14**, **AC-19**.
- Shopify sweep 20 minutes old: the strip shows the warning while today's number stays `live`, verifies **AC-17**.
- Scale suite: `/api/reporting/today` under 800 ms p95, verifies **AC-23**.

## Build plan

Tracer bullet: milestone 1 is one real figure through every layer (dictionary row, owner read, reader, state rule, endpoint, page, both languages, phone); each later milestone thickens one segment end to end. Milestones 2 to 4 each wait for the owning spec's read they need; until then the figure is `not_available`, which milestone 1 already draws.

1. **One figure, end to end.** The `reporting` module row in the registry with `reporting.dashboard`; `metric-dictionary.ts` and `metric-value.ts` with `orders.placed` and `orders.confirmed`, the parity test, `readableWith`, and `isCombinable`; `metric-state.ts` with its tests across Cairo daylight saving and a cutoff hour of 3 (feature 23's read stubbed as "nothing confirmed", so closed days are `provisional`); `OrderQueries.dayFigures` (orders' task, placed with duplicates and reopened orders left out) and the `ConfirmationQueries.metrics` call; `MetricReader` with the `orders` and `confirmation` readers; `GET /api/reporting/today` with "Confirmed yesterday" and "Today so far" and every other figure `not_available`; the `/today` page with header, freshness strip, store switcher, the four cards, `BottomTabs` and spacer, both languages, at 360 by 800; the manager lands there; the import rule of AC-2, satisfies **AC-1**, **AC-2**, **AC-3**, **AC-5**, **AC-14**, **AC-19**, **AC-20**, **AC-21**, **AC-22**.
2. **The order flow, the pipeline, and the returns split.** `OrderQueries.dayFigures` in full, `lineChangeFigures` (with the netted lines recorded from `ChannelEditNetted`), `outcomeFigures`, `pipelineCounts`, `openReplacements`, and the event day list filters; `DeliveryOutcomeReads.dayCounts`, `openCounts`, and `sizeSwapsWithoutReplacement` (spec 0019's tasks); the `orders`, `pipeline`, `deliveries`, `returns`, `exchanges` readers; `returns-split.ts` with its precedence tests; `CANCEL_REASON_GROUPS` with its parity test; the Right now and Yesterday blocks, the failed delivery card, Where deliveries fail, Returns split; `/reports/orders` with the cohort and `/reports/returns`; the drill downs to `/orders`; `GET /api/reporting/metrics`, satisfies **AC-4**, **AC-6**, **AC-7**, **AC-10** (exchanges), **AC-11**, **AC-12**, **AC-13**, **AC-15**.
3. **Cash and confirmed days.** After specs 0020 and 0022: the `cash` and `sales` readers over `CarrierSettlementReads`, `ManualHandovers`, and `deliveredValue`; `cash.owed_to_you` with its parts, the store split, and the `not_available` lines; the `refunds` reader (`TaskQueries.counts` now, the credit read when it lands); feature 23's `ConfirmedDays` replaces the stub and the confirmed and provisional parts split; the two date freshness strip; `/reports/cash` with the deliveries cohort view and the bridge, satisfies **AC-3**, **AC-8**, **AC-9**, **AC-10**, **AC-15**.
4. **Needs you, freshness, definitions, and scale.** `ConnectorsService.freshness`; the `tasks` and `automation` readers and `needs-you.ts`; the 60 second refetch and the freshness warnings; `/reports/definitions` and the `HelpPanel`s; the confirming agent and campaign cuts; the media buyer's page; the Playwright pass at 360 by 800 with touch in both languages and at desk width; the api scale suite case, satisfies **AC-11**, **AC-16**, **AC-17**, **AC-18**, **AC-19**, **AC-21**, **AC-23**.

## Consequences

**Positive**:

- One definition per figure, one reader, and no copy of anyone's data, so the dashboard, the daily report, the order page, the delivery outcomes page, and the settlement page cannot disagree.
- A figure whose source is not built yet still has a place on the page and says so, so slice 1a can ship the page before the credit slice and partner settlement exist.
- Each returned piece is in one kind and every count opens its orders, so the team can act on a number, not just read it.
- Adding a figure later (campaign profit, the exchange dashboard) is a dictionary row, a reader, and both languages; the page and the report pick it up.

**Negative / tradeoffs**:

- Every read fans out to several modules at request time; it is fast at a few hundred orders a day, and the scale budget is the guard, but a slow owner read slows the Today page.
- The feature waits on reads from seven other modules (orders, confirmation, deliveries, settlement, period close, connectors, inventory) and a small change in tasks; milestones 2 and 3 cannot finish before specs 0019, 0020, and 0022 build theirs.
- No figure carries cost or margin in slice 1a, so the owner's first dashboard has no profit number; margin needs cost coverage first (final plan 6.10).
- A day's figures can still change after they show `confirmed` if feature 23 revokes the day, and order value by placed day stays provisional for up to three days; both are honest but take a sentence of explaining to the owner.
- An exchange made in Shopify whose replacement number is never entered counts as a sale and its old piece as a real return; the figure is only as good as that link.

**Neutral**:

- `DESIGN.md`'s phone first dashboard section describes the first four cards; the blocks below them (Right now, Yesterday, Where deliveries fail, Returns split) are new compositions of the built parts, not new components.
- The api scale suite gains one case.

## Follow-up

- [ ] Spec 0022 (feature 23, lane B): own the own records day confirmation as well as third party money periods, and export `ConfirmedDays.confirmedThrough` (owner decision Q-24.5); a hand over note is in the shared notes folder.
- [ ] Spec 0013 (orders): add the reads and list filters of *Requested reads* to its exported read table, and record `ChannelEditNetted` on the lines.
- [ ] Spec 0017: leave exchange replacements out of `ConfirmationQueries.metrics`, and answer lane counts with the oldest age.
- [ ] Spec 0016: link the replacement order on `exchange_made_in_shopify` when its number is entered.
- [ ] Spec 0019: add `DeliveryOutcomeReads.dayCounts`, `openCounts`, and `sizeSwapsWithoutReplacement` beside `rates`.
- [ ] Specs 0015 and 0018: export `ConnectorsService.freshness()` (the data already exists for the shell's freshness line).
- [ ] Spec 0011: a count of open stock discrepancies and the stock push state for Needs you.
- [ ] `packages/ui/DESIGN.md` (ui designer): record that a `live` value is drawn like a provisional one with the word "live", and the blocks below the four cards, once milestone 2 is built.
- [ ] Feature 47 onwards: margin, campaign profit, and spec 0013's closed awaiting quantities as a loss at `unit_cost` join the dictionary with a `cost.view` gate and the "not set" rule of final plan 6.10.
- [ ] Feature 28 (credit ledger): add "store credit outstanding" to the cash page when the ledger exists.
- [ ] The consignment module (feature 43): replace the partner `not_available` line with partner settlement's owed read.
- [ ] `/sync` after the build: the `reporting` entry in the root `AGENTS.md` module list moves from planned to built.

## Domain review applied

domain-metric-dictionary (kept private) (accept with changes: 0 blockers, 14 majors, 16 minors). Every finding is folded in:

| Finding | Where it landed |
|---|---|
| M1 netted edit pairs reach the lines | AC-7 rule (1); `lineChangeFigures` answers the netted flag; spec 0013 records `ChannelEditNetted` (Follow-up) |
| M2 one piece in two kinds | AC-7 precedence, replacement link per returned quantity, the sum test |
| M3 real return rate over two cohorts | AC-11 delivered cohort with `real_return_maturity_days`; weekly returns as a count only; the basis list of AC-1 |
| M4 expected and remitted are different money | AC-8 (`cash.expected`, `cash.carrier_fees`, `cash.credited`, `cash.cashed_out`, the cohort view), AC-4 no "versus", Q-24.14 |
| M5 delivered value is not cash | `sales.delivered_value` in a `sales` family, the bridge on the cash page |
| M6 placed count and value disagree, value moves, reopened orders | AC-6 one population, maturity with `placed_value_maturity_days`, `reopened_from` rule, Q-24.15 |
| M7 replacements left out only when linked | AC-12 (spec 0017 leaves them out), spec 0016 links the replacement, a Consequence named |
| M8 operations counts drop real parcels | `parcels.*` count every type with the split, Q-24.12 |
| M9 not a funnel, no cohort | AC-13 `orders.outcome_cohort` on `/reports/orders`; each Yesterday row labelled as its own figure; Q-24.16 |
| M10 the morning pipeline | AC-14 Right now block (`pipeline.*`); AC-16 stock push and discrepancies |
| M11 rate first ranking | AC-14 ranked by count, rate beside; Q-24.13 |
| M12 cash per store with one account | AC-9 store split rule and its sum test |
| M13 family is not a permission | AC-1 `readableWith`, AC-21, AC-20, Q-24.4 changed |
| M14 drill downs end at totals | AC-15 counts open the order list with `drillTo`; requested list filters |
| m1 live versus provisional look | AC-3 drawing rule; DESIGN.md Follow-up |
| m2 one confirmed date | AC-14 strip with two dates |
| m3 basis list | AC-1 bases (cancel, delivered, lost, received, cashed out, cohorts) |
| m4 cancel groups, before or after confirmation | `orders.cancelled` groups and split |
| m5 edit removal split | AC-7 rule (2) |
| m6 real return day, returns on the way | AC-7 received day; pieces on their way shown beside |
| m7 Follow-ups to feature 24 | Contracts with spec 0013; AC-6 unshipped quantity; Follow-ups for loss at cost and store credit |
| m8 exchanges owed until delivered | AC-10 |
| m9 owed total honesty | AC-9 label, negative wallet line, gateway line |
| m10 Arabic at 320, whole pounds | AC-4 basis inside the label; AC-14 whole pounds on cards |
| m11 window label from the setting | AC-11, AC-14 |
| m12 cutoff hour changed after go live | AC-5 stamped columns; the warning line under Settings |
| m13 which time counts, late facts | AC-5 event time; State rule (feature 23 handles late facts) |
| m14 today's shipped and delivered | AC-14 Today so far |
| m15 including VAT | AC-1 `money`, AC-19 |
| m16 Needs you for an owner | AC-16 unowned and escalated tasks for the manager |

## Owner decisions

The architect wrote this spec without the owner and recorded each question with its options and a recommended answer. The owner answered all of them on 2026-11-13 (owner ruling 2026-11-13): every recommendation is ratified.

1. **Q-24.1 Do exchange replacements count as orders?** (a) No: they are counted in "exchanges" and left out of orders placed, order value, and the confirmation rate; an exchange made in Shopify counts as one once its replacement number is entered. (b) Yes, as orders like any other. **Answered (owner ruling 2026-11-13): (a), as recommended**: a replacement is not new demand, and counting it as an order makes a bad exchange week look like a good sales week.
2. **Q-24.2 Which orders are "orders placed"?** (a) Every sale order received, except confirmed duplicates and orders reopened from a cancelled one; cancelled and fake orders stay counted and their cancellations show beneath. (b) Only orders that were confirmed. (c) Every order received, duplicates included. **Answered (owner ruling 2026-11-13): (a), as recommended**: the owner sees demand and then what the team lost of it; (b) hides the cancellation problem, (c) counts one customer's double tap twice.
3. **Q-24.3 Which failed delivery rate is the half card?** (a) The last 30 days of shipped orders, with the open share. (b) Yesterday's shipped orders. (c) This month so far. **Answered (owner ruling 2026-11-13): (a), as recommended**: a day is too few orders and its failures are not known yet. The window is a setting (7 to 90 days).
4. **Q-24.4 Who sees the dashboard?** (a) Everyone with `reports.view` (operations and manager hats) sees everything; the media buyer sees order counts, confirmations, order value, and failed deliveries by campaign, no cash. (b) The manager hat only. **Answered (owner ruling 2026-11-13): (a), as recommended**: operations needs the failed delivery and cash figures daily; the media buyer needs counts to judge ads but not the brand's cash.
5. **Q-24.5 Who confirms a day of the app's own records (orders, confirmations, shipments)?** (a) Feature 23 (spec 0022), the same place that confirms third party money, after the day closes and the sweep agrees (spec 0007 section 3). (b) The reporting module, with feature 23 only for money. **Answered (owner ruling 2026-11-13): (a), as recommended**: one owner for "confirmed".
6. **Q-24.6 What happens to the dashboard when the Operations plan lapses?** (a) It stays readable through the wind down with the wind down banner, then stops with the module. (b) It becomes core and never stops. (c) It stops at the lapse. **Answered (owner ruling 2026-11-13): (a), as recommended**: the owner needs the numbers most while winding down.
7. **Q-24.7 On which day does a failed delivery count?** (a) The day Bosta turns the parcel back (the flip), as spec 0019 counts failures. (b) The day it reaches the warehouse. **Answered (owner ruling 2026-11-13): (a), as recommended**: the owner learns of the failure the day it happens.
8. **Q-24.8 Partners in slice 1a.** (a) A line saying partner figures arrive with partner settlement, in Cash owed and in the Yesterday block. (b) No partner lines until feature 43. **Answered (owner ruling 2026-11-13): (a), as recommended**: the owner sees that partner cash is missing rather than thinking it is zero.
9. **Q-24.9 Does your day end at midnight?** The operating day already has a cutoff hour setting (default midnight). **Answered (owner ruling 2026-11-13): keep midnight, as recommended** unless the brand counts late night orders as the day before; set it before go live, because changing it later makes days before and after the change not comparable.
10. **Q-24.10 What is an "exchange owed"?** (a) Replacements not yet delivered, plus size swaps requested on a refusal with no replacement made. (b) Also open support cases that may end in an exchange. **Answered (owner ruling 2026-11-13): (a), as recommended**: a case is not yet an exchange.
11. **Q-24.11 If a figure is too slow, may reporting keep its own copy?** (a) No; the owning module adds an index or a faster read. (b) Yes, a reporting projection. **Answered (owner ruling 2026-11-13): (a), as recommended**: a copy is how the real brand's pages came to contradict each other.
12. **Q-24.12 Do shipped, delivered, and failed count parcels or sales?** (a) Parcels: every order that left, sales, replacements, and gifts, with the split shown; rates stay on sales as spec 0019 defines. (b) Sales only. **Answered (owner ruling 2026-11-13): (a), as recommended**: "shipped yesterday" must match Bosta's pickups and the warehouse's airway bills.
13. **Q-24.13 How is "where deliveries fail" ranked?** (a) By the number of failed deliveries, with the rate beside. (b) By the rate. **Answered (owner ruling 2026-11-13): (a), as recommended**: a small governorate with 3 of 5 failed should not hide Cairo's 120.
14. **Q-24.14 What does "remitted" mean?** (a) Credited by Bosta into the Bosta wallet, net of fees, with fees, cash outs to the bank, and "cashed out, not seen in bank" on their own lines, and gross COD for expected and owed. (b) Arrived in the bank. **Answered (owner ruling 2026-11-13): (a), as recommended**: spec 0020 already defines remitted as the wallet credit; the bank step is shown, not hidden.
15. **Q-24.15 When is a day's order value final?** (a) Once every order of the day has shipped or been cancelled, or after 3 days. (b) At the day's close. **Answered (owner ruling 2026-11-13): (a), as recommended**: pre shipping cancellations keep lowering it for a few days, so calling it confirmed at the close would be wrong.
16. **Q-24.16 Should the placed day cohort be on the dashboard?** (a) On the orders report page, one tap from the Today page. (b) On the first screen. **Answered (owner ruling 2026-11-13): (a), as recommended**: the first screen keeps the four agreed numbers and the morning blocks; the cohort is the follow up question.
