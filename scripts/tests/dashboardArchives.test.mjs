import test from 'node:test';
import assert from 'node:assert/strict';
import {makeArchive} from '../lib/historyArchive.mjs';
import {restoreDashboardArchives,compactArchiveHours} from '../lib/dashboardArchives.mjs';
import {mergeHistory,historyPlan} from '../lib/collectorState.mjs';
import {buildDashboard,buildGameHistory} from '../lib/trends.mjs';

const generatedAt='2026-10-28T12:30:00.000Z';
const sample=(gameId,capturedAt,activePlayers)=>({gameId,capturedAt,activePlayers,visits:10000,favorites:100,upVotes:90,downVotes:10,likeRatio:.9,collectionId:'00000000-0000-4000-8000-000000000001'});
function source(rows){
  const asset=makeArchive(rows[0].capturedAt.slice(0,10),rows,'source');
  return {asset,record:{...asset.manifest,archiveUrl:`https://github.com/RamenOnTop/roblox-trending/releases/download/roblox-history/${asset.name}`}};
}
function options(sources,extra={}){return {records:sources.map(item=>item.record),state:null,ids:['1'],generatedAt,historyDays:30,readArchive:async record=>{const asset=sources.find(item=>item.record.archiveDigest===record.archiveDigest).asset;return {bytes:asset.bytes,manifest:asset.manifest};},...extra};}

test('cache-free rebuild with only fourteen database days preserves monthly game charts and genre metrics',async()=>{
  const older=[sample('1','2026-09-30T12:05:00.000Z',100),sample('1','2026-09-30T12:55:00.000Z',120)];
  const middle=[sample('1','2026-10-10T12:00:00.000Z',160)];
  const recent=[sample('1','2026-10-27T12:40:00.000Z',200)];
  const sources=[source(older),source(middle),source(recent)];
  const current=sample('1',generatedAt,300),ids=['1'];
  const hourly=compactArchiveHours([...older,...middle,...recent,current],ids,generatedAt,30);
  const hot=hourly.filter(row=>Date.parse(row.capturedAt)>=Date.parse(generatedAt)-14*86400000);
  const restored=await restoreDashboardArchives(options(sources));
  const complete=mergeHistory(null,[...recent,current],hourly,ids,generatedAt,30);
  const cold=mergeHistory(null,[...recent,current],[...restored.hourlySamples,...hot],ids,generatedAt,30);
  const points=history=>buildGameHistory([...history.rawSamples,...history.hourlySamples]);
  assert.deepEqual(points(cold),points(complete));
  const games=[{id:'1',name:'Game',genreL1:'RPG'}];
  const dashboard=history=>buildDashboard(games,[...history.rawSamples,...history.hourlySamples],{generatedAt});
  assert.deepEqual(dashboard(cold),dashboard(complete));
  assert.ok(dashboard(cold).games[0].metrics[720].hoursUsed>27*24);
  assert.equal(points(cold).get('1')[0].value,120);
  assert.equal(restored.hourlySamples.length,3);
  assert.equal(historyPlan(null,ids,generatedAt,30,15).find(plan=>plan.table==='trendHourlySamples').since,'2026-10-13T12:30:00.000Z');
});

test('warm checkpoints skip verified digests but new games recover their older observations',async()=>{
  const sources=[source([sample('1','2026-10-02T12:00:00.000Z',100),sample('2','2026-10-02T12:00:00.000Z',200)])];
  const state={gameIds:['1'],archiveDigests:[sources[0].record.archiveDigest],hourlySamples:[]};
  const warm=await restoreDashboardArchives(options(sources,{state,readArchive:()=>assert.fail('Warm history must not redownload archives')}));
  assert.equal(warm.archivesRead,0);
  const newGame=await restoreDashboardArchives(options(sources,{state,ids:['1','2']}));
  assert.equal(newGame.hourlySamples.find(row=>row.gameId==='2').activePlayers,200);
});

test('corruption, missing assets, ledger mismatches and archive budgets cannot publish partial history',async()=>{
  const sources=[source([sample('1','2026-10-02T12:00:00.000Z',100)])];
  await assert.rejects(restoreDashboardArchives(options(sources,{readArchive:async()=>{throw new Error('Archive missing');}})),/Archive missing/);
  const corrupt=Buffer.from(sources[0].asset.bytes);corrupt[10]^=1;
  await assert.rejects(restoreDashboardArchives(options(sources,{readArchive:async()=>({bytes:corrupt,manifest:sources[0].asset.manifest})})),/SHA-256/);
  await assert.rejects(restoreDashboardArchives(options(sources,{records:[{...sources[0].record,rowCount:2}]})),/verification ledger/);
  await assert.rejects(restoreDashboardArchives(options(sources,{maxArchiveRows:0})),/row budget/);
  await assert.rejects(restoreDashboardArchives(options(sources,{maxHourlyRows:0})),/exceeds its budget/);
});

test('conflicting versions stop restoration and future or out-of-window days stay absent',async()=>{
  const first=source([sample('1','2026-10-02T12:00:00.000Z',100)]);
  const changed=source([sample('1','2026-10-02T12:00:00.000Z',999)]);
  await assert.rejects(restoreDashboardArchives(options([first,changed])),/Conflicting archive versions/);
  const records=[{...first.record,archiveDay:'2026-09-01'},{...first.record,archiveDay:'2026-10-28'}];
  const result=await restoreDashboardArchives(options([],{records,readArchive:()=>assert.fail('Outside the archive window')}));
  assert.equal(result.hourlySamples.length,0);
  assert.deepEqual(result.archiveDigests,[]);
});
