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
