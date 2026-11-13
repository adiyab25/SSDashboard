# Verify: metric dictionary and phone dashboard · spec 0023 · written 2026-11-13

_Steps derived from spec 0023's acceptance criteria and its Value sourcing table, revised the same day for the [domain review](../../reviews/domain-metric-dictionary.md). `/check verify` runs these; `/test` locks the durable ones. Run each on a phone sized window (360 by 800, touch) and at desk width, in Arabic and in English._

## UI / manual

Milestone 1:

- [ ] Sign in with the manager hat → you land on `/today`, one heading with the brand name, the freshness strip under it → AC-14, AC-20
- [ ] Place three sale orders yesterday (one at 23:50 Cairo), one gifted, one cancelled as duplicate, and one reopened from a cancelled order → "Confirmed yesterday" and the Yesterday block count the three, marked provisional (dashed, `≈`) while nothing is confirmed; the gifted order appears only under gifted → AC-3, AC-6
- [ ] Place two orders now → "Today so far" shows them dashed with the word "live" and "updated less than a minute ago" → AC-3, AC-17
- [ ] Switch the store to one store → every figure narrows to it and the URL holds `?store=<code>`; reload keeps it → AC-14
- [ ] The cash and failed delivery cards before their sources exist → each says "not available yet" with its reason, never 0 → AC-3
- [ ] Sign in as support or warehouse → `/today` is not in the nav, and opening it is refused → AC-20, AC-21
- [ ] At 320px wide in Arabic → no sideways scroll, every label carries its day basis in words, the tab bar never covers a target, every card is one link → AC-4, AC-14, AC-19

Milestones 2 to 4:

- [ ] One fixture with a netted Shopify edit pair, a size change by edit, a cancel before shipping, a kept two of three with the third swapped and received back, a refusal with a size swap, a returned to origin parcel, and a piece returned after delivery with no replacement → Returns, split puts each piece in one kind, the kinds add up to the pieces, and only the last is a real return → AC-7
- [ ] The Right now block shows orders waiting to confirm with the oldest age, confirmed and not shipped (held, short), parcels with the couriers and their COD, and parcels coming back → AC-14
- [ ] Tap "Cancelled yesterday" → `/orders` opens with exactly those orders → AC-15
- [ ] Tap "Failed deliveries, last 30 days" → `/delivery-outcomes` opens on the shipped cohort with the same rate; Where deliveries fail lists Cairo above a small governorate with a higher rate; a governorate with 8 ended orders shows "few orders" → AC-11, AC-14, AC-15
- [ ] Change `failed_rate_window_days` to 14 → the card says "last 14 days" → AC-11
- [ ] Open `/reports/orders` for a 92 day range → loads with the placed day cohort; 93 days → refused with "range too long" → AC-13, AC-15
- [ ] Yesterday shows "Should come from yesterday's deliveries" and "Credited by Bosta yesterday" as two rows, never one line with "versus" → AC-4, AC-8
- [ ] "Cash owed to you" lists each Bosta connection, manual couriers, card gateways and partners as "not available yet", and says it does not count partners; with one Bosta account for two stores, filter by a store → the wallet shows "held for all stores, not split" → AC-9
- [ ] After feature 23 confirms yesterday → the order counts turn solid (confirmed); order value stays provisional until its orders shipped or were cancelled; a range across confirmed and unconfirmed days shows both parts; the strip shows both confirmed dates → AC-3, AC-6, AC-14
- [ ] An open `refund.unrecorded_payout` task → Needs you shows "1 refund owed, not recorded" and the cash page shows it beside refunds owed → AC-10, AC-16
- [ ] Stop the Shopify sweep for 20 minutes → the freshness strip warns "Shopify last checked 20 minutes ago" → AC-17
- [ ] Open `/reports/definitions` → every figure with its definition, basis, gross or net, and exclusions in your language → AC-18
- [ ] Sign in as a media buyer → `/reports/orders` shows orders placed, value, confirmations, and failed deliveries by campaign; `/api/reporting/metrics?keys=cash.expected…` → 403 `METRIC_FORBIDDEN` → AC-20, AC-21
- [ ] Lapse the Operations plan in a test install → the pages stay readable with the wind down banner; after the wind down ends they are refused → AC-22

## Automated

- [ ] `pnpm --filter @ssdashboard/contracts test -- src/reporting` → the dictionary parity test (labels in both languages, a reader per metric, `readableWith` set), the combinable test, the return precedence and sum tests, the cancel reason group parity → AC-1, AC-4, AC-7
- [ ] `pnpm --filter @ssdashboard/api test -- src/reporting` → the state rule across the Cairo daylight saving dates of the release year and with a cutoff hour of 3, the maturity of placed value; each reader against stubbed owner reads; the real return cohort stays under 100 percent in a slow week after a busy one; the store split sums to the total → AC-3, AC-5, AC-6, AC-9, AC-11
- [ ] `pnpm lint` → an import of `OrderQueries` in a reporting controller fails the restricted import rule → AC-2
- [ ] `pnpm --filter @ssdashboard/web test -- src/reporting` → every card and block row renders its metric label; axe in both directions → AC-4, AC-19
- [ ] `pnpm test:e2e` → the Today thread above in both languages at 360 by 800 with touch → AC-14, AC-19
- [ ] `pnpm --filter @ssdashboard/api test:scale` → `/api/reporting/today` under 800 ms and a 92 day read under 2 s at p95 → AC-23
