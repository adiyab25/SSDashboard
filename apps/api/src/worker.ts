import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module.js';

// Entry point: `worker`. Runs pg-boss jobs (the nightly ledger reconciliation) until stopped.
const app = await NestFactory.createApplicationContext(WorkerModule);
app.enableShutdownHooks();
console.log('Worker started.');
