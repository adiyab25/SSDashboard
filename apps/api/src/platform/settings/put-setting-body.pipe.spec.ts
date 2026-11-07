import { UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { PutSettingBodyPipe } from './put-setting-body.pipe.js';

const pipe = new PutSettingBodyPipe();

/** The 422 answer body the pipe throws for this request body. */
function refusal(body: unknown): Record<string, unknown> {
  try {
    pipe.transform(body);
  } catch (error) {
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    return (error as UnprocessableEntityException).getResponse() as Record<string, unknown>;
  }
  throw new Error('the pipe accepted the body');
}

// Spec 0009 AC-3; security review S3 and S4.
describe('PutSettingBodyPipe', () => {
  it('passes a well formed body, reason trimmed', () => {
    expect(pipe.transform({ value: [1], reason: ' why ', expectedUpdatedAt: null })).toEqual({
      value: [1],
      reason: 'why',
      expectedUpdatedAt: null,
    });
  });

  it('answers SETTING_INVALID for a value nested deeper than 16 levels', () => {
    let value: unknown = 1;
    for (let level = 0; level < 5_000; level += 1) value = { a: value };
    expect(refusal({ value, expectedUpdatedAt: null })).toMatchObject({
      code: 'SETTING_INVALID',
      issues: [{ path: 'value' }],
    });
  });

  it('answers REASON_TOO_LONG for a reason over 500 characters', () => {
    expect(refusal({ value: 1, reason: 'x'.repeat(501), expectedUpdatedAt: null })).toMatchObject({
      code: 'REASON_TOO_LONG',
    });
  });

  it('answers VALIDATION_FAILED for a missing expectedUpdatedAt', () => {
    expect(refusal({ value: 1 })).toMatchObject({
      code: 'VALIDATION_FAILED',
      issues: [{ path: 'expectedUpdatedAt' }],
    });
  });
});
