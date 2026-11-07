import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/**
 * Validates a query string against a contract schema; a bad query is 400 `INVALID_QUERY`, or 400
 * with the code an endpoint's spec names instead (the audit list answers `INVALID_FILTER`).
 */
export class ZodQueryPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  /** Takes the contract schema to validate against and the stable error code of a bad query. */
  constructor(
    private readonly schema: T,
    private readonly code = 'INVALID_QUERY',
  ) {}

  /** Returns the parsed query, or throws 400 with the pipe's code. */
  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({ code: this.code, issues: result.error.issues });
    }
    return result.data;
  }
}
