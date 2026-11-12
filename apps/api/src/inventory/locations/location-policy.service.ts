import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  OWNER_POLICY_LOCKED_FIELDS,
  type LocationOwnerType,
  type OwnerPolicyField,
  type OwnerPolicyFields,
  type RefundBy,
  type SaleRecordedAt,
  type SettlementOwnerType,
  type TaxDocument,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { AuditService } from '../../audit/audit.service.js';
import { DATABASE } from '../../database/database.module.js';
import { pgConstraint, pgErrorCode, type Executor } from '../../database/sql.js';
import { PartnerAccounts, type PartyRoleColumn } from '../../partners/partner-accounts.service.js';
import { nameBasedUuid } from '../../platform/name-based-uuid.js';

/**
 * What differs by owner type, as one row of `location_owner_policies` (spec 0002, A13), typed by
 * the policy enums of `@ssdashboard/contracts`. Callers read these attributes and never compare an
 * owner type themselves.
 */
export interface LocationPolicy {
  /** The owner type the row belongs to; for display and logs, never for branching. */
  ownerType: LocationOwnerType;
  /** Stock at the location is still the brand's asset (false: it belongs to the customer). */
  stockOwnedByBrand: boolean;
  /** Handing stock over is already the sale. */
  handoverIsSale: boolean;
  /** The moment a sale counts. */
  saleRecordedAt: SaleRecordedAt;
  /** Who refunds an end customer's returned piece. */
  endCustomerRefundBy: RefundBy;
  /** Who refunds a defective piece. */
  defectivePieceRefundBy: RefundBy;
  /** The tax document a sale needs. */
  taxDocument: TaxDocument;
  /** The settlement account kind a sale settles through, or null when it does not settle. */
  settlementOwnerType: SettlementOwnerType | null;
  /** Whether stock here may feed the portal and Shopify. */
  canSellOnline: boolean;
}

/** The owner type rules a caller can break. */
export type LocationPolicyErrorCode =
  'NotFound' | 'NotSellableOnline' | 'PartyRoleMismatch' | 'PolicyChangedSinceArchive';

/**
 * An owner type rule the caller broke: `NotSellableOnline` (the policy forbids online stock at
 * this owner type) or `PartyRoleMismatch` (the party's roles do not fit the owner type). The
 * controller maps `code` to a stable HTTP error code. Never carries personal data.
 */
export class LocationPolicyError extends Error {
  /** Takes the stable `code` and a message safe to show. */
  constructor(
    readonly code: LocationPolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LocationPolicyError';
  }
}

interface PolicyRow extends Record<string, unknown> {
  owner_type: LocationOwnerType;
  stock_owned_by_brand: boolean;
  handover_is_sale: boolean;
  sale_recorded_at: LocationPolicy['saleRecordedAt'];
  end_customer_refund_by: RefundBy;
  defective_piece_refund_by: RefundBy;
  tax_document: LocationPolicy['taxDocument'];
  settlement_owner_type: LocationPolicy['settlementOwnerType'];
  can_sell_online: boolean;
}

/** A policy row with its change facts. */
interface StoredPolicyRow extends PolicyRow {
  updated_at: string;
  updated_by: string | null;
}

/** The attribute columns of a policy row, read through the alias `p`. */
const POLICY_COLUMNS = sql.raw(
  `p.owner_type, p.stock_owned_by_brand, p.handover_is_sale, p.sale_recorded_at,
   p.end_customer_refund_by, p.defective_piece_refund_by, p.tax_document,
   p.settlement_owner_type, p.can_sell_online`,
);

function toStored(row: StoredPolicyRow): StoredOwnerPolicy {
  return { policy: toPolicy(row), updatedAt: row.updated_at, updatedBy: row.updated_by };
}

function toPolicy(row: PolicyRow): LocationPolicy {
  return {
    ownerType: row.owner_type,
    stockOwnedByBrand: row.stock_owned_by_brand,
    handoverIsSale: row.handover_is_sale,
    saleRecordedAt: row.sale_recorded_at,
    endCustomerRefundBy: row.end_customer_refund_by,
    defectivePieceRefundBy: row.defective_piece_refund_by,
    taxDocument: row.tax_document,
    settlementOwnerType: row.settlement_owner_type,
    canSellOnline: row.can_sell_online,
  };
}

/**
 * The party role an owner type needs, or null when it takes no party. Together with the policy
 * lookups below, this map is the only place in the api that names owner type values.
 */
export function requiredPartyRole(ownerType: LocationOwnerType): PartyRoleColumn | null {
  switch (ownerType) {
    case 'own':
      return null;
    case 'consignment_partner':
      return 'is_consignment_partner';
    case 'wholesale_customer':
      return 'is_wholesale_customer';
  }
}

/** The namespace of owner type policy record ids: a fixed random uuid, never to change. */
const OWNER_POLICY_NAMESPACE = '3b8e1f6a-2c4d-4e9b-a7f0-5d1c8b2e6a94';

/**
 * The audit record id of an owner type policy row (spec 0009, AC-24): a name based uuid of the
 * owner type, so every `policy.changed` entry of one row carries the same id. Pure.
 */
export function ownerPolicyRecordId(ownerType: LocationOwnerType): string {
  return nameBasedUuid(OWNER_POLICY_NAMESPACE, ownerType);
}

/** A consistency rule of an owner type policy row (spec 0009, AC-24). */
export type OwnerPolicyRule =
  | 'handover_is_sale_means_customer_stock'
  | 'sale_at_handover_means_handover_is_sale'
  | 'consignment_settles_with_partner'
  | 'online_needs_brand_stock';

/**
 * The consistency rules a policy row breaks (spec 0009, AC-24, owner ruling 2026-11-08), empty
 * when sound: handing stock over is the sale exactly when the stock is not the brand's; the sale
 * counts at the handover exactly when the handover is the sale; only the brand's own stock whose
 * sales settle through no partner is offered online, so partner and customer stock never is; and
 * the consignment row always settles with its partner (owner ruling 2026-11-08, "pin it"), so the
 * online rule can never be opened up for partner stock by redefining the row. The twins of the
 * table's CHECKs (migration 0011, `OWNER_POLICY_CHECKS`). Names an owner type, which only this file
 * may. Pure.
 */
export function ownerPolicyInconsistencies(
  fields: OwnerPolicyFields,
  ownerType: LocationOwnerType,
): OwnerPolicyRule[] {
  const broken: OwnerPolicyRule[] = [];
  if (fields.handoverIsSale !== !fields.stockOwnedByBrand) {
    broken.push('handover_is_sale_means_customer_stock');
  }
  if ((fields.saleRecordedAt === 'at_handover') !== fields.handoverIsSale) {
    broken.push('sale_at_handover_means_handover_is_sale');
  }
  if (ownerType === 'consignment_partner' && fields.settlementOwnerType === null) {
    broken.push('consignment_settles_with_partner');
  }
  if (fields.canSellOnline && !(fields.stockOwnedByBrand && fields.settlementOwnerType === null)) {
    broken.push('online_needs_brand_stock');
  }
  return broken;
}

/** The rule each CHECK of the table holds (migration 0011), for the backstop of `updatePolicy`. */
const OWNER_POLICY_CHECKS: Readonly<Record<string, OwnerPolicyRule>> = {
  location_owner_policies_handover_is_sale: 'handover_is_sale_means_customer_stock',
  location_owner_policies_sale_at_handover: 'sale_at_handover_means_handover_is_sale',
  location_owner_policies_consignment_settles_with_partner: 'consignment_settles_with_partner',
  location_owner_policies_online_needs_brand_stock: 'online_needs_brand_stock',
};

/**
 * The rule a raw CHECK violation (23514) of the policy table names, or undefined for any other
 * error: a rule the api's own check missed still answers `Inconsistent`, never a server error.
 */
export function brokenCheckOf(error: unknown): OwnerPolicyRule | undefined {
  if (pgErrorCode(error) !== '23514') return undefined;
  const constraint = pgConstraint(error);
  return constraint !== undefined && Object.hasOwn(OWNER_POLICY_CHECKS, constraint)
    ? OWNER_POLICY_CHECKS[constraint]
    : undefined;
}

/**
 * How many locations of an owner type exist, for the edit's locks (spec 0009, AC-24): those not
 * archived (`countActiveByOwnerType`), and those selling online, archived or not
 * (`countSellableOnlineByOwnerType`). `LocationsService` answers it; the controller hands it in,
 * so this service never reads the locations table for the edit and the two never depend on each
 * other.
 */
export interface OwnerTypeUsage {
  countActiveByOwnerType: (ownerType: LocationOwnerType, executor: Executor) => Promise<number>;
  countSellableOnlineByOwnerType: (
    ownerType: LocationOwnerType,
    executor: Executor,
  ) => Promise<number>;
}

/** One policy row with when and by whom it last changed, as the settings screen reads it. */
export interface StoredOwnerPolicy {
  policy: LocationPolicy;
  /** `updated_at` in UTC with microseconds; send it back as `expectedUpdatedAt`. */
  updatedAt: string;
  updatedBy: string | null;
}

/** One edit asked for through `LocationPolicyService.updatePolicy`. */
export interface OwnerPolicyChange {
  ownerType: LocationOwnerType;
  fields: OwnerPolicyFields;
  reason?: string;
  /** The `updatedAt` the caller last saw. */
  expectedUpdatedAt: string;
  /** The person editing it and the hat the audit entry names. */
  actor: { userId: string; hat: string };
}

/** The owner policy edit rules a caller can break (spec 0009, AC-24). */
export type OwnerPolicyEditErrorCode =
  | 'OwnerTypeUnknown'
  | 'Inconsistent'
  | 'InUse'
  | 'SellableLocationsExist'
  | 'Stale'
  | 'ReasonRequired';

/**
 * A refused owner policy edit: `Inconsistent` with the broken `rules`, `InUse` with the locked
 * `fields` the change touched, and the rest bare. The controller maps `code` to a stable HTTP
 * code. Never carries a value or the reason text.
 */
export class OwnerPolicyEditError extends Error {
  /** Takes the stable code, a message safe to show, and the broken rules or touched fields. */
  constructor(
    readonly code: OwnerPolicyEditErrorCode,
    message: string,
    readonly details: readonly string[] = [],
  ) {
    super(message);
    this.name = 'OwnerPolicyEditError';
  }
}

/** The policy attributes as the audit diff and the change check compare them. */
function fieldsOf(policy: LocationPolicy): OwnerPolicyFields {
  return {
    stockOwnedByBrand: policy.stockOwnedByBrand,
    handoverIsSale: policy.handoverIsSale,
    saleRecordedAt: policy.saleRecordedAt,
    endCustomerRefundBy: policy.endCustomerRefundBy,
    defectivePieceRefundBy: policy.defectivePieceRefundBy,
    taxDocument: policy.taxDocument,
    settlementOwnerType: policy.settlementOwnerType,
    canSellOnline: policy.canSellOnline,
  };
}

/** `updated_at` in UTC with microseconds. */
const POLICY_UPDATED_AT = sql.raw(
  `to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
);

function notSellableOnline(): LocationPolicyError {
  return new LocationPolicyError(
    'NotSellableOnline',
    'Stock at this kind of location cannot be sold online',
  );
}

/**
 * The only reader and writer of `location_owner_policies` and the only code that names an owner
 * type value (spec 0002, A13; `owner-type-boundary.spec.ts` enforces it). Orders, refunds,
 * settlement, tax documents, and channel feeds ask `policyFor` and read attributes; none compares
 * owner types. A holder of `settings.manage` edits a row through `updatePolicy` (spec 0009,
 * AC-24); a change answers only future questions, so recorded movements and settlement lines are
 * never reinterpreted.
 */
@Injectable()
export class LocationPolicyService {
  /**
   * Takes the app database connection and the partners module's `PartnerAccounts`, which answers
   * whether a party holds a role (this service never reads `parties`). The audit writer is needed
   * only by `updatePolicy`; Nest always injects it, and unit tests may leave it out.
   */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(PartnerAccounts) private readonly partners: Pick<PartnerAccounts, 'holdsRole'>,
    @Optional() @Inject(AuditService) private readonly audit?: AuditService,
  ) {}

  /** The policy of the location's owner type, or `NotFound` when the location does not exist. */
  async policyFor(
    locationId: string,
    executor: Executor = this.connection.db,
  ): Promise<LocationPolicy> {
    const { rows } = await executor.execute<PolicyRow>(sql`
      SELECT p.owner_type, p.stock_owned_by_brand, p.handover_is_sale, p.sale_recorded_at,
             p.end_customer_refund_by, p.defective_piece_refund_by, p.tax_document,
             p.settlement_owner_type, p.can_sell_online
      FROM locations l
      JOIN location_owner_policies p ON p.tenant_id = l.tenant_id AND p.owner_type = l.owner_type
      WHERE l.id = ${locationId}`);
    const row = rows[0];
    if (!row) throw new LocationPolicyError('NotFound', 'Location not found');
    return toPolicy(row);
  }

  /**
   * Checks a new location before it is inserted: the party's roles fit the owner type
   * (`PartyRoleMismatch`; the brand's own location takes no party). A new location is never
   * online, so no online check runs here (spec 0011 AC-1). An absent owner type is the brand's own. Pass the
   * transaction that inserts the location as `executor`: the party row is read `FOR SHARE`, so the
   * lock lasts until that insert commits, and so does the owner type's shared advisory lock, so a
   * policy edit cannot count the type's locations while one is being added (spec 0009, AC-24).
   * Without one it uses a plain connection (no lasting lock).
   */
  async assertCanCreate(
    input: { ownerType?: LocationOwnerType; partyId?: string },
    executor: Executor = this.connection.db,
  ): Promise<void> {
    const ownerType = input.ownerType ?? 'own';
    await this.assertParty(ownerType, input.partyId, executor);
    await this.holdOwnerType(ownerType, executor);
  }

  /**
   * Refuses turning `sellable_online` on for a location whose policy forbids it, holding the owner
   * type's shared advisory lock in `executor`'s transaction so a policy edit turning online
   * selling off cannot pass alongside it.
   */
  async assertCanSellOnline(
    locationId: string,
    executor: Executor = this.connection.db,
  ): Promise<void> {
    await this.holdOwnerTypeOf(locationId, executor);
    const policy = await this.policyFor(locationId, executor);
    if (!policy.canSellOnline) throw notSellableOnline();
  }

  /**
   * Every owner type's policy row with when and by whom it last changed, in owner type enum
   * order, for the settings screen (spec 0009, AC-24, AC-25).
   */
  async listPolicies(executor: Executor = this.connection.db): Promise<StoredOwnerPolicy[]> {
    const { rows } = await executor.execute<StoredPolicyRow>(sql`
      SELECT ${POLICY_COLUMNS}, ${POLICY_UPDATED_AT} AS updated_at, p.updated_by
      FROM location_owner_policies p ORDER BY p.owner_type`);
    return rows.map(toStored);
  }

  /**
   * Edits one owner type's policy row (spec 0009, AC-24), the only writer of the table. Refuses a
   * blank reason (`ReasonRequired`), an owner type with no row (`OwnerTypeUnknown`), a row that
   * breaks a consistency rule (`Inconsistent`, `ownerPolicyInconsistencies`), a stale
   * `expectedUpdatedAt` (`Stale`), a change to a locked field (`OWNER_POLICY_LOCKED_FIELDS`) of the
   * brand's own row or of a row with at least one location that is not archived (`InUse`: changed
   * terms mean a new location, D13), and online selling turned off while a location of the type
   * sells online (`SellableLocationsExist`). In one transaction, under the owner type's exclusive
   * advisory lock (which location creation, online selling, and unarchiving take shared), it
   * writes the row (`updated_at`, `updated_by`) and the `policy.changed` audit entry with the
   * changed fields before and after. An edit that changes nothing writes nothing and answers
   * `changed: false`. Recorded movements and settlement lines are never reinterpreted: the next
   * `policyFor` answers the new row.
   */
  async updatePolicy(
    change: OwnerPolicyChange,
    usage: OwnerTypeUsage,
  ): Promise<{ stored: StoredOwnerPolicy; changed: boolean }> {
    const { audit } = this;
    if (!audit) throw new Error('LocationPolicyService was built without the audit writer');
    if (!change.reason?.trim()) {
      throw new OwnerPolicyEditError('ReasonRequired', 'A reason is required for this change');
    }
    const broken = ownerPolicyInconsistencies(change.fields, change.ownerType);
    if (broken.length > 0) {
      throw new OwnerPolicyEditError(
        'Inconsistent',
        'The policy contradicts itself; check how stock, the handover, and the sale fit together',
        broken,
      );
    }
    const reason = change.reason;
    return this.connection.db.transaction(async (tx) => {
      await this.holdOwnerType(change.ownerType, tx, 'exclusive');
      const { rows } = await tx.execute<StoredPolicyRow & { matches: boolean }>(sql`
        SELECT ${POLICY_COLUMNS}, ${POLICY_UPDATED_AT} AS updated_at, p.updated_by,
               p.updated_at = ${change.expectedUpdatedAt}::timestamptz AS matches
        FROM location_owner_policies p
        WHERE p.owner_type = ${change.ownerType}::location_owner_type
        FOR UPDATE`);
      const row = rows[0];
      if (!row) throw new OwnerPolicyEditError('OwnerTypeUnknown', 'No such owner type');
      if (!row.matches) {
        throw new OwnerPolicyEditError('Stale', 'This policy was changed by someone else');
      }
      const current = toStored(row);
      const before = fieldsOf(current.policy);
      const touched = (Object.keys(change.fields) as OwnerPolicyField[]).filter(
        (field) => change.fields[field] !== before[field],
      );
      if (touched.length === 0) return { stored: current, changed: false };

      const lockedTouched = touched.filter((field) =>
        (OWNER_POLICY_LOCKED_FIELDS as readonly OwnerPolicyField[]).includes(field),
      );
      if (lockedTouched.length > 0) {
        // The brand's own row (the owner type that takes no party) is locked always.
        const brandOwn = requiredPartyRole(change.ownerType) === null;
        if (brandOwn || (await usage.countActiveByOwnerType(change.ownerType, tx)) > 0) {
          throw new OwnerPolicyEditError(
            'InUse',
            'Locations of this type exist, so these terms cannot change; open a new location instead',
            lockedTouched,
          );
        }
      }
      if (
        before.canSellOnline &&
        !change.fields.canSellOnline &&
        (await usage.countSellableOnlineByOwnerType(change.ownerType, tx)) > 0
      ) {
        throw new OwnerPolicyEditError(
          'SellableLocationsExist',
          'Locations of this type still sell online; turn that off on each location first',
        );
      }

      const next = change.fields;
      const written = await tx
        .execute<StoredPolicyRow>(
          sql`
        UPDATE location_owner_policies p
        SET stock_owned_by_brand = ${next.stockOwnedByBrand},
            handover_is_sale = ${next.handoverIsSale},
            sale_recorded_at = ${next.saleRecordedAt}::sale_recorded_at,
            end_customer_refund_by = ${next.endCustomerRefundBy}::refund_by,
            defective_piece_refund_by = ${next.defectivePieceRefundBy}::refund_by,
            tax_document = ${next.taxDocument}::tax_document,
            settlement_owner_type = ${next.settlementOwnerType}::settlement_owner_type,
            can_sell_online = ${next.canSellOnline},
            updated_at = now(),
            updated_by = ${change.actor.userId}${
              // Only a locked term moves it, at the write's own clock (after the location counts
              // it read), so an archive that committed before this edit is always earlier.
              lockedTouched.length > 0 ? sql`, locked_terms_changed_at = clock_timestamp()` : sql``
            }
        WHERE p.owner_type = ${change.ownerType}::location_owner_type
        RETURNING ${POLICY_COLUMNS}, ${POLICY_UPDATED_AT} AS updated_at, p.updated_by`,
        )
        .then(
          (result) => result.rows,
          (error: unknown) => {
            const rule = brokenCheckOf(error);
            if (rule === undefined) throw error;
            throw new OwnerPolicyEditError('Inconsistent', 'The policy contradicts itself', [rule]);
          },
        );
      const saved = written[0];
      if (!saved) throw new Error('The policy update returned no row');
      const after = fieldsOf(toPolicy(saved));
      await audit.record(tx, {
        actor: { kind: 'person', userId: change.actor.userId, hat: change.actor.hat },
        action: 'policy.changed',
        record: {
          type: 'policy',
          id: ownerPolicyRecordId(change.ownerType),
          label: change.ownerType,
        },
        before: Object.fromEntries(touched.map((field) => [field, before[field]])),
        after: Object.fromEntries(touched.map((field) => [field, after[field]])),
        reason,
        correlationId: audit.newCorrelationId(),
      });
      return { stored: toStored(saved), changed: true };
    });
  }

  /**
   * Takes the owner type's advisory lock in `executor`'s transaction: `exclusive` for a policy
   * edit, `shared` for anything that adds a location of the type, turns online selling on, or
   * brings one back from the archive, so an edit's location counts cannot change under it.
   */
  async holdOwnerType(
    ownerType: LocationOwnerType,
    executor: Executor,
    mode: 'shared' | 'exclusive' = 'shared',
  ): Promise<void> {
    const key = sql`hashtext('ssd.owner_policy.' || ${ownerType})`;
    await executor.execute(
      mode === 'exclusive'
        ? sql`SELECT pg_advisory_xact_lock(${key})`
        : sql`SELECT pg_advisory_xact_lock_shared(${key})`,
    );
  }

  /**
   * Refuses bringing an archived location back when a locked term of its owner type's policy
   * (`OWNER_POLICY_LOCKED_FIELDS`) changed after it was archived (`PolicyChangedSinceArchive`,
   * spec 0009 AC-24, D13: changed terms mean a new location), so a location never comes back
   * under terms it was not opened with. A change of a free field (who refunds, online selling)
   * never blocks it: only `locked_terms_changed_at` counts. Run it in the
   * unarchive's transaction after `holdOwnerTypeOf`, so no policy edit can land in between. A
   * location that is not archived, or does not exist, passes (the caller answers those).
   */
  async assertUnchangedSinceArchive(locationId: string, executor: Executor): Promise<void> {
    const { rows } = await executor.execute<{ changed: boolean }>(sql`
      SELECT coalesce(p.locked_terms_changed_at > l.archived_at, false) AS changed
      FROM locations l
      JOIN location_owner_policies p ON p.tenant_id = l.tenant_id AND p.owner_type = l.owner_type
      WHERE l.id = ${locationId} AND l.archived_at IS NOT NULL`);
    if (rows[0]?.changed) {
      throw new LocationPolicyError(
        'PolicyChangedSinceArchive',
        'The terms of this kind of location changed after it was archived; open a new location instead',
      );
    }
  }

  /** `holdOwnerType` (shared) for the owner type of an existing location; nothing for none. */
  async holdOwnerTypeOf(locationId: string, executor: Executor): Promise<void> {
    const { rows } = await executor.execute<{ owner_type: LocationOwnerType }>(sql`
      SELECT owner_type FROM locations WHERE id = ${locationId}`);
    const ownerType = rows[0]?.owner_type;
    if (ownerType !== undefined) await this.holdOwnerType(ownerType, executor);
  }

  private async assertParty(
    ownerType: LocationOwnerType,
    partyId: string | undefined,
    executor: Executor,
  ): Promise<void> {
    const role = requiredPartyRole(ownerType);
    if (role === null) {
      if (partyId !== undefined) {
        throw new LocationPolicyError(
          'PartyRoleMismatch',
          'This owner type takes no party; leave the party out',
        );
      }
      return;
    }
    if (partyId === undefined) {
      throw new LocationPolicyError('PartyRoleMismatch', 'This owner type needs a party');
    }
    if (!(await this.partners.holdsRole(partyId, role, executor))) {
      throw new LocationPolicyError(
        'PartyRoleMismatch',
        'The party does not hold the role this owner type needs',
      );
    }
  }
}
