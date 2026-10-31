# Epic: Platform

Cross cutting capabilities: access, audit, data in and out, operations, alerts, reporting, and multi client tooling. Back to [index](index.md).

## Slice 2: Go live essentials

### 13. Roles & permissions · needs a decision · GA
Access by role (warehouse, showroom, buyer, accountant, manager, admin), scoped to specific locations.
**Done when:** an admin can assign roles per location; a user only sees and changes what their role allows, enforced on the server, not just hidden in the UI; denied actions show a clear message.
- [ ] Design it (spec): `/architect roles & permissions`

### 14. Audit trail · needs a decision
Who changed what and when, for every record that matters.
**Done when:** creating, editing, approving, or deleting key records writes an audit entry with user, time, and before and after values; managers can filter the trail by record, user, and date.
- [ ] Design it (spec): `/architect audit trail`

### 15. Bulk import & export · needs a decision
Load tens of thousands of SKUs, suppliers, and opening stock from spreadsheets for go live, and export any list.
**Done when:** a 100,000 row import runs in the background with progress, validates every row, reports errors per row without importing a broken file halfway, and opening stock posts as ledger movements; any filtered list exports to a spreadsheet.
- [ ] Design it (spec): `/architect bulk import & export`

### 16. Deployment, backups & monitoring · needs a decision
Run the first client's install safely in production.
**Done when:** the app deploys repeatably to production; the database is backed up automatically and a restore has been tested; errors and downtime alert the team.
- [ ] Design it (spec): `/architect deployment, backups & monitoring`

## Slice 4: Purchasing (platform pieces)

### 23. Alerts & notifications · needs a decision
In app and email alerts for low stock, late supplier deliveries, expiring lots, and approvals waiting.
**Done when:** users get alerts for the events their role cares about, can mark them read, and can choose in app or email per type.
- [ ] Design it (spec): `/architect alerts & notifications`

### 25. Ops dashboard & reports · needs a decision
One home screen with stock levels, stock value, slow movers, and supplier performance, growing as modules land.
**Done when:** the dashboard loads fast at full data size, every number links to the list behind it, and each report can be filtered by location and date and exported.
- [ ] Design it (spec): `/architect ops dashboard & reports`

## Slice 9: Multi client platform

### 46. Client settings & module toggles · needs a decision
Per client configuration: branding, languages, tax settings, numbering, and which modules (production, POS, storefront, accounting) are switched on.
**Done when:** turning a module off hides it everywhere and blocks its API; settings change behavior without code changes; the shared core updates without overwriting a client's settings.
- [ ] Design it (spec): `/architect client settings & module toggles`

### 47. New client provisioning · needs a decision
Stand up a new client's own install and database from the shared core in a repeatable way.
**Done when:** a new client install can be created, seeded with defaults, and upgraded alongside the others with one documented process; each client's data stays fully separate.
- [ ] Design it (spec): `/architect new client provisioning`

### 48. Public API & webhooks · needs a decision · GA
A documented API and event webhooks so other systems and client specific add ons can read and write data without changing the core.
**Done when:** API keys are scoped by permission and can be revoked; core records are readable and writable through the API; webhooks fire for stock, order, and purchase events with retries and signatures.
- [ ] Design it (spec): `/architect public API & webhooks`
