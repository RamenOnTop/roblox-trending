import {readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {readSnapshotArchive,snapshotArchivePattern} from './lib/historyArchive.mjs';
import {compactArchiveHours,restoreDashboardArchives} from './lib/dashboardArchives.mjs';
import {mergeHistory} from './lib/collectorState.mjs';
import {buildDashboard,buildGameHistory} from './lib/trends.mjs';

const folder=new URL('../.localHistory/archives/',import.meta.url);
const dataset=JSON.parse(await readFile(new URL('../.localHistory/latestDashboard.json',import.meta.url),'utf8'));
const generatedAt=dataset.meta.generatedAt,ids=dataset.games.map(game=>game.id),records=[],hourly=[],raw=[];
const current=dataset.games.map(game=>({gameId:game.id,capturedAt:generatedAt,activePlayers:game.activePlayers,visits:game.visits,favorites:game.favorites,likeRatio:game.likeRatio,bucketAt:new Date(Math.floor(Date.parse(generatedAt)/3600000)*3600000).toISOString()}));
for(const name of (await readdir(folder)).filter(name=>snapshotArchivePattern.test(name)).sort()){
  const manifest=JSON.parse(await readFile(new URL(name+'.manifest.json',folder),'utf8'));
  const bytes=await readFile(new URL(name,folder));
  const rows=readSnapshotArchive(name,bytes,manifest,Date.parse(generatedAt));
  records.push({...manifest,archiveUrl:`https://github.com/RamenOnTop/roblox-trending/releases/download/roblox-history/${name}`});
  hourly.push(...compactArchiveHours(rows,ids,generatedAt,30));
  raw.push(...rows.filter(row=>Date.parse(row.capturedAt)>=Date.parse(generatedAt)-86400000));
}
const restored=await restoreDashboardArchives({records,ids,state:null,generatedAt,historyDays:30,readArchive:async(record,name)=>({bytes:await readFile(new URL(name,folder)),manifest:JSON.parse(await readFile(new URL(name+'.manifest.json',folder),'utf8'))})});
const hot=hourly.filter(row=>Date.parse(row.capturedAt)>=Date.parse(generatedAt)-14*86400000);
const original=mergeHistory(null,[...raw,...current],[...hourly,...current],ids,generatedAt,30);
const rebuilt=mergeHistory(null,[...raw,...current],[...restored.hourlySamples,...hot,...current],ids,generatedAt,30);
function chartDigest(history){
  const hash=createHash('sha256'),charts=buildGameHistory([...history.rawSamples,...history.hourlySamples]);
  let points=0;
  for(const id of [...charts.keys()].sort()){const values=charts.get(id);points+=values.length;hash.update(id).update(JSON.stringify(values));}
  return {digest:hash.digest('hex'),games:charts.size,points};
}
const before=chartDigest(original),after=chartDigest(rebuilt);
if(before.digest!==after.digest)throw new Error('Cache-free per-game charts differ from the full-history reference.');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const dashboardDigest=hash(buildDashboard(dataset.games,[...original.rawSamples,...original.hourlySamples],{generatedAt}));
if(dashboardDigest!==hash(buildDashboard(dataset.games,[...rebuilt.rawSamples,...rebuilt.hourlySamples],{generatedAt})))throw new Error('Cache-free dashboard metrics differ from the full-history reference.');
const earliest=rebuilt.hourlySamples.reduce((minimum,row)=>Math.min(minimum,Date.parse(row.capturedAt)),Infinity);
const report={checkedAt:new Date().toISOString(),sourceArchives:records.length,archiveDays:restored.archiveDays,simulatedDatabaseDays:14,collectorCheckpointUsed:false,chartsMatch:true,dashboardMetricsMatch:true,...after,dashboardDigest,archivedHourlyRows:restored.hourlySamples.length,simulatedDatabaseHourlyRows:hot.length,earliestObservation:new Date(earliest).toISOString()};
await writeFile(new URL('../.localHistory/archiveRestoreRehearsal.json',import.meta.url),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
