export * from './client.js';
export * from './migrate.js';
export * as schema from './schema/index.js';
// The api builds queries with these, so the whole repo shares this package's one Drizzle
// instance (a second copy, pulled in by another peer dependency, has incompatible types).
export { and, inArray, isNull, sql, type SQL } from 'drizzle-orm';
