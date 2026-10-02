-- Additive setup for the fresh collector. Existing tables and data are untouched.
-- Run once in the NEW Supabase project's SQL Editor before connecting Actions secrets.
create table if not exists public."collectionRuns" (
  id uuid primary key,
  "startedAt" timestamptz not null,
  "completedAt" timestamptz,
  status text not null check (status in ('running', 'complete', 'failed')),
  "requestedGames" integer not null default 0,
  "collectedGames" integer not null default 0,
  warning text
);

create table if not exists public."trendGames" (
  id text primary key check (id ~ '^[1-9][0-9]*$'),
  "rootPlaceId" text,
  name text not null,
  description text not null default '',
  creator text not null,
  "creatorId" text,
  "creatorType" text,
  "genreL1" text,
  "genreL2" text,
  "maxPlayers" integer,
  "createdAt" timestamptz,
  "updatedAt" timestamptz,
  "firstSeenAt" timestamptz not null default now(),
  "lastSeenAt" timestamptz not null
);

create table if not exists public."trendSnapshots" (
  "gameId" text not null references public."trendGames"(id),
  "capturedAt" timestamptz not null,
  "activePlayers" bigint not null check ("activePlayers" >= 0),
  visits bigint,
  favorites bigint,
  "upVotes" bigint,
  "downVotes" bigint,
  "likeRatio" double precision check ("likeRatio" between 0 and 1),
  "collectionId" uuid not null references public."collectionRuns"(id),
  primary key ("gameId", "capturedAt")
);

-- Compact latest observation per hour for dashboard queries; raw snapshots remain for ML.
create table if not exists public."trendHourlySamples" (
  "gameId" text not null references public."trendGames"(id),
  "bucketAt" timestamptz not null,
  "capturedAt" timestamptz not null,
  "activePlayers" bigint not null check ("activePlayers" >= 0),
  visits bigint,
  favorites bigint,
  "upVotes" bigint,
  "downVotes" bigint,
  "likeRatio" double precision check ("likeRatio" between 0 and 1),
  "collectionId" uuid not null references public."collectionRuns"(id),
  primary key ("gameId", "bucketAt")
);

create index if not exists "trendGamesLastSeen" on public."trendGames" ("lastSeenAt" desc);
create index if not exists "trendSnapshotsCaptured" on public."trendSnapshots" ("capturedAt" desc, "gameId");
create index if not exists "trendHourlyCursor" on public."trendHourlySamples" ("bucketAt" desc, "gameId");

alter table public."collectionRuns" enable row level security;
alter table public."trendGames" enable row level security;
alter table public."trendSnapshots" enable row level security;
alter table public."trendHourlySamples" enable row level security;

-- Pages receives only generated public Roblox statistics. Browsers get no database secret.
revoke all on public."collectionRuns", public."trendGames", public."trendSnapshots", public."trendHourlySamples" from anon, authenticated;
grant select, insert, update on public."collectionRuns", public."trendGames", public."trendSnapshots", public."trendHourlySamples" to service_role;
