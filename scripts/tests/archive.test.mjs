import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { makeArchive,verifyArchive,archiveAndVerify } from '../lib/historyArchive.mjs';

const dayAt = days => new Date(Date.now()-days*86400000).toISOString().slice(0,10);
const fixture = day => ({gameId:'1',capturedAt:day+'T12:00:00.000Z',activePlayers:123,visits:123456,favorites:null,upVotes:50,downVotes:1,likeRatio:50/51,collectionId:'00000000-0000-4000-8000-000000000001'});

test('archive preserves the complete ML row and requires a verified download before finalization',async()=>{
  const day=dayAt(10);const row=fixture(day);const saved=new Map();let finalized=0;let downloads=0;
  const store={async upload(name,bytes){saved.set(name,bytes);},async download(name){downloads++;return saved.get(name);},url:name=>'https://example/'+name};
  await archiveAndVerify(day,[row],{rowCount:1,sourceFingerprint:'source'},store,async(manifest)=>{finalized++;assert.equal(manifest.rowCount,1);assert.equal(downloads,2);});
  assert.equal(finalized,1);
  const archive=makeArchive(day,[row],'source');
  assert.equal(verifyArchive(archive.bytes,archive.manifest).rowCount,1);
  const corrupted=Buffer.from(archive.bytes);corrupted[10]^=1;
  assert.throws(()=>verifyArchive(corrupted,archive.manifest),/SHA-256/);
  store.download=async()=>corrupted;
  await assert.rejects(archiveAndVerify(day,[row],{rowCount:1,sourceFingerprint:'source'},store,()=>assert.fail('Must not prune unverified bytes')));
});

test('failed uploads and incomplete source pages never authorize deletion',async()=>{
  const day=dayAt(10);
  await assert.rejects(archiveAndVerify(day,[fixture(day)],{rowCount:2,sourceFingerprint:'source'},{},()=>assert.fail()),/row count changed/);
  await assert.rejects(archiveAndVerify(day,[fixture(day)],{rowCount:1,sourceFingerprint:'source'},{upload:async()=>{throw new Error('Upload unavailable');}},()=>assert.fail()),/Upload unavailable/);
});

test('PostgreSQL retention verifies unchanged source, keeps recent rows, and protects hourly recovery',async t=>{
  const db=new PGlite();
  try {
    await db.exec('create role anon; create role authenticated; create role service_role;');
    await db.exec(await readFile(new URL('../../database/freshDataset.sql',import.meta.url),'utf8'));
    const migration=await readFile(new URL('../../database/optimizeHistory.sql',import.meta.url),'utf8');
    await db.exec(migration);await db.exec(migration);
    await db.exec(`insert into public."collectionRuns" (id,"startedAt",status) values ('00000000-0000-4000-8000-000000000001',now(),'complete'); insert into public."trendGames" (id,name,creator,"lastSeenAt") values ('1','Game','Creator',now());`);
    async function insert(day,hour=12){const row={...fixture(day),capturedAt:day+`T${hour}:00:00.000Z`};await db.query('insert into public."trendSnapshots" ("gameId","capturedAt","activePlayers",visits,favorites,"upVotes","downVotes","likeRatio","collectionId") values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',Object.values(row));return row;}
    const oldDay=dayAt(60);await insert(oldDay);
    const inspect=async day=>(await db.query('select public."inspectHistoryDay"($1) as result',[day])).rows[0].result;
    const finish=async(day,inspection,digest='a'.repeat(64))=>(await db.query('select public."finalizeHistoryArchive"($1,$2,$3,$4,$5,7) as result',[day,inspection.rowCount,inspection.sourceFingerprint,digest,`https://github.com/RamenOnTop/roblox-trending/releases/download/roblox-history/trendSnapshots-${day}-${digest}.jsonl.gz`])).rows[0].result;
    const inspection=await inspect(oldDay);
    await insert(oldDay,13);
    await assert.rejects(finish(oldDay,inspection),/source changed/);
    assert.equal((await inspect(oldDay)).rowCount,2);
    await db.query('insert into public."trendHourlySamples" select "gameId",date_trunc(\'hour\',"capturedAt"),"capturedAt","activePlayers",visits,favorites,"upVotes","downVotes","likeRatio","collectionId" from public."trendSnapshots"');
    const currentDay=dayAt(1);await insert(currentDay);
    const recent=await finish(currentDay,await inspect(currentDay),'b'.repeat(64));
    assert.equal(recent.prunedRows,0);
    assert.equal((await inspect(currentDay)).rowCount,1);
    const freshInspection=await inspect(oldDay);
    // Same number of rows with an edited feature must also stop deletion.
    await db.query('update public."trendSnapshots" set visits=visits+1 where "capturedAt" < $1',[currentDay]);
    await assert.rejects(finish(oldDay,freshInspection),/source changed/);
    const archived=await finish(oldDay,await inspect(oldDay));
    assert.equal(archived.prunedRows,2);
    assert.equal((await inspect(oldDay)).rowCount,0);
    assert.equal((await db.query('select public."pruneArchivedHourlyHistory"(35) as removed')).rows[0].removed,2);
    assert.equal((await inspect(currentDay)).rowCount,1);
    const access=(await db.query(`select has_function_privilege('anon','public."finalizeHistoryArchive"(date,bigint,text,text,text,integer)','EXECUTE') as "anonAccess",has_function_privilege('authenticated','public."inspectHistoryDay"(date)','EXECUTE') as "userAccess",has_function_privilege('service_role','public."finalizeHistoryArchive"(date,bigint,text,text,text,integer)','EXECUTE') as "workerAccess"`)).rows[0];
    assert.deepEqual(access,{anonAccess:false,userAccess:false,workerAccess:true});
    await assert.rejects(db.query('select public."pruneArchivedHourlyHistory"(1)'),/at least 35/);
  } finally {await db.close();}
});
