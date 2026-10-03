import test from 'node:test';
import assert from 'node:assert/strict';
import {readTrainingSnapshots} from '../lib/trainingExport.mjs';

function fakeDatabase(data, failure=null) {
  let cursor = null; let limit; const filters = {};
  const query = {select(){return query;},gte(field,value){filters.since=value;return query;},
    lte(field,value){filters.until=value;return query;},order(){return query;},limit(value){limit=value;return query;},
    or(value){const match=value.match(/^capturedAt.gt.([^,]+),and\(capturedAt.eq.[^,]+,gameId.gt.([^)]+)\)$/);cursor={stamp:match[1],id:match[2]};return query;},
    then(resolve){
      const rows=data.filter(row=>row.capturedAt>=filters.since&&row.capturedAt<=filters.until&&(!cursor||row.capturedAt>cursor.stamp||(row.capturedAt===cursor.stamp&&row.gameId>cursor.id)))
        .sort((left,right)=>left.capturedAt.localeCompare(right.capturedAt)||left.gameId.localeCompare(right.gameId)).slice(0,limit);
      resolve({data:rows,error:failure});
    }};
  return {from(table){assert.equal(table,'trendSnapshots');return query;}};
}
const options={since:'2026-10-02T00:00:00Z',until:'2026-10-03T00:00:00Z',maxRows:10,pageSize:2};
test('training export pages through timestamp ties without duplicates or missed games',async()=>{
  const data=['1','2','3','4','5'].map(gameId=>({gameId,capturedAt:'2026-10-02T12:00:00Z',activePlayers:100}));
  data.push({gameId:'1',capturedAt:'2026-10-02T12:30:00Z',activePlayers:120});
  const rows=await readTrainingSnapshots(fakeDatabase(data),options);
  assert.deepEqual(rows,data);
});
test('training export refuses a partial dataset when the row budget is exceeded',async()=>{
  const data=['1','2','3'].map(gameId=>({gameId,capturedAt:'2026-10-02T12:00:00Z',activePlayers:100}));
  await assert.rejects(readTrainingSnapshots(fakeDatabase(data),{...options,maxRows:2}),/row budget/);
});
test('database failures stop export without printing server credentials or error payloads',async()=>{
  await assert.rejects(readTrainingSnapshots(fakeDatabase([],{code:'failed',message:'private error body'}),options),/Read training history failed \(failed\)/);
});
