export const breakoutHours = [3, 6, 24];
export const breakoutTiers = [
  {label:'Emerging',below:1000,minGain:100,minPct:30,minCurrent:200},
  {label:'Small',below:10000,minGain:300,minPct:20,minCurrent:0},
  {label:'Growing',below:75000,minGain:1000,minPct:10,minCurrent:0},
  {label:'Established',below:Infinity,minGain:3000,minPct:8,minCurrent:0},
];

// All thresholds are transparent heuristics, not trained probabilities.
export function detectBreakout(samples, hours, nowMs) {
  const unique = new Map();
  for (const sample of samples) {
    const time = Date.parse(sample.capturedAt);
    if (!Number.isFinite(time) || time > nowMs || !Number.isFinite(sample.activePlayers) || sample.activePlayers < 0) continue;
    if (!unique.has(time)) unique.set(time,{time,value:sample.activePlayers});
  }
  const all = [...unique.values()].sort((a,b)=>a.time-b.time);
  const latest = all.at(-1);
  const target = nowMs-hours*3600000;
  // Allow normal collection jitter around a half-hour cadence, including manual runs.
  const first = all.filter(point=>Math.abs(point.time-target)<=20*60000)
    .sort((a,b)=>Math.abs(a.time-target)-Math.abs(b.time-target)||a.time-b.time)[0];
  const points = first ? all.filter(point=>point.time>=first.time) : all.filter(point=>point.time>=target);
  const hoursUsed = points.length>1 ? (latest.time-points[0].time)/3600000 : 0;
  const ageMinutes = latest ? (nowMs-latest.time)/60000 : null;
  const gaps = points.slice(1).map((point,index)=>(point.time-points[index].time)/60000);
  const maxGapMinutes = gaps.length ? Math.max(...gaps) : 0;
  const tier = breakoutTiers.find(item=>(first?.value??latest?.value??0)<item.below);
  const gain = first&&latest ? latest.value-first.value : null;
  const growthPct = first?.value>0 ? gain/first.value*100 : null;
  const result = {status:'insufficientHistory',tier:tier.label,hoursUsed,observations:points.length,
    ageMinutes,maxGapMinutes,gain,growthPct,score:0,sparkline:[]};
  if (!latest || !first || hoursUsed<hours*0.9 || points.length<4) return result;
  if (ageMinutes>45) return {...result,status:'stale'};
  if (maxGapMinutes>(hours===24?75:45)) return {...result,status:'patchyHistory'};
  if (first.value===0) return {...result,status:'zeroBaseline'};
  if (gain<tier.minGain || growthPct<tier.minPct || latest.value<tier.minCurrent) return {...result,status:'belowThreshold'};
  const peak = Math.max(...points.map(point=>point.value));
  const largestJump = Math.max(...points.slice(1).map((point,index)=>Math.max(0,point.value-points[index].value)));
  // Extra observations must not shorten the hold period and erase an existing signal.
  const holdIndex = points.findLastIndex(point=>point.time<=latest.time-54*60000);
  const held = holdIndex<0 ? [] : points.slice(holdIndex);
  const heldLongEnough = held.length>=3 && (held.at(-1).time-held[0].time)/3600000>=0.9;
  const heldThreshold = held.every(point=>point.value-first.value>=tier.minGain && (point.value-first.value)/first.value*100>=tier.minPct && point.value>=tier.minCurrent);
  const status = latest.value<peak*0.75 ? 'cooling' : largestJump>=gain*0.7 ? 'spike' : heldLongEnough&&heldThreshold ? 'sustained' : 'early';
  // Compare strength relative to each size tier; the score is a ranking, not confidence.
  const score = 0.6*Math.min(growthPct/tier.minPct,3)+0.4*Math.min(gain/tier.minGain,3);
  const sparkline = points.filter((point,index)=>index===points.length-1 || index%Math.max(1,Math.ceil(points.length/24))===0)
    .map(point=>({time:Math.floor(point.time/1000),value:point.value}));
  return {...result,status,score,sparkline};
}

export function rankBreakouts(games, hours) {
  return games.filter(game=>game.breakouts?.[hours]?.status==='sustained')
    .sort((a,b)=>b.breakouts[hours].score-a.breakouts[hours].score || b.breakouts[hours].growthPct-a.breakouts[hours].growthPct || a.id.localeCompare(b.id));
}
