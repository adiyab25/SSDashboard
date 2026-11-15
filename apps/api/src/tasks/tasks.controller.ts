import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  CloseTaskBody,
  TaskListQuery,
  taskTypeOf,
  type TaskListResponse,
  type TaskListRow,
  type TaskSummary,
} from '@ssdashboard/contracts';
import type { DatabaseConnection } from '@ssdashboard/db';
import type { z } from 'zod';
import { DATABASE } from '../database/database.module.js';
import { Access } from '../platform/access/access.js';
import { CurrentAccess } from '../platform/access/current-access.decorator.js';
import { Permission } from '../platform/access/permission.decorator.js';
import { Audience } from '../platform/audience/audience.decorator.js';
import { RequiresModule } from '../platform/modules/requires-module.decorator.js';
import { ZodQueryPipe } from '../platform/zod-query.pipe.js';
import { InvalidTaskCursor, TaskQueries } from './task-queries.js';
import { TaskBodyPipe, taskIdPipe, tasksHttpError } from './tasks-http.js';
import { TasksService } from './tasks.service.js';

const notFound = () =>
  new NotFoundException({ code: 'TASK_NOT_FOUND', message: 'No task has that id' });

/**
 * My work, milestone 1 (spec 0016 API surface): the caller's open tasks, the shell counts, and
 * closing a task with an outcome. Staff audience, core module `tasks`, `tasks.work` on every
 * handler. Visibility is computed from the caller's `Access` and the hats' active holders; a task
 * the caller cannot see answers 404 `TASK_NOT_FOUND`, the same as a missing one. Answers carry
 * ids, codes, times, display names, and an order's number and store, never a phone, a name, an
 * address, or a note; a refusal never echoes a note. `view=team` is milestone 2 and answers 400
 * `INVALID_QUERY`.
 */
@Audience('staff')
@RequiresModule('tasks')
@Controller('tasks')
export class TasksController {
  /** Takes the database (for the close transaction), the writer, and the readers. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    private readonly tasks: TasksService,
    private readonly queries: TaskQueries,
  ) {}

  /** `GET /api/tasks?view=mine`: one keyset page of the caller's open tasks (AC-5). */
  @Permission('tasks.work')
  @Get()
  async list(
    @Query(new ZodQueryPipe(TaskListQuery)) query: z.output<typeof TaskListQuery>,
    @CurrentAccess() access: Access,
  ): Promise<TaskListResponse> {
    try {
      return await this.queries.listMine(access, query.cursor);
    } catch (error) {
      if (error instanceof InvalidTaskCursor) {
        throw new BadRequestException({ code: 'INVALID_QUERY', message: error.message });
      }
      throw error;
    }
  }

  /** `GET /api/tasks/summary`: the shell counts, and `unsyncedEdits` for `orders.confirm` (AC-7). */
  @Permission('tasks.work')
  @Get('summary')
  summary(@CurrentAccess() access: Access): Promise<TaskSummary> {
    return this.queries.summary(access);
  }

  /**
   * `POST /api/tasks/:id/close` (AC-3): a person closes a visible task with one of the outcomes
   * a person may set, with `expectedUpdatedAt`. A type only the system closes answers 422
   * `OUTCOME_NOT_FOR_PERSON`. Answers the task as the screen shows it.
   */
  @Permission('tasks.work')
  @Post(':id/close')
  @HttpCode(200)
  async close(
    @Param('id', taskIdPipe()) id: string,
    @Body(new TaskBodyPipe(CloseTaskBody)) body: z.output<typeof CloseTaskBody>,
    @CurrentAccess() access: Access,
  ): Promise<TaskListRow> {
    const visible = await this.queries.visible(access, id);
    const definition = visible ? taskTypeOf(visible.type) : undefined;
    if (!visible || !definition) throw notFound();
    try {
      await this.connection.db.transaction(
        (tx) =>
          this.tasks.close(tx, id, {
            outcome: body.outcome,
            ...(body.note === undefined ? {} : { note: body.note }),
            expectedUpdatedAt: body.expectedUpdatedAt,
            by: {
              kind: 'person',
              userId: access.userId,
              hat: access.actingHat(definition.requiredPermission),
            },
          }),
        { isolationLevel: 'read committed' },
      );
    } catch (error) {
      throw tasksHttpError(error);
    }
    const row = await this.queries.rowOf(id);
    if (!row) throw notFound();
    return row;
  }
}
