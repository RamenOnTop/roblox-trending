import {execFileSync} from 'node:child_process';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,sep} from 'node:path';
import {parseArgs} from 'node:util';
import {mergeTrainingRows,readVerifiedTrainingArchives,assertDailyCoverage} from './lib/trainingHistory.mjs';

const repository=process.env.githubRepository??'RamenOnTop/roblox-trending';
if(repository!=='RamenOnTop/roblox-trending')throw new Error('Unexpected training archive repository.');
const {values}=parseArgs({options:{output:{type:'string'}}});
const output=values.output?pathToFileURL(resolve(values.output)+sep):new URL('../machineLearning/output/',import.meta.url);
const cache=new URL('../.historyArchives/training/',import.meta.url);
await mkdir(cache,{recursive:true});
const recent=JSON.parse(await readFile(new URL('export.json',output),'utf8'));
const recentRows=(await readFile(new URL('observations.jsonl',output),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
if(recent.rows!==recentRows.length||recent.source!=='Supabase trendSnapshots')throw new Error('Recent training export metadata differs from observations.');
const ghEnv={...process.env};
if(process.env.githubToken)ghEnv.GH_TOKEN=process.env.githubToken;
// This process has no database credentials; GitHub access is read-only.
function gh(args){return execFileSync(process.env.ghPath??'gh',[...args,'--repo',repository],{env:ghEnv,maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']});}
const release=JSON.parse(gh(['release','view','roblox-history','--json','assets']));
const archived=await readVerifiedTrainingArchives(release.assets,async name=>{
  gh(['release','download','roblox-history','--pattern',name,'--dir',fileURLToPath(cache),'--clobber']);
  return readFile(new URL(name,cache));
},recent.until);
assertDailyCoverage(archived.days,recentRows,recent.until);
const combined=mergeTrainingRows([archived.rows,recentRows],{until:recent.until});
const target=new URL('observations.jsonl',output);
await writeFile(new URL('observations.jsonl.tmp',output),combined.rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
await rename(new URL('observations.jsonl.tmp',output),target);
const provenance={schemaVersion:2,source:'Verified GitHub archives plus recent Supabase player observations',repository,
  until:recent.until,earliest:combined.rows[0].capturedAt,latest:combined.rows.at(-1).capturedAt,
  rows:combined.rows.length,recentRows:recentRows.length,archiveRows:archived.rows.length,
  duplicateRowsRemoved:combined.duplicateRows,archiveDays:archived.days,archives:archived.manifests,
  fields:['gameId','capturedAt','activePlayers'],recentExport:recent};
await writeFile(new URL('provenance.json',output),JSON.stringify(provenance,null,2));
console.log(JSON.stringify({verifiedArchiveDays:archived.days.length,combinedRows:combined.rows.length,duplicateRowsRemoved:combined.duplicateRows,earliest:provenance.earliest,latest:provenance.latest}));
