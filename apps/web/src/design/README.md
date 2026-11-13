# Design gallery

A development only `/design` page that shows the design system components, plus the contrast helper used to check color roles (text, meaning color, boundary, gradient stop, and tint pairs) and the type specimens (Geist, Noto Sans Arabic, Geist Mono). It shows the Midnight, Silver and Cyan look of spec 0025 live, in both themes and both languages, so the owner can approve it. Production bundles drop it.

## Owns

- The gallery: [design-gallery.tsx](design-gallery.tsx)
- The client side loader that imports it only outside production: [design-loader.tsx](design-loader.tsx)
- Contrast math: [contrast.ts](contrast.ts) (`pairContrast` paints a pair over its surface, so tints and gradient stops are measured as painted), the pair lists in [design-pairs.ts](design-pairs.ts) (spec 0025 "Measured contrast": text and controls, tints, the gradient stop groups, and the light accent options), and the live row [contrast-pair.tsx](contrast-pair.tsx) with [contrast-list.tsx](contrast-list.tsx). A row shows a figure, a mark, and the word meets or fails; its `data-testid` is `contrast-<fg>-on-<bg>` (or `contrast-<id>`), and `compare-*` for the accent choice rows, which may fail.
- The look sections: [palette-swatches.tsx](palette-swatches.tsx) (every role with its live hex), [gradient-samples.tsx](gradient-samples.tsx) and [gradient-stops-list.tsx](gradient-stops-list.tsx), [type-specimen.tsx](type-specimen.tsx), [radius-and-density.tsx](radius-and-density.tsx), [motion-samples.tsx](motion-samples.tsx), [status-chips-sample.tsx](status-chips-sample.tsx), [table-sample.tsx](table-sample.tsx) and [table-states-sample.tsx](table-states-sample.tsx), [feedback-samples.tsx](feedback-samples.tsx), and the buttons, fields, overlays, and command samples.
- The light theme accent choice ([accent-choice.tsx](accent-choice.tsx), spec 0025 AC-17): option A (`accent` #DCE5EE, ink row hover) beside option B (#E9EEF4), each with live ratios; B is set as a local `--accent` override because it is not a token. Shown in the light theme only. The owner's decision is recorded in the spec, not here.
- Two documented exceptions to role tokens only: `accent-choice.tsx` (the local `--accent` override for option B) and `contrast-pair.tsx` (inline `style` with the live measured colours it displays). Nowhere else in this folder sets a raw colour.
- Text: the gallery's labels are the `design.*` catalog keys (English and Arabic); the order, phone, help, and frame samples keep their own sample copy.
- The status samples: order rows in both reading directions ([order-rows-sample.tsx](order-rows-sample.tsx), whose "+2" chip opens a popover of the hidden statuses, [overflow-statuses-sample.tsx](overflow-statuses-sample.tsx)) and the `floor` scope confirmation queue card ([confirmation-queue-sample.tsx](confirmation-queue-sample.tsx)), joined by [order-status-section.tsx](order-status-section.tsx). The Playwright check in `e2e/design-status.spec.ts` measures the card's buttons.
- The frames section ([frames-section.tsx](frames-section.tsx)): the portal (sample brand, and a refused accent), and the partner frame, each as a development only preview page in an `<iframe>` in both languages, because a frame renders its own `main`. The previews are [portal-frame-preview.tsx](portal-frame-preview.tsx) and [partner-frame-preview.tsx](partner-frame-preview.tsx), with sample text in [frame-preview-copy.ts](frame-preview-copy.ts); their routes are `src/app/(portal)/[lang]/returns/preview/{brand,rejected}/page.tsx` and `src/app/(partner)/[lang]/partner/preview/page.tsx`, a real 404 in production (proxy path list and `notFound()`). `e2e/frames.spec.ts` checks them.
- The phone first dashboard sample ([phone-dashboard-sample.tsx](phone-dashboard-sample.tsx), text in [phone-dashboard-copy.ts](phone-dashboard-copy.ts), a `CollapsingTable` of orders in [collapsing-orders-sample.tsx](collapsing-orders-sample.tsx)), loaded by [phone-dashboard-loader.tsx](phone-dashboard-loader.tsx) on its own development only page, `src/app/(backoffice)/design/phone-dashboard/page.tsx`, inside the real shell: a page of its own (not an iframe) so a test can load it at 360 by 800 and measure the page itself. The proxy's `/design` path rule makes it a real 404 in production. The numbers are made up and its links go to `#`.
- The in screen help sample ([help-sample.tsx](help-sample.tsx)): the Help button, the `?` key, the panel, and the dismissible first run checklist for the confirmation queue, plus the two `HelpHint`s on the queue card. Text comes from the `help.confirmationQueue.*` catalog keys; the no answer limit is a sample number (`SAMPLE_NO_ANSWER_LIMIT`) standing in for a setting that does not exist yet. `e2e/phone-dashboard.spec.ts` checks both samples at 360 by 800 with touch in English and Arabic.
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
