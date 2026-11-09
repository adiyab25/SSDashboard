-- Hand written (spec 0011, milestone 1): the data move that comes before the new location rules.
-- 0014_online_location_and_transfer_tables.sql adds the check `locations_online_needs_warehouse`
-- and the partial unique index `locations_one_online`. Before that, a location flagged online
-- before those rules existed (a shop, a location that is not sellable, or a second one) loses
-- the flag, so the new rules never meet a row that breaks them. Of several online warehouses
-- the oldest keeps the flag. Nothing here touches stock; the manager turns a location on again
-- through the online gate.
UPDATE "locations"
SET "sellable_online" = false
WHERE "sellable_online"
  AND NOT ("kind" = 'warehouse' AND "is_sellable");--> statement-breakpoint
UPDATE "locations" AS l
SET "sellable_online" = false
WHERE l."sellable_online"
  AND l."archived_at" IS NULL
  AND EXISTS (
    SELECT 1 FROM "locations" AS o
    WHERE o."tenant_id" = l."tenant_id"
      AND o."sellable_online"
      AND o."archived_at" IS NULL
      AND (o."created_at", o."id") < (l."created_at", l."id")
  );
