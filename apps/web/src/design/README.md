# Design gallery

A development only `/design` page that shows the design system components, plus the contrast helper used to check color roles (text, meaning color, and boundary pairs) and the type specimens (Inter, Noto Sans Arabic, JetBrains Mono). Production bundles drop it.

## Owns

- The gallery: [design-gallery.tsx](design-gallery.tsx)
- The client side loader that imports it only outside production: [design-loader.tsx](design-loader.tsx)
- Contrast math: [contrast.ts](contrast.ts)
- The status samples: order rows in both reading directions ([order-rows-sample.tsx](order-rows-sample.tsx)) and the `floor` scope confirmation queue card ([confirmation-queue-sample.tsx](confirmation-queue-sample.tsx)), joined by [order-status-section.tsx](order-status-section.tsx). The Playwright check in `e2e/design-status.spec.ts` measures the card's buttons.
- The frames section ([frames-section.tsx](frames-section.tsx)): the portal (sample brand, and a refused accent), and the partner frame, each as a development only preview page in an `<iframe>` in both languages, because a frame renders its own `main`. The previews are [portal-frame-preview.tsx](portal-frame-preview.tsx) and [partner-frame-preview.tsx](partner-frame-preview.tsx), with sample text in [frame-preview-copy.ts](frame-preview-copy.ts); their routes are `src/app/(portal)/[lang]/returns/preview/{brand,rejected}/page.tsx` and `src/app/(partner)/[lang]/partner/preview/page.tsx`, a real 404 in production (proxy path list and `notFound()`). `e2e/frames.spec.ts` checks them.
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
