import { Controller, Get, Inject } from '@nestjs/common';
import type { ConfigResponse } from '@ssdashboard/contracts';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

/** Public by design: the shell and the sign in page need it, and it holds nothing secret. */
@Controller('config')
export class ConfigController {
  constructor(@Inject(ENV) private readonly env: Env) {}

  @Get()
  read(): ConfigResponse {
    return { clientName: this.env.CLIENT_DISPLAY_NAME, version: this.env.APP_VERSION };
  }
}
