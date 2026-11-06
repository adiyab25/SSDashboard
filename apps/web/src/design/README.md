# Design gallery

A development only `/design` page that shows the design system components, plus the contrast helper used to check color roles (text, meaning color, and boundary pairs) and the type specimens (Inter, Noto Sans Arabic, JetBrains Mono). Production bundles drop it.

## Owns

- The gallery: [design-gallery.tsx](design-gallery.tsx)
- The client side loader that imports it only outside production: [design-loader.tsx](design-loader.tsx)
- Contrast math: [contrast.ts](contrast.ts)
- The route: `src/app/(backoffice)/design/page.tsx`

## Never touches

- Production behaviour. Everything sits behind `process.env.NODE_ENV !== 'production'` and loads through `import()`.
- Component source. Components live in [packages/ui](../../../../packages/ui/).

## How to test

```bash
pnpm --filter @ssdashboard/web test -- src/design
```

The unit spec is [contrast.spec.ts](contrast.spec.ts).

## Governing spec

- [0003 Design system and UI foundation](../../../../docs/specs/0003-design-system-ui-foundation/index.md)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
