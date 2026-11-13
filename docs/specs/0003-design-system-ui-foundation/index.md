# 0003. Build the back office design system on shadcn/ui (Radix, Vega, zinc) in a shared `packages/ui`, with the app shell as its first real screen

**Date**: 2026-11-03
**Status**: Proposed (amendment of 2026-11-05 for scope feature 5; the original decision was accepted and built)
**Amended by**: [spec 0025](../0025-midnight-silver-cyan/index.md) (2026-11-13), which replaces the look (option B, Daftar: colour, type, corner radius, motion, and the look of base components) with Midnight, Silver and Cyan. The behaviour rules below stay.

## Summary

This spec sets the look of the back office and builds its frame (the app shell: sidebar, top bar, location switcher, command palette) that every later screen sits inside. The look is quiet and neutral: zinc grays, black and white actions with no colored accent, 10px corners, IBM Plex Sans in English and Arabic, light and dark modes, compact table rows, and normal sized forms. The components live in a new shared `packages/ui` package built from shadcn/ui, written with start and end (logical) sides so Arabic right to left layout mirrors cleanly. A development only `/design` page shows every token and component, and automated accessibility checks (axe) run on it in light, dark, left to right, and right to left.

> Amended 2026-11-05: the look described above is the original direction and is now one of three options (Quiet Ledger). The frame, the package, the gallery, and the checks stay. See Amendment 2026-11-05 below.

> Amended 2026-11-06 (Daftar built): the owner picked option B, Daftar, and milestone 1 built it, so "Vega, zinc" in the title and the zinc, black and white, 10px corners, IBM Plex wording in the paragraph above no longer describe the code. Built: warm paper neutrals (hue 70 to 85), a deep indigo primary (`oklch(0.38 0.12 275)` light, `oklch(0.78 0.12 280)` dark), radius 0.5rem, table rows 40px, header 44px, controls 40px, body text 15px, Inter plus Noto Sans Arabic plus JetBrains Mono. The frame, the package, the gallery, and the checks are as described. Values and measured contrast: `packages/ui/DESIGN.md`.

> Amended 2026-11-13 (spec 0025): the look of option B, Daftar, is replaced by [Midnight, Silver and Cyan](../0025-midnight-silver-cyan/index.md): new colour tokens (a dark theme as designed, a derived light theme), Geist and Geist Mono instead of Inter and JetBrains Mono (Noto Sans Arabic stays), explicit radius tokens, and new motion. Everything about behaviour stays as written here: the frames, density (40px controls and rows, 44px table header, 32px sidebar items, 15px body, the `floor` scope), the status meaning and provisional rules, help, right to left, focus and target sizes, and the contrast minimums. Where this spec names Daftar values, fonts, or colours, spec 0025 and `packages/ui/DESIGN.md` hold the current ones.

## Amendment 2026-11-05

Scope feature 5 was rewritten for the new product ([rebuild plan](../../positioning/2026-11-05-rebuild-plan.md), [positioning](../../positioning/2026-11-05-egypt-order-operations-layer.md)). Shape A of [spec 0007](../0007-stack-architecture-operations-layer/index.md): keep and amend, never replace. Nothing below removes the built shell, `packages/ui`, `/design`, or the axe checks. The amendment adds what the new product needs on top, and asks the owner to pick the look.

### Why it changes

- **The users changed.** The original look was drawn for a generic warehouse ERP. The product is now the order operations and warehouse back office of an Egyptian clothing brand: confirmation agents on calls and WhatsApp all day (the queue is the longest daily session), warehouse staff scanning, an operations lead reading tables, and the owner on a phone (positioning section 2). Arabic first, English always.
- **Status is now the content.** An order carries a fulfillment state, a cash state, a source, an outcome, and an attention flag (positioning 6.1). Numbers are confirmed or provisional (positioning 7.6, the brand's own rule from the [reference brand notes](../../positioning/2026-11-05-reference-brand-notes.md) item 5 and 11). The original spec only had in stock, low, and error.
- **There are now three frames, not one.** Spec 0007 section 2 adds a public returns portal on its own host (customers on cheap Android phones and slow networks, carrying the brand's own logo and accent) and a partner surface. The original spec built one frame and left "the public portal and partner seams" with a minimal frame.
- **Two scope items were never designed.** A phone first pattern for the manager dashboard, and a pattern for in screen help (staff turn over, so help and training are product). Scope feature 5 now lists both in its Done when.
- **What a real brand uses today** (read only: the design notes of the reference console, `docs/rebuild/2026-10-21-design.md` in that repository, summarised in the [insights](../../positioning/2026-11-05-reference-brand-notes.md)): a branded green on paper white, Inter plus IBM Plex Sans Arabic, light only, a bottom bar on phones. It shows that a brand expects to see its own colors, and that the brand's green is also the color of "success". Both facts shape the rules below.

### New requirements

Numbering continues from AC-14. Every direction below must satisfy all of them; the direction only changes values.

- **AC-15**: The chosen direction is applied: `packages/ui/src/styles/globals.css` and `packages/ui/DESIGN.md` carry its tokens, fonts, density, and focus width, in light and dark, with every pair measured and meeting AC-2 (4.5:1 text, 3:1 control boundaries and focus ring), including the new status and chip pairs. `/design` shows the new pairs live. axe stays at zero violations on `/` and `/design` in the four theme and direction combinations.
- **AC-16**: Status is shown by four meaning roles: `confirmed`, `failed` (failed delivery), `owed` (cash owed), and `provisional`, each defined in light and dark as an alias of an existing hue (success, destructive, warning, and the muted foreground) so no new hue is added. A `StatusChip` always renders an icon and a word together; color is never the only carrier of meaning. One row shows at most three chips (fulfillment, cash, attention), the rest sit behind a count.
- **AC-17**: Provisional values never look like confirmed ones. A provisional number is drawn with a leading `≈`, a dashed boundary (never a solid one), and a visually hidden "provisional" label for screen readers; confirmed numbers are plain. A total that mixes both shows the confirmed part and the provisional part separately. Every dashboard and report view that shows provisional data carries a freshness strip ("Confirmed through <operating day>, today is provisional").
- **AC-18**: The design system covers three frames, each with exactly one `<h1>` and one `<main>`: `AppShell` (back office, as built), `PortalFrame` (public portal: one column, brand logo and accent, language switch, no sidebar, no command palette, no staff navigation), and `PartnerFrame` (partner surface: top navigation with the partner's name and the brand logo, no location switcher, no command palette, no cost columns). Frames take all text through props. `/design` shows all three, in left to right and right to left.
- **AC-19**: Per brand portal theming works from settings, never from the image: a brand supplies an accent color and a logo; the system derives `--brand` and `--brand-foreground` and refuses an accent whose best foreground (white or near black) is below 4.5:1, falling back to the neutral primary. The accent colors only the logo tile, a top rule, and the main portal button. It never colors status, text, the focus ring, or any chip. The logo has an `alt` from the brand name.
- **AC-20**: A phone first pattern for the manager dashboard exists in `DESIGN.md` and in `packages/ui`: one column from 320px, numbers first, tap targets of 44 by 44, no hover, no horizontal scroll from 320 to 430px, tables collapse into cards below 640px, a bottom tab bar of at most four tabs, and a freshness strip. Playwright at 360 by 800 with touch passes, in both languages.
- **AC-21**: A pattern for in screen help exists in three layers, and works from the keyboard: a `HelpHint` (a small button that opens a popover with one or two sentences, for a field, column, or outcome), a `HelpPanel` (a page guide in a sheet, opened by a top bar button or the `?` key outside text fields, with steps, an outcome glossary, and an optional recorded training slot, Esc closes and focus returns), and a first run checklist per hat that can be dismissed and brought back. Help text is keyed, typed, and present in Arabic and English (a missing Arabic key fails a test). Help that quotes a policy value (retry count, callback delay) reads it from settings, so it cannot go stale. Help never holds the only copy of an instruction a user must follow.
- **AC-22**: Dense work surfaces have written rules: the data table row height per direction, a `floor` density scope (taller rows, 48px controls, a thicker focus ring) that the confirmation queue and the scan screens use on a coarse pointer in every direction, one outcome per button with a visible shortcut, and the sticky action bar on phones.
- **AC-23**: Type works for Arabic first: Arabic body text is optically at least as large as the Latin text beside it (tuned per pair by size adjustment, recorded in `DESIGN.md`), line height at least 1.7 for Arabic, codes stay in `LtrText` in a monospace face, digits are Western in both languages (as built), tabular figures work in the chosen face, and every font file is self hosted with its OFL license text shipped. The portal loads one Arabic weight pair first and falls back to the system face meanwhile (`font-display: swap`), so a slow phone shows text at once.

  > Amended 2026-11-06: fonts are self hosted from committed files with `next/font/local` (`apps/web/src/shell/fonts/`), so building an image needs no request to Google.

### Direction options

All three are token level changes on the same shadcn on Radix components, so none replaces the shell, and none changes a component's structure. Each has a static preview with Arabic and English samples: an order row table, one confirmation queue card, the 375px phone dashboard, and the portal frame. Open them in a browser (they load the preview fonts from Google Fonts; the product self hosts).

| | A. Quiet Ledger (keep and tune) | B. Daftar (warm paper) | C. Floor Console |
|---|---|---|---|
| Preview | [quiet-ledger.html](directions/quiet-ledger.html) | [daftar-warm-paper.html](directions/daftar-warm-paper.html) | [floor-console.html](directions/floor-console.html) |
| Feel | Calm zinc, color only where it means something | Warm paper, ink blue actions, tinted chips | Big, loud, readable from a metre away |
| Fonts | Plex Sans + Plex Sans Arabic | Inter + Noto Sans Arabic | Readex Pro (both scripts) |
| Primary | near black (as built) | deep indigo | deep teal |
| Base text | 14px | 15px | 16px |
| Table row | 36px | 40px | 48px |
| Status chip | muted fill, colored word | tinted fill, colored word | solid fill, white word, 6px start stripe |
| Focus ring | 2px | 2px | 3px |
| Rework of built code | none (values only) | token values and font swap | token values, font swap, density tokens |

Shared facts for all three, measured with a throwaway script that converts each oklch value to sRGB and applies the WCAG 2 formula; the script reproduces the figures in `packages/ui/DESIGN.md` for the built zinc set (foreground on background 19.89, muted foreground 6.85, success 5.90) before any new value was trusted. `/design` recomputes every pair live in the browser in the build. Every value below is a proposal tuned to pass; the build may nudge a lightness to keep the margins.

**How the four meaning colors work** (same rule in all three): `confirmed` maps to the success hue, `failed` to destructive, `owed` to warning, `provisional` to the muted foreground drawn dashed. Each is always an icon plus a word (check, cross, coin, dashed clock). Info never carries order state. A brand accent is never used for any of them (see AC-19), so a brand whose accent is green cannot be confused with "confirmed".

#### Option A. Quiet Ledger (keep and tune)

- **Feel**: a calm zinc ledger; hue appears only as the four meaning colors. The original look, with status, provisional, frames, and brand theming added.
- **Type pairing**: IBM Plex Sans (English) with IBM Plex Sans Arabic, designed as one family, so a SKU inside an Arabic name aligns without tuning; optional IBM Plex Mono for codes. All SIL Open Font License 1.1 (to be confirmed against each font's OFL file in build task 1.1). Already built and served by `next/font`. Sizes: 14px body, 20px page title, Arabic one step more line height (as built).
- **Color roles**: unchanged from `globals.css` (light: background white, foreground zinc 950, primary zinc 900; dark: background zinc 950, primary near white). Added aliases only: `confirmed`, `failed`, `owed`, `provisional`, plus `brand` and `brand-foreground`. Meaning colors, light then dark, contrast on the page background: confirmed 5.90 and 9.90, failed 5.85 and 7.44, owed 6.34 and 10.54, provisional 6.85 and 8.60. Chips sit on `muted`: confirmed 5.36 and 7.41, failed 5.31 and 5.57, owed 5.76 and 7.89, provisional 6.22 and 6.44.
- **Density**: table rows 36px, header 40px, controls 36px (as built), about 22 rows on a 1080p screen. The confirmation queue is one order at a time in a 28rem card; outcome buttons 36px, 44px on touch. Scan screens use the `floor` scope.
- **A status heavy order row**: order code, customer, area, total, then two chips in a muted fill with a colored word and an icon, and an attention flag under the customer name. Provisional cash is a dashed outline chip. No stripe. The row reads left to right (or right to left) as: what, who, where, how much, where it is, where the money is.
- **Phone dashboard**: white page, a freshness strip in muted, then a full width "Cash owed" card with an amber start edge, two half cards (confirmed yesterday, failed delivery rate), a dashed "Today so far" card, a "Needs you" list of at most five rows, and a four tab bar. Calm, very little color.
- **Portal frame**: white page, 6px top rule in the brand accent, brand logo tile and name, one column of 320px, one brand colored button; Plex Sans Arabic as the only loaded face.
- **Pros**: zero rework and zero regression risk; passes AC-2 already; Plex was built as one family for exactly this mixed script content; the least decoration, so the status colors stand out the most.
- **Cons**: the primary action ("Confirmed") is near black like the text, so the main button is the weakest part of the queue card; the look is generic and says nothing about the product; no warmth for people who look at it eight hours a day.
- **Risk to built code**: none. Tokens, fonts, and components stay.

#### Option B. Daftar (warm paper)

- **Feel**: a well kept paper ledger (daftar means notebook or ledger): warm off white paper, ink blue for the one main action, soft tinted chips, Arabic set first.
- **Type pairing**: Inter (English) with Noto Sans Arabic (Arabic), both SIL OFL 1.1 (to be confirmed in build task 1.1); JetBrains Mono for codes (OFL). Inter has tabular figures. The two faces are not one family, so the Arabic size is tuned up by about one pixel (16px beside 15px Latin) and checked by eye in build task 1.1; this is recorded in `DESIGN.md`. Sizes: 15px body, 17px section title, 20px page title.
- **Color roles** (oklch, light then dark):

  | Role | Light | Dark |
  |---|---|---|
  | background | 0.985 0.006 85 | 0.19 0.012 70 |
  | foreground | 0.22 0.02 70 | 0.96 0.01 85 |
  | card | 0.997 0.003 85 | 0.23 0.014 70 |
  | muted | 0.955 0.01 85 | 0.28 0.014 70 |
  | muted-foreground | 0.46 0.02 70 | 0.75 0.02 80 |
  | border (decorative) | 0.9 0.012 85 | 0.33 0.014 70 |
  | input | 0.58 0.02 70 | 0.6 0.02 75 |
  | primary | 0.38 0.12 275 | 0.78 0.12 280 |
  | primary-foreground | 0.99 0.003 85 | 0.2 0.03 275 |
  | success (confirmed) | 0.45 0.11 150 | 0.78 0.15 150 |
  | warning (owed) | 0.48 0.11 65 | 0.82 0.14 80 |
  | destructive (failed) | 0.5 0.19 27 | 0.74 0.16 25 |
  | info | 0.45 0.07 235 (slate) | 0.78 0.08 235 |

  Measured, light and dark: foreground on background 16.61 and 16.45; muted foreground on background 6.85 and 8.30, on muted 6.27 and 6.56; input on background 4.11 and 4.67 (needs 3); primary foreground on primary 10.05 and 8.82; primary on background 9.91 and 8.99; success 6.77 and 9.78, warning 6.45 and 10.45, destructive 6.34 and 7.46, info 7.02 and 9.37 on the background. Chips are the hue at 12 percent mixed into the card with the hue as text: 5.80, 5.55, 5.47 and 6.00 in light (success, warning, destructive, info), 7.27, 7.71, 5.73 and 7.01 in dark. Info is a quiet slate, not a bright blue, so it cannot be mistaken for the indigo primary.
- **Density**: table rows 40px, header 44px, controls 40px, about 20 rows on a 1080p screen. The queue card is one order at a time with 44px outcome buttons; the `floor` scope lifts it to 48px.
- **A status heavy order row**: the same columns as A, with tinted chips (a soft color wash and a colored word with the icon) that read faster across a table than outlined ones; a provisional chip is dashed and transparent. A quiet start edge is not used.
- **Phone dashboard**: warm paper page, white cards with a hairline border, the amber edge on "Cash owed", chips tinted, the "Today so far" card dashed. The indigo appears on the active tab and the one primary action.
- **Portal frame**: the warm paper page, a 6px brand rule, logo tile, one 320px column, the brand button. The warmth keeps a returns form from feeling like a bank.
- **Pros**: the one main action stands out in the queue; warm paper is easier over a long shift than white; tinted chips scan well; Noto Sans Arabic is a plain, neutral Arabic face that sits in dense tables.
- **Cons**: two unrelated families need a tuned Arabic size and a visual check; an indigo primary is a hue every client shares, so it can clash with a client's own brand color in the portal (mitigated: the portal uses the brand accent, not the indigo); warm tints shift how the status colors look, so the chips need the live contrast check.
- **Risk to built code**: low. Token values change; `next/font` loads two different families; every component keeps its classes. The `/design` contrast table and the `DESIGN.md` numbers are rewritten. Screenshots in existing tests, if any, change.

#### Option C. Floor Console

- **Feel**: built for the call and the scanner: larger type, taller rows, solid status chips, a thick start stripe you can read from a metre away; a console for the people who spend all day in the queue.
- **Type pairing**: Readex Pro for both Arabic and Latin (one family, a Lexend derivative made for easy reading; SIL OFL 1.1, to be confirmed in build task 1.1); JetBrains Mono for codes. One family for both scripts keeps the two scripts matched in size and weight. Whether Readex Pro has tabular figures is unverified; build task 1.1 checks it and falls back to the mono face for numeric columns if it does not. Sizes: 16px body, 18px section title, 22px page title.
- **Color roles** (oklch, light then dark):

  | Role | Light | Dark |
  |---|---|---|
  | background | 0.97 0.004 250 | 0.14 0.012 255 |
  | foreground | 0.16 0.02 255 | 0.97 0.004 250 |
  | card | 1 0 0 | 0.19 0.014 255 |
  | muted | 0.94 0.006 250 | 0.25 0.016 255 |
  | muted-foreground | 0.44 0.025 255 | 0.76 0.02 255 |
  | border (decorative) | 0.88 0.008 250 | 0.3 0.016 255 |
  | input | 0.55 0.025 255 | 0.6 0.025 255 |
  | primary | 0.42 0.09 200 (teal) | 0.8 0.1 200 |
  | primary-foreground | 0.99 0 0 | 0.14 0.012 255 |
  | success (confirmed) | 0.42 0.12 150 | 0.78 0.16 150 |
  | warning (owed) | 0.45 0.11 60 | 0.82 0.14 80 |
  | destructive (failed) | 0.48 0.2 27 | 0.75 0.16 25 |
  | info | 0.44 0.15 262 | 0.78 0.11 260 |

  Measured, light and dark: foreground on background 17.80 and 18.26; muted foreground on background 7.11 and 9.28, on muted 6.51 and 7.46; input on background 4.44 and 5.05; primary foreground on primary 7.66 and 11.07; success, warning, destructive, info as text on the background 7.31, 7.06, 6.57, 7.31 in light and 10.57, 11.25, 8.20, 9.91 in dark. Chips are solid fills with the on color (white in light, the dark page color in dark): success 7.75 and 10.57, warning 7.48 and 11.25, destructive 6.96 and 8.20, info 7.75 and 9.91. Provisional stays a dashed outline with foreground text, never a solid fill.
- **Density**: table rows 48px, header 52px, controls 48px, a 3px focus ring, about 16 rows on a 1080p screen. This is the `floor` scope applied everywhere. An operations lead who wants more rows on screen gets fewer than in A or B.
- **A status heavy order row**: a 6px start stripe in the status color (decorative, the chip repeats it), then the same columns with solid chips: a green "Confirmed", a red "Failed delivery", a dashed "Provisional". Across a table the stripe and solid chips let you find every failed delivery without reading.
- **Phone dashboard**: the same card stack with larger numbers, a solid "Cash owed" card edge, and the tab bar at 56px with 16px labels; the page is cool gray so white cards separate clearly in sunlight.
- **Portal frame**: cool gray page, white card, 6px brand rule, larger inputs (48px) that suit a thumb on a cheap phone.
- **Pros**: best for the confirmation agents and the warehouse; the status is readable at a glance and at a distance; large touch targets everywhere help the phone and the handheld; the single Readex Pro family keeps both scripts matched.
- **Cons**: the fewest rows per screen, which is wrong for the operations lead's long tables; loud color on every row can fatigue over a day, and a screen full of solid red and green hides the one row that needs attention; Readex Pro's tabular figures and its Arabic hinting at 14px are unverified; the biggest visual change.
- **Risk to built code**: medium. Tokens, fonts, and density tokens change, the shell's top bar (56px) and sidebar item (32px) heights have to be revisited, and `shell.spec.ts` geometry checks may need new numbers.

#### Recommendation

**Option B, Daftar**, with the `floor` density scope from option C (AC-22) so the queue and the scan screens get tall rows and big targets on touch devices.

- The two sessions that matter most are the agent's queue and the owner's phone. B gives the queue a primary action that stands out (A's near black does not) without the fatigue risk of C's solid color on every row, and its warm paper and neutral Arabic face suit the longest daily session.
- The `floor` scope gets C's real benefit, for the people who need it and only on coarse pointers or the scan and queue screens, while the operations lead's tables keep 40px rows.
- The risk is low: tokens and `next/font` only, no component structure changes.
- If the owner wants zero visual change and zero risk, A is a safe fallback and still satisfies every new requirement. C is the right pick only if most of the day is on handhelds or tablets.

### Design delta

These patterns hold in every direction; only values differ.

#### Three frames (AC-18)

| | Back office | Public portal | Partner |
|---|---|---|---|
| Audience, host | staff, `ops.<brand domain>` (`(backoffice)`) | customers, `returns.<brand domain>` (`(portal)`) | consignment partners, staff host (`(partner)`) |
| Component | `AppShell` (as built) | `PortalFrame` | `PartnerFrame` |
| Navigation | sidebar grouped by module, command palette, location switcher | none; logo, language switch, a back link | top bar tabs (statements, stock at your location, settlement), partner name |
| Density | dense tables and forms, the `floor` scope on queue and scan screens | one column, large inputs, 320px baseline | dense tables, simpler, no cost columns |
| Identity | client name from `/api/config` | brand logo and accent from settings (AC-19) | brand logo, partner name |
| Language | `lang`, `dir` by the language setting (spec 0004) | rendered on the server in the visitor's language so a slow phone never waits on a catalog (spec 0007 section 10) | as back office |
| Network budget | normal | tight: one Arabic weight pair first, system face meanwhile, no icon library beyond the few used, no web fonts for the Latin text that the system face covers | normal |

All three use the same role tokens and base components; a frame is a layout plus a few props, not a second system. The sign in screens use a minimal frame (as before). Wiring the frames into the route groups belongs to the features that build those screens; this spec builds the frame components and shows them on `/design`.

#### Status and provisional value display (AC-16, AC-17)

- Four roles, each icon plus word: confirmed (check), failed delivery (cross), cash owed (coin), provisional (dashed clock). Order state and cash state are separate chips; an attention flag ("Stuck 3 days") is a third element under the name, not a chip.
- At most three chips per row; beyond that a count chip ("+2") opens the detail. Row order is the same in every table: code, who, where, how much, state, cash.
- Provisional: `≈` before the number (inside a `bdi` so it stays first in right to left), a dashed boundary, "provisional" read by screen readers. Confirmed values are plain. A dashboard card that is provisional is a dashed card, never a solid one.
- Meaning never relies on position or color. The start stripe of option C is decorative.
- The freshness strip sits under every dashboard and report header: "Confirmed through 4 Nov, today is provisional".
- Cash owed always names who owes (Bosta, a partner, a customer).

#### Phone first manager dashboard (AC-20)

Baseline 360 by 800, works from 320. One column. Top to bottom:
1. A header with the brand name and the date, and a freshness strip.
2. A full width "Cash owed to you" card, the biggest number, with the split below (Bosta, partners).
3. Two half cards: confirmed yesterday, failed delivery rate.
4. A dashed "Today so far" card, provisional.
5. "Needs you", at most five rows, each a full width tap target of at least 44px with a chip and a link to the exact screen; a count when there are more.
6. A bottom tab bar of at most four tabs (Today, Orders, Cash, More), 56px tall.

Each card is a link to a drill down page, never a hover. Tables below 640px collapse to cards of the same chips. The first screen order matches the pushed daily report ([positioning 7.6](../../positioning/2026-11-05-egypt-order-operations-layer.md)) so the owner reads the same story in Telegram and in the app. The four numbers on the first screen are an owner decision (see the questions).

#### In screen help (AC-21)

Staff turn over, so help is part of every screen, in three layers:
- **HelpHint**: a small question mark button next to a field, a column header, or an outcome button. It opens a popover of one or two sentences. Never on hover alone; it works by tap and by Enter and Space, with an accessible name that includes what it explains.
- **HelpPanel**: a sheet from the start edge titled "How this screen works", opened by a button in the top bar and by the `?` key when focus is not in a text field. Content: numbered steps, a glossary of the outcomes and states on the screen (each shown with its real chip), the settings that change the behavior (read live), and an optional slot for a recorded training clip served from the install's own storage with captions in both languages.
- **First run checklist**: per hat (agent, warehouse, lead, owner), a short list of the first actions ("Confirm your first order", "Scan a receipt") with progress, dismissible, restorable from the help panel. Empty states teach in the same words as the panel.
Help text lives in the message catalogs under `help.<screen>.*`, typed, in Arabic and English, so a missing Arabic key fails the build. Where help quotes a policy ("three no answers closes the order"), the number comes from settings, so the help is never wrong for that brand.

#### Per brand portal theming (AC-19)

The brand supplies an accent color and a logo in settings (the names and the public read endpoint belong to the portal spec; see Follow-up). `deriveBrandTokens(accent)` returns the fill, the foreground (white or near black, whichever has more contrast) and whether it is accepted (at least 4.5:1). A rejected accent is refused at save with the nearest accepted lightness suggested, and the portal falls back to the neutral primary. Worked examples with the same method: the real brand's green `#0A7C39` with white text is 5.31:1 (accepted); a yellow `#F2C230` with white text is 1.68:1 but with near black text 12.53:1 (accepted with a dark foreground). The accent colors the logo tile, the 6px top rule, and the main button only. Focus ring, links, status, and error colors stay the system's, so a green brand never makes "failed" look like "confirmed".

> Amended 2026-11-06 (milestone 3 built): the near black foreground is the system's own `#211910` (Daftar light `--foreground`, `oklch(0.22 0.02 70)`), which `deriveBrandTokens` uses, not pure `#000000`. Measured with the WCAG 2 formula, `#F2C230` with `#211910` is 10.35:1 (12.53:1 holds only for pure black); white on it stays 1.68:1. It is still accepted with the dark foreground. The `#0A7C39` with white figure of 5.31:1 is unchanged.

## Requirements

**User stories**:
- As a staff member, I want every screen inside one consistent frame with navigation, so I always know where I am and can move fast.
- As a staff member at a warehouse or showroom, I want to pick the location I'm working in once, so later screens can show that place by default.
- As a keyboard or screen reader user, I want every control reachable and announced, with visible focus, so I can work without a mouse.
- As an Arabic speaking user, I want the whole frame mirrored right to left, so it reads naturally.
- As a developer, I want one written design standard and a gallery page, so later features build screens that match without guessing.

**Acceptance criteria**:
- **AC-1**: `packages/ui/DESIGN.md` exists and defines: color roles for light and dark with each pair's measured contrast, the type scale and fonts, spacing, radius, density (table row and form control heights), focus style, elevation, motion, icon rules including which icons mirror in right to left, and component rules for the shell, data tables, forms, and feedback (toast, dialog, empty, loading, error states).
- **AC-2**: Every text color pair defined in the tokens meets 4.5:1 contrast (3:1 for large text), and every UI component boundary and the focus indicator meets 3:1 against adjacent colors, in both light and dark. axe reports zero violations on the shell and on `/design` in all four combinations: light and dark, each in left to right and right to left.
- **AC-3**: Every page renders inside the shell: a sidebar listing the navigation registry entries grouped by module, a top bar with the client name, the location switcher, a command palette button, and the user menu, plus a single `main` landmark holding the page content.
- **AC-4**: Keyboard: a "Skip to main content" link is the first focusable element; Tab moves through every shell control in visual order in both directions; focus is always visible; Ctrl+B (Cmd+B on macOS) toggles the sidebar; Ctrl+K (Cmd+K) opens the command palette; Esc closes any open overlay and returns focus to the control that opened it.
- **AC-5**: With `dir="rtl"`, the sidebar sits on the right, the mobile sheet slides in from the right, directional icons (chevrons, arrows, back) are mirrored, and the layout is the mirror of left to right. No physical side utilities (`ml-`, `mr-`, `pl-`, `pr-`, `left-`, `right-`, `text-left`, `text-right`, `border-l`, `border-r`, `rounded-l`, `rounded-r`, and the like) exist in `packages/ui` or `apps/web` source; the lint step fails if one is added.
- **AC-6**: Theme offers Light, Dark, and System in the user menu; a first visit follows the operating system setting; the choice survives a reload; the page never flashes the wrong theme on load.
- **AC-7**: On screens 768px wide and up, the sidebar collapses to an icon rail and expands again, and that state survives a reload. Below 768px the sidebar is hidden, opens as a sheet from the start edge via a menu button in the top bar, and closes when you pick a page.
- **AC-8**: The command palette lists every navigation registry entry visible in the current environment, filters as you type, and Enter goes to the highlighted page.
- **AC-9**: The top bar shows `clientName` from `GET /api/config`. If that call fails or is still loading, it shows "SSDashboard" and the rest of the shell works normally.
- **AC-10**: The location switcher lists active (not archived) locations of type warehouse or showroom, ordered by code, with "All locations" first, and never lists transit or virtual locations. The choice is stored in a browser cookie and survives a reload. `useCurrentLocation()` returns the selected location id or `'all'`. If the stored id is not in the loaded list, it falls back to `'all'` and rewrites the cookie. With zero such locations the switcher is visible but disabled and reads "No locations yet". While the list is loading, and if loading fails, `useCurrentLocation()` returns `'all'`; on failure the switcher shows an error message with a retry action.
- **AC-11**: In development, `/design` shows every token (color roles with live contrast, type, spacing, radius, density) and every component in `packages/ui` with its states (default, hover, focus, disabled, loading where it applies), plus a direction switch (left to right or right to left) that also appears in the shell's user menu. In a production build, `/design` returns 404, the direction switch is absent, and the page is always `dir="ltr"`.
- **AC-12**: No UI string is hard coded: all shell and `packages/ui` text comes from the English message dictionary through `t()` (or through props, for `packages/ui` components), and a missing or misspelled key fails the type check. The sample content on the development only `/design` page (specimen text, demo labels) is exempt.
- **AC-13**: Text renders in IBM Plex Sans; any element under `lang="ar"` renders in IBM Plex Sans Arabic. Both fonts are self hosted: the browser makes no request to a third party font host at runtime. A `tabular-nums` utility is available for numeric columns.

> Amended 2026-11-06 (Daftar built): AC-13 as written (IBM Plex) is replaced by: text renders in Inter; any element under `lang="ar"` renders in Noto Sans Arabic; codes and the `/design` code specimen use JetBrains Mono. All three are self hosted by `next/font` (`apps/web/src/shell/root-fonts.ts`) with their SIL OFL texts in `apps/web/public/licenses/fonts/`, and the browser still makes no request to a third party font host at runtime. `tabular-nums` is unchanged.
- **AC-14**: Every interactive target is at least 24 by 24 CSS pixels; on a coarse pointer (touch screens), shell controls (menu button, sidebar items, switcher, palette button, user menu) are at least 44 by 44.

## Decision

**Chosen option**: Option 2: shadcn/ui in a shared `packages/ui`, with the app shell as the tracer bullet

Build the design system as a shared `@ssdashboard/ui` workspace package initialised with shadcn/ui (Radix primitives, Vega style, zinc base, RTL on), tokens in Tailwind v4 CSS variables, documented in `packages/ui/DESIGN.md`, and prove it end to end by building the real app shell in `apps/web` on top of it.

> Amended 2026-11-06 (Daftar built): Vega and RTL stay as initialised, but the zinc base is replaced by the Daftar tokens in `packages/ui/src/styles/globals.css` (see the Color, Radius, Density, and Fonts rows and the paragraphs below).

**Implementation skills**: `shadcn` (`shadcn-ui/ui`, `.claude/skills/shadcn/`) · `tailwind-4-docs` (`lombiq/tailwind-agent-skills`, `.claude/skills/tailwind-4-docs/`) · `design-md` (`.claude/skills/design-md/`) · `nextjs-app-router-patterns` (`wshobson/agents`, `.claude/skills/nextjs-app-router-patterns/`) · `vercel-react-best-practices` (`.claude/skills/vercel-react-best-practices/`) · `nestjs-best-practices` (`kadajett/agent-nestjs-skills`, `.claude/skills/nestjs-best-practices/`) · `turborepo` (`vercel/turborepo`, `.claude/skills/turborepo/`) · `pnpm` (`antfu/skills`, `.claude/skills/pnpm/`)

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

### Engineer's choices (fixed)

| Dimension | Choice |
|---|---|
| Design source | No external design; direction set in this spec |
| Kit scope built now | App shell. Tables, forms, and feedback are specified in `DESIGN.md` and built by the first feature that needs them (7, 8) |
| Primitives / style | shadcn/ui on Radix UI, Vega style, `init --rtl` |
| Color | Zinc neutral; primary is near black in light mode and near white in dark mode (monochrome, no hue) |
| Radius | `--radius: 0.625rem` (10px) |
| Modes | Light and dark, System by default, via `next-themes` |
| Density | Table rows 36px; form controls at the Vega defaults; no density toggle |
| Icons | Lucide (`lucide-react`) |
| Fonts | IBM Plex Sans + IBM Plex Sans Arabic, self hosted |
| Component home | `packages/ui` (`@ssdashboard/ui`) |
| Gallery | Development only `/design` route in `apps/web` |
| Accessibility checks | axe in Vitest (components) and in Playwright (pages, all four theme × direction combinations) |
| RTL before feature 5 | Development only direction switch (cookie) |
| Navigation | Collapsible sidebar grouped by module; sheet below 768px |
| Top bar | Client name, location switcher, command palette (Ctrl/Cmd+K), user menu placeholder |
| Branding | Client display name from `GET /api/config`; logo and colors wait for feature 46 |
| Nav items | Only built pages, from a typed registry |
| Location switcher | Warehouses + showrooms + "All"; cookie; exposed via hook, filters nothing yet; disabled when empty |
| Strings | English only, every string behind a typed key (feature 5 adds Arabic and the library) |
| Locations endpoint auth | Open until feature 6 adds the session guard |

> Amended 2026-11-05: the Color, Radius, Density, and Fonts rows describe the original direction (option A, Quiet Ledger) and change with the direction the owner picks. The Branding row is false for the portal: the portal frame carries a per brand logo and accent from settings (AC-19), while the back office still shows only the client name. The Top bar row is unchanged; the shell stays.

> Amended 2026-11-06 (Daftar built): the rows above now hold the built values: Color is warm paper neutrals with a deep indigo primary (not monochrome), Radius is 0.5rem (8px), Density is table rows 40px, header 44px, controls 40px (48, 52, and 48px in the `floor` scope on coarse pointers, AC-22), and Fonts are Inter, Noto Sans Arabic, and JetBrains Mono (not IBM Plex).

### Decisions made in this spec (with the runner up)

- **Package layout**: `packages/ui/src/components/ui/*` (shadcn components), `packages/ui/src/lib/utils.ts` (`cn`), `packages/ui/src/hooks/*`, `packages/ui/src/styles/globals.css` (tokens and base layer), its own `components.json`; `apps/web` keeps a `components.json` pointing its `ui` alias at `@ssdashboard/ui`, so `shadcn add` run in either place lands in `packages/ui`. This is the shadcn monorepo layout. Runner up: tokens in `packages/config` (spec 0001 named it for "Tailwind config"), rejected because in Tailwind v4 the config is CSS that belongs beside the components it themes. `apps/web/src/app/globals.css` becomes `@import "@ssdashboard/ui/globals.css";` plus `@source "../../../../packages/ui/src";` (Tailwind v4 does not scan linked workspace packages on its own). Every CSS dependency the stock shadcn CSS imports (`tw-animate-css` and similar) is imported only inside `packages/ui/src/styles/globals.css` and listed in `packages/ui` dependencies; if the Turbopack Tailwind loader cannot resolve them from there under pnpm's strict layout, also list them in `apps/web`. Milestone 1 proves this resolves in `next dev`, `next build`, and the Docker build.
- **Exports**: `packages/ui` is consumed as TypeScript source (no build step), with `exports` entries per path (`"./components/*": "./src/components/ui/*.tsx"`, `"./lib/*": "./src/lib/*.ts"`, `"./hooks/*": "./src/hooks/*.ts"`, `"./globals.css": "./src/styles/globals.css"`), added to `apps/web` as `"@ssdashboard/ui": "workspace:*"`, and `transpilePackages: ['@ssdashboard/ui']` in `next.config.ts`. `components.json` in both packages sets `iconLibrary: "lucide"`, `rsc: true`, and the `ui`, `utils`, `hooks` aliases to `@ssdashboard/ui/...`. If the shadcn CLI misbehaves in this monorepo, timebox it and copy the generated components by hand (the CLI only generates source). Runner up: a compiled package, rejected as a needless build step for a private monorepo package. Named exports only, as everywhere.
- **`DESIGN.md` home**: `packages/ui/DESIGN.md`, next to the tokens it describes, with a pointer line in root and `packages/ui/AGENTS.md`. Runner up: repo root `DESIGN.md`.
- **Fonts**: loaded in `apps/web/src/shell/root-fonts.ts` (used by every root layout; spec 0004 removed `app/layout.tsx`) with `next/font/google` (`IBM_Plex_Sans` with `subsets: ['latin']`; `IBM_Plex_Sans_Arabic` with `subsets: ['arabic', 'latin']` and `preload: false`, so English pages don't download it; weights 400, 500, 600, `display: 'swap'`), which downloads the files at build time and serves them from the app, so nothing is fetched from Google at runtime. They're exposed as `--font-sans` and `--font-arabic`; tokens map `font-sans` to Plex Sans, and `:lang(ar)` switches to Plex Sans Arabic with line height raised one step. Runner up: `next/font/local` with vendored files, the fallback if Docker builds ever run without network.

> Amended 2026-11-06 (Daftar built): fonts are now `Inter` (latin), `Noto_Sans_Arabic` (arabic, `preload: false`), and `JetBrains_Mono` (latin, `preload: false`), each a variable file with `display: swap`, exposed as `--font-inter`, `--font-noto-arabic`, and `--font-jetbrains-mono`; tokens map `font-sans` to Inter, `font-arabic` to Noto Sans Arabic, and `font-mono` to JetBrains Mono. IBM Plex is no longer loaded. The file location, `next/font/google`, and the rule that nothing is fetched at runtime are unchanged.

> Amended 2026-11-06: fonts are self hosted from committed files with `next/font/local` (`apps/web/src/shell/fonts/`), so building an image needs no request to Google.
- **Tokens** (all oklch CSS variables, light in `:root`, dark in `.dark`, Tailwind v4 `@theme inline` mapping, the shadcn convention): the shadcn zinc set for `background`, `foreground`, `card`, `popover`, `primary` (zinc 900 light, zinc 50 dark), `secondary`, `muted`, `accent`, `border`, `input`, `ring`, and `sidebar-*`; plus status pairs the stock set lacks: `success`, `warning`, `info` alongside `destructive`, each with a `-foreground`, each tuned until it passes AC-2. Start from the stock shadcn zinc oklch values, then make these deliberate changes: darken `input` (the border of fields, outline buttons, checkboxes) until it reaches 3:1 against `background` and `card` in both modes, since the stock zinc border fails that; `border` stays light and is used only for decorative separators and card edges, which are exempt from 3:1; `muted-foreground` (also used for placeholder text) must reach 4.5:1 on `background`, `card`, and `muted`; `destructive` must reach 4.5:1 as text on `background` and its `-foreground` 4.5:1 on it as a fill; every `sidebar-*` text pair meets 4.5:1. Disabled controls are exempt from contrast, but are still styled at 3:1 or more so "No locations yet" stays readable. Status hues exist only for meaning (in stock, low, error, info), never for decoration. Runner up: brand hue tokens, out of scope (feature 46).

> Amended 2026-11-06 (Daftar built): the zinc set and the "zinc 900 light, zinc 50 dark" primary in this paragraph are replaced by the Daftar set in `globals.css`: `background` `oklch(0.985 0.006 85)`, `foreground` `oklch(0.22 0.02 70)`, `primary` `oklch(0.38 0.12 275)` (dark `oklch(0.78 0.12 280)`), plus the meaning roles `confirmed`, `failed`, `owed`, `provisional` (each with a `-surface`), `info-surface`, and `brand`. The rules (contrast minimums for `input`, `muted-foreground`, `destructive`, `sidebar-*`, and status pairs) are unchanged; the measured pairs are in `DESIGN.md` and recomputed live on `/design`.

> Amended 2026-11-05: status hues now also carry order meaning (confirmed, failed delivery, cash owed, provisional, AC-16), and the runner up "brand hue tokens" is now in scope for the portal only (`brand` and `brand-foreground`, AC-19). The colors, contrast numbers, and "monochrome primary" in this paragraph are option A; the other options change them.
- **Type scale**: base UI text 14px (`text-sm`) with 20px line height; secondary 12px (`text-xs`); page title 20px semibold; section title 16px semibold. Weights 400, 500, 600 only.

> Amended 2026-11-06 (Daftar built): body text is 15px (`text-sm`, line height 1.5) and the section title 17px (`text-base`); the page title stays 20px semibold. Arabic keeps one step more line height.
- **Density**: table row 36px, table header 40px, form controls the Vega default height (36px), shell top bar 56px, sidebar item 32px on fine pointers.

> Amended 2026-11-06 (Daftar built): table row 40px, table header 44px, form controls 40px, and in the `floor` scope on coarse pointers 48px, 52px, and 48px. The shell top bar (56px) and sidebar item (32px) are unchanged.
- **Touch sizing** (AC-14): `globals.css` defines `@custom-variant coarse (@media (pointer: coarse));`. Under `coarse:`, the menu button, sidebar and icon rail items, sheet items, switcher trigger, palette button, user menu trigger and its items, and command items are at least 44px tall (icon only ones 44 by 44). Everywhere, the 24 by 24 floor also covers dialog and sheet close buttons (pad the stock close icon), tooltip triggers, and `Kbd` when it is clickable.
- **Focus**: `focus-visible` only, 2px `ring` outline with 2px offset, the same in every component; the monochrome ring is near black on light and near white on dark, which passes 3:1.

> Amended 2026-11-06 (Daftar built): the ring is now the indigo `ring` token (`oklch(0.38 0.12 275)` light, `oklch(0.78 0.12 280)` dark), not monochrome; its width is `--focus-width`, 2px, and 3px in the `floor` scope. It still passes 3:1.
- **Motion**: shadcn defaults (150 to 200ms), all disabled under `prefers-reduced-motion: reduce`.
- **Icon mirroring**: directional Lucide icons get `rtl:-scale-x-100` (Tailwind's `rtl:` variant); `DESIGN.md` lists which icons count as directional. Non directional icons (search, user, box) never mirror. Runner up: a `DirectionalIcon` wrapper, rejected as one more component to learn for a one class rule.
- **Logical CSS enforcement** (AC-5): a small Node script `packages/config/scripts/check-logical-css.mjs` (add `scripts` to `packages/config`'s `files`) that scans `.ts`, `.tsx`, and `.css` under `packages/ui/src` and `apps/web/src` (skipping `node_modules`, `.next`, and its own fixtures) for physical side utilities and properties: CSS `margin-left|right`, `padding-left|right`, `left:`, `right:`, `border-left|right`, `text-align: left|right`; Tailwind `ml-`, `mr-`, `pl-`, `pr-`, `left-`, `right-`, `text-left`, `text-right`, `border-l`, `border-r`, `rounded-l`, `rounded-r`, `rounded-tl|tr|bl|br`, `float-left|right`, `slide-in-from-left|right`, `slide-out-to-left|right`, `origin-left|right`, and `data-[side=left|right]` (with optional `-` prefix and variant prefixes). It allowlists `rtl:-scale-x-100`, `ltr:` and `rtl:` scoped overrides, and lines marked `// logical-css-ignore: <reason>`. `space-x-*` and `divide-x-*` are allowed (Tailwind v4 makes them direction aware). Each package's `lint` script becomes `eslint . && node ../../packages/config/scripts/check-logical-css.mjs <src dir>`. Expect to patch leftovers that `shadcn init --rtl` does not convert. Runner up: an ESLint plugin for Tailwind classes, rejected because Tailwind v4 support in those plugins is uneven.
- **`/design` gating and contrast**: the page calls `notFound()` when `process.env.NODE_ENV === 'production'`, and the production check asserts a real 404 status (not a 200 page). Its gallery modules load through `import()` behind the same check, so production bundles don't carry them, and it is never linked or prefetched in production (it is `devOnly` in the registry). Live contrast reads each resolved color by painting it onto a 1 by 1 canvas and reading the sRGB pixel back (this handles `oklch` values), then computes the WCAG 2 ratio. Pinned states are forced with `data-state-preview="hover|focus|active"` attributes that the component styles honour only inside the gallery wrapper.
- **Theme**: `next-themes` (0.4.6 or later, checked against React 19 and Next 16 for script warnings) `ThemeProvider`, in a client `Providers` component in `apps/web/src/app/providers.tsx` (with the `DirectionProvider` and `CurrentLocationProvider`), with `attribute="class"`, `defaultTheme="system"`, `enableSystem`, `disableTransitionOnChange`; `<html suppressHydrationWarning>`.
- **Root layout stays static.** `cacheComponents` is on in `next.config.ts`, so the root layout never calls `cookies()` or `headers()` (that would force a Suspense boundary around the whole app and cannot set `<html>` attributes). It renders `<html lang="en" dir="ltr" suppressHydrationWarning>`, and all browser state is read on the client. Read `node_modules/next/dist/docs/` first, as `apps/web/AGENTS.md` asks.
- **Direction (development only)**: stored in localStorage `ss_dir` (`ltr` or `rtl`). In development only (`process.env.NODE_ENV !== 'production'`, inlined at build), the layout renders a small inline `<script>` in `<head>` that sets `document.documentElement.dir` from `ss_dir` before first paint, and a client `DirectionBridge` passes the same value to Radix's `DirectionProvider`, which wraps the whole app (including every portal: dropdowns, popovers, tooltips, sheet). The switch writes localStorage, updates `<html dir>`, and updates the provider state, with no reload. Radix reads only the provider, never `<html dir>`, so both must change together. Production builds contain neither the script nor the switch. Feature 5 replaces this whole mechanism with the language switch.
- **Strings**: `apps/web/src/i18n/messages.en.ts` exports a nested `as const` object; `apps/web/src/i18n/t.ts` exports `t(key: MessageKey)` where `MessageKey` is the union of dotted paths, so a wrong key fails `tsc` (AC-12). `packages/ui` components hold no text of their own; labels arrive as props (including the sr only labels, such as "Toggle sidebar", passed by the shell). No interpolation or plurals yet (no shell string needs them); feature 5 adds them. Key namespaces: `shell.skipLink`, `shell.nav.groups.*`, `shell.nav.items.*`, `shell.topbar.*` (menu button, palette button), `shell.palette.*` (placeholder, no results, group headings), `shell.user.*` (menu name, placeholder name, theme, direction, sign out, sign out hint), `shell.theme.*` (light, dark, system), `shell.direction.*`, `shell.locations.*` (all, none yet, loading, error, retry, search, label), `shell.sidebar.toggle`, `home.*` (including the `ApiStatus` texts). Runner up: `next-intl`, deferred to feature 5's decision.
- **Home page**: Home keeps `ApiStatus` inside the shell with a page `<h1>` (from `t('home.title')`); its hard coded texts move to `messages.en.ts`, and the existing `page.spec.tsx`, `layout.spec.tsx`, `api-status.spec.tsx`, and `e2e/home.spec.ts` are updated to match. Every page renders exactly one `<h1>`.
- **Navigation registry**: `apps/web/src/shell/nav.ts` exports `navItems: readonly NavItem[]` with `{ id, labelKey: MessageKey, href, icon: LucideIcon, group: NavGroup, devOnly?: true }`; `NavGroup` is a union (`'general'` now; `'inventory'`, `'purchasing'` and others are added by the features that ship them). Today it holds Home (`/`) and Design (`/design`, `devOnly`), both in group `general` (heading `shell.nav.groups.general`, "General"). Sidebar and palette both read it, filtered by environment; a group with no visible items is not rendered. The active item gets `aria-current="page"`: exact match for `/`, prefix match (`pathname === href || pathname.startsWith(href + '/')`) for others. Features 13 and 46 later filter the same list by role and module toggle.
- **Sidebar state**: the shadcn `Sidebar` keeps its own cookie (`sidebar_state`, its default 7 day expiry), read on the client only (see *Root layout stays static*), so a collapsed sidebar may show expanded for one frame on reload; accepted. The mobile breakpoint is 768px. To avoid a desktop sidebar flashing on phones before `useIsMobile` settles, the desktop sidebar and the mobile menu button are shown and hidden with CSS (`md:` classes), and `useIsMobile` only decides whether the sheet is used. The sheet closes on navigation: `setOpenMobile(false)` in an effect on `usePathname()`.
- **Skip link and landmarks**: the first element in `body` is a link to `#main-content` (text `t('shell.skipLink')`), visually hidden until focused, positioned with logical utilities. `<main id="main-content" tabIndex={-1}>` holds the page. The sidebar is inside `<nav aria-label>`, the top bar is `<header>`. Tab order follows DOM order, so it mirrors automatically in right to left.
- **Command palette**: shadcn `CommandDialog` (cmdk) opened by Ctrl+K or Cmd+K on every platform (`preventDefault` so the browser's own shortcut does not fire). It also opens while focus is in a text field, and the shortcut closes it if it is already open. A visible top bar button shows the shortcut in a `Kbd`; the server renders "Ctrl K", and after mount it switches to "⌘ K" on Apple platforms, which avoids a hydration mismatch. On Esc, focus returns to the element that was focused before it opened (the button when opened by click, the previously focused element when opened by shortcut). It lists navigation entries now; later features register more groups.
- **User menu placeholder**: a trigger with accessible name `t('shell.user.menu')` ("User menu") showing an avatar with the initial "S" and the label "Staff", a Theme sub menu (Light, Dark, System), the Direction sub menu in development only, and a disabled "Sign out" item with the hint "Available after sign in". Feature 6 replaces the identity part.
- **Location switcher**: a shadcn `Popover` + `Command` combobox (searchable), state in `apps/web/src/shell/current-location-provider.tsx` (a React context provider plus `useCurrentLocation(): string | 'all'` and `setCurrentLocation()`); The context value is `{ current: string | 'all', locations, status: 'loading' | 'ready' | 'empty' | 'error', retry(), setCurrentLocation(id | 'all') }`. Cookie `ss_location`, value a location uuid or `all`, `SameSite=Lax`, `Path=/`, `Max-Age=31536000`, `Secure` when the page is served over https, not `HttpOnly`; read from `document.cookie` after mount. `current` is `'all'` until the list loads, then the stored id if it is in the list, else `'all'` (and the cookie is rewritten). The display name is `name.en` trimmed, else `name.ar` trimmed, else `code`. It follows `nextCursor` until all pages are loaded, capped at 50 pages (beyond that it keeps what it has and logs a console warning).
- **Data loading**: the client name and locations load in client components on relative `/api` paths with `fetch` plus the Zod contract's `.parse`, the same pattern as `ApiStatus` today. The OpenAPI document and generated client are not built by this feature; the first feature that needs them adds them and migrates these two calls. `/api/config` is fetched once per browser session (a module level cached promise, `cache: 'no-store'` on the request), so remounting providers never refetches.
- **API wiring**: `apps/api/src/platform/config.controller.ts` (`GET /api/config`, injects the validated env) registered in `PlatformModule`; `apps/api/src/inventory/locations/locations.controller.ts` and `locations.service.ts` registered in `InventoryModule` (the module that owns `locations`), with `module-boundary.spec.ts` updated if it lists allowed files. Queries are validated by a small `ZodQueryPipe` in `apps/api/src/platform/` that throws `BadRequestException({ code: 'INVALID_QUERY', issues })`. `limit` is `z.coerce.number().int().min(1).max(200).default(200)`; the cursor is the last row's `code`, base64url encoded, and a cursor that does not decode is 400. Ordering and the keyset comparison both use `code COLLATE "C"`, so pages never skip or repeat rows. The `name` contract reuses the shared localized text Zod schema if `packages/contracts` has one (else adds `LocalizedText` there), matching spec 0002's `{ en, ar }` shape.
- **Accessibility test tooling**: `axe-core` run in Vitest through a small helper `expectNoAxeViolations(container)` in `packages/ui/src/test/axe.ts`. jsdom has no layout or color, so this layer checks roles, names, and structure only; contrast (AC-2) and target size (AC-14) are checked only in Playwright. Overlays are checked on `document.body`, since Radix portals render outside the container. `packages/ui` gets its own `vitest.config.ts` (jsdom, `@testing-library/jest-dom`, polyfills for `ResizeObserver`, `matchMedia`, `scrollIntoView`, and pointer capture, which Radix and cmdk need), and `turbo.json` gains a `test` task. `@axe-core/playwright` in `apps/web/e2e` runs with tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`, on the desktop project only, over the shell and `/design` in the four theme × direction combinations (theme and `ss_dir` set through `addInitScript` writing localStorage before load). Keyboard flows (AC-4) are Playwright tests on desktop; sheet and touch tests use the mobile project with `hasTouch: true` and `isMobile: true`; sidebar collapse tests run on desktop only. The happy path uses database seeded locations; the failure cases stub the api with `page.route`. Production checks (AC-11, AC-13) run in a separate Playwright project whose web server runs `next build && next start` on another port. Runner up: `vitest-axe`, rejected to avoid a thin wrapper dependency with uncertain upkeep.

### Data model sketch

No new tables, columns, or migrations. This feature reads `locations` as defined in spec 0002 (`id`, `code`, `name jsonb {en, ar}`, `type`, `archived_at`). Browser state only:

| Store | Key | Value | Owner |
|---|---|---|---|
| Cookie (read on the client) | `sidebar_state` | `true` or `false` | shadcn Sidebar |
| Cookie (read on the client) | `ss_location` | location uuid or `all` | location switcher |
| localStorage (development only) | `ss_dir` | `ltr` or `rtl` | direction switch, removed by feature 5 |
| localStorage | `theme` | `light`, `dark`, or `system` | next-themes |

**State transitions**: none.

### API surface

| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/config` (platform module) | GET | none | `clientName: string`, `version: string` | public (needed before sign in) | none expected; a 5xx makes the web use its fallback |
| `/api/locations` (inventory module) | GET | `cursor?: string`, `limit?: int` (1 to 200, default 200) | `items: { id: uuid, code: string, name: { en?: string, ar?: string }, type: 'warehouse' \| 'showroom' }[]`, `nextCursor: string \| null` | open until feature 6 (see Security model) | 400 invalid cursor or limit (stable code `INVALID_QUERY`) |

Both shapes are Zod schemas in `packages/contracts` (`ConfigResponse`, `LocationListQuery`, `LocationListResponse`), used by the api for validation and by the web to parse responses (no OpenAPI or generated client yet, see *Data loading*). `GET /api/locations` filters `type IN ('warehouse','showroom') AND archived_at IS NULL`, orders by `code`, and uses a keyset cursor on `code` (unique). Feature 10 extends this module with location management; this endpoint stays a read.

### Value sourcing

| Action | Value produced / displayed | Source |
|---|---|---|
| Top bar | client name | `GET /api/config` `clientName` ← env `CLIENT_DISPLAY_NAME` (default `SSDashboard`); fallback literal "SSDashboard" in the web when the call fails |
| `GET /api/config` | `version` | existing env `APP_VERSION` |
| Location switcher | list of locations | `GET /api/locations` ← `locations` table (spec 0002), filtered by `type` and `archived_at` |
| Location switcher | each location's label | `name.en` trimmed → `name.ar` trimmed → `code` (English UI until feature 5 picks by locale) |
| Location switcher | selected location | cookie `ss_location`, checked against the loaded list; while loading, on error, missing, or unknown → `'all'` |
| Location switcher | status (loading, ready, empty, error) | the fetch state in `CurrentLocationProvider`; empty = zero items after all pages load |
| `useCurrentLocation()` | current value | the context state above |
| Sidebar, command palette | entries, labels, icons, links | `navItems` registry; labels through `t(labelKey)`; filtered by `devOnly` against `NODE_ENV` |
| Sidebar | expanded or collapsed | cookie `sidebar_state` read on the client; default expanded |
| Sidebar, palette | active item | `usePathname()` with the match rule in *Navigation registry* |
| Palette button | shortcut label | "Ctrl K" on the server; "⌘ K" after mount on Apple platforms (`navigator.userAgent`) |
| `<html>` | `class` (theme) | next-themes from localStorage `theme`; default from `prefers-color-scheme` |
| `<html>` | `dir` | `ltr` in the markup; development only: the inline head script sets it from localStorage `ss_dir` (default `ltr`); production: always `ltr` (until feature 5) |
| `<html>` | `lang` | `en` (until feature 5) |
| All shell text | strings | `messages.en.ts` via `t()` |
| `/design` | contrast ratio per color pair | computed live in the browser from the resolved CSS variables |
| User menu | name and initial | fixed message keys `shell.user.placeholderName` ("Staff") until feature 6 |

### Key invariants

- `packages/ui` never imports from `apps/*`, `@ssdashboard/contracts`, or Next.js (`next/*`); it is plain React plus Radix, Tailwind, Lucide, cmdk, and `next-themes`, so a future storefront or POS app can use it.
- Tokens are the only source of color, radius, and font: no raw hex, rgb, or Tailwind palette classes (`bg-zinc-200`) in components or pages; use the role tokens (`bg-muted`, `text-foreground`).
- No physical left or right styling anywhere in web or ui source (enforced by the check script).
- No hard coded UI text in `apps/web` (through `t()`) or in `packages/ui` (through props).
- Shell server code reads no cookies, headers, or business data (the root layout stays static under `cacheComponents`); browser state is read on the client.
- The direction switch and `/design` never exist in a production build.

### Security model

- `GET /api/config` is public by design (the shell and the future sign in page need it) and returns only the display name and version, nothing secret.
- `GET /api/locations` returns only `id`, `code`, `name`, and `type` (no stock, cost, or settings). It is reachable without sign in until feature 6, which adds the session guard to every `/api` route except `/api/config`, `/api/health`, and `/api/auth/*`. This endpoint is listed in Follow-up so feature 6 covers it. Roles (feature 13) may later restrict which locations a user sees; the switcher then shows only what the endpoint returns.
- Both are cheap indexed reads. Rate limiting for public endpoints is owed to feature 6 (with the auth routes) or feature 16 (Caddy); until then exposure is limited to each client's own install.
- Cookies hold no secrets; `ss_location` is a preference, and the api never trusts it (it is not sent to the api in this feature).
- No personal data, payments, or regulated data in scope.

### Configuration required

- `CLIENT_DISPLAY_NAME`: optional, the install's name shown in the shell. In `apps/api/src/config/env.ts`: trimmed, an empty value treated as unset, default `SSDashboard`, at most 80 characters. Also add it to `.env.example` (commented, with the default), to `turbo.json` `dev.passThroughEnv`, and only to the `api` service's `environment` in `deploy/compose.yaml` (next to `PUBLIC_URL`), not to the shared `x-app-env` block, so `migrate` and `worker` never receive it.

### Critical test scenarios

- Happy path: open `/` in light, left to right; the shell shows the client name from config, the sidebar with Home, the switcher listing seeded warehouses and showrooms; choose one, reload, and it is still selected. Verifies **AC-3**, **AC-9**, **AC-10**.
- Accessibility matrix: Playwright axe on `/` and `/design` in light and dark × left to right and right to left, zero violations. Verifies **AC-2**, **AC-5**, **AC-11**.
- Keyboard: Tab from page load hits the skip link first, then every shell control in order; Ctrl+K opens the palette, typing "des" plus Enter goes to `/design`; Esc closes it and focus returns to the palette button; Ctrl+B collapses the sidebar. Verifies **AC-4**, **AC-8**, **AC-7**.
- Right to left: with localStorage `ss_dir` set to `rtl`, the sidebar's bounding box is at the right edge, a chevron icon's computed transform is mirrored, and at 375px wide the sheet enters from the right. Verifies **AC-5**, **AC-7**.
- Failure case: the config endpoint returns 500, so the shell shows "SSDashboard"; the locations endpoint returns 500, so the switcher shows the error and retry, and `useCurrentLocation()` returns `'all'`; the cookie holds an archived location's id, so the switcher falls back to All and rewrites the cookie. Verifies **AC-9**, **AC-10**.
- Empty install: no warehouse or showroom rows, so the switcher is disabled and reads "No locations yet". Verifies **AC-10**.
- Theme: set Dark, reload, no light flash (screenshot at first paint) and `html.dark` present. Verifies **AC-6**.
- Production build: `/design` returns 404, the user menu has no Direction item, `<html dir="ltr">`; the network log shows no request to a font host. Verifies **AC-11**, **AC-13**.
- Guardrails: the logical CSS check fails on a planted `ml-2`; `tsc` fails on `t('shell.nope')`. Verifies **AC-5**, **AC-12**.
- Touch: at a coarse pointer emulation, shell controls measure at least 44 by 44. Verifies **AC-14**.
- Auth/permission: none yet (no accounts exist); feature 6's tests assert `/api/locations` returns 401 without a session.

## Build plan (original, built)

Tracer Bullet: the first milestone pushes one thin thread through every layer (env → api → Zod contract → web fetch and parse → shared ui package → web shell). Each later milestone thickens one segment and stays shippable.

1. **Thin thread through every layer**
   1. Create `packages/ui` with `shadcn init` (Radix base, Vega style, zinc, `--rtl`) in the monorepo layout; add `exports`, the `workspace:*` dependency, `transpilePackages`, the `@source` scan, its Vitest config, a `test` task in `turbo.json`, and a nested `packages/ui/AGENTS.md`; prove CSS imports resolve in `next dev`, `next build`, and the Docker web build. Satisfies **AC-5**, **AC-12**.
   2. Add `CLIENT_DISPLAY_NAME` to `env.ts`, `.env.example`, `turbo.json`, and the `api` service in Compose; add `ConfigResponse`, `config.controller.ts`, and `GET /api/config` in the platform module. Satisfies **AC-9**.
   3. Keep the root layout static; add a minimal shell header to Home that shows `clientName` (fetched and parsed, with fallback) and one `Button` from `@ssdashboard/ui`, keeping `ApiStatus`; update the existing web tests; one Vitest axe test and one Playwright test pass in CI. Satisfies **AC-9**, **AC-2**.
2. **Foundations**
   1. Final light and dark tokens including the `success`, `warning`, and `info` pairs, radius, density, focus, motion; fonts through `next/font` with the `:lang(ar)` switch; `tabular-nums`. Satisfies **AC-2**, **AC-13**.
   2. `Providers` with `next-themes`; the development only `ss_dir` head script, `DirectionBridge`, and `DirectionProvider`; `messages.en.ts` and typed `t()`, with the `ApiStatus` strings moved in. Satisfies **AC-6**, **AC-5**, **AC-11**, **AC-12**.
   3. `check-logical-css.mjs` wired into `lint` for `packages/ui` and `apps/web`. Satisfies **AC-5**.
3. **App shell**
   1. Add the shadcn components the shell needs to `packages/ui` (sidebar, sheet, button, dropdown menu, command, dialog, popover, tooltip, avatar, separator, skeleton, kbd), each with a Vitest axe test. Satisfies **AC-2**, **AC-14**.
   2. Shell layout in `apps/web/src/shell/`: nav registry, sidebar with icon collapse and cookie, mobile sheet, top bar, skip link, landmarks, user menu with Theme (and Direction in development), command palette with Ctrl/Cmd+K, coarse pointer sizing, directional icon mirroring. Satisfies **AC-3**, **AC-4**, **AC-5**, **AC-6**, **AC-7**, **AC-8**, **AC-14**.
4. **Location switcher** (independent of milestones 3 and 5; it never blocks them)
   1. `LocationListQuery` and `LocationListResponse` contracts, `ZodQueryPipe`, and `GET /api/locations` in `inventory/locations/` (keyset pagination on `code COLLATE "C"`, filtered by type and `archived_at`), with an e2e test on seeded rows including a `limit=1` pagination walk and a bad cursor 400. Satisfies **AC-10**.
   2. `CurrentLocationProvider`, `useCurrentLocation()`, the `ss_location` cookie, and the switcher combobox with loading, empty, error and retry, and stale id fallback states. Satisfies **AC-10**.
5. **Gallery, standard, and checks**
   1. Development only `/design` page following the shadcn design system page outline, limited to the foundations and the components in `packages/ui`, with live contrast pairs, pinned states, a right to left row, and an Arabic type specimen under `lang="ar"`; 404 in production. Satisfies **AC-11**, **AC-2**, **AC-13**.
   2. Write `packages/ui/DESIGN.md` from the final tokens (with measured contrast), including the table, form, and feedback rules features 7 and 8 will build to. Satisfies **AC-1**.
   3. Playwright suite: axe matrix (four combinations × two pages), keyboard flows, right to left geometry, theme no flash, production build checks, touch sizes. Satisfies **AC-2**, **AC-4**, **AC-5**, **AC-6**, **AC-7**, **AC-8**, **AC-11**, **AC-13**, **AC-14**.

## Build plan

Amendment work only. The shell, `packages/ui`, `/design`, and the axe matrix stay as built. The owner chose option B, Daftar, with the `floor` density scope from option C on the queue and scan screens for coarse pointers (2026-11-05, see Questions for the owner). "The chosen direction" in the milestones below means option B's values in *Direction options*. Milestone 1 is the thin thread: it changes the real tokens and fonts and proves every existing check still passes with the new look, before any new component. Our own components go outside `packages/ui/src/components/` (the shadcn folder), one per file, named after the file.

1. **The chosen direction (B, Daftar) in tokens, fonts, and `DESIGN.md`** (the thin thread)
   1. [x] Load the chosen direction's fonts with `next/font` in `apps/web/src/shell/root-fonts.ts`, keep the `:lang(ar)` switch and the Arabic line height, tune the Arabic size against the Latin face, confirm tabular figures work (fall back to the mono face for numeric columns if not), confirm each font name exists in `next/font/google`, and ship each font's OFL text. Satisfies **AC-23**.
   2. [x] Retune `packages/ui/src/styles/globals.css` to the chosen direction: light and dark values, radius, the density tokens (`--spacing-row`, `--spacing-row-header`, `--spacing-control`), the focus ring width, the four meaning aliases (`confirmed`, `failed`, `owed`, `provisional`) with their chip surfaces, `brand` and `brand-foreground`, and the `floor` density scope (a `data-density="floor"` attribute and the `coarse:` rules). Satisfies **AC-15**, **AC-16**, **AC-19**, **AC-22**.
   3. [x] Extend the `/design` contrast list with the new pairs (meaning colors on the page, on the card, and on their chip surface, `brand-foreground` on `brand`, the dashed provisional border on its surface) so each is measured live. Satisfies **AC-15**.
   4. [x] Rewrite `packages/ui/DESIGN.md` for option B, Daftar, with the `floor` scope on the queue and scan screens: the color table with measured contrast, the type table and the Arabic size rule, density and focus values, the new status and provisional rules, the `floor` scope, and the line "Zinc grays, a black and white primary" where it is no longer true. Also update `packages/ui/AGENTS.md` if the stack line changes. Satisfies **AC-15**, **AC-23**.
   - **Done when**: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm --filter @ssdashboard/ui test`, and `pnpm test:e2e` all pass, where `shell.spec.ts` runs axe with zero violations on `/` and `/design` in light and dark, left to right and right to left, and every contrast pair on `/design` shows its minimum met.
2. **Status and provisional display, and the floor scope**
   1. [x] `StatusChip` (icon plus word, the four roles, one chip surface per direction), `ProvisionalValue` (`≈` inside `bdi`, dashed boundary, hidden "provisional" text), `FreshnessStrip`, and a row start stripe helper, each with a spec that includes `expectNoAxeViolations` in light, dark, and `dir="rtl"`. Satisfies **AC-16**, **AC-17**.
   2. [x] A chip count rule ("+2") and the row column order in the `DESIGN.md` table section, and a sample order row table and a confirmation queue card on `/design` built from the base `Table`, `Button`, and `Field` parts, with the `floor` scope on the card. Satisfies **AC-16**, **AC-22**.
   3. [x] A test that no chip renders without an icon and a word, and a Playwright check that on a coarse pointer the queue card's outcome buttons measure at least 48 by 48. Satisfies **AC-16**, **AC-22**.
   - **Done when**: `pnpm --filter @ssdashboard/ui test` and `pnpm test:e2e` pass, the latter including axe on `/design` in the four combinations with the new rows visible.
3. **Three frames and per brand theming**
   1. [x] `PortalFrame` and `PartnerFrame` in `packages/ui` (text through props, one `h1` and one `main`, logical sides only, no `next/*` imports), and `AppShell` unchanged. Satisfies **AC-18**.
   2. [x] `deriveBrandTokens(accent)`: converts an accent to a fill and foreground, accepts at least 4.5:1, returns the rejection and the nearest accepted suggestion otherwise; unit tests for `#0A7C39` (accepted, white), `#F2C230` (accepted, dark foreground), and a pale yellow that fails both. Satisfies **AC-19**.
      > Amended 2026-11-06 (milestone 3 built): "a pale yellow that fails both" cannot exist, because a pale yellow passes with the near black `#211910` (see the amendment in Design delta). A colour fails with both white and `#211910` only near mid luminance, so the tests use `#A9780B` (3.90:1 with white, 4.44:1 with `#211910`, suggestion `#AB7A0B` at 4.56:1) and `#808080` (3.95:1 and 4.39:1, suggestion `#828282` at 4.51:1).
   3. [x] `/design` section "Frames" showing the three frames, the portal with a sample brand accent and logo, in left to right and right to left, and a Playwright check at 360 by 800 with touch that the portal and partner samples have no horizontal overflow and no violations in axe. Satisfies **AC-18**, **AC-19**, **AC-20**.
   - **Done when**: `pnpm --filter @ssdashboard/ui test`, `pnpm test:e2e`, and `pnpm lint` (the logical CSS check) pass.
4. **Phone dashboard and in screen help patterns**
   1. [x] `MetricCard`, `BottomTabs` (at most four tabs, 56px), the row to card collapse below 640px, and the "Needs you" list in `packages/ui`, with a sample phone dashboard on `/design` in the order the daily report uses. Satisfies **AC-20**.
   2. [x] `HelpHint`, `HelpPanel` (sheet, `?` key outside text fields, Esc closes, focus returns), and `FirstRunChecklist`, with the `help.*` key convention documented and a test that fails when an Arabic help key is missing. Satisfies **AC-21**.
   3. [x] Playwright at 360 by 800 with touch, in both languages: no horizontal scroll from 320 to 430, tap targets at least 44 by 44, keyboard open and close of the help panel with focus return, axe clean. Satisfies **AC-20**, **AC-21**.
   4. [x] Add the phone first dashboard and in screen help sections to `packages/ui/DESIGN.md`, and tick the follow up lines this amendment closes. Satisfies **AC-20**, **AC-21**.
   - **Done when**: `pnpm --filter @ssdashboard/ui test`, `pnpm test:e2e`, `pnpm lint`, `pnpm typecheck`, and `pnpm format:check` all pass, and `node packages/config/scripts/check-doc-links.mjs` passes.

## Consequences

**Positive**:
- Every later screen starts inside a finished, accessible, mirrored frame, and builds to one written standard instead of guessing.
- A shared `packages/ui` is ready for a storefront or POS app without moving files later.
- Logical CSS and typed string keys are enforced by tooling from the first commit, so right to left and translation debt can't build up quietly.
- The location context exists before any stock screen, so features 7 to 12 filter by it without redesigning the shell.

**Negative / tradeoffs**:
- A shared package before a second consumer exists: extra `exports`, `@source`, and `transpilePackages` wiring, and `shadcn add` must be run from the right `components.json`.
- A monochrome primary makes primary actions stand out less than a colored accent would; the hierarchy has to come from weight, fill versus outline, and placement. Status colors carry all hue. (Amended 2026-11-05: true of option A only; options B and C give the primary a hue, and the amendment makes this the main reason to pick one.)
- English only text means right to left testing here sees English words in a mirrored layout; Arabic length and line height issues surface only in feature 5 (the `/design` Arabic specimen catches font issues, not layout overflow).
- `GET /api/locations` and `GET /api/config` ship unauthenticated and without rate limiting until feature 6 or 16.
- With the root layout static, browser state is read after mount: a collapsed sidebar can show expanded for one frame on reload, and the location switcher shows "All" briefly while loading.
- Two calls use `fetch` plus `.parse` instead of a generated client; the feature that adds OpenAPI must migrate them.
- Fonts are self hosted from committed files with `next/font/local` (`apps/web/src/shell/fonts/`), so an offline image build works; the Noto Sans Arabic file keeps only the arabic subset, so Western digits and Latin letters inside an Arabic page render in Inter.
- The development direction switch is throwaway code that feature 5 must remove.

**Neutral**:
- `apps/web/src/app/globals.css` shrinks to an import of the package's tokens.
- Spec 0001's line that `packages/config` holds the Tailwind config is superseded in practice: tokens live in `packages/ui`; `packages/config` keeps TypeScript, ESLint, and now the logical CSS check script.
- New dependencies: `next-themes`, `lucide-react`, `cmdk` and the Radix packages (through shadcn), `axe-core`, `@axe-core/playwright`.

## Follow-up

- [ ] Feature 6: put `GET /api/locations` behind the session guard (all `/api` routes except `/api/config`, `/api/health`, `/api/auth/*`), add rate limiting for the public routes, and replace the user menu placeholder with the signed in staff member.
- [ ] Feature 5: replace the development `ss_dir` cookie and `DirectionProvider` wiring with the language switch, move `messages.en.ts` keys into the chosen library, add Arabic messages, pick location names by locale, and check Arabic text length and line height across the shell. (Checked 2026-11-06, still open: the `ss_dir` cookie is gone from `apps/web/src` and the Arabic catalog and a language setting exist, and location names are picked by language (`locations.name` is `{ en, ar }`, read through `localizedText()` in `current-location-provider.tsx`); what remains is a recorded Arabic text length and line height read across the shell, which joins feature 6's open Arabic speaker read.)
- [ ] Features 7 and 8: build the data table, form fields, and feedback components to the rules in `packages/ui/DESIGN.md` and add them to `/design`. (Checked 2026-11-06, still open: the amendment added `CollapsingTable`, `MetricCard`, and the status components, but no data table with TanStack Table, form field set, or feedback components beyond `packages/ui/src/components/field.tsx`, `alert.tsx`, and `sonner.tsx` are built to the DESIGN.md rules.)
- [ ] Feature 10: location management extends the inventory module's locations surface; keep `GET /api/locations` filtering compatible with the switcher.
- [ ] Feature 13 and 46: filter `navItems` by role and module toggle; feature 46 adds per client logo and accent overrides on top of these tokens. (Amended 2026-11-05: the portal's per brand logo and accent come from this amendment's `deriveBrandTokens` and settings; feature 46 keeps only any back office branding beyond the client name.) (Checked 2026-11-06, still open: `visibleNavItems` in `apps/web/src/shell/nav.ts` filters only by `adminOnly`, with no role hats or module toggle.)
- [ ] Amendment 2026-11-05: the portal spec names the brand accent and logo settings, serves them on a public read (the portal cannot read the staff config), and stores the logo; this spec only consumes `accent` and `logoUrl` as props. (Noted 2026-11-06, still open: no settings endpoint exists yet; the frames already consume `brand.tokens` and `logoUrl` props and fall back to the neutral primary.)
- [ ] Amendment 2026-11-05: spec 0004 (localization) owns the Arabic message catalog; the `help.*` keys, the status labels, and the frame strings join it, and its Arabic key test covers them. (Noted 2026-11-06, partly done: the `help.*` keys and the frame strings are in the English and Arabic catalogs, and `packages/i18n/src/help-catalog.spec.ts` fails when an Arabic help key is missing. Still open: the status labels, because the chips take labels as props and no screen uses them yet; they join the catalog with the first screen that does.)
- [ ] Amendment 2026-11-05: the pushed daily report (positioning 7.6) and the phone dashboard share one metric dictionary and one order of numbers; the reporting spec owns the metrics, this spec owns how they are shown. (Noted 2026-11-06, partly done: the display order is documented in `packages/ui/DESIGN.md` and shown in the `/design/phone-dashboard` sample. Still open: the metric dictionary itself, which the reporting spec writes.)
- [ ] 2026-11-06: the back office shell needs a phone layout for the real manager dashboard. `AppShell`'s `main` has `p-6`, which leaves 272px of content at 320px, and the `BottomTabs` bar must sit under the sticky top bar. Owned by the feature that builds the manager dashboard.
- [ ] 2026-11-06: an Arabic speaker reviews the Arabic `help.*` text, together with feature 6's open Arabic read.
- [ ] `/sync`: add `packages/ui/AGENTS.md` and `DESIGN.md` pointers to root `AGENTS.md` `## Context files`, note that tokens moved from `packages/config` to `packages/ui`, and add the shadcn and Tailwind 4 conventions (Radix `asChild`, role tokens only, logical utilities) to root `## Rules`.

## Questions for the owner

Answered by the owner on 2026-11-05, after viewing the three previews. Questions 4, 6, and 7 keep the designer's default.

1. **Which direction?** **Answered: B, Daftar**, with the `floor` density scope from option C on the confirmation queue and the scan screens for coarse pointers.
2. **What are the four numbers on the owner's first phone screen?** **Answered:** cash owed to you (split by Bosta and partners), confirmed orders yesterday, failed delivery rate, and today so far (provisional). The same four lead the pushed daily report.
3. **What do the scanning and calling devices look like?** **Answered:** a laptop or desktop with the phone beside it for the queue; staff phones and Android handhelds for scanning. So the `floor` scope applies only on the scan and queue screens on touch devices.
4. **Light and dark, or light only?** Default kept: both (already built and tested).
5. **Does the back office show the brand's accent at all?** **Answered: no.** Only the portal and the partner frame carry the brand accent; the back office keeps the system colors and shows the client name.
6. **Which brand accent and logo do we design the portal against first?** Default kept: the first brand's real accent and logo when sent; until then the sample (green `#0A7C39`, 5.31:1 with white).
7. **Who records the training clips, in which language first?** Default kept: the help panel ships text first (Arabic first, then English); the clip slot stays empty until a brand records its own, captioned in both languages.
