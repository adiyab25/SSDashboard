# Access

What the signed in person may see in the web: their hats and permissions from the who am I answer, the check pages and the shell use to hide what the person cannot use, and the state a page shows when it is opened by its address without its permission.

## Owns

- `useAccess()`: hats, effective permissions, `can(permission)`, `ready`, and `failed` with `retry`, read from the who am I answer the page already loads (`useMe`, `/api/me` or `/api/partner/me`): [use-access.ts](use-access.ts)
- The failed state (the who am I call failed: the page title plus an error with Try again that asks again): [access-error-state.tsx](access-error-state.tsx)
- The no access state, the page title as the one `<h1>` plus the empty pattern of the design system: [no-access-state.tsx](no-access-state.tsx)
- The plain hat names on one line, for the user menu and the account screen: [use-hats-label.ts](use-hats-label.ts)
- The catalog keys it reads: `access.loadError.*`, `access.noAccess.*`, `access.hats.<hat>.name` and `.description`, `access.permissions.<permission>` in `packages/i18n`

## Never touches

- Granting anything. The api decides every request (spec 0008, `PermissionGuard`); the web only hides, and a hidden button's route still answers 403.
- The permission matrix. `HAT_PERMISSIONS` and `Permission` live in `packages/contracts/src/access.ts`; never copy them here.
- Who am I loading and caching. That is `src/auth/use-me.ts`.
- Hard coded text. Use `t()`.

## How to test

```bash
pnpm --filter @ssdashboard/web test -- src/access
pnpm --filter @ssdashboard/web test:e2e -- e2e/access.spec.ts
```

## Governing spec

- [0008 Roles as hats](../../../../docs/specs/0008-roles-as-hats/index.md) (AC-11)

## Decisions

- An action button whose api route needs a permission is hidden without it (`can(...)`): New SKU and Edit SKU need `catalog.edit`, New receipt needs `stock.receive` ([gated-actions.spec.tsx](gated-actions.spec.tsx)).
- A page wires the no access state with `if (access.ready && !access.can(...)) return <NoAccessState titleKey="..." />` and keeps its data loads behind the same check, so the page asks the api for nothing. A failed who am I call renders `<AccessErrorState titleKey="..." onRetry={access.retry} />` first, so a gated page never loads forever. Wired so far: `/staff` (`people.manage`), `/locations` (`catalog.manage`), `/audit` (`audit.read`), `/stock`, `/stock-receipts`, `/stock-receipts/[id]`, `/skus`, and `/skus/[id]` (`stock.view`), and `/stock-receipts/new` (`stock.receive`). The page file checks access and renders a `*-view` file that takes `enabled`; the receipt form takes no prop: it mounts only once the person is allowed (a skeleton with the title shows until then). [gated-pages.spec.tsx](gated-pages.spec.tsx) drives every page through loading, denied, allowed, and failed.
- Record other non obvious decisions as ADRs in docs/adr/ and link them here.
