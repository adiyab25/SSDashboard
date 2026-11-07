/**
 * pg-boss keeps its tables in this schema, created by migration and owned by the app role. Every
 * pg-boss client of the api and the worker passes it with `createSchema: false`, because the app
 * role cannot create schemas.
 */
export const JOB_SCHEMA = 'pgboss';
