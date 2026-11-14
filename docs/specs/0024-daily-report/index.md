# 0024. Daily report: a worker job that reads the metric dictionary at a fixed Cairo time and sends one message to the brand's Telegram group through an outbound command, with failures sent to the owner's private chat and by email

**Date**: 2026-11-13 (domain review folded in the same day: [domain-daily-report](../../reviews/domain-daily-report.md), see [Domain review applied](#domain-review-applied))
**Status**: Proposed (ratified: the owner answered every question in [Owner decisions](#owner-decisions) on 2026-11-13; every recommendation ratified except Q-25.9 and Q-25.12, applied below)
**Scope feature**: 25, Daily report (Beta), in [Slice 1a: confirmation to cash](../../scope/confirmation-to-cash.md)
**Depends on**: [spec 0023](../0023-metric-dictionary-phone-dashboard/index.md) (`MetricReader`, the dictionary, the state rule, the Today page order, the `reporting` module); [spec 0007](../0007-stack-architecture-operations-layer/index.md) section 3 (the daily report: worker job, `tz`, confirmed data, Telegram first, gate decision 6) and section 1 (outbound commands and their failure path); [spec 0015](../0015-shopify-connector/index.md) (built framework: `connections` with sealed credentials, `outbound_commands`, the failure contract of AC-24, `OutboundCommandFailed`); [spec 0016](../0016-tasks-my-work-inbox/index.md) (`TasksService`, `TaskQueries.counts`, owner question 6: write back failure alerts through this feature's sender); [spec 0009](../0009-settings-toggles-bundles/index.md) (settings registry, module gate, `LicenseService`); the `mail` module (built: `MailProducer`, `mail.send`); feature 23, period close (spec 0022, in parallel: the confirmed day read).

## Summary

Every morning at a fixed Cairo time (06:00 by default) a job in the worker reads yesterday's figures through the same metric reader the phone dashboard uses, writes them as one short message in the brand's language, and sends it to the Telegram group the owner already reads. The message follows the dashboard's order: cash owed (as of the sending minute), confirmed yesterday, failed deliveries, what is in the pipe, yesterday's flow, one line per store, exchanges and refunds owed, and a short automation status line. The header says whether the orders are confirmed; the cash block says on its own that Bosta's money is provisional until the period closes, so "provisional" in the header means something. A failure (Telegram refusing, a figure that cannot be built, a worker that was down) never stays silent: it goes to the owner's private chat with the bot, by email to the managers, onto the dashboard, and into a task, and every run is recorded so a report is never sent twice for the same day.

## Requirements

**User stories**:

- As the owner, I want yesterday's numbers in my Telegram group every morning without opening the app, so that I start the day knowing how the business went.
- As the owner, I want the report to tell me when something in the automation is broken or needs me to sign in, so that a silent sync failure never runs for days.
- As the operations manager, I want to know at once when the report did not go out, and to send it again after fixing the cause, so that the owner is never left wondering.
- As the owner, I want the report and the dashboard to show the same numbers in the same order, so that I read one story in Telegram and in the app.
- As the owner, I want failure notices and alerts kept out of the business group, so that the group stays a business report.

**Acceptance criteria**:

*The schedule*

- **AC-1** (a fixed Cairo time, spec 0007 section 3): a pg-boss schedule `reporting.daily_report` in the worker, declared through the platform `JobRegistry` under the capability `reporting.daily_report`, runs at the setting `daily_report_time` (default `06:00`, allowed `04:00` to `11:00` in steps of 15 minutes, and at least one hour after `operating_day_cutoff_hour`, checked by the setting's validation, owner decision Q-25.2) with `tz` from the install `timezone` setting (default `Africa/Cairo`). It reports on the operating day before the run's own operating day (`ssd_operating_day(now()) − 1 day`). A test runs the schedule across the real Cairo daylight saving dates of the release year and finds exactly one run per operating day.
- **AC-2** (confirmed data, honestly labelled, owner decisions Q-25.3 and Q-25.14): at the run, the job asks spec 0023's state rule whether yesterday's own records (orders, confirmations, parcels) are confirmed (feature 23's read). If not, it checks again every 10 minutes for up to `daily_report_wait_minutes` (default 60, allowed 0 to 180), then sends with whatever is confirmed. The header says "confirmed" or "provisional" about the own records only. The cash block carries its own line, "Bosta money: provisional until the period is closed (confirmed through <day>)", because third party money is confirmed only at period close (spec 0020 AC-22), so on most mornings it is provisional and that is normal. Every figure not confirmed is printed with its value and the word provisional in the report's language, never as zero and never left out (spec 0007 M4).
- **AC-3** (once per day, and every missed day noticed): each run is one `daily_report_runs` row unique on (`tenant_id`, `report_day`). A second run for the same day (a retry, a restart, a second worker) finds the row and does nothing more than its state allows. On worker start, the job writes a row for every report day since the last row (at most 7): the latest runs late if the current time is before `daily_report_latest_time` (default `12:00`); every other missed day is written `skipped` with reason `worker_down`, and the failure path of AC-10 runs for it at once. A run still `waiting` 15 minutes after `daily_report_time` plus the wait is set `failed` with `STUCK_WAITING` by a watchdog in the same job.

*The content*

- **AC-4** (what it says, in order): one message, in the order of spec 0023 AC-14 so the owner reads one story: (1) header: the brand name, the report day in the report's language (for example "Thursday 12 November"), and "confirmed" or "provisional" (AC-2); (2) cash owed to you "as of <time>" (the minute of rendering), total then one line per Bosta connection and manual courier, and one line "partners and card payouts: not available yet" while those parts are `not_available`, with the Bosta money line of AC-2; (3) confirmed yesterday; (4) failed deliveries, last `failed_rate_window_days` days, with the open share; (5) right now, as of the same time: waiting to confirm, confirmed not shipped, with the couriers and their COD, coming back; (6) yesterday: orders placed, cancelled, parcels shipped, delivered (partly delivered inside it), turned back, lost when above zero, and order value by order day labelled as such; (7) cash yesterday, two rows that are never set against each other: "should come from yesterday's deliveries" (gross) and "credited by Bosta yesterday" (net), with Bosta's fees; (8) one line per store (placed, confirmed, shipped, delivered, turned back), shown only when more than one store took orders in the last 30 days; (9) exchanges owed and refunds owed "as of <time>", with "refunds owed (unrecorded)" while it is above zero; (10) the automation status line of AC-5; (11) a link to `/today` on the staff host. Every figure is a spec 0023 metric with its spec 0023 label, read through `MetricReader`; the job computes nothing itself. A reader that fails answers its metrics `not_available` with reason `read_failed`, and the line says "could not be read, the team is told" while the report still goes.
- **AC-5** (the automation status line, spec 0007 sections 1 and 3): one short block, every item from a read service: per Shopify store and per Bosta connection, "ok, last change <time>" or the health reason in plain words ("needs a new app approval in Shopify", "Bosta key refused, ask the manager to enter a new one", "no change seen for 6 hours"); open failed write backs and failed inbound events with the age of the oldest (open counts, never "since the last report", so an unresolved failure keeps showing); open and overdue tasks of the manager and operations hats (counts); "the report on <day> did not send" for each `failed` or `worker_down` run since the last sent one; a change in the report group's member count ("the report group has 9 members, it had 6"); Operations license expiry at 30, 14, and 7 days and during the wind down. When everything is fine it says so in one line. Detail beyond this block goes to the alerts destination (AC-12), not to the group.
- **AC-6** (both languages, right to left safe): the report is rendered in the setting `daily_report_language` (default the install `default_language`, owner decision Q-25.4) from `packages/i18n` keys `reporting.dailyReport.*` and the metric labels of spec 0023, with Western digits, `EGP` after amounts, every left to right run inside Arabic text (amounts, store codes, times, the link) wrapped in Unicode isolate marks (U+2068 and U+2069), and every Arabic line starting with a right to left mark (U+200F) so Telegram sets the line's direction; the rendering is checked by hand on Telegram for Android, iOS, and desktop before the pilot (verify.md). It is sent as plain text, never with a parse mode, so no store or partner name can inject formatting, with `link_preview_options.is_disabled`. It stays under 4,000 characters; with many stores the per store lines collapse to the top 10 by orders placed and "N more stores in the app".
- **AC-7** (no personal data, Law 151, owner decision Q-25.12): the report and every alert hold aggregates, store and partner names, connection labels, kinds, counts, links, and, where a line is about one order, its order number with the store code; never a customer name, phone, address, note, or message body. The owner accepted order numbers going to Telegram, whose servers are outside Egypt; every other field is held back by the redaction list (`packages/config/src/redaction.ts`), which the renderer and the alert sender apply to anything they print. A test renders a report and each alert kind over the seeded data and fails if any field on the redaction list or a phone shape appears. The rendered text is stored on the run for resending and audit and carries no personal data by the same rule.

*Sending, failure, and resending*

- **AC-8** (the Telegram connection, owner decision Q-25.9): a manager (`settings.manage`) connects on `/connections/new?provider=telegram` with a label and the token of a bot made for this report (stored only in the sealed credentials, `kind: 'telegram_bot_token'`, AES-256-GCM under `CONNECTOR_SECRET_KEY`, as spec 0015 AC-2; the screen shows "set" and its last 4 characters; `getMe` checks it). The screen then shows, with a copy button, the exact text `/start@<bot username>`: the manager types it in the report group, in the chosen topic when the group has topics, and taps "Find the group"; a command addressed to the bot arrives under Telegram's privacy mode and carries the group and the topic, so `getUpdates` finds both in one step (pasting the topic's link is the second way). The same way, the owner sends `/start` to the bot in a private chat, which becomes the **owner private chat** (the alerts and failure destination, AC-10, AC-12); an alerts topic in the group is the alternative. The report group is the owner only (owner decision Q-25.9). The screen warns: "Everyone in this group will see cash figures every morning. The owner decided the group is the owner only; adding anyone else is the owner's decision," and shows the group's member count from `getChatMemberCount`. "Send a test message" sends one line to each destination. A bot another program already polls answers Telegram's 409 conflict, shown as `BOT_IN_USE_ELSEWHERE` ("make a new bot for the report"). The chat ids, titles, topic, and member count live in `connections.config`; connecting, changing a destination, and replacing the token are audited (`connection.created`, `connection.config_changed`, `connection.credentials_replaced`). One Telegram connection per install in slice 1a.
- **AC-9** (sending is an outbound command): the job writes the run (`state = 'sending'`) and one `outbound_commands` row (`kind = 'telegram.send_message'`, linked type `daily_report_run`, the run id, an idempotency key `daily_report:<report_day>`) in one transaction; the Telegram executor in `apps/api/src/connectors/telegram/` calls `sendMessage` (chat id, topic thread, text, `link_preview_options`). Spec 0015's failure contract applies unchanged: transient errors (network, timeout, HTTP 5xx, 429 after its `retry_after`) retry with backoff up to 5 attempts over about 30 minutes; a rejection fails at once with a mapped code (never Telegram's text): `TOKEN_REFUSED` (401), `BOT_REMOVED` (403), `CHAT_NOT_FOUND` and `TOPIC_NOT_FOUND` or `TOPIC_CLOSED` (400), `NO_RIGHTS` (the bot may not post). A 400 answer that names a new supergroup id moves the destination's chat id to it (audited `connection.config_changed`, actor the system) and sends once more. Telegram has no idempotency key: a timeout after Telegram took the message can send it twice, which is accepted and named in Consequences.
- **AC-10** (a failure is seen, by meaning, scope done when): reporting reacts to the run's end by its cause:

  | Cause | Owner private chat | Email | Task | Needs you | Next report |
  |---|---|---|---|---|---|
  | `failed` (send rejected or retries used up, `RENDER_FAILED`, `STUCK_WAITING`) | the report text and the reason, first | to the managers and `daily_report_fallback_emails`, after the private chat fails or is not set | `report.send_failed`, one per cause (dedupe `daily_report:<cause>`), closed by the system when a later report is sent | "The daily report did not send" with the reason | yes |
  | `skipped`, `worker_down` | the reason, at once on worker start | as above | as above | yes | yes |
  | `skipped`, `no_channel` | none | none | none | one row for the manager, "Connect Telegram to start the daily report" | no |
  | `skipped`, `paused` | none | none | none | "The daily report is paused" | no |
  | `skipped`, `module_off` | none | none | none | none (the module gate says so) | no |

  A rejection also sets the Telegram connection's health `failing` with the reason; the next successful send or test message sets it back to ok. The fallback email renders the text in a `pre` block with `dir="rtl"` and `lang="ar"` for an Arabic report; with no mailer configured, the connect screen and the status line say "No email fallback: mail is not set up".
- **AC-11** (send again): a manager sees the last 30 runs on `/reports/daily` (day, state, sent at, attempts, reason, member count, the stored text in a preview) and can "Send again" a `failed` or `skipped` run (audited `daily_report.resent`, reason optional), which re-renders the figures as of now for a run that never rendered (its header says "sent late, figures as of <time>"), or resends the stored text of a run that did; a run `skipped` for `no_channel` this morning can be sent this way once Telegram is connected. No day that is already `sent` is sent again.
- **AC-12** (alerts through the same sender, spec 0016 owner question 6, owner decisions Q-25.5 and Q-25.10): `ReportChannel.sendAlert(tx, { kind, storeId, orderNumber?, count, link, dedupeKey })` is exported for other modules; it writes one `telegram.send_message` command to the alerts destination (the owner private chat, or the alerts topic; with neither set, the report destination), with the caller's dedupe key so a repeat never sends twice. Alerts are batched per kind: the first sends at once, then at most one summary line per 10 minutes ("6 more Shopify writes failed since 13:02, see My work"). The first caller is the tasks module: a failed or late write back sends its kind, the order number with its store code, and a link to the order (spec 0016 owner question 6, confirmed by Q-25.12; never a name, phone, address, or message body, AC-7). Alerts are off until a Telegram connection exists, and `daily_report_alerts` (default on) turns them off without turning off the report.

*Access, module, and lapse*

- **AC-13** (who may do what): connecting Telegram, the report settings, "Send again", and "Send today's report now" need `settings.manage` (manager); `/reports/daily` is readable with `reports.view`. All routes are `@Audience('staff')` and carry `@RequiresCapability('reporting.daily_report')` or the connectors capability `connectors.telegram.send`.
- **AC-14** (on and off, owner decision Q-25.6): the capability `reporting.daily_report` (bundle `operations`, `kind: 'write'`, `windDown: 'pre_lapse'`) keeps the report running through the Operations wind down, where its status line carries the wind down's days left and the open settlement items (spec 0020 `openItems`); when the wind down ends or the module is off, the schedule is removed and no command is written. The setting `daily_report_enabled` (default on once a Telegram connection exists) pauses the report without removing the connection (AC-10, `paused`).

## Decision

**Chosen option**: Option 1: a worker job in the `reporting` module that renders spec 0023's figures and sends one Telegram message through a connectors outbound command, with failures going to the owner's private chat with the bot and then by email to the managers.

Rendering lives with the figures (reporting), sending lives with every other outside call (connectors), and the failure path is the one the app already has for Shopify write backs (spec 0015 AC-24), so a failed report behaves like a failed sync: retried, visible, a task, and repeated in the next report. Runner up: sending by email through the `mail` module as the main channel, rejected because the owner reads the chat group, not email (reference brand notes 9), and spec 0007's gate decision 6 already chose Telegram first; email stays as the last failure path.

**Implementation skills**: `pg-boss-v12` (`.claude/skills/pg-boss-v12/`) · `nestjs-best-practices` (`.claude/skills/nestjs-best-practices/`) · `nextjs-app-router-patterns` (`.claude/skills/nextjs-app-router-patterns/`) · `postgresql-table-design` (`.claude/skills/postgresql-table-design/`)

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

### Where things live

- `apps/api/src/reporting/daily-report/`: `daily-report.job.ts` (the schedule, the wait, the catch up on start, the watchdog), `daily-report-render.ts` (pure: figures and labels in, plain text out, the direction marks, the length rule), `daily-report-runs.ts` (`DailyReportRuns`: the run writer and reads, `lastFailed` for spec 0023's Needs you), `daily-report-failure.ts` (the table of AC-10), `daily-report.controller.ts` (`/api/reporting/daily-runs`), `report-channel.ts` (`ReportChannel.sendAlert` and its batching), `README.md`.
- `apps/api/src/connectors/telegram/`: `telegram-client.ts` (`sendMessage`, `getUpdates`, `getMe`, `getChatMemberCount`, 30 second timeout, the error mapping), `telegram-executor.ts` (the `telegram.send_message` kind), `telegram-connection.ts` (connect, find the group and the owner chat, test message), recorded fixtures under `fixtures/` (a sent message, 401, 403 removed, 400 chat not found, 400 topic closed, 400 with `migrate_to_chat_id`, 429 with `retry_after`, 409 conflict, a `getUpdates` answer with a `/start@bot` command in a forum topic and a private `/start`, a privacy mode answer with only the service message).
- `packages/contracts/src/reporting/daily-report.ts`: `DailyReportRunState`, the run and run list answers, the settings schemas; `packages/contracts/src/connectors/telegram.ts`: `TelegramConnectionConfig` (report destination, alerts destination, owner private chat, member count).
- `packages/i18n`: `reporting.dailyReport.*` (header, section titles, status sentences, failure notices), `connections.telegram.*`, `mail.dailyReportFallback.*`.
- `apps/web/src/reporting/daily-runs-page.tsx` and `apps/web/src/app/(backoffice)/reports/daily/page.tsx`; the Telegram connect form under `apps/web/src/connectors/`.
- `apps/api/src/mail/mail-templates.ts`: the `daily_report_fallback` template (the report text in a `pre` block with the language's direction, the link).

### Data model

One new table owned by `reporting`, and three amendments to connectors' enums. One generated migration.

| Table or change | Columns | Rules |
|---|---|---|
| ★ `daily_report_runs` | `id uuid` (v7), `tenant_id`, `report_day date not null`, `state` enum `daily_report_run_state` (`waiting`, `sending`, `sent`, `failed`, `skipped`), `confirmed boolean not null` (true when every own records figure was confirmed at render), `language text not null`, `rendered_text text null` (at most 4,096 characters), `figures jsonb null` (the `MetricValue`s as sent, for audit and a later check that the report and the dashboard agreed), `figures_as_of timestamptz null`, `outbound_command_id uuid null` (connectors' command, no foreign key across modules), `scheduled_for timestamptz not null`, `rendered_at`, `sent_at`, `provider_message_id text null`, `failure_reason text null` (upper case code shape, as spec 0015: the Telegram codes of AC-9, `RENDER_FAILED`, `STUCK_WAITING`), `skip_reason text null` (`worker_down`, `no_channel`, `paused`, `module_off`), `attempts smallint not null default 0`, `group_member_count integer null`, `private_notice_queued_at timestamptz null`, `fallback_mail_queued_at timestamptz null`, `created_at`, `updated_at` | unique (`tenant_id`, `report_day`); check `state <> 'sent' OR (sent_at IS NOT NULL AND rendered_text IS NOT NULL)`; check `state <> 'skipped' OR skip_reason IS NOT NULL`; check `failure_reason IS NULL OR failure_reason ~ '^[A-Z0-9_]+$'`; index (`tenant_id`, `report_day desc`); the app role may `SELECT`, `INSERT`, `UPDATE`, never `DELETE`; rows are kept (one a day) |
| `connections.provider` enum | add `telegram` | |
| `outbound_commands.kind` | add `telegram.send_message` | |
| `outbound_commands.linked_type` enum | add `daily_report_run` | alerts link to `connection` (already added by spec 0015) |

The table ownership map (`table-ownership.ts`) lists `daily_report_runs` under `reporting`; the enum parity test covers the new values.

### State transitions

`daily_report_runs.state`: (none) → `waiting` (created, waiting for confirmed data) → `sending` (rendered, command written) → `sent` or `failed`; `waiting` → `failed` (`RENDER_FAILED`, `STUCK_WAITING`); (none) or `waiting` → `skipped` (missed, no channel, paused, module off); `failed` → `sending` (Send again: the stored text, or rendered as of now when none was stored); `skipped` → `sending` (Send again, rendered as of now). `sent` is final.

### Sending sequence

1. The schedule fires (or the catch up on start, AC-3). The job takes the advisory lock `daily_report:<report_day>`, inserts the run `waiting` (`ON CONFLICT DO NOTHING`), and returns if the row already existed past `waiting`.
2. It checks the gates: module and capability on, `daily_report_enabled`, a Telegram connection active. A failed gate sets `skipped` with its reason (AC-10 decides what follows).
3. It asks for yesterday's confirmation (AC-2); if not confirmed and the wait is not used up, it re-enqueues itself with `startAfter` 10 minutes, keeping `waiting`.
4. It reads the figures through `MetricReader` (spec 0023) with the system access of the worker (a reader that throws gives `read_failed` figures, AC-4), renders the text, and in one transaction writes the run `sending` with the text, figures, `figures_as_of`, the member count, and the outbound command. A render that cannot produce a text sets `failed` with `RENDER_FAILED`.
5. The connectors executor sends; its success or failure events (`OutboundCommandSynced`, `OutboundCommandFailed`) are listened to by reporting, which sets `sent` or `failed` and runs the failure table of AC-10.

### API surface

| Endpoint | Method | Key inputs | Key outputs | Permission | Key errors |
|---|---|---|---|---|---|
| `/api/reporting/daily-runs` | GET | `cursor?`, `limit?` (30, max 100) | items: `id`, `reportDay`, `state`, `confirmed`, `sentAt`, `attempts`, `failureReason`, `skipReason`, `groupMemberCount`; `nextCursor` | `reports.view` | 400 `INVALID_CURSOR` |
| `/api/reporting/daily-runs/:id` | GET | none | the run with `renderedText` | `reports.view` | 404 |
| `/api/reporting/daily-runs/:id/resend` | POST | `reason?`, `expectedUpdatedAt` | the run (`sending`) | `settings.manage` | 409 `RUN_ALREADY_SENT`, `STALE_RECORD`, `NO_CHANNEL`; 422 `REASON_INVALID` |
| `/api/reporting/daily-runs/send-today` | POST | none | the run for today (`report_day` yesterday) | `settings.manage` | 409 `RUN_ALREADY_SENT`, `NO_CHANNEL` |
| `/api/connections/telegram` | POST | `label`, `botToken` | the connection (`credentialsHint`, the bot username) | `settings.manage` | 422 `TOKEN_REFUSED` (from `getMe`), `INVALID_BODY` |
| `/api/connections/:id/telegram/chats` | GET | none | chats where the bot received `/start@<bot>` or `/start` in the last 24 hours: `chatId`, `kind` (group or private), `title`, `topicId?`, `topicTitle?`, `memberCount` | `settings.manage` | 409 `NO_UPDATES` ("type the start text in the group first"), `BOT_IN_USE_ELSEWHERE` |
| `/api/connections/:id/telegram/destinations` | PUT | `report: { chatId, topicId? }`, `alerts?: { chatId, topicId? }`, `ownerChatId?`, or `topicLink?` for the report topic, `expectedUpdatedAt` | the connection | `settings.manage` | 409 `STALE_RECORD`; 422 `CHAT_NOT_SEEN`, `TOPIC_LINK_INVALID` |
| `/api/connections/:id/telegram/test` | POST | none | per destination `{ sent: true }` or the mapped code | `settings.manage` | 502 `TELEGRAM_REFUSED` with the code |

### Value sourcing

| Action | Value produced or displayed | Source |
|---|---|---|
| schedule | the run time | setting `daily_report_time`, `tz` from `timezone`, validated against `operating_day_cutoff_hour` |
| run | the report day | `ssd_operating_day(now())` minus one day (spec 0007 section 10) |
| run | whether yesterday is confirmed, and the Bosta money confirmed through day | spec 0023's state rule over feature 23's `ConfirmedDays.confirmedThrough` |
| run | every figure, and the "as of" time | `MetricReader.read` (spec 0023) with the keys of AC-4; `figures_as_of` is the read's `asOf` |
| render | language | setting `daily_report_language`, else `default_language` |
| render | brand name | the install's client name, as `/api/config` and the mail templates already read it (`clientName`) |
| render | day name and date | `packages/i18n` date format for the language, from `report_day` |
| render | which stores get a line | `ChannelsService` stores, kept when `orders.placed` over the last 30 days is above zero |
| render | store names | `ChannelsService` (store public name in the language) |
| render | connection lines | `ConnectorsService.freshness()` (spec 0023 requested read) |
| render | open failure counts and oldest age, task counts | `TaskQueries.counts(now, …)` (spec 0016) for `sync.*`, `connector.inbound_failed`, and the manager and operations hats |
| render | member count change | `getChatMemberCount` now against the last sent run's `group_member_count` |
| render | license lines | `LicenseService` (spec 0009: expiry, wind down days left) and spec 0020 `openItems` during the wind down |
| render | runs not sent | `daily_report_runs` since the last `sent` row |
| render | the link | `PUBLIC_URL` plus `STAFF_BASE_PATH` plus `/today` (as `mail-links.ts` builds links) |
| send | bot token | the Telegram connection's sealed credentials |
| send | destinations | `connections.config` (`TelegramConnectionConfig`) |
| send | idempotency key | `daily_report:<report_day>`, or the caller's key for an alert |
| failure | email recipients | active users holding the manager hat, through identity's exported read (the one the mail module already uses), plus `daily_report_fallback_emails` |
| failure | task | `TasksService.open(tx, { type: 'report.send_failed', dedupeKey: 'daily_report:<cause>' … })` (spec 0016 registry row, requested) |

### Settings (rows for spec 0009's registry; Operations bundle, group Reports, `whoMayChange: settings.manage`)

| Key | Default | Allowed | Reason |
|---|---|---|---|
| `daily_report_enabled` | `true` | boolean | required to turn off |
| `daily_report_time` | `06:00` | `04:00` to `11:00`, 15 minute steps, at least one hour after `operating_day_cutoff_hour` | optional |
| `daily_report_latest_time` | `12:00` | after `daily_report_time`, at most `18:00` | optional |
| `daily_report_wait_minutes` | `60` | 0 to 180 | optional |
| `daily_report_language` | null (use `default_language`) | one of `languages` | optional |
| `daily_report_alerts` | `true` | boolean | optional |
| `daily_report_fallback_emails` | empty | at most 5 email addresses | optional |

### Needs from other specs

- **Spec 0016 (tasks)**: a registry row `report.send_failed` (linked `daily_report_run`, hat manager, permission `settings.manage`, due now, outcomes `sent` and `resolved` (system), closed by the system, no snooze, not opened by a person); its write back alert sends the kind, the order number with its store code, and a link (Q-25.12, as its owner question 6 said).
- **Spec 0015 (connectors)**: the `telegram` provider and `telegram.send_message` kind under its outbound framework, unchanged; `ConnectorsService.freshness()` (also requested by spec 0023).
- **Spec 0023**: `MetricReader` callable from the worker with a system access that holds `reports.view`, answering `read_failed` for a reader that throws; `DailyReportRuns.lastFailed` is read by its Needs you.
- **Feature 23 (spec 0022)**: `ConfirmedDays.confirmedThrough`, as spec 0023 requests.
- **Feature 26 (deployment and monitoring)**: an outside check that the day's run is `sent` by `daily_report_time` plus the wait plus 30 minutes, alerting from outside the stack, because a dead host sends nothing.

### Key invariants

- At most one report row per operating day, and the app sends each day once (Telegram may still duplicate one after a timeout, AC-9).
- The job computes no figure; every number is a spec 0023 `MetricValue`, and the stored `figures` equal what the dashboard read at that instant.
- No unconfirmed figure is sent without the word provisional; no unknown figure is sent as zero.
- No customer name, phone, address, note, or message body in the text, an alert, the stored row, the command, an event, or a log; an order number with its store code is allowed (Q-25.12).
- The bot token is never in an answer, a log line, an event, an audit entry, or an error.

### Security model

Staff audience only; reading runs needs `reports.view`, every change needs `settings.manage`. The bot token is a connector secret (sealed, last 4 shown, replace only). The worker sends as the app database role with no host access (spec 0007). Telegram's servers are outside Egypt, so the report and alerts are limited to aggregates, the names of the brand's own stores, partners, and connections, and order numbers with their store code, which the owner accepted (Q-25.12, Law 151; the test of AC-7 and the redaction list hold everything else back). The report group is outside the app's permissions: everyone in it sees cash figures, so the owner decided it is the owner only (Q-25.9) and adding anyone else is the owner's decision; the connect screen warns, the member count is shown and its change reported, and the staff offboarding runbook removes a leaver from the group. Plain text sending removes formatting injection through a partner or store name. Audit: connecting, changing a destination, replacing the token, resending, and changing a report setting.

### Configuration required

No new environment variable: the token is stored through `CONNECTOR_SECRET_KEY` (spec 0015). Per brand, outside the app: a new Telegram bot created with BotFather for this report only (never one another program polls), owned by the brand's own Telegram account, added to the owner's group with permission to post in the chosen topic, as `docs/runbooks/telegram-report.md` will describe. The worker needs outbound HTTPS to `api.telegram.org` from the host.

### Critical test scenarios

- Thread: at 06:00 Cairo with yesterday confirmed, one run, one command, the recorded "sent" fixture, the run `sent` with the message id, the text in Arabic with a right to left mark on each line and isolate marks around amounts, matching the dashboard's figures for that instant, verifies **AC-1**, **AC-4**, **AC-6**, **AC-9**.
- Yesterday not confirmed at 06:00: the job waits, sends at 07:00 with "provisional" in the header and beside each unconfirmed figure; on a confirmed morning the header says "confirmed" while the Bosta money line says provisional; no unknown printed as 0, verifies **AC-2**.
- Two workers and a restart at 06:00: one run, one command, one message, verifies **AC-3**.
- Worker down for three days: on start, the latest day runs late if before 12:00 and the two before are `skipped` (`worker_down`) with a private chat notice and an email at once, verifies **AC-3**, **AC-10**.
- A reader throws: the report goes with "could not be read" for its figures; the renderer fails: `RENDER_FAILED` through AC-10; a run stuck `waiting`: `STUCK_WAITING`, verifies **AC-3**, **AC-4**, **AC-10**.
- The 403 "removed" fixture: the run fails at once, the connection health is `failing`, a `report.send_failed` task opens, the owner's private chat gets the text and reason; with the private chat also failing, the managers and the extra addresses get one email with `dir="rtl"`; re adding the bot and Send again sends the stored text once and the health and task clear, verifies **AC-9**, **AC-10**, **AC-11**.
- Paused, no channel, module off: no task and no email; each shows only its row of AC-10, verifies **AC-10**.
- The 429, `migrate_to_chat_id`, topic closed, and 409 conflict fixtures map as AC-8 and AC-9 say, verifies **AC-8**, **AC-9**.
- Setup under privacy mode: only `/start@bot` in a topic is found, with its topic; a pasted topic link also sets it, verifies **AC-8**.
- A seeded store named with Arabic and a customer whose name equals a store word: the report and every alert hold no customer name, phone shape, or address, while an alert about one order carries its order number and store code, verifies **AC-7**.
- Ten failed write backs in two minutes: one alert line, then one summary line ten minutes later, in the owner private chat, verifies **AC-12**.
- An open write back failure from three days ago still shows in today's status line with its age, verifies **AC-5**.
- Daylight saving: a schedule over the release year's Cairo transitions runs once per operating day; a report time earlier than the cutoff hour plus one is refused, verifies **AC-1**.
- A support agent calls resend: 403; an operations user reads runs but cannot resend, verifies **AC-13**.
- The Operations plan in its wind down: the report keeps sending with the wind down line; after it ends no command is written, verifies **AC-14**.

## Build plan

Tracer bullet: milestone 1 sends one real report with one figure through every layer (schedule, run row, render, outbound command, Telegram executor on a recorded fixture, the run page); each later milestone thickens one segment. Milestone 1 needs spec 0023 milestone 1 (the reader and two figures) and nothing from features 19 to 23, whose figures arrive as `not_available` until their milestones land.

1. **One report sent.** Migration for `daily_report_runs` and the three enum values, grants, ownership map, parity test; `TelegramConnectionConfig`, the Telegram client and executor with the recorded fixtures; the connect flow (token, `/start@bot` in the group, find the chat and topic, topic link, owner private chat, member count, warning, test message) and its screen; the `reporting.daily_report` capability and the schedule through `JobRegistry`; the run writer with the lock and the unique day; `daily-report-render.ts` with the header, "confirmed yesterday", and the link, in both languages with direction marks, plain text; the success path to `sent`; `/reports/daily` listing runs; the settings rows; `docs/runbooks/telegram-report.md`, satisfies **AC-1**, **AC-3**, **AC-6**, **AC-8**, **AC-9**, **AC-11** (list), **AC-13**.
2. **The whole report.** Every section of AC-4 through `MetricReader` (each `not_available` until its spec 0023 milestone), the "as of" times, `read_failed`, the per store lines and the length rule, the personal data test, the status line of AC-5 over `ConnectorsService.freshness`, `TaskQueries.counts`, the member count, and `LicenseService`, satisfies **AC-4**, **AC-5**, **AC-6**, **AC-7**.
3. **Failure, resend, and confirmed data.** The failure listeners and the cause table of AC-10 (private chat, email with direction, task per cause, health back to ok, Needs you); `RENDER_FAILED` and the watchdog; Send again and Send today's report now; the catch up over missed days; after feature 23's read: the wait for confirmed data, the own records header, and the Bosta money line, satisfies **AC-2**, **AC-3**, **AC-10**, **AC-11**.
4. **Alerts and the lapse.** `ReportChannel.sendAlert` with destinations and batching, and the tasks module's write back alert (spec 0016 Follow-up); `daily_report_alerts`; the wind down line and the stop at the end of the wind down; the daylight saving schedule test; the hand check on three Telegram clients, satisfies **AC-1**, **AC-6**, **AC-12**, **AC-14**.

## Consequences

**Positive**:

- The owner gets the figures where they already read, from the same reader as the dashboard, with no second system to keep alive (insights section 7: four systems for one daily message).
- A failed report behaves like any failed sync: retried, visible on the dashboard, a task, a private notice, an email, and a line in the next report; a deliberate pause raises no alarm.
- The sender is reusable: spec 0016's write back alerts and later notifications use it without a second Telegram integration, and they stay out of the business group.

**Negative / tradeoffs**:

- If the whole host or worker is down at 06:00, the app sends nothing until it starts again; until feature 26's outside check exists, the runbook's line "if no report has arrived by 07:30, call <the support contact>" is the only guard.
- Telegram is outside Egypt; the report is limited to aggregates and order numbers, which the owner accepted (Q-25.12); a mistake in the redaction list would send more, so the AC-7 test is the guard.
- Everyone in the report group sees cash figures, outside the app's permissions; the group is the owner only by the owner's decision, and the warning, the member count, and the offboarding line guard it.
- The brand must create a bot, type one command in the group, and have the owner start a private chat with it; a bot removed from the group stops the report until a person re adds it.
- On most mornings the cash figures are provisional, because Bosta's money is confirmed only at period close; the owner must learn that provisional cash is normal.
- Telegram has no idempotency key, so a timeout after delivery can repeat a message.

**Neutral**:

- The connectors module gains a second provider kind with no inbound side (no webhook; `getUpdates` is called only at setup).
- One small table, one row a day.

## Follow-up

- [ ] Spec 0016: add the `report.send_failed` registry row, and wire its write back alert through `ReportChannel.sendAlert` with the kind, the order number with its store code, and a link (its owner question 6, confirmed by Q-25.12).
- [ ] Spec 0015: record the `telegram` provider, its sealed credential kind, and the `telegram.send_message` executor in its outbound framework table when milestone 1 is built.
- [ ] Feature 26 (deployment and monitoring): an outside check that each day's report run is `sent` on time, alerting from outside the stack; allow outbound HTTPS to `api.telegram.org` from the worker on every host, checked from an Egyptian data center before the pilot.
- [ ] Feature 50 (WhatsApp): research WhatsApp group sending against Meta's own documentation (spec 0007 m6) and add it as a second channel kind under the same `ReportChannel`.
- [ ] Runbook `docs/runbooks/telegram-report.md` (milestone 1): who owns the bot (the brand's own Telegram account, not a staff member's), create a new bot, allow groups, add it with posting rights in the topic, type the start text, start the owner's private chat, test, what to do when the report stops, "if no report by 07:30", and removing a leaver from the group.
- [ ] A weekly or monthly summary is out of slice 1a; if the owner asks, it is a second schedule over the same renderer.

## Domain review applied

[domain-daily-report](../../reviews/domain-daily-report.md) (ratify with changes: 0 blockers, 11 majors, 13 minors). Every finding is folded in:

| Finding | Where it landed |
|---|---|
| M1 the header is provisional every day | AC-2 header follows own records; the Bosta money line |
| M2 no "as of" on owed figures | AC-4 "as of <time>", `figures_as_of`; AC-11 "sent late, figures as of" |
| M3 a dead host sends nothing | AC-3 catch up over missed days with notices at once; Consequences; feature 26 Follow-up and *Needs from other specs*; runbook line |
| M4 a failure before the send has no state | AC-4 `read_failed`; `RENDER_FAILED`; the `STUCK_WAITING` watchdog (AC-3) |
| M5 deliberate skips raise the alarm | AC-10 table by cause |
| M6 "since the last report" hides open failures | AC-5 open counts with the oldest age |
| M7 the group sees cash outside permissions | AC-8 warning and member count, AC-5 member change, Security model, runbook; Q-25.9 answered: the owner only |
| M8 setup flow against real Telegram | AC-8 `/start@bot`, topic link, owner private chat, `BOT_IN_USE_ELSEWHERE`, fixtures; Configuration required |
| M9 alerts in the business group | AC-12 alerts destination and batching; Q-25.5, Q-25.10 |
| M10 order numbers in alerts | Put to the owner as Q-25.12; the owner allowed order numbers with the store code, knowing Telegram is abroad (AC-7, AC-12); the redaction list guards every other field |
| M11 the fallback email may not reach the owner | AC-10 private chat first, then email with extra addresses and direction, the no mailer warning; Q-25.1, Q-25.11 |
| m1 one task per failed day | AC-10 one task per cause, closed by a later sent report |
| m2 multi day outage | AC-3 a row per missed day (at most 7) |
| m3 "never twice" overstated | AC-9, Key invariants, Consequences |
| m4 `link_preview_options` | AC-6, AC-9 |
| m5 topic closed, no rights | AC-9 codes and fixtures |
| m6 health back to ok | AC-10 |
| m7 line direction | AC-6 right to left mark per line, hand check on three clients |
| m8 "confirmed yesterday" twice | AC-4 Yesterday block no longer repeats it |
| m9 the manual store | AC-4 (8) only stores that took orders in the last 30 days |
| m10 partner lines | AC-4 (2) one line for parts not available yet; Q-25.7 |
| m11 report time against the cutoff hour | AC-1 validation |
| m12 the noon example | AC-11 Send again of the `no_channel` run |
| m13 who owns the bot | Configuration required, runbook Follow-up |

## Owner decisions

The architect wrote this spec without the owner and recorded each question with its options and a recommended answer. The owner answered all of them on 2026-11-13 (owner ruling 2026-11-13): every recommendation is ratified except Q-25.9 (the group is the owner only) and Q-25.12 (order numbers are allowed), and the design above follows those two answers.

1. **Q-25.1 Where does the report go, and where do failures go?** (a) The report to the Telegram group the owner already reads; a failure notice first to the owner's private chat with the bot, then by email to the managers and any extra addresses. (b) Telegram only. (c) Email only, through the app's mail. (d) Both every day. (e) A WhatsApp group. **Answered (owner ruling 2026-11-13): (a), as recommended**: spec 0007's gate decision 6 already chose Telegram first and the reference brand runs its report there and sends failures to the owner's private chat; email is the last net; (d) doubles the noise; (e) needs Meta's group eligibility checked first (feature 50), so it is not available in slice 1a.
2. **Q-25.2 What time?** (a) 06:00 Cairo, changeable from 04:00 to 11:00. (b) 08:00. **Answered (owner ruling 2026-11-13): (a), as recommended**: the reference brand's report goes at 06:00, before the team starts.
3. **Q-25.3 What if yesterday's orders are not confirmed at that time?** (a) Wait up to 60 minutes, then send with the word provisional. (b) Send at once, provisional. (c) Wait until confirmed, however long. **Answered (owner ruling 2026-11-13): (a), as recommended**: usually the sweep confirms the day long before 06:00; (c) can leave the owner with nothing.
4. **Q-25.4 Which language?** (a) One language per brand, the brand's default (Arabic for most). (b) Arabic and English in the same message. **Answered (owner ruling 2026-11-13): (a), as recommended**: one short message.
5. **Q-25.5 Automation status in the report or apart?** (a) One short status block at the end of the report; alerts and detail go to the owner's private chat (or an alerts topic). (b) Everything in the report group. (c) No status in the report. **Answered (owner ruling 2026-11-13): (a), as recommended**: the scope asks for a status line in the report, and the reference brand keeps detail and failures out of the business group.
6. **Q-25.6 After the Operations plan lapses?** (a) The report keeps going through the wind down with the wind down line, then stops. (b) It stops at the lapse. **Answered (owner ruling 2026-11-13): (a), as recommended**.
7. **Q-25.7 Partners in slice 1a.** (a) One line "partners and card payouts: not available yet" in cash owed. (b) One line per partner. (c) Nothing until feature 43. **Answered (owner ruling 2026-11-13): (a), as recommended**: honest and short; spec 0023 Q-24.8 shows the same on the dashboard.
8. **Q-25.8 Fridays and holidays.** (a) Every day, including Fridays and Eid. (b) Skip days off. **Answered (owner ruling 2026-11-13): (a), as recommended**: orders and deliveries do not stop, and a missing report looks like a failure.
9. **Q-25.9 Who is in the report group?** (a) Only the people who may see cash figures (the owner, partners in the business, the manager); the app warns at setup and reports member changes. (b) The whole team. (c) The owner only. Recommended was (a). **Answered (owner ruling 2026-11-13): (c), the owner only.** Adding anyone else to the group is an owner decision, because the group sees the brand's cash every morning, outside the app's permissions.
10. **Q-25.10 Where do alerts go?** (a) The owner's private chat with the bot. (b) A separate alerts topic in the group. (c) The report group. **Answered (owner ruling 2026-11-13): (a), as recommended**, with (b) for a brand that wants the manager to see them too.
11. **Q-25.11 Does the owner have a manager login and an email they read?** If not, the brand adds the owner's address to `daily_report_fallback_emails`. **Answered (owner ruling 2026-11-13): ask at setup, as recommended.**
12. **Q-25.12 May order numbers go to Telegram in alerts?** (a) No: kind, store code, count, and a link to My work. (b) Yes, as spec 0016's ratified wording says. Recommended was (a). **Answered (owner ruling 2026-11-13): (b).** The report and alerts may carry the order number with its store code, as spec 0016's owner question 6 said. The owner accepted this knowing Telegram's servers are outside Egypt (Law 151). Names, phones, addresses, and message bodies still never go, and the redaction list (`packages/config/src/redaction.ts`) stays the guard for everything else.
13. **Q-25.13 Whom does the owner call when the report has not arrived by 07:30?** Needed for the runbook until feature 26's outside check exists. **Answered (owner ruling 2026-11-13): the support contact in the brand's contract, as recommended.**
14. **Q-25.14 How is an unconfirmed figure shown?** (a) Its value with the word provisional. (b) "Awaiting confirmation" with no amount, as the reference brand does. **Answered (owner ruling 2026-11-13): (a), as recommended**: spec 0007 M4 says a provisional value is printed, never left out; a figure with no amount teaches the owner to ignore the line.
