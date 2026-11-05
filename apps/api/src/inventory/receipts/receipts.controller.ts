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
import type { AuthenticatedRequest } from '../../auth/current-staff.js';
import { Roles } from '../../auth/roles.decorator.js';
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

  /** Admin only: posts a reversal and marks the receipt voided (AC-8). */
  @Roles('admin')
  @Post(':id/void')
  @HttpCode(200)
  async void(
    @Param('id', receiptId()) id: string,
    @Body(new ZodBodyPipe(VoidStockReceiptRequest, INVALID_INPUT))
    body: z.output<typeof VoidStockReceiptRequest>,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StockReceiptDetail> {
    try {
      return await this.receipts.void(id, body.reason, callerOf(request));
    } catch (error) {
      throw receiptHttpError(error, response);
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
