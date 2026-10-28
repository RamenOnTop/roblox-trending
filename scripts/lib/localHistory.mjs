
export const archivePattern=/^trendSnapshots-(\d{4}-\d{2}-\d{2})-([a-f0-9]{64})\.jsonl\.gz$/;
export const sqlValue=value=>`'${String(value).replaceAll("'","''")}'`;
export const csvJson=row=>`"${JSON.stringify(row).replaceAll('"','""')}"`;

export {readSnapshotArchive as verifyLocalArchive} from './historyArchive.mjs';

export const beginImportSql=`begin;
lock table "localHistory"."snapshots" in share row exclusive mode;
create temporary table "incomingRows" (payload jsonb not null) on commit drop;
`;

export function finishImportSql(name,manifest){
  return `
do $verification$ begin
  if (select count(*) from "incomingRows") <> ${manifest.rowCount} then
    raise exception 'Incomplete incoming archive';
  end if;
  if exists (
    select 1 from "incomingRows" i join "localHistory"."snapshots" s
      on s."gameId"=i.payload->>'gameId' and s."capturedAt"=(i.payload->>'capturedAt')::timestamptz
    where s."sourceRow" is distinct from i.payload
  ) then raise exception 'Conflicting archive version; existing local observations were preserved'; end if;
end $verification$;
insert into "localHistory"."snapshots"
  ("gameId","capturedAt","activePlayers",visits,favorites,"upVotes","downVotes","likeRatio","collectionId","sourceRow")
select payload->>'gameId',(payload->>'capturedAt')::timestamptz,(payload->>'activePlayers')::bigint,
  (payload->>'visits')::bigint,(payload->>'favorites')::bigint,(payload->>'upVotes')::bigint,
  (payload->>'downVotes')::bigint,(payload->>'likeRatio')::double precision,(payload->>'collectionId')::uuid,payload
from "incomingRows" on conflict ("gameId","capturedAt") do nothing;
do $verification$ begin
  if (select count(*) from "incomingRows" i join "localHistory"."snapshots" s
    on s."gameId"=i.payload->>'gameId' and s."capturedAt"=(i.payload->>'capturedAt')::timestamptz
    and s."sourceRow"=i.payload) <> ${manifest.rowCount} then
    raise exception 'Local rows differ from the verified archive';
  end if;
end $verification$;
insert into "localHistory"."archiveImports" ("archiveDigest","archiveName","archiveDay","rowCount","sourceFingerprint")
values (${sqlValue(manifest.archiveDigest)},${sqlValue(name)},${sqlValue(manifest.archiveDay)},${manifest.rowCount},${sqlValue(manifest.sourceFingerprint)});
commit;
`;
}

export function archiveImportSql(name,rows,manifest){
  return beginImportSql+'copy "incomingRows" (payload) from stdin with (format csv);\n'+rows.map(csvJson).join('\n')+'\n\\.\n'+finishImportSql(name,manifest);
}

export const statusSql=`select json_build_object(
  'rows',count(*),'games',count(distinct "gameId"),'earliest',min("capturedAt"),'latest',max("capturedAt"),
  'archiveImports',(select count(*) from "localHistory"."archiveImports"),
  'archiveDays',(select count(distinct "archiveDay") from "localHistory"."archiveImports"),
  'namedGames',(select count(*) from "localHistory"."gameCatalog"),
  'negativeStatisticRows',count(*) filter (where visits<0 or favorites<0 or "upVotes"<0 or "downVotes"<0),
  'databaseSize',pg_size_pretty(pg_database_size(current_database()))
) from "localHistory"."snapshots";`;
