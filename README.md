# SSDashboard

The order operations and warehouse back office for Egyptian clothing brands: it sits behind Shopify, Bosta cash on delivery, and consignment showroom partners, confirms every order, runs exchanges and refunds, and reconciles every piaster. Built as one shared core deployed per brand.

- Product scope: [docs/scope/index.md](docs/scope/index.md)
- Stack decision: [docs/specs/0007-stack-architecture-operations-layer/index.md](docs/specs/0007-stack-architecture-operations-layer/index.md)
- Staff sign in run book (first admin, break glass reset, lockouts): [docs/runbooks/staff-sign-in.md](docs/runbooks/staff-sign-in.md)

Status: the wave 3 scaffold (spec 0007, Shape A: keep and amend) is in, and the foundation specs come next (the rebuild plan (private), [scope](docs/scope/index.md)). The code from the earlier build is kept and amended feature by feature.

## Run locally

The database, object storage, and a mail catcher run in Docker; the api, worker, and web run on your machine for a fast edit loop.

**Prerequisites**

- Node 26 (the version in [`.nvmrc`](.nvmrc))
- pnpm, through corepack: `corepack enable`
- Docker Desktop (or any Docker with Compose v2), running

**Set up and start**

```bash
pnpm install && pnpm bootstrap
pnpm dev
```

`pnpm bootstrap` is safe to run again. It creates `.env` from [`.env.example`](.env.example) with fresh secrets (an existing `.env` is kept, and only missing variables are added), starts PostgreSQL, Garage, and Mailpit, creates the Garage bucket and access key, and applies the database migrations. The script is [`deploy/dev-bootstrap.mjs`](deploy/dev-bootstrap.mjs).

Once, after the baseline reset ([ADR 0003](docs/adr/0003-reset-migrations-to-one-baseline.md)): recreate your dev database, because the migration history was replaced by one baseline. `pnpm bootstrap` stops with this instruction when it finds a database migrated by the old history.

```bash
docker compose -f deploy/compose.dev.yaml down -v
pnpm bootstrap
```

Warning: `down -v` removes every database in the shared dev volume, so other checkouts on the same server lose theirs too. To start over for one checkout only, drop and recreate just its own database.

**What runs where**

| What                      | Address                 | Notes                                           |
| ------------------------- | ----------------------- | ----------------------------------------------- |
| Back office (web)         | http://localhost:3000   | `pnpm dev`                                      |
| Api and worker            | http://localhost:3001   | `pnpm dev`                                      |
| PostgreSQL 18             | `localhost:5433`        | Docker; 5433 so it never meets a local 5432     |
| Garage (S3 compatible)    | http://localhost:3900   | Docker; bucket `ssdashboard-dev`, keys in `.env` |
| Mailpit (mail catcher)    | http://localhost:8025   | Docker; SMTP on `localhost:1025`                |

- **See email**: open the Mailpit page. Every email the apps send (with `MAIL_DRIVER=smtp`, set by `.env.example`) lands there and nothing leaves your machine.
- **See files**: Garage speaks S3 at `S3_ENDPOINT` with `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` from `.env`, path style. Any S3 client works. Its admin tool runs in the container: `docker compose -f deploy/compose.dev.yaml exec garage /garage bucket list`. The api does not use object storage yet.
- **Database roles**: local runs use the same two roles as production (`ssdashboard` owner for migrations, `ssdashboard_app` for the api), so permission errors show up locally. Per client role names come with a later feature.
- **Reset everything**: `docker compose -f deploy/compose.dev.yaml down -v` deletes the database, Garage, and Mailpit data. Then run `pnpm bootstrap` again; it creates a new Garage key and writes it to `.env`, so first empty the two `S3_*` key values there.
- **Stop, keeping data**: `docker compose -f deploy/compose.dev.yaml down`.

**Troubleshooting**

- *Port 3000 is taken* (often another project's container): stop what holds it, or run the web on another port and set `PUBLIC_URL` in `.env` to match. Ports 3001, 5433, 3900, 1025, and 8025 must also be free.
- *`docker compose` fails or cannot connect*: start Docker Desktop and wait until it says it is running.
- *`pnpm bootstrap` stops at migrations*: run `pnpm install` first, then bootstrap again.

## License

SSDashboard is licensed under the Business Source License 1.1, see [LICENSE](LICENSE). The Licensor is adiyab25. Non-production use is allowed. Production use needs a commercial license from the Licensor, because the Additional Use Grant is None. The Change Date is 2030-11-15. On that date, or four years after a version is first published if that comes first, the version moves to the Apache License, Version 2.0.
