import type { BadRequestException } from '@nestjs/common';
import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { CustomerMergeRequest, CustomerUndoMergeRequest } from '@ssdashboard/contracts';
import { describe, expect, it } from 'vitest';
import { CustomerBodyPipe, customersHttpError } from './customers-http.js';
import { CustomersError, MergeAlreadyUndone, MergeNotLatest } from './customers.errors.js';

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

  it('maps the merge refusals to 409 and the unknown merge or suggestion to 404', () => {
    for (const error of [
      new CustomersError('SAME_CUSTOMER', 'x'),
      new CustomersError('CUSTOMER_MERGED', 'x'),
      new CustomersError('CUSTOMER_CHANGED', 'x'),
      new CustomersError('SUGGESTION_CLOSED', 'x'),
      new CustomersError('SUGGESTION_MISMATCH', 'x'),
      new MergeAlreadyUndone(),
      new MergeNotLatest(),
    ]) {
      const answer = customersHttpError(error) as ConflictException;
      expect(answer).toBeInstanceOf(ConflictException);
      expect(answer.getResponse()).toMatchObject({ code: error.code });
    }
    for (const code of ['MERGE_NOT_FOUND', 'SUGGESTION_NOT_FOUND'] as const) {
      expect(customersHttpError(new CustomersError(code, 'x'))).toBeInstanceOf(NotFoundException);
    }
  });
});

describe('CustomerBodyPipe', () => {
  const survivorId = '01937f3a-0000-7000-8000-00000000000a';
  const mergedId = '01937f3a-0000-7000-8000-00000000000b';
  const codeOf = (run: () => unknown): unknown => {
    try {
      run();
    } catch (error) {
      return ((error as UnprocessableEntityException).getResponse() as { code: string }).code;
    }
    return 'passed';
  };

  it('answers REASON_REQUIRED for a missing required code and REASON_INVALID for an unlisted one', () => {
    const undo = new CustomerBodyPipe(CustomerUndoMergeRequest);

    expect(codeOf(() => undo.transform({}))).toBe('REASON_REQUIRED');
    expect(codeOf(() => undo.transform(undefined))).toBe('REASON_REQUIRED');
    expect(codeOf(() => undo.transform({ reasonCode: null }))).toBe('REASON_REQUIRED');
    expect(codeOf(() => undo.transform({ reasonCode: 'call_01012345678' }))).toBe('REASON_INVALID');
    expect(undo.transform({ reasonCode: 'wrong_merge' })).toEqual({ reasonCode: 'wrong_merge' });
  });

  it('takes a merge without a reason, refuses an unlisted one, and names only paths for other faults', () => {
    const merge = new CustomerBodyPipe(CustomerMergeRequest);

    expect(codeOf(() => merge.transform({ survivorId, mergedId }))).toBe('passed');
    expect(codeOf(() => merge.transform({ survivorId, mergedId, reasonCode: 'nope' }))).toBe(
      'REASON_INVALID',
    );
    // An optional code sent as null or empty is an unlisted code, not a missing required one.
    expect(codeOf(() => merge.transform({ survivorId, mergedId, reasonCode: null }))).toBe(
      'REASON_INVALID',
    );
    expect(codeOf(() => merge.transform({ survivorId, mergedId, reasonCode: '' }))).toBe(
      'REASON_INVALID',
    );
    let body = '';
    try {
      merge.transform({ survivorId: 'Zzsentinel', mergedId });
    } catch (error) {
      body = JSON.stringify((error as UnprocessableEntityException).getResponse());
    }
    expect(body).toContain('VALIDATION_FAILED');
    expect(body).not.toContain('Zzsentinel');
  });
});
