# Staff sign in run book

For the person who runs a client install (`deploy/`). Covers the first admin, break glass recovery, lockouts, mail, the nightly cleanup, changing the staff base path, and common symptoms. Spec: [0005](../specs/0005-staff-sign-in/index.md).

Run every command from the `deploy/` folder, with the install's `.env` in place.

## 1. Create the first admin

1. Run `./bootstrap.sh` once. It writes `.env` with fresh secrets. Then set `CLIENT_ID`, `SSD_VERSION`, `SITE_ADDRESS` and `PUBLIC_URL`.
2. Start the stack: `docker compose --env-file .env up -d`
3. Check the Docker log driver. Do this on the same host, before step 4:

   ```bash
   docker info --format '{{.LoggingDriver}}'
   ```

   It must print `json-file` or `local`. Any other value (for example `journald`, `syslog`, `fluentd` or `awslogs`) means the daemon keeps or ships container output, so the temporary password would be stored or sent to that log. Do not run step 4 on that host. Use a host with a local driver instead. The daemon default is set in `/etc/docker/daemon.json` on a Linux host. `deploy/compose.yaml` sets no `logging:` key, so the daemon default applies to `api`.

4. Create the admin:

   ```bash
   docker compose --env-file .env run --rm api node dist/create-admin.js --email <email> --name <name>
   ```

   The `--rm` flag removes the container when the command ends. With the `json-file` driver, its log goes with it.

5. The output shows a temporary password once: `Temporary password (shown once, change it at first sign in): <password>`. Give it to the admin in person or in a password manager. Do not write it down anywhere else.
6. The admin signs in at `PUBLIC_URL/sign-in`. The app opens the Change your password screen first. Choose a new password. It needs 8 to 128 characters, with a lowercase letter, an uppercase letter and a digit.

The command refuses, exits with code 1 and changes nothing when an active admin already exists, or when the email already belongs to an account.

### Recommended setup

Create a second admin right after the first one signs in and changes the password:

- On the staff page, choose Add staff, set Role to Administrator, and hand over the temporary password under the same rules as step 5 above.
- Each admin turns on two factor (account page, Turn on) and stores the 10 backup codes offline. The codes are shown once, when two factor is turned on or when new codes are made.

With two admins, a lost authenticator never leaves the install without a working admin. A sole admin who loses the authenticator and every backup code uses the two factor reset in section 2.

## 2. Break glass: reset a sole admin's password or two factor

### Reset the password

Use this when mail is off (`MAIL_DRIVER=none`), and the only active admin cannot sign in because the password is lost or the account is locked. With mail on, the admin can use the forgot password link instead. That link also clears the lock.

```bash
docker compose --env-file .env run --rm api node dist/create-admin.js --reset-password --email <email>
```

What it does:

- Sets a new temporary password. It is shown once.
- Clears the lockout for that email.
- Ends every session for that account, and deletes its older reset and invite links.
- Ends any sign in that is waiting for a two factor code.
- Sets the must change flag. The old password stops working at once, and the admin must choose a new one at next sign in.
- Writes one audit line to stderr, with the event `auth.admin_break_glass_reset`, the user id and the time. It holds no password and no email.

It refuses, exits with code 1 and changes nothing when:

- The email has no account: `No account has the email <email>.`
- The account is not an admin: ask an admin to reset that password from the staff page.
- The account is disabled: enable it first.

It does not reset two factor. If the admin also lost the authenticator app, they need one of these:

- A backup code. At the two factor step, choose Use a backup code instead.
- Another active admin resets their two factor from the staff page (row menu, Reset two factor). This also ends their sessions.

If neither is possible, use the two factor reset below.

### Reset two factor

Use this when an admin has lost the authenticator app and every backup code. It applies to a sole admin, and to each admin after a `BETTER_AUTH_SECRET` rotation. Run it from a shell on the server. It is never offered over HTTP, by email or on any screen.

```bash
docker compose --env-file .env run --rm api node dist/create-admin.js --reset-two-factor --email <email>
```

What it does:

- Turns two factor off for that account and deletes its stored two factor setup.
- Ends every session for that account.
- Ends any sign in that is waiting for a two factor code.
- Clears the lockout for that email. This includes a lock built up by wrong codes.
- Keeps the password. It does not set the must change flag, so the admin signs in with the same password.
- Prints a confirmation with the email. It prints no password.
- Writes one audit line to stderr, with the event `auth.admin_break_glass_two_factor_reset`, the user id and the time. It holds no email, code, secret or password.

It refuses, exits with code 1 and changes nothing when:

- The email has no account.
- The account is not an admin. An admin resets that person's two factor from the staff page.
- The account is disabled. Enable it first.

If two factor is already off, the command still succeeds and changes nothing else. A repeated run is safe.

After the run, the admin signs in with the password and turns two factor on again from the account page (Turn on). They store the new backup codes offline.

### Lost password and two factor

For a sole admin who is fully locked out, with the password and the authenticator both lost, run both reset flags in one command:

```bash
docker compose --env-file .env run --rm api node dist/create-admin.js --reset-password --reset-two-factor --email <email>
```

Both changes happen in one transaction. Either both apply or neither does. The command prints one temporary password, and each mode writes its own audit line to stderr. Follow section 3 for this output, because it holds a live password. The admin signs in with the temporary password, chooses a new one, and then turns two factor on again.

Do not add `--name` to a reset run. With a reset flag, `--name` prints the usage and exits with code 1.

**Do not rotate `BETTER_AUTH_SECRET` to get around this.** Rotating it makes every enrolled two factor secret and every backup code unreadable, and it signs everyone out. Rotate it only if one of these is true:

- No account has two factor on.
- A second active admin who has two factor off can sign in. That admin resets the other accounts' two factor from the staff page.

If the secret is rotated while two factor is on, each admin with two factor on needs the two factor reset above, once, for their own email. The reset refuses for an account that is not an admin, so an admin resets those accounts from the staff page after signing in again.

## 3. Do not capture the output

The `create-admin` output contains a live temporary password whenever it resets a password (`--reset-password`, and the combined run). Keep it out of every log:

- Run the command in a local terminal on the server.
- Do not pipe or save it: no `| tee`, no `> file`, no `script`.
- Do not run it from CI, a scheduled job or a remote session that records output.
- Do not send container output to a remote or persistent log driver (journald, syslog, fluentd, awslogs). Check the daemon default first, with `docker info --format '{{.LoggingDriver}}'` (section 1, step 3). `deploy/compose.yaml` sets no `logging:` key for `api`. Keep it that way.
- Do not paste the password into chat, a ticket or an email.

The command prints the password to its standard output, and the app never logs it. Under `docker compose run`, that output still goes through the container's log driver. That is why step 3 of section 1 checks the driver first.

## 4. Lockouts and abuse

Limits (from `apps/api/src/identity/sign-in/sign-in-lockout.ts`):

| Rule | Limit | Lock |
|---|---|---|
| One email from one client IP | 5 failures within 10 minutes | That pair is locked for 15 minutes |
| One email from any IP | 20 failures within 10 minutes | That email is locked for 15 minutes, for everyone |

- The email is compared trimmed and lowercased.
- Failures count: a wrong password, an unknown email, a wrong two factor code, and a wrong current password on change password or two factor disable.
- During a lock, every attempt gets the same answer as a wrong password (`The email or password is not right`), even the correct one. Locked attempts are refused before they are counted, so they do not extend the lock.
- A full sign in clears the counters.
- Per IP, sign in is also limited to 30 attempts per minute. Going over returns 429 with an `X-Retry-After` header. A shift change can hit this. Wait a minute.

**Abuse:** anyone who knows a staff email can lock that person out for 15 minutes by sending 20 wrong passwords from any addresses. A patient attacker can repeat this every 15 minutes. The per IP limit does not stop this. Look for `AccountLocked` and `SignInFailed` lines in the api log to spot it.

How to clear a lock:

1. Wait 15 minutes from when it started. Nothing else is needed.
2. Another active admin resets that person's password from the staff page. This clears the lock, but it also changes the password.
3. Break glass for a sole admin (section 2).

**On premises behind the client's TLS proxy:** with `SITE_ADDRESS=:80`, Caddy treats the proxy's own address as the client, so every user shares one IP and the per IP lockout and rate limits apply to the whole install. Set `TRUSTED_PROXIES` in `.env` to the proxy's address (for example `10.0.0.5/32`, several separated by spaces) so Caddy reads the real client address from the proxy's `X-Forwarded-For`. Caddy reads that header from the right, ignores anything a user forged on the left, and always passes the api exactly one address. Never set it to a wide range such as `0.0.0.0/0`, because anyone could then fake their IP. Leave it empty when Caddy faces users directly.

## 5. Mail on or off

`MAIL_DRIVER` is `none` (default), `smtp` or `postmark`. The api and worker read it at startup, so restart both after a change.

- **`none`:** no email is sent. `GET /api/config` reports `mailEnabled: false`. The forgot password page says to ask an administrator. Creating a person or resetting a password shows a temporary password once. Resending an invite is refused.
- **`smtp`:** needs `MAIL_FROM` and `SMTP_HOST`. `SMTP_USER` and `SMTP_PASSWORD` go together or both stay empty.
- **`postmark`:** needs `MAIL_FROM` and `POSTMARK_SERVER_TOKEN`. The sender must be verified in Postmark before the first send.
- With mail on, a reset link is valid for 1 hour and works once. An invite link is valid for 7 days.
- The worker tries each email up to 5 times. A failure logs `Mail job <id> failed (try N), will retry` with no link.
- A missing required setting stops the process at startup with `Invalid environment`, and names the setting.

## 6. Nightly cleanup

- Schedule: `AUTH_CLEANUP_CRON`. Default `0 3 * * *` (03:00 every day). It is set in `deploy/compose.yaml` and `apps/api/src/config/env.ts`.
- Timezone: the `timezone` setting. The first migration seeds `Africa/Cairo`. The worker reads it at startup, so restart the worker after a change.
- Deletes:
  - sessions past `expires_at`
  - reset and invite tokens past `expires_at`
  - sign in counters whose lock has ended and whose window is over
  - rate limit counters whose last request is more than 1 day old
- Keeps live sessions, live tokens and counters still in use.
- Logs one line from the worker: `Removed <n> sessions, <n> tokens, <n> sign in counters, <n> rate limit counters.`
- A malformed cron value (not five valid fields) stops the api and the worker at startup with `Invalid environment`, naming the setting.

## 7. Changing STAFF_BASE_PATH on a live install

`STAFF_BASE_PATH` sets the `Path` of every sign in cookie. After it changes (for example from empty to `/ops`), each browser still holds its old session cookie on the wider path (`Path=/`). The browser sends both cookies, and the api reads the old one, so a person either acts in an older session (on a shared terminal, possibly someone else's) or is signed out again right after signing in, until the old cookie expires. Signing out clears only the new path.

So a change of `STAFF_BASE_PATH` on a live install always comes with these steps:

1. Set the new value in `.env`, and the matching prefix in Caddy.
2. Restart the stack: `docker compose --env-file .env up -d`
3. Revoke every session, and every sign in waiting for a two factor code, as the owner role:

   ```bash
   docker compose --env-file .env exec postgres psql -U ssdashboard -d ssdashboard -c "DELETE FROM sessions" -c "DELETE FROM verifications WHERE identifier LIKE '2fa-%'"
   ```

   Everyone is signed out. Reset and invite links keep working.
4. Ask every staff member to clear this site's cookies in their browser (or sign in from a private window once), then sign in again.

Pick the value before go live where you can: an install that never changes it never needs this.

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Correct password says "The email or password is not right" | The email is locked (from this address, or from anywhere), or the password is wrong | Wait 15 minutes, or have an admin reset the password (section 4) |
| Sign in returns "Too many attempts. Wait a minute" (429) | More than 30 sign in attempts per minute from one IP | Wait a minute |
| "Your session has ended" (401 `SESSION_EXPIRED`) | Idle for 12 hours, 7 days since sign in, or signed out, disabled or revoked | Sign in again |
| Opens the Change your password screen | The must change flag is set (first admin, temporary password, reset) | Choose a new password |
| 403 `BANNED_USER`, "This account is disabled. Ask an administrator for help." | The account is disabled | An admin enables it on the staff page |
| "This link is no longer valid" | The link was used, expired after 1 hour, or a newer link replaced it | Request a new link |
| Forgot password page says to ask an administrator | `MAIL_DRIVER=none` | An admin resets the password, or set `MAIL_DRIVER` to `smtp` or `postmark` and restart |
| `create-admin` prints `An active admin already exists` | The first admin was already created | Sign in as that admin. For a locked out admin use `--reset-password` |
| `create-admin` prints `... already belongs to an account` | The email is taken | Use another email. If it is an admin, use `--reset-password` |
| `--reset-password` prints `... is not an admin` | The account is staff | An admin resets it from the staff page |
| `--reset-password` prints `... is disabled` | The account is disabled | Enable it first |
| Process stops at startup with `Invalid environment` | A required or invalid setting | Fix the setting named in the message in `.env`, then restart |
| Reset email never arrives | Mail is off, or sending is failing | Check `mailEnabled` in `GET /api/config`. In the worker log, look for `will retry` or a final failure |
| Two factor code is refused after `BETTER_AUTH_SECRET` changed | Rotating the secret makes every enrolled two factor secret and every backup code unreadable, and signs everyone out | Do not rotate it without the conditions in section 2. If it was rotated, each affected admin runs `--reset-two-factor` for their email (section 2). If a second admin with two factor off can sign in, that admin can also reset each affected person's two factor from the staff page |
| Two factor code is refused after a lock | A lock ends the sign in that was waiting for a code | Start again from the password |
| Lost authenticator app and no backup codes | The authenticator and every backup code are gone | Another admin resets two factor from the staff page. A sole admin runs `--reset-two-factor` (section 2) |
| `--reset-two-factor` exits with code 1 | The email has no account, the account is not an admin, or it is disabled | For a staff account, an admin resets two factor from the staff page. For a disabled account, enable it first. Check the email spelling |
| A reset run prints the usage and exits with code 1 | `--name` was given with a reset flag, or `--email` is missing | Run it again with `--email <email>` and no `--name` |
