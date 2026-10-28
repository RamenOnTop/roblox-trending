import {readSnapshotArchive,snapshotArchivePattern} from './historyArchive.mjs';

const dayMs=86400000;
const fields=['activePlayers','visits','favorites','likeRatio'];
export function compactArchiveHours(rows,ids,generatedAt,historyDays){
  const until=Date.parse(generatedAt),since=until-(historyDays+1)*dayMs;
  const active=new Set(ids),byHour=new Map();
  for(const row of rows){
    const stamp=Date.parse(row.capturedAt);
    if(!active.has(row.gameId)||stamp<since||stamp>until)continue;
    const bucket=Math.floor(stamp/3600000)*3600000,key=`${row.gameId}:${bucket}`;
    const previous=byHour.get(key),previousTime=Date.parse(previous?.capturedAt);
    if(previousTime===stamp&&fields.some(field=>(previous[field]??null)!==(row[field]??null)))throw new Error('Conflicting archived hourly observations.');
    if(!previous||stamp>previousTime)byHour.set(key,{gameId:row.gameId,capturedAt:new Date(stamp).toISOString(),bucketAt:new Date(bucket).toISOString(),...Object.fromEntries(fields.map(field=>[field,row[field]??null]))});
  }
  return [...byHour.values()];
}

export async function restoreDashboardArchives({records,state,ids,generatedAt,historyDays,readArchive,maxArchiveRows=3000000,maxHourlyRows=1000000}){
  const until=Date.parse(generatedAt),firstDay=new Date(until-(historyDays+1)*dayMs).toISOString().slice(0,10),today=new Date(until).toISOString().slice(0,10);
  if(!Number.isFinite(until)||!Number.isInteger(historyDays)||historyDays<1||historyDays>365)throw new Error('Invalid dashboard archive window.');
  const relevant=records.filter(record=>record.archiveDay>=firstDay&&record.archiveDay<today);
  if(records.length>=1000||relevant.length>366)throw new Error('Dashboard archive ledger budget exceeded.');
  const known=new Set(state?.archiveDigests??[]),previousIds=new Set(state?.gameIds??[]);
  const newGames=ids.some(id=>!previousIds.has(id));
  const hourly=new Map();let archiveRowsRead=0,archivesRead=0;
  for(const record of relevant){
    const name=`trendSnapshots-${record.archiveDay}-${record.archiveDigest}.jsonl.gz`;
    if(!snapshotArchivePattern.test(name)||!Number.isSafeInteger(Number(record.rowCount))||Number(record.rowCount)<=0)throw new Error('Invalid dashboard archive ledger record.');
    if(known.has(record.archiveDigest)&&!newGames)continue;
    const {bytes,manifest}=await readArchive(record,name);
    if(manifest.sourceFingerprint!==record.sourceFingerprint||manifest.rowCount!==Number(record.rowCount)||manifest.archiveDigest!==record.archiveDigest)throw new Error('Dashboard archive differs from the database verification ledger.');
    archiveRowsRead+=manifest.rowCount;
    if(archiveRowsRead>maxArchiveRows)throw new Error('Dashboard archive row budget exceeded; refusing partial history.');
    const rows=readSnapshotArchive(name,bytes,manifest,until);
    for(const row of compactArchiveHours(rows,ids,generatedAt,historyDays)){
      const key=`${row.gameId}:${row.bucketAt}`,previous=hourly.get(key);
      if(previous?.capturedAt===row.capturedAt&&fields.some(field=>(previous[field]??null)!==(row[field]??null)))throw new Error('Conflicting archive versions; refusing to publish altered history.');
      if(!previous||Date.parse(row.capturedAt)>Date.parse(previous.capturedAt))hourly.set(key,row);
    }
    if(hourly.size>maxHourlyRows)throw new Error('Restored dashboard hourly history exceeds its budget.');
    archivesRead++;
  }
  // An updated archive cannot silently contradict an already checkpointed observation.
  for(const row of state?.hourlySamples??[]){
    const restored=hourly.get(`${row.gameId}:${row.bucketAt}`);
    if(restored?.capturedAt===row.capturedAt&&fields.some(field=>(restored[field]??null)!==(row[field]??null)))throw new Error('Archive version conflicts with the collector checkpoint.');
  }
  return {hourlySamples:[...hourly.values()],archiveDigests:[...new Set(relevant.map(record=>record.archiveDigest))],archiveDays:[...new Set(relevant.map(record=>record.archiveDay))].sort(),archiveRowsRead,archivesRead};
}
