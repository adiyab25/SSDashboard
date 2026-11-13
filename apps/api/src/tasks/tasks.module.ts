import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { HatDirectoryModule } from '../identity/hats/hat-directory.js';
import { StaffDirectoryModule } from '../identity/staff/staff-directory.js';
import { OrdersModule } from '../orders/orders.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { WriteBackFailedListener } from './listeners/write-back-failed.listener.js';
import { TaskQueries } from './task-queries.js';
import { TasksController } from './tasks.controller.js';
import { TasksService } from './tasks.service.js';

/**
 * The tasks module (spec 0016): the only writer of `tasks` and `task_notes`, and My work. Other
 * modules open and close tasks through the exported `TasksService` inside their own transaction,
 * or by publishing a past tense event this module listens to (milestone 1: the outbound command
 * events of connectors). It is core with no toggle (every controller declares
 * `@RequiresModule('tasks')`), loaded in the api and the worker, because outbound events are
 * published in the worker. It reads hats and staff names through identity's public files, order
 * numbers through `OrderQueries`, and settings and the clock through platform, never another
 * module's tables.
 */
@Module({
  imports: [AuditModule, HatDirectoryModule, OrdersModule, PlatformModule, StaffDirectoryModule],
  controllers: [TasksController],
  providers: [TasksService, TaskQueries, WriteBackFailedListener],
  exports: [TasksService, TaskQueries],
})
export class TasksModule {}
