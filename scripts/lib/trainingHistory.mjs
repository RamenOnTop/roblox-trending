import {gunzipSync} from 'node:zlib';
import {verifyArchive} from './historyArchive.mjs';

const archivePattern=/^trendSnapshots-(\d{4}-\d{2}-\d{2})-([a-f0-9]{64})\.jsonl\.gz$/;

export function mergeTrainingRows(sources,{maxRows=2000000,until}={}) {
  const cutoff=Date.parse(until);
  if(!Number.isFinite(cutoff))throw new Error('Invalid training history cutoff.');
  const merged=new Map();let duplicateRows=0;
  for(const rows of sources)for(const row of rows){
    const stamp=Date.parse(row.capturedAt);
    if(typeof row.gameId!=='string'||!/^[1-9]\d*$/.test(row.gameId)||!Number.isFinite(stamp)||stamp>cutoff||typeof row.activePlayers!=='number'||!Number.isFinite(row.activePlayers)||row.activePlayers<0)throw new Error('Invalid training observation in combined history.');
    const key=`${row.gameId}:${stamp}`;
    const previous=merged.get(key);
    if(previous){
      if(previous.activePlayers!==row.activePlayers)throw new Error('Conflicting player counts across history sources.');
      duplicateRows++;continue;
    }
    merged.set(key,{gameId:row.gameId,capturedAt:new Date(stamp).toISOString(),activePlayers:row.activePlayers});
    if(merged.size>maxRows)throw new Error('Combined training row budget exceeded; refusing partial history.');
  }
  return {rows:[...merged.values()].sort((a,b)=>Date.parse(a.capturedAt)-Date.parse(b.capturedAt)||a.gameId.localeCompare(b.gameId)),duplicateRows};
}

export async function readVerifiedTrainingArchives(assets,download,until) {
  const untilMs=Date.parse(until);
  if(!Number.isFinite(untilMs))throw new Error('Invalid archive cutoff.');
  const today=new Date(untilMs).toISOString().slice(0,10);
  const names=new Set(assets.map(asset=>asset.name));
  const archives=assets.filter(asset=>archivePattern.test(asset.name)).sort((a,b)=>a.name.localeCompare(b.name));
  if(!archives.length)throw new Error('No verified history archive assets are available.');
  if(archives.length>366)throw new Error('Archive asset budget exceeded.');
  const days=new Set();const manifests=[];const rows=[];
  for(const asset of archives){
    const [,day,digest]=asset.name.match(archivePattern);
    if(new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day||day>=today)throw new Error('Archive date is invalid or not a completed UTC day.');
    if(!names.has(asset.name+'.manifest.json'))throw new Error('Archive manifest is missing.');
    const manifest=JSON.parse(await download(asset.name+'.manifest.json'));
    if(manifest.archiveDay!==day||manifest.archiveDigest!==digest||!Number.isSafeInteger(manifest.rowCount)||manifest.rowCount<=0)throw new Error('Archive filename and manifest disagree.');
    const bytes=await download(asset.name);
    if(bytes.length!==manifest.compressedBytes)throw new Error('Archive compressed size differs from manifest.');
    verifyArchive(bytes,manifest);
    const lines=gunzipSync(bytes,{maxOutputLength:128*1024*1024}).toString('utf8').trimEnd().split('\n');
    lines.shift();
    for(const line of lines){const row=JSON.parse(line);rows.push({gameId:row.gameId,capturedAt:row.capturedAt,activePlayers:row.activePlayers});}
    if(rows.length>3000000)throw new Error('Archive row budget exceeded; refusing partial history.');
    days.add(day);manifests.push({name:asset.name,archiveDay:day,archiveDigest:digest,rowCount:manifest.rowCount});
  }
  // Keep multiple immutable versions; merge later and fail if their player counts conflict.
  return {rows,manifests,days:[...days].sort()};
}

export function assertDailyCoverage(archiveDays,recentRows,until) {
  const observedDays=new Set([...archiveDays,...recentRows.map(row=>new Date(row.capturedAt).toISOString().slice(0,10))]);
  const first=[...observedDays].sort()[0];
  if(!first)throw new Error('Combined history is empty.');
  const today=new Date(until).toISOString().slice(0,10);
  for(let day=first;day<today;day=new Date(Date.parse(day+'T00:00:00Z')+86400000).toISOString().slice(0,10)){
    if(!observedDays.has(day))throw new Error(`Combined history is missing UTC day ${day}.`);
  }
}
