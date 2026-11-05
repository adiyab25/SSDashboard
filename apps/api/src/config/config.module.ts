import { Global, Module } from '@nestjs/common';
import { loadEnv, type Env } from './env.js';

/** The Nest injection token for the validated env. */
export const ENV = Symbol('ENV');

/**
 * Global module that validates the env once at startup and provides it as `ENV`. Never read
 * `process.env` anywhere else.
 */
@Global()
@Module({
  providers: [{ provide: ENV, useFactory: (): Env => loadEnv() }],
  exports: [ENV],
})
export class ConfigModule {}
