import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {readFile,writeFile,mkdir,rename,open,unlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {archivePattern,archiveImportSql,verifyLocalArchive,csvJson,sqlValue,statusSql} from './lib/localHistory.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const local=join(root,'.localHistory');
const archives=join(local,'archives');
const runtime=join(local,'runtime.env');
const container='robloxTrendsHistory';
const repository='RamenOnTop/roblox-trending';
const ghPath=process.env.ghPath??(process.platform==='win32'?'C:\\Program Files\\GitHub CLI\\gh.exe':'gh');
const command=process.argv[2]??'status';
const composeArgs=['compose','--env-file',runtime,'-f',join(root,'compose.localHistory.yaml')];
function run(program,args,options={}){return execFileSync(program,args,{cwd:root,maxBuffer:8*1024*1024,timeout:120000,stdio:['pipe','pipe','pipe'],...options})?.toString('utf8').trim()??'';}
function docker(args,options){return run('docker',args,options);}
function query(sql){return docker(['exec','-i',container,'psql','--no-psqlrc','--set','ON_ERROR_STOP=1','--quiet','--tuples-only','--no-align','--username','historyOwner','--dbname','robloxHistory'],{input:sql,maxBuffer:8*1024*1024});}

async function start(){
  docker(['version','--format','{{.Server.Version}}']);
  await mkdir(local,{recursive:true});
  let settings=await readFile(runtime,'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(!settings){
    let image;
    try{image=docker(['image','inspect','postgres:17-alpine','--format','{{index .RepoDigests 0}}']);}
    catch{docker(['pull','postgres:17-alpine'],{stdio:'inherit'});image=docker(['image','inspect','postgres:17-alpine','--format','{{index .RepoDigests 0}}']);}
    if(!/^postgres@sha256:[a-f0-9]{64}$/.test(image))throw new Error('Official PostgreSQL image digest could not be pinned.');
    settings=`historyImage=${image}\nhistoryPassword=${randomBytes(32).toString('hex')}\n`;
    await writeFile(runtime,settings,{flag:'wx',mode:0o600});
  }
  if(!/^historyImage=postgres@sha256:[a-f0-9]{64}$/m.test(settings)||!/^historyPassword=[a-f0-9]{64}$/m.test(settings))throw new Error('Unexpected local runtime configuration. Credentials were not replaced.');
  // Never adopt an unrelated container or volume with the same name.
  const names=docker(['ps','-a','--format','{{.Names}}']).split('\n');
  if(names.includes(container)&&docker(['inspect',container,'--format','{{index .Config.Labels "com.docker.compose.project"}}'])!=='roblox-trends-local-history')throw new Error('The local history container name is already used by another project.');
  const volumes=docker(['volume','ls','--format','{{.Name}}']).split('\n');
  if(volumes.includes('robloxTrendsHistoryData')&&docker(['volume','inspect','robloxTrendsHistoryData','--format','{{index .Labels "com.docker.compose.project"}}'])!=='roblox-trends-local-history')throw new Error('The local history volume belongs to another project.');
  docker([...composeArgs,'up','-d','--wait','--wait-timeout','100'],{stdio:'inherit'});
  query(await readFile(join(root,'database/localHistory.sql'),'utf8'));
}

async function acquireLock(){
  const path=join(local,'sync.lock');
  async function create(){const file=await open(path,'wx',0o600);await file.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));await file.close();}
  try{await create();}catch(error){
    if(error.code!=='EEXIST')throw error;
    const owner=JSON.parse(await readFile(path,'utf8'));
    if(!Number.isSafeInteger(owner.pid)||owner.pid<=0)throw new Error('Invalid sync lock. Inspect .localHistory/sync.lock before retrying.');
    try{process.kill(owner.pid,0);throw new Error(`A history sync may still be running (process ${owner.pid}).`);}
    catch(check){if(check.code!=='ESRCH')throw check;}
    await rename(path,path+`.recovered-${Date.now()}`);await create();
  }
  return ()=>unlink(path);
}

async function download(url,maxBytes){
  for(let attempt=0;attempt<4;attempt++){
    try{
      const response=await fetch(url,{headers:{'User-Agent':'robloxTrendsLocalHistory/1.0'},signal:AbortSignal.timeout(60000)});
      if(!response.ok){if(response.status!==429&&response.status<500)throw Object.assign(new Error(`Archive download returned HTTP ${response.status}.`),{permanent:true});throw new Error(`Archive download returned HTTP ${response.status}.`);}
      const chunks=[];let length=0;
      for await(const chunk of response.body){length+=chunk.length;if(length>maxBytes)throw Object.assign(new Error('Archive download exceeds the size budget.'),{permanent:true});chunks.push(chunk);}
      return Buffer.concat(chunks);
    }catch(error){if(error.permanent||attempt===3)throw error;await new Promise(resolve=>setTimeout(resolve,1000*2**attempt));}
  }
}

async function readPair(asset){
  const dataPath=join(archives,asset.name),manifestPath=dataPath+'.manifest.json';
  let bytes,manifest;
  try{bytes=await readFile(dataPath);manifest=JSON.parse(await readFile(manifestPath,'utf8'));}
  catch(error){
    if(error.code!=='ENOENT')throw error;
    const url=`https://github.com/${repository}/releases/download/roblox-history/${asset.name}`;
    manifest=JSON.parse((await download(url+'.manifest.json',65536)).toString('utf8'));
    bytes=await download(url,32*1024*1024);
    verifyLocalArchive(asset.name,bytes,manifest);
    await writeFile(dataPath+'.tmp',bytes);await writeFile(manifestPath+'.tmp',JSON.stringify(manifest,null,2)+'\n');
    await rename(dataPath+'.tmp',dataPath);await rename(manifestPath+'.tmp',manifestPath);
  }
  const rows=verifyLocalArchive(asset.name,bytes,manifest);
  return {rows,manifest};
}

async function updateCatalog(){
  const bytes=await download('https://ramenontop.github.io/roblox-trending/data/dashboard.json',32*1024*1024);
  const data=JSON.parse(bytes.toString('utf8'));
  const observedAt=new Date(data.meta?.generatedAt).toISOString();
  if(!Array.isArray(data.games)||data.games.length>10000||data.games.some(game=>typeof game.id!=='string'||!/^[1-9]\d*$/.test(game.id)||typeof game.name!=='string'))throw new Error('Unexpected public game catalog.');
  const sql=`begin;
create temporary table "catalogRows" (payload jsonb not null) on commit drop;
copy "catalogRows" (payload) from stdin with (format csv);
${data.games.map(csvJson).join('\n')}
\\.
insert into "localHistory"."gameCatalog" ("gameId",name,creator,"genreL1","observedAt","sourceRow")
select payload->>'id',payload->>'name',payload->>'creator',payload->>'genreL1',${sqlValue(observedAt)},payload from "catalogRows"
on conflict ("gameId") do update set name=excluded.name,creator=excluded.creator,"genreL1"=excluded."genreL1","observedAt"=excluded."observedAt","sourceRow"=excluded."sourceRow"
where excluded."observedAt">="gameCatalog"."observedAt";
commit;`;
  query(sql);
  await writeFile(join(local,'latestDashboard.json'),bytes);
}

async function sync(){
  await mkdir(archives,{recursive:true});
  const releaseLock=await acquireLock();
  try{
    const release=JSON.parse(run(ghPath,['release','view','roblox-history','--repo',repository,'--json','assets']));
    const names=new Set(release.assets.map(asset=>asset.name));
    const assets=release.assets.filter(asset=>archivePattern.test(asset.name)).sort((a,b)=>a.name.localeCompare(b.name));
    if(!assets.length||assets.length>4096)throw new Error('No history archives available, or the archive budget was exceeded.');
    for(const asset of assets)if(!names.has(asset.name+'.manifest.json'))throw new Error('A history archive has no verification manifest.');
    const imported=new Set(JSON.parse(query(`select coalesce(json_agg("archiveDigest"),'[]'::json) from "localHistory"."archiveImports";`)));
    let newArchives=0,skippedArchives=0;
    for(const [index,asset] of assets.entries()){
      const {rows,manifest}=await readPair(asset);
      if(imported.has(manifest.archiveDigest)){skippedArchives++;continue;}
      query(archiveImportSql(asset.name,rows,manifest));
      newArchives++;imported.add(manifest.archiveDigest);
      console.log(`Imported and verified ${manifest.archiveDay}: ${rows.length.toLocaleString()} observations (${index+1}/${assets.length}).`);
    }
    try{await updateCatalog();}catch(error){console.warn(`History is imported; current game names could not refresh: ${error.message}`);}
    const summary=JSON.parse(query(statusSql));
    const days=[...new Set(assets.map(asset=>asset.name.match(archivePattern)[1]))].sort();
    const missingArchiveDays=[];
    for(let day=days[0];day<days.at(-1);day=new Date(Date.parse(day+'T00:00:00Z')+86400000).toISOString().slice(0,10))if(!days.includes(day))missingArchiveDays.push(day);
    const report={finishedAt:new Date().toISOString(),source:`https://github.com/${repository}/releases/tag/roblox-history`,newArchives,skippedArchives,missingArchiveDays,...summary};
    await writeFile(join(local,'latestSync.json.tmp'),JSON.stringify(report,null,2)+'\n');
    await rename(join(local,'latestSync.json.tmp'),join(local,'latestSync.json'));
    console.log(JSON.stringify(report,null,2));
    if(missingArchiveDays.length)console.warn('Some UTC days have no archive. Missing observations have not been invented.');
  }finally{await releaseLock();}
}

try{
  if(command==='start'){await start();console.log('Local PostgreSQL is ready on 127.0.0.1:55432 (database robloxHistory).');}
  else if(command==='sync'){await start();await sync();}
  else if(command==='status')console.log(query(statusSql));
  else if(command==='stop'){docker([...composeArgs,'stop'],{stdio:'inherit'});console.log('Database stopped. Persistent data and archive files are retained.');}
  else if(command==='sql')docker(['exec','-it',container,'psql','--no-psqlrc','--username','historyOwner','--dbname','robloxHistory'],{stdio:'inherit',timeout:undefined});
  else throw new Error('Use start, sync, status, sql, or stop.');
}catch(error){
  console.error(error.stderr?.toString().trim()||error.message);
  process.exitCode=1;
}
