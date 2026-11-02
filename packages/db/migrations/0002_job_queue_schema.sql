-- pg-boss (the `worker` entry point) keeps its job tables in their own schema. The
-- application role owns it, so pg-boss can install and upgrade itself there, and the
-- application role still needs no CREATE right on the database.
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION ssdashboard_app;
