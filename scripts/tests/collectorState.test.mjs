import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { databaseScope, loadCollectorState, saveCollectorState, historyPlan, mergeHistory, readHistoryPages } from '../lib/collectorState.mjs';
import { buildDashboard } from '../lib/trends.mjs';

const sample = (gameId,capturedAt,activePlayers) => ({gameId,capturedAt,activePlayers,visits:10000,favorites:100,likeRatio:0.9,bucketAt:new Date(Math.floor(Date.parse(capturedAt)/3600000)*3600000).toISOString()});

test('incremental updates match a full rebuild, including new games and replaced hourly rows',()=>{
  const priorAt='2026-10-02T12:00:00.000Z';const now='2026-10-02T12:30:00.000Z';
  const before=[sample('1','2026-09-29T12:00:00.000Z',100),sample('1',priorAt,200),sample('2',priorAt,0)];
  const prior={...mergeHistory(null,before,before,['1','2'],priorAt,30),generatedAt:priorAt,gameIds:['1','2']};
  const incoming=[sample('1',now,300),sample('2',now,0),sample('3','2026-09-30T12:00:00.000Z',50),sample('3',now,150)];
  const plans=historyPlan(prior,['1','2','3'],now,30);
  const deltas=plans.flatMap(plan=>[...before,...incoming].filter(row=>plan.ids.includes(row.gameId)&&Date.parse(row.capturedAt)>=Date.parse(plan.since)));
  const incremental=mergeHistory(prior,deltas,deltas,['1','2','3'],now,30);
  const complete=mergeHistory(null,[...before,...incoming],[...before,...incoming],['1','2','3'],now,30);
  const games=['1','2','3'].map(id=>({id,name:id,creator:'Creator',genreL1:'RPG'}));
  const dashboard=history=>buildDashboard(games,[...history.rawSamples,...history.hourlySamples],{generatedAt:now});
  assert.deepEqual(dashboard(incremental),dashboard(complete));
  assert.equal(incremental.hourlySamples.filter(row=>row.gameId==='1'&&row.bucketAt===priorAt).length,1);
  assert.equal(incremental.rawSamples.filter(row=>row.gameId==='1').length,2);
  assert.ok(plans.find(plan=>plan.ids.includes('3')&&plan.table==='trendHourlySamples').since<'2026-09-30');
});

test('checkpoint survives compression and rejects corrupt or other-project data',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'roblox-checkpoint-'));const path=join(folder,'state.gz');
  try {
    const scope=databaseScope('https://example.supabase.co');
    const state={scope,generatedAt:'2026-10-02T12:00:00.000Z',gameIds:['1'],rawSamples:[sample('1','2026-10-02T12:00:00.000Z',100)],hourlySamples:[],enrichment:[{gameId:'1',payload:{badges:[]}}]};
    await saveCollectorState(path,state);
    const restored=await loadCollectorState(path,scope,Date.parse(state.generatedAt));
    assert.equal(restored.state.rawSamples[0].activePlayers,100);
    assert.deepEqual(restored.state.enrichment,state.enrichment);
    assert.equal((await loadCollectorState(path,'different-project')).state,null);
    await writeFile(path,'corrupt archive');
    assert.equal((await loadCollectorState(path,scope)).state,null);
  } finally {await rm(folder,{recursive:true,force:true});}
});

function fakeDatabase(data){
  const calls=[];
  return {calls,from(){
    const filters={};let cursor=null;let limit=1000;
    const query={select(){return query;},in(field,ids){filters.ids=ids;return query;},gte(field,value){filters.since=Date.parse(value);return query;},lte(field,value){filters.until=Date.parse(value);return query;},order(){return query;},limit(value){limit=value;return query;},or(value){const match=value.match(/^capturedAt.lt.([^,]+),and\(capturedAt.eq.[^,]+,gameId.gt.([^)]+)\)$/);cursor={time:Date.parse(match[1]),id:match[2]};return query;},then(resolve,reject){
      calls.push({...filters,cursor});
      const rows=data.filter(row=>filters.ids.includes(row.gameId)&&Date.parse(row.capturedAt)>=filters.since&&Date.parse(row.capturedAt)<=filters.until&&(!cursor||Date.parse(row.capturedAt)<cursor.time||(Date.parse(row.capturedAt)===cursor.time&&row.gameId>cursor.id)))
        .sort((a,b)=>Date.parse(b.capturedAt)-Date.parse(a.capturedAt)||a.gameId.localeCompare(b.gameId)).slice(0,limit);
      return Promise.resolve({data:rows,error:null}).then(resolve,reject);
    }};return query;
  }};
}

test('pagination preserves all games sharing a timestamp and permits an exact row budget',async()=>{
  const rows=['1','2','3','4'].map(id=>sample(id,'2026-10-02T12:00:00.000Z',100));
  const db=fakeDatabase(rows);
  const plan={table:'trendSnapshots',ids:rows.map(row=>row.gameId),since:'2026-10-02T11:00:00Z',until:'2026-10-02T12:30:00Z'};
  const result=await readHistoryPages(db,plan,{maxRows:4,pageSize:2});
  assert.deepEqual(result.rows.map(row=>row.gameId),['1','2','3','4']);
  assert.equal(db.calls.length,3);
  await assert.rejects(readHistoryPages(fakeDatabase(rows),plan,{maxRows:3,pageSize:2}),/refusing to advance/);
});

test('overlap recovers late observations while old raw rows and inactive games leave the cache',()=>{
  const now='2026-10-02T13:00:00.000Z';
  const state={generatedAt:'2026-10-02T12:30:00Z',gameIds:['1'],rawSamples:[sample('1','2026-09-30T12:00:00Z',100),sample('2','2026-10-02T12:00:00Z',300)],hourlySamples:[]};
  const plan=historyPlan(state,['1'],now,30)[0];
  assert.equal(plan.since,'2026-10-02T11:30:00.000Z');
  const merged=mergeHistory(state,[sample('1','2026-10-02T12:15:00Z',200)],[],['1'],now,30);
  assert.equal(merged.rawSamples.length,1);
  assert.equal(merged.rawSamples[0].activePlayers,200);
});
