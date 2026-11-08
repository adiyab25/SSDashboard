# Shopify connector

The adapter between the shared core and a brand's Shopify store (Admin GraphQL API, version `2026-10`). Today only its synthetic fixtures exist; the client, mapper, and jobs arrive with spec 0015 tasks 4 to 7.

## Owns

- `fixtures/`: hand written, synthetic Shopify Admin GraphQL order recordings for API version `2026-10`, one folder per scenario, to be replaced by recordings from a development store ([fixtures README](fixtures/README.md)).
- Nothing else yet: no client, no mapper, no job, no table, no controller. Each lands with its spec 0015 task.

## Never touches

- Other modules' tables, the stock ledger, and the owner database role.
- Anything outside `shopify/` in the connectors module: the stand-in described in [../README.md](../README.md) stays as it is.
- A real shop domain, token, secret, or customer's data: fixtures use invented people and `fixture-store.myshopify.com` only.

## How to test

Nothing runs against these files yet. To check them:

```bash
pnpm exec prettier --check apps/api/src/connectors/shopify
```

and parse every JSON file as the command in the [fixtures README](fixtures/README.md) shows. Spec 0013's orders intake e2e will read them; no test calls Shopify.

## Governing spec

- [0015 Shopify connector](../../../../../docs/specs/0015-shopify-connector/index.md) (AC-26 fixtures, the order mapping rows of *Value sourcing*)
- [0013 Orders and their state machines](../../../../../docs/specs/0013-orders-state-machines/index.md) (milestone 3, channel intake)
- [Scope feature 13](../../../../../docs/scope/index.md), the open box "Re-record fixtures from a Shopify dev store"

## Decisions

- **Synthetic fixtures** (owner ruling 2026-11-07): until a Shopify development store exists, fixtures are hand written and shaped per shopify.dev for `2026-10`; every file says "synthetic, to be replaced by recordings". No ADR yet.
