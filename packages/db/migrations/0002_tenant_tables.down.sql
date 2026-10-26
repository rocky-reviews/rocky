-- Reverse dependency order; CASCADE is not used so a forgotten dependency fails loudly.
DROP TABLE IF EXISTS jobs;
DROP TABLE IF EXISTS llm_usage;
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS embeddings;
DROP TABLE IF EXISTS memory_entries;
DROP TABLE IF EXISTS comments_pending;
DROP TABLE IF EXISTS findings_state;
DROP TABLE IF EXISTS analyses;
DROP TABLE IF EXISTS pr_revisions;
DROP TABLE IF EXISTS pull_requests;
DROP TABLE IF EXISTS repos;
DROP TABLE IF EXISTS members;
DROP TABLE IF EXISTS orgs;
