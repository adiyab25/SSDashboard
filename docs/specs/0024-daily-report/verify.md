# Verify: daily report · spec 0024 · written 2026-11-13

_Steps derived from spec 0024's acceptance criteria and its Value sourcing table, revised the same day for the domain review (kept private). `/check verify` runs these; `/test` locks the durable ones. Telegram is replaced by its recorded fixtures in tests; the manual steps use a test bot and a test group, never the brand's real group._

## UI / manual

Milestone 1:

- [ ] As a manager, open `/connections/new?provider=telegram`, paste a test bot token → the screen shows "set" and its last 4 characters; a wrong token → "Telegram refused this token" → AC-8
- [ ] Add a new test bot to a test group (privacy mode on), type the shown `/start@<bot>` in a topic, tap "Find the group" → the group and that topic are listed with the member count and the cash warning; send `/start` to the bot privately → the private chat is offered as the owner chat; pick both, tap "Send a test message" → one line in each → AC-8
- [ ] Paste the token of a bot another program polls → "make a new bot for the report" (`BOT_IN_USE_ELSEWHERE`) → AC-8
- [ ] Set `daily_report_time` to two minutes from now → one message arrives with the brand name, yesterday's day in the report's language, "confirmed yesterday", and the link to `/today`; `/reports/daily` lists the run `sent` → AC-1, AC-4, AC-11
- [ ] Switch `daily_report_language` to Arabic and send today's report again on a new day → the Arabic text reads right to left with amounts and times in the right order → AC-6
- [ ] Sign in as operations → `/reports/daily` readable, Send again not offered; as support → refused → AC-13

Milestones 2 to 4:

- [ ] With every source built, the message follows the dashboard's order: cash owed (as of the sending time, with one "not available yet" line for partners and card payouts), confirmed yesterday, failed deliveries, right now, yesterday's flow, "should come from yesterday's deliveries" and "credited by Bosta yesterday" on two rows, one line per store that took orders, exchanges and refunds owed, the status line → AC-4, AC-5
- [ ] Open the Today page at the same minute → every figure in the message equals the page's figure → AC-4
- [ ] Before yesterday is confirmed → the report waits, then arrives with "provisional" in the header and beside each unconfirmed figure, and no unknown printed as 0 → AC-2
- [ ] Remove the bot from the group → the run fails at once; the Telegram connection shows failing; the owner's private chat gets the text and the reason; the manager's My work has "Daily report did not send"; Needs you on `/today` shows it; block the private chat too → each manager and each extra address gets one email, right to left in Arabic → AC-9, AC-10
- [ ] Pause the report, or leave Telegram unconnected → only the Needs you row, no task and no email → AC-10
- [ ] On a confirmed morning → the header says confirmed and the cash block says Bosta money is provisional; owed figures say "as of <time>" → AC-2, AC-4
- [ ] Re add the bot and tap Send again → the stored text arrives once; the task closes and the connection health is ok → AC-10, AC-11
- [ ] Stop the worker over the report time and start it at 09:00 → the report sends late; start it at 13:00 instead → the run is `skipped`, the private chat and email notices go at once, and the next morning's status line says that day's report did not send; stop it for three days → a row for each day → AC-3, AC-5, AC-10
- [ ] Make a Shopify write back fail → one alert line in the owner's private chat with the kind, the order number and store code, and a link, no customer name or phone; ten more in two minutes → one summary line ten minutes later; the same failure retried does not send again → AC-7, AC-12
- [ ] Leave a write back failed for three days → each morning's status line still shows it with its age → AC-5
- [ ] Read the Arabic report on Telegram for Android, iOS, and desktop → every line reads right to left, amounts and times in order → AC-6
- [ ] Turn `daily_report_enabled` off → no report, Needs you says it is paused → AC-14

## Automated

- [ ] `pnpm --filter @ssdashboard/api test -- src/reporting/daily-report` → render tests in both languages (direction marks, plain text, the 4,000 character rule with 15 stores, provisional wording, `read_failed` lines, no field on the redaction list or phone shape in the report or any alert over the seeded data, order numbers with store codes allowed) → AC-4, AC-6, AC-7
- [ ] `pnpm --filter @ssdashboard/api test -- src/connectors/telegram` → each recorded fixture: sent, 401, 403, 400 chat not found, 400 topic closed, 400 with a new supergroup id, 429 with `retry_after`, 409 conflict, a privacy mode `getUpdates` → AC-8, AC-9
- [ ] Schedule test over the release year's Cairo daylight saving dates → one run per operating day → AC-1
- [ ] Concurrency e2e: two workers and a restart at the report time → one run, one command → AC-3
- [ ] Database e2e: the failure table: each cause gives exactly its private notice, email, task, and Needs you row; `RENDER_FAILED` and `STUCK_WAITING` go the same way → AC-3, AC-10
- [ ] Wind down e2e: the report keeps sending during the wind down with the wind down line, and writes no command after it ends → AC-14
