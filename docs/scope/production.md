# Epic: Production

Making finished SKUs in your own factories and through contract manufacturers. Back to [index](index.md).

## Slice 7: Production

### 39. Bills of materials · needs a decision
The recipe for each finished SKU: raw materials, quantities, and expected scrap.
**Done when:** a finished SKU can have a versioned bill of materials; it can include sub assemblies; the system can show how many units can be made from current stock.
- [ ] Design it (spec): `/architect bills of materials`

### 40. Production orders · needs a decision
Run production in your own factories: consume raw materials, produce finished goods.
**Done when:** a production order moves through planned, in progress, done; completing it consumes materials (with lots) and adds finished stock (with new lots); the finished unit cost rolls up from materials; actual vs planned usage is reported.
- [ ] Design it (spec): `/architect production orders`

### 41. Contract manufacturing · needs a decision
Send materials or designs to an outside factory and track what comes back and what it costs.
**Done when:** a work order sends materials to a factory location; finished goods are received against it; the factory's service charge and the materials roll into finished unit cost; materials still held at each factory are visible.
- [ ] Design it (spec): `/architect contract manufacturing`
