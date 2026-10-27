-- 0011 reserved for P4-5 (0011_llm_metering), which merges before P4-6.
--
-- Migration versions must be 1..n (packages/db/src/migrate.ts), and P4-6's migration is 0012.
-- This empty placeholder keeps the P4-6 branch loadable on its own. Delete both
-- 0011_reserved_p4_5 files when rebasing onto P4-5: with both present the loader refuses to start
-- ("two names for version 11"), so it cannot be forgotten.
SELECT 1;
