import { type DynamicModule, Module } from '@nestjs/common';
import { PlatformModule } from '../platform.module.js';
import { JOB_BOSS_ROLE, JobBoss } from './job-boss.js';
import { JobRegistry } from './job-registry.js';
import { JobSender } from './job-sender.js';
import { ModuleJobSupervisor } from './module-job-supervisor.js';

/**
 * The process's pg-boss wiring (spec 0009, AC-10): one `PgBoss` client per process. `forApi()`
 * gives the api a send only client (`JobSender`, used by the settings write and the mail
 * producer); `forWorker()` gives the worker its working client, the `JobRegistry` its job
 * providers declare into, and the `ModuleJobSupervisor`. Both are global, each imported once:
 * `forApi()` by `PlatformApiModule`, `forWorker()` by `WorkerModule`. Never import `forWorker()`
 * into the api, or `forApi()` into the worker.
 */
@Module({})
export class JobsModule {
  /** The api's send only half. */
  static forApi(): DynamicModule {
    return {
      module: JobsModule,
      global: true,
      providers: [{ provide: JOB_BOSS_ROLE, useValue: 'send' }, JobBoss, JobSender],
      exports: [JobSender],
    };
  }

  /** The worker's half: the working client, the registry, and the supervisor. */
  static forWorker(): DynamicModule {
    return {
      module: JobsModule,
      global: true,
      imports: [PlatformModule],
      providers: [
        { provide: JOB_BOSS_ROLE, useValue: 'work' },
        JobBoss,
        JobSender,
        JobRegistry,
        ModuleJobSupervisor,
      ],
      exports: [JobSender, JobRegistry, ModuleJobSupervisor],
    };
  }
}
