# 0003. Design system & UI foundation: rationale

Back to the build spec: [index.md](index.md).

## Context

The back office (`apps/web`, Next.js 16) has no visual language and no components yet: one page and `@import 'tailwindcss'`. Spec 0001 chose shadcn/ui on Tailwind v4 and TanStack Table, and left design tokens and grid patterns to this feature. Every screen in the next 40+ features, from stock tables to scanning screens, depends on what is fixed here, so drift now multiplies.

Forces:
- **Dense, data heavy work.** 100,000+ SKUs, long tables, many forms; staff need many rows on screen and fast keyboard navigation.
- **English and Arabic from day one** (AGENTS.md): every layout must mirror right to left, and both scripts need fonts that sit well together. The translation library is still undecided (feature 5).
- **WCAG 2.2 AA** with keyboard and focus support is a hard rule.
- **Phones and handhelds** use the same app for scanning (spec 0001), so the frame must work on small touch screens.
- **Per client installs, possibly offline from the internet**, with nothing per client baked into the image (AGENTS.md config rule); branding has to come from configuration.
- **A team of 1 to 3**, so tooling must catch mistakes (physical CSS, hard coded strings) that reviewers would miss.
- **Tracer Bullet** delivery: prove a thin real thread before thickening.

Without a decision, each feature invents its own spacing, colors, and right to left fixes, and accessibility gets retrofitted screen by screen.

## Options considered

### Option 1: shadcn/ui inside `apps/web`, tokens only, no shell yet

Run `shadcn init` in the web app, define tokens and `DESIGN.md`, and let feature 7 build the first real screen and the shell.

**Pros**:
- Least wiring; the plain shadcn single app setup.
- Fastest to finish.

**Cons**:
- Nothing proves the tokens in a real screen, which goes against Tracer Bullet; feature 7 would carry shell design work on top of stock logic.
- Moving components to a package later touches every import.

### Option 2: shadcn/ui in a shared `packages/ui`, app shell as the tracer bullet (chosen)

A workspace UI package from shadcn's monorepo layout, tokens in its CSS, and the real shell built on it in `apps/web`, plus the config and locations endpoints it needs.

**Pros**:
- Ready for a second consumer (storefront, POS) without a later move.
- The shell exercises tokens, right to left, keyboard, theme, and the api thread end to end now.

**Cons**:
- Extra monorepo wiring before a second app exists.
- More scope in this feature (two small endpoints, a location context).

### Option 3: React Aria Components with a custom styled kit

Adobe's accessible primitives with built in RTL and locale handling, styled by hand with Tailwind.

**Pros**:
- The strongest accessibility and internationalisation behaviour out of the box.

**Cons**:
- Leaves the shadcn ecosystem chosen in spec 0001 (its registry, blocks, CLI, and the installed skill); every component is styled by hand, a heavy cost for a small team.

### Option 4: A full component framework (for example Mantine or Ant Design)

A ready made library with tables, forms, date pickers, and RTL support.

**Pros**:
- Many complex components for free, including data heavy ones.

**Cons**:
- You don't own the code, theming fights the library, it overlaps with TanStack Table, and it reverses spec 0001.

## Rationale

Option 2 fits Tracer Bullet: the shell is the thinnest real screen that touches every layer (env, api, contract, shared ui, web), so the tokens, right to left handling, and accessibility checks are proven on something real before feature 7 adds stock logic. You chose `packages/ui` now over the simpler in app layout. That costs some wiring today but removes a cross repo import rewrite when the storefront or POS arrives, and it keeps `packages/ui` free of Next.js and business code by construction.

Radix, Vega, and zinc are the most travelled shadcn path (most docs and blocks assume them), which matters for a small team. Vega's standard control heights match "normal forms", while table density comes from our own tokens. The monochrome primary keeps hue free for status meaning (in stock, low, error), which matters more in an inventory tool than a branded accent; the cost (less prominent primary buttons) is called out in Consequences. IBM Plex Sans and IBM Plex Sans Arabic were designed as one family, so mixed English and Arabic text (SKU codes inside Arabic names) aligns without manual tuning. `next/font` self hosts them, which keeps on premises installs independent of Google at runtime.

Keeping the strings and the direction mechanism deliberately thin (an English dictionary with typed keys, and a development only direction cookie) respects feature 5's open decision while still meeting the AGENTS.md rules today. Typed keys and the logical CSS check turn two rules that are easy to forget into build failures, which is the cheapest guard a 1 to 3 person team can have. The location switcher is in scope at your request; limiting it to exposing the selection (not filtering, not sending it to the api) keeps it a pure frame concern until stock screens exist.

## Amendment 2026-11-05

Back to the amendment: [index.md](index.md#amendment-2026-11-05).

### Context

The decision above was right for a generic warehouse ERP and is built. The product changed (positioning (kept private)): the users are confirmation agents on calls and WhatsApp all day, warehouse staff scanning, an operations lead, and an owner on a phone, in Arabic first. Three things the first decision did not need are now needed: order and cash status as the main content, provisional versus confirmed numbers, and two more frames (a public portal on cheap Android phones carrying a brand's own identity, and a partner surface). Shape A of spec 0007 applies: keep and amend.

Forces added:

- **Status density.** An order row carries fulfillment, cash, source, outcome, and an attention flag. Color must help a reader find a failed delivery in a long table without being the only signal.
- **The longest session is the queue.** Eight hours of calls and WhatsApp, reading Arabic names and addresses, one main action per order.
- **Trust in numbers.** The reference brand's numbers contradicted each other until provisional and confirmed data were separated (insights items 5 and 11); the screen must make the difference impossible to miss.
- **A brand's color is also a meaning color.** The reference brand's accent is green, the color of "confirmed". The portal must carry the brand without borrowing meaning colors.
- **Slow phones.** The portal's first view cannot wait for a font catalog.
- **A small team.** The cheapest change that works is values in tokens, not new component structure.

### Options considered (amendment)

#### Option A. Quiet Ledger (keep and tune)

The built zinc look, plus four meaning aliases, a status chip, provisional rules, three frames, and a portal brand accent.

**Pros**:

- No rework or regression risk.
- Plex Sans and Plex Sans Arabic are one family.
- The least decoration, so status colors stand out the most.

**Cons**:

- The main action is near black like the text, so it is the weakest element of the queue card.
- The look is generic; no warmth over a long shift.

#### Option B. Daftar (warm paper)

Warm off white paper, a deep indigo primary, tinted chips, Inter with Noto Sans Arabic, 40px rows, a quiet slate for info.

**Pros**:

- The main action is visible.
- Easier over a long shift than white; tinted chips scan well in a table.
- A plain Arabic face for dense data.

**Cons**:

- Two unrelated families need a tuned Arabic size.
- An indigo primary is shared by all clients.
- Tints move how the status colors look, so they need a live contrast check.

#### Option C. Floor Console

Cool gray, a teal primary, Readex Pro for both scripts, 48px rows, solid status chips, a thick start stripe, a 3px focus ring.

**Pros**:

- Strongest for the agents and the warehouse; status readable at a glance and at a distance.
- Big targets suit phones and handhelds; one family for both scripts.

**Cons**:

- About 16 rows per screen is too few for the operations lead.
- Solid color on every row can fatigue and can hide the one row that needs attention.
- Readex Pro's tabular figures and small size Arabic are unverified; the biggest visual change.

#### Option D. Theme the whole back office per brand

Every client's back office takes the brand accent as its primary, as the portal does.

Rejected: the back office is the staff's daily tool and its meaning colors must be the same in every install so a trained agent can move between brands; a brand accent can collide with confirmed or failed (a green or a red brand); it multiplies the contrast checks per client and needs a settings screen before it earns anything. The portal is where the brand's identity matters (customers), so only the portal and the partner frame carry it.

### Rationale (amendment)

**Recommended: Option B with C's `floor` density scope.** The queue and the owner's phone are the two sessions that matter. B gives the queue a primary action that stands out (A does not) without the fatigue and row loss of C everywhere, and gives all day readers a warmer surface. C's one real advantage, large rows and targets for hands busy with a phone or a scanner, is kept as a scope (`data-density="floor"`) that the queue and scan screens use on a coarse pointer, in any direction, so the operations lead's tables stay at 40px.

All three keep the decisions from the first rationale: shadcn on Radix, `packages/ui`, role tokens only, logical CSS, the `/design` page, and axe in four combinations. The change is token values, a font pair, and new components outside the vendored shadcn folder, so existing components keep their classes.

The status rules are the same in every direction because they come from the product, not from taste: icon plus word, four meaning roles mapped onto existing hues, provisional shown dashed with a leading approximation sign, and a brand accent that never touches status. The phone dashboard and the help pattern are also direction independent for the same reason, and the dashboard's order follows the daily report so the owner reads one story in Telegram and in the app.

Contrast values for the options were computed with a throwaway script (oklch to sRGB, WCAG 2 formula) after it reproduced the built zinc figures in `DESIGN.md`; the build recomputes them live on `/design`. Font licenses (SIL OFL 1.1 for IBM Plex, Inter, Noto Sans Arabic, Readex Pro, JetBrains Mono) are stated from general knowledge and are confirmed against each font's own license file in the first build task, not assumed.

### Consequences (amendment)

- Picking B or C rewrites the `DESIGN.md` color and type tables and the `/design` contrast list; picking A leaves them and adds sections.
- The direction can be changed later with a token edit; the frames, chips, and patterns do not depend on it.
- The brand accent guard means some brand colors are refused at save; the owner sees the reason and a suggested nearest accepted color.
- The previews are static HTML and load fonts from Google Fonts for display only; they are not part of the product and are not tested.
