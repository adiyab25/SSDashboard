import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  BackfillBody,
  ConnectionListQuery,
  ConnectShopifyBody,
  SyncRunListQuery,
  type ConnectionDetail,
  type ConnectionListResponse,
  type ConnectShopifyResponse,
  type SyncRunListResponse,
  type SyncRunStarted,
} from '@ssdashboard/contracts';
import { ChannelsError } from '../../channels/channels.errors.js';
import type { AuthenticatedRequest } from '../../identity/sign-in/current-staff.js';
import type { Access } from '../../platform/access/access.js';
import { CurrentAccess } from '../../platform/access/current-access.decorator.js';
import { Permission } from '../../platform/access/permission.decorator.js';
import { Audience } from '../../platform/audience/audience.decorator.js';
import { RequiresModule } from '../../platform/modules/requires-module.decorator.js';
import { ZodQueryPipe } from '../../platform/zod-query.pipe.js';
import { ConnectionsError } from '../connectors.errors.js';
import { ConnectionsService } from './connections.service.js';

/** A malformed id is a connection that does not exist: 404, never 400. */
const connectionId = () =>
  new ParseUUIDPipe({
    exceptionFactory: () => new NotFoundException({ code: 'NOT_FOUND', message: 'Not found' }),
  });

/**
 * Parses the connect body (spec 0015 *API surface*): 422 `INVALID_SHOP_DOMAIN` when the shop
 * domain is the only field of the wrong shape, else 422 `INVALID_BODY` naming each failing field
 * path. Never echoes a value: the client secret could be in it.
 */
function parseConnectBody(body: unknown): ConnectShopifyBody {
  const result = ConnectShopifyBody.safeParse(body ?? {});
  if (result.success) return result.data;
  const paths = result.error.issues.map((issue) => issue.path.join('.'));
  if (paths.length > 0 && paths.every((path) => path === 'shopDomain')) {
    throw new UnprocessableEntityException({
      code: 'INVALID_SHOP_DOMAIN',
      message: 'The shop domain must look like <name>.myshopify.com',
    });
  }
  throw new UnprocessableEntityException({
    code: 'INVALID_BODY',
    message: 'Some fields are not valid',
    issues: [...new Set(paths)].map((path) => ({ path })),
  });
}

/** Maps the connectors and channels refusals to their stable answers. */
export function connectionHttpError(error: unknown): unknown {
  if (error instanceof ConnectionsError) {
    switch (error.code) {
      case 'NOT_FOUND':
        return new NotFoundException({ code: 'NOT_FOUND', message: error.message });
      case 'SHOP_ALREADY_CONNECTED':
      case 'STORE_CODE_TAKEN':
      case 'CONNECTION_ARCHIVED':
      case 'SCAN_RUNNING':
      case 'BACKFILL_RUNNING':
      case 'CONNECTION_NOT_READY':
        return new ConflictException({ code: error.code, message: error.message });
      case 'GATEWAYS_UNMAPPED':
        return new ConflictException({
          code: error.code,
          message: error.message,
          gateways: [...error.gateways],
        });
      case 'INVALID_CURSOR':
        return new BadRequestException({ code: 'INVALID_QUERY', message: error.message });
    }
  }
  if (error instanceof ChannelsError && error.code === 'INVALID_STORE_INPUT') {
    return new UnprocessableEntityException({ code: 'INVALID_BODY', message: error.message });
  }
  return error;
}

/**
 * The connections of the brand's outside accounts (spec 0015 task 6, AC-1, AC-27): the list,
 * connecting a Shopify store, one connection, and a new connect check; from task 12 (AC-17) the
 * gateway scan, the first backfill with its go live instant, and the sync runs. Manager only
 * (`settings.manage`). Never answers a credential or a token: only that keys are set and the last
 * 4 characters of the client id. The rest of the spec's routes land with their tasks; the
 * freshness line is `FreshnessController` (`orders.view`).
 */
@Audience('staff')
@RequiresModule('connectors')
@Permission('settings.manage')
@Controller('connections')
export class ConnectionsController {
  /** Takes the connections service. */
  constructor(private readonly connections: ConnectionsService) {}

  /** One page of connections, newest first (`limit` 50 by default, at most 100). */
  @Get()
  async list(
    @Query(new ZodQueryPipe(ConnectionListQuery)) query: ConnectionListQuery,
  ): Promise<ConnectionListResponse> {
    try {
      return await this.connections.list(query);
    } catch (error) {
      throw connectionHttpError(error);
    }
  }

  /**
   * Connects a Shopify store: 201 `{ id, health: 'connecting' }`; the worker's `connect` job then
   * runs the checks. 409 `SHOP_ALREADY_CONNECTED` or `STORE_CODE_TAKEN`; 422
   * `INVALID_SHOP_DOMAIN` or `INVALID_BODY`.
   */
  @Post('shopify')
  @HttpCode(201)
  async connectShopify(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
  ): Promise<ConnectShopifyResponse> {
    const parsed = parseConnectBody(body);
    try {
      return await this.connections.connect(parsed, { userId: request.staff.id, access });
    } catch (error) {
      throw connectionHttpError(error);
    }
  }

  /** One connection (`ConnectionDetail`, never credentials); 404 `NOT_FOUND`. */
  @Get(':id')
  async detail(@Param('id', connectionId()) id: string): Promise<ConnectionDetail> {
    try {
      return await this.connections.detail(id);
    } catch (error) {
      throw connectionHttpError(error);
    }
  }

  /** Runs the connect checks again: 202; 404 `NOT_FOUND`; 409 `CONNECTION_ARCHIVED`. */
  @Post(':id/check')
  @HttpCode(202)
  async check(@Param('id', connectionId()) id: string): Promise<Record<string, never>> {
    try {
      await this.connections.check(id);
      return {};
    } catch (error) {
      throw connectionHttpError(error);
    }
  }

  /**
   * Starts a gateway scan (spec 0015 task 12, AC-17): 202 `{ runId }`; 404 `NOT_FOUND`; 409
   * `SCAN_RUNNING` or `CONNECTION_ARCHIVED`.
   */
  @Post(':id/gateway-scan')
  @HttpCode(202)
  async gatewayScan(@Param('id', connectionId()) id: string): Promise<SyncRunStarted> {
    try {
      return await this.connections.startGatewayScan(id);
    } catch (error) {
      throw connectionHttpError(error);
    }
  }

  /**
   * Starts the first backfill with its go live instant (AC-17): 202 `{ runId }`; 404 `NOT_FOUND`;
   * 409 `BACKFILL_RUNNING`, `CONNECTION_NOT_READY`, or `GATEWAYS_UNMAPPED` (with `gateways`, the
   * scanned names still unmapped); 422 `INVALID_BODY`.
   */
  @Post(':id/backfill')
  @HttpCode(202)
  async backfill(
    @Param('id', connectionId()) id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
  ): Promise<SyncRunStarted> {
    const parsed = BackfillBody.safeParse(body ?? {});
    if (!parsed.success) {
      throw new UnprocessableEntityException({
        code: 'INVALID_BODY',
        message: 'The go live instant must be an ISO date and time',
        issues: [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))].map(
          (path) => ({ path }),
        ),
      });
    }
    try {
      return await this.connections.startBackfill(id, parsed.data, {
        userId: request.staff.id,
        access,
      });
    } catch (error) {
      throw connectionHttpError(error);
    }
  }

  /** A connection's sync runs, newest first (`kind?`, `cursor?`, `limit?`); 404 `NOT_FOUND`. */
  @Get(':id/sync-runs')
  async syncRuns(
    @Param('id', connectionId()) id: string,
    @Query(new ZodQueryPipe(SyncRunListQuery)) query: SyncRunListQuery,
  ): Promise<SyncRunListResponse> {
    try {
      return await this.connections.syncRuns(id, query);
    } catch (error) {
      throw connectionHttpError(error);
    }
  }
}
