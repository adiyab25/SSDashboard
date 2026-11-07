import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
  type PipeTransform,
} from '@nestjs/common';
import {
  CreateStockReceiptRequest,
  StockReceiptListQuery,
  VoidStockReceiptRequest,
  type StockReceiptDetail,
  type StockReceiptListResponse,
} from '@ssdashboard/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { auditHttpError } from '../../audit/audit-http.js';
import type { AuthenticatedRequest } from '../../identity/sign-in/current-staff.js';
import { Roles } from '../../identity/sign-in/roles.decorator.js';
import { Audience } from '../../platform/audience/audience.decorator.js';
import { ZodQueryPipe } from '../../platform/zod-query.pipe.js';
import { INVALID_INPUT, ZodBodyPipe } from '../../platform/zod-body.pipe.js';
import { ledgerHttpError } from '../ledger-http.js';
import { ReceiptError, ReceiptsService, type ReceiptCaller } from './receipts.service.js';

const IdempotencyKey = z.uuid();

/** A malformed id is a receipt that does not exist: 404, never 400. */
const receiptId = () =>
  new ParseUUIDPipe({
    exceptionFactory: () => new NotFoundException({ code: 'NOT_FOUND', message: 'Not found' }),
  });

function receiptHttpError(error: unknown, response?: Response): unknown {
  if (error instanceof ReceiptError) {
    switch (error.code) {
      case 'NotFound':
        return new NotFoundException({ code: 'NOT_FOUND', message: error.message });
      case 'IdempotencyConflict':
        return new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: error.message });
      case 'InvalidLines':
        return new UnprocessableEntityException({
          code: 'INVALID_LINES',
          message: error.message,
          lineErrors: error.lineErrors,
        });
      case 'InvalidLocation':
        return new UnprocessableEntityException({
          code: 'INVALID_LOCATION',
          message: error.message,
        });
      case 'FutureDate':
        return new UnprocessableEntityException({ code: 'FUTURE_DATE', message: error.message });
      case 'ReasonRequired':
        return new UnprocessableEntityException({
          code: 'REASON_REQUIRED',
          message: error.message,
        });
      case 'AlreadyVoided':
        return new ConflictException({ code: 'ALREADY_VOIDED', message: error.message });
      case 'InsufficientStock':
        return new ConflictException({
          code: 'INSUFFICIENT_STOCK',
          message: error.message,
          skuIds: error.skuIds,
        });
    }
  }
  return ledgerHttpError(error, response);
}

type VoidBody = z.output<typeof VoidStockReceiptRequest>;

/** True for a void body that names no reason, or a blank one, and nothing else. */
function isMissingReason(body: unknown): boolean {
  if (body === undefined || body === null) return true;
  if (typeof body !== 'object' || Array.isArray(body)) return false;
  if (Object.keys(body).some((key) => key !== 'reason')) return false;
  const reason: unknown = (body as { reason?: unknown }).reason;
  return reason === undefined || reason === null || (typeof reason === 'string' && !reason.trim());
}

/**
 * The void body. A missing or blank reason is passed on empty, so the audit reason policy refuses
 * it inside the void's transaction (spec 0010, AC-5: 422 `REASON_REQUIRED`, nothing changes);
 * every other body is validated by the contract (400 `INVALID_INPUT`).
 */
class VoidBodyPipe implements PipeTransform<unknown, VoidBody> {
  private readonly contract = new ZodBodyPipe(VoidStockReceiptRequest, INVALID_INPUT);

  /** Returns `{ reason: '' }` for a missing reason, otherwise the contract's parse. */
  transform(value: unknown): VoidBody {
    if (isMissingReason(value)) return { reason: '' };
    return this.contract.transform(value);
  }
}

const callerOf = (request: AuthenticatedRequest): ReceiptCaller => ({
  id: request.staff.id,
  role: request.staff.role,
});

/** Stock receipts (spec 0006). Any signed in person posts and reads; cost fields are admin only. */
@Audience('staff')
@Controller('stock-receipts')
export class ReceiptsController {
  /** Takes the receipts service. */
  constructor(private readonly receipts: ReceiptsService) {}

  /** 201 when created, 200 when the same key and body were posted before (AC-6). */
  @Post()
  async create(
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodBodyPipe(CreateStockReceiptRequest, INVALID_INPUT))
    body: z.output<typeof CreateStockReceiptRequest>,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StockReceiptDetail> {
    const id = IdempotencyKey.safeParse(key);
    if (!id.success) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Send an Idempotency-Key header holding a UUID',
      });
    }
    try {
      const { receipt, created } = await this.receipts.post(
        id.data.toLowerCase(),
        body,
        callerOf(request),
      );
      response.status(created ? 201 : 200);
      return receipt;
    } catch (error) {
      throw receiptHttpError(error, response);
    }
  }

  /** Newest first, 50 a page, by location and number or reference (AC-12). */
  @Get()
  async list(
    @Query(new ZodQueryPipe(StockReceiptListQuery)) query: StockReceiptListQuery,
  ): Promise<StockReceiptListResponse> {
    try {
      return await this.receipts.list(query);
    } catch (error) {
      throw receiptHttpError(error);
    }
  }

  /**
   * Admin only: posts a reversal, marks the receipt voided, and records the audit entry, all in
   * one transaction (AC-8; spec 0010, AC-2). A missing reason is 422 `REASON_REQUIRED`.
   */
  @Roles('admin')
  @Post(':id/void')
  @HttpCode(200)
  async void(
    @Param('id', receiptId()) id: string,
    @Body(new VoidBodyPipe()) body: VoidBody,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StockReceiptDetail> {
    try {
      return await this.receipts.void(id, body.reason, callerOf(request));
    } catch (error) {
      throw auditHttpError(error) ?? receiptHttpError(error, response);
    }
  }

  /** Reads one receipt; cost fields are left out unless the caller is an admin. */
  @Get(':id')
  async get(
    @Param('id', receiptId()) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<StockReceiptDetail> {
    try {
      return await this.receipts.get(id, callerOf(request));
    } catch (error) {
      throw receiptHttpError(error);
    }
  }
}
