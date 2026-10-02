import { createClient } from '@supabase/supabase-js';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { archiveAndVerify, verifyArchive } from './lib/historyArchive.mjs';

const config = JSON.parse(await readFile(new URL('../config/collection.json',import.meta.url),'utf8'));
if (!process.env.supabaseUrl || !process.env.supabaseServiceKey) {console.log('Archive skipped: no Supabase database configured.');process.exit(0);}
const database = createClient(process.env.supabaseUrl,process.env.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
const repository = process.env.githubRepository;
const directory = fileURLToPath(new URL('../.historyArchives/',import.meta.url));
const tag = 'roblox-history';
function checked(result) {if(result.error)throw new Error(result.error.message);return result.data;}
function gh(args) {return execFileSync('gh',[...args,'--repo',repository],{env:{...process.env,GH_TOKEN:process.env.githubToken},maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']});}

async function releaseStore() {
  if (!/^[A-Za-z0-9.-]+\/[A-Za-z0-9.-]+$/.test(repository ?? '') || !process.env.githubToken) throw new Error('GitHub archive credentials are missing.');
  try {gh(['release','view',tag]);}
  catch {gh(['release','create',tag,'--title','Roblox history archives','--notes','Compressed public Roblox observations for ML. Each archive has a SHA-256 manifest. Keep these assets: older Supabase rows may be pruned after verification.','--latest=false']);}
  await mkdir(directory,{recursive:true});
  return {
    async upload(name,bytes) {
      const path = directory+name;
      await writeFile(path,bytes);
      const release = JSON.parse(gh(['release','view',tag,'--json','assets']));
      if (!release.assets.some(asset=>asset.name === name)) gh(['release','upload',tag,path]);
    },
    async download(name) {
      // The original upload is never used as verification evidence.
      const folder = directory+'verification/';await mkdir(folder,{recursive:true});
      gh(['release','download',tag,'--pattern',name,'--dir',folder,'--clobber']);
      return readFile(folder+name);
    },
    url(name) {return `https://github.com/${repository}/releases/download/${tag}/${name}`;}
  };
}

async function dayRows(day) {
  const next = new Date(Date.parse(day+'T00:00:00Z')+86400000).toISOString();
  const rows = [];let cursor = null;
  while (true) {
    let query = database.from('trendSnapshots').select('*').gte('capturedAt',day+'T00:00:00Z').lt('capturedAt',next)
      .order('capturedAt',{ascending:true}).order('gameId',{ascending:true}).limit(1000);
    if (cursor)query = query.or(`capturedAt.gt.${cursor.capturedAt},and(capturedAt.eq.${cursor.capturedAt},gameId.gt.${cursor.gameId})`);
    const page = checked(await query) ?? [];
    rows.push(...page);if(page.length<1000)break;
    const nextCursor = page.at(-1);
    if(cursor && nextCursor.capturedAt===cursor.capturedAt && nextCursor.gameId===cursor.gameId)throw new Error('Archive cursor did not advance.');
    cursor = nextCursor;
  }
  return rows;
}

try {
  const recordsResult = await database.from('historyArchives').select('*').order('archiveDay',{ascending:false}).limit(10000);
  if(recordsResult.error) {
    console.warn('::warning::Archive retention is inactive. Run database/optimizeHistory.sql once in Supabase. No history has been deleted.');
    process.exit(0);
  }
  const store = await releaseStore();
  const probe = Buffer.from(JSON.stringify({schemaVersion:1,kind:'storageVerification',containsTrainingData:false}));
  await store.upload('ArchiveStorageCheck.json',probe);
  if(!(await store.download('ArchiveStorageCheck.json')).equals(probe))throw new Error('GitHub archive storage verification failed.');
  const records = recordsResult.data ?? [];
  const earliest = checked(await database.from('trendSnapshots').select('capturedAt').order('capturedAt',{ascending:true}).limit(1));
  const today = new Date().toISOString().slice(0,10);
  const coldBefore = new Date(Date.parse(today+'T00:00:00Z')-config.rawRetentionDays*86400000).toISOString().slice(0,10);
  let archivedDays = 0;let prunedRows = 0;
  for(let day=earliest[0]?.capturedAt.slice(0,10);day && day<today;day=new Date(Date.parse(day+'T00:00:00Z')+86400000).toISOString().slice(0,10)) {
    const existing = records.filter(record=>record.archiveDay===day);
    if(existing.length && day>=coldBefore)continue;
    const inspection = checked(await database.rpc('inspectHistoryDay',{archiveDay:day}));
    if(!Number(inspection.rowCount))continue;
    const finalize = async (manifest,url) => checked(await database.rpc('finalizeHistoryArchive',{archiveDay:day,expectedRows:manifest.rowCount,sourceFingerprint:manifest.sourceFingerprint,archiveDigest:manifest.archiveDigest,archiveUrl:url,rawRetentionDays:config.rawRetentionDays}));
    const previous = existing.find(record=>record.sourceFingerprint===inspection.sourceFingerprint && Number(record.rowCount)===Number(inspection.rowCount));
    let result;
    if(previous) {
      const name = `trendSnapshots-${day}-${previous.archiveDigest}.jsonl.gz`;
      const manifest = JSON.parse(await store.download(name+'.manifest.json'));
      verifyArchive(await store.download(name),manifest);
      if(manifest.archiveDigest!==previous.archiveDigest || manifest.sourceFingerprint!==inspection.sourceFingerprint || manifest.rowCount!==Number(inspection.rowCount))throw new Error('Stored archive verification differs from current source.');
      result = await finalize(manifest,store.url(name));
    } else result = await archiveAndVerify(day,await dayRows(day),inspection,store,finalize);
    archivedDays++;prunedRows+=Number(result.prunedRows);
  }
  const prunedHourlyRows = checked(await database.rpc('pruneArchivedHourlyHistory',{hourlyRetentionDays:config.hourlyRetentionDays}));
  console.log(JSON.stringify({archiveStorageVerified:true,archivedDays,prunedRows,prunedHourlyRows,rawRetentionDays:config.rawRetentionDays,hourlyRetentionDays:config.hourlyRetentionDays}));
} catch(error) {
  console.error('Archive maintenance stopped; unverified observations remain in Supabase: '+error.message);
  process.exitCode=1;
}
