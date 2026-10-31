-- Search across 100,000+ SKUs: fuzzy and partial matching, and accent folding.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
