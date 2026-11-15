/** Every refusal the tasks module can raise, as a stable code the api edge maps to an HTTP answer. */
export type TasksErrorCode =
  | 'UnknownTaskType'
  | 'TaskLinkNotAllowed'
  | 'InvalidOutcome'
  | 'OutcomeNotForPerson'
  | 'NoteRequired'
  | 'TaskNotOpen'
  | 'TaskNotFound'
  | 'TaskChanged'
  | 'TaskAssigneeNotEligible'
  | 'DueInvalid'
  | 'DueRequired'
  | 'DueRuleUnsupported'
  | 'KeyShapeInvalid'
  | 'NoteInvalid'
  | 'ExpectedUpdatedAtRequired'
  | 'SystemNoteRefused';

/**
 * A typed domain error of the tasks module (never an error string). Messages are fixed text and
 * never carry a note, a phone, a name, or an address (Law 151): a caller may log `code` and the
 * message safely.
 */
export abstract class TasksError extends Error {
  /** Takes the stable code and a message safe to show. */
  protected constructor(
    readonly code: TasksErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The task type code is not in `TASK_TYPES`. */
export class UnknownTaskType extends TasksError {
  /** Fixed text; the code is not echoed. */
  constructor() {
    super('UnknownTaskType', 'No task type has that code');
  }
}

/** The type's registry entry does not allow the linked record kind. */
export class TaskLinkNotAllowed extends TasksError {
  /** Fixed text. */
  constructor() {
    super('TaskLinkNotAllowed', 'This task type cannot be opened on that kind of record');
  }
}

/** The outcome is not one of the type's outcomes. */
export class InvalidOutcome extends TasksError {
  /** Fixed text. */
  constructor() {
    super('InvalidOutcome', 'This task type has no such outcome');
  }
}

/** The outcome, or the whole type, is reserved for the system. */
export class OutcomeNotForPerson extends TasksError {
  /** Fixed text. */
  constructor() {
    super('OutcomeNotForPerson', 'Only the system may close this task with that outcome');
  }
}

/** The outcome needs a note and none was given. */
export class NoteRequired extends TasksError {
  /** Fixed text. */
  constructor() {
    super('NoteRequired', 'This outcome needs a note');
  }
}

/** The task is already done or cancelled. */
export class TaskNotOpen extends TasksError {
  /** Fixed text. */
  constructor() {
    super('TaskNotOpen', 'The task is not open');
  }
}

/** No task has that id. */
export class TaskNotFound extends TasksError {
  /** Fixed text. */
  constructor() {
    super('TaskNotFound', 'No task has that id');
  }
}

/** A person's `expectedUpdatedAt` is not the task's current `updated_at`. */
export class TaskChanged extends TasksError {
  /** Fixed text. */
  constructor() {
    super('TaskChanged', 'The task changed since it was read');
  }
}

/** The chosen person is disabled or lacks the type's permission. */
export class TaskAssigneeNotEligible extends TasksError {
  /** Fixed text. */
  constructor() {
    super('TaskAssigneeNotEligible', 'That person cannot hold this task');
  }
}

/** A due time that is not allowed. */
export class DueInvalid extends TasksError {
  /** Fixed text. */
  constructor() {
    super('DueInvalid', 'The due time is not allowed');
  }
}

/** The type's due rule is `required` and the opener passed none. */
export class DueRequired extends TasksError {
  /** Fixed text. */
  constructor() {
    super('DueRequired', 'This task type needs a due time');
  }
}

/** A due rule that arrives with working hours (milestone 2); no registered type uses one yet. */
export class DueRuleUnsupported extends TasksError {
  /** Fixed text. */
  constructor() {
    super('DueRuleUnsupported', 'This due rule needs the working hours, which are not built yet');
  }
}

/** A dedupe or subject key outside its shape: ids and codes only, never a phone or a name. */
export class KeyShapeInvalid extends TasksError {
  /** Fixed text; the key is not echoed. */
  constructor() {
    super('KeyShapeInvalid', 'A key may hold ids and codes only');
  }
}

/** A person changed a task without the `updated_at` she read (the concurrency token). */
export class ExpectedUpdatedAtRequired extends TasksError {
  /** Fixed text. */
  constructor() {
    super('ExpectedUpdatedAtRequired', 'A person must send the updated time she read');
  }
}

/** A system close carried a note: notes are a person's words, the system has none. */
export class SystemNoteRefused extends TasksError {
  /** Fixed text. */
  constructor() {
    super('SystemNoteRefused', 'The system does not write notes');
  }
}

/** A note outside 1 to 1,000 characters. */
export class NoteInvalid extends TasksError {
  /** Fixed text; the note is never echoed. */
  constructor() {
    super('NoteInvalid', 'A note is 1 to 1,000 characters');
  }
}
