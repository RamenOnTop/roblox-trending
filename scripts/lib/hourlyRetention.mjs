import {readSnapshotArchive} from './historyArchive.mjs';

export async function verifyHourlyPruneArchives(records,days,download,now=Date.now()){
  const digests=[];
  for(const day of days){
    const candidates=records.filter(record=>record.archiveDay===day&&record.prunedAt);
    if(!candidates.length)throw new Error('Hourly cleanup has no verified source archive for '+day);
    for(const record of candidates){
      const name=`trendSnapshots-${day}-${record.archiveDigest}.jsonl.gz`;
      const manifest=JSON.parse(await download(name+'.manifest.json'));
      if(manifest.archiveDigest!==record.archiveDigest||manifest.sourceFingerprint!==record.sourceFingerprint||manifest.rowCount!==Number(record.rowCount))throw new Error('Hourly cleanup archive differs from the database ledger.');
      readSnapshotArchive(name,await download(name),manifest,now);
      digests.push(record.archiveDigest);
    }
  }
  return [...new Set(digests)];
}
