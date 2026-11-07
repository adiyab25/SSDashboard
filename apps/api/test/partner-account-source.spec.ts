import { Body, Controller, Get, Headers, Param, Post, Query, Req } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { UpdateMeRequest } from '@ssdashboard/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppModule } from '../src/app.module.js';
import { AnyHat } from '../src/platform/access/permission.decorator.js';
import { Audience } from '../src/platform/audience/audience.decorator.js';
import { ZodBodyPipe } from '../src/platform/zod-body.pipe.js';
import { ZodQueryPipe } from '../src/platform/zod-query.pipe.js';
import { routeCatalog, routesOf, type ControllerClass, type RouteEntry } from './route-catalog.js';

// Spec 0008, AC-9: a partner route takes the partner account only from `request.partner`, which
// the session guard reads from the person's own hat row. This fails the build when a handler of a
// `partner` controller declares a path param, a query or body field, or a header named for an
// account (`partnerAccountId`, `partyId`, `partnerId`, in any casing or separator), so partner A
// can never name partner B's account. A handler reading `request.query` by hand is not caught
// here: code review and the route sweep (`access-sweep.e2e-spec.ts`) cover that.

/** The names an account id goes by, compared without case, `_`, `-` or spaces. */
const ACCOUNT_NAMES = ['partneraccountid', 'partyid', 'partnerid'];

/** Nest's `RouteParamtypes` values for the request parts a caller controls. */
const SOURCES: Readonly<Record<string, string>> = {
  '3': 'body',
  '4': 'query',
  '5': 'param',
  '6': 'header',
};

const normal = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const namesAccount = (name: string): boolean =>
  ACCOUNT_NAMES.some((banned) => normal(name).includes(banned));

/**
 * Every field name a Zod schema accepts, at any depth (objects, arrays, optional and nullable
 * wrappers, pipes, unions, intersections), read from Zod 4's `_zod.def`.
 */
function fieldNames(schema: unknown, seen = new Set<unknown>()): string[] {
  if (!schema || typeof schema !== 'object' || seen.has(schema)) return [];
  seen.add(schema);
  const def = (schema as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
  if (!def) return [];
  const names: string[] = [];
  const shape = def.shape;
  if (shape && typeof shape === 'object') {
    for (const [key, child] of Object.entries(shape)) {
      names.push(key, ...fieldNames(child, seen));
    }
  }
  for (const key of ['innerType', 'in', 'out', 'element', 'left', 'right', 'valueType']) {
    names.push(...fieldNames(def[key], seen));
  }
  if (Array.isArray(def.options))
    for (const option of def.options) names.push(...fieldNames(option, seen));
  return names;
}

interface RouteArg {
  data?: unknown;
  pipes?: unknown[];
}

/** Every request part a partner route reads by an account name, in plain words. */
function accountSources(route: RouteEntry): string[] {
  const where = `${route.controller.name}.${route.handlerName} (${route.method} ${route.path})`;
  const problems: string[] = [];
  for (const [, param] of route.path.matchAll(/:([A-Za-z0-9_]+)/g)) {
    if (param && namesAccount(param)) problems.push(`${where}: path param "${param}"`);
  }
  const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, route.controller, route.handlerName) ??
    {}) as Record<string, RouteArg>;
  for (const [key, arg] of Object.entries(args)) {
    const source = SOURCES[key.split(':')[0] ?? ''];
    if (!source) continue;
    if (typeof arg.data === 'string' && namesAccount(arg.data)) {
      problems.push(`${where}: ${source} "${arg.data}"`);
    }
    for (const pipe of arg.pipes ?? []) {
      const schema = (pipe as { schema?: unknown } | null)?.schema;
      for (const field of fieldNames(schema).filter(namesAccount)) {
        problems.push(`${where}: ${source} field "${field}"`);
      }
    }
  }
  return problems;
}

const partnerRoutes = (controllers: ControllerClass[]): RouteEntry[] =>
  controllers.flatMap(routesOf).filter((route) => route.audience === 'partner');

// Planted partner controllers: never registered in AppModule.
@Audience('partner')
@AnyHat()
@Controller('partner/planted-query')
class QueryByName {
  @Get()
  read(@Query('partnerAccountId') account: string): string {
    return account;
  }
}

@Audience('partner')
@AnyHat()
@Controller('partner/planted-param')
class PathParam {
  @Get(':partyId')
  read(@Param('partyId') party: string): string {
    return party;
  }
}

@Audience('partner')
@AnyHat()
@Controller('partner/planted-body')
class BodyField {
  @Post()
  write(
    @Body(new ZodBodyPipe(z.object({ note: z.string(), partner_id: z.uuid().optional() })))
    body: unknown,
  ): unknown {
    return body;
  }
}

@Audience('partner')
@AnyHat()
@Controller('partner/planted-query-schema')
class QuerySchemaField {
  @Get()
  read(
    @Query(new ZodQueryPipe(z.object({ filter: z.object({ PartnerAccountId: z.uuid() }) })))
    query: unknown,
  ): unknown {
    return query;
  }
}

@Audience('partner')
@AnyHat()
@Controller('partner/planted-header')
class HeaderName {
  @Get()
  read(@Headers('x-partner-account-id') account: string): string {
    return account;
  }
}

@Audience('partner')
@AnyHat()
@Controller('partner/planted-good')
class ReadsTheRequestOnly {
  @Get(':statementId')
  read(@Param('statementId') id: string, @Req() _request: unknown): string {
    return id;
  }
}

describe('a partner route never takes an account from the request (spec 0008, AC-9)', () => {
  it('finds the partner routes of the app, the who am I routes among them', () => {
    const routes = routeCatalog(AppModule).filter((route) => route.audience === 'partner');

    expect(routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual(
      expect.arrayContaining(['GET /partner/me', 'PATCH /partner/me']),
    );
  });

  it('reads the fields of a body schema, so a planted field cannot hide in one', () => {
    expect(fieldNames(UpdateMeRequest)).toEqual(expect.arrayContaining(['name', 'phone']));
  });

  it('finds no partner handler that names an account in a path, query, body or header', () => {
    const problems = routeCatalog(AppModule)
      .filter((route) => route.audience === 'partner')
      .flatMap(accountSources);

    expect(problems, problems.join('\n')).toEqual([]);
  });

  describe('fails a planted partner controller', () => {
    it.each([
      [QueryByName, 'QueryByName.read (GET /partner/planted-query): query "partnerAccountId"'],
      [PathParam, 'PathParam.read (GET /partner/planted-param/:partyId): path param "partyId"'],
      [BodyField, 'BodyField.write (POST /partner/planted-body): body field "partner_id"'],
      [
        QuerySchemaField,
        'QuerySchemaField.read (GET /partner/planted-query-schema): query field "PartnerAccountId"',
      ],
      [HeaderName, 'HeaderName.read (GET /partner/planted-header): header "x-partner-account-id"'],
    ] as const)('%o', (target, problem) => {
      const problems = partnerRoutes([target]).flatMap(accountSources);

      expect(problems).toContain(problem);
    });
  });

  it('passes a partner handler that reads only its own params and the request', () => {
    expect(partnerRoutes([ReadsTheRequestOnly]).flatMap(accountSources)).toEqual([]);
  });
});
