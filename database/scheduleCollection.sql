-- Requires a fine-grained GitHub token saved in Supabase Vault as robloxWorkflowToken.
-- Token scope: RamenOnTop/roblox-trending only, Actions read and write.
-- No credential belongs in this file or in a saved SQL Editor snippet.
-- Run only after approving storage of that token in the Roblox project's Vault.
begin;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'robloxWorkflowToken' and length(decrypted_secret) >= 20)
  then raise exception 'Save the repository-scoped GitHub token in Vault as robloxWorkflowToken before enabling collection';
  end if;
end;
$$;

create schema if not exists "collectorPrivate";
revoke all on schema "collectorPrivate" from public, anon, authenticated, service_role;

create or replace function "collectorPrivate"."dispatchRobloxCollection"("force" boolean default false)
returns bigint language plpgsql security invoker set search_path = ''
as $$
declare
  workflowToken text;
  requestId bigint;
begin
  if not pg_try_advisory_xact_lock(hashtext('RobloxTrendsCollection')) then return null; end if;
  -- A real collection already in progress does not need a second trigger.
  -- Stale running records from failed/terminated runs expire after the build timeout.
  if not "force" and exists (
    select 1 from public."collectionRuns"
    where status = 'running' and "startedAt" > now() - interval '25 minutes'
  ) then return null; end if;
  select decrypted_secret into workflowToken from vault.decrypted_secrets where name = 'robloxWorkflowToken';
  if workflowToken is null or length(workflowToken) < 20 then
    raise exception 'The Roblox workflow token is missing from Vault';
  end if;
  select net.http_post(
    url := 'https://api.github.com/repos/RamenOnTop/roblox-trending/actions/workflows/pages.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || workflowToken,
      'Accept', 'application/vnd.github+json',
      'Content-Type', 'application/json',
      'User-Agent', 'RobloxTrendsScheduler/1.0',
      'X-GitHub-Api-Version', '2026-03-10'
    ),
    body := jsonb_build_object('ref', 'main'),
    timeout_milliseconds := 10000
  ) into requestId;
  return requestId;
end;
$$;
revoke all on function "collectorPrivate"."dispatchRobloxCollection"(boolean) from public, anon, authenticated, service_role;

-- Re-running replaces the job with this name instead of adding a second timer.
select cron.schedule('robloxCollection', '13,43 * * * *', 'select "collectorPrivate"."dispatchRobloxCollection"();');
commit;

-- Manual verification (administrator only):
-- select "collectorPrivate"."dispatchRobloxCollection"(true) as "requestId";
-- Then inspect net._http_response for that ID: HTTP 200/204 means GitHub accepted it.
-- Confirm the resulting Actions run AND the published dashboard timestamp.
-- Once verified, remove only the native schedule block in pages.yml to avoid two timers.
-- Keep push, workflow_dispatch, and Actions concurrency protection.
-- Pause this timer without deleting observations:
-- select cron.alter_job((select jobid from cron.job where jobname='robloxCollection'), active := false);
