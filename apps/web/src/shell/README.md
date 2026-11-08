# App shell

The frame every staff back office page renders inside: sidebar, user menu, command palette, location switcher, and the navigation list they read.

## Owns

- The frame: [app-shell.tsx](app-shell.tsx), [app-sidebar.tsx](app-sidebar.tsx), [skip-link.tsx](skip-link.tsx)
- The navigation list (add a page here to join the sidebar and palette): [nav.ts](nav.ts); [nav-links.tsx](nav-links.tsx) marks only the most specific entry of the address as the current page (`navItemFor`, the longest match), so `/settings/cost-rules` marks Cost rules and not Settings too
- The module aware shell (spec 0009, AC-9, AC-17): [module-states-api.ts](module-states-api.ts) and [use-module-states.ts](use-module-states.ts) read `GET /api/platform/modules` once (again on window focus, every 60 seconds, and at once when `apiFetch` sees a 404 `MODULE_OFF` or 409 `MODULE_LIMITED`, wired in `Providers`); [nav.ts](nav.ts) entries name their `module` and `visibleNavItems` hides an `off` one (and an `action` entry while `read_only`); [module-page-gate.tsx](module-page-gate.tsx) wraps the page body in `AppShell` and shows [module-not-available-state.tsx](module-not-available-state.tsx) for an off page or [module-notice.tsx](module-notice.tsx) above a read only or limited one; [staff-notice-banner.tsx](staff-notice-banner.tsx) (with [staff-notice-row.tsx](staff-notice-row.tsx)) is the neutral lapse notice for internal hats; [module-reason-text.ts](module-reason-text.ts) words each stop reason; [stock-out-source-notice.tsx](stock-out-source-notice.tsx) is the standing notice on the stock and receipts pages, "Online sales are not deducted from stock on this install yet", shown only while `connectors.shopify.stock_push` is `read_only` with reason `no_stock_out_source` (AC-29, wave 1 review W9); [module-fixtures.ts](module-fixtures.ts) feeds specs
- The command palette: [command-palette.tsx](command-palette.tsx)
- The user menu: [user-menu.tsx](user-menu.tsx)
- The manager's license banner under the top bar (only for `settings.manage`, only when a plan is within 30 days of lapsing or past it, or the license file check failed): [license-banner.tsx](license-banner.tsx), [license-notice-row.tsx](license-notice-row.tsx), [license-problem-row.tsx](license-problem-row.tsx), [license-level-look.ts](license-level-look.ts); [license-notice-row.tsx](license-notice-row.tsx) also draws [license-notice-work.tsx](license-notice-work.tsx) (what stops and what continues, from `licenseNoticeWork` over the module registry, AC-17; a part with an empty list draws nothing) and [use-capability-name.ts](use-capability-name.ts) names a capability by its registry label (the staff notice uses it too); it reads `GET /api/platform/license` through `@/settings/license-api`
- The current location and its `ss_location` cookie: [current-location-provider.tsx](current-location-provider.tsx), [location-switcher.tsx](location-switcher.tsx)
- The documents (root frames): [static-root-frame.tsx](static-root-frame.tsx) for the back office and sign in (head script, English first render), [public-root-frame.tsx](public-root-frame.tsx) for the portal and partner (language from the URL, server rendered), with [root-fonts.ts](root-fonts.ts) (Inter, Noto Sans Arabic, JetBrains Mono through `next/font/local` from the committed variable files in [fonts/](fonts/README.md), so a build needs no request to Google; each font's OFL license text is in `public/licenses/fonts/`) and [root-metadata.ts](root-metadata.ts) (staff) and [public-metadata.ts](public-metadata.ts) (portal and partner, in the page language) they share
- Install name and client config: [client-config.ts](client-config.ts), [client-name.tsx](client-name.tsx)

## Never touches

- Business data for a page. Pages load their own data in client components.
- Server side cookies. Browser state (theme, language, sidebar, location) is read on the client.
- The `(auth)`, `(partner)` and `(portal)` frames, which are separate.

## How to test

```bash
pnpm --filter @ssdashboard/web test -- src/shell
pnpm --filter @ssdashboard/web test:e2e -- e2e/shell.spec.ts
```

Other Playwright specs: `e2e/menus.spec.ts`, `e2e/license.spec.ts` (the banner), `e2e/modules.spec.ts` (off and read only entries and pages, route mocked).

## Governing spec

- [0003 Design system and UI foundation](../../../../docs/specs/0003-design-system-ui-foundation/index.md)
- [0004 Localization](../../../../docs/specs/0004-localization/index.md)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
