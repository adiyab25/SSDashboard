# Shared

Small pieces of web code that more than one feature folder needs and that belong to none of them: the focus rule of a dialog that has no Radix trigger, and the query client wrapper every screen spec renders under.

## Owns

- `useReturnFocus()`: for a dialog mounted with `open`, remembers the control that had focus when it mounted and hands focus back to it on close (WCAG 2.4.3): [use-return-focus.ts](use-return-focus.ts)
- `renderWithQuery()`: renders a screen under a fresh TanStack Query client that never retries, for component specs: [render-with-query.tsx](render-with-query.tsx)

## Never touches

- Business data or any api call. A piece that reads or writes business data belongs in its feature folder.
- Wording. Nothing here draws text, so nothing here needs `t()`.
- A feature's rules. Move a piece here only when two or more feature folders already import it.

## How to test

```bash
pnpm --filter @ssdashboard/web test
```

Both pieces are exercised by the dialog and screen specs of `src/inventory`, `src/catalog`, `src/audit`, and `src/access`.

## Governing spec

- [0003 Design system and UI foundation](../../../../docs/specs/0003-design-system-ui-foundation/index.md)

## Decisions

- Moved here from `src/inventory` (audit review M3R18) because the catalog and audit screens imported them across feature folders.
