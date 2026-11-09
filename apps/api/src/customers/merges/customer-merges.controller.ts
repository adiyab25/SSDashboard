import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  CustomerMergeRequest,
  CustomerUndoMergeRequest,
  MergeSuggestionDismissRequest,
  MergeSuggestionListQuery,
  type CustomerMergeResponse,
  type CustomerUndoMergeResponse,
  type MergeSuggestionPage,
} from '@ssdashboard/contracts';
import { auditHttpError } from '../../audit/audit-http.js';
import type { AuthenticatedRequest } from '../../identity/sign-in/current-staff.js';
import type { Access } from '../../platform/access/access.js';
import { CurrentAccess } from '../../platform/access/current-access.decorator.js';
import { Permission } from '../../platform/access/permission.decorator.js';
import { Audience } from '../../platform/audience/audience.decorator.js';
import { RequiresModule } from '../../platform/modules/requires-module.decorator.js';
import { ZodQueryPipe } from '../../platform/zod-query.pipe.js';
import { CustomerBodyPipe, customersHttpError, notFoundIdPipe } from '../customers-http.js';
import { CustomerMerges, type MergeActor } from './customer-merges.service.js';
import { MergeSuggestions } from './merge-suggestions.service.js';

/** The person acting, under the hat that holds `customers.merge`. */
const mergeActor = (request: AuthenticatedRequest, access: Access): MergeActor => ({
  userId: request.staff.id,
  hat: access.actingHat('customers.merge'),
});

/** Maps a customers or audit refusal to its stable answer; anything else passes through. */
const httpError = (error: unknown): unknown => auditHttpError(error) ?? customersHttpError(error);

/**
 * The merge routes of spec 0014 (AC-6, AC-8, AC-9): merge, undo, the open suggestions list, and
 * dismiss. Declared before the `:id` profile route (its controller is listed after this one), so
 * `merge-suggestions` is never read as a customer id. Bodies hold ids and codes only.
 */
@Audience('staff')
@RequiresModule('customers')
@Controller('customers')
export class CustomerMergesController {
  /** Takes the merge and suggestion services. */
  constructor(
    private readonly merges: CustomerMerges,
    private readonly suggestions: MergeSuggestions,
  ) {}

  /**
   * Merges `mergedId` into `survivorId` (201 `{ mergeId, survivor }`). 404 `CUSTOMER_NOT_FOUND` or
   * `SUGGESTION_NOT_FOUND`; 409 `SAME_CUSTOMER`, `CUSTOMER_MERGED`, `CUSTOMER_CHANGED`,
   * `SUGGESTION_CLOSED`, `SUGGESTION_MISMATCH`; 422 `REASON_INVALID`.
   */
  @Permission('customers.merge')
  @Post('merges')
  @HttpCode(201)
  async merge(
    @Body(new CustomerBodyPipe(CustomerMergeRequest)) body: CustomerMergeRequest,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
  ): Promise<CustomerMergeResponse> {
    try {
      return await this.merges.merge(
        {
          survivorId: body.survivorId,
          mergedId: body.mergedId,
          ...(body.reasonCode === undefined ? {} : { reasonCode: body.reasonCode }),
          ...(body.suggestionId === undefined ? {} : { suggestionId: body.suggestionId }),
        },
        mergeActor(request, access),
      );
    } catch (error) {
      throw httpError(error);
    }
  }

  /**
   * Undoes a merge (200 `{ restoredId, survivorId }`). 404 `MERGE_NOT_FOUND`; 409
   * `MERGE_ALREADY_UNDONE`, `MERGE_NOT_LATEST`; 422 `REASON_REQUIRED`, `REASON_INVALID`.
   */
  @Permission('customers.merge')
  @Post('merges/:id/undo')
  @HttpCode(200)
  async undo(
    @Param('id', notFoundIdPipe('MERGE_NOT_FOUND')) id: string,
    @Body(new CustomerBodyPipe(CustomerUndoMergeRequest)) body: CustomerUndoMergeRequest,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
  ): Promise<CustomerUndoMergeResponse> {
    try {
      return await this.merges.undo(id.toLowerCase(), body.reasonCode, mergeActor(request, access));
    } catch (error) {
      throw httpError(error);
    }
  }

  /** The open suggestions, oldest first, keyset paged; 400 `INVALID_QUERY` or `INVALID_CURSOR`. */
  @Permission('customers.view')
  @Get('merge-suggestions')
  async list(
    @Query(new ZodQueryPipe(MergeSuggestionListQuery)) query: MergeSuggestionListQuery,
  ): Promise<MergeSuggestionPage> {
    try {
      return await this.suggestions.list(query);
    } catch (error) {
      throw httpError(error);
    }
  }

  /** Dismisses an open suggestion for good (204). 404 `SUGGESTION_NOT_FOUND`; 409 `SUGGESTION_CLOSED`; 422 `REASON_INVALID`. */
  @Permission('customers.merge')
  @Post('merge-suggestions/:id/dismiss')
  @HttpCode(204)
  async dismiss(
    @Param('id', notFoundIdPipe('SUGGESTION_NOT_FOUND')) id: string,
    @Body(new CustomerBodyPipe(MergeSuggestionDismissRequest)) body: MergeSuggestionDismissRequest,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
  ): Promise<void> {
    try {
      await this.suggestions.dismiss(
        id.toLowerCase(),
        body.reasonCode,
        mergeActor(request, access),
      );
    } catch (error) {
      throw httpError(error);
    }
  }
}
