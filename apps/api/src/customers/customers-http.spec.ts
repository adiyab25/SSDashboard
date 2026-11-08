import type { BadRequestException } from '@nestjs/common';
import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { customersHttpError } from './customers-http.js';
import { CustomersError } from './customers.errors.js';

describe('customersHttpError', () => {
  it('maps each domain error to the status and stable code of the API table', () => {
    const notFound = customersHttpError(new CustomersError('CUSTOMER_NOT_FOUND', 'x'));
    const phone = customersHttpError(new CustomersError('INVALID_PHONE', 'x'));
    const cursor = customersHttpError(new CustomersError('INVALID_CURSOR', 'x'));
    const channel = customersHttpError(new CustomersError('INVALID_CHANNEL_CUSTOMER', 'x'));

    expect(notFound).toBeInstanceOf(NotFoundException);
    expect((phone as BadRequestException).getResponse()).toMatchObject({ code: 'INVALID_PHONE' });
    expect((cursor as BadRequestException).getResponse()).toMatchObject({ code: 'INVALID_CURSOR' });
    expect(channel).toBeInstanceOf(UnprocessableEntityException);
  });

  it('keeps the fixed message and never adds the input', () => {
    const answer = customersHttpError(
      new CustomersError('INVALID_PHONE', 'The text is not a valid phone number'),
    ) as BadRequestException;

    expect(JSON.stringify(answer.getResponse())).toBe(
      '{"code":"INVALID_PHONE","message":"The text is not a valid phone number"}',
    );
  });

  it('returns an error that is not a customers error unchanged', () => {
    const other = new Error('boom');

    expect(customersHttpError(other)).toBe(other);
  });
});
