import { ConfigResponse } from '@ssdashboard/contracts';
import { describe, expect, it } from 'vitest';
import type { Env } from '../config/env.js';
import { ConfigController } from './config.controller.js';

describe('ConfigController', () => {
  it('answers with the install name and release version from the env', () => {
    const controller = new ConfigController({
      CLIENT_DISPLAY_NAME: 'Acme Home',
      APP_VERSION: '1.2.3',
    } as Env);

    expect(ConfigResponse.parse(controller.read())).toEqual({
      clientName: 'Acme Home',
      version: '1.2.3',
    });
  });
});
