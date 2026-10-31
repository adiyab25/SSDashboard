# Epic: Storefront

The client's own customer facing online store, powered by ERP stock and orders. Back to [index](index.md).

## Slice 8: Storefront

### 42. Storefront catalog & product pages · needs a decision
Public category and product pages showing live ERP stock and prices, in English and Arabic.
**Done when:** category and product pages load fast and show live availability; each page has its own title, description, social card, and structured data; a sitemap lists every page in both languages. (basis: Google SEO starter guide)
- [ ] Design it (spec): `/architect storefront catalog & product pages`

### 43. Cart & checkout · needs a decision · GA
Cart, checkout, and online payment that create a reserved sales order in the ERP.
**Done when:** a shopper can add items, check out as guest or customer, and pay; a paid order appears in the ERP with stock reserved; failed payments never create an order; card data never touches our servers. (basis: PCI DSS scope)
- [ ] Design it (spec): `/architect cart & checkout`

### 44. Customer accounts · needs a decision
Shopper accounts with saved addresses, order history, and order tracking.
**Done when:** a shopper can sign up, sign in, save addresses, and see past orders with shipment status.
- [ ] Design it (spec): `/architect customer accounts`

### 45. Legal pages & cookie consent
Privacy policy, terms, and a cookie consent banner that actually controls tracking.
**Done when:** privacy and terms pages exist in both languages; non essential cookies load only after consent; a shopper can change their choice later. (basis: GDPR and ePrivacy cookie rules)
- [ ] Build it: `/develop legal pages & cookie consent`
