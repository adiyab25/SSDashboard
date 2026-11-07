import type { Server } from 'node:http';
import { Controller, Get, Post, Req, type INestApplication } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../config/env.js';
import { Audience } from '../../platform/audience/audience.decorator.js';
import { AudienceGuard } from '../../platform/audience/audience.guard.js';
import { Access } from '../../platform/access/access.js';
import { AnyHat, Permission } from '../../platform/access/permission.decorator.js';
import { PermissionGuard } from '../../platform/access/permission.guard.js';
import type { SessionAudience } from '../sessions/session-audiences.js';
import type { Auth } from './auth.tokens.js';
import type { CurrentPartner, CurrentStaff } from './current-staff.js';
import { Public } from './public.decorator.js';
import { SessionGuard } from './session.guard.js';

// Spec 0005, AC-29, and the spec 0008 guard order (session, audience, permission), through real
// HTTP and Nest's guard pipeline. The guards are built by hand here, in the order
// `identity.module.ts` registers them; this file does not load IdentityModule.
// These controllers live only in this test module: never add them to AppModule (`audience.spec.ts`
// walks it).

type Seen = Request & { staff?: CurrentStaff; partner?: CurrentPartner };
const who = (req: Seen) => ({
  staff: req.staff?.id ?? null,
  partner: req.partner?.userId ?? null,
});

@Audience('staff')
@Controller('things')
class StaffProbe {
  @AnyHat()
  @Get()
  read(@Req() req: Seen) {
    return who(req);
  }

  @Permission('people.manage')
  @Get('managed')
  managed(@Req() req: Seen) {
    return who(req);
  }

  @Get('undeclared')
  undeclared(@Req() req: Seen) {
    return who(req);
  }
}

@Audience('partner')
@Controller('partner/things')
class PartnerProbe {
  @Permission('partner.view_own')
  @Get()
  read(@Req() req: Seen) {
    return who(req);
  }
}

@Audience('portal')
@Controller('portal/things')
class PortalProbe {
  @Get()
  read(@Req() req: Seen) {
    return who(req);
  }

  @Post()
  write(@Req() req: Seen) {
    return who(req);
  }
}

@Audience('hook')
@Controller('hooks/things')
class HookProbe {
  @Post()
  receive(@Req() req: Seen) {
    return who(req);
  }
}

@Audience('public')
@Public()
@Controller('open')
class PublicProbe {
  @Get()
  read(@Req() req: Seen) {
    return who(req);
  }
}

const ORIGIN = 'https://erp.example.com';
const COOKIE = 'better-auth.session_token=abc.def';
const USER_ID = '0190c0de-0000-7000-8000-000000000001';

/** A Better Auth stand in: a live session for the one cookie above, none otherwise. */
function fakeAuth() {
  const getSession = vi.fn((input: { headers: Headers }) =>
    Promise.resolve({
      response: input.headers.get('cookie')?.includes(COOKIE)
        ? {
            user: {
              id: USER_ID,
              name: 'Sam',
              email: 'sam@example.com',
              role: 'user',
              banned: false,
              mustChangePassword: false,
              twoFactorEnabled: false,
            },
            session: { id: 's1', token: 't1', createdAt: new Date() },
          }
        : null,
      headers: new Headers(),
    }),
  );
  const deleteUserSessions = vi.fn(() => Promise.resolve());
  const auth = {
    api: { getSession },
    $context: Promise.resolve({ internalAdapter: { deleteUserSessions } }),
  } as unknown as Auth;
  return { auth, getSession };
}

async function createApp(options: {
  fullChain: boolean;
  audiences: SessionAudience[];
  /** The hats the fake loader answers; by default one hat of each audience given. */
  hats?: string[];
}) {
  const { auth, getSession } = fakeAuth();
  const hats =
    options.hats ??
    options.audiences.map((audience) => (audience === 'partner' ? 'partner' : 'warehouse'));
  const load = vi.fn((userId: string) =>
    Promise.resolve(
      new Access({
        userId,
        hats,
        grants: [],
        partnerAccountId: hats.includes('partner') ? '0190c0de-0000-7000-8000-0000000000aa' : null,
      }),
    ),
  );
  const env = { PUBLIC_URL: ORIGIN } as Env;
  const guards = [
    {
      provide: APP_GUARD,
      inject: [Reflector],
      useFactory: (reflector: Reflector) => new SessionGuard(reflector, auth, env, { load }),
    },
    ...(options.fullChain
      ? [
          { provide: APP_GUARD, useFactory: () => new AudienceGuard() },
          { provide: APP_GUARD, useFactory: () => new PermissionGuard() },
        ]
      : []),
  ];
  const moduleRef = await Test.createTestingModule({
    controllers: [StaffProbe, PartnerProbe, PortalProbe, HookProbe, PublicProbe],
    providers: guards,
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<Server>>({ logger: false });
  await app.init();
  return { app, getSession, load };
}

describe('the session guard over HTTP (AC-29)', () => {
  let app: INestApplication<Server> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  describe('the session guard alone, so every handler it lets through runs', () => {
    it.each([
      ['a portal route', 'get', '/portal/things'],
      ['a portal write', 'post', '/portal/things'],
      ['a hook route', 'post', '/hooks/things'],
    ] as const)(
      'gives %s no user from a valid staff cookie, and never asks for the session',
      async (_case, method, path) => {
        const made = await createApp({ fullChain: false, audiences: ['staff'] });
        app = made.app;

        const response = await request(app.getHttpServer())
          [method](path)
          .set('cookie', COOKIE)
          .set('origin', 'https://portal.example.com');

        expect(response.status).toBeLessThan(300);
        expect(response.body).toEqual({ staff: null, partner: null });
        expect(made.getSession).not.toHaveBeenCalled();
        expect(made.load).not.toHaveBeenCalled();
      },
    );

    it('gives a public route no user from a valid staff cookie, and never asks for the session', async () => {
      const made = await createApp({ fullChain: false, audiences: ['staff'] });
      app = made.app;

      const response = await request(app.getHttpServer()).get('/open').set('cookie', COOKIE);

      expect(response.body).toEqual({ staff: null, partner: null });
      expect(made.getSession).not.toHaveBeenCalled();
    });

    it('puts a staff person on a staff route and a partner user on a partner route', async () => {
      const staff = await createApp({ fullChain: false, audiences: ['staff'] });
      app = staff.app;
      const onStaff = await request(app.getHttpServer()).get('/things').set('cookie', COOKIE);
      await app.close();
      const partner = await createApp({ fullChain: false, audiences: ['partner'] });
      app = partner.app;
      const onPartner = await request(app.getHttpServer())
        .get('/partner/things')
        .set('cookie', COOKIE);

      expect(onStaff.body).toEqual({ staff: USER_ID, partner: null });
      expect(onPartner.body).toEqual({ staff: null, partner: USER_ID });
    });

    it.each([
      ['a staff session on a partner route', ['staff'], '/partner/things'],
      ['a partner session on a staff route', ['partner'], '/things'],
    ] as const)('answers 403 WRONG_AUDIENCE to %s', async (_case, audiences, path) => {
      const made = await createApp({ fullChain: false, audiences: [...audiences] });
      app = made.app;

      const response = await request(app.getHttpServer()).get(path).set('cookie', COOKIE);

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: 'WRONG_AUDIENCE' });
    });

    it.each(['/things', '/partner/things'])(
      'answers 401 UNAUTHENTICATED without a cookie on %s',
      async (path) => {
        const made = await createApp({ fullChain: false, audiences: ['staff'] });
        app = made.app;

        const response = await request(app.getHttpServer()).get(path);

        expect(response.status).toBe(401);
        expect(response.body).toMatchObject({ code: 'UNAUTHENTICATED' });
      },
    );
  });

  describe('the session, audience and permission guards in that order, built by hand', () => {
    it('answers 403 FORBIDDEN, naming no permission, to a staff person without it (spec 0008)', async () => {
      const made = await createApp({ fullChain: true, audiences: ['staff'] });
      app = made.app;

      const response = await request(app.getHttpServer())
        .get('/things/managed')
        .set('cookie', COOKIE);

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        code: 'FORBIDDEN',
        message: 'You do not have access to this.',
      });
    });

    it('lets a person whose hat holds the permission through (spec 0008)', async () => {
      const made = await createApp({ fullChain: true, audiences: ['staff'], hats: ['manager'] });
      app = made.app;

      const response = await request(app.getHttpServer())
        .get('/things/managed')
        .set('cookie', COOKIE);

      expect(response.status).toBe(200);
    });

    it('answers 500 PERMISSION_MISSING for a staff handler with no declaration (spec 0008)', async () => {
      const made = await createApp({ fullChain: true, audiences: ['staff'], hats: ['manager'] });
      app = made.app;

      const response = await request(app.getHttpServer())
        .get('/things/undeclared')
        .set('cookie', COOKIE);

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({ code: 'PERMISSION_MISSING' });
    });

    it('lets a staff session use a staff route', async () => {
      const made = await createApp({ fullChain: true, audiences: ['staff'] });
      app = made.app;

      const response = await request(app.getHttpServer()).get('/things').set('cookie', COOKIE);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ staff: USER_ID, partner: null });
    });

    it.each([
      ['a portal route', 'get', '/portal/things'],
      ['a hook route', 'post', '/hooks/things'],
    ] as const)(
      'refuses a valid staff cookie on %s without ever reading it',
      async (_case, method, path) => {
        const made = await createApp({ fullChain: true, audiences: ['staff'] });
        app = made.app;

        const response = await request(app.getHttpServer())[method](path).set('cookie', COOKIE);

        expect(response.status).toBe(403);
        expect(response.body).toMatchObject({ code: 'WRONG_AUDIENCE' });
        expect(made.getSession).not.toHaveBeenCalled();
      },
    );

    it('answers 403 WRONG_AUDIENCE to a staff session on a partner route', async () => {
      const made = await createApp({ fullChain: true, audiences: ['staff'] });
      app = made.app;

      const response = await request(app.getHttpServer())
        .get('/partner/things')
        .set('cookie', COOKIE);

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: 'WRONG_AUDIENCE' });
    });

    it('lets a partner session reach a partner handler end to end, as a partner only', async () => {
      const made = await createApp({ fullChain: true, audiences: ['partner'] });
      app = made.app;

      const response = await request(app.getHttpServer())
        .get('/partner/things')
        .set('cookie', COOKIE);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ staff: null, partner: USER_ID });
    });

    it('answers 403 WRONG_AUDIENCE to a partner session on a staff route', async () => {
      const made = await createApp({ fullChain: true, audiences: ['partner'] });
      app = made.app;

      const response = await request(app.getHttpServer()).get('/things').set('cookie', COOKIE);

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: 'WRONG_AUDIENCE' });
    });

    it.each([
      ['a portal route', 'get', '/portal/things'],
      ['a hook route', 'post', '/hooks/things'],
    ] as const)(
      'refuses a valid partner cookie on %s without ever reading it',
      async (_case, method, path) => {
        const made = await createApp({ fullChain: true, audiences: ['partner'] });
        app = made.app;

        const response = await request(app.getHttpServer())[method](path).set('cookie', COOKIE);

        expect(response.status).toBe(403);
        expect(response.body).toMatchObject({ code: 'WRONG_AUDIENCE' });
        expect(made.getSession).not.toHaveBeenCalled();
      },
    );
  });
});
