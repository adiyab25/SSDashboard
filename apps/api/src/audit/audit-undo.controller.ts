import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UnprocessableEntityException,
  type PipeTransform,
} from '@nestjs/common';
import { AuditUndoRequest, type AuditEntryView } from '@ssdashboard/contracts';
import type { Access } from '../platform/access/access.js';
import { CurrentAccess } from '../platform/access/current-access.decorator.js';
import { Permission } from '../platform/access/permission.decorator.js';
import { Audience } from '../platform/audience/audience.decorator.js';
import { serializeAuditEntry } from './audit-cost-fields.js';
import { auditHttpError } from './audit-http.js';
import { AuditUndoService } from './audit-undo.service.js';

/**
 * The undo body (spec 0010, AC-14, API surface): `AuditUndoRequest`. A missing, empty, or blank
 * reason is 422 `REASON_REQUIRED`; one over 500 characters 422 `REASON_TOO_LONG`; any other bad
 * body (another field, a reason that is not text) 400 `INVALID_INPUT`. Never echoes the reason.
 */
export class AuditUndoBodyPipe implements PipeTransform<unknown, AuditUndoRequest> {
  /** Returns the trimmed request, or throws the answer the API surface names. */
  transform(value: unknown): AuditUndoRequest {
    const body: unknown = value ?? {};
    const parsed = AuditUndoRequest.safeParse(body);
    if (parsed.success) return parsed.data;
    const onlyReason = parsed.error.issues.every((issue) => issue.path[0] === 'reason');
    const reason: unknown =
      typeof body === 'object' && body !== null ? (body as { reason?: unknown }).reason : undefined;
    if (onlyReason && (reason === undefined || reason === null || typeof reason === 'string')) {
      if (typeof reason === 'string' && reason.trim()) {
        throw new UnprocessableEntityException({
          code: 'REASON_TOO_LONG',
          message: 'A reason can be at most 500 characters',
        });
      }
      throw new UnprocessableEntityException({
        code: 'REASON_REQUIRED',
        message: 'A reason is required to undo an action',
      });
    }
    throw new BadRequestException({ code: 'INVALID_INPUT', message: 'The undo takes a reason' });
  }
}

/** A malformed entry id is an entry that does not exist: 404 `ENTRY_NOT_FOUND`. */
const entryId = () =>
  new ParseUUIDPipe({
    exceptionFactory: () =>
      new NotFoundException({ code: 'ENTRY_NOT_FOUND', message: 'Audit entry not found' }),
  });

/**
 * The one step undo of an audited action (spec 0010, AC-14): `POST /api/audit/entries/:id/undo`.
 * Staff audience only, `audit.undo` (the manager hat by default, spec 0008); anyone else gets 403
 * `FORBIDDEN`. Its own controller, because the entry routes carry `audit.read` on their class. The
 * answer is the new undone entry, cost fields left out for a reader without `cost.view`.
 */
@Audience('staff')
@Permission('audit.undo')
@Controller('audit/entries')
export class AuditUndoController {
  /** Takes the undo service. */
  constructor(private readonly undos: AuditUndoService) {}

  /**
   * Undoes the entry and answers 200 with the undone entry. 404 `ENTRY_NOT_FOUND`, 409
   * `NOT_UNDOABLE`, 409 `ALREADY_UNDONE`, 409 `UNDO_NOT_POSSIBLE` with the owner's `undoCode`
   * (nothing changed), 422 `REASON_REQUIRED`, 422 `REASON_TOO_LONG`, and on a record type that
   * keeps reason codes 422 `REASON_INVALID`.
   */
  @Post(':id/undo')
  @HttpCode(200)
  async undo(
    @Param('id', entryId()) id: string,
    @Body(new AuditUndoBodyPipe()) body: AuditUndoRequest,
    @CurrentAccess() access: Access,
  ): Promise<AuditEntryView> {
    try {
      return serializeAuditEntry(await this.undos.undo(id, access, body.reason), access);
    } catch (error) {
      throw auditHttpError(error) ?? error;
    }
  }
}
