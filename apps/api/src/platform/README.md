# Platform

Services every module shares: brand settings, gap free document numbers, the per order cost rules, the audience and permission guards, request validation pipes, and the public client config route.

## Owns

- `GET /api/config`, open to everyone, serving only the `public_config` registry entries (spec 0009, AC-5): [config.controller.ts](config.controller.ts)
- Brand settings typed by the registry in `@ssdashboard/contracts` (`packages/contracts/src/settings/`), in [settings/](settings/):
  - `SettingsService`, the only reader and writer of `settings` ([settings/settings.service.ts](settings/settings.service.ts)): `read(keys)` and `get(key)` return the registry default for a key with no row, and for a row that fails its schema (logged once by key, never the value; `invalid` in the staff read), except that `read` and `get` of an entry marked `onInvalid: 'refuse'` (the inventory lock date and the document prefixes) throw `SettingUnreadable` so the work stops; a read given a transaction goes to the database, any other read to the cache; `write` refuses a value nested deeper than 16 levels, checks the value, the reason rule, `expectedUpdatedAt`, and the rules across settings (`settingWriteIssues`: the default language stays enabled, only languages with a catalog) under one advisory lock, writes nothing for an unchanged value, and otherwise writes the row, the `setting.changed` audit entry, `NOTIFY ssd_platform_changed`, and the `platform.reconcile_modules` job in one transaction. Also `localDate` in the install time zone
  - `SettingsCache` (30 seconds per key) and `PlatformChangesListener` (one dedicated connection running `LISTEN ssd_platform_changed` in the api and the worker, dropping cached keys on each notification, with TCP keepalive whose first probe goes out after 10 seconds idle, so a silently dropped connection errors once the operating system's probes go unanswered (minutes by OS defaults) and is then reconnected, and a 5 second connect timeout, reconnecting with a doubling delay (`LISTENER_RETRY`, overridable in tests) and dropping the whole cache once back): [settings/settings-cache.ts](settings/settings-cache.ts), [settings/platform-changes-listener.ts](settings/platform-changes-listener.ts)
  - `GET /api/settings` and `PUT /api/settings/:key`, staff with `settings.manage`: [settings/settings.controller.ts](settings/settings.controller.ts), the body checked by [settings/put-setting-body.pipe.ts](settings/put-setting-body.pipe.ts) (422 `SETTING_INVALID` for a bad or too deep value, `REASON_TOO_LONG`, `VALIDATION_FAILED`)
  - The `platform.reconcile_modules` queue: `ReconcileModulesProducer`, provided only in the api by [platform-api.module.ts](platform-api.module.ts) (the worker never writes a setting), starts at bootstrap (5 second connect timeout) and enqueues inside the write transaction (pg-boss `fromDrizzle`), `ReconcileModulesWorker` works it in the worker, a no op until spec 0009 milestone 3: [settings/reconcile-modules.queue.ts](settings/reconcile-modules.queue.ts)
- The pg-boss schema name every queue client uses: [job-schema.ts](job-schema.ts)
- Gap free document numbers: [numbering.service.ts](numbering.service.ts); corrupt stored `document_prefixes` refuse the document (`DocumentPrefixesUnreadable`, 409 `DOCUMENT_PREFIXES_UNREADABLE` through `inventory/ledger-http.ts`)
- The per order cost rules in force on a day (`CostRulesService.ruleFor`, `not_set` and never 0 when no rule is set): [cost-rules.service.ts](cost-rules.service.ts), selection in [cost-rule-selection.ts](cost-rule-selection.ts)
- `@Audience(...)` and the deny by default guard: [audience/audience.decorator.ts](audience/audience.decorator.ts), [audience/audience.guard.ts](audience/audience.guard.ts)
- One permission declaration per route and its guard (spec 0008): `Access`, the immutable value object of what the caller may do ([access/access.ts](access/access.ts)), `@Permission(...)` and `@AnyHat()` ([access/permission.decorator.ts](access/permission.decorator.ts)), `@CurrentAccess()` ([access/current-access.decorator.ts](access/current-access.decorator.ts)) and `PermissionGuard` ([access/permission.guard.ts](access/permission.guard.ts)). It reads `request.access`, which identity's session guard sets, and never queries the database
- Request validation: [zod-body.pipe.ts](zod-body.pipe.ts), [zod-query.pipe.ts](zod-query.pipe.ts)
- Keyset paging cursors: [keyset-cursor.ts](keyset-cursor.ts)
- Mapping query errors to answers: [query-error.filter.ts](query-error.filter.ts)
- Auth events other modules can listen to: [events/auth-events.ts](events/auth-events.ts)
- The settings, document counter, custom field, and order cost rule tables (`install` too, written only by `migrate`, which also seeds one `not_set` rule per kind), defined in [packages/db](../../../../packages/db/src/schema/platform.ts)

## Never touches

- Ledger tables or the ledger service.
- Business rules of any module. It offers shared tools only.
- Another module's tables.

## How to test

```bash
pnpm --filter @ssdashboard/api test -- src/platform
pnpm --filter @ssdashboard/api build
pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/numbering-reconcile.e2e-spec.ts test/cost-rules.e2e-spec.ts test/settings.e2e-spec.ts test/settings-cache.e2e-spec.ts
```

[audience/audience.spec.ts](audience/audience.spec.ts) fails the build for a controller without exactly one `@Audience(...)`, and [access/permission.spec.ts](access/permission.spec.ts) for a `staff` or `partner` handler without exactly one valid permission declaration.

## Governing spec

- [0002 Core data model](../../../../docs/specs/0002-core-data-model/index.md)
- [0007 Stack and architecture for the operations layer](../../../../docs/specs/0007-stack-architecture-operations-layer/index.md) (audiences)
- [0008 Roles as hats](../../../../docs/specs/0008-roles-as-hats/index.md) (permissions per route, `Access`)
- [0009 Settings, module toggles, bundles, and the license](../../../../docs/specs/0009-settings-toggles-bundles/index.md) (the settings registry, read and write path, cross process cache)

## Decisions

- The projection rule (A6): a module publishes a past tense domain event inside its own transaction, and no module reads another module's table to fill an order projection column (`orders.write_back_state`, `returned_credit_amount`, `exchange_consumed_amount`, the cash amounts). See [0002 tenancy child](../../../../docs/specs/0002-core-data-model/0002-tenancy-platform.md).

- A setting's audit record id is a name based (version 5) uuid of its key (`settingRecordId`), because `audit_entries.record_id` is a uuid and `settings` rows have none; the entry's label carries the key.
- `SettingsService` takes its audit writer without `@Optional()`, so a missing one fails at boot. Its job producer is `@Optional()` and api only (`PlatformApiModule`, imported by `AppModule` alone), so the worker never opens the send client; a missing producer fails the first write, which only the api serves.

Record other non obvious decisions as ADRs in docs/adr/ and link them here.
