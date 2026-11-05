import { ConsoleLogger } from '@nestjs/common';
import { redact } from '@ssdashboard/config/redaction';

/** Every argument of a log call through the shared redaction list. */
function redactAll(args: readonly unknown[]): unknown[] {
  return args.map(safeRedact);
}

/** `redact`, but a failure yields a fixed placeholder: logging must never throw or leak. */
function safeRedact(value: unknown): unknown {
  try {
    return redact(value);
  } catch {
    return '[unloggable]';
  }
}

/**
 * The api and worker logger (Law 151, spec 0007). Nest's console logger with every argument, the
 * message, the stack, and the context, passed through `redact` from `@ssdashboard/config/redaction`
 * first, so a customer's phone, name, address, or message body never reaches stdout or a log
 * driver. It is installed on the app in `main.ts` and `worker.ts`, which also covers every
 * `new Logger('Name')` in the code base (Nest routes them to the app logger).
 *
 * Redaction happens before formatting and at every level, `debug` and `verbose` included. Must
 * never be given a bypass or a "raw" mode. When pino replaces this class, `redact` moves into its
 * `formatters.log` hook unchanged.
 */
export class RedactingLogger extends ConsoleLogger {
  /** Logs at `log` level after redacting the message and every extra argument. Never skips redaction. */
  override log(message: unknown, ...optionalParams: unknown[]): void {
    super.log(safeRedact(message), ...redactAll(optionalParams));
  }

  /** Logs at `error` level after redacting the message and every extra argument. Never skips redaction. */
  override error(message: unknown, ...optionalParams: unknown[]): void {
    super.error(safeRedact(message), ...redactAll(optionalParams));
  }

  /** Logs at `warn` level after redacting the message and every extra argument. Never skips redaction. */
  override warn(message: unknown, ...optionalParams: unknown[]): void {
    super.warn(safeRedact(message), ...redactAll(optionalParams));
  }

  /** Logs at `debug` level after redacting the message and every extra argument. Never skips redaction. */
  override debug(message: unknown, ...optionalParams: unknown[]): void {
    super.debug(safeRedact(message), ...redactAll(optionalParams));
  }

  /** Logs at `verbose` level after redacting the message and every extra argument. Never skips redaction. */
  override verbose(message: unknown, ...optionalParams: unknown[]): void {
    super.verbose(safeRedact(message), ...redactAll(optionalParams));
  }

  /** Logs at `fatal` level after redacting the message and every extra argument. Never skips redaction. */
  override fatal(message: unknown, ...optionalParams: unknown[]): void {
    super.fatal(safeRedact(message), ...redactAll(optionalParams));
  }
}
