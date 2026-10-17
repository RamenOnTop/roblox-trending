import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyLabState,metadataChanges,resolvePending,applyLabBatch,labSummary} from '../lib/mlLab.mjs';
const model={modelVersion:'testModel',trainedThrough:'2026-10-16T00:00:00Z'};
const anchor='2026-10-17T12:00:00.000Z',issuedAt='2026-10-17T12:02:00.000Z',target='2026-10-17T13:00:00.000Z';
const forecast={forecastId:'f1',gameId:'1',modelVersion:'testModel',anchorTime:anchor,issuedAt,targetTime:target,playersNow:100,predictedPlayers:120};
const batch=(overrides={})=>({schemaVersion:1,issuedAt,forecasts:[forecast],outcomes:[],metadataChanges:[],...overrides});

test('forecasts stay pending until a real later outcome in the declared window exists',()=>{
  assert.deepEqual(resolvePending([forecast],[{gameId:'1',capturedAt:anchor,activePlayers:100}],issuedAt),[]);
  const rows=[{gameId:'1',capturedAt:'2026-10-17T13:15:00Z',activePlayers:999},{gameId:'1',capturedAt:'2026-10-17T13:03:00Z',activePlayers:130},{gameId:'1',capturedAt:target,activePlayers:125}];
  assert.equal(resolvePending([forecast],rows,'2026-10-17T13:05:00Z')[0].actualPlayers,125);
  assert.equal(resolvePending([forecast],[], '2026-10-17T13:11:00Z')[0].status,'expired');
});
test('replay is idempotent and metrics pair the model with the same baseline outcome',()=>{
  const state=emptyLabState();applyLabBatch(state,batch(),'first');applyLabBatch(state,batch(),'first');
  assert.equal(state.pending.length,1);assert.equal(state.issued.testModel,1);
  applyLabBatch(state,batch({issuedAt:'2026-10-17T13:05:00Z',forecasts:[],outcomes:[{forecastId:'f1',status:'scored',labelTime:target,actualPlayers:125}]}),'second');
  const summary=labSummary(state,model,'2026-10-17T13:05:00Z').summary;
  assert.equal(summary.pending,0);assert.equal(summary.metrics.count,1);
  assert.equal(summary.metrics.modelMae,5);assert.equal(summary.metrics.baselineMae,25);
  assert.equal(summary.metrics.improvementPct,80);assert.equal(summary.audienceBands[0].count,1);
});
test('backdated issuance, premature expiry, unknown or invalid outcome rows cannot be scored',()=>{
  assert.throws(()=>applyLabBatch(emptyLabState(),batch({forecasts:[{...forecast,issuedAt:'2026-10-17T13:00:00Z'}]}),'bad'),/Invalid/);
  const state=emptyLabState();applyLabBatch(state,batch(),'first');
  for(const outcome of [{forecastId:'missing',status:'expired'},{forecastId:'f1',status:'expired'},{forecastId:'f1',status:'scored',labelTime:anchor,actualPlayers:100},{forecastId:'f1',status:'scored',labelTime:target,actualPlayers:-1}])assert.throws(()=>applyLabBatch(structuredClone(state),batch({forecasts:[],outcomes:[outcome]}),'bad'));
});
test('missing outcomes are excluded from errors and model versions never mix',()=>{
  const state=emptyLabState();applyLabBatch(state,batch(),'first');
  applyLabBatch(state,batch({issuedAt:'2026-10-17T13:11:00Z',forecasts:[],outcomes:[{forecastId:'f1',status:'expired'}]}),'second');
  const summary=labSummary(state,model,'2026-10-17T13:11:00Z').summary;
  assert.equal(summary.metrics.count,0);assert.equal(summary.metrics.modelErrorPct,null);assert.equal(summary.expired,1);
  assert.equal(labSummary(state,{modelVersion:'other'},anchor).summary.expired,0);
});
test('metadata records start now and only append when observed values change',()=>{
  const state=emptyLabState();const game={id:'1',name:'Original',description:'Description',genreL1:'RPG',updatedAt:'2026-10-15T00:00:00Z'};
  const changes=metadataChanges([game],state.metadata,anchor);
  applyLabBatch(state,batch({forecasts:[],metadataChanges:changes}),'first');
  assert.equal(metadataChanges([game],state.metadata,target).length,0);
  const next=metadataChanges([{...game,name:'New title'}],state.metadata,target);
  assert.equal(next[0].observedAt,target);assert.equal(next[0].payload.name,'New title');
  assert.equal(state.metadataStartedAt,anchor);
});
