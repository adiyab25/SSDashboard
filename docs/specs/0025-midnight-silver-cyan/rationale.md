# Rationale: Midnight, Silver and Cyan

Companion to [index.md](index.md). This file holds the context, the options, the reasons, and the sources. The build spec is `index.md`.

## Context

- [Spec 0003](../0003-design-system-ui-foundation/index.md) built the design system with option B, "Daftar": warm paper neutrals, a deep indigo primary, Inter, Noto Sans Arabic, JetBrains Mono, 8px corners. Its behaviour rules (frames, density, focus, status meaning, provisional values, help, right to left, contrast minimums) are the product's rules and are not in question.
- The owner then chose a different look, "Midnight, Silver and Cyan" (design spec and three reference screens kept outside this repository). It describes the dark theme exactly. It has no light theme; the design spec lists a few starting suggestions and says the light theme must be shown to the owner before it ships.
- The design spec's mockups use sizes that differ from the project's density rules (44px controls, 46px rows, 14px body, a 34px display heading). The design spec itself says the project's density rules win and only the look is meant to change. The owner confirmed it.
- The design is also contrast checked by hand in the design spec. This spec measures it with the project's own formula before trusting it (see below).

## Options considered

1. **Replace the look by changing token values and base components, keep every role name (chosen).** Same shadcn components on Radix, same role tokens, new values, a few new roles and gradient utilities, a font swap. Screens change in batches.
   - Why: it is the smallest change that gives the new look, it keeps spec 0003's behaviour and the tests that guard it, and it keeps the rule "role tokens only" so a screen never needs a colour edit.
2. **Adopt the mockups literally (44px controls, 46px rows, 14px body, 34px heading, status bar, breadcrumb path, keyboard hint chips).**
   - Why not: it changes density, which the owner and the design spec both put out of scope; it adds content and behaviour (a status bar, a path, shortcuts); and it would break `shell.spec.ts` geometry and every table's row height rule.
3. **Dark only, drop the light theme.**
   - Why not: the owner wants the Light, Dark, and System switch to keep working (design spec section 7), and spec 0003 AC-6 requires it.
4. **Design the light theme from scratch with a separate set of roles.**
   - Why not: the owner wants a light theme that matches the dark one from the same roles; deriving values for the same roles keeps one component set. The values are shown on `/design` for approval first (AC-17).
5. **Cyan for info notices.**
   - Why not: cyan means link, focus, and current page. An info notice in cyan would read as a link. Decision 5 uses `muted-foreground` with an "i" icon.
6. **Keep the design spec's plain status dot.**
   - Why not: spec 0003 AC-16 says an icon and a word together and the four meanings need to differ without colour; a dot of the same shape for every meaning loses that. The chip keeps its distinct icons and gains the glow (decision 3).
7. **Keep the design spec's secondary edge (white 25 percent to 8 percent).**
   - Why not: measured 2.19:1 at the top and 1.20:1 at the bottom against the page, below the 3:1 a control boundary needs. The chosen edge runs a lighter slate down to `input` (decision 2).
8. **A bigger heading (34px) with the blend.**
   - Why not: type sizes are not part of this change (decision 4).

## Rationale

- **Look only.** Every decision touches colour, typeface, corner radius, motion, or the look of a base component. None touches a route, a data shape, a permission, a string, the fixed table column order, or a size in `DESIGN.md`. That keeps the risk to token values, a font swap, and class lists, and lets the existing tests guard behaviour (AC-21).
- **Contrast is measured, not assumed.** The design spec's numbers were calculated by hand. They were rerun with the same WCAG 2 formula as `apps/web/src/design/contrast.ts` (the script is named in [verify.md](verify.md)). Dark passes every text and control pair. The weakest are `input` on control fill (3.25) and `input` on `sidebar` (3.75). Light passes too, with the weakest text pair the cyan link on the page (4.98) and the owed chip (4.82), and the weakest control pair `input` on `sidebar` (3.81).
- **Four failures found and handled.**
  - The design spec's secondary button edge fails 3:1 (1.2 to 2.2). Replaced (decision 2).
  - In light, cyan, confirmed, and owed text on `accent` `#DCE5EE` failed 4.5 (4.21, 4.31, 4.25). Resolved on 2026-11-14: the owner chose option B, light `accent` `#E9EEF4`, and every text pair on it passes (4.59, 4.70, 4.65, 4.99 for failed; 16.58 and 6.45 for foreground and muted). AC-5 now states that; row hover stays the `tint-row` utility in both themes. Cyan as text on the light current page tint measures 3.88, so the current page text is `foreground` and cyan is only the marker.
  - The segmented control's selected fill against its track is 1.35, so the selected border in `input` supplies the boundary (decision 7).
  - Two chart colours fail 3:1 and are recorded for the chart spec, not used here (decision 12).
- **Status never uses cyan or the blends.** The design spec says so; the project's rule from spec 0003 (a brand accent never colours status) is the same idea. It makes a "confirmed" green impossible to confuse with a "current page" cyan.
- **Reduced motion has to remove movement.** The repository's global rule only shrinks durations to 0.01ms; a hover lift would still jump 1px and a press would still scale. AC-19 asks for no transform at all, which is what the design spec's `@media (prefers-reduced-motion: reduce)` block does (`.btn:hover{transform:none}`).
- **Arabic needs three extra rules the design spec did not state.** Letter spacing of -0.03em on headings breaks the joining of Arabic letters, so it is 0 under `:lang(ar)`. Geist Mono has no Arabic glyphs, so Noto Sans Arabic is in the mono stack. And gradients that run along the line must flip in right to left, or the tint would fade the wrong way. These come from the project's Arabic first rule (spec 0003 AC-5 and AC-23); they are marked **Assumed** where they are my reading, in [index.md](index.md).
- **Fonts.** Geist has no Arabic glyphs (the design spec says so), so Noto Sans Arabic stays as the Arabic face and Geist is its Latin fallback. Self hosting from committed files keeps spec 0003 AC-23 and the Docker build needing no network (spec 0003, 2026-11-06 amendment).
- **Why a spec and not only an edit of 0003.** Spec 0003 is already carrying three amendments. The new look has its own tokens, acceptance criteria, and milestones across seven batches, so it gets its own spec, and 0003 gets a line saying it is amended.

## Assumed, in one place

- Sidebar token aliases follow their parents (the owner's mapping did not list them).
- Light `primary-edge` `#0B5568` (the owner asked for "a dark cyan").
- Dark secondary edge top `#8A9BB2`; the light edge runs from `#475569` (a darker slate, since a lighter one loses contrast on a light page).
- Light hero blend gets a middle stop `#155E75`.
- Heading letter spacing -0.03em for Latin only; 0 in Arabic.
- `content: '// ' / ''` works in the targeted browsers; M1 verifies.
- Utility and radius token names are proposals.
- The Geist files and licence texts come from the sources the owner named (Google Fonts woff2, the Geist repository). I did not open either in this task.
- `tnum` exists in Geist; M1 checks the font file (AC-16).

## References

- The owner's design spec and reference screens (outside the repository, read only): `DESIGN-SPEC.md`, `screens/DSheet.dc.html`, `screens/DComponents.dc.html`, `screens/DSsdOrders.dc.html`.
- [Spec 0003](../0003-design-system-ui-foundation/index.md): the behaviour rules kept (AC-2 contrast, AC-5 logical CSS, AC-13 and AC-23 fonts, AC-14 targets, AC-15 to AC-23 status, frames, help, density).
- [`packages/ui/DESIGN.md`](../../../packages/ui/DESIGN.md): the density and component rules that stay.
- [`packages/ui/src/styles/globals.css`](../../../packages/ui/src/styles/globals.css): the tokens and the reduced motion rule that change.
- [`apps/web/src/design/contrast.ts`](../../../apps/web/src/design/contrast.ts): the WCAG 2 formula the measurements reproduce.
- [`apps/web/src/shell/root-fonts.ts`](../../../apps/web/src/shell/root-fonts.ts) and [`apps/web/src/shell/fonts/README.md`](../../../apps/web/src/shell/fonts/README.md): how fonts are self hosted today.
