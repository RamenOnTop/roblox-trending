import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { batches } from './robloxClient.mjs';

const dayMs = 86400000;
const fields = ['gameId','capturedAt','activePlayers','visits','favorites','likeRatio','bucketAt'];
export const stateVersion = 1;
export const databaseScope = url => createHash('sha256').update(url).digest('hex');
const pack = sample => fields.map(field => sample[field] ?? null);
const unpack = row => Object.fromEntries(fields.map((field,index) => [field,row[index]]));

export async function loadCollectorState(path, scope, now = Date.now()) {
  try {
    const state = JSON.parse(gunzipSync(await readFile(path), {maxOutputLength:256*1024*1024}));
    if (state.schemaVersion !== stateVersion || state.scope !== scope || !Number.isFinite(Date.parse(state.generatedAt)) || Date.parse(state.generatedAt) > now + 300000) throw new Error('Invalid collector checkpoint.');
    if (!Array.isArray(state.gameIds) || !Array.isArray(state.rawSamples) || !Array.isArray(state.hourlySamples) || !Array.isArray(state.enrichment)) throw new Error('Incomplete collector checkpoint.');
    state.rawSamples = state.rawSamples.map(unpack);
    state.hourlySamples = state.hourlySamples.map(unpack);
    for (const sample of [...state.rawSamples,...state.hourlySamples]) {
      if (!/^[1-9]\d*$/.test(sample.gameId) || !Number.isFinite(Date.parse(sample.capturedAt)) || !Number.isFinite(sample.activePlayers) || sample.activePlayers < 0) throw new Error('Invalid cached observation.');
    }
    return {state,warning:null};
  } catch (error) {
    return {state:null,warning:error.code === 'ENOENT' ? null : `Checkpoint unavailable; rebuilding from Supabase: ${error.message}`};
  }
}

export async function saveCollectorState(path, state) {
  const data = {...state,schemaVersion:stateVersion,rawSamples:state.rawSamples.map(pack),hourlySamples:state.hourlySamples.map(pack)};
  await mkdir(dirname(path),{recursive:true});
  await writeFile(path+'.tmp',gzipSync(JSON.stringify(data)));
  await rename(path+'.tmp',path);
}

export function historyPlan(state, ids, generatedAt, historyDays) {
  const now = Date.parse(generatedAt);
  const previous = state ? Date.parse(state.generatedAt) - 3600000 : null;
  const known = new Set(state?.gameIds ?? []);
  const plans = [];
  for (const fresh of [false,true]) {
    const group = ids.filter(id => known.has(id) !== fresh);
    for (const batch of batches(group,100)) {
      for (const table of ['trendSnapshots','trendHourlySamples']) {
        const cutoff = now - (table === 'trendSnapshots' ? 1 : historyDays + 1) * dayMs;
        plans.push({ids:batch,table,since:new Date(!fresh && previous != null ? Math.max(cutoff,previous) : cutoff).toISOString(),until:generatedAt});
      }
    }
  }
  return plans;
}

export async function readHistoryPages(database, plan, {maxRows,pageSize=1000} = {}) {
  const rows = [];
  let cursor = null;
  let jsonBytes = 0;
  while (true) {
    const limit = Math.min(pageSize,maxRows-rows.length+1);
    let query = database.from(plan.table).select(`gameId,capturedAt,activePlayers,visits,favorites,likeRatio${plan.table === 'trendHourlySamples' ? ',bucketAt' : ''}`)
      .in('gameId',plan.ids).gte('capturedAt',plan.since).lte('capturedAt',plan.until)
      .order('capturedAt',{ascending:false}).order('gameId',{ascending:true}).limit(limit);
    if (cursor) query = query.or(`capturedAt.lt.${cursor.capturedAt},and(capturedAt.eq.${cursor.capturedAt},gameId.gt.${cursor.gameId})`);
    const result = await query;
    if (result.error) throw new Error(`Read ${plan.table}: ${result.error.message}`);
    const page = result.data ?? [];
    if (!page.length) break;
    if (rows.length + page.length > maxRows) throw new Error('History exceeds maxHistoryRows; refusing to advance an incomplete checkpoint.');
    jsonBytes += Buffer.byteLength(JSON.stringify(page));
    rows.push(...page);
    const next = page.at(-1);
    if (cursor && cursor.gameId === next.gameId && cursor.capturedAt === next.capturedAt) throw new Error('History cursor did not advance.');
    cursor = next;
    if (page.length < limit) break;
  }
  return {rows,jsonBytes};
}

export function mergeHistory(state, rawRows, hourlyRows, ids, generatedAt, historyDays) {
  const now = Date.parse(generatedAt);
  const activeIds = new Set(ids);
  function merge(previous, incoming, hourly) {
    const cutoff = now - (hourly ? historyDays + 1 : 1) * dayMs;
    const byKey = new Map();
    for (const row of [...previous,...incoming]) {
      const time = Date.parse(row.capturedAt);
      if (!activeIds.has(row.gameId) || !Number.isFinite(time) || time < cutoff || time > now || !Number.isFinite(row.activePlayers) || row.activePlayers < 0) continue;
      const bucket = hourly ? Date.parse(row.bucketAt) : time;
      if (!Number.isFinite(bucket)) throw new Error('Invalid hourly bucket.');
      const key = `${row.gameId}:${bucket}`;
      const existing = byKey.get(key);
      if (!existing || time >= Date.parse(existing.capturedAt)) byKey.set(key,{...row,capturedAt:new Date(time).toISOString(),...(hourly ? {bucketAt:new Date(bucket).toISOString()} : {})});
    }
    return [...byKey.values()];
  }
  return {rawSamples:merge(state?.rawSamples ?? [],rawRows,false),hourlySamples:merge(state?.hourlySamples ?? [],hourlyRows,true)};
}
