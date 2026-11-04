import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { StaffController } from './staff.controller.js';
import { StaffService } from './staff.service.js';

/** Staff administration (spec 0005): the admin only `/api/staff` endpoints. */
@Module({
  imports: [MailModule, PlatformModule],
  controllers: [StaffController],
  providers: [StaffService],
})
export class StaffModule {}
