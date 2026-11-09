-- Hand written (spec 0011, milestone 1): the data move that comes before the new location rules.
-- 0014_online_location_and_transfer_tables.sql adds the checks `locations_online_needs_warehouse`
-- and `locations_online_not_archived` and the partial unique index `locations_one_online`.
-- From now on a location goes online only through the gate (stock confirmed counted, every
-- registered check passing, a written reason), so every online flag set before this release is
-- cleared, archived rows included: a flag that skipped the gate must not survive, and an
-- archived row must never come back online by unarchiving. Every brand turns its online
-- location on again through the gate. Nothing here touches stock.
UPDATE "locations" SET "sellable_online" = false WHERE "sellable_online";
