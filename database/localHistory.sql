-- Local PostgreSQL only. No Supabase credentials or cloud deletion functions.
begin;
create schema if not exists "localHistory";
create table if not exists "localHistory"."snapshots" (
  "gameId" text not null check ("gameId" ~ '^[1-9][0-9]*$'),
  "capturedAt" timestamptz not null,
  "activePlayers" bigint not null check ("activePlayers" >= 0),
  visits bigint,
  favorites bigint,
  "upVotes" bigint,
  "downVotes" bigint,
  "likeRatio" double precision,
  "collectionId" uuid not null,
  "sourceRow" jsonb not null,
  primary key ("gameId", "capturedAt")
);
create index if not exists "localSnapshotsTime" on "localHistory"."snapshots" ("capturedAt");
create table if not exists "localHistory"."archiveImports" (
  "archiveDigest" text primary key,
  "archiveName" text unique not null,
  "archiveDay" date not null,
  "rowCount" bigint not null check ("rowCount" > 0),
  "sourceFingerprint" text not null,
  "importedAt" timestamptz not null default now()
);
create table if not exists "localHistory"."gameCatalog" (
  "gameId" text primary key,
  name text not null,
  creator text,
  "genreL1" text,
  "observedAt" timestamptz not null,
  "sourceRow" jsonb not null
);
commit;
