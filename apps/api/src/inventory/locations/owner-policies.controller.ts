import {
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Put,
  UnprocessableEntityException,
  type HttpException,
} from '@nestjs/common';
import {
  LocationOwnerType,
  OWNER_POLICY_LOCKED_FIELDS,
  PutOwnerPolicyBody,
  type OwnerPoliciesResponse,
  type OwnerPolicyView,
  type PutOwnerPolicyAnswer,
} from '@ssdashboard/contracts';
import { type DatabaseConnection } from '@ssdashboard/db';
import { auditHttpError } from '../../audit/audit-http.js';
import { DATABASE } from '../../database/database.module.js';
import type { Executor } from '../../database/sql.js';
import { StaffDirectory } from '../../identity/staff/staff-directory.js';
import type { Access } from '../../platform/access/access.js';
import { CurrentAccess } from '../../platform/access/current-access.decorator.js';
import { Permission } from '../../platform/access/permission.decorator.js';
import { Audience } from '../../platform/audience/audience.decorator.js';
import { RequiresModule } from '../../platform/modules/requires-module.decorator.js';
import { ZodBodyPipe } from '../../platform/zod-body.pipe.js';
import {
  LocationPolicyService,
  OwnerPolicyEditError,
  requiredPartyRole,
  type StoredOwnerPolicy,
} from './location-policy.service.js';
import { LocationsService } from './locations.service.js';

/**
 * The api edge mapping of a refused owner policy edit (spec 0009, AC-24): 404
 * `OWNER_TYPE_UNKNOWN`, 422 `OWNER_POLICY_INCONSISTENT` with `rules`, 409 `OWNER_POLICY_IN_USE`
 * with `fields`, 409 `SELLABLE_LOCATIONS_EXIST`, 409 `STALE_SETTING`, 422 `REASON_REQUIRED`.
 * Undefined for anything else.
 */
export function ownerPolicyHttpError(error: unknown): HttpException | undefined {
  if (!(error instanceof OwnerPolicyEditError)) return undefined;
  switch (error.code) {
    case 'OwnerTypeUnknown':
      return new NotFoundException({ code: 'OWNER_TYPE_UNKNOWN', message: error.message });
    case 'Inconsistent':
      return new UnprocessableEntityException({
        code: 'OWNER_POLICY_INCONSISTENT',
        message: error.message,
        rules: error.details,
      });
    case 'InUse':
      return new ConflictException({
        code: 'OWNER_POLICY_IN_USE',
        message: error.message,
        fields: error.details,
      });
    case 'SellableLocationsExist':
      return new ConflictException({ code: 'SELLABLE_LOCATIONS_EXIST', message: error.message });
    case 'Stale':
      return new ConflictException({ code: 'STALE_SETTING', message: error.message });
    case 'ReasonRequired':
      return new UnprocessableEntityException({ code: 'REASON_REQUIRED', message: error.message });
  }
}

/**
 * The location owner type policies for the people who manage settings (spec 0009, AC-24, AC-25):
 * every row with its locked fields and why, and one row's edit with a reason. Staff only,
 * `settings.manage` on both routes; served by the inventory module, which owns the table. Holds no
 * rule itself; `LocationPolicyService` does.
 */
@Audience('staff')
@Permission('settings.manage')
@RequiresModule('inventory')
@Controller('inventory/owner-policies')
export class OwnerPoliciesController {
  /** Takes the policy service, the locations service (the counts), the database, and names. */
  constructor(
    @Inject(LocationPolicyService) private readonly policies: LocationPolicyService,
    @Inject(LocationsService) private readonly locations: LocationsService,
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(StaffDirectory) private readonly staff: StaffDirectory,
  ) {}

  /** Every owner type's policy, its locked fields, and its count of active locations. */
  @Get()
  async list(): Promise<OwnerPoliciesResponse> {
    const db = this.connection.db;
    const stored = await this.policies.listPolicies(db);
    const names = await this.staff.namesByIds(
      stored.flatMap((row) => (row.updatedBy ? [row.updatedBy] : [])),
    );
    const policies: OwnerPolicyView[] = [];
    for (const row of stored) policies.push(await this.view(row, names, db));
    return { policies };
  }

  /**
   * Edits one owner type's policy (AC-24): 404 `OWNER_TYPE_UNKNOWN`, 422
   * `OWNER_POLICY_INCONSISTENT`, 409 `OWNER_POLICY_IN_USE`, 409 `SELLABLE_LOCATIONS_EXIST`, 409
   * `STALE_SETTING`, 422 `REASON_REQUIRED`. Answers the row as it now stands and `changed`.
   */
  @Put(':ownerType')
  async update(
    @Param('ownerType') ownerTypeText: string,
    @Body(new ZodBodyPipe(PutOwnerPolicyBody)) body: PutOwnerPolicyBody,
    @CurrentAccess() access: Access,
  ): Promise<PutOwnerPolicyAnswer> {
    const ownerType = LocationOwnerType.safeParse(ownerTypeText);
    if (!ownerType.success) {
      throw new NotFoundException({ code: 'OWNER_TYPE_UNKNOWN', message: 'No such owner type' });
    }
    const { reason, expectedUpdatedAt, ...fields } = body;
    try {
      const { stored, changed } = await this.policies.updatePolicy(
        {
          ownerType: ownerType.data,
          fields,
          ...(reason !== undefined && { reason }),
          expectedUpdatedAt,
          actor: { userId: access.userId, hat: access.actingHat('settings.manage') },
        },
        this.locations,
      );
      const names = await this.staff.namesByIds(stored.updatedBy ? [stored.updatedBy] : []);
      return { policy: await this.view(stored, names, this.connection.db), changed };
    } catch (error) {
      throw ownerPolicyHttpError(error) ?? auditHttpError(error) ?? error;
    }
  }

  private async view(
    row: StoredOwnerPolicy,
    names: ReadonlyMap<string, string>,
    executor: Executor,
  ): Promise<OwnerPolicyView> {
    const { ownerType, ...attributes } = row.policy;
    const activeLocations = await this.locations.countActiveByOwnerType(ownerType, executor);
    // The brand's own row (the owner type that takes no party) is locked always.
    const locked = requiredPartyRole(ownerType) === null || activeLocations > 0;
    return {
      ...attributes,
      ownerType,
      lockedFields: locked ? [...OWNER_POLICY_LOCKED_FIELDS] : [],
      activeLocations,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy
        ? { id: row.updatedBy, name: names.get(row.updatedBy) ?? null }
        : null,
    };
  }
}
