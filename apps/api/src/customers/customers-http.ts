import {
  BadRequestException,
  NotFoundException,
  ParseUUIDPipe,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CustomersError } from './customers.errors.js';

/**
 * Maps a customers domain error to the stable HTTP answer of spec 0014's API table; any other
 * error is returned unchanged. The messages are fixed text and never echo a phone or a name.
 */
export function customersHttpError(error: unknown): unknown {
  if (!(error instanceof CustomersError)) return error;
  switch (error.code) {
    case 'CUSTOMER_NOT_FOUND':
      return new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: error.message });
    case 'INVALID_PHONE':
    case 'INVALID_QUERY':
    case 'INVALID_CURSOR':
      return new BadRequestException({ code: error.code, message: error.message });
    case 'INVALID_CHANNEL_CUSTOMER':
      return new UnprocessableEntityException({ code: error.code, message: error.message });
  }
}

/** A malformed customer id is a customer that does not exist: 404 `CUSTOMER_NOT_FOUND`, never 400. */
export const customerIdPipe = (): ParseUUIDPipe =>
  new ParseUUIDPipe({
    exceptionFactory: () =>
      new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'No customer has that id' }),
  });
