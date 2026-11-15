import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InvalidAmountError } from '@ssdashboard/contracts';
import type { Response } from 'express';
import { InvalidCursorError as KeysetCursorError } from '../platform/keyset-cursor.js';
import { DocumentPrefixesUnreadable, NumberingError } from '../platform/numbering.service.js';
import { LedgerError } from './ledger/ledger.errors.js';
import { OnlineStockError } from './online-stock/online-stock.errors.js';
import { InvalidCursorError as LocationCursorError } from './locations/locations.service.js';

const logger = new Logger('LedgerHttp');

/** Seconds a caller waits before retrying a busy posting (AC-14). */
export const BUSY_RETRY_AFTER_SECONDS = 2;

const unprocessable = (code: string, message: string) =>
  new UnprocessableEntityException({ code, message });

/**
 * The one mapping from ledger and money errors to HTTP answers (spec 0006, Error mapping), used
 * by every inventory controller. A `BUSY` answer also sets `Retry-After` on `response`. Anything
 * not listed is returned unchanged; an unmapped ledger code or a numbering error is a bug: 500.
 */
export function ledgerHttpError(error: unknown, response?: Response): unknown {
  if (error instanceof HttpException) return error;
  if (error instanceof LedgerError) {
    switch (error.code) {
      case 'InvalidInput':
        return new BadRequestException({ code: 'INVALID_INPUT', message: error.message });
      case 'InvalidCost':
        return unprocessable('INVALID_INPUT', error.message);
      case 'UnknownReference':
        return unprocessable('UNKNOWN_REFERENCE', error.message);
      case 'Archived':
        return unprocessable('ARCHIVED', error.message);
      case 'NotStockable':
      case 'TrackingMismatch':
        return unprocessable('NOT_STOCKABLE', error.message);
      case 'FutureDate':
        return unprocessable('FUTURE_DATE', error.message);
      case 'PeriodLocked':
        return unprocessable('PERIOD_LOCKED', error.message);
      case 'InsufficientStock':
        return new ConflictException({ code: 'INSUFFICIENT_STOCK', message: error.message });
      case 'IdempotencyConflict':
        return new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: error.message });
      case 'AlreadyReversed':
        return new ConflictException({ code: 'ALREADY_VOIDED', message: error.message });
      // The stored lock date fails its schema: postings stop until a manager sets it again.
      case 'LockDateUnreadable':
        return new ConflictException({ code: 'LOCK_DATE_UNREADABLE', message: error.message });
      case 'LockTimeout':
        logger.warn('Answered 503 BUSY: a ledger lock wait timed out');
        response?.setHeader('Retry-After', String(BUSY_RETRY_AFTER_SECONDS));
        return new HttpException(
          { code: 'BUSY', message: 'Stock is busy with another posting. Try again.' },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      // A posting named a reservation that is not this line's open one (security review L4).
      case 'ReservationMismatch':
        return new ConflictException({ code: 'RESERVATION_MISMATCH', message: error.message });
      case 'CannotReverseReversal':
      case 'NotFound':
      case 'DuplicateReservation':
      case 'ReservationClosed':
      case 'QuantityTooLarge':
      case 'DiscrepancyClosed':
      case 'NotRebuildable':
      case 'NestedStockTransaction':
        logger.error(`Unmapped ledger error ${error.code}: ${error.message}`);
        return new InternalServerErrorException();
    }
  }
  if (error instanceof OnlineStockError) {
    // Only the connector reads online stock through code; a route that surfaces it asks to go online first.
    if (error.code === 'NotOnlineCandidate') {
      return unprocessable('NOT_ONLINE_CANDIDATE', error.message);
    }
    return new ConflictException({ code: 'NO_ONLINE_LOCATION', message: error.message });
  }
  if (error instanceof InvalidAmountError) {
    return unprocessable('AMOUNT_TOO_LARGE', error.message);
  }
  if (error instanceof KeysetCursorError || error instanceof LocationCursorError) {
    return new BadRequestException({ code: 'INVALID_QUERY', message: error.message });
  }
  // The stored prefixes fail their schema: documents stop until a manager sets them again.
  if (error instanceof DocumentPrefixesUnreadable) {
    return new ConflictException({ code: 'DOCUMENT_PREFIXES_UNREADABLE', message: error.message });
  }
  if (error instanceof NumberingError) {
    logger.error(error.message);
    return new InternalServerErrorException();
  }
  return error;
}
