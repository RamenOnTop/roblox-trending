import test from 'node:test';
import assert from 'node:assert/strict';
import {makeArchive} from '../lib/historyArchive.mjs';
import {mergeTrainingRows,readVerifiedTrainingArchives,assertDailyCoverage} from '../lib/trainingHistory.mjs';

const until='2026-10-17T12:00:00Z';
const row={gameId:'1',capturedAt:'2026-10-02T12:00:00Z',activePlayers:100,visits:555};
function archiveStore(rows=[row]){
  const archive=makeArchive('2026-10-02',rows,'fingerprint');
  const store=new Map([[archive.name,archive.bytes],[archive.name+'.manifest.json',Buffer.from(JSON.stringify(archive.manifest))]]);
  return {archive,store,assets:[...store.keys()].map(name=>({name})),download:async name=>store.get(name)};
}

test('archive assembly verifies manifests, strips unrelated columns and preserves provenance',async()=>{
  const fixture=archiveStore();
  const result=await readVerifiedTrainingArchives(fixture.assets,fixture.download,until);
  assert.deepEqual(result.rows,[{gameId:'1',capturedAt:row.capturedAt,activePlayers:100}]);
  assert.equal(result.manifests[0].archiveDigest,fixture.archive.manifest.archiveDigest);
  assert.deepEqual(result.days,['2026-10-02']);
});
test('corrupt bytes, missing manifests and filename mismatches stop archive assembly',async()=>{
  const fixture=archiveStore();
  await assert.rejects(readVerifiedTrainingArchives([{name:fixture.archive.name}],fixture.download,until),/manifest is missing/);
  const corrupted=Buffer.from(fixture.archive.bytes);corrupted[12]^=1;
  fixture.store.set(fixture.archive.name,corrupted);
  await assert.rejects(readVerifiedTrainingArchives(fixture.assets,fixture.download,until),/SHA-256/);
  fixture.store.set(fixture.archive.name,fixture.archive.bytes);
  fixture.store.set(fixture.archive.name+'.manifest.json',Buffer.from(JSON.stringify({...fixture.archive.manifest,archiveDay:'2026-10-03'})));
  await assert.rejects(readVerifiedTrainingArchives(fixture.assets,fixture.download,until),/disagree/);
});
test('overlapping archive versions and live rows are deduplicated by normalized timestamp',()=>{
  const result=mergeTrainingRows([[row],[{...row,capturedAt:'2026-10-02T12:00:00.000+00:00'}]],{until});
  assert.equal(result.rows.length,1);assert.equal(result.duplicateRows,1);
  assert.deepEqual(Object.keys(result.rows[0]),['gameId','capturedAt','activePlayers']);
  assert.throws(()=>mergeTrainingRows([[row],[{...row,activePlayers:200}]],{until}),/Conflicting/);
});
test('partial combined exports, invalid counts and future observations fail rather than train',()=>{
  assert.throws(()=>mergeTrainingRows([[row,{...row,gameId:'2'}]],{until,maxRows:1}),/budget/);
  for(const activePlayers of [-1,null,'10',Infinity])assert.throws(()=>mergeTrainingRows([[{...row,activePlayers}]],{until}),/Invalid/);
  assert.throws(()=>mergeTrainingRows([[{...row,capturedAt:'2026-10-18T00:00:00Z'}]],{until}),/Invalid/);
  assert.throws(()=>assertDailyCoverage(['2026-10-14'],[{...row,capturedAt:'2026-10-16T12:00:00Z'}],until),/missing UTC day 2026-10-15/);
  assert.doesNotThrow(()=>assertDailyCoverage(['2026-10-14','2026-10-15'],[{...row,capturedAt:'2026-10-16T12:00:00Z'}],until));
});
