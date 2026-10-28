import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {makeArchive} from '../lib/historyArchive.mjs';
import {verifyHourlyPruneArchives} from '../lib/hourlyRetention.mjs';

test('hourly maintenance requires a fresh manifest and byte verification for every candidate day',async()=>{
  const day='2026-01-01',row={gameId:'1',capturedAt:day+'T12:00:00Z',activePlayers:10,collectionId:'00000000-0000-4000-8000-000000000001'};
  const asset=makeArchive(day,[row],'source'),record={...asset.manifest,prunedAt:'2026-01-20'};
  let downloads=0;
  const download=async name=>{downloads++;return name.endsWith('.json')?Buffer.from(JSON.stringify(asset.manifest)):asset.bytes;};
  assert.deepEqual(await verifyHourlyPruneArchives([record],[day],download),[asset.manifest.archiveDigest]);
  assert.equal(downloads,2);
  await assert.rejects(verifyHourlyPruneArchives([],[day],download),/no verified source/);
  await assert.rejects(verifyHourlyPruneArchives([record],[day],async()=>Buffer.from('{}')),/differs from the database ledger/);
  await assert.rejects(verifyHourlyPruneArchives([record],[day],async name=>name.endsWith('.json')?Buffer.from(JSON.stringify(asset.manifest)):Buffer.from('corrupt')),/do not agree/);
});

test('fourteen-day pruning retains recent, unarchived, unverified and raw-backed hourly observations',async()=>{
  const db=new PGlite();
  try{
    await db.exec('create role anon; create role authenticated; create role service_role;');
    await db.exec(await readFile(new URL('../../database/freshDataset.sql',import.meta.url),'utf8'));
    await db.exec(await readFile(new URL('../../database/optimizeHistory.sql',import.meta.url),'utf8'));
    const migration=await readFile(new URL('../../database/retainRecentHistory.sql',import.meta.url),'utf8');
    await db.exec(migration);await db.exec(migration);
    await db.exec(`insert into public."collectionRuns" (id,"startedAt",status) values ('00000000-0000-4000-8000-000000000001',now(),'complete'); insert into public."trendGames" (id,name,creator,"lastSeenAt") values ('1','Game','Creator',now());`);
    const day=offset=>new Date(Date.now()-offset*86400000).toISOString().slice(0,10);
    async function add(offset,archived,raw=false){
      const date=day(offset),stamp=date+'T12:00:00Z',digest=String(offset).padStart(64,'a');
      await db.query('insert into public."trendHourlySamples" ("gameId","bucketAt","capturedAt","activePlayers","collectionId") values ($1,$2,$2,10,$3)',['1',stamp,'00000000-0000-4000-8000-000000000001']);
      if(archived)await db.query('insert into public."historyArchives" ("archiveDigest","archiveDay","rowCount","sourceFingerprint","archiveUrl","prunedAt") values ($1,$2,1,\'source\',\'url\',now())',[digest,date]);
      if(raw)await db.query('insert into public."trendSnapshots" ("gameId","capturedAt","activePlayers","collectionId") values ($1,$2,10,$3)',['1',stamp,'00000000-0000-4000-8000-000000000001']);
      return digest;
    }
    const verified=await add(20,true);await add(19,true);await add(18,false);await add(17,true,true);await add(2,true);
    const preview=(await db.query('select public."inspectHourlyRetention"(14) as result')).rows[0].result;
    assert.equal(preview.candidateRows,2);assert.equal(preview.unverifiedRows,2);
    await assert.rejects(db.query('select public."pruneVerifiedHourlyHistory"(14,null)'),/verified archive digests/);
    await assert.rejects(db.query('select public."pruneVerifiedHourlyHistory"(1,$1)',[[verified]]),/at least 14/);
    assert.equal((await db.query('select public."pruneVerifiedHourlyHistory"(14,$1) as removed',[[verified]])).rows[0].removed,1);
    assert.equal((await db.query('select count(*)::int as count from public."trendHourlySamples"')).rows[0].count,4);
    assert.equal((await db.query(`select has_function_privilege('anon','public."pruneVerifiedHourlyHistory"(integer,text[])','EXECUTE') as allowed`)).rows[0].allowed,false);
  }finally{await db.close();}
});
