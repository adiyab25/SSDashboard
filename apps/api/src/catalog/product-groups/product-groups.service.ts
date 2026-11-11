import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateProductGroupRequest,
  GroupingListQuery,
  ProductGroup,
  ProductGroupListResponse,
  UpdateProductGroupRequest,
} from '@ssdashboard/contracts';
import type { DatabaseConnection } from '@ssdashboard/db';
import type { z } from 'zod';
import { AuditService } from '../../audit/audit.service.js';
import { DATABASE } from '../../database/database.module.js';
import type { CatalogCaller } from '../catalog-caller.js';
import { StyleGroupingStore, type GroupingRow } from '../style-grouping-store.js';

const toGroup = ({ startsOn: _startsOn, endsOn: _endsOn, ...row }: GroupingRow): ProductGroup =>
  row;

/**
 * The brand's product groups (spec 0012, AC-7): the same rules as seasons without dates. The
 * seeded `MAIN` group is renamed but never archived, deleted, or recoded. Every write records its
 * `product_group.*` entry in its own transaction. Never gives a group to a style (styles do,
 * through `CatalogService.assignableGrouping`).
 */
@Injectable()
export class ProductGroupsService {
  private readonly store: StyleGroupingStore;

  /** Takes the app connection and the audit writer. */
  constructor(
    @Inject(DATABASE) connection: DatabaseConnection,
    @Inject(AuditService) audit: AuditService,
  ) {
    this.store = new StyleGroupingStore(connection, audit, {
      table: 'product_groups',
      recordType: 'product_group',
      noun: 'Product group',
      protectedCode: 'MAIN',
      codeTaken: 'ProductGroupCodeTaken',
      protectedError: 'ProductGroupProtected',
      codeConstraint: 'product_groups_code_unique',
      hasDates: false,
      actions: {
        created: 'product_group.created',
        edited: 'product_group.edited',
        archived: 'product_group.archived',
        unarchived: 'product_group.unarchived',
        deleted: 'product_group.deleted',
      },
    });
  }

  /** One page of product groups ordered by code. */
  async list(query: GroupingListQuery): Promise<ProductGroupListResponse> {
    const page = await this.store.list(query);
    return { items: page.items.map(toGroup), nextCursor: page.nextCursor };
  }

  /** Adds a product group; a taken code is `ProductGroupCodeTaken`. */
  async create(
    input: z.output<typeof CreateProductGroupRequest>,
    caller: CatalogCaller,
  ): Promise<ProductGroup> {
    return toGroup(await this.store.create(input, caller));
  }

  /** Edits code and name with the stale check. */
  async update(
    id: string,
    input: z.output<typeof UpdateProductGroupRequest>,
    caller: CatalogCaller,
  ): Promise<ProductGroup> {
    return toGroup(await this.store.update(id, input, caller));
  }

  /** Archives (`archived: true`) or unarchives a product group. */
  async setArchived(id: string, archived: boolean, caller: CatalogCaller): Promise<ProductGroup> {
    return toGroup(await this.store.setArchived(id, archived, caller));
  }

  /** Deletes an unreferenced product group (`InUse` otherwise). */
  async remove(id: string, caller: CatalogCaller): Promise<void> {
    await this.store.remove(id, caller);
  }
}
