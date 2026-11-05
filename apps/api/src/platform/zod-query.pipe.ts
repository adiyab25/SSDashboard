import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/** Validates a query string against a contract schema; a bad query is 400 `INVALID_QUERY`. */
export class ZodQueryPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  /** Takes the contract schema to validate against. */
  constructor(private readonly schema: T) {}

  /** Returns the parsed query, or throws 400 `INVALID_QUERY`. */
  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({ code: 'INVALID_QUERY', issues: result.error.issues });
    }
    return result.data;
  }
}
