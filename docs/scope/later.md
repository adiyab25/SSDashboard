# Later and parked

Kept so the plan stays honest. Nothing here is built in the current pass. [Back to the scope](index.md).

## Later, per client, by toggle

Each becomes a numbered feature through `/scope <feature>` when a client needs it.

- **Own shop point of sale**: electronic receipts, Arabic thermal printing, end of day close; only for a client with own shops · needs a decision · GA
- **Wholesale customers & price lists**: handover as a sale at the wholesale price list, B2B electronic invoice at handover · needs a decision · GA
- **Own storefront as a channel**: grows from the COD landing page (feature 53); reword "failed payments never create an order" for cash on delivery · needs a decision · GA
- **WooCommerce connector**: a second store platform on the Shopify connector's pattern · needs a decision · GA
- **Second carrier**: Mylerz, Aramex, J&T, or ShipBlu, with returned to origin compared per carrier · needs a decision · GA
- **Allocation planning across partners**: what to hand to which showroom, from sell through · needs a decision
- **Console importer**: bring months of real orders, shipments, cases, and mappings from a brand's own console database · needs a decision · GA
- **Public API & webhooks** · needs a decision · GA
- **Multiple currencies for sales**: costs in dollars and yuan already land in EGP through landed cost · needs a decision · GA
- **Offline point of sale**: only if an own shop client appears · needs a decision

## Parked

Chosen not to build. A parked item comes back only through a new positioning decision.

- Lots, batches, and expiry
- Serial numbers
- Full versioned bills of materials (a production run record replaces them)
- Marketplace sync
- Customer accounts (the portal identifies by phone plus order id)
- Card checkout on an own storefront
- Chat inbox (we integrate with messaging, we do not become it)
- Segments, broadcasts, and campaign tooling
- Discount engine
- Multi tenant hosting (every row carries a tenant id, so a shared install later is a migration, not a rewrite)
- A public Shopify App Store listing
- 100,000 SKU targets (the design target is 10,000, tested at 50,000)
- Demand forecasting and a custom report builder
