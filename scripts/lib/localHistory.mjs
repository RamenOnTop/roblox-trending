import {gunzipSync} from 'node:zlib';
import {verifyArchive} from './historyArchive.mjs';

export const archivePattern=/^trendSnapshots-(\d{4}-\d{2}-\d{2})-([a-f0-9]{64})\.jsonl\.gz$/;
export const sqlValue=value=>`'${String(value).replaceAll("'","''")}'`;
export const csvJson=row=>`"${JSON.stringify(row).replaceAll('"','""')}"`;

export function verifyLocalArchive(name,bytes,manifest){
  const match=name.match(archivePattern);
  if(!match||manifest.archiveDay!==match[1]||manifest.archiveDigest!==match[2]||!Number.isSafeInteger(manifest.rowCount)||manifest.rowCount<=0||manifest.compressedBytes!==bytes.length||typeof manifest.sourceFingerprint!=='string')throw new Error('Archive filename, size, and manifest do not agree.');
  const dayStart=Date.parse(manifest.archiveDay+'T00:00:00.000Z');
  if(!Number.isFinite(dayStart)||new Date(dayStart).toISOString().slice(0,10)!==manifest.archiveDay||dayStart>=Date.parse(new Date().toISOString().slice(0,10)))throw new Error('Archive must describe a completed UTC day.');
  verifyArchive(bytes,manifest);
  const lines=gunzipSync(bytes,{maxOutputLength:128*1024*1024}).toString('utf8').trimEnd().split('\n');
  lines.shift();
  const seen=new Set();
  return lines.map(line=>{
    const row=JSON.parse(line);
    const stamp=Date.parse(row.capturedAt);
    if(typeof row.gameId!=='string'||!/^[1-9]\d*$/.test(row.gameId)||!Number.isFinite(stamp)||stamp<dayStart||stamp>=dayStart+86400000||!Number.isSafeInteger(row.activePlayers)||row.activePlayers<0||typeof row.collectionId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(row.collectionId))throw new Error('Invalid archived observation.');
    // Preserve upstream anomalies (for example negative favorites) instead of rewriting history.
    for(const key of ['visits','favorites','upVotes','downVotes'])if(row[key]!=null&&!Number.isSafeInteger(row[key]))throw new Error('Invalid archived count.');
    if(row.likeRatio!=null&&(typeof row.likeRatio!=='number'||!Number.isFinite(row.likeRatio)||row.likeRatio<0||row.likeRatio>1))throw new Error('Invalid archived rating.');
    const normalized={...row,capturedAt:new Date(stamp).toISOString(),collectionId:row.collectionId.toLowerCase()};
    const identity=`${normalized.gameId}:${normalized.capturedAt}`;
    if(seen.has(identity))throw new Error('Duplicate normalized archive observation.');
    seen.add(identity);
    return normalized;
  });
}

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
