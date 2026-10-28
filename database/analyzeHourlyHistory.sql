-- Run separately after pruning/index maintenance. Makes dead-row space reusable.
-- This is ordinary vacuum, not a full table rewrite. Do not wrap in BEGIN/COMMIT.
vacuum (analyze) public."trendHourlySamples";
