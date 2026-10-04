import test from 'node:test';
import assert from 'node:assert/strict';
import {detectBreakout,rankBreakouts} from '../lib/breakouts.mjs';
import {buildDashboard} from '../lib/trends.mjs';
const nowMs=Date.parse('2026-10-04T12:00:00Z');
function observations(counts,stepMinutes=30){return counts.map((activePlayers,index)=>({gameId:'1',capturedAt:new Date(nowMs-(counts.length-1-index)*stepMinutes*60000).toISOString(),activePlayers}));}
const gradual=[100,120,150,180,220,280,350,420,490,560,630,700,770];

test('small games qualify without needing a two thousand player gain',()=>{
  const signal=detectBreakout(observations(gradual),6,nowMs);
  assert.equal(signal.status,'sustained');
  assert.equal(signal.tier,'Emerging');
  assert.equal(signal.gain,670);
  assert.equal(signal.growthPct,670);
  assert.equal(signal.hoursUsed,6);
});
test('audience tier uses starting size and established games have their own threshold',()=>{
  const signal=detectBreakout(observations(gradual.map(value=>100000+value*30)),6,nowMs);
  assert.equal(signal.tier,'Established');
  assert.equal(signal.status,'sustained');
  assert.equal(detectBreakout(observations(gradual.map(value=>100000+value)),6,nowMs).status,'belowThreshold');
});
test('missing, stale and patchy history cannot become steady-growth picks',()=>{
  assert.equal(detectBreakout(observations(gradual.slice(-4)),6,nowMs).status,'insufficientHistory');
  const patchy=observations(gradual).filter((point,index)=>index!==4&&index!==5);
  assert.equal(detectBreakout(patchy,6,nowMs).status,'patchyHistory');
  assert.equal(detectBreakout(observations(Array.from({length:49},(_,i)=>100+i*20)).slice(0,-2),24,nowMs).status,'stale');
});
test('a dominant single jump and newly reached threshold stay outside sustained picks',()=>{
  assert.equal(detectBreakout(observations([100,100,100,100,100,100,100,700,700,700,700,700,700]),6,nowMs).status,'spike');
  assert.equal(detectBreakout(observations([100,105,110,115,120,125,130,135,140,145,150,175,210]),6,nowMs).status,'early');
});
test('a decline from the recent peak is labelled cooling even with positive net growth',()=>{
  assert.equal(detectBreakout(observations([100,150,200,300,400,500,600,700,800,900,1000,800,700]),6,nowMs).status,'cooling');
});
test('zero baselines, invalid observations, duplicates and future counts never imply breakout growth',()=>{
  assert.equal(detectBreakout(observations([0,...gradual.slice(1)]),6,nowMs).status,'zeroBaseline');
  const samples=observations(gradual);
  const extra=[...samples,samples[0],{capturedAt:'bad',activePlayers:9999},{capturedAt:new Date(nowMs+1000).toISOString(),activePlayers:99999},{capturedAt:new Date(nowMs-1000).toISOString(),activePlayers:-20}];
  assert.deepEqual(detectBreakout(extra,6,nowMs),detectBreakout(samples,6,nowMs));
});
test('ranking is deterministic, includes only qualifying games, and never pads the top five',()=>{
  const sustained=detectBreakout(observations(gradual),6,nowMs);
  const games=[{id:'2',breakouts:{6:sustained}},{id:'1',breakouts:{6:sustained}},{id:'3',breakouts:{6:{...sustained,status:'spike',score:100}}}];
  assert.deepEqual(rankBreakouts(games,6).slice(0,5).map(game=>game.id),['1','2']);
});
test('published dashboard includes signal windows and genre counts use validated 24 hour growth',()=>{
  const samples=observations(Array.from({length:49},(_,i)=>100+i*20));
  const dashboard=buildDashboard([{id:'1',name:'Growing game',genreL1:'RPG'}],samples,{generatedAt:new Date(nowMs).toISOString()});
  assert.equal(dashboard.schemaVersion,4);
  assert.equal(dashboard.games[0].breakouts[24].status,'sustained');
  assert.deepEqual(Object.keys(dashboard.games[0].breakouts),['3','6','24']);
  assert.equal(dashboard.ranges[24].genres[0].breakoutsCount,1);
  assert.equal(dashboard.ranges[168].genres[0].breakoutsWindowHours,24);
});
