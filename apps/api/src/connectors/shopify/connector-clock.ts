import { Injectable } from '@nestjs/common';

/**
 * The clock the Shopify jobs judge waiting times by (spec 0015 AC-8: reads failing for 3 hours).
 * The real one is the process clock; a test binds a moved clock in its place
 * (`overrideProvider(ConnectorClock)`) instead of backdating rows. Never used for a value stored as
 * a business time: the database stamps those.
 */
@Injectable()
export class ConnectorClock {
  /** The current instant. */
  now(): Date {
    return new Date();
  }
}
