import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CreateStockReceiptRequest, type StockReceiptDetail } from '@ssdashboard/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../../auth/current-staff.js';
import { INVALID_INPUT, ZodBodyPipe } from '../../platform/zod-body.pipe.js';
import { ledgerHttpError } from '../ledger-http.js';
import { ReceiptError, ReceiptsService, type ReceiptCaller } from './receipts.service.js';

const IdempotencyKey = z.uuid();

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
    }
  }
  return ledgerHttpError(error, response);
}

const callerOf = (request: AuthenticatedRequest): ReceiptCaller => ({
  id: request.staff.id,
  role: request.staff.role,
});

/** Stock receipts (spec 0006). Any signed in person posts and reads; cost fields are admin only. */
@Controller('stock-receipts')
export class ReceiptsController {
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

  @Get(':id')
  async get(
    @Param(
      'id',
      new ParseUUIDPipe({
        exceptionFactory: () => new NotFoundException({ code: 'NOT_FOUND', message: 'Not found' }),
      }),
    )
    id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<StockReceiptDetail> {
    try {
      return await this.receipts.get(id, callerOf(request));
    } catch (error) {
      throw receiptHttpError(error);
    }
  }
}
