-- Additive migration. Preserves all existing Roblox history.
begin;
create table if not exists public."trendEnrichment" (
  "gameId" text primary key references public."trendGames"(id),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  "refreshedAt" timestamptz not null
);
alter table public."trendEnrichment" enable row level security;
revoke all on public."trendEnrichment" from public, anon, authenticated;
grant select, insert, update on public."trendEnrichment" to service_role;
notify pgrst, 'reload schema';
commit;
