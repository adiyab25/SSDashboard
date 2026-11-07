import { Module } from '@nestjs/common';
import { PartnerAccounts } from './partner-accounts.service.js';

/**
 * The partners module (spec 0008 milestone 3, before feature 41): consignment partner accounts
 * as other modules may see them, through one exported service, `PartnerAccounts`. It owns
 * `parties`; no other module reads that table. It has no routes yet.
 */
@Module({
  providers: [PartnerAccounts],
  exports: [PartnerAccounts],
})
export class PartnersModule {}
