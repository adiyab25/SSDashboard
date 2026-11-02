import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { HealthResponse } from '@ssdashboard/contracts';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ENV } from '../config/config.module.js';
import { DATABASE } from '../database/database.module.js';
import { HealthController } from './health.controller.js';

type Execute = () => Promise<unknown>;

async function createApp(execute: Execute): Promise<INestApplication<Server>> {
  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      { provide: DATABASE, useValue: { db: { execute: vi.fn(execute) } } },
      { provide: ENV, useValue: { APP_VERSION: '1.2.3' } },
    ],
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<Server>>({ logger: false });
  await app.init();
  return app;
}

describe('GET /health', () => {
  let app: INestApplication<Server> | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await app?.close();
    app = undefined;
  });

  it('reports ok and the release version when the database answers', async () => {
    app = await createApp(() => Promise.resolve({ rows: [] }));

    const response = await request(app.getHttpServer()).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', version: '1.2.3', database: 'up' });
  });

  it('still answers 200 but reports degraded when the database query fails', async () => {
    app = await createApp(() => Promise.reject(new Error('connect ECONNREFUSED')));

    const response = await request(app.getHttpServer()).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'degraded', version: '1.2.3', database: 'down' });
  });

  it('does not leak the database error in the response', async () => {
    app = await createApp(() =>
      Promise.reject(new Error('password authentication failed for user "ssd"')),
    );

    const response = await request(app.getHttpServer()).get('/health');

    expect(JSON.stringify(response.body)).not.toContain('password');
  });

  it('matches the shared HealthResponse contract the web app parses', async () => {
    app = await createApp(() => Promise.resolve({ rows: [] }));

    const response = await request(app.getHttpServer()).get('/health');

    expect(HealthResponse.safeParse(response.body).success).toBe(true);
  });
});

describe('HealthController.check', () => {
  const env = { APP_VERSION: '1.2.3' } as never;

  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives up on a database that hangs and reports degraded after 2 seconds', async () => {
    vi.useFakeTimers();
    const controller = new HealthController(
      { db: { execute: () => new Promise(() => {}) } } as never,
      env,
    );

    const result = controller.check();
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(result).resolves.toEqual({
      status: 'degraded',
      version: '1.2.3',
      database: 'down',
    });
  });

  it('is still waiting just before the 2 second limit', async () => {
    vi.useFakeTimers();
    const controller = new HealthController(
      { db: { execute: () => new Promise(() => {}) } } as never,
      env,
    );
    let settled = false;

    void controller.check().then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(1_999);

    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });

  it('leaves no timer running once the database has answered', async () => {
    vi.useFakeTimers();
    const controller = new HealthController(
      { db: { execute: () => Promise.resolve({}) } } as never,
      env,
    );

    await controller.check();

    expect(vi.getTimerCount()).toBe(0);
  });
});
