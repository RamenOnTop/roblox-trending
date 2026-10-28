-- One-time maintenance after verified hourly pruning. Run as a single SQL Editor query.
-- Rebuilds the existing indexes while allowing normal inserts, updates and deletes.
-- Do not wrap this command in BEGIN/COMMIT.
reindex table concurrently public."trendHourlySamples";
