import { Inject, Injectable } from '@nestjs/common';
import { ModuleRegistry } from '../modules/module-registry.js';
import type {
  JobHandlerDeclaration,
  QueueDeclaration,
  ScheduleDeclaration,
} from './job-declarations.js';

/** Raised at start for a declaration that names an unknown capability, step, or queue, or repeats. */
export class JobDeclarationConflict extends Error {
  /** Takes the plain words of what clashed. */
  constructor(message: string) {
    super(message);
    this.name = 'JobDeclarationConflict';
  }
}

/**
 * Every pg-boss queue, job handler, and cron schedule of the worker, each with the capability it
 * serves (spec 0009, AC-10; *Key invariants*: no queue or schedule outside it). Job providers
 * declare from their `onModuleInit`; the `ModuleJobSupervisor` creates the queues and keeps
 * workers and schedules in line with the capabilities' states. A capability or step must be in
 * the module registry, a step must gate that capability, and a queue, a handler per queue and
 * capability, and a schedule key per queue are each declared once.
 */
@Injectable()
export class JobRegistry {
  private readonly queueMap = new Map<string, QueueDeclaration>();
  private readonly handlerMap = new Map<string, JobHandlerDeclaration>();
  private readonly scheduleMap = new Map<string, ScheduleDeclaration>();

  /** Takes the module registry the declarations are checked against. */
  constructor(@Inject(ModuleRegistry) private readonly registry: ModuleRegistry) {}

  /** Declares a queue with its owning capability. */
  declareQueue(queue: QueueDeclaration): void {
    this.knownCapability(queue.capability, queue.name);
    if (this.queueMap.has(queue.name)) {
      throw new JobDeclarationConflict(`Queue ${queue.name} is declared twice`);
    }
    this.queueMap.set(queue.name, queue);
  }

  /** Declares the handler of one capability's jobs on a declared queue. */
  declareHandler(handler: JobHandlerDeclaration): void {
    this.knownQueue(handler.queue);
    this.knownCapability(handler.capability, handler.queue);
    const id = `${handler.queue}\u0000${handler.capability}`;
    if (this.handlerMap.has(id)) {
      throw new JobDeclarationConflict(
        `Two handlers of ${handler.capability} on queue ${handler.queue}`,
      );
    }
    this.handlerMap.set(id, handler);
  }

  /** Declares a keyed cron schedule on a declared queue. */
  declareSchedule(schedule: ScheduleDeclaration): void {
    this.knownQueue(schedule.queue);
    this.knownCapability(schedule.capability, schedule.queue);
    if (schedule.step !== undefined) {
      const steps = this.registry.capability(schedule.capability)?.capability.steps ?? [];
      if (!steps.includes(schedule.step)) {
        throw new JobDeclarationConflict(
          `Schedule ${schedule.key} names step ${schedule.step}, which ${schedule.capability} does not gate`,
        );
      }
    }
    const id = `${schedule.queue}\u0000${schedule.key}`;
    if (this.scheduleMap.has(id)) {
      throw new JobDeclarationConflict(
        `Schedule ${schedule.key} on ${schedule.queue} is declared twice`,
      );
    }
    this.scheduleMap.set(id, schedule);
  }

  /** Every declared queue. */
  queues(): QueueDeclaration[] {
    return [...this.queueMap.values()];
  }

  /** One declared queue, or undefined. */
  queue(name: string): QueueDeclaration | undefined {
    return this.queueMap.get(name);
  }

  /** The handler of a capability's jobs on a queue, or the owner's on an `ownerHandlesAll` queue. */
  handlerFor(queue: string, capability: string): JobHandlerDeclaration | undefined {
    const own = this.handlerMap.get(`${queue}\u0000${capability}`);
    if (own) return own;
    const declared = this.queueMap.get(queue);
    return declared?.ownerHandlesAll
      ? this.handlerMap.get(`${queue}\u0000${declared.capability}`)
      : undefined;
  }

  /** The schedules declared on a queue. */
  schedulesOf(queue: string): ScheduleDeclaration[] {
    return [...this.scheduleMap.values()].filter((schedule) => schedule.queue === queue);
  }

  /** The capabilities with a handler or a schedule on a queue, the owner first. */
  capabilitiesOn(queue: string): string[] {
    const owner = this.queueMap.get(queue)?.capability;
    const found = new Set<string>(owner ? [owner] : []);
    for (const handler of this.handlerMap.values()) {
      if (handler.queue === queue) found.add(handler.capability);
    }
    for (const schedule of this.schedulesOf(queue)) found.add(schedule.capability);
    return [...found];
  }

  /**
   * Every step that can gate a job on a queue: the registry's `steps` of each capability with a
   * handler or a schedule there, and any step a schedule names, so a step's jobs sent without a
   * schedule are cancelled too (security review m3, 4).
   */
  stepsOn(queue: string): string[] {
    return [
      ...new Set([
        ...this.capabilitiesOn(queue).flatMap(
          (capability) => this.registry.capability(capability)?.capability.steps ?? [],
        ),
        ...this.schedulesOf(queue).flatMap((s) => (s.step === undefined ? [] : [s.step])),
      ]),
    ];
  }

  /** Every capability some declaration serves (for the "every capability is used" check). */
  declaredCapabilities(): string[] {
    return [
      ...new Set([
        ...[...this.queueMap.values()].map((q) => q.capability),
        ...[...this.handlerMap.values()].map((h) => h.capability),
        ...[...this.scheduleMap.values()].map((s) => s.capability),
      ]),
    ];
  }

  private knownQueue(name: string): void {
    if (!this.queueMap.has(name)) throw new JobDeclarationConflict(`Queue ${name} is not declared`);
  }

  private knownCapability(capability: string, where: string): void {
    if (!this.registry.capability(capability)) {
      throw new JobDeclarationConflict(
        `${where} names ${capability}, which the module registry does not list`,
      );
    }
  }
}
