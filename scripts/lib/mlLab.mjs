import {createHash} from 'node:crypto';
export const labDigest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function emptyLabState(){return {schemaVersion:1,processed:[],pending:[],results:[],metadata:{},totals:{},issued:{},expired:{},startedAt:{},metadataStartedAt:null};}
const metadataFields=['name','description','genreL1','genreL2','updatedAt','creator','creatorId','creatorType'];
export function metadataChanges(games,previous,observedAt){
  return games.flatMap(game=>{
    const payload=Object.fromEntries(metadataFields.map(key=>[key,game[key]??null]));
    return JSON.stringify(previous[game.id]?.payload)===JSON.stringify(payload)?[]:[{gameId:game.id,observedAt,payload}];
  });
}
export function resolvePending(pending,samples,issuedAt){
  const byGame=new Map();const cutoff=Date.parse(issuedAt);
  for(const sample of samples){
    const time=Date.parse(sample.capturedAt);
    if(time>cutoff||!Number.isFinite(time)||!Number.isFinite(sample.activePlayers)||sample.activePlayers<0)continue;
    const list=byGame.get(sample.gameId)??[];list.push(sample);byGame.set(sample.gameId,list);
  }
  for(const list of byGame.values())list.sort((a,b)=>Date.parse(a.capturedAt)-Date.parse(b.capturedAt));
  return pending.flatMap(row=>{
    const target=Date.parse(row.targetTime),expires=target+10*60000;
    const actual=(byGame.get(row.gameId)??[]).find(sample=>Date.parse(sample.capturedAt)>=target&&Date.parse(sample.capturedAt)<=expires&&Date.parse(sample.capturedAt)>Date.parse(row.issuedAt));
    return actual?[{forecastId:row.forecastId,status:'scored',labelTime:actual.capturedAt,actualPlayers:actual.activePlayers}]:cutoff>expires?[{forecastId:row.forecastId,status:'expired'}]:[];
  });
}
export function audienceBand(players){return players<1000?'Under 1K':players<10000?'1K–10K':players<75000?'10K–75K':'75K+';}
export function applyLabBatch(state,batch,name){
  if(state.processed.includes(name))return state;
  if(batch.schemaVersion!==1||!Number.isFinite(Date.parse(batch.issuedAt))||!Array.isArray(batch.forecasts)||!Array.isArray(batch.outcomes)||!Array.isArray(batch.metadataChanges))throw new Error('Invalid ML journal batch.');
  const pending=new Map(state.pending.map(row=>[row.forecastId,row]));
  for(const outcome of batch.outcomes){
    const row=pending.get(outcome.forecastId);
    if(!row)throw new Error('ML outcome has no previously recorded forecast.');
    if(outcome.status==='scored'){
      const label=Date.parse(outcome.labelTime),target=Date.parse(row.targetTime);
      if(!Number.isFinite(outcome.actualPlayers)||outcome.actualPlayers<0||label<target||label>target+10*60000||label<=Date.parse(row.issuedAt)||label>Date.parse(batch.issuedAt))throw new Error('Invalid forecast outcome timing or count.');
      const result={...row,...outcome};state.results.push(result);
      const key=`${row.modelVersion}:${row.gameId}`;
      const total=state.totals[key]??{gameId:row.gameId,modelVersion:row.modelVersion,count:0,actual:0,modelError:0,baselineError:0,bands:{}};
      const band=audienceBand(row.playersNow);
      const bucket=total.bands[band]??{count:0,actual:0,modelError:0,baselineError:0};
      for(const metrics of [total,bucket]){metrics.count++;metrics.actual+=outcome.actualPlayers;metrics.modelError+=Math.abs(row.predictedPlayers-outcome.actualPlayers);metrics.baselineError+=Math.abs(row.playersNow-outcome.actualPlayers);}
      total.bands[band]=bucket;state.totals[key]=total;
    }else if(outcome.status==='expired'){
      if(Date.parse(batch.issuedAt)<=Date.parse(row.targetTime)+10*60000)throw new Error('Forecast expired before its outcome window ended.');
      state.expired[row.modelVersion]=(state.expired[row.modelVersion]??0)+1;
    }else throw new Error('Unknown ML outcome status.');
    pending.delete(outcome.forecastId);
  }
  for(const row of batch.forecasts){
    if(!/^[1-9]\d*$/.test(row.gameId)||row.issuedAt!==batch.issuedAt||Date.parse(row.issuedAt)-Date.parse(row.anchorTime)<0||Date.parse(row.issuedAt)-Date.parse(row.anchorTime)>10*60000||Date.parse(row.targetTime)-Date.parse(row.anchorTime)!==3600000||![row.playersNow,row.predictedPlayers].every(value=>Number.isFinite(value)&&value>=0)||pending.has(row.forecastId))throw new Error('Invalid or duplicate issued forecast.');
    pending.set(row.forecastId,row);state.issued[row.modelVersion]=(state.issued[row.modelVersion]??0)+1;state.startedAt[row.modelVersion]??=row.issuedAt;
  }
  for(const change of batch.metadataChanges){
    if(!/^[1-9]\d*$/.test(change.gameId)||!Number.isFinite(Date.parse(change.observedAt))||Date.parse(change.observedAt)>Date.parse(batch.issuedAt))throw new Error('Invalid metadata observation.');
    state.metadata[change.gameId]={observedAt:change.observedAt,payload:change.payload};
    state.metadataStartedAt??=change.observedAt;
  }
  state.pending=[...pending.values()];state.processed.push(name);
  state.results=state.results.filter(row=>Date.parse(row.labelTime)>=Date.parse(batch.issuedAt)-7*86400000);
  return state;
}
function summarize(totals){
  const count=totals.reduce((sum,row)=>sum+row.count,0);
  if(!count)return {count:0,games:0,modelErrorPct:null,baselineErrorPct:null,modelMae:null,baselineMae:null,improvementPct:null};
  const modelErrorPct=totals.reduce((sum,row)=>sum+row.modelError/Math.max(row.actual,row.count),0)/totals.length*100;
  const baselineErrorPct=totals.reduce((sum,row)=>sum+row.baselineError/Math.max(row.actual,row.count),0)/totals.length*100;
  return {count,games:totals.length,modelErrorPct,baselineErrorPct,modelMae:totals.reduce((sum,row)=>sum+row.modelError,0)/count,baselineMae:totals.reduce((sum,row)=>sum+row.baselineError,0)/count,improvementPct:baselineErrorPct>0?(baselineErrorPct-modelErrorPct)/baselineErrorPct*100:null};
}
export function labSummary(state,model,generatedAt){
  const totals=Object.values(state.totals).filter(row=>row.modelVersion===model.modelVersion);
  const pending=state.pending.filter(row=>row.modelVersion===model.modelVersion);
  const results=state.results.filter(row=>row.modelVersion===model.modelVersion);
  const metrics=summarize(totals);
  const byGame=new Map();
  for(const row of [...results,...pending]){const list=byGame.get(row.gameId)??[];list.push(row);byGame.set(row.gameId,list);}
  for(const list of byGame.values())list.sort((a,b)=>Date.parse(a.targetTime)-Date.parse(b.targetTime));
  return {summary:{schemaVersion:1,status:metrics.count?'active':'collecting',generatedAt,model,metrics,
    issued:state.issued[model.modelVersion]??0,pending:pending.length,expired:state.expired[model.modelVersion]??0,
    firstIssuedAt:state.startedAt[model.modelVersion]??null,
    audienceBands:['Under 1K','1K–10K','10K–75K','75K+'].map(label=>({label,...summarize(totals.flatMap(row=>row.bands[label]?[row.bands[label]]:[]))})),
    gameIds:[...byGame.keys()],latest:[...results,...pending].sort((a,b)=>Date.parse(b.anchorTime)-Date.parse(a.anchorTime)||a.gameId.localeCompare(b.gameId)).slice(0,20),
    metadataGames:Object.keys(state.metadata).length,metadataStartedAt:state.metadataStartedAt},histories:byGame};
}
