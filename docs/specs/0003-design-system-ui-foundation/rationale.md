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
