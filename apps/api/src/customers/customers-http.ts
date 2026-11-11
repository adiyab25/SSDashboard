import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ParseUUIDPipe,
  UnprocessableEntityException,
  type PipeTransform,
} from '@nestjs/common';
import type { z } from 'zod';
import { CustomersError } from './customers.errors.js';

/**
 * Maps a customers domain error to the stable HTTP answer of spec 0014's API table; any other
 * error is returned unchanged. The messages are fixed text and never echo a phone or a name.
 */
export function customersHttpError(error: unknown): unknown {
  if (!(error instanceof CustomersError)) return error;
  switch (error.code) {
    case 'CUSTOMER_NOT_FOUND':
    case 'SUGGESTION_NOT_FOUND':
    case 'MERGE_NOT_FOUND':
      return new NotFoundException({ code: error.code, message: error.message });
    case 'INVALID_PHONE':
    case 'INVALID_QUERY':
    case 'INVALID_CURSOR':
      return new BadRequestException({ code: error.code, message: error.message });
    case 'INVALID_CHANNEL_CUSTOMER':
      return new UnprocessableEntityException({ code: error.code, message: error.message });
    case 'SAME_CUSTOMER':
    case 'CUSTOMER_MERGED':
    case 'CUSTOMER_CHANGED':
    case 'SUGGESTION_CLOSED':
    case 'SUGGESTION_MISMATCH':
    case 'MERGE_ALREADY_UNDONE':
    case 'MERGE_NOT_LATEST':
    case 'STALE_RECORD':
    case 'NOT_FLAGGED':
      return new ConflictException({ code: error.code, message: error.message });
  }
}

/** A malformed customer id is a customer that does not exist: 404 `CUSTOMER_NOT_FOUND`, never 400. */
export const customerIdPipe = (): ParseUUIDPipe =>
  new ParseUUIDPipe({
    exceptionFactory: () =>
      new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'No customer has that id' }),
  });

/** A malformed id of `code`'s kind is one that does not exist: 404 with that code, never 400. */
export const notFoundIdPipe = (code: 'MERGE_NOT_FOUND' | 'SUGGESTION_NOT_FOUND'): ParseUUIDPipe =>
  new ParseUUIDPipe({
    exceptionFactory: () => new NotFoundException({ code, message: 'Not found' }),
  });

/**
 * Parses a merge, undo, dismiss, or flag body against its contract (spec 0014 API table): a missing
 * (absent, null, or empty) `reasonCode` the schema requires is 422 `REASON_REQUIRED`; an unlisted
 * one, or a null or empty one for an optional field, 422 `REASON_INVALID`; and any
 * other bad body 422 `VALIDATION_FAILED` naming the failing paths. Never echoes a value.
 */
export class CustomerBodyPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  /** Takes the contract schema of the body. */
  constructor(private readonly schema: T) {}

  /** Returns the parsed body, or throws the answer the API table names. */
  transform(value: unknown): z.output<T> {
    const body: unknown = value ?? {};
    const result = this.schema.safeParse(body);
    if (result.success) return result.data;
    const paths = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    // A flag note over its cap has its own code (spec 0014 API table); the note is never echoed.
    if (
      paths.length === 1 &&
      paths[0] === 'note' &&
      result.error.issues.every((issue) => issue.code === 'too_big')
    ) {
      throw new UnprocessableEntityException({
        code: 'NOTE_TOO_LONG',
        message: 'The note is too long',
      });
    }
    if (paths.length === 1 && paths[0] === 'reasonCode') {
      const given =
        typeof body === 'object' && body !== null && 'reasonCode' in body
          ? (body as { reasonCode?: unknown }).reasonCode
          : undefined;
      // Missing is REASON_REQUIRED only where the schema requires the code; a null or empty code
      // for an optional field is an unlisted one (REASON_INVALID).
      const missing = given === undefined || given === null || given === '';
      if (missing && this.requiresReason(body)) {
        throw new UnprocessableEntityException({
          code: 'REASON_REQUIRED',
          message: 'A reason code is required',
        });
      }
      throw new UnprocessableEntityException({
        code: 'REASON_INVALID',
        message: 'The reason code is not one this action takes',
      });
    }
    throw new UnprocessableEntityException({
      code: 'VALIDATION_FAILED',
      message: 'Some fields are not valid',
      issues: paths.map((path) => ({ path })),
    });
  }

  /** Whether the schema refuses this body with its `reasonCode` left out: the field is required. */
  private requiresReason(body: unknown): boolean {
    if (typeof body !== 'object' || body === null) return true;
    const { reasonCode: _omitted, ...rest } = body as Record<string, unknown>;
    const result = this.schema.safeParse(rest);
    return !result.success && result.error.issues.some((issue) => issue.path[0] === 'reasonCode');
  }
}
