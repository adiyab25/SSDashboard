# Slice 5: the production loop

Materials out to contracted factories, finished pieces in, and cost rolled up honestly. A run record, not a versioned bill of materials. [Back to the scope](index.md).

### 64. Factory production runs · GA · needs a decision
Send fabric and trims to a factory location, receive finished pieces as SKUs, and roll the factory charge plus materials into unit cost.
**Done when:** materials leave the warehouse to a factory location on the ledger, materials held per factory are visible, finished pieces receive at a cost that includes materials and the factory charge, and an open run gives the expected date for "wait for stock".
- [ ] Design it (spec): `/architect factory production runs`

### 65. Quality report from return reasons · needs a decision
Which products, sizes, and factories drive returns, from the reasons customers and inspections record.
**Done when:** the report shows return and defect reasons by product, size, and factory over a period, from confirmed data only.
- [ ] Design it (spec): `/architect quality report from return reasons`
