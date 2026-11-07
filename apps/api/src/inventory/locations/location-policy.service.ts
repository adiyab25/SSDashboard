import { Inject, Injectable } from '@nestjs/common';
import type { LocationOwnerType } from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../../database/database.module.js';
import type { Executor } from '../../database/sql.js';
import { PartnerAccounts, type PartyRoleColumn } from '../../partners/partner-accounts.service.js';

/** Who pays a refund: the brand, or the owner of the location. */
export type RefundBy = 'brand' | 'location_owner';

/**
 * What differs by owner type, as one row of `location_owner_policies` (spec 0002, A13). Callers
 * read these attributes and never compare an owner type themselves.
 */
export interface LocationPolicy {
  /** The owner type the row belongs to; for display and logs, never for branching. */
  ownerType: LocationOwnerType;
  /** Stock at the location is still the brand's asset (false: it belongs to the customer). */
  stockOwnedByBrand: boolean;
  /** Handing stock over is already the sale. */
  handoverIsSale: boolean;
  /** The moment a sale counts. */
  saleRecordedAt: 'at_shipment' | 'at_sell_through' | 'at_handover';
  /** Who refunds an end customer's returned piece. */
  endCustomerRefundBy: RefundBy;
  /** Who refunds a defective piece. */
  defectivePieceRefundBy: RefundBy;
  /** The tax document a sale needs. */
  taxDocument:
    | 'b2c_electronic_receipt'
    | 'b2b_electronic_invoice_at_settlement'
    | 'b2b_electronic_invoice_at_handover';
  /** The settlement account kind a sale settles through, or null when it does not settle. */
  settlementOwnerType: 'carrier' | 'consignment_partner' | 'gateway' | null;
  /** Whether stock here may feed the portal and Shopify. */
  canSellOnline: boolean;
}

/** The owner type rules a caller can break. */
export type LocationPolicyErrorCode = 'NotFound' | 'NotSellableOnline' | 'PartyRoleMismatch';

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

function notSellableOnline(): LocationPolicyError {
  return new LocationPolicyError(
    'NotSellableOnline',
    'Stock at this kind of location cannot be sold online',
  );
}

/**
 * The only reader of `location_owner_policies` and the only code that names an owner type value
 * (spec 0002, A13; `owner-type-boundary.spec.ts` enforces it). Orders, refunds, settlement, tax
 * documents, and channel feeds ask `policyFor` and read attributes; none compares owner types.
 * It never writes the policy table (feature 9 owns editing it).
 */
@Injectable()
export class LocationPolicyService {
  /**
   * Takes the app database connection and the partners module's `PartnerAccounts`, which answers
   * whether a party holds a role (this service never reads `parties`).
   */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(PartnerAccounts) private readonly partners: Pick<PartnerAccounts, 'holdsRole'>,
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
   * (`PartyRoleMismatch`; the brand's own location takes no party) and `sellableOnline` is
   * allowed by the policy (`NotSellableOnline`). An absent owner type is the brand's own. Pass the
   * transaction that inserts the location as `executor`: the party row is read `FOR SHARE`, so the
   * lock lasts until that insert commits. Without one it uses a plain connection (no lasting lock).
   */
  async assertCanCreate(
    input: { ownerType?: LocationOwnerType; partyId?: string; sellableOnline?: boolean },
    executor: Executor = this.connection.db,
  ): Promise<void> {
    const ownerType = input.ownerType ?? 'own';
    await this.assertParty(ownerType, input.partyId, executor);
    if (input.sellableOnline) await this.assertOnlineAllowed(ownerType, executor);
  }

  /** Refuses turning `sellable_online` on for a location whose policy forbids it. */
  async assertCanSellOnline(
    locationId: string,
    executor: Executor = this.connection.db,
  ): Promise<void> {
    const policy = await this.policyFor(locationId, executor);
    if (!policy.canSellOnline) throw notSellableOnline();
  }

  private async assertOnlineAllowed(
    ownerType: LocationOwnerType,
    executor: Executor,
  ): Promise<void> {
    const { rows } = await executor.execute<{ can_sell_online: boolean }>(sql`
      SELECT can_sell_online FROM location_owner_policies
      WHERE owner_type = ${ownerType}::location_owner_type`);
    if (!rows[0]?.can_sell_online) throw notSellableOnline();
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
