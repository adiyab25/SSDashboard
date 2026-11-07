# Staff sign in run book

For the person who runs a client install. A vendor hosted client and a self hosted install use the same steps, run from the `deploy/` folder. This guide covers the first admin, the tenant id, recovery for each kind of person, lockouts, the client address, mail, the nightly cleanup, sessions and hat changes, cookies and paths, and common symptoms.

Governing spec: [spec 0005, amendment of 2026-11-05](../specs/0005-staff-sign-in/index.md). The amendment section of that spec says what changed and why.

Checked against the code on 2026-11-06. Where a part is not built yet, this guide says so.

Run every command from the `deploy/` folder, with the install's `.env` in place.

## 0. What works today

| Part | Today | Arrives with |
|---|---|---|
| Staff sign in and sign out, the first admin, break glass recovery | Works | |
| Access by hats (support, operations, warehouse, manager, media buyer, partner) and the cost grant | Built (spec 0008). The staff page gives and changes hats and the cost switch | Feature 8 (spec 0008), done |
| Partner users and the Partner logins tab | Built (spec 0008 milestone 3). A partner user signs in to the partner side only | Feature 8 (spec 0008), done |
| Hat changes and what they do to sessions | Built (spec 0008 milestones 2 and 3). See section 8 | Feature 8 (spec 0008), done |
| `STAFF_ORIGIN`, the new name of `PUBLIC_URL` | Not in the code. Use `PUBLIC_URL` | The spec 0007 rename, features 3 and 26 |
| A portal site in the Caddyfile | Not built. `deploy/Caddyfile` serves one site | Feature 26 |
| A path prefix rule in the Caddyfile for `STAFF_BASE_PATH` | Not built | Features 26 and 47 |
| One shared Postgres and one edge Caddy for many clients | Not built. Each client runs its own stack | Features 4 and 26 |
| Published images in a registry | Not built. Each install builds its own images (section 1.2) | Feature 26 |

Each step that depends on a part that is not built says so where it appears.

## 1. Set up a new install and create the first admin

### 1.1 Check the log driver once per host

A Docker host can run many client stacks. Its daemon sets one default log driver for all of them. Check it once per host. Do this before anyone creates the first admin of any client on that host.

Run this on the host itself:

```bash
docker info --format '{{.LoggingDriver}}'
```

It must print `json-file` or `local`. Any other value (for example `journald`, `syslog`, `fluentd` or `awslogs`) means the daemon keeps or ships container output. The temporary password would then be stored or sent to that log. Do not create an admin on that host. Use a host with a local driver instead.

`deploy/compose.yaml` sets no `logging:` key for any service, so every client stack on the host takes the daemon default. On a Linux host, that default is usually set in `/etc/docker/daemon.json`.

### 1.2 Fill in `.env`

Create `.env` from the template. It generates fresh values for `POSTGRES_PASSWORD`, `APP_DB_PASSWORD` and `BETTER_AUTH_SECRET`:

```bash
./bootstrap.sh
```

`bootstrap.sh` refuses to run when `.env` already exists. It writes `.env` with mode 600. Then set these values by hand:

| Name | What to put | Why |
|---|---|---|
| `CLIENT_ID` | A short name for the client, for example `acme` | It names the Compose project `ssdashboard-<CLIENT_ID>` (the top-level `name:` key of `deploy/compose.yaml`), so each client's containers and volumes stay apart. |
| `SSD_VERSION` | An exact release, never `latest` | It is the image tag. The header of `deploy/compose.yaml` pins it, and section "Where the images come from" below names the images |
| `SSD_REGISTRY` | `local` for an install that builds its own images. Leave it unset only once published images exist | Part of the image names. See "Where the images come from" below |
| `SITE_ADDRESS` | The host name Caddy serves, or `:80` behind the client's own TLS proxy. For a trial on one machine, `localhost` (see "Trial run without a public name") | The `{$SITE_ADDRESS}` site block of `deploy/Caddyfile`. A bare host gets automatic HTTPS |
| `PUBLIC_URL` | The full https address with no path, for example `https://erp.example.com`. It must match the address people type in the browser | This is the staff origin today. It sets the sign in address, the cookie `Secure` flag and the links in emails (`PUBLIC_URL` in `EnvSchema`, `apps/api/src/config/env.ts`). |
| `PORTAL_ORIGIN` | Leave empty unless the install has a public portal | Only the api reads it. See section 9.4. |
| `STAFF_BASE_PATH` | Leave empty | Read section 9 before you set it. |
| `TRUSTED_PROXIES` | Leave empty unless a client proxy sits in front of Caddy | See section 5. |

About the names: `STAFF_ORIGIN` is not in the code yet. Spec 0007 renames `PUBLIC_URL` to `STAFF_ORIGIN` later. When that rename lands, set `STAFF_ORIGIN` to the same address. The address does not change.

A vendor hosted client follows the same steps. Run them in that client's own Compose project, with that client's own `.env`. Keep that `.env` in the private store for the client (the header comment of `deploy/.env.example`). Spec 0007 names `STAFF_ORIGIN` and `PORTAL_ORIGIN` as the two hostnames of a client. Today the staff host is `PUBLIC_URL`, and `PORTAL_ORIGIN` is set only when the client has a portal. A self hosted install runs the same steps on the client's own machine.

#### Where the images come from

`deploy/compose.yaml` runs two images. Their names come from `SSD_REGISTRY` and `SSD_VERSION`:

- `${SSD_REGISTRY}/ssdashboard-app:${SSD_VERSION}` for `api`, `worker` and `migrate` (the `image:` line of the `x-app` anchor).
- `${SSD_REGISTRY}/ssdashboard-web:${SSD_VERSION}` for `web` (the `image:` line of the `web` service).

`SSD_REGISTRY` defaults to `ghcr.io/adiyab25` when it is unset. No published image exists there yet. The CI `images` job in `.github/workflows/ci.yml` builds both images and does not push them (`push: false`). Publishing comes with feature 26. Until then, an operator builds the two images on the host, with the tag that compose expects:

1. In `.env`, set `SSD_REGISTRY=local` and `SSD_VERSION` to the release number you want, for example `0.1.0`.
2. Build from a checkout of the repository root. The build context is the root, so a copy of `deploy/` alone is not enough. The header of `deploy/Dockerfile.web` gives the same build from the root.

   ```bash
   docker build -f deploy/Dockerfile.app -t local/ssdashboard-app:0.1.0 .
   docker build -f deploy/Dockerfile.web -t local/ssdashboard-web:0.1.0 .
   ```

The image name and tag must equal `${SSD_REGISTRY}/ssdashboard-app:${SSD_VERSION}` and `${SSD_REGISTRY}/ssdashboard-web:${SSD_VERSION}` exactly. QA's walk-through used this method: `SSD_REGISTRY=local`, `SSD_VERSION=qa`, and images tagged `local/ssdashboard-app:qa` and `local/ssdashboard-web:qa` (spec 0005, verify.md, AC-35).

#### Trial run without a public name

To try an install on one machine, set these two values in `.env`:

```
SITE_ADDRESS=localhost
PUBLIC_URL=https://localhost
```

A bare host makes Caddy use its own internal certificate, because the `{$SITE_ADDRESS}` site block of `deploy/Caddyfile` gives a bare host automatic HTTPS. A browser does not trust that certificate, so it shows a certificate warning. QA's walk-through accepted the warning and signed in on `https://localhost` (spec 0005, verify.md, AC-35). Accept the warning for a trial only.

`PUBLIC_URL` must match the address typed in the browser. Better Auth trusts only that origin (`createAuth` in `apps/api/src/identity/sign-in/auth.factory.ts`, `trustedOrigins`).

A real client needs a public name that points at the host, for example `SITE_ADDRESS=erp.example.com` and `PUBLIC_URL=https://erp.example.com`. `SITE_ADDRESS=:80` is only for a client's own TLS proxy (section 5).

### 1.3 Start the stack

Before you start, the two images from 1.2 must exist under the names in `.env`.

Caddy mounts `../extensions/<CLIENT_ID>/locales` (the `caddy` service's `volumes` in `deploy/compose.yaml`) at `/srv/locales`, read only. That folder sits in the repository next to `deploy/`. QA's walk-through saw Docker create it when it was missing (spec 0005, verify.md, R3). To add a client language, drop a `<code>.json` file into that folder. Caddy serves it at `/locales/<code>.json` (`deploy/Caddyfile`, the `handle /locales/*` block).

```bash
docker compose --env-file .env up -d
```

The `migrate` service runs first. It applies the database migrations and then exits. The `api` and the `worker` start only after `migrate` finishes without error (the `depends_on` blocks of `api` and `worker` in `deploy/compose.yaml`). If `migrate` fails, the api does not start. Read the migrate log, fix the cause, and run the same command again:

```bash
docker compose --env-file .env logs migrate
```

The `migrate` service checks only its own settings at start (`loadMigrateEnv` in `apps/api/src/config/env.ts`): the owner database address, the app role password and name, and the tenant id. It never needs the auth secret or `PUBLIC_URL`. A missing owner database address stops it with `Invalid environment` and names `MIGRATION_DATABASE_URL`.

### 1.4 Where the tenant id comes from

Every row in the database carries one tenant id. The auth tables take it from a database setting, `ssd.tenant_id`. You do not set it by hand on a new install.

- On the first run, `migrate` chooses the tenant id. It uses `TENANT_ID` from `.env` when that is set, and makes a new one when it is not (`TENANT_ID` in `EnvSchema`, `apps/api/src/config/env.ts`). It stores the id as the database setting `ssd.tenant_id` and writes the `install` row (`runMigrations`, `packages/db/src/migrate.ts`).
- `create-admin` writes to the same database. It needs that setting. The auth tables fill `tenant_id` from it by default (`packages/db/AGENTS.md`, the `tenantId()` convention).

**Symptom when the setting is missing:** `create-admin` prints `create-admin failed: 42704`. That is the code QA observed for a missing `ssd.tenant_id`. Another database error prints `create-admin failed: database error` or another PostgreSQL code. It exits with code 1 and creates nothing (`apps/api/src/create-admin.ts`).

**Check the setting.** A uuid in the output means the setting is there. An error or an empty value means it is missing. On QA's run, a missing setting made `SHOW` print `unrecognized configuration parameter`:

```bash
docker compose --env-file .env exec postgres psql -U ssdashboard -d ssdashboard -c "SHOW ssd.tenant_id"
```

**Fix it.** Running `migrate` again does not set it when the `install` row already exists (`runMigrations`, the stored tenant check in `packages/db/src/migrate.ts`). So set it by hand, as the database owner:

1. Read the tenant id from the install row:

   ```bash
   docker compose --env-file .env exec postgres psql -U ssdashboard -d ssdashboard -tAc "SELECT id FROM install"
   ```

2. Set the setting to that id. Replace `<tenant id>` with the value from step 1 only:

   ```bash
   docker compose --env-file .env exec postgres psql -U ssdashboard -d ssdashboard -c "ALTER DATABASE ssdashboard SET ssd.tenant_id = '<tenant id>'"
   ```

3. Run `create-admin` again (section 1.5). A new connection reads the setting. `ALTER DATABASE` reaches new sessions only (the `ALTER DATABASE` statement in `runMigrations`, `packages/db/src/migrate.ts`).

Do not guess the id. If step 1 prints nothing, the database has no `install` row. Stop and ask the vendor.

### 1.5 Create the first admin

```bash
docker compose --env-file .env run --rm api node dist/create-admin.js --email <email> --name <name>
```

The `--rm` flag removes the container when the command ends. With the `json-file` driver, its log goes with it.

The command prints the temporary password once:

```
Admin created: <email>
Temporary password (shown once, change it at first sign in): <password>
```

Give the password to the admin in person or in a password manager. Do not write it down anywhere else.

The admin signs in at the staff origin plus `/sign-in`. Today that is `PUBLIC_URL/sign-in`. The app opens the Change your password screen first. Choose a new password. It needs 8 to 128 characters, with a lowercase letter, an uppercase letter and a digit. Any decimal digit counts.

The command refuses, exits with code 1 and changes nothing when:

- `An active admin already exists. Sign in as that admin to add staff.` If that admin is locked out, use section 2.1.
- `<email> already belongs to an account.` Use another email. If that account is an admin, use section 2.1.
- `--name` is missing, or `--email` is missing. The usage text prints (`apps/api/src/identity/sign-in/create-admin-args.ts`).

### 1.6 Add a second admin (recommended)

Create a second admin right after the first one signs in and changes the password:

- On the staff page, choose Add staff. Give the person the Manager hat and turn the cost switch on. Give the temporary password to that person under the same rules as step 1.5.
- Each admin turns on two factor from the account page (Turn on). They store the 10 backup codes offline. The codes show once, when two factor turns on or when new codes are made.

With two admins, a lost authenticator never leaves the install without a working admin. A sole admin who loses the authenticator and every backup code uses section 2.2.

## 2. Recovery for each kind of person

| Who is locked out | Who fixes it | Where |
|---|---|---|
| An admin, with mail on | The admin uses the forgot password link. The link also clears the lock. | Section 2.1 |
| An admin, with mail off, or no admin can sign in | Someone on the server shell runs `create-admin` | Section 2.1 |
| Staff (no manager hat) | A manager, on the staff page | Section 2.3 |
| A partner user | A manager, on the Partner logins tab of the staff page | Section 2.4 |
| The only admin, with the password and the authenticator both lost | Someone on the server shell runs both reset flags in one command | Section 2.5 |

### 2.1 Admin: reset the password

Use this when mail is off (`MAIL_DRIVER=none`), and the only active admin cannot sign in because the password is lost or the account is locked. With mail on, the admin can use the forgot password link instead. That link also clears the lock.

```bash
docker compose --env-file .env run --rm api node dist/create-admin.js --reset-password --email <email>
```

What it does (`apps/api/src/identity/sign-in/reset-admin.ts`):

- Sets a new temporary password. It is shown once.
- Clears the lockout for that email.
- Ends every session for that account, and deletes its older reset and invite links.
- Ends any sign in that waits for a two factor code.
- Sets the must change flag. The old password stops working at once. The admin must choose a new password at the next sign in.
- Writes one audit line to stderr, with the event `auth.admin_break_glass_reset`, the user id and the time. It holds no password and no email.

The command prints:

```
Password reset: <email>. Sessions ended and lockout cleared.
Temporary password (shown once, change it at next sign in): <password>
```

It refuses, exits with code 1 and changes nothing when:

- `No account has the email <email>.`
- `<email> is not an admin. Ask an admin to reset their password from the staff page.` (The account is staff.)
- `<email> is disabled. Enable the account before resetting its password.`

This run does not reset two factor. If the admin also lost the authenticator app, the admin needs one of these:

- A backup code. At the two factor step, choose Use a backup code instead.
- Another active admin resets that person's two factor from the staff page (Reset two factor). This also ends their sessions.

If neither is possible, use section 2.2.

### 2.2 Admin: reset two factor

Use this when an admin has lost the authenticator app and every backup code. It applies to a sole admin, and to each admin after a rotation of `BETTER_AUTH_SECRET` (section 10). Run it from a shell on the server. It is never offered over HTTP, by email or on any screen.

```bash
docker compose --env-file .env run --rm api node dist/create-admin.js --reset-two-factor --email <email>
```

What it does (`apps/api/src/identity/sign-in/reset-admin.ts`):

- Turns two factor off for that account and deletes its stored two factor setup.
- Ends every session for that account, and every sign in that waits for a code.
- Clears the lockout for that email. This includes a lock built up by wrong codes.
- Keeps the password. The admin signs in with the same password. The must change flag is not set.
- Prints `Two factor reset: <email>. Sign in with the password alone, then set up two factor again.` It prints no password.
- Writes one audit line to stderr, with the event `auth.admin_break_glass_two_factor_reset`, the user id and the time. It holds no email, code, secret or password.

It refuses, exits with code 1 and changes nothing when:

- `No account has the email <email>.`
- The account is not an admin. An admin resets that person's two factor from the staff page.
- The account is disabled. Enable it first.

If two factor is already off, the command still succeeds and changes nothing else. A repeated run is safe.

After the run, the admin signs in with the password and turns two factor on again from the account page (Turn on). They store the new backup codes offline.

### 2.3 Staff (not an admin): the staff page

An admin does this from the staff page. Find the person, then use the action you need:

- **Reset password.** With mail on, the person gets a link that is valid for 1 hour. With mail off, a temporary password shows once. Either way the old password stops working at once, the person's sessions end, the person must change the password at the next sign in, and the lock clears (`StaffService.resetPassword` in `apps/api/src/identity/staff/staff.service.ts`; spec 0005, AC-18).
- **Sign out everywhere.** Ends every session of the person. The password stays the same.
- **Reset two factor.** Turns two factor off and ends the person's sessions (`StaffService.resetTwoFactor` in `staff.service.ts`, in the same transaction).

Staff cannot reset their own password from the staff page. They use the Account page, or the forgot password link when mail is on.

### 2.4 Partner user: the Partner logins tab

A partner user wears the `partner` hat and is bound to one consignment partner account (spec 0008, AC-9). A person with `people.manage` (the manager hat) manages partner users on the Partner logins tab of the staff page (spec 0008, AC-15). A manager can reset a partner user's password and clear the lock from that tab. The same 15 minute lock and the same wait apply (section 4). Partner users use the same reset link by email when mail is on.

### 2.5 The only admin, with the password and the authenticator both lost

Run both reset flags in one command:

```bash
docker compose --env-file .env run --rm api node dist/create-admin.js --reset-password --reset-two-factor --email <email>
```

Both changes happen in one transaction. Either both apply or neither does. The command prints one temporary password (the `reset` case in `apps/api/src/create-admin.ts`). Each mode writes its own audit line. The output holds a live password, so follow section 3 for it. The admin signs in with the temporary password, chooses a new one, and then turns two factor on again.

Do not add `--name` to a reset run. With a reset flag, `--name` prints the usage and exits with code 1.

**Do not rotate `BETTER_AUTH_SECRET` to get around this.** Section 10 says when a rotation is safe.

## 3. Do not capture the output

The `create-admin` output contains a live temporary password whenever it resets a password (`--reset-password`, and the combined run). The first admin run prints one too. Keep it out of every log:

- Run the command in a local terminal on the server.
- Do not pipe or save it: no `| tee`, no `> file`, no `script`.
- Do not run it from CI, a scheduled job or a remote session that records output.
- Do not send container output to a remote or persistent log driver (journald, syslog, fluentd, awslogs). Check the host default first, with `docker info --format '{{.LoggingDriver}}'` (section 1.1). `deploy/compose.yaml` sets no `logging:` key for any service. Keep it that way.
- Do not paste the password into chat, a ticket or an email.

The command prints the password to its standard output, and the app never logs it. Under `docker compose run`, that output still goes through the container's log driver. That is why section 1.1 checks the driver first.

## 4. Lockouts and abuse

Limits (from the `LOCKOUT` constant in `apps/api/src/identity/sign-in/sign-in-lockout.ts`):

| Rule | Limit | Lock |
|---|---|---|
| One email from one client IP | 5 failures within 10 minutes | That pair is locked for 15 minutes |
| One email from any IP | 20 failures within 10 minutes | That email is locked for 15 minutes, for everyone |

- The email is compared trimmed and lowercased.
- Failures count: a wrong password, an unknown email, a wrong two factor code, and a wrong current password on change password or on two factor disable.
- During a lock, every attempt gets the same answer as a wrong password (`The email or password is not right. Check both and try again.`), even the correct one. Locked attempts are refused before they are counted, so they do not extend the lock.
- A full sign in clears the counters.
- Per IP, sign in is also limited to 30 attempts per minute (`createAuth` in `apps/api/src/identity/sign-in/auth.factory.ts`, the `/sign-in/email` rule of `rateLimit.customRules`). Going over returns 429 with an `X-Retry-After` header. A shift change can hit this. Wait a minute.

**Abuse:** anyone who knows a staff email can lock that person out for 15 minutes by sending 20 wrong passwords from any addresses. A patient attacker can repeat this every 15 minutes. The per IP limit does not stop this. Look for `AccountLocked` and `SignInFailed` lines in the api log to spot it.

How to clear a lock:

1. Wait 15 minutes from when it started. Nothing else is needed.
2. Another active admin resets that person's password from the staff page (section 2.3). This clears the lock, but it also changes the password.
3. Break glass for a sole admin (section 2.1). A forgot password link also clears the lock.

## 5. The client address behind Caddy

Lockouts and rate limits count by client address. The address must be the real client's. This section explains how Caddy works it out.

The chain, from the browser to the api:

1. The browser connects to the client's own TLS proxy, if there is one.
2. That proxy adds the client's address to the `X-Forwarded-For` header.
3. Caddy reads that header. It trusts only the proxies listed in `TRUSTED_PROXIES`, and it reads the list from the right. A value a user forges on the left is ignored (the global options block at the top of `deploy/Caddyfile`).
4. Caddy passes the api exactly one address. It sets `X-Forwarded-For` to the client address it found (the `upstream_headers` snippet in `deploy/Caddyfile`).
5. The api trusts only that header for the address (`createAuth` in `apps/api/src/identity/sign-in/auth.factory.ts`, the `advanced.ipAddress` setting).

Where to set it:

- `TRUSTED_PROXIES` in `.env` (the `TRUSTED_PROXIES` comment in `deploy/.env.example`). It is empty by default. The `caddy` service reads it (the `caddy` service's `environment` in `deploy/compose.yaml`).
- Set it only to the client's own TLS proxy, as space separated addresses or CIDRs. For example `10.0.0.5/32`.
- Leave it empty when Caddy faces users directly.

What goes wrong:

- **Behind a client proxy with `SITE_ADDRESS=:80` and an empty `TRUSTED_PROXIES`.** Caddy sees the proxy as the client. Every user shares one address. The per IP limits then apply to the whole install.
- **A wide range, such as `0.0.0.0/0`.** Anyone can fake their address, and the per IP limits stop meaning anything. Never use one.

Only `caddy` publishes ports (the `ports:` of `caddy` in `deploy/compose.yaml`). The api cannot be reached around Caddy, which is why it can trust that header.

**Later (feature 26):** one edge Caddy in front of many client stacks changes this chain. Each stack behind that edge must list the edge's address in its `TRUSTED_PROXIES`, and the edge must send one client address. Spec 0005 requires that `apps/api/test/compose-ports.spec.ts` stays meaningful when that change lands.

## 6. Mail on or off

`MAIL_DRIVER` is `none` (default), `smtp` or `postmark`. The api and the worker read it at startup. After a change, run `docker compose --env-file .env up -d`, which restarts the containers whose settings changed.

- **`none`:** no email is sent. `GET /api/config` reports `mailEnabled: false`. The forgot password page says to ask an administrator. Creating a person or resetting a password shows a temporary password once. Resending an invite is refused with `MAIL_DISABLED`.
- **`smtp`:** needs `MAIL_FROM` and `SMTP_HOST`. `SMTP_USER` and `SMTP_PASSWORD` go together, or both stay empty.
- **`postmark`:** needs `MAIL_FROM` and `POSTMARK_SERVER_TOKEN`. The sender must be verified in Postmark before the first send.
- With mail on, a reset link is valid for 1 hour and works once. An invite link is valid for 7 days.
- The worker tries each email up to 5 times (`apps/api/src/mail/mail-queue.ts`, `MAIL_RETRY_LIMIT` plus the first try). A failed try logs `Mail job <id> failed (try N), will retry: <detail>`. The last failure logs `Mail job <id> failed for good after N tries: <detail>` (`MailWorker.handle` in `apps/api/src/mail/mail.worker.ts`). The log never holds the link.
- A missing required setting stops the process at startup with `Invalid environment`, and names the setting.

## 7. Nightly cleanup

- Schedule: `AUTH_CLEANUP_CRON`. Default `0 3 * * *` (03:00 every day). It is set for the `worker` service in `deploy/compose.yaml`, and read as `AUTH_CLEANUP_CRON` in `EnvSchema` (`apps/api/src/config/env.ts`).
- Timezone: the `timezone` setting. The baseline migration seeds `Africa/Cairo` (`packages/db/migrations/0002_baseline_rules.sql`). The worker reads it at startup, so restart the worker after a change.
- Deletes:
  - sessions past `expires_at`
  - reset and invite tokens past `expires_at`
  - sign in counters whose lock has ended and whose window is over
  - sign in slots older than 60 seconds (a slot is normally given back at once, so these are left by requests that died)
  - rate limit counters whose last request is more than 1 day old
- Keeps live sessions, live tokens, and counters still in use.
- Logs one line from the worker (`AuthCleanupJob.onApplicationBootstrap`, in `apps/api/src/identity/sign-in/auth-cleanup.job.ts`):
  `Removed <n> sessions, <n> tokens, <n> sign in counters, <n> sign in slots, <n> rate limit counters.`
- A malformed cron value (not five valid fields) stops the api and the worker at startup with `Invalid environment`, naming the setting.

## 8. Sessions and hat changes

### 8.1 What sessions do today

- A session lasts 12 hours without use. Each use renews it, at most once an hour. It never lasts longer than 7 days from sign in (spec 0005, AC-5; `apps/api/src/identity/sign-in/session-policy.ts`).
- The cookie is never cached. The session and the person's hats are read from the database on every request (`createAuth` in `apps/api/src/identity/sign-in/auth.factory.ts`, the `session.cookieCache` setting). A change acts on the next request.
- A request with a cookie but no live session gets `SESSION_EXPIRED`, and the person is sent to sign in again. A request with no cookie gets `UNAUTHENTICATED`.

What the actions in the staff page do to sessions today:

| What you do | What happens to the person's sessions |
|---|---|
| Disable an account | All sessions end in the same step. The next request is refused. The sign in is refused with `This account is disabled. Ask an administrator for help.` (`StaffService.disable`; AC-16) |
| Enable an account | Nothing ends. The person can sign in again |
| Reset a password (admin) | All sessions end at once. The person must change the password at the next sign in (`StaffService.resetPassword`; AC-18) |
| Sign out everywhere (admin) | All sessions end. The password stays |
| Reset two factor (admin) | All sessions end (`StaffService.resetTwoFactor`) |
| Change the email of an invited account (admin) | All sessions end (`StaffService.update`, the email branch for an invited account) |
| Change own password | The person's other sessions end. The current session stays (AC-19) |
| Change hats or the cost grant (manager, staff page) | **Nothing ends** in the usual case. The new set applies on the person's next request, with the same sign in. The exceptions are in section 8.2 |

Removing `manager` from the last active manager is refused with `409 LAST_ADMIN` (spec 0005, AC-17; spec 0008, AC-12). Disabling the last active manager is refused too.

### 8.2 What hat changes do (spec 0008)

Hats are built. A person wears one or more hats, and a hat change is the way to change what a person can do.

The rules the spec sets (spec 0005, AC-33, and spec 0008, AC-12), in operator words:

- A hat added or removed takes effect on the person's next click. They keep the same sign in. They do not need to sign in again.
- A change that would leave a person with no hat is refused (`422 NO_HAT`). Nobody is signed out by it.
- No screen or route moves a person between the staff side and the partner side. `/api/staff` refuses the partner hat (`422 HAT_CONFLICT`).
- Binding a partner user to another partner account ends all their sessions in the same change. Their next click gets the sign in page.
- A change that only adds or removes a staff hat or the cost grant keeps their sessions.
- You still cannot remove `manager` from the last active manager. The change is refused (`409 LAST_ADMIN`).
- Nobody can change their own hats.
- Each hat change writes one log line, with no email, name or phone. It also writes one domain event.

## 9. Cookies, paths and the portal host

### 9.1 What the staff cookie is

- **Host only.** The cookie never carries a `Domain` attribute. This is set in `createAuth` in `apps/api/src/identity/sign-in/auth.factory.ts` (the `advanced` block). The test `apps/api/test/staff-cookie.e2e-spec.ts` reads a real sign in and fails on a `Domain`.
- **`HttpOnly`, `SameSite=Lax`**, and **`Secure`** when `PUBLIC_URL` is https (`createAuth`, `advanced.useSecureCookies`).
- **Why `Domain` matters.** A `Domain` cookie goes to every subdomain, the portal host included. The portal would then receive the staff session. If you ever see `Domain` in a `Set-Cookie` header from this install, stop and report it. Do not run the install until it is fixed.
- **`Path`.** It is `/` by default. `STAFF_BASE_PATH` sets it (`createAuth`, `advanced.defaultCookieAttributes`). The value must start with `/`, must not end with `/`, must not contain `..`, may hold only letters, digits and `/ . _ ~ -`, and no segment may be empty or start with a dot (`STAFF_BASE_PATH` in `EnvSchema`, `apps/api/src/config/env.ts`). A bad value stops the process at startup with `Invalid environment`.

### 9.2 The path prefix: when it breaks

Today `deploy/Caddyfile` has no path prefix rule. It sends `/api/*` to the api and everything else to the web app. So leave `STAFF_BASE_PATH` empty until feature 26 adds the rule.

**Symptom:** the person is signed out at once after sign in, and `STAFF_BASE_PATH` is set. **Cause:** `STAFF_BASE_PATH` does not match the prefix Caddy serves. **Fix:** make the two match, or clear `STAFF_BASE_PATH` and follow section 9.3.

### 9.3 Changing `STAFF_BASE_PATH` on a live install

`STAFF_BASE_PATH` sets the `Path` of every sign in cookie. After it changes (for example from empty to `/ops`), each browser still holds its old session cookie on the wider path (`Path=/`). The browser sends both cookies, and the api reads the old one. So a person either acts in an older session (on a shared terminal, possibly someone else's), or is signed out again right after signing in, until the old cookie expires. Signing out clears only the new path.

So a change of `STAFF_BASE_PATH` on a live install always comes with these steps:

1. Set the new value in `.env`, and make the matching prefix work in Caddy. Caddy has no prefix rule yet (section 9.2).
2. Restart the stack: `docker compose --env-file .env up -d`
3. Revoke every session, and every sign in waiting for a two factor code, as the owner role:

   ```bash
   docker compose --env-file .env exec postgres psql -U ssdashboard -d ssdashboard -c "DELETE FROM sessions" -c "DELETE FROM verifications WHERE identifier LIKE '2fa-%'"
   ```

   Everyone is signed out. Reset and invite links keep working.
4. Ask every staff member to clear this site's cookies in their browser (or to sign in from a private window once), then sign in again.

Pick the value before go live where you can. An install that never changes it never needs these steps.

### 9.4 The portal host

- `PORTAL_ORIGIN` is the portal's address, for example `https://shop.example.com`. It must have a different host name from `PUBLIC_URL`. A different port is not enough, because cookies ignore the port (the `superRefine` of `EnvSchema` in `apps/api/src/config/env.ts`).
- When it is set, the api answers 404 to every `/api/auth/*` request that carries the portal host. The api reads `X-Forwarded-Host` and `Host` (`mountAuth` in `apps/api/src/identity/sign-in/mount-auth.ts`, and `isPortalRequest` in `portal-host.ts`).
- **The portal host must never show a sign in page.** Keeping the web sign in pages off the portal host is Caddy's job, and that work is feature 26. Today `deploy/Caddyfile` serves one site and has no portal site. It also does not set `X-Forwarded-Host`, so feature 26 must confirm what Caddy sends when it adds the portal site.
- If a portal host ever shows a sign in page, report it. Do not add a Caddy rule by hand.

## 10. Rotating `BETTER_AUTH_SECRET`

`BETTER_AUTH_SECRET` signs sessions, and it encrypts every two factor secret and backup code. Rotating it does two things:

- It signs everyone out.
- It makes every enrolled two factor secret and every backup code unreadable.

Do not rotate it to get around a lost second factor. Rotate it only if one of these is true:

- No account has two factor on.
- A second active admin who has two factor off can sign in. That admin resets the other accounts' two factor from the staff page.

If the secret is rotated while two factor is on, each admin with two factor on needs the two factor reset in section 2.2, once, for their own email. The reset refuses for an account that is not an admin. So an admin resets those accounts from the staff page, after signing in again. The reset deletes the unreadable rows without decrypting them (`breakGlassReset` in `apps/api/src/identity/sign-in/reset-admin.ts`, the two factor branch).

## 11. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `The email or password is not right. Check both and try again.` with the right password | The email is locked (from this address, or from any address), or the password is wrong | Wait 15 minutes, or have an admin reset the password (section 4) |
| `Too many attempts. Wait a minute, then try again.` (429) | More than 30 sign in attempts per minute from one IP | Wait a minute |
| Sent back to sign in, session ended (401 `SESSION_EXPIRED`) | Idle for 12 hours, 7 days since sign in, or signed out, disabled or revoked | Sign in again |
| Opens the Change your password screen | The must change flag is set (first admin, temporary password, reset) | Choose a new password |
| `This account is disabled. Ask an administrator for help.` (403 `BANNED_USER`) | The account is disabled | An admin enables it on the staff page |
| `This link is no longer valid` | The link was used, expired (1 hour for a reset, 7 days for an invite), or a newer link replaced it | Ask for a new link. For an invite, an admin sends a new one |
| The forgot password page says to ask an administrator | `MAIL_DRIVER=none` | An admin resets the password (section 2.1 or 2.3). Or set `MAIL_DRIVER` to `smtp` or `postmark`, and restart (section 6) |
| `create-admin` prints `An active admin already exists. ...` | The first admin was already created | Sign in as that admin. For a locked out admin, use section 2.1 |
| `create-admin` prints `... already belongs to an account.` | The email is taken | Use another email. If it is an admin, use section 2.1 |
| `create-admin failed: 42704` (or another code), or `create-admin failed: database error` | `42704` is the code for a missing `ssd.tenant_id` setting (section 1.4). Other codes are other database errors | Check `ssd.tenant_id` as section 1.4 says. If the setting is there, report the code |
| `--reset-password` prints `... is not an admin` | The account is staff | An admin resets it from the staff page (section 2.3) |
| `--reset-password` or `--reset-two-factor` prints `... is disabled` | The account is disabled | Enable it first |
| `No account has the email <email>.` | The email is mistyped, or no account has it | Check the spelling |
| The process stops at startup with `Invalid environment` | A required or invalid setting | Fix the setting named in the message in `.env`, then restart |
| The reset email never arrives | Mail is off, or sending is failing | Check `mailEnabled` in `GET /api/config`. In the worker log, look for `will retry` or `failed for good` |
| Two factor code refused after `BETTER_AUTH_SECRET` changed | Rotating the secret made every two factor secret and backup code unreadable | Section 10. Each affected admin runs `--reset-two-factor` for their email (section 2.2) |
| Two factor code refused after a lock | A lock ends the sign in that was waiting for a code | Start again from the password |
| Lost authenticator app and no backup codes | The authenticator and every backup code are gone | Another admin resets two factor from the staff page. A sole admin runs `--reset-two-factor` (section 2.2) |
| `--reset-two-factor` exits with code 1 | No account, not an admin, or disabled | For a staff account, an admin resets two factor from the staff page. For a disabled account, enable it first. Check the email spelling |
| A reset run prints the usage and exits with code 1 | `--name` was given with a reset flag, or `--email` is missing | Run it again with `--email <email>` and no `--name` |
| Signed out right after sign in, with `STAFF_BASE_PATH` set | The prefix does not match the one Caddy serves | Section 9.2 |
| A sign in page shows on the portal host | Feature 26 is not done | Report it (section 9.4) |
| A `Set-Cookie` header with `Domain` | This must never happen | Stop and report it (section 9.1) |
