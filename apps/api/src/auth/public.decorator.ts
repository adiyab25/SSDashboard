import { SetMetadata } from '@nestjs/common';

/** The metadata key the `@Public()` decorator sets and the session guard reads. */
export const IS_PUBLIC = 'isPublic';

/** Marks a route that needs no session: config, health, and nothing else (spec 0005, AC-7). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
