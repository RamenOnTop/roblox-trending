import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {gzipSync,gunzipSync} from 'node:zlib';
import {emptyLabState,metadataChanges,resolvePending,applyLabBatch,labSummary,labDigest} from './lib/mlLab.mjs';

const repository='RamenOnTop/roblox-trending',tag='roblox-ml-lab';
const directory=new URL('../.mlLab/',import.meta.url),output=new URL('../public/data/',import.meta.url);
await mkdir(directory,{recursive:true});await mkdir(output,{recursive:true});
const config=JSON.parse(await readFile(new URL('../config/mlLab.json',import.meta.url),'utf8'));
const collection=JSON.parse(await readFile(new URL('collection.json',directory),'utf8'));
const ghEnv={...process.env};if(process.env.githubToken)ghEnv.GH_TOKEN=process.env.githubToken;
function gh(args){return execFileSync(process.env.ghPath??'gh',[...args,'--repo',repository],{env:ghEnv,maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']});}
function release(){return JSON.parse(gh(['release','view',tag,'--json','assets']));}
async function download(name){
  gh(['release','download',tag,'--pattern',name,'--dir',fileURLToPath(directory),'--clobber']);
  return readFile(new URL(name,directory));
}
let assets;
try{assets=release().assets;}catch{throw new Error('ML journal release unavailable; forecasts were not issued.');}
const journalPattern=/^labBatch-\d{8}T\d{9}Z-[a-f0-9-]{36}\.json\.gz$/;
const journals=assets.filter(asset=>journalPattern.test(asset.name)).sort((a,b)=>a.name.localeCompare(b.name));
if(journals.length>4096)throw new Error('ML journal budget exceeded; compact journals before continuing.');
let state;
try{
  state=JSON.parse(gunzipSync(await readFile(new URL('state.json.gz',directory)),{maxOutputLength:512*1024*1024}));
  if(state.schemaVersion!==1||!Array.isArray(state.processed)||!Array.isArray(state.pending)||!state.totals||!state.metadata||!Array.isArray(state.results)||state.processed.some(name=>!journals.some(asset=>asset.name===name)))throw new Error('Invalid ML checkpoint.');
}catch{state=emptyLabState();}
const names=new Set(assets.map(asset=>asset.name));
for(const asset of journals){
  if(state.processed.includes(asset.name))continue;
  if(!names.has(asset.name+'.manifest.json'))throw new Error('ML journal manifest missing.');
  const manifest=JSON.parse(await download(asset.name+'.manifest.json'));
  const bytes=await download(asset.name);
  if(manifest.name!==asset.name||manifest.sha256!==labDigest(bytes)||manifest.compressedBytes!==bytes.length)throw new Error('ML journal integrity check failed.');
  const batch=JSON.parse(gunzipSync(bytes,{maxOutputLength:32*1024*1024}));
  if(batch.issuedAt!==manifest.issuedAt)throw new Error('ML journal timestamp mismatch.');
  applyLabBatch(state,batch,asset.name);
}
const model=config.model;
if(!model||!/^[a-f0-9]{64}$/.test(model.sha256)||model.modelFile!==`model-${model.sha256}.joblib`)throw new Error('No pinned experimental model configured.');
const modelPath=new URL(model.modelFile,directory);
let modelBytes=await readFile(modelPath).catch(()=>null);
if(!modelBytes||labDigest(modelBytes)!==model.sha256)modelBytes=await download(model.modelFile);
if(labDigest(modelBytes)!==model.sha256)throw new Error('Pinned model SHA-256 verification failed.');
await writeFile(modelPath,modelBytes);await writeFile(new URL('modelManifest.json',directory),JSON.stringify(model));
execFileSync(process.env.pythonPath??'python',['machineLearning/issueForecasts.py','--input',fileURLToPath(new URL('collection.json',directory)),'--model',fileURLToPath(modelPath),'--manifest',fileURLToPath(new URL('modelManifest.json',directory)),'--output',fileURLToPath(new URL('predictions.json',directory))],{env:process.env,stdio:'inherit'});
const predictions=JSON.parse(await readFile(new URL('predictions.json',directory),'utf8'));
const issuedAt=predictions.issuedAt;
const forecasts=predictions.predictions.map(row=>({...row,forecastId:`${model.modelVersion}:${row.gameId}:${collection.generatedAt}`,modelVersion:model.modelVersion,anchorTime:collection.generatedAt,issuedAt,targetTime:new Date(Date.parse(collection.generatedAt)+3600000).toISOString()}));
const batch={schemaVersion:1,issuedAt,collectionId:collection.collectionId,modelVersion:model.modelVersion,
  forecasts,outcomes:resolvePending(state.pending,collection.rawSamples,issuedAt),metadataChanges:metadataChanges(collection.games,state.metadata,collection.generatedAt)};
// Python ISO timestamps have microseconds; use JS milliseconds for a stable asset name.
const name=`labBatch-${new Date(issuedAt).toISOString().replace(/[-:.]/g,'')}-${collection.collectionId}.json.gz`;
if(!journalPattern.test(name))throw new Error('Invalid journal asset name.');
const nextState=applyLabBatch(structuredClone(state),batch,name);
const bytes=gzipSync(JSON.stringify(batch));
const manifest={schemaVersion:1,name,issuedAt,sha256:labDigest(bytes),compressedBytes:bytes.length,forecasts:forecasts.length,outcomes:batch.outcomes.length,metadataChanges:batch.metadataChanges.length};
await writeFile(new URL(name,directory),bytes);await writeFile(new URL(name+'.manifest.json',directory),JSON.stringify(manifest));
gh(['release','upload',tag,fileURLToPath(new URL(name,directory)),fileURLToPath(new URL(name+'.manifest.json',directory))]);
// Journal upload plus a verified re-download precedes any public forecast display.
const downloaded=await download(name),verified=JSON.parse(await download(name+'.manifest.json'));
if(labDigest(downloaded)!==manifest.sha256||verified.sha256!==manifest.sha256||verified.name!==name)throw new Error('ML journal read-back verification failed.');
state=nextState;
const lab=labSummary(state,model,collection.generatedAt);
await writeFile(new URL('mlLab.json',output),JSON.stringify(lab.summary));
const histories=new URL('mlGames/',output);await mkdir(histories,{recursive:true});
for(const [gameId,rows] of lab.histories)await writeFile(new URL(gameId+'.json',histories),JSON.stringify({gameId,modelVersion:model.modelVersion,rows}));
await writeFile(new URL('state.json.gz.tmp',directory),gzipSync(JSON.stringify(state)));
await rename(new URL('state.json.gz.tmp',directory),new URL('state.json.gz',directory));
console.log(JSON.stringify({issued:forecasts.length,scoredNow:batch.outcomes.filter(row=>row.status==='scored').length,metadataChanges:batch.metadataChanges.length,totalScored:lab.summary.metrics.count,pending:lab.summary.pending,modelVersion:model.modelVersion}));
