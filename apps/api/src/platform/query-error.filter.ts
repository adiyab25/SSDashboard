import { Catch, HttpException, type ArgumentsHost } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { loggableError } from '../database/pg-error.js';

/**
 * Nest's own handling for every error, except that a failed database query is swapped for
 * `FailedQueryError` before it is logged, so the logs never hold the query params. The answer is
 * Nest's usual 500 either way. An `HttpException` is an answer we chose, so it passes untouched.
 */
@Catch()
export class QueryErrorFilter extends BaseExceptionFilter {
  /**
   * Replaces a failed query with its pg code before Nest logs it, then lets Nest answer. An
   * `HttpException` passes through unchanged.
   */
  override catch(exception: unknown, host: ArgumentsHost): void {
    if (exception instanceof HttpException) {
      super.catch(exception, host);
      return;
    }
    super.catch(loggableError(exception), host);
  }
}
