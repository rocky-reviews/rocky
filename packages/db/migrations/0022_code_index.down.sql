-- Back to the 0021 shape. The index is derived data (rebuilt from GitHub): it goes with its
-- tables, and the vectors go with the column they can no longer fit.

DROP FUNCTION worker.claim_code_indexes(integer, integer);

ALTER TABLE embeddings NO FORCE ROW LEVEL SECURITY;
DELETE FROM embeddings;
ALTER TABLE embeddings FORCE ROW LEVEL SECURITY;

DROP INDEX embeddings_hnsw_idx;
DROP INDEX embeddings_code_space_idx;
DROP INDEX embeddings_code_chunk_space_unique;
ALTER TABLE embeddings
  DROP CONSTRAINT embeddings_code_chunk_kind,
  DROP CONSTRAINT embeddings_code_chunk_fk,
  DROP CONSTRAINT embeddings_model_shape,
  DROP COLUMN code_chunk_id,
  DROP COLUMN dimensions,
  DROP COLUMN provider,
  ALTER COLUMN embedding TYPE vector(1536);

DROP TABLE code_chunks;
DROP TABLE code_files;
DROP TABLE code_indexes;

-- Queued pushes cannot be decoded by the older code: they go too, with their lane rows in the
-- ready queue (0014's pattern; FORCE RLS lifted for these statements only).
ALTER TABLE app.webhook_deliveries NO FORCE ROW LEVEL SECURITY;
DELETE FROM app.webhook_deliveries WHERE event_type LIKE 'repository.%';
ALTER TABLE app.webhook_deliveries FORCE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_queue NO FORCE ROW LEVEL SECURITY;
DELETE FROM app.webhook_queue WHERE lane = 'repository';
ALTER TABLE app.webhook_queue FORCE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_deliveries DROP CONSTRAINT webhook_deliveries_repository_shape;
ALTER TABLE app.webhook_deliveries DROP CONSTRAINT webhook_deliveries_event_type_check;
ALTER TABLE app.webhook_deliveries ADD CONSTRAINT webhook_deliveries_event_type_check
  CHECK (event_type IN (
    'installation.created', 'installation.deleted',
    'pull_request.opened', 'pull_request.synchronize',
    'pull_request.closed', 'pull_request.reopened',
    'org_member.removed'));
