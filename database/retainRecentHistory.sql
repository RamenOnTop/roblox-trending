-- Install after deploying archive-backed chart rebuilds. Setup itself deletes no rows.
-- The maintenance worker supplies only digests whose release files it freshly verified.
begin;
create or replace function public."inspectHourlyRetention"("hourlyRetentionDays" integer default 14)
returns jsonb language plpgsql security definer set search_path = '' set timezone = 'UTC'
as $$
declare result jsonb;
begin
  if "hourlyRetentionDays" < 14 or "hourlyRetentionDays" > 365 then raise exception 'Keep at least 14 days of hourly history'; end if;
  with candidates as (
    select (h."capturedAt" at time zone 'UTC')::date as day,
      exists(select 1 from public."historyArchives" a where a."archiveDay"=(h."capturedAt" at time zone 'UTC')::date and a."prunedAt" is not null)
      and not exists(select 1 from public."trendSnapshots" s where s."gameId"=h."gameId" and s."capturedAt"=h."capturedAt") as covered
    from public."trendHourlySamples" h
    where h."bucketAt" < ((now() at time zone 'UTC')::date-"hourlyRetentionDays")::timestamp at time zone 'UTC'
  ) select jsonb_build_object('candidateRows',count(*) filter(where covered),'unverifiedRows',count(*) filter(where not covered),
      'archiveDays',coalesce(jsonb_agg(distinct day) filter(where covered),'[]'::jsonb)) into result from candidates;
  return result;
end;
$$;

create or replace function public."pruneVerifiedHourlyHistory"("hourlyRetentionDays" integer, "verifiedArchiveDigests" text[])
returns bigint language plpgsql security definer set search_path = '' set timezone = 'UTC'
as $$
declare removed bigint;
begin
  if "hourlyRetentionDays" < 14 or "hourlyRetentionDays" > 365 then raise exception 'Keep at least 14 days of hourly history'; end if;
  if "verifiedArchiveDigests" is null or cardinality("verifiedArchiveDigests")=0 or cardinality("verifiedArchiveDigests")>366
    or exists(select 1 from unnest("verifiedArchiveDigests") digest where digest is null or digest !~ '^[a-f0-9]{64}$')
  then raise exception 'Freshly verified archive digests are required'; end if;
  delete from public."trendHourlySamples" h
  where h."bucketAt" < ((now() at time zone 'UTC')::date-"hourlyRetentionDays")::timestamp at time zone 'UTC'
    and exists(select 1 from public."historyArchives" a where a."archiveDay"=(h."capturedAt" at time zone 'UTC')::date
      and a."prunedAt" is not null and a."archiveDigest"=any("verifiedArchiveDigests"))
    and not exists(select 1 from public."trendSnapshots" s where s."gameId"=h."gameId" and s."capturedAt"=h."capturedAt");
  get diagnostics removed=row_count;
  return removed;
end;
$$;
revoke all on function public."inspectHourlyRetention"(integer) from public,anon,authenticated;
revoke all on function public."pruneVerifiedHourlyHistory"(integer,text[]) from public,anon,authenticated;
grant execute on function public."inspectHourlyRetention"(integer) to service_role;
grant execute on function public."pruneVerifiedHourlyHistory"(integer,text[]) to service_role;
notify pgrst,'reload schema';
commit;
