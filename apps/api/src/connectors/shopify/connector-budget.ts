import { Injectable } from '@nestjs/common';

/**
 * The work limits of one sweep, backfill, or gateway scan chunk (spec 0015 AC-25, *Rate policy*,
 * *Inbound processing* item 2): a chunk ends after 60 seconds or 3,000 Shopify cost points spent,
 * leaving its run `partial` with its position recorded, and its next job continues it; a running
 * bulk operation is polled every 30 seconds. A chunk always handles at least one page or object
 * before it checks the limits, so every chunk moves forward. A test binds smaller limits
 * (`overrideProvider(ConnectorBudget)`) to stop a chunk early; nothing else changes them.
 */
@Injectable()
export class ConnectorBudget {
  /** How long one chunk may work, in milliseconds. */
  chunkMillis = 60_000;
  /** How many Shopify cost points one chunk may spend. */
  chunkPoints = 3_000;
  /** How long to wait between two polls of a running bulk operation, in seconds. */
  bulkPollSeconds = 30;
}
