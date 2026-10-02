import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildCandles,candleInterval} from '../../src/app/lib/chartCandles.mjs';

test('candles use chronological sampled open, high, low and close',()=>{
  assert.deepEqual(buildCandles([{time:1800,value:15},{time:100,value:10},{time:900,value:25},{time:1200,value:5}],3600),[{time:0,open:10,high:25,low:5,close:15,samples:4}]);
});
test('empty intervals remain absent and single snapshots produce flat candles',()=>{
  assert.deepEqual(buildCandles([{time:100,value:10},{time:10800,value:20}],3600),[{time:0,open:10,high:10,low:10,close:10,samples:1},{time:10800,open:20,high:20,low:20,close:20,samples:1}]);
});
test('invalid observations are excluded and duplicate timestamps do not inflate candles',()=>{
  assert.deepEqual(buildCandles([{time:100,value:10},{time:100,value:12},{time:200,value:null},{time:300,value:-1},{time:NaN,value:30}],3600),[{time:0,open:12,high:12,low:12,close:12,samples:1}]);
  assert.throws(()=>buildCandles([],0));
  assert.equal(candleInterval(24),3600);
  assert.equal(candleInterval(168),14400);
  assert.equal(candleInterval(336),43200);
  assert.equal(candleInterval(720),86400);
});
