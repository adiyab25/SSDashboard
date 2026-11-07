# 0009. Settings, module toggles, bundles, and the license: rationale

Decision record for [index.md](index.md). `/develop` builds from the index; this file explains why. Mode: FEATURE (scope feature 9, GA). References level: `sources`. Written without the owner in the loop: every choice the design conversation would have asked is decided here with the recommended answer, and the owner only questions are in the index under `## Questions for the owner`.

> Amended 2026-11-07: the owner answered the five questions (plus a sixth, the optional Warehouse expiry) and the [domain review](../../reviews/domain-settings-toggles-bundles.md) was folded in. The new decisions are the last rows of *Decisions settled here*, and *Why the wind down widened* explains the largest change.

> Amended 2026-11-07 (second note, slice 1a wave 1): the owner's rulings on the partners split, the core connectors, and the requested settings rows (owner, 2026-11-07, "Accept all", relayed by the lead session) are recorded in the index; *Why partners split into a module of their own* and the last rows of *Decisions settled here* explain how they fit the registry.

## Context

One image is sold two ways (final plan section 5): Warehouse, a perpetual license, and Operations, a yearly plan priced in EGP. Both sit on a Core that is never sold alone. The same code must therefore behave as a Warehouse install, an Operations install, or both, with no per client build (AGENTS.md: "config is env only; client differences live in settings, module toggles, custom fields, or `extensions/<client>`, never core edits"). The decision on the license itself is made (spec 0007 *Bundles, module toggles, and the license (R-12)*): a signed Ed25519 file over client id, bundles, Operations expiry, and issue date, a public key in the image, verified at startup and daily, no phone home. What is not decided is everything around it: where settings and toggles live, how a change reaches every process, what "off" means for each surface, how the lapse is computed, and what a damaged file does.

The forces:

- **Operations is other people's APIs** (Shopify, Bosta, Meta, WhatsApp). When it lapses, the brand's biggest fear is being stranded (debate round one, objection 2). The owner chose a read only wind down at the gate (spec 0007 gate item 1): mirror reads and the cash sweep continue for shipments created before the lapse until a final cash state or `operations_wind_down_days` (default 60), with warnings at 30, 14, and 7 days, a 14 day grace, and a backfill on renewal (domain review M5, re review n2).
- **Two processes read settings**: the api and the worker (`apps/api/src/main.ts`, `apps/api/src/worker.ts`). Today `SettingsService.read` goes to the database on every call and each job reads the time zone once at startup (`apps/api/src/inventory/ledger/reconcile.job.ts`: "a change to the timezone setting applies after a worker restart"). A toggle that only takes effect after a restart is not a toggle.
- **Jobs outlive intentions.** pg-boss keeps schedules in its own tables and queued jobs survive restarts (`.claude/skills/pg-boss-v12/SKILL.md`), so a module "switched off" in code still fires its cron and runs its queued work unless something removes them. Each existing job also creates its own `PgBoss` instance today.
- **Executing steps act on the outside world for the brand**: creating Bosta shipments, refunds, Shopify writes, Meta events, WhatsApp messages, automatic approvals (final plan 6.7, 6.9, 6.16, 7.3; scope features 31, 32, 35, 37, 48, 50). A mistake costs real money or a customer's trust, and slice 1a is built on mirror mode precisely because it "needs no permission to execute anything" (scope index, *Why this order*).
- **Location owner types must be a setting, not three code paths** (final plan 6.5, spec 0007 section 8). The policy table, its service, and its boundary test exist in the feature 4 design (catalog child); feature 9 owns editing it, and edits must not reinterpret recorded history.
- **Self host and offline** installs must behave the same as vendor hosted ones (spec 0007 section 6), so nothing may depend on reaching the vendor.
- **Team size**: 1 to 3 developers plus agents. Every new table, endpoint, and screen per setting multiplies across 65 features.

Not deciding means every later feature invents its own flag, its own cache, and its own way to stop its jobs, and the first lapse at a pilot brand finds the orphans.

## Options considered

### Option 1: Settings table for values, a dedicated toggles table, license state in memory

Keep `settings` for brand values; add `module_toggles` (module key, enabled, changed by) and a `step_switches` table; verify the license file at startup into process memory; each module checks a flag service and stops its own jobs in an `onModuleDestroy`.

**Pros**:
- Toggles are visibly separate from ordinary settings in the schema.
- No new tables for the license.

**Cons**:
- Three tables with three read paths, three caches, three audit calls, and three screen patterns for what are all typed values with a default and an owner.
- License state in memory differs between the api and the worker after a file change until both restart, and leaves no evidence of what was checked when.
- Each module stopping its own jobs is the orphan bug spread across 20 modules: one forgotten `unschedule` and a lapsed brand keeps calling Bosta.

### Option 2: One typed registry; toggles and steps as settings rows; recorded licenses; one job supervisor (chosen)

One registry in `packages/contracts` describes every setting (schema, default, bundle, who may change it, reason rule) and every module and capability (bundle, toggle, kind, wind down). Module toggles and executing steps are settings rows. The license file is verified and each valid license is recorded in an append only table, with a check row per verification. A worker supervisor reconciles pg-boss schedules, workers, and queued jobs against the computed state; every job is declared through one registry. LISTEN and NOTIFY drop caches across processes, with a short cache lifetime as the fallback.

**Pros**:
- One read path, one cache, one audit action (`setting.changed`, spec 0010 AC-19 names exactly this), one screen pattern; a new knob or step is one registry entry with no migration.
- "No orphaned jobs" is one place's job, provable by one test, and inherited by every later feature that declares its jobs.
- Recorded licenses give evidence and make a lost or damaged file harmless.
- Pure functions (`moduleState`, `operationsPhase`) in contracts are testable exhaustively and shared with the web.

**Cons**:
- The registry files are shared files every feature edits.
- One more decorator per controller and one declaration per job.
- A LISTEN connection per process.

### Option 3: Environment variables for bundles and toggles, no settings screen for them

`BUNDLES=warehouse,operations` and `MODULES_OFF=...` per client in `.env`, with the license only checking that env matches.

**Pros**:
- Simplest; matches "config is env only" literally.
- No runtime switching, so no reconciliation.

**Cons**:
- AGENTS.md puts client differences in settings and module toggles, not env; env is for deployment facts.
- A brand manager cannot switch anything; every change is a vendor redeploy, which a self host client cannot do safely.
- A lapse would need someone to edit env on time, the opposite of an automatic wind down.

### Option 4: Online license activation with a vendor server

The install calls a vendor endpoint daily to confirm entitlement and receive toggles.

**Pros**:
- Revocation and expiry changes are immediate; clock rollback is irrelevant.

**Cons**:
- Rejected by spec 0007 (no phone home; offline installs must work).
- A vendor outage or a network block switches brands off; a transfer abroad would also need Law 151 review.
- Another service for 1 to 3 developers to run.

## Rationale

Option 2 is chosen because it answers the forces with the fewest moving parts. Toggles and executing steps are, in shape, settings: a typed value with a default, a bundle, an owner, and an audit trail. Storing them as settings rows gives one cache, one invalidation path, one audit action, and one screen, which is what lets a 1 to 3 person team add 11 executing steps and a dozen knobs across later features without new plumbing (basis: spec 0010 AC-19, "adding an action costs one row"; the existing `SettingShapes` pattern in `apps/api/src/platform/settings.service.ts`). The license is different in kind, a signed fact from outside, so it alone gets tables, and append only ones, because its history is the evidence in a dispute (basis: AGENTS.md append only rule; spec 0002 tenancy child A4).

The supervisor exists because the scope's done line is "a module turns off cleanly without errors or orphaned jobs", and pg-boss keeps schedules and queued jobs in the database across restarts (basis: `.claude/skills/pg-boss-v12/SKILL.md`, scheduling and the job table). The only reliable design is one place that knows every queue and every schedule (`JobRegistry`) and makes the database match the computed state (`unschedule`, `offWork`, `cancel`), plus a gate inside every handler for the race window. A handler that starts after the switch completes with `skipped` rather than failing, so the off switch produces no error and no retry storm (basis: pg-boss retry semantics in the same skill: a failed job is retried; a completed one is not).

Cross process freshness uses PostgreSQL LISTEN and NOTIFY because the database is already the one shared service, a notification sent inside a transaction is delivered only if that transaction commits (basis: PostgreSQL documentation for `NOTIFY`), and it needs no new infrastructure. The 30 second cache lifetime covers a dropped listener; the durable `platform.reconcile_modules` job, enqueued in the same transaction as the toggle (basis: spec 0007 *Background jobs*, transactional `send`), covers a worker that was down. Three paths, each cheap, for a switch whose failure would be a brand being charged by Bosta for shipments it did not want.

Recorded licenses only add, and the entitlement is the union of them. This keeps a deleted, damaged, or half copied file from switching a paying brand off, which matters more for a self hosted brand at 2am than the vendor's ability to shorten an expiry remotely, which no offline design can offer anyway. For the same reason the clock rule records a clock set back in time but does not act on it: acting on a high water mark would let a clock wrongly set into the future switch Operations off permanently. The license is a commercial lock with evidence, not copy protection; a self host client who controls the machine can always patch an image (basis: spec 0007 R-12, no phone home; owner question 2 records the alternative).

### Why the wind down widened (amended 2026-11-07)

The first version kept only the Bosta reads and the cash sweep alive after a lapse. Read as a working week (domain review D1), that strands the brand anyway: cash arrives and moves orders to `remitted`, but `remitted` becomes `reconciled` only when the settlement lines are matched, and the matching job and the accountant's match, account, and close actions were gone, so open items never reached zero and the last month could never close. Spec 0007's own gate decision says "the settlement screen stays usable for them". The amendment adds the matching job as `pre_lapse` and the person facing close out as `until_closed`, and introduces the `limited` state so these keep working only for records from before the lapse. The same state lets work in flight finish after a lapse or a manager's toggle off (D6, owner ruling 3) without reopening new requests. Warehouse gets no wind down phase because nothing outside the brand holds Warehouse money; its only in flight risk is stock in transit, which `inventory.transfers_receive` covers.

Read only for lapsed modules keeps spec 0007's "data stays readable": `GET` routes keep answering and write routes answer 404 `MODULE_OFF`. The narrower reading of spec 0007 (every route 404) would hide the brand's own exchange and credit history behind a commercial event, the stranding fear the gate decision exists to remove (basis: domain review M5; final plan section 5, "the exit package is product").

Location owner policy edits go through the inventory module, which owns the table, and lock the three stock semantics fields once a location of that type exists, because movements recorded at a location always join to the owner type they were recorded under without date logic (spec 0002 catalog child: owner type fixed for a location's life). Letting `handover_is_sale` flip under existing partner stock would silently change what the next count means; locking it costs a brand nothing before it opens its first partner location, which is exactly when it decides these answers.

Executing steps are listed by name now, before their features exist, so that every later spec uses one vocabulary and the "every executing step defaults to off" test has a contract to check against. Exclusions are deliberate: an action that only changes the install's own data, is audited, and can be undone in one step (period close confirming itself, exact channel code matches) is not an executing step; reading from a provider is not; the daily report goes to the brand's own group and starts only when a manager connects it.

### Why partners split into a module of their own (amended 2026-11-07, wave 1)

The owner ruled that the partner record and showroom send and return are core while the partner portal and partner settlement stay an Operations toggle. The registry has exactly one switch, the module toggle, and a core module has none, so a toggleable part cannot live inside the core `partners` module without a second switch mechanism (a toggle per capability), which would double the screen, the reconcile, and the dependency checks for one case. The record cannot move into the toggleable side either: identity binds partner logins through `PartnerAccounts` and inventory checks a location's party role through it (`apps/api/src/partners/README.md`), both core, and AGENTS.md forbids a core module depending on an optional one. So the toggle gets its own module, `consignment`, which calls `PartnerAccounts`, inventory, and the settlement primitive through their exported services and owns its own tables when feature 41 designs them. Partner sign in and the partner's own account stay in identity: they are core today (spec 0008), a partner whose portal is off loses nothing by signing in to a page that says so, and gating sign in would make identity ask an optional module on every partner request.

The Shopify queue is shared because spec 0015 needs one job per connection at a time across every Shopify job, which pg-boss gives per queue. Splitting the queue by capability would break that, so the supervisor stops a capability on a shared queue by its schedule keys and job data instead of stopping the queue's workers (installed `pg-boss` 12.38.0: `ScheduleOptions.key`, `unschedule(name, key)`, `FindJobsOptions.data`).

### Decisions settled here (the RECOMMEND items)

| Decision | Pick | Why | Runner up |
|---|---|---|---|
| Where toggles and steps live | settings rows | one path for everything typed (above) | a `module_toggles` table |
| Where the registry lives | `packages/contracts` | the web renders the screen and filters nav from the same keys and schemas (AGENTS.md, one schema per shape) | inside `apps/api/src/platform` with a generated web copy |
| Absent setting row | registry default | a new knob needs no migration; `sqlRead` keys stay seeded for `ssd_operating_day` | seed every key in a migration |
| Invalid stored value | default plus `invalid` flag and one log line | fail safe (a step reads off), screen shows it; writes always validate | throw on read (today's behaviour), which would 500 the screen meant to fix it |
| Cache invalidation | LISTEN and NOTIFY plus 30 second lifetime plus durable reconcile job | no new service; covers listener loss and worker downtime | no cache (a query per gate check on every request) |
| Who may change | `settings.manage` (the manager hat, spec 0008) for everything in this spec; cost rules also need `cost.view`; `currency` nobody | money columns carry no currency (spec 0002), so a currency change would corrupt history | operations hat for policies |
| Lapsed module routes | `GET` answers, writes 404 `MODULE_OFF` | data stays readable (spec 0007) | every route 404 |
| Hook routes when off | 200 plus `ignored_unlicensed` | providers delete subscriptions that keep failing (spec 0007 section 1) | 404 |
| License envelope | JSON with base64url payload bytes and signature | signs exact bytes, so no JSON canonicalization question | detached signature over canonical JSON |
| Binding | `clientCode` and `tenantId` of the `install` row | a license cannot be copied to another brand's install | client code only |
| Dev and tests | a committed `devOnly` key refused in production (the `app` image sets `NODE_ENV=production`, `deploy/Dockerfile.app`; amended 2026-11-07: trusted only when `APP_VERSION` is also `0.0.0-dev`, security review m2) | real verification path in dev and tests | a bypass flag |
| Clock | database `now()`, rollback recorded not enforced | one clock for both processes; no permanent lockout from a wrong clock | high water mark enforcement |
| Lapse instant | local 00:00 of expiry plus 15 days in `timezone` | expiry date is the last active day, then 14 grace days | the operating day with its cutoff (adds a dependency for no gain) |
| Retention bonus default | not set (no bonus) | no money leaves by default, like "not set" cost rules (final plan 6.10) | a numeric default |
| Retention task default | off | creates work for support; the brand switches it on at onboarding | on |
| Auto approval price limits | two limits, `max_customer_pays` and `max_brand_refunds`, both 0.00, and a scope knob (amended 2026-11-07, D12) | money coming in at the door is low risk, money going back out is not; one symmetric limit would let raising it for slice 1b also refund downgrades with no person | one limit with leftovers always kept as store credit |
| Capability states (amended 2026-11-07) | four: `on`, `limited`, `read_only`, `off` | the wind down and a toggle off must let pre lapse cash close and work in flight finish (D1, D6) without reopening new work; `limited` scopes writes to records opened before an instant | more capabilities with `windDown` true and no record scope, which would reopen new work too |
| Route gate granularity (amended 2026-11-07) | `@RequiresModule` or `@RequiresCapability` | Operations work lives inside core modules (confirmation queue in `orders`, carrier cash in `settlement`); a module key alone cannot stop it (D4) | module only, which leaves the queue on after a lapse |
| Stock push without a stock out source (amended 2026-11-07) | pause it (`requiresOneOf`), one task, feature 13 adds the Shopify fulfillment source | pushing ledger quantities the ledger no longer lowers oversells (D2); a pause is honest and cheap | make the Bosta delivery facts a core capability (review option a), which puts an Operations connector into Core |
| Backfills and resumed steps (amended 2026-11-07) | a backfill only catches up mirror state; a step acts only after its `since` (the `updated_at` of the switch-on write, the module turn-on, or the renewal) | renewals and switched on steps must not treat weeks of history as fresh work or fresh messages (D3); the settings row already holds the instant, so no new column | a per step cursor table |
| Pre lapse scope (amended 2026-11-07) | the carrier's own creation time, plus `operations_wind_down_pickup_days` (default 3) for orders confirmed before the lapse | deliveries for the last evening's confirmations are created after midnight and are still the brand's cash (D5) | discovery time only |
| Wind down length (amended 2026-11-07) | at least 60 days | the reference repo's fee window is 60 days; a shorter wind down drops cash still arriving (D8) | `whoMayChange: nobody`, set at provisioning |
| Cost rule in a locked period (amended 2026-11-07) | 409 `COST_RULE_IN_LOCKED_PERIOD`, or recorded with `inLockedPeriod` and a reason under its own audit code | moving the lock date back reopens stock postings, a broader action for a narrow fix (D14) | refuse with no override |
| Warehouse expiry (owner ruling 6, 2026-11-07) | optional `warehouseExpiresOn`; same warnings and grace; then read only with no wind down, except receiving transfers already dispatched | a paid pilot needs Warehouse features that can end (D18); no outside party holds Warehouse cash, so there is nothing to wind down, but stock in transit must land | the pilot as Operations only, accepted on a paid Warehouse license |
| Where the partner portal and settlement toggle lives (owner ruling, 2026-11-07, wave 1) | a new toggleable Operations module `consignment`; the record stays in core `partners` | one switch kind (the module toggle); identity and inventory keep calling a core service | Operations capabilities inside `partners` with a per capability toggle |
| Executing steps and capabilities (amended 2026-11-07, wave 1) | a step gates exactly one capability, named in the module registry's `steps`, and takes its state from it | spec 0015 needs the stock push capability (preview, reconcile) to run before its step is on, and one capability carries several steps (order write back) | a step as a capability of its own kind, which would stop the preview the step's own precondition needs |
| When a registry row lands (amended 2026-11-07, wave 1) | with the code that does its work; an empty `requiresOneOf` is never satisfied | a row ahead of its code would read `on` and let the stock push run with no stock out source (D2) | rows for every planned capability now, with a built flag |
| Shared queue (amended 2026-11-07, wave 1) | stop a capability by schedule key and job data; never stop the queue's workers while its owner runs | keeps spec 0015's one job per connection rule | one queue per capability |
| Requested settings rows (amended 2026-11-07, wave 1) | the requesting spec decides keys, defaults, ranges, bundles, and reason rules; this spec decides permission names, groups it leaves open, and the free text rule | each side decides what it knows | copy the requests verbatim, including `manager` |
| Payload format (amended 2026-11-07) | stays `format: 1` | no license has been issued, so adding an optional field changes no issued meaning | `format: 2` |

## References

**Project sources**
- `AGENTS.md`: config is env only, client differences in settings and module toggles; two database roles; append only ledgers; audiences deny by default; one schema per shape; Law 151 logging rule.
- Spec 0007: *Bundles, module toggles, and the license (R-12)*, section 1 *Switching off on lapse*, section 2 (Turnstile fallback by setting), section 8 (location owner type), section 10 (operating day cutoff), *Configuration* (`LICENSE_FILE`), *Decisions at the gate* item 1, *Carried from the domain review* M5 and M7.
- `docs/reviews/domain-stack.md`: M5 and the re review finding n2.
- Spec 0002 amendment: [tenancy child](../0002-core-data-model/0002-tenancy-platform.md) (platform tables, A4, A5, the operating day), [catalog child](../0002-core-data-model/0002-catalog-locations.md) (`location_owner_policies`, `order_cost_rules`), [orders child](../0002-core-data-model/0002-orders.md) (final cash states, `outbound_commands`).
- Spec 0004 amendment (settings `languages`, `default_language`, `currency`, `timezone`; `GET /api/config` AC-4); spec 0005 (the `admin` role, sessions); [spec 0010](../0010-audit-trail/index.md) (`AuditService.record`, `setting.changed`, `policy.changed`, AC-19).
- Final plan `docs/positioning/2026-11-05-egypt-order-operations-layer.md` sections 5, 6.5, 6.7, 6.9, 6.10, 6.13, 6.16, 7.3; scope `docs/scope/foundations.md` feature 9, `docs/scope/index.md` bundles, `docs/scope/exchange-loop.md` features 31, 32, 35, 36, 37.
- Code read: `apps/api/src/platform/settings.service.ts`, `config.controller.ts`, `platform.module.ts`, `audience/audience.guard.ts`, `apps/api/src/inventory/ledger/reconcile.job.ts`, `apps/api/src/worker.module.ts`, `apps/api/src/config/env.ts`, `packages/db/src/schema/platform.ts`, `packages/contracts/src/platform.ts`, `apps/web/src/shell/nav.ts`, `deploy/Dockerfile.app`.
- Wave 1 (amended 2026-11-07): specs 0011 (AC-24, AC-25: the minimal partner create and showroom moves), 0012, 0013, 0014, and 0015 (their *Settings requested from feature 9* sections, the `connector-shopify` queue, the executor registry); scope `docs/scope/consignment-and-accounting.md` feature 41; `docs/handover/2026-11-07-settings.md` (the relayed rulings); the installed `pg-boss` 12.38.0 `dist/index.d.ts` and `dist/types.d.ts` (`schedule`, `unschedule`, `getSchedules`, `findJobs`, `cancel`, `offWork`); code read: `apps/api/src/partners/`, `apps/api/src/identity/partner-users/partner-users.controller.ts`, `apps/api/src/identity/sign-in/partner-me.controller.ts`, `apps/web/src/app/(partner)/`, `packages/contracts/src/settings/setting-definition.ts`, the existing job files (`license-check.job.ts`, `reconcile-modules.queue.ts`, `reconcile.job.ts`, `auth-cleanup.job.ts`, `mail-queue.ts`).
- Installed skills: `.claude/skills/pg-boss-v12/` (scheduling, `unschedule`, `getSchedules`, `offWork`, `findJobs`, `cancel`, retry semantics; written for pg-boss 12.15 while the repo pins `^12.38.0`, so calls are confirmed against the installed types at build time), `.claude/skills/nestjs-best-practices/` (guards for cross cutting route rules, event driven decoupling, graceful shutdown).

**Practices & standards**
- Fail safe defaults: an automation is off until a person switches it on.
- Reconciliation loops (desired state compared with actual state) over imperative start and stop calls.
- Offline signed licenses with public key verification (Ed25519 as provided by Node's `node:crypto` `verify`).
- PostgreSQL LISTEN and NOTIFY delivered on commit.
- Expand and contract migrations; append only audit evidence.
