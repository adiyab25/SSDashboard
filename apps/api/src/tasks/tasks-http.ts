import {
  ConflictException,
  NotFoundException,
  ParseUUIDPipe,
  UnprocessableEntityException,
  type PipeTransform,
} from '@nestjs/common';
import type { z } from 'zod';
import { TasksError } from './task-errors.js';

/**
 * Maps a tasks domain error to the stable HTTP answer of spec 0016's API table; any other error is
 * returned unchanged. Messages are fixed text and never echo a note, a key, or a person.
 */
export function tasksHttpError(error: unknown): unknown {
  if (!(error instanceof TasksError)) return error;
  switch (error.code) {
    case 'TaskNotFound':
      return new NotFoundException({ code: 'TASK_NOT_FOUND', message: error.message });
    case 'TaskChanged':
      return new ConflictException({ code: 'TASK_CHANGED', message: error.message });
    case 'TaskNotOpen':
      return new ConflictException({ code: 'TASK_NOT_OPEN', message: error.message });
    case 'InvalidOutcome':
      return new UnprocessableEntityException({ code: 'OUTCOME_INVALID', message: error.message });
    case 'OutcomeNotForPerson':
      return new UnprocessableEntityException({
        code: 'OUTCOME_NOT_FOR_PERSON',
        message: error.message,
      });
    case 'NoteRequired':
      return new UnprocessableEntityException({ code: 'NOTE_REQUIRED', message: error.message });
    case 'NoteInvalid':
      return new UnprocessableEntityException({
        code: 'VALIDATION_FAILED',
        message: error.message,
      });
    // The rest are refusals of in process callers (a module opening a task), not of a route.
    case 'UnknownTaskType':
    case 'TaskLinkNotAllowed':
    case 'TaskAssigneeNotEligible':
    case 'DueInvalid':
    case 'DueRequired':
    case 'DueRuleUnsupported':
    case 'KeyShapeInvalid':
      return error;
    default: {
      const unreachable: never = error.code;
      return unreachable;
    }
  }
}

/** A malformed task id is a task that does not exist: 404 `TASK_NOT_FOUND`, never 400. */
export const taskIdPipe = (): ParseUUIDPipe =>
  new ParseUUIDPipe({
    exceptionFactory: () =>
      new NotFoundException({ code: 'TASK_NOT_FOUND', message: 'No task has that id' }),
  });

/**
 * Validates a task body with its contract schema: a refusal answers 422 `VALIDATION_FAILED`
 * listing the failing field paths only. It never echoes a value, because a note is personal data
 * (spec 0016 API surface, AC-11).
 */
export class TaskBodyPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  /** Takes the contract schema of the body. */
  constructor(private readonly schema: T) {}

  /** Returns the parsed body or throws the 422 answer. */
  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value ?? {});
    if (result.success) return result.data;
    throw new UnprocessableEntityException({
      code: 'VALIDATION_FAILED',
      message: 'The request is not valid',
      fields: [...new Set(result.error.issues.map((issue) => issue.path.join('.')))],
    });
  }
}
