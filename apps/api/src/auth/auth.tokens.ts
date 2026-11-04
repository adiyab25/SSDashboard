import type { createAuth } from './auth.factory.js';

export const AUTH = Symbol('AUTH');
export type Auth = ReturnType<typeof createAuth>;
