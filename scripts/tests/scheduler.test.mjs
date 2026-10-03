import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('external timer fixes the repository target, protects its token, and skips active collections', async () => {
  const database = new PGlite();
  try {
    await database.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema vault; create schema net; create schema cron;
      create table vault.decrypted_secrets(name text, decrypted_secret text);
      insert into vault.decrypted_secrets values ('robloxWorkflowToken','testTokenNotARealCredential');
      create table public."collectionRuns" (status text,"startedAt" timestamptz);
      create table net."requests" (id bigserial primary key,url text,headers jsonb,body jsonb,"timeoutMs" integer);
      create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql as $$
        insert into net."requests"(url,headers,body,"timeoutMs") values ($1,$2,$3,$4) returning id;
      $$;
      create table cron.job(jobid bigserial primary key,jobname text unique,schedule text,command text);
      create function cron.schedule(text,text,text) returns bigint language sql as $$
        insert into cron.job(jobname,schedule,command) values ($1,$2,$3)
        on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command returning jobid;
      $$;
    `);
    const source = await readFile(new URL('../../database/scheduleCollection.sql',import.meta.url),'utf8');
    // pg_cron, pg_net and Vault are vendor extensions; test their boundaries with SQL stubs.
    const setup = source.replace(/^create extension[^\n]+\n/gm,'');
    await database.exec(setup);
    await database.exec(setup);
    const jobs = (await database.query('select * from cron.job')).rows;
    assert.equal(jobs.length,1);
    assert.equal(jobs[0].schedule,'13,43 * * * *');
    const dispatch = async (force=false) => (await database.query('select "collectorPrivate"."dispatchRobloxCollection"($1) as id',[force])).rows[0].id;
    assert.equal(await dispatch(),1);
    const request = (await database.query('select * from net."requests"')).rows[0];
    assert.equal(request.url,'https://api.github.com/repos/RamenOnTop/roblox-trending/actions/workflows/pages.yml/dispatches');
    assert.deepEqual(request.body,{ref:'main'});
    assert.equal(request.headers.Authorization,'Bearer testTokenNotARealCredential');
    assert.equal(request.timeoutMs,10000);
    await database.exec(`insert into public."collectionRuns" values ('running',now());`);
    assert.equal(await dispatch(),null);
    assert.equal(await dispatch(true),2);
    await database.exec(`update public."collectionRuns" set "startedAt"=now()-interval '26 minutes';`);
    assert.equal(await dispatch(),3);
    const access = (await database.query(`select
      has_function_privilege('anon','"collectorPrivate"."dispatchRobloxCollection"(boolean)','EXECUTE') as "publicAccess",
      has_function_privilege('service_role','"collectorPrivate"."dispatchRobloxCollection"(boolean)','EXECUTE') as "workerAccess"
    `)).rows[0];
    assert.deepEqual(access,{publicAccess:false,workerAccess:false});
    await database.exec(`delete from vault.decrypted_secrets;`);
    await assert.rejects(dispatch(),/missing from Vault/);
    await assert.rejects(database.exec(setup),/before enabling collection/);
    await database.exec('rollback;');
  } finally {await database.close();}
});
