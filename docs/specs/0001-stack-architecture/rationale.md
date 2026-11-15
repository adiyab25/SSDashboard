# 0001. Stack & architecture: rationale

Decision record for [index.md](index.md). `/develop` builds from the index. This file explains why.

## Context

SSDashboard is a warehouse and ERP system for an ecommerce business with thousands to 100,000+ SKUs, several warehouses and showrooms, suppliers and factories (both owned production and contract manufacturing), and sales through marketplaces, an existing ecommerce platform, showroom POS, and later its own storefront. It starts with one client. Other clients will want their own customized version later. Full accounting is out of scope (a separate app), but every transaction must carry cost and price.

The forces: a team of 1 to 3 developers; installs that must run both in a cloud you manage and on a client's own servers, including servers with no internet access; clients that pin their own version and upgrade on their own schedule; an interface in English and Arabic (right to left) from day one; stock that must never be wrong under concurrent scans, sales, and syncs; and heavy back office screens (large grids, bulk imports) plus phone and handheld scanning. This decision covers the back office and scanning. POS and the storefront come later.

Not deciding means every early feature would invent its own tooling. Getting it wrong is expensive in two specific ways: a stack that needs many services makes every on premises install and every version upgrade harder, and a stack without strong transactions puts stock accuracy at risk.

## Options considered

### Option 1: TypeScript modular monolith (NestJS + Next.js + PostgreSQL), one container set per client

One TypeScript monorepo: a NestJS api and worker, a Next.js back office, and shared Zod contracts, on PostgreSQL with a queue stored in PostgreSQL, object storage, and Caddy. It ships as Docker images with one Compose stack per client.

**Pros**:
- One language across the whole system, with shared types and validation.
- NestJS modules give the monolith enforceable internal boundaries.
- Few services per install (PostgreSQL does transactions, jobs, search, and JSON fields).
- The same packaging works in the cloud and on premises.

**Cons**:
- Two app servers (Next.js and NestJS) for an app that is all behind login.
- The Node.js ecosystem churns quickly, so dependencies need regular upkeep across pinned versions.

### Option 2: Python Django monolith with a React frontend

Django with its ORM, admin, and migrations, a separate React app, and PostgreSQL. A well trodden path for ERPs.

**Pros**:
- Mature ORM, migrations, and a free admin UI for internal data screens.
- A long record in ERP style systems.

**Cons**:
- Two languages for a 1 to 3 person team, and no shared types between frontend and backend.
- Async jobs need Celery and Redis, adding a service to every on premises install.

### Option 3: C# ASP.NET Core with a React frontend

ASP.NET Core with Entity Framework Core and PostgreSQL or SQL Server, plus a React frontend.

**Pros**:
- Excellent performance and very strong typing.
- Familiar to enterprise and on premises IT teams.

**Cons**:
- Two languages and two toolchains for a small team.
- Pulls toward SQL Server and Windows hosting, which adds licence cost per client.

### Option 4: Backend as a service platform

A hosted platform providing the database, auth, storage, and generated APIs, with business logic in database functions or edge functions.

**Pros**:
- The fastest start, with auth and storage out of the box.

**Cons**:
- On premises installs mean self hosting the whole platform, which is heavy.
- Complex stock ledger, reservation, and costing logic fits poorly in database policies and short lived functions.

## Rationale

The deciding forces are the small team and the dual hosting model. A single language with shared Zod contracts cuts the team's surface area roughly in half compared with Options 2 and 3. Keeping PostgreSQL as the one stateful service (transactions, job queue, search, custom fields) means an on premises install is a handful of containers that a client's IT team can run. Option 4 fails the on premises requirement outright. Option 2 is the strongest alternative for ERP maturity, but its two languages and extra job broker cost more than its admin UI saves.

A modular monolith rather than services follows from team size: with 1 to 3 developers, each extra deployable multiplies the work of every client install and every version upgrade. NestJS modules plus the rule that modules never read each other's tables give the boundaries that make a later split possible without paying for it now. Stock correctness depends on PostgreSQL transactions and row locks, and Drizzle keeps those queries explicit rather than hidden behind ORM behavior.

On the frontend, the recommended pick was a plain React single page app, because the whole back office sits behind login and gains little from server rendering. The engineer chose Next.js. That works well: it is a mature React framework, it runs in Docker as a standalone server, and it gives a path to share code with the future storefront, where server rendering and SEO do matter. The cost to accept consciously is a second app server per install. The way to keep that cost low is to use Next.js mostly for routing and client components, keep business logic in the NestJS api, and never put stock or pricing logic in Next.js server code.

The engineer also chose pinned versions per client over one shared release line. That fits clients who need controlled upgrades, but it is the biggest ongoing cost in this design. The expand and contract migration rule, the "latest plus previous minor" support window, and the CI upgrade test exist to keep it manageable.

### Cross check (independent model review)

A fresh model reviewed the first draft and found the stack sound but 13 scaffold decisions unsettled: the migration runner, the image and version model, runtime config versus the Next.js build, the auth path and cookies, extension loading, the contract toolchain, secrets, PostgreSQL setup, and offline installs. The engineer accepted the recommended fix for each, and they are now in `index.md` (Architecture shape). The review also noted that a static frontend served by Caddy would remove the `web` container. That was considered and set aside, because Next.js was chosen knowingly.

### Update, 2026-11-03: two database roles and per service env lists

The data model (spec 0002) split the database into an owner role and an application role, so the append only ledger holds even against a bug in the api. Its fresh model review (private `docs/reviews/2026-11-03-feat-data-model.md`) then found that every service loaded the whole `.env` with `env_file`, which put the owner password inside the api and worker and undid the split. The fix, already shipped in `deploy/compose.yaml`, gives each service an explicit env list. This spec's configuration section described the old `env_file` setup, so it now records the two roles, the list each service receives, the owner privileges a managed database needs, and how to rotate each secret. Nothing about the stack itself changed.
