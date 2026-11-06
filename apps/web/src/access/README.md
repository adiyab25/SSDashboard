# Access

What the signed in person may see in the web: their hats and permissions from the who am I answer, the check pages and the shell use to hide what the person cannot use, and the state a page shows when it is opened by its address without its permission.

## Owns

- `useAccess()`: hats, effective permissions, `can(permission)`, and `ready`, read from the who am I answer the page already loads (`useMe`, `/api/me` or `/api/partner/me`): [use-access.ts](use-access.ts)
- The no access state, the page title as the one `<h1>` plus the empty pattern of the design system: [no-access-state.tsx](no-access-state.tsx)
- The plain hat names on one line, for the user menu and the account screen: [use-hats-label.ts](use-hats-label.ts)
- The catalog keys it reads: `access.noAccess.*`, `access.hats.<hat>.name` and `.description`, `access.permissions.<permission>` in `packages/i18n`

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

- A page wires the no access state with `if (access.ready && !access.can(...)) return <NoAccessState titleKey="..." />` and keeps its data loads behind the same check, so the page asks the api for nothing. Wired so far: `/staff` (`people.manage`) and `/locations` (`catalog.manage`); milestone 4 of spec 0008 does the rest.
- Record other non obvious decisions as ADRs in docs/adr/ and link them here.
