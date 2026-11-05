# 0005 rationale: Staff sign in

The decision record for [index.md](index.md). The build does not read this file.

## Context

> ⚠️ Premise note: "Staff sign in" spans several pieces that could each be their own spec: the sign in core, mail and password reset, staff administration, and optional two factor. They are kept together here because they share one data model and one set of session rules, and the build plan ships them as separate slices. If time runs short, cut optional two factor (slice 6) first; nothing else depends on it. Roles and permissions are feature 13 and are deliberately not designed here, so this spec only knows `admin` and `staff`.

SSDashboard holds stock quantities, unit costs and stock value for a business with up to 100,000+ SKUs, and later prices, purchase orders and the data behind an accounting export. Today nobody signs in. The `/api` routes are open, the user menu is a placeholder, and the stock ledger's `posted_by` and the data model's `created_by` columns are plain empty `uuid` columns waiting for a users table (spec 0002). Every slice after this one assumes a known person is acting.

Each client gets their own install, either in your cloud or on their own servers, sometimes with no internet. Some installs have a working mail server and some do not. Staff range from office buyers with a work email to warehouse staff on shared terminals who may have none. The team is one to three developers, so every extra moving part counts, and spec 0001 already chose Better Auth, mounted in the NestJS api, with a host only session cookie. What it left open is the flows: who may sign in and how, how accounts start and end, how a forgotten password is recovered when mail may not exist, how long sessions live, and how the system defends against guessing.

The cost of leaving this open is that every later feature either builds around an anonymous user or invents its own idea of "who did this", and that the costs and stock values this system exists to protect stay readable by anyone who can reach the URL.

## Options considered

### Option 1: Better Auth with the admin and two factor plugins, wrapped by our own staff endpoints and database backed hardening

Use Better Auth for hashing, sessions, reset tokens and two factor, and its admin plugin for the role and ban columns and the ban check at sign in. Expose staff management only through our own `/api/staff` NestJS routes (Zod contracts, last admin rule, logging), and add per email lockout, the 7 day cap, the mail queue, a nightly cleanup and a `create-admin` command around it.

**Pros**:
- Builds on the choice spec 0001 already made; works fully on premises with no per user fees.
- Password hashing, token handling and the two factor protocol come from a maintained library, not our code.
- One contract and one OpenAPI document for everything the browser calls that we own.
- Every recovery path works without mail.

**Cons**:
- Better Auth has no per account lockout or absolute session cap, so we write and test those ourselves.
- Wrapping the admin plugin means two layers to understand, and an upgrade can change hook behavior.
- More to build than a bare sign in page.

### Option 2: Better Auth with the admin plugin called straight from the browser

Use Better Auth's `/admin/*` routes from the staff screen with its own client, with no `/api/staff` layer.

**Pros**:
- Much less code for staff administration.
- Tested behavior for create, ban and set role out of the box.

**Cons**:
- Those routes sit outside our OpenAPI document and the "one schema per shape" rule.
- The last admin rule and our logging would have to be bolted on, and cannot be made atomic with Better Auth's own connection.

### Option 3: A separate identity server per client (for example Keycloak)

Run a dedicated identity service in each Compose stack and have the api trust its tokens.

**Pros**:
- Rich built in features: password policy, lockout, two factor, user admin screens.
- Single sign on for a future storefront or other apps.

**Cons**:
- One more heavy service to install, upgrade, back up and secure in every client install, against the small team and one container set principle of spec 0001.
- A second place for users and a second admin UI; our own roles and `posted_by` still need a local users table.

### Option 4: Hand written sign in on NestJS

Hash with argon2, issue sessions ourselves, and write reset and two factor flows.

**Pros**:
- Full control and no library to learn.

**Cons**:
- Session fixation, token storage, timing and reset flaws are each a breach waiting to happen, and the work must be redone and reviewed for every protocol detail. This is the "reinventing auth" failure pattern and contradicts spec 0001.

## Rationale

Option 1 wins on the forces in Context. Spec 0001 already committed to Better Auth for on premises operation, so Options 3 and 4 would reopen a settled decision and add a service or a security surface for a team of one to three. Between Options 1 and 2, the deciding forces are the stock ledger and the roles to come: the last admin rule must be atomic, staff actions must be logged and emitted as events for feature 14, and the repo's rule is one Zod contract per shape. Those need our own layer, and a thin layer now is cheaper than retrofitting one after screens depend on the raw routes. (basis: your AGENTS.md rules on contracts and error codes; spec 0001)

Recovery without mail drove several choices. Temporary passwords shown once to an admin, `create-admin --reset-password`, and an emailed link used only when mail is on mean no install can be locked out for want of a mail server. Lockout keyed on email text with identical answers, and a neutral reset response with the same timing, close account probing without giving an attacker a way to lock out a real person for long (the lock is 15 minutes and self clearing). (basis: OWASP forgot password and authentication cheat sheets; account enumeration prevention)

Two factor break glass (amended 2026-11-04). A sole admin who loses the authenticator app and every backup code, or every admin after a `BETTER_AUTH_SECRET` rotation, had no way back in: the staff page reset needs a second admin who can sign in, and `--reset-password` deliberately left two factor alone. We added `create-admin --reset-two-factor` with the same shell only trust as `--reset-password`. Anyone who can run that command can already replace the password and reach the database, so removing the second factor from there grants nothing new. It takes the same lock and row lock as the other admin changes, deletes exactly what the staff page reset deletes plus the pending challenges and the lockout, and keeps the password, so a person who still knows it is not forced through a change. It can run together with `--reset-password` in one transaction because the fully locked out case is the common one and should take one command, with nothing half applied. Rejected: a recovery flow over HTTP or email, because a second factor that can be removed by whoever controls the mailbox or the network path no longer adds a factor; rotating the secret or editing the database by hand, because both are error prone and leave no audit line; leaving the gap and escalating to a developer, because installs run on premises, sometimes with no internet and no developer at hand. (basis: OWASP Multifactor Authentication cheat sheet, on resetting a lost factor out of band; the existing `resetAdminPassword` and `StaffService.resetTwoFactor` in this repo)

Sending mail through the existing pg-boss worker was chosen over sending inside the request: it keeps response time the same whether the email exists, and retries cover a briefly unavailable mail server. The worker already exists and runs the nightly reconcile job, so this adds a queue, not a service. Invites reuse Better Auth's reset redeem path with a 7 day token, which avoids a table and a second redeem flow, at the cost of depending on its token format, covered by a pinned test.

Three choices differ from what I recommended, and each is yours to make:
- **Password rule.** You chose 8 characters with upper, lower and a digit. Current guidance prefers length (12 or more) with a blocklist and no composition rules. The choice works but is easier to guess and more annoying to type on handhelds; lockout, IP limits and optional two factor are the compensating controls, and the rule lives in one shared schema so it can change cheaply.
- **Two factor in this feature.** You chose optional for everyone rather than leaving the door open. It adds enrollment, backup codes and admin resets to a feature that others wait on, so it is the last slice before the cleanup and can be dropped without touching the rest.
- **Both mail adapters.** SMTP is certain to be needed; Postmark has no asking client yet. It costs a small adapter and test, and gives cloud clients delivery stats.

Where the 7 day cap and idle expiry come from: Better Auth gives a sliding session only, so the 12 hour renewal comes from its `expiresIn` and `updateAge` settings and the 7 day cap is a comparison against `sessions.created_at` in the guard. Cookie caching is off so a disable takes effect on the next request, at the price of one database read per request, which is fine at back office volumes. (basis: OWASP session management cheat sheet)

## References

**Project sources** (verifiable, in this repo):
- `AGENTS.md`: rules on modules, contracts, errors, no business logic in Next.js, UI and design system.
- Spec 0001: Better Auth choice, sessions and routing, secrets, entry points.
- Spec 0002: `created_by` / `posted_by` follow up and the `postedBy` input.
- Spec 0003: user menu placeholder and the `/api/locations` follow up.
- Spec 0004: `ss_lang` cookie and the default language in config.
- `apps/api/src/inventory/ledger/reconcile.job.ts`: the pg-boss worker pattern the mail and cleanup jobs follow.
- The six installed Better Auth skills listed in `index.md` under Decision.

**Practices & standards**:
- NIST SP 800-63B password guidance (length over composition, screening, no forced rotation).
- OWASP Authentication, Session Management and Forgot Password cheat sheets; OWASP ASVS chapters on authentication and sessions.
- Account enumeration prevention (identical answers and timing).
- Single use, short lived reset tokens; revoke sessions on credential change.
- WCAG 2.2 success criterion 3.3.8, Accessible Authentication (Minimum).
- Expand and contract migrations (spec 0001) for the staged foreign keys.

## Amendment 2026-11-05

The decision record for the amendment in [index.md](index.md). The original text above stays as it was; this section only adds.

### Context

Spec 0007 chose Shape A: keep this spec and its built code, and amend it ([0007 build plan](../0007-stack-architecture-operations-layer/index.md)). The positioning moved the product to clothing brands behind Shopify and Bosta, with a back office, a partner surface and a public returns portal on separate hostnames ([0007 section 2](../0007-stack-architecture-operations-layer/index.md), [positioning section 6.6](../../positioning/2026-11-05-egypt-order-operations-layer.md)). Three forces reach sign in. A public host now sits one DNS name away from a host that holds a session cookie, so the cookie scope is a security control and no longer a detail. A second kind of person (a partner user, bound to one partner account) must sign in through the pages and limits already built and reviewed. And every table gets a tenant id, with roles becoming hats that one person can hold several of, so a live session must have a defined behavior when a person's hats change. The 2026-11-04 review found no blockers and its fixes are in, so the amendment does not reopen sign in itself ([review](../../reviews/2026-11-04-feat-staff-sign-in.md)).

### Options considered

**Cookie scope for the staff session.**
- *Host only on the staff host (chosen).* No `Domain` attribute, so the browser sends the cookie to the staff host alone. It is what spec 0007 section 2 already says, and it needs no setting beyond leaving Better Auth's `crossSubDomainCookies` off. Pros: the public portal host never receives it, and it costs nothing. Cons: one staff host per brand, and a sibling subdomain can still plant a cookie with a wider `Domain` (cookie tossing).
- *A `Domain=<brand domain>` cookie shared by subdomains.* Easier for single sign on later. Rejected: the portal host would receive the staff session on every request, which is the exact risk the origin wall exists to remove.
- *Portal on a different registrable domain.* Strongest separation, and it ends cookie tossing. Rejected as a requirement: it costs the brand a second domain and its DNS work. It stays allowed, because nothing in this spec forbids it.
- *A `__Host-` cookie name.* Would stop tossing. Not possible through configuration: Better Auth prepends `__Secure-` on https, so the name cannot start with `__Host-` (checked in the installed `better-auth` 1.7.15, `dist/cookies/index.mjs`). Left as a follow up.

**Path based fallback.** Scoping the cookie by `Path` through `advanced.defaultCookieAttributes.path` is supported in the installed version (same file; it is spread over Better Auth's own `path: "/"`). That is why AC-31 is a small, testable cookie contract. What it cannot decide is whether pages and `/api` can share one prefix, because Next.js `basePath` is fixed at build time and `AGENTS.md` forbids per client values in an image. That belongs to deployment, so it is a risk and not a requirement here.

**Partner users.**
- *Same Better Auth users and pages, audience from hats (chosen).* Reuses lockout, limits, reset, mail and two factor without a second copy, and keeps one place to prove that answers do not reveal the kind of person. Cons: the guard must now look at audiences, and a mistake there could let one kind reach another's routes; AC-29 and its tests cover that.
- *A second Better Auth instance or user table for partners.* Cleaner on paper. Rejected: two lockouts, two reset flows and two sets of mail to keep identical, and an attacker could tell the two apart by timing.
- *A separate partner sign in page.* Rejected: the lockout would still be shared, and the extra page buys nothing but a visible difference between staff and partner emails.

**How the guard learns a person's audiences.**
- *A port, `SessionAudiences`, read from the database on every request (chosen).* Keeps the hat model out of this spec (spec 0008 owns it), lets this spec be built and tested now with a staff only implementation and a fake, and fits the rule that cookie caching is off.
- *Hats stored in the session or cookie.* Rejected: a removed hat would keep working until the session ended, up to 7 days.
- *The guard reads hat tables directly.* Rejected: it would force this spec to design hats, which scope feature 8 owns.

**Tenant id on the auth tables.** The column default from the database setting `ssd.tenant_id` (chosen, per [0007 section 7](../0007-stack-architecture-operations-layer/index.md)) means Better Auth's inserts, which never name the column, still fill it. Passing the tenant id from code (runner up) was rejected there because a data move in SQL could forget it. `rate_limits` and `verifications` keep the keys Better Auth owns because changing them would fight the library for no gain in a one tenant database.

**Sessions when hats change.**
- *Conservative (chosen): the next request sees the change, and sessions are deleted only when the person loses every hat, changes audience, or moves to another partner account.* A grant or a smaller change needs no new sign in, and a change that could leave a stale partner binding ends the session in the same transaction, like disabling.
- *Always delete sessions on any hat change.* Safe but annoying: an operations person would be signed out each time a manager adds a hat.
- *Never delete, rely on fresh reads.* Rejected for kind changes and partner rebinding, where a leftover session is hard to reason about in an audit.

**One `identity` module.** Spec 0007's module map names it. Keeping `auth` and `staff` apart would leave `staff` importing `auth` internals (it already takes the admin lock and writes auth tables), which breaks the rule that modules talk through exported services. One module, with sub folders, keeps the rule honest and is a rename with no behavior change.

### Rationale

Keep what was built and reviewed, and change only what the new layout forces. The three real changes are all about boundaries: which host can see the cookie, which audience a session may use, and which tenant a row belongs to. Each is a few lines of configuration or a guard rule with a test that fails when it is removed. The risky part, the hat model, is pushed to spec 0008 behind a port and a single revoke call, so this amendment can be built first and the two specs cannot disagree about sessions. (basis: spec 0007 sections 2 and 7 and the Carried table row m8; the 2026-11-04 review)

### References (amendment)

**Project sources** (verifiable, in this repo):
- [Spec 0007](../0007-stack-architecture-operations-layer/index.md): section 2 (audiences, origin wall, partner sign in), section 7 (tenant id), the Module map, Configuration, and the Carried table row m8.
- [Positioning, section 6.6](../../positioning/2026-11-05-egypt-order-operations-layer.md): roles are hats, teams optional.
- [Review of 2026-11-04](../../reviews/2026-11-04-feat-staff-sign-in.md): settled findings 1 to 7, deferred finding 8.
- `apps/api/src/auth/auth.factory.ts` (cookie caching off, `useSecureCookies`, `ipAddress` header), `apps/api/src/platform/audience/` (the audience guard), `apps/api/src/auth/AGENTS.md` (the guard still demands a staff session), `packages/db/src/schema/auth.ts`.
- `deploy/Caddyfile`: the single forwarded client address and `trusted_proxies`.
- Installed `better-auth` 1.7.15, `dist/cookies/index.mjs`: cookie name prefix, default `path`, `defaultCookieAttributes`, `crossSubDomainCookies`.

**Practices & standards**:
- OWASP Session Management cheat sheet (cookie scope, `Domain` and `Path` attributes).
- Account enumeration prevention (identical answers for every kind of account).
