import {
  ConflictException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ParseUUIDPipe,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InvalidAmountError } from '@ssdashboard/contracts';
import type { Response } from 'express';
import { DocumentPrefixesUnreadable } from '../platform/numbering.service.js';
import { OrdersError } from './orders.errors.js';

const logger = new Logger('OrdersHttp');

/** Seconds a caller waits before retrying a busy order change. */
export const ORDERS_BUSY_RETRY_AFTER_SECONDS = 2;

const unprocessable = (code: string, message: string) =>
  new UnprocessableEntityException({ code, message });

/**
 * Maps an orders domain error to the stable HTTP answer of spec 0013's API table; any other error
 * is returned unchanged. A lock wait past its cap answers 503 `BUSY` with `Retry-After`. The
 * messages are fixed text and never echo an address, phone, or note.
 */
export function ordersHttpError(error: unknown, response?: Response): unknown {
  if (error instanceof HttpException) return error;
  if (error instanceof InvalidAmountError) return unprocessable('INVALID_BODY', error.message);
  if (error instanceof DocumentPrefixesUnreadable) {
    return new ConflictException({ code: 'DOCUMENT_PREFIXES_UNREADABLE', message: error.message });
  }
  if (!(error instanceof OrdersError)) return error;
  switch (error.code) {
    case 'OrderNotFound':
      return new NotFoundException({ code: 'ORDER_NOT_FOUND', message: error.message });
    case 'OrderNumberTaken':
      return new ConflictException({ code: 'ORDER_NUMBER_TAKEN', message: error.message });
    case 'StoreNotInternal':
      return unprocessable('STORE_NOT_INTERNAL', error.message);
    case 'ChannelNotAllowed':
      return unprocessable('CHANNEL_NOT_ALLOWED', error.message);
    case 'VariantUnknown':
      return unprocessable('VARIANT_UNKNOWN', error.message);
    case 'PartialPrepaymentNotSupported':
      return unprocessable('PARTIAL_PREPAYMENT_NOT_SUPPORTED', error.message);
    case 'RelatedOrderState':
      return unprocessable('RELATED_ORDER_STATE', error.message);
    case 'RelatedOrderUnknown':
      return unprocessable('RELATED_ORDER_UNKNOWN', error.message);
    case 'GiftMustStayFree':
      return unprocessable('GIFT_MUST_STAY_FREE', error.message);
    case 'InvalidPhoneAlt':
      return unprocessable('INVALID_PHONE_ALT', error.message);
    case 'InvalidOrderInput':
      return unprocessable('INVALID_BODY', error.message);
    case 'LineFullyDiscounted':
      return unprocessable('LINE_FULLY_DISCOUNTED', error.message);
    case 'RelatedOrderOtherCustomer':
      return unprocessable('RELATED_ORDER_OTHER_CUSTOMER', error.message);
    case 'AlreadyReopened':
      return new ConflictException({ code: 'ALREADY_REOPENED', message: error.message });
    case 'TransactionNested':
      logger.error('A nested OrderTransactions.run was refused');
      return new InternalServerErrorException();
    case 'LockTimeout':
      logger.warn('Answered 503 BUSY: an order lock wait timed out');
      response?.setHeader('Retry-After', String(ORDERS_BUSY_RETRY_AFTER_SECONDS));
      return new HttpException(
        { code: 'BUSY', message: error.message },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    default: {
      const unreachable: never = error.code;
      return unreachable;
    }
  }
}

/** A malformed order id is an order that does not exist: 404 `ORDER_NOT_FOUND`, never 400. */
export const orderIdPipe = (): ParseUUIDPipe =>
  new ParseUUIDPipe({
    exceptionFactory: () =>
      new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'No order has that id' }),
  });
