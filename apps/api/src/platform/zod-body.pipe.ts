import { UnprocessableEntityException, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/** Validates a request body against a contract schema; a bad body is 422 `VALIDATION_FAILED`. */
export class ZodBodyPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value ?? {});
    if (!result.success) {
      throw new UnprocessableEntityException({
        code: 'VALIDATION_FAILED',
        message: 'Some fields are not valid',
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    return result.data;
  }
}
