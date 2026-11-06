# App shell

The frame every staff back office page renders inside: sidebar, user menu, command palette, location switcher, and the navigation list they read.

## Owns

- The frame: [app-shell.tsx](app-shell.tsx), [app-sidebar.tsx](app-sidebar.tsx), [skip-link.tsx](skip-link.tsx)
- The navigation list (add a page here to join the sidebar and palette): [nav.ts](nav.ts)
- The command palette: [command-palette.tsx](command-palette.tsx)
- The user menu: [user-menu.tsx](user-menu.tsx)
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

Another Playwright spec: `e2e/menus.spec.ts`.

## Governing spec

- [0003 Design system and UI foundation](../../../../docs/specs/0003-design-system-ui-foundation/index.md)
- [0004 Localization](../../../../docs/specs/0004-localization/index.md)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
