import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';

/** Module that mounts the health controller. */
@Module({ controllers: [HealthController] })
export class HealthModule {}
