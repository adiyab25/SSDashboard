import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateSeasonRequest,
  GroupingListQuery,
  Season,
  SeasonListResponse,
  UpdateSeasonRequest,
} from '@ssdashboard/contracts';
import type { DatabaseConnection } from '@ssdashboard/db';
import type { z } from 'zod';
import { AuditService } from '../../audit/audit.service.js';
import { DATABASE } from '../../database/database.module.js';
import type { CatalogCaller } from '../catalog-caller.js';
import { StyleGroupingStore, type GroupingRow } from '../style-grouping-store.js';

const toSeason = (row: GroupingRow): Season => ({ ...row });

/**
 * The brand's seasons (spec 0012, AC-6): list, create, edit with the stale check, archive,
 * unarchive, and delete only while no style or cost record holds one. The seeded `CORE` season is
 * renamed but never archived, deleted, or recoded. Every write records its `season.*` entry in
 * its own transaction. Never gives a season to a style (styles do, through
 * `CatalogService.assignableGrouping`).
 */
@Injectable()
export class SeasonsService {
  private readonly store: StyleGroupingStore;

  /** Takes the app connection and the audit writer. */
  constructor(
    @Inject(DATABASE) connection: DatabaseConnection,
    @Inject(AuditService) audit: AuditService,
  ) {
    this.store = new StyleGroupingStore(connection, audit, {
      table: 'seasons',
      recordType: 'season',
      noun: 'Season',
      protectedCode: 'CORE',
      codeTaken: 'SeasonCodeTaken',
      protectedError: 'SeasonProtected',
      codeConstraint: 'seasons_code_unique',
      hasDates: true,
      actions: {
        created: 'season.created',
        edited: 'season.edited',
        archived: 'season.archived',
        unarchived: 'season.unarchived',
        deleted: 'season.deleted',
      },
    });
  }

  /** One page of seasons ordered by code. */
  async list(query: GroupingListQuery): Promise<SeasonListResponse> {
    const page = await this.store.list(query);
    return { items: page.items.map(toSeason), nextCursor: page.nextCursor };
  }

  /** Adds a season; a taken code is `SeasonCodeTaken`. */
  async create(
    input: z.output<typeof CreateSeasonRequest>,
    caller: CatalogCaller,
  ): Promise<Season> {
    return toSeason(await this.store.create(input, caller));
  }

  /** Edits code, name, and dates with the stale check. */
  async update(
    id: string,
    input: z.output<typeof UpdateSeasonRequest>,
    caller: CatalogCaller,
  ): Promise<Season> {
    return toSeason(await this.store.update(id, input, caller));
  }

  /** Archives (`archived: true`) or unarchives a season. */
  async setArchived(id: string, archived: boolean, caller: CatalogCaller): Promise<Season> {
    return toSeason(await this.store.setArchived(id, archived, caller));
  }

  /** Deletes an unreferenced season (`InUse` otherwise). */
  async remove(id: string, caller: CatalogCaller): Promise<void> {
    await this.store.remove(id, caller);
  }
}
