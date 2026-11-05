import { HttpException, UnprocessableEntityException, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/** How a pipe answers a bad body: the HTTP status and the stable error code. */
export interface ZodBodyPipeOptions {
  /** Default 422. */
  status?: number;
  /** Default `VALIDATION_FAILED`. */
  code?: string;
}

/**
 * Validates a request body against a contract schema. A bad body is 422 `VALIDATION_FAILED`
 * unless the endpoint's spec names another answer (spec 0006 uses 400 `INVALID_INPUT`).
 */
export class ZodBodyPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  /** Takes the contract schema and optional answer overrides. */
  constructor(
    private readonly schema: T,
    private readonly options: ZodBodyPipeOptions = {},
  ) {}

  /**
   * Returns the parsed body, or throws the HTTP error listing each failing field. A missing body
   * is validated as an empty object.
   */
  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value ?? {});
    if (!result.success) {
      const body = {
        code: this.options.code ?? 'VALIDATION_FAILED',
        message: 'Some fields are not valid',
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      };
      if (this.options.status === undefined) throw new UnprocessableEntityException(body);
      throw new HttpException(body, this.options.status);
    }
    return result.data;
  }
}

/** The body answer spec 0006 names for every inventory and catalog write. */
export const INVALID_INPUT: ZodBodyPipeOptions = { status: 400, code: 'INVALID_INPUT' };
