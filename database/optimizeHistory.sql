-- Additive setup. Running this file does not delete observations.
-- Only the server collector can call these functions. Pruning requires a verified archive.
begin;
create index if not exists "trendHourlyCaptured" on public."trendHourlySamples" ("capturedAt" desc, "gameId");
create table if not exists public."historyArchives" (
  "archiveDigest" text primary key check ("archiveDigest" ~ '^[a-f0-9]{64}$'),
  "archiveDay" date not null,
  "rowCount" bigint not null check ("rowCount" > 0),
  "sourceFingerprint" text not null,
  "archiveUrl" text not null,
  "verifiedAt" timestamptz not null default now(),
  "prunedAt" timestamptz
);
create index if not exists "historyArchivesDay" on public."historyArchives" ("archiveDay");
alter table public."historyArchives" enable row level security;
revoke all on public."historyArchives" from public, anon, authenticated, service_role;
grant select on public."historyArchives" to service_role;

create or replace function public."inspectHistoryDay"("archiveDay" date)
returns jsonb language sql security definer set search_path = '' set timezone = 'UTC'
as $$
  select jsonb_build_object('rowCount',count(*),'sourceFingerprint',md5(coalesce(string_agg(to_jsonb(s)::text,E'\n' order by s."capturedAt",s."gameId"),'')))
  from public."trendSnapshots" s
  where s."capturedAt" >= "archiveDay"::timestamp at time zone 'UTC'
    and s."capturedAt" < ("archiveDay"+1)::timestamp at time zone 'UTC';
$$;

create or replace function public."finalizeHistoryArchive"(
  "archiveDay" date, "expectedRows" bigint, "sourceFingerprint" text,
  "archiveDigest" text, "archiveUrl" text, "rawRetentionDays" integer default 7
) returns jsonb language plpgsql security definer set search_path = '' set timezone = 'UTC'
as $$
declare
  inspection jsonb;
  existing public."historyArchives"%rowtype;
  removed bigint := 0;
begin
  if "archiveDay" >= (now() at time zone 'UTC')::date or "expectedRows" <= 0
    or "rawRetentionDays" < 7 or "rawRetentionDays" > 365
    or "archiveDigest" !~ '^[a-f0-9]{64}$'
    or "archiveUrl" !~ '^https://github.com/RamenOnTop/roblox-trending/releases/download/roblox-history/trendSnapshots-[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-f0-9]{64}\.jsonl\.gz$'
  then raise exception 'Invalid archive metadata or retention window'; end if;
  -- Source fingerprint checks every original column. A late insert or update stops deletion.
  lock table public."trendSnapshots" in share row exclusive mode;
  inspection := public."inspectHistoryDay"("archiveDay");
  if (inspection->>'rowCount')::bigint <> "expectedRows" or inspection->>'sourceFingerprint' <> "sourceFingerprint"
  then raise exception 'Archive source changed; refusing to prune'; end if;
  select a.* into existing from public."historyArchives" a where a."archiveDigest" = "finalizeHistoryArchive"."archiveDigest";
  if found and (existing."archiveDay" <> "archiveDay" or existing."rowCount" <> "expectedRows" or existing."sourceFingerprint" <> "sourceFingerprint" or existing."archiveUrl" <> "archiveUrl")
  then raise exception 'Archive metadata conflicts with existing verification'; end if;
  insert into public."historyArchives" ("archiveDigest","archiveDay","rowCount","sourceFingerprint","archiveUrl")
    values ("archiveDigest","archiveDay","expectedRows","sourceFingerprint","archiveUrl") on conflict do nothing;
  if "archiveDay" < (now() at time zone 'UTC')::date - "rawRetentionDays" then
    delete from public."trendSnapshots" s where s."capturedAt" >= "archiveDay"::timestamp at time zone 'UTC'
      and s."capturedAt" < ("archiveDay"+1)::timestamp at time zone 'UTC';
    get diagnostics removed = row_count;
    update public."historyArchives" a set "prunedAt" = now() where a."archiveDigest" = "finalizeHistoryArchive"."archiveDigest";
  end if;
  return jsonb_build_object('archivedRows',"expectedRows",'prunedRows',removed);
end;
$$;

create or replace function public."pruneArchivedHourlyHistory"("hourlyRetentionDays" integer default 35)
returns bigint language plpgsql security definer set search_path = '' set timezone = 'UTC'
as $$
declare removed bigint;
begin
  if "hourlyRetentionDays" < 35 or "hourlyRetentionDays" > 365 then raise exception 'Keep at least 35 days of hourly history'; end if;
  delete from public."trendHourlySamples" h where h."bucketAt" < ((now() at time zone 'UTC')::date - "hourlyRetentionDays")::timestamp at time zone 'UTC'
    and exists (select 1 from public."historyArchives" a where a."archiveDay" = (h."capturedAt" at time zone 'UTC')::date and a."prunedAt" is not null)
    and not exists (select 1 from public."trendSnapshots" s where s."gameId" = h."gameId" and s."capturedAt" = h."capturedAt");
  get diagnostics removed = row_count;
  return removed;
end;
$$;
revoke all on function public."inspectHistoryDay"(date) from public, anon, authenticated;
revoke all on function public."finalizeHistoryArchive"(date,bigint,text,text,text,integer) from public, anon, authenticated;
revoke all on function public."pruneArchivedHourlyHistory"(integer) from public, anon, authenticated;
grant execute on function public."inspectHistoryDay"(date) to service_role;
grant execute on function public."finalizeHistoryArchive"(date,bigint,text,text,text,integer) to service_role;
grant execute on function public."pruneArchivedHourlyHistory"(integer) to service_role;
notify pgrst, 'reload schema';
commit;
