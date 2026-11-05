# Slice 2: consignment partners and the accounting handoff

Showroom partners hold your stock and report sales their own way; your accountant needs the exact workbook they import today. This slice reuses the settlement primitive and period close from slice 1a for both. [Back to the scope](index.md).

### 40. Channel code mapping · GA · needs a decision
Every partner and channel names products its own way. Map their codes and texts to your variants, with suggestions, an impact preview, and undo.
**Done when:** per channel, codes and product texts map to a variant; suggestions are staged with confidence and evidence; a mapping queue offers bulk confirm, pick another, and not a product; every edit shows how many lines and how much money it moves before it applies, is audited, and can be undone; unmapped lines show as a count on the navigation and never reach a settlement or an export; only exact matches map automatically.
- [ ] Design it (spec): `/architect channel code mapping`

### 41. Consignment partners & handover · GA · needs a decision
Partners as locations you still own stock at, and the handover that puts it there.
**Done when:** a partner is a location with the consignment owner type; a handover is a transfer with a consignment note (pieces, consignment prices, date); partner stock shows per partner and is never offered online; fulfilling an online order from partner stock means a logged transfer back to the warehouse first.
- [ ] Design it (spec): `/architect consignment partners & handover`

### 42. Partner sales ingestion · GA · needs a decision
Sell through arrives the way each partner can deliver it: a standard statement file, an upload page with the partner's own login, an API adapter, or a count by difference.
**Done when:** each channel records its type and cadence; each import is a day level batch that previews before it applies; a partner can declare a "no sales" day; batches stay provisional until confirmed; a coverage grid shows which days each partner has reported; statement, count, and the partner's own total reconcile against each other with disagreements as line items; partner codes go through channel code mapping first.
- [ ] Design it (spec): `/architect partner sales ingestion`

### 43. Partner settlement · GA · needs a decision
The settlement primitive with its second owner: per period, what the partner owes for what sold through.
**Done when:** sold pieces at consignment price become what the partner owes; missing pieces are charged per agreement; defective returns are credited to the partner and written off at cost; payment closes the period with evidence; the account reconciles with unmatched lines listed.
- [ ] Design it (spec): `/architect partner settlement`

### 44. Tax authority documents · GA · needs a decision
Design the Egyptian Tax Authority integration around the primary document for a consignment brand: the B2B electronic invoice to the partner at settlement.
**Done when:** the spec records the current thresholds and phases, item code needs (GS1 or EGS), and the signing approach; a B2B electronic invoice can be issued from a partner settlement against the authority's test environment on recorded fixtures.
- [ ] Design it (spec): `/architect tax authority documents`

### 45. Export engine · GA · needs a decision
The accounting handoff as a templated export per client, reproducing the workbook or file their accountant imports today, exactly.
**Done when:** a rules matrix (channel, product group, kind, and the client's own codes) produces the client's format; each export is a versioned immutable record with a "mark imported" step; a preflight lists blockers (unmapped lines, missing codes, unconfirmed days) and warnings (overlap with an earlier export); a fixture based freeze test guards the format across releases; it carries sales, returns, exchanges, credits, refunds, carrier fees, remittances, and partner invoices.
- [ ] Design it (spec): `/architect export engine`

### 46. Sell through report · needs a decision
Sell through per partner, product, and size, to decide what to send where next.
**Done when:** the report shows given, sold, returned, and on hand per partner, product, and size over a chosen period, from confirmed data only, with provisional days marked.
- [ ] Design it (spec): `/architect sell through report`

### 47. Client provisioning · GA · needs a decision
Bring up a new brand's stack, hosted by us, without hand work: its database, settings, subdomain, backups, and first admin.
**Done when:** one documented command provisions a new brand on a shared host, the result passes the same health checks as a hand built stack, and teardown is just as scripted. (basis: final plan section 10 moves provisioning up for vendor hosting; placed before the second brand, since the first is set up by hand)
- [ ] Design it (spec): `/architect client provisioning`
