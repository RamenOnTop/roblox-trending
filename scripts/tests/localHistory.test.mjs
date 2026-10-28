import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {makeArchive} from '../lib/historyArchive.mjs';
import {verifyLocalArchive,beginImportSql,finishImportSql,csvJson} from '../lib/localHistory.mjs';

const day='2026-01-01';
const fixture=(gameId='1',activePlayers=100)=>({gameId,capturedAt:day+'T12:00:00+00:00',activePlayers,visits:123456,favorites:null,upVotes:80,downVotes:2,likeRatio:.975609756097561,collectionId:'00000000-0000-4000-8000-000000000001'});
const archive=rows=>makeArchive(day,rows,'source');
const verified=asset=>verifyLocalArchive(asset.name,asset.bytes,asset.manifest);

test('local import verifies full archive contents, digest, size, and normalized timestamps',()=>{
  const asset=archive([fixture()]);
  const rows=verified(asset);
  assert.deepEqual(rows,[{...fixture(),capturedAt:day+'T12:00:00.000Z'}]);
  assert.throws(()=>verifyLocalArchive(asset.name,asset.bytes,{...asset.manifest,compressedBytes:1}),/do not agree/);
  const corrupt=Buffer.from(asset.bytes);corrupt[20]^=1;
  assert.throws(()=>verifyLocalArchive(asset.name,corrupt,asset.manifest),/SHA-256/);
  assert.throws(()=>verifyLocalArchive(asset.name.replace(day,'2026-01-02'),asset.bytes,asset.manifest),/do not agree/);
});

test('local import rejects invalid counts, identity aliases and CSV control characters remain quoted',()=>{
  assert.throws(()=>verified(archive([{...fixture(),visits:Number.MAX_SAFE_INTEGER+1}])),/Invalid archived count/);
  assert.equal(verified(archive([{...fixture(),favorites:-1486}]))[0].favorites,-1486);
  assert.throws(()=>verified(archive([fixture(),{...fixture(),capturedAt:day+'T12:00:00.000Z'}])),/Duplicate normalized/);
  const value={note:'a,"b"\n\\.\nend'};
  assert.equal(csvJson(value),'"'+JSON.stringify(value).replaceAll('"','""')+'"');
});

async function importInto(db,asset){
  await db.exec(beginImportSql);
  for(const row of verified(asset))await db.query('insert into "incomingRows" (payload) values ($1)',[row]);
  try{await db.exec(finishImportSql(asset.name,asset.manifest));}
  catch(error){await db.exec('rollback;');throw error;}
}

test('PostgreSQL imports preserve all fields, deduplicate overlapping versions and roll back conflicting batches',async()=>{
  const db=new PGlite();
  try{
    await db.exec(await readFile(new URL('../../database/localHistory.sql',import.meta.url),'utf8'));
    const first=archive([fixture()]);
    await importInto(db,first);
    const stored=(await db.query('select "sourceRow" from "localHistory"."snapshots"')).rows[0].sourceRow;
    assert.deepEqual(stored,verified(first)[0]);
    const overlap=archive([fixture(),fixture('2',200)]);
    await importInto(db,overlap);
    assert.equal((await db.query('select count(*)::int as count from "localHistory"."snapshots"')).rows[0].count,2);
    assert.equal((await db.query('select count(*)::int as count from "localHistory"."archiveImports"')).rows[0].count,2);
    await assert.rejects(importInto(db,archive([fixture('1',999),fixture('3',300)])),/Conflicting archive version/);
    assert.equal((await db.query('select count(*)::int as count from "localHistory"."snapshots"')).rows[0].count,2);
    assert.equal((await db.query('select "activePlayers"::int as players from "localHistory"."snapshots" where "gameId"=\'1\'')).rows[0].players,100);
    assert.equal((await db.query('select count(*)::int as count from "localHistory"."archiveImports"')).rows[0].count,2);
    // An accidental replay of the same ledger entry rolls back without duplicating data.
    await assert.rejects(importInto(db,overlap),/duplicate key/);
    assert.equal((await db.query('select count(*)::int as count from "localHistory"."snapshots"')).rows[0].count,2);
  }finally{await db.close();}
});
