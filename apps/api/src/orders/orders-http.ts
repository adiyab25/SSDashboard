import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ParseUUIDPipe,
  UnprocessableEntityException,
  type PipeTransform,
} from '@nestjs/common';
import { InvalidAmountError, InvalidTransition } from '@ssdashboard/contracts';
import type { Response } from 'express';
import type { z } from 'zod';
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
  if (error instanceof InvalidTransition) {
    return new ConflictException({
      code: 'INVALID_TRANSITION',
      message: error.message,
      machine: error.machine,
      from: error.from,
      to: error.to,
    });
  }
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
    case 'OrderLocked':
      return new ConflictException({ code: 'ORDER_LOCKED', message: error.message });
    case 'OrderStale':
      return new ConflictException({ code: 'ORDER_STALE', message: error.message });
    case 'OrderNeedsALine':
      return unprocessable('ORDER_NEEDS_A_LINE', error.message);
    case 'EditChangesPayment':
      return unprocessable('EDIT_CHANGES_PAYMENT', error.message);
    case 'EditOverpaid':
      return unprocessable('EDIT_OVERPAID', error.message);
    case 'EditInShopify':
      return new ConflictException({ code: 'EDIT_IN_SHOPIFY', message: error.message });
    case 'CancelInShopify':
      return new ConflictException({ code: 'CANCEL_IN_SHOPIFY', message: error.message });
    case 'WriteBackOpen':
      return new ConflictException({ code: 'WRITE_BACK_OPEN', message: error.message });
    case 'GiftNotAllowed':
      return new ForbiddenException({ code: 'GIFT_NOT_ALLOWED', message: error.message });
    case 'DuplicateTargetRequired':
      return unprocessable('DUPLICATE_TARGET_REQUIRED', error.message);
    case 'InvalidPhoneMain':
      return unprocessable('INVALID_PHONE', error.message);
    case 'OrderStoreMissing':
      logger.error('An order names a store that does not exist');
      return new InternalServerErrorException();
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

/** The body fields whose refusal answers 422 `REASON_INVALID` instead of `INVALID_BODY`. */
const REASON_FIELDS = new Set(['reasonCode', 'cancelReasonCode']);

/**
 * Validates the body of an order move with its contract schema (spec 0013 API surface): a reason
 * code outside its list answers 422 `REASON_INVALID`, anything else 422 `INVALID_BODY`, each
 * listing the failing paths. Messages are Zod's fixed text and never echo a typed value.
 */
export class OrderBodyPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  /** Takes the contract schema of the body. */
  constructor(private readonly schema: T) {}

  /** Returns the parsed body or throws the 422 answer. */
  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value ?? {});
    if (result.success) return result.data;
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    const reason = result.error.issues.some((issue) =>
      issue.path.some((part) => typeof part === 'string' && REASON_FIELDS.has(part)),
    );
    throw new UnprocessableEntityException({
      code: reason ? 'REASON_INVALID' : 'INVALID_BODY',
      message: reason ? 'The reason is not one of the listed reasons' : 'Some fields are not valid',
      issues,
    });
  }
}
