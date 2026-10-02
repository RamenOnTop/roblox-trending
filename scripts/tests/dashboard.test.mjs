import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDashboard,buildGameHistory} from '../lib/trends.mjs';
const game={id:'1',name:'Game',genreL1:'RPG'};
const sample=(capturedAt,activePlayers)=>({gameId:'1',capturedAt,activePlayers,likeRatio:.9,visits:1000,favorites:50});
test('display growth reflects actual counts and labels the partial measurement window',()=>{
  const dataset=buildDashboard([game],[sample('2026-10-02T12:00:00Z',20),sample('2026-10-02T10:00:00Z',10)],{generatedAt:'2026-10-02T12:00:00Z'});
  assert.equal(dataset.games[0].metrics[168].growthPct,100);
  assert.equal(dataset.games[0].metrics[168].hoursUsed,2);
  assert.equal(dataset.games[0].likeRatio,.9);
});
test('growth from a zero baseline stays unavailable instead of implying a finite percentage',()=>{
  const dataset=buildDashboard([game],[sample('2026-10-02T12:00:00Z',20),sample('2026-10-02T10:00:00Z',0)],{generatedAt:'2026-10-02T12:00:00Z'});
  assert.equal(dataset.games[0].metrics[24].growthPct,null);
});
test('history exports sorted actual observations without filling collection gaps',()=>{
  const result=buildGameHistory([sample('2026-10-02T12:00:00Z',20),sample('2026-10-02T10:00:00Z',10),sample('invalid',10),sample('2026-10-02T11:00:00Z',null),sample('2026-10-02T12:00:00.000Z',20)]).get('1');
  assert.equal(result.length,2);
  assert.equal(result[1].time-result[0].time,7200);
  assert.deepEqual(result.map(point=>point.value),[10,20]);
});
