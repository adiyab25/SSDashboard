# Api contracts (`@ssdashboard/contracts`)

The shared shapes of the api: Zod schemas and the types inferred from them. The api validates with them and the web parses answers with them.

Agent gotchas: [AGENTS.md](AGENTS.md).

## Owns

- One file per area of shapes, re-exported from [src/index.ts](src/index.ts): [auth](src/auth.ts), [catalog](src/catalog/index.ts) (a folder: SKU shapes in `skus.ts`, the SKU list query in `search.ts`, `CostBasis` in `cost-basis.ts`; spec 0012 milestone 2: the style list, detail, edit, assign, code change, and add variant shapes in `styles.ts`, seasons in `seasons.ts` (with the shared `GroupingCode` and `GroupingListQuery`), product groups in `product-groups.ts`, barcodes in `barcodes.ts`, and `OptionRole` with `OPTION_ROLE_NAMES` in `option-roles.ts`), [inventory](src/inventory.ts) (the ledger posting shapes; spec 0011 milestone 2: `ReserveLinesInput`, `ReservedLine`, `ReleaseLinesInput`, `ReservationSource`, `ReservationLine`, `CarrierShipmentInput`, and `carrierShipmentKey`), [locations](src/locations.ts), [online-stock](src/online-stock.ts) (spec 0011: the online stock read shapes, the online gate view and its requests, and the status), [platform](src/platform.ts), [staff](src/staff.ts), [stock](src/stock.ts), [stock-receipts](src/stock-receipts.ts), [health](src/health.ts)
- Eleven folders of pure modules, each re-exported from [src/index.ts](src/index.ts). Nothing in them reads a database, a clock, or the network:
  - [customers/](src/customers/): [egyptian-phone.ts](src/customers/egyptian-phone.ts) turns phone text into one E.164 number and its kind (`EgyptianPhone.parse`), and defines `InvalidPhone`; [customer-enums.ts](src/customers/customer-enums.ts) (flag, flag source, external id kind, merge suggestion, and `findOrCreate` outcome enums), [customer-reason-codes.ts](src/customers/customer-reason-codes.ts), [customer-views.ts](src/customers/customer-views.ts) (`CustomerBrief`, `CustomerProfile`, the returner signal `CustomerRiskSignal` with its rule `suggestedRiskFlag`, and `CUSTOMER_PROFILE_GUARDED_FIELDS`), [customer-search.ts](src/customers/customer-search.ts) (`CustomerSearchRequest`: exactly one of phone, name fragment, or flagged), and [customer-timeline.ts](src/customers/customer-timeline.ts) (spec 0014 milestone 4: the timeline entry union `CustomerTimelineEntry`, `CustomerTimelinePage`, `CustomerTimelineQuery`, and the lens table `CUSTOMER_TIMELINE_KINDS` with `timelineLens`).
  - [orders/](src/orders/): [order-states.ts](src/orders/order-states.ts) holds the fulfillment and cash state machines, their transition table, `nextState`, `firstCashState`, and `replayStates`.
  - [orders/](src/orders/): [order-outcome.ts](src/orders/order-outcome.ts) holds `deriveOrderOutcome`, the only place an order's outcome is computed, plus `refundedAmountOf` and `deliveredAmountOf`.
  - [orders/](src/orders/): [payment-method.ts](src/orders/payment-method.ts) holds `OrderPaymentMethod` (`PaymentTender` is it without `none`).
  - [orders/](src/orders/): [line-split.ts](src/orders/line-split.ts) holds `splitLine`, which divides a line on a partial delivery.
  - [orders/](src/orders/): [order-amounts.ts](src/orders/order-amounts.ts) holds `allocatePayments`, `codExpected`, `codDue`, and `linesGrossAmountOf`.
  - [credit/](src/credit/): [credit-enums.ts](src/credit/credit-enums.ts) holds the credit enums; [credit-amounts.ts](src/credit/credit-amounts.ts) holds the return credit and its split by funding, `planConsumption`, `planPayout`, `planDebtPayment`, and the balances.
  - [settlement/](src/settlement/): [settlement-enums.ts](src/settlement/settlement-enums.ts) holds the settlement enums; [settlement-states.ts](src/settlement/settlement-states.ts) holds `lineMatchState` (follows the supersede chain, throws `InvalidMatchChain` on a fork) and `settlementPeriodStatus`.
  - [tasks/](src/tasks/): [task-enums.ts](src/tasks/task-enums.ts) holds the task enums.
  - [platform/](src/platform/): [cost-rules.ts](src/platform/cost-rules.ts) holds the order cost rule enums and the `CostRule` result type.
  - [audit/](src/audit/): the actor union and its constructors ([audit-actor.ts](src/audit/audit-actor.ts)), the entry and list shapes ([audit-entries.ts](src/audit/audit-entries.ts), [audit-reading.ts](src/audit/audit-reading.ts)), the `AUDIT_ACTIONS` registry ([audit-actions.ts](src/audit/audit-actions.ts)), and `AUDIT_RECORD_TYPES` ([audit-record-types.ts](src/audit/audit-record-types.ts)) (spec 0010).
  - [connectors/](src/connectors/): [connector-enums.ts](src/connectors/connector-enums.ts) holds the connector enums (spec 0015).
  - [license/](src/license/): the signed envelope and the strict payload ([license-envelope.ts](src/license/license-envelope.ts)), `bundlePhase` and the union rule per bundle ([license-phase.ts](src/license/license-phase.ts)), and the license API shapes ([license-api.ts](src/license/license-api.ts)) (spec 0009).
  - [settings/](src/settings/): the settings registry ([registry.ts](src/settings/registry.ts), one file per screen group: [brand-settings.ts](src/settings/brand-settings.ts), [policy-settings.ts](src/settings/policy-settings.ts), [catalog-settings.ts](src/settings/catalog-settings.ts)), `PUBLIC_CONFIG_FIELDS` ([public-config.ts](src/settings/public-config.ts)), the rules across settings ([write-checks.ts](src/settings/write-checks.ts)), and the settings API shapes ([settings-api.ts](src/settings/settings-api.ts): the entries with their `step` facts and turn on check, and the off impact) (spec 0009); the location owner type policy shapes of AC-24 sit in [locations.ts](src/locations.ts). `registry.spec.ts` holds every entry to AC-1 and to the free text rule, failing closed: no string anywhere in a value (map keys included) without a `regex` check or a fixed shape format (uuid, ISO date, datetime, time), and no schema type the walk does not know, because the audit trail keeps every value for ever.

    The executing step naming contract (spec 0009, *Executing steps*): each step is a registry entry of `kind: executing_step`, default `false`, reason required, with `notifiesCustomer`, in the bundle of the one capability whose `steps` lists it, added by its owning feature with its executor and never before its capability (no step is registered yet):

    | Key | Bundle | Gates capability | Customer hears about it | Owning feature |
    |---|---|---|---|---|
    | `step.shopify_order_edit_write_back` | operations | `connectors.shopify.order_write_back` | no | 18 |
    | `step.shopify_duplicate_cancel` | operations | `connectors.shopify.order_write_back` | no | 18 |
    | `step.shopify_return_exchange_write_back` | operations | `connectors.shopify.order_write_back` | no (confirmed at build) | 37 |
    | `step.shopify_stock_push` | warehouse | `connectors.shopify.stock_push` | no | 13 (spec 0015), with `SHOPIFY_STOCK_PUSH_NOT_READY` after the platform's `NO_STOCK_OUT_SOURCE` |
    | `step.carrier_driver_forward` | operations | `connectors.bosta.driver` | the courier, as on any delivery | 32 |
    | `step.carrier_driver_exchange` | operations | `connectors.bosta.driver` | as above | 32 |
    | `step.carrier_driver_return_pickup` | operations | `connectors.bosta.driver` | as above | 32, 35 |
    | `step.exchange_auto_approve` | operations | `exchanges.auto_approval` | yes, in the portal | 31 |
    | `step.refund_gateway_execute` | operations | `connectors.shopify.order_write_back` | no Shopify email (confirmed at build) | 35 |
    | `step.meta_purchase_events` | operations | `connectors.meta.conversions` | no | 48 |
    | `step.whatsapp_customer_messages` | operations | `connectors.whatsapp.messages` | yes | 50 |
  - [modules/](src/modules/): the module registry ([module-registry.ts](src/modules/module-registry.ts), its rules in [module-registry-checks.ts](src/modules/module-registry-checks.ts)), module toggles ([module-toggles.ts](src/modules/module-toggles.ts)), the pure `moduleStates` ([module-state.ts](src/modules/module-state.ts)), and the modules API and error shapes ([modules-api.ts](src/modules/modules-api.ts)) (spec 0009).
- Money rules: [src/money.ts](src/money.ts) (`Money`, `UnitCost`, `LineAmounts`)
- Localized text: [src/localized-text.ts](src/localized-text.ts)

## Never touches

- Floats for money. Amounts cross boundaries as `numeric` text.
- Hand written duplicate types. Export `z.infer` types from the schema.
- `apps/*`, the database, or NestJS. It is plain TypeScript and Zod.

## How to test

```bash
pnpm --filter @ssdashboard/contracts test
pnpm --filter @ssdashboard/contracts build
```

Specs sit in [test/](test/) and beside the source (`src/*.spec.ts`). The pure order and customer modules have their own: [egyptian-phone.spec.ts](test/egyptian-phone.spec.ts), [order-states.spec.ts](test/order-states.spec.ts), [order-outcome.spec.ts](test/order-outcome.spec.ts), [line-split.spec.ts](test/line-split.spec.ts), [order-amounts.spec.ts](test/order-amounts.spec.ts), [credit-amounts.spec.ts](test/credit-amounts.spec.ts), [settlement-states.spec.ts](test/settlement-states.spec.ts), and [domain-enums.spec.ts](test/domain-enums.spec.ts). None of them needs a database.

## Governing spec

- [0002 Core data model](../../docs/specs/0002-core-data-model/index.md)
- [0002 orders child](../../docs/specs/0002-core-data-model/0002-orders.md) (`src/orders/`)
- [0002 customers, credit, and tasks child](../../docs/specs/0002-core-data-model/0002-customers-credit-tasks.md) (`src/customers/`)
- [0006 Core stock loop](../../docs/specs/0006-core-stock-loop/index.md)
- [0007 Stack and architecture for the operations layer](../../docs/specs/0007-stack-architecture-operations-layer/index.md)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
