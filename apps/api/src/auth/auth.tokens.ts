import type { createAuth } from './auth.factory.js';

/** The Nest injection token for the Better Auth instance. */
export const AUTH = Symbol('AUTH');
/**
 * The type of the Better Auth instance the factory builds, so injected code is typed without
 * importing the factory.
 */
export type Auth = ReturnType<typeof createAuth>;
