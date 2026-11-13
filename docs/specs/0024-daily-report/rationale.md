# 0024. Daily report: decision record

The build spec is [index.md](index.md). This file holds the reasoning `/develop` skips.

## Context

The owner's real interface is a chat group. The reference brand sends a confirmed business report at 06:00 Cairo to a Telegram forum group, with a separate direct message for automation status, and it took four systems to keep that one message alive: an agent on the server with timers, Telegram topics, cron jobs, a watcher, and a separate ads sync with its own database, with the owner as the integrator of all of it (reference brand notes 9 and section 7). Slice 1a promises the same report as a product feature: at a fixed Cairo time, built only from confirmed data, a worker job with no host privileges (final plan 7.6, spec 0007 section 3).

Spec 0007 settled the frame at its gate: a pg-boss cron in the worker with `tz` from the install time zone, reading through the reporting module's metric dictionary, rendered in the brand's language, sent through an outbound command, and a Telegram group first (gate decision 6, accepted by the owner); WhatsApp group sending has eligibility conditions still to check against Meta's own pages. It also defined what "confirmed" means for a report at 06:00: own records confirm after the day closes and a sweep agrees; third party money only after period close; an unconfirmed figure is printed with its value and the word provisional, never as zero.

The forces left for this spec are delivery and failure. The scope's done when asks that a failed send retries and shows up on the dashboard. The app already has one failure path for any outside call (spec 0015 AC-24: outbound commands with retries, `failed` with a code, an event, a task), and a `mail` module that sends through any SMTP server. Telegram's servers are outside Egypt, so Law 151 limits what may travel that way. Spec 0016's owner question 6 (ratified on 2026-11-13) also asks this feature to provide the sender for one line alerts on failed write backs. No owner is in this session, and the lead asked that the delivery channel be put to the owner.

## Options considered

### Option 1: A reporting job that renders, a connectors outbound command that sends to Telegram, email to the managers on failure (chosen)

The job reads spec 0023's figures and renders the text; a `telegram.send_message` command carries it; the outbound framework retries and fails it; reporting reacts to failure with a task, the dashboard, and a fallback email.

**Pros**:
- Rendering sits with the figures, sending with every other outside call; a failure behaves like any failed sync.
- One sender serves the report and spec 0016's alerts.
- A broken bot is never silent: the email reaches the managers the same morning.

**Cons**:
- The brand must create a bot and add it to the group.
- Two paths to keep working (Telegram and the fallback email).

### Option 2: Email only, through the `mail` module

The report is an email to the manager hat every morning.

**Pros**:
- Already built; no new provider; nothing leaves for a foreign chat service.

**Cons**:
- The owner reads the group, not email; the reference brand's report lives in Telegram, and spec 0007's gate chose Telegram.
- Email is easy to ignore, which defeats the report's purpose.

### Option 3: A WhatsApp group through the WhatsApp Cloud API

The report goes to the WhatsApp group many Egyptian owners use.

**Pros**:
- WhatsApp is where most Egyptian teams talk.

**Cons**:
- Group sending is limited to eligible business accounts and groups the business creates, per provider documentation only (spec 0007 m6); not checked against Meta's own pages, so not buildable in slice 1a.
- Needs a WhatsApp business number and template approval before the first report.

### Option 4: Send straight from the job, outside the outbound framework

The job calls Telegram directly and records success or failure on its own row.

**Pros**:
- Fewer moving parts for one daily call.

**Cons**:
- A second failure path to build and test; the dashboard, tasks, and retries would differ from every other outside call.
- Spec 0016's alerts would need their own sender.

## Rationale

The report exists because the owner reads the group, so the main channel follows the owner (Telegram, as the gate decided) and the failure channel follows reliability (email, already built, reaches every manager). Option 1 is the only one that meets the scope's failure clause without new machinery: the outbound framework already retries, records a code, and publishes `OutboundCommandFailed`, and reporting only adds what a failed report means (the task, Needs you, the email, the line in the next report). Option 4 saves a table row and costs a second, different failure path. Option 3 is the right long term answer for many Egyptian brands, but it cannot be built on unverified facts; it stays as feature 50's research and slots in later as a second channel kind behind the same `ReportChannel`. Option 2 is kept, but as the safety net, not the main road.

Two smaller calls. The job never computes a figure (it calls spec 0023's reader and stores what it sent), so the report and the dashboard cannot disagree, and the stored figures let anyone check later that they did not. Waiting up to an hour for confirmation, then sending provisional, follows spec 0007's rule that a provisional value is shown with its label and never left out: an owner who gets nothing three mornings in a row stops reading.

## References

**Project sources**:
- Spec 0007 section 3, gate decision 6, carried rows M4 and m6; section 1 (outbound commands).
- Spec 0015 AC-2 (sealed credentials) and AC-24 (failure contract).
- Spec 0016 owner question 6 and its Follow-up (alerts through this sender).
- Spec 0023 (the metric dictionary and the Today page order).
- reference brand notes, item 9 and section 7; final plan 7.6.
- The `mail` module README (`apps/api/src/mail/README.md`).

**Practices & standards**:
- Idempotency keys for any operation with an outside side effect.
- One failure path for every outbound call (retry, record a code, raise a task).
