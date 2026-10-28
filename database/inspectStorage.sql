-- Read-only Supabase storage audit. Does not change data or retention.
select pg_size_pretty(pg_database_size(current_database())) as "databaseSize";

select schemaname as "schemaName", relname as "tableName",
  pg_total_relation_size(relid) as "totalBytes",
  pg_size_pretty(pg_total_relation_size(relid)) as "totalSize",
  pg_size_pretty(pg_table_size(relid)) as "tableSize",
  pg_size_pretty(pg_indexes_size(relid)) as "indexSize",
  n_live_tup as "estimatedLiveRows", n_dead_tup as "estimatedDeadRows",
  last_autovacuum as "lastAutovacuum"
from pg_stat_user_tables
order by pg_total_relation_size(relid) desc;

select 'rawSnapshots' as kind, min("capturedAt") as "oldestObservation",
  max("capturedAt") as "newestObservation", count(*) as rows
from public."trendSnapshots"
union all
select 'hourlySamples', min("capturedAt"), max("capturedAt"), count(*)
from public."trendHourlySamples";

select "archiveDay", "rowCount", "verifiedAt", "prunedAt"
from public."historyArchives" order by "archiveDay" desc limit 12;
