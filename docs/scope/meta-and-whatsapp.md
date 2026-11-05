# Slice 3: Meta and WhatsApp

Tell Meta who really bought, show profit per campaign after returns and shipping, and bring leads in from the places customers actually talk. [Back to the scope](index.md).

### 48. Attribution & Meta Conversions API · GA · needs a decision
Campaign, ad set, and ad on every order, and the purchase event sent to Meta on confirmation, not on form submit.
**Done when:** source identifiers are captured from the landing page click, Shopify's customer journey, or the WhatsApp thread; a confirmed order fires one purchase event with only the hashed fields Meta needs; a cancelled order never fires; recorded fixtures replay green with no live call.
- [ ] Design it (spec): `/architect attribution & meta conversions api`

### 49. Campaign profit report · needs a decision
Profit per campaign after returned to origin, shipping both ways, refunds, and cost of goods, for the owner and the media buyer.
**Done when:** the report uses the agreed definitions (front end marketing efficiency on placed day order value, kept orders, 7 day click and 1 day view attribution, intraday spend kept apart from complete days); the media buyer sees campaign results without customer data; a cost rule that is not set shows as not set, never as zero.
- [ ] Design it (spec): `/architect campaign profit report`

### 50. WhatsApp templates & backup number · GA · needs a decision
Customer messages from approved templates on the WhatsApp Cloud API, and continuity when the brand's number is restricted.
**Done when:** confirmation, shipping, exchange, and refund messages send from templates in Arabic and English; switching to a backup number loses no data or history; recorded fixtures replay green with no live call.
- [ ] Design it (spec): `/architect whatsapp templates & backup number`

### 51. Lead capture: Meta lead ads & click to WhatsApp · needs a decision
Leads from Meta lead ads and click to WhatsApp conversations land in the confirmation queue with their source.
**Done when:** a lead ads webhook and a click to WhatsApp thread each create a lead in the confirmation queue, merged by phone, with campaign identifiers kept.
- [ ] Design it (spec): `/architect lead capture`

### 52. Instagram DM attribution · needs a decision
Orders that start in Instagram messages, attributed to source and product, through Meta's messaging API where app review allows.
**Done when:** an order taken from an Instagram conversation records its source and product; until the API is approved, the agent tags the source by hand.
- [ ] Design it (spec): `/architect instagram dm attribution`

### 53. COD landing page · GA · needs a decision
A cash on delivery order form on a landing page, as its own channel and the first form of an own storefront.
**Done when:** a customer orders in Arabic on a phone, the order enters the confirmation queue with its campaign source, the page links the privacy notice, and spam and duplicate submissions are caught.
- [ ] Design it (spec): `/architect cod landing page`
