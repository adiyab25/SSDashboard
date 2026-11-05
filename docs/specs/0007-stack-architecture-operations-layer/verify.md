# Verify: Stack & architecture for the operations layer · spec 0007 · 2026-11-05
_Steps derived from spec 0007. It is a decision spec, so its checks map to the requirements R-1 to R-12 and to the Build plan milestones. Part 1 is for the domain reviewer and the owner at the gate (read checks). Part 2 runs after wave 3 in the shape the owner chose. Part 3 lists the checks later features own, so nothing here is lost._

## Part 1: before the gate (read the spec)

- [ ] `grep -n "^## " docs/specs/0007-stack-architecture-operations-layer/index.md` lists Summary, Verdict on spec 0001, Requirements, Decision, Proposed stack, Architecture shape, Conventions, Alternatives considered, Assessment of the existing build, Decisions at the gate, Carried from the domain review, Build plan, Consequences, Open questions, Follow-up, Rationale.
- [ ] B1 closed: section 7 keys order number on (`tenant_id`, `store_id`, `order_number`), says the store shows beside every order number, and says how the portal resolves phone plus order number across stores.
- [ ] B2 closed: section 1 has "When an outbound command fails" (sync state on the record, `OutboundCommandFailed`, a task, the shell count, the rule that blocks packing) and "What mirror mode cannot do".
- [ ] `## Carried from the domain review` has one row for each finding from M1 to M10 and m1 to m8, each with an owning scope feature number.
- [ ] `## Decision` records the owner decisions of 2026-11-05; Open questions keep the data center open and link `docs/research/0001-egypt-hosting-options.md`.
- [ ] `## Decisions at the gate` has the nine answers dated 2026-11-05, items 5 to 9 marked "recommended default, accepted by the owner without override"; `## Open questions` no longer lists them; each answer that belongs to a later feature has an "Also from spec 0007" line in that feature's scope row (features 4, 9, 13, 19, 22, 25, 27, 29, 41, 45).
- [ ] `## Build plan` states the pilot window (mid March to early May 2027) as a schedule constraint.
- [ ] `grep -n "^### " docs/specs/0007-stack-architecture-operations-layer/index.md` shows one section for each of R-1 to R-11 (numbered 1 to 11) plus bundles and database roles.
- [ ] `grep -n "Status" docs/specs/0001-stack-architecture/index.md docs/specs/0007-*/index.md` shows 0007 `Accepted` and 0001 `Superseded by 0007`.
- [ ] Every row of *Alternatives considered* has a concrete "why not" tied to a force in rationale.md's Context.
- [ ] *Assessment of the existing build* has a row for specs 0002, 0003, 0004, 0005, 0006 and the inventory module, each with keep, amend, or replace, a reason, cited paths, and the new requirements (tenant id; store, channel, source; two order state machines; outcome enum; credit ledger; settlement primitive; owner type and sellable flag; tasks; period close; channel code mapping).
- [ ] Each shape has 2 to 5 milestones with a "Done when" a person can run, its own keep list, and a cost line; the recommendation is a separate line, not inside a shape.
- [ ] Every convention in *Conventions* names its enforcer or says **review only**; every named ESLint plugin and rule is listed with a link in rationale.md.
- [ ] Every repo path cited exists, or the text marks it "to be created". Spot check: `ls apps/api/src/inventory/module-boundary.spec.ts apps/api/src/inventory/locations/locations.service.ts packages/db/src/schema/locations.ts packages/db/src/schema/parties.ts apps/web/src/api/client.ts apps/api/test/scale.e2e-spec.ts`.
- [x] Domain review (wave 2b) of sections 1 to 6 has no open blocker (`docs/reviews/domain-stack.md`; Igris confirms B1 and B2 against this revision).

## Part 2: after wave 3 (both shapes unless marked)

- [ ] Shape A only: `apps/web/src/app/(backoffice)`, `(portal)`, `(partner)`, `(auth)` exist and `(app)` does not → R-2, R-9
- [ ] Shape B only: `pnpm db:migrate`, then `pnpm dev`, then `curl localhost:3001/api/health` → `"status":"ok"`; the web health page renders with `dir="rtl"` in Arabic → R-10
- [ ] `pnpm build && pnpm typecheck && pnpm test` → every task succeeds
- [ ] Remove the `@Audience` annotation from one controller, run `pnpm --filter @ssdashboard/api test` → the audience test fails naming that controller; restore it → passes → R-2
- [ ] `pnpm lint` → passes; switch off `jsdoc/require-jsdoc` in `packages/config/eslint` and run the fixture check → it fails for each export kind (function, class, interface, type alias, enum, exported const, React component, hook) → R-9
- [ ] Delete one module README heading (for example `## Never touches`), run `pnpm lint` → the README script fails naming the file → R-9
- [ ] Empty the redaction list, run the logger test → it fails showing a phone in the output; restore → passes → R-9 (M10)
- [ ] Add a second component to a `.tsx` file → `react/no-multi-comp` fails; add a file `MiscHelper.ts` → `unicorn/filename-case` and the banned names script fail → R-9
- [ ] `git commit -m "wip"` on a scratch branch → the `commit-msg` hook rejects it; the same subject pushed with `--no-verify` fails the CI commit check → R-9
- [ ] Open a PR from a branch named `test-branch` → the CI branch name check fails; from `feat/<slug>` → passes → R-9
- [ ] The PR shows the `app` and `web` image build jobs green, with nothing pushed to the registry → R-5
- [ ] `ls docs/adr/0000-template.md docs/templates/module-readme.md docs/research .github/pull_request_template.md` → all exist → R-9

## Part 3: owned by later features (listed so they are not lost)

- Feature 3: `deploy/compose.dev.yaml` runs PostgreSQL 18, the chosen S3 compatible store, and a mail catcher; fresh clone to running apps under 10 minutes → R-5
- Features 4 and 16: two stores each import order `#1001`; both are stored, every list shows the store beside the number, and the portal lookup for a phone with `#1001` in both stores asks which store → R-7 (B1)
- Features 13, 17, 18: a Shopify write back of a confirmation edit fails after retries → the order shows `failed` with the reason, a task opens for the operations hat, the shell count rises within a minute, and moving the order to packed is refused until resolved → R-1 (B2)
- Feature 19: a recorded Bosta 429 sequence makes the sweep end partial and the next run resume least recently synced first; a delivered shipment with no cash cycle is re read until one appears → R-1 (M1)
- Feature 4: schema test fails if any table outside `pgboss` and `drizzle` lacks `tenant_id uuid not null`; inserting without a tenant id fills it from `ssd.tenant_id` → R-7. The order to refund to settlement test passes for all three owner types with no branch; the owner type boundary test fails on a planted comparison → R-8. The scale suite at 50,000 variants meets its budgets → R-11. The operating day test across a daylight saving change → R-10
- Feature 9: an expired license plus grace period turns Operations routes into 404 `MODULE_OFF`, cancels their jobs, and deregisters their webhooks, with no errors in the logs → R-12, R-1
- Feature 13 onward (each connector): bad signature answers 401 with no inbox row; a repeated delivery id is processed once; a stale event is ignored; any unrecorded outbound HTTP call fails the test; mirror mode attempts no write → R-1
- Feature 25: the daily report runs at the configured Cairo time from confirmed data only, from the worker, with the automation status line → R-3
- Features 26 and 27: restore an exit package dump on a clean server and insert one row → the tenant default fills it → R-6, R-7 (m1)
- Feature 26: a client app role cannot connect to another client's database on the shared server (`psql` as `ssd_a_app` to `ssd_b` → permission denied); backups restore; idle memory per client stack recorded → R-6
- Feature 27: `ops export-package` produces an encrypted dump and files in client storage, and a restore from it works on a clean host → R-6
- Feature 29: portal lookup with a wrong phone and a right phone answer with the same shape and minimum time; the staff cookie is never sent to the portal host; rate limits per phone and address hold across an api restart → R-2
- Feature 41: partner A's session cannot read partner B's given, sold, or owed → R-2
- Feature 45: the export freeze test fails when one cell of a template's output changes; an export run cannot be edited → R-4
