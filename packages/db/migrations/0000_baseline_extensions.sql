-- Hand written (spec 0002, A2). The extensions the model needs, in a file of their own so a
-- regenerated tables file never touches them.
-- pg_trgm and unaccent: search across 100,000+ SKUs, fuzzy and partial matching, accent folding.
-- btree_gist: the settlement period overlap constraint (ships in PostgreSQL's contrib set).
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS unaccent;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;
