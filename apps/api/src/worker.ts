import { NestFactory } from '@nestjs/core';
import { RedactingLogger } from './platform/logging/redacting-logger.js';
import { WorkerModule } from './worker.module.js';

// Entry point: `worker`. Runs pg-boss jobs (the nightly ledger reconciliation) until stopped.
const app = await NestFactory.createApplicationContext(WorkerModule, {
  logger: new RedactingLogger(),
});
app.enableShutdownHooks();
console.log('Worker started.');
